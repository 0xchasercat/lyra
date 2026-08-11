//! The drift tripwire between `packages/lyra-acp/schema/protocol.json` and the
//! serde types in [`super::types`].
//!
//! DESIGN.md §2 asks for one canonical schema with the Rust types validated
//! against it, so *"a drifted field is a build failure, not a runtime surprise"*.
//! This module is that check, and it is deliberately test-only: it embeds the
//! schema file with [`include_str!`], so the schema moving or losing a variant
//! fails compilation of the test target, and everything else fails a test.
//!
//! Four things are asserted, and together they close the loop:
//!
//! 1. **Variant parity.** The schema's `#/$defs/update` `oneOf` titles equal
//!    `types::UPDATE_TAGS` exactly — a daemon-side variant this client
//!    does not model is a red test, not a shrug.
//! 2. **Field parity.** Every property declared on every variant appears in this
//!    module's sample for it. A new field lands here before it lands in a
//!    renderer.
//! 3. **Round-trip fidelity.** Every sample deserializes to its modelled variant
//!    (never `Update::Unknown`) and re-serializes to a
//!    semantically identical document. Anything the Rust types silently drop
//!    shows up as a diff.
//! 4. **Direction two.** The params this client *sends* validate against the
//!    schemas the daemon declares for them.
//!
//! The validator below implements the same JSON Schema subset the TypeScript
//! side does (`packages/lyra-acp/src/schema.ts`); `protocol.test.ts` asserts the
//! schema uses no keyword outside it, so the two validators see the same file.

use serde_json::{json, Map, Value};

use super::types::{
    AddModelParams, AddModelResult, AddProviderParams, AddProviderResult, AgentState,
    AgentTransition, ApiType,
    CancelParams, CheckpointDiffResult, CheckpointKind, CheckpointListResult,
    CheckpointRestoreResult,
    Classification, ConfigurableApiType, DeltaField, DetectProviderParams, DetectProviderResult,
    GetProviderParams, ModelSelection, ModelsResult, PauseKind, PromptParams, ProviderAuthSource,
    ProviderInfo, ProviderPersist, ProviderSetupOptions, ProvidersResult, RemoveProviderParams,
    RemoveProviderResult, RestoreParams, RewindParams, RewindResult, Secret, SelectModelParams,
    SelectProviderParams, SessionSnapshot,
    SessionSummary, SteerDelivery, SteerParams, SteerResult, SteerSource, StopReason, ToolStatus,
    TurnStatus,
    Update, UpdateNotification, VerifyProviderParams, VerifyProviderResult, WebsocketMode,
    UPDATE_TAGS,
};

/// The canonical schema, embedded at compile time.
const SCHEMA: &str = include_str!("../../../lyra-acp/schema/protocol.json");

/// A JSON Schema document, resolved by pointer.
struct Schema {
    root: Value,
}

impl Schema {
    fn load() -> Self {
        Self {
            root: serde_json::from_str(SCHEMA).expect("protocol.json is valid JSON"),
        }
    }

    /// Resolve a local pointer such as `#/$defs/requests/session~1cancel/params`.
    fn resolve(&self, pointer: &str) -> &Value {
        let mut node = &self.root;
        for raw in pointer.trim_start_matches("#/").split('/') {
            let token = raw.replace("~1", "/").replace("~0", "~");
            node = node
                .get(&token)
                .unwrap_or_else(|| panic!("schema pointer {pointer} has no member {token}"));
        }
        node
    }

    /// Validate `value` against the schema at `pointer`, returning every problem.
    fn validate(&self, value: &Value, pointer: &str) -> Vec<String> {
        let mut errors = Vec::new();
        self.check(self.resolve(pointer), value, "$", &mut errors);
        errors
    }

    fn matches(&self, node: &Value, value: &Value) -> bool {
        let mut errors = Vec::new();
        self.check(node, value, "$", &mut errors);
        errors.is_empty()
    }

    fn check(&self, node: &Value, value: &Value, path: &str, errors: &mut Vec<String>) {
        let Some(node) = node.as_object() else {
            return;
        };
        if let Some(Value::String(reference)) = node.get("$ref") {
            self.check(self.resolve(reference), value, path, errors);
        }
        if let Some(expected) = node.get("const")
            && value != expected
        {
            errors.push(format!("{path} must be {expected}"));
        }
        if let Some(Value::Array(allowed)) = node.get("enum")
            && !allowed.contains(value)
        {
            errors.push(format!("{path} is not one of the declared values"));
        }
        if let Some(declared) = node.get("type") {
            check_type(declared, value, path, errors);
        }
        self.check_object(node, value, path, errors);
        self.check_array(node, value, path, errors);
        check_scalar(node, value, path, errors);
        self.check_combinators(node, value, path, errors);
    }

    fn check_object(
        &self,
        node: &Map<String, Value>,
        value: &Value,
        path: &str,
        errors: &mut Vec<String>,
    ) {
        let Some(object) = value.as_object() else {
            return;
        };
        if let Some(Value::Array(required)) = node.get("required") {
            for key in required.iter().filter_map(Value::as_str) {
                if !object.contains_key(key) {
                    errors.push(format!("{path}.{key} is required"));
                }
            }
        }
        let properties = node.get("properties").and_then(Value::as_object);
        if node.get("additionalProperties") == Some(&Value::Bool(false)) {
            for key in object.keys() {
                if !properties.is_some_and(|declared| declared.contains_key(key)) {
                    errors.push(format!("{path}.{key} is not declared"));
                }
            }
        }
        if let Some(properties) = properties {
            for (key, subschema) in properties {
                if let Some(member) = object.get(key) {
                    self.check(subschema, member, &format!("{path}.{key}"), errors);
                }
            }
        }
    }

    fn check_array(
        &self,
        node: &Map<String, Value>,
        value: &Value,
        path: &str,
        errors: &mut Vec<String>,
    ) {
        let Some(items) = value.as_array() else {
            return;
        };
        if let Some(minimum) = node.get("minItems").and_then(Value::as_u64)
            && (items.len() as u64) < minimum
        {
            errors.push(format!("{path} needs at least {minimum} items"));
        }
        if let Some(schema) = node.get("items") {
            for (index, item) in items.iter().enumerate() {
                self.check(schema, item, &format!("{path}[{index}]"), errors);
            }
        }
    }

    fn check_combinators(
        &self,
        node: &Map<String, Value>,
        value: &Value,
        path: &str,
        errors: &mut Vec<String>,
    ) {
        if let Some(Value::Array(branches)) = node.get("oneOf") {
            let matched = branches
                .iter()
                .filter(|branch| self.matches(branch, value))
                .count();
            if matched != 1 {
                errors.push(format!(
                    "{path} matches none of the {} declared variants (matched {matched})",
                    branches.len()
                ));
            }
        }
        if let Some(Value::Array(branches)) = node.get("allOf") {
            for branch in branches {
                self.check(branch, value, path, errors);
            }
        }
    }

    /// The `title` of every branch of `#/$defs/update`, in declaration order.
    fn update_titles(&self) -> Vec<String> {
        self.resolve("#/$defs/update")["oneOf"]
            .as_array()
            .expect("the update union is a oneOf")
            .iter()
            .map(|branch| {
                branch["title"]
                    .as_str()
                    .expect("every update variant is titled")
                    .to_owned()
            })
            .collect()
    }

    /// Every property name declared on the variant with this tag.
    fn update_properties(&self, tag: &str) -> Vec<String> {
        self.resolve("#/$defs/update")["oneOf"]
            .as_array()
            .expect("the update union is a oneOf")
            .iter()
            .find(|branch| branch["title"].as_str() == Some(tag))
            .unwrap_or_else(|| panic!("no variant titled {tag}"))["properties"]
            .as_object()
            .expect("every variant declares properties")
            .keys()
            .filter(|key| key.as_str() != "sessionUpdate")
            .cloned()
            .collect()
    }
}

/// Type checking is independent of the document, so it needs no schema context.
fn check_type(declared: &Value, value: &Value, path: &str, errors: &mut Vec<String>) {
    let names: Vec<&str> = match declared {
        Value::String(name) => vec![name.as_str()],
        Value::Array(names) => names.iter().filter_map(Value::as_str).collect(),
        _ => return,
    };
    let ok = names.iter().any(|name| match *name {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        "null" => value.is_null(),
        "number" => value.is_number(),
        "integer" => value.is_i64() || value.is_u64(),
        _ => true,
    });
    if !ok {
        errors.push(format!("{path} must be {}", names.join(" or ")));
    }
}

/// Scalar bounds, likewise context-free.
fn check_scalar(node: &Map<String, Value>, value: &Value, path: &str, errors: &mut Vec<String>) {
    if let (Some(text), Some(minimum)) = (
        value.as_str(),
        node.get("minLength").and_then(Value::as_u64),
    ) && (text.chars().count() as u64) < minimum
    {
        errors.push(format!("{path} is shorter than {minimum}"));
    }
    if let (Some(number), Some(minimum)) =
        (value.as_f64(), node.get("minimum").and_then(Value::as_f64))
        && number < minimum
    {
        errors.push(format!("{path} is below {minimum}"));
    }
}

/// One sample per declared variant, exercising **every** declared property.
///
/// Values are lifted from `packages/lyra-acp/test/protocol.test.ts` wherever that
/// suite pins one, so both sides are asserting about the same documents.
fn maximal_samples() -> Vec<(&'static str, Value)> {
    vec![
        (
            "turn_start",
            json!({"sessionUpdate":"turn_start","turnId":"turn-1","promptEntryId":"e-1",
                   "source":"user","startedAtMs":1_700_000_000_000_i64}),
        ),
        (
            "turn_resume",
            json!({"sessionUpdate":"turn_resume","turnId":"turn-1","after":"retry","pausedMs":4_000}),
        ),
        (
            "turn_end",
            json!({"sessionUpdate":"turn_end","turnId":"turn-1","status":"error",
                   "stopReason":"cancelled","durationMs":12_400,"partialRetained":true,
                   "promptTrimmed":false,"hardStopRequested":true,
                   "error":{"classification":"bad_request","message":"no such model",
                            "code":"model_not_found","status":404}}),
        ),
        (
            "round_start",
            json!({"sessionUpdate":"round_start","turnId":"turn-1","round":1,
                   "startedAtMs":1_700_000_000_000_i64}),
        ),
        (
            "message_start",
            json!({"sessionUpdate":"message_start","turnId":"turn-1",
                   "messageId":"turn-1-msg-1","role":"assistant"}),
        ),
        (
            "part_start",
            json!({"sessionUpdate":"part_start","messageId":"turn-1-msg-1",
                   "partId":"turn-1-msg-1-part-3","kind":"tool_call","toolCallId":"call-1"}),
        ),
        (
            "delta",
            json!({"sessionUpdate":"delta","messageId":"turn-1-msg-1",
                   "partId":"turn-1-msg-1-part-1","field":"text","delta":"Reading the file."}),
        ),
        (
            "part_end",
            json!({"sessionUpdate":"part_end","messageId":"turn-1-msg-1",
                   "partId":"turn-1-msg-1-part-1"}),
        ),
        (
            "reasoning_item",
            json!({"sessionUpdate":"reasoning_item","messageId":"turn-1-msg-1",
                   "partId":"turn-1-msg-1-part-4","provider":"openai",
                   "item":{"id":"reasoning-1","encrypted":"opaque"}}),
        ),
        (
            "message_end",
            json!({"sessionUpdate":"message_end","messageId":"turn-1-msg-1","stopReason":"tool_use"}),
        ),
        (
            "tool_call_start",
            json!({"sessionUpdate":"tool_call_start","toolCallId":"call-1",
                   "messageId":"turn-1-msg-1","partId":"turn-1-msg-1-part-3","tool":"read",
                   "argsSummary":"src/auth.ts"}),
        ),
        (
            "tool_call_update",
            json!({"sessionUpdate":"tool_call_update","toolCallId":"call-1","status":"running",
                   "tool":"read","argsSummary":"src/auth.ts","args":{"path":"src/auth.ts"},
                   "startedAtMs":1_700_000_000_010_i64}),
        ),
        (
            "tool_call_end",
            json!({"sessionUpdate":"tool_call_end","toolCallId":"call-1","tool":"read",
                   "status":"ok","resultSummary":"export function auth() {}","durationMs":37,
                   "interrupted":true,
                   "progress":{"filesRead":["src/auth.ts"],
                               "filesModified":[{"path":"src/auth.ts","beforeHash":"a1",
                                                 "afterHash":"b2"}],
                               "commandExitCode":0}}),
        ),
        (
            "retry",
            json!({"sessionUpdate":"retry","attempt":3,"maxAttempts":8,"classification":"quota",
                   "providerMessage":"monthly limit reached","delayMs":2_500,
                   "retryAtMs":1_700_000_123_456_i64,"resetsPartialOutput":true}),
        ),
        (
            "compaction",
            json!({"sessionUpdate":"compaction","boundaryId":"e-77","tokensBefore":180_000,
                   "tokensAfter":42_000,"firstKeptEntry":"e-51"}),
        ),
        (
            "context_repair",
            json!({"sessionUpdate":"context_repair",
                   "repairs":[{"code":"missing_tool_result",
                               "detail":"synthesised a missing result","entryId":"e-9",
                               "tokenEstimate":12}]}),
        ),
        (
            "context",
            json!({"sessionUpdate":"context","tokenEstimate":4_200,"sourceEntryCount":7,
                   "contextWindow":200_000}),
        ),
        (
            "usage",
            json!({"sessionUpdate":"usage",
                   "turn":{"inputTokens":90,"outputTokens":30,"cacheReadTokens":64,
                           "cacheWriteTokens":8},
                   "session":{"inputTokens":120,"outputTokens":40,"costMicroUsd":4_321}}),
        ),
        (
            "steer",
            json!({"sessionUpdate":"steer","entryId":"e-42",
                   "text":"the parser tests pass now","at":"tool_boundary",
                   "source":"hub","from":"reviewer"}),
        ),
        (
            "loop_warning",
            json!({"sessionUpdate":"loop_warning",
                   "warning":{"type":"identical_tool_call","tool":"read","count":3,"turns":2,
                              "path":"src/a.ts","hash":"9f1"},
                   "hardStopRequested":false}),
        ),
        (
            "transport_fallback",
            json!({"sessionUpdate":"transport_fallback","from":"openai_websocket",
                   "to":"openai_completions","reason":"handshake refused",
                   "resetsPartialOutput":false}),
        ),
        (
            "error",
            json!({"sessionUpdate":"error",
                   "error":{"classification":"auth","message":"token expired",
                            "code":"invalid_api_key","status":401}}),
        ),
        (
            "report",
            json!({"sessionUpdate":"report","message":"[git preview] assembled 2026-08-05-1246 from 3 workspace(s)"}),
        ),
        (
            "model_changed",
            json!({"sessionUpdate":"model_changed","provider":"anthropic","model":"opus-5",
                   "apiType":"anthropic_messages"}),
        ),
        (
            "session_changed",
            json!({"sessionUpdate":"session_changed","reason":"fork",
                   "descriptor":{"sessionId":"s-2","name":"purple-falcon",
                                 "path":"/tmp/purple-falcon.jsonl","headId":"e-51",
                                 "createdAt":"2026-08-09T10:00:00.000Z"}}),
        ),
        (
            "agent",
            json!({"sessionUpdate":"agent","id":"spawn-2","peer":"reviewer",
                   "label":"reviewer","status":"awaiting_tool","event":"started",
                   "model":"opus-5","depth":0,
                   "workspace":"/home/dev/project","toolCalls":7,"filesModified":3,
                   "error":"the provider stopped answering"}),
        ),
    ]
}

/// The same variants with every optional field omitted — the shapes a bare
/// daemon actually sends when nothing optional is known.
fn minimal_samples() -> Vec<(&'static str, Value)> {
    vec![
        (
            "turn_start",
            json!({"sessionUpdate":"turn_start","turnId":"t","source":"steer","startedAtMs":0}),
        ),
        (
            "turn_end",
            json!({"sessionUpdate":"turn_end","turnId":"t","status":"cancelled","durationMs":0,
                   "partialRetained":false}),
        ),
        (
            "tool_call_start",
            json!({"sessionUpdate":"tool_call_start","toolCallId":"c","messageId":"m",
                   "partId":"p","tool":"bash"}),
        ),
        (
            "tool_call_update",
            json!({"sessionUpdate":"tool_call_update","toolCallId":"c","status":"pending"}),
        ),
        (
            "tool_call_end",
            json!({"sessionUpdate":"tool_call_end","toolCallId":"c","status":"denied",
                   "durationMs":0}),
        ),
        (
            "compaction",
            json!({"sessionUpdate":"compaction","boundaryId":"b","tokensBefore":5,
                   "tokensAfter":0,"firstKeptEntry":null}),
        ),
        (
            "context_repair",
            json!({"sessionUpdate":"context_repair",
                   "repairs":[{"code":"empty_content","detail":"dropped"}]}),
        ),
        (
            "context",
            json!({"sessionUpdate":"context","tokenEstimate":5_000,"sourceEntryCount":9}),
        ),
        (
            "usage",
            json!({"sessionUpdate":"usage",
                   "turn":{"inputTokens":90,"outputTokens":30},
                   "session":{"inputTokens":120,"outputTokens":40}}),
        ),
        (
            "loop_warning",
            json!({"sessionUpdate":"loop_warning","warning":{"type":"no_progress"},
                   "hardStopRequested":true}),
        ),
        (
            "model_changed",
            json!({"sessionUpdate":"model_changed","provider":"openai","model":"gpt-5"}),
        ),
        (
            "steer",
            json!({"sessionUpdate":"steer","entryId":"e-1","text":"stop","at":"turn_boundary"}),
        ),
        (
            "agent",
            json!({"sessionUpdate":"agent","id":"spawn-1","peer":"spawn-1","status":"queued"}),
        ),
    ]
}

fn all_samples() -> Vec<(&'static str, Value)> {
    let mut samples = maximal_samples();
    samples.extend(minimal_samples());
    samples
}

/// The `provider/setup_options` answer, with **every** declared property of
/// every declared object present, so the field-parity test below has something
/// to check the schema against.
fn setup_options_sample() -> Value {
    json!({
        "presets": [
            {"id":"openai","label":"OpenAI","detail":"Official API · responses protocol",
             "provider":"openai","baseUrl":"https://api.openai.com/v1",
             "apiType":"openai_responses","model":"gpt-5.6","fastModel":"gpt-5.6-luna",
             "mergeModel":"gpt-5.6","websocket":"auto","authEnvVar":"OPENAI_API_KEY",
             "needsKey":true,"envVarSet":false,"configured":false,"custom":false},
            {"id":"compatible","label":"OpenAI-compatible","needsKey":true,"custom":true}
        ],
        "persist": [
            {"id":"keychain","label":"OS keychain",
             "detail":"Recommended · the token never enters a file","available":true},
            {"id":"env","label":"Environment variable","available":true},
            {"id":"plaintext","label":"providers.toml","available":true},
            {"id":"none","label":"No credential","available":true}
        ],
        "apiTypes": [
            {"id":"openai_responses","label":"OpenAI responses","detail":"The newer /responses format"},
            {"id":"openai_completions","label":"OpenAI chat completions"},
            {"id":"anthropic_messages","label":"Anthropic messages"}
        ],
        "path": "/home/dev/.lyra/providers.toml",
        "configured": ["anthropic"]
    })
}

/// One `provider/add` request per persistence mode.
///
/// The pairing rules are the point: the schema declares `apiKey` optional, so
/// nothing but these four documents proves this client never sends a credential
/// to a mode that has nowhere to put one.
fn add_params_samples() -> Vec<(ProviderPersist, AddProviderParams)> {
    let base = AddProviderParams {
        provider: "openai".to_owned(),
        base_url: "https://api.openai.com/v1".to_owned(),
        api_type: ConfigurableApiType::OpenAiResponses,
        model: Some("gpt-5.6".to_owned()),
        fast_model: Some("gpt-5.6-luna".to_owned()),
        merge_model: Some("gpt-5.6".to_owned()),
        websocket: Some(WebsocketMode::Auto),
        persist: ProviderPersist::Keychain,
        api_key: None,
        auth_env_var: None,
    };
    vec![
        (
            ProviderPersist::Keychain,
            AddProviderParams {
                persist: ProviderPersist::Keychain,
                api_key: Some(Secret::new("sk-keychain")),
                ..base.clone()
            },
        ),
        (
            ProviderPersist::Plaintext,
            AddProviderParams {
                persist: ProviderPersist::Plaintext,
                api_key: Some(Secret::new("sk-plaintext")),
                ..base.clone()
            },
        ),
        (
            ProviderPersist::Env,
            AddProviderParams {
                persist: ProviderPersist::Env,
                auth_env_var: Some("OPENAI_API_KEY".to_owned()),
                ..base.clone()
            },
        ),
        (
            ProviderPersist::NoCredential,
            AddProviderParams {
                provider: "local".to_owned(),
                base_url: "http://localhost:11434/v1".to_owned(),
                api_type: ConfigurableApiType::OpenAiCompletions,
                model: Some("qwen2.5-coder:14b".to_owned()),
                fast_model: None,
                merge_model: None,
                websocket: None,
                persist: ProviderPersist::NoCredential,
                ..base
            },
        ),
    ]
}

/// The edit form's request: an update to a provider that already exists, whose
/// credential is left exactly as it was.
///
/// Its own function because it is the one `provider/add` document that carries
/// **no** credential *and* no `authEnvVar` while naming a credential-backed
/// provider — the shape `persist: "keep"` exists to express, and the shape a
/// test has to be able to point at.
fn keep_params_sample() -> AddProviderParams {
    AddProviderParams {
        provider: "openai".to_owned(),
        base_url: "https://api.openai.com/v1".to_owned(),
        api_type: ConfigurableApiType::OpenAiResponses,
        model: None,
        fast_model: None,
        merge_model: None,
        websocket: Some(WebsocketMode::Auto),
        persist: ProviderPersist::Keep,
        api_key: None,
        auth_env_var: None,
    }
}

/// One half-landed change to the protocol, and how to tell whether the schema
/// has caught up with it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PendingChange {
    /// `provider/detect` exists at all.
    DetectMethod,
    /// `model/add` exists at all.
    ModelAddMethod,
    /// `provider/add` no longer requires a `model`.
    ModelOptional,
    /// Its result reports how many models were discovered.
    ModelsFound,
    /// `session/models` answers for every provider, not one.
    GroupedModels,
    /// `provider/get` exists at all.
    GetMethod,
    /// `provider/remove` exists at all.
    RemoveMethod,
    /// `persist` accepts `"keep"`: an edit that does not rotate the credential.
    KeepPersist,
    /// `provider/detect` answers with the endpoint's canonical shape.
    NormalizedUrl,
}

impl PendingChange {
    /// Whether `protocol.json` declares this yet. Until it does, the client
    /// codes against the agreed contract and the app tests hold it up against a
    /// scripted daemon; from the moment it does, the schema does.
    fn landed(self, schema: &Schema) -> bool {
        let requests = &schema.root["$defs"]["requests"];
        let declares = |method: &str, property: &str| {
            requests[method]["result"]["properties"]
                .get(property)
                .is_some()
        };
        match self {
            Self::DetectMethod => requests.get("provider/detect").is_some(),
            Self::ModelAddMethod => requests.get("model/add").is_some(),
            Self::ModelOptional => !requests["provider/add"]["params"]["required"]
                .as_array()
                .is_some_and(|required| required.iter().any(|name| name == "model")),
            Self::ModelsFound => schema.root["$defs"]["addProviderResult"]["properties"]
                .get("modelsDiscovered")
                .is_some(),
            Self::GroupedModels => declares("session/models", "providers"),
            Self::GetMethod => requests.get("provider/get").is_some(),
            Self::RemoveMethod => requests.get("provider/remove").is_some(),
            Self::KeepPersist => schema.root["$defs"]["providerPersist"]["enum"]
                .as_array()
                .is_some_and(|allowed| allowed.iter().any(|value| value == "keep")),
            Self::NormalizedUrl => declares("provider/detect", "normalizedBaseUrl"),
        }
    }
}

/// The documents of the **reshaped** provider/model contract, which the
/// TypeScript side is growing in parallel with this client.
///
/// They are here, in full, rather than only in the app tests, because they are
/// the contract: the moment `protocol.json` declares `provider/detect`,
/// `model/add`, a model-less `provider/add` or the cross-provider
/// `session/models`, the test below validates every one of them and the
/// tripwire is closed. Until then it checks the half that needs no schema —
/// that these exact documents decode through [`super::types`] without loss —
/// and reports the methods it is still waiting for.
///
/// See `App::adopt_detect`, `App::adopt_added` and `app::model_choices`: this is
/// what those read.
fn pending_contract_samples() -> Vec<(PendingChange, &'static str, Value)> {
    use PendingChange::{
        DetectMethod, GetMethod, GroupedModels, KeepPersist, ModelAddMethod, ModelOptional,
        ModelsFound, NormalizedUrl, RemoveMethod,
    };
    vec![
        (
            DetectMethod,
            "#/$defs/requests/provider~1detect/params",
            serde_json::to_value(DetectProviderParams {
                base_url: "http://localhost:11434/v1".to_owned(),
                api_key: Some(Secret::new("sk-detect")),
            })
            .expect("detect params encode"),
        ),
        (
            DetectMethod,
            "#/$defs/requests/provider~1detect/result",
            json!({"apiTypes":["openai_completions","anthropic_messages"],
                   "suggestedName":"localhost","authRequired":false}),
        ),
        (
            ModelAddMethod,
            "#/$defs/requests/model~1add/params",
            serde_json::to_value(AddModelParams {
                provider: "local".to_owned(),
                model: "qwen2.5-coder:14b".to_owned(),
            })
            .expect("model/add params encode"),
        ),
        (
            ModelAddMethod,
            "#/$defs/requests/model~1add/result",
            json!({"ok":true,"provider":"local","model":"qwen2.5-coder:14b"}),
        ),
        (
            ModelOptional,
            "#/$defs/requests/provider~1add/params",
            // The form's own request: no model, because discovery is the
            // daemon's and the form stopped asking.
            serde_json::to_value(AddProviderParams {
                provider: "local".to_owned(),
                base_url: "http://localhost:11434/v1".to_owned(),
                api_type: ConfigurableApiType::OpenAiCompletions,
                model: None,
                fast_model: None,
                merge_model: None,
                websocket: None,
                persist: ProviderPersist::NoCredential,
                api_key: None,
                auth_env_var: None,
            })
            .expect("add params encode"),
        ),
        (
            ModelsFound,
            "#/$defs/requests/provider~1add/result",
            json!({"ok":true,"provider":"local","model":"qwen2.5-coder:14b","auth":"none",
                   "path":"/home/dev/.lyra/providers.toml","modelsDiscovered":12}),
        ),
        (
            GroupedModels,
            "#/$defs/requests/session~1models/result",
            json!({"current":"anthropic/opus-5",
                   "providers":[
                       {"provider":"anthropic",
                        "models":[{"id":"opus-5","contextWindow":200_000}]},
                       {"provider":"local",
                        "models":[{"id":"qwen2.5-coder:14b"}]}]}),
        ),
        (
            NormalizedUrl,
            "#/$defs/requests/provider~1detect/result",
            json!({"apiTypes":["openai_responses"],"suggestedName":"openai",
                   "authRequired":true,
                   "normalizedBaseUrl":"https://api.openai.com/v1"}),
        ),
        (
            GetMethod,
            "#/$defs/requests/provider~1get/params",
            serde_json::to_value(GetProviderParams {
                provider: "openai".to_owned(),
            })
            .expect("provider/get params encode"),
        ),
        (
            GetMethod,
            "#/$defs/requests/provider~1get/result",
            // Every declared property at once, so the field-parity argument the
            // catalog sample makes applies here too.
            json!({"provider":"openai","baseUrl":"https://api.openai.com/v1",
                   "apiType":"openai_responses","websocket":"auto",
                   "authType":"keychain","authDetail":"dev.lyra.provider.openai",
                   "models":["gpt-5.6","gpt-5.6-luna"],"inUse":true}),
        ),
        (
            RemoveMethod,
            "#/$defs/requests/provider~1remove/params",
            serde_json::to_value(RemoveProviderParams {
                provider: "openai".to_owned(),
                remove_credential: Some(true),
            })
            .expect("provider/remove params encode"),
        ),
        (
            RemoveMethod,
            "#/$defs/requests/provider~1remove/result",
            json!({"ok":true,"provider":"openai",
                   "path":"/home/dev/.lyra/providers.toml",
                   "credentialRemoved":true,"danglingRoles":["default","fast"]}),
        ),
        (
            KeepPersist,
            "#/$defs/requests/provider~1add/params",
            serde_json::to_value(keep_params_sample()).expect("keep params encode"),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_schema_declares_exactly_the_variants_this_client_models() {
        let declared = Schema::load().update_titles();
        assert_eq!(
            declared,
            UPDATE_TAGS.to_vec(),
            "the update union drifted: regenerate acp::types::Update"
        );
    }

    #[test]
    fn every_declared_variant_has_a_sample() {
        let schema = Schema::load();
        let sampled: Vec<&str> = maximal_samples().iter().map(|(tag, _)| *tag).collect();
        assert_eq!(sampled, schema.update_titles());
    }

    #[test]
    fn every_declared_property_is_exercised_by_a_sample() {
        let schema = Schema::load();
        for (tag, sample) in maximal_samples() {
            let present = sample.as_object().expect("an update is an object");
            for property in schema.update_properties(tag) {
                assert!(
                    present.contains_key(&property),
                    "{tag}.{property} is declared in the schema but not sampled here — \
                     a field was added to the protocol and nothing in the client reads it yet"
                );
            }
        }
    }

    #[test]
    fn every_sample_validates_against_the_schema_it_claims_to_follow() {
        let schema = Schema::load();
        for (tag, sample) in all_samples() {
            let errors = schema.validate(&sample, "#/$defs/update");
            assert!(errors.is_empty(), "{tag}: {}", errors.join("; "));
        }
    }

    #[test]
    fn every_sample_round_trips_through_the_serde_types_without_loss() {
        for (tag, sample) in all_samples() {
            let decoded = Update::from_json(sample.clone());
            assert!(
                !decoded.is_unknown(),
                "{tag} did not decode into a modelled variant: {decoded:?}"
            );
            assert_eq!(decoded.tag(), tag);
            assert_eq!(
                decoded.to_json(),
                sample,
                "{tag} lost or invented a field on the way back out"
            );
        }
    }

    #[test]
    fn a_full_notification_envelope_validates_both_ways() {
        let schema = Schema::load();
        for (tag, sample) in all_samples() {
            let frame = json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {"sessionId": "session-conformance", "update": sample.clone()},
            });
            let errors = schema.validate(&frame, "#/$defs/notification");
            assert!(errors.is_empty(), "{tag}: {}", errors.join("; "));

            let decoded: UpdateNotification =
                serde_json::from_value(frame["params"].clone()).expect("envelope decodes");
            assert_eq!(decoded.session_id, "session-conformance");
            assert_eq!(decoded.update.tag(), tag);
            assert_eq!(
                serde_json::to_value(&decoded).expect("envelope re-encodes"),
                frame["params"]
            );
        }
    }

    #[test]
    fn the_legacy_frame_is_gone_from_the_contract_entirely() {
        let schema = Schema::load();
        // The pre-rewrite `{event, stats, report}` frame is no longer declared, so
        // `sessionUpdateParams` has exactly one shape and a client cannot double-apply
        // a turn by reading two.
        assert!(
            schema.root["$defs"].get("legacyUpdateParams").is_none(),
            "legacyUpdateParams must not be declared any more"
        );
        assert!(
            schema.root["$defs"]["requests"].get("session/update").is_none(),
            "the deprecated session/update request alias must be gone"
        );
        let legacy = json!({"event":{"type":"text_delta","text":"x"}});
        assert!(
            !schema
                .validate(&legacy, "#/$defs/sessionUpdateParams")
                .is_empty(),
            "the legacy frame must no longer validate as notification params"
        );
    }

    #[test]
    fn an_undeclared_variant_fails_the_schema_but_never_the_client() {
        let schema = Schema::load();
        let invented = json!({"sessionUpdate":"invented","frames":3});
        assert!(schema
            .validate(&invented, "#/$defs/update")
            .join("; ")
            .contains("matches none of the"));
        let decoded = Update::from_json(invented.clone());
        assert!(decoded.is_unknown());
        assert_eq!(decoded.to_json(), invented);
    }

    #[test]
    fn the_params_this_client_sends_validate_against_their_declared_schemas() {
        let schema = Schema::load();
        let cases: Vec<(&str, Value)> = vec![
            (
                "#/$defs/requests/session~1prompt/params",
                serde_json::to_value(PromptParams {
                    prompt: "ship it".to_owned(),
                })
                .unwrap(),
            ),
            (
                "#/$defs/requests/session~1steer/params",
                serde_json::to_value(SteerParams {
                    prompt: "actually use fetch".to_owned(),
                })
                .unwrap(),
            ),
            (
                "#/$defs/requests/session~1cancel/params",
                serde_json::to_value(CancelParams {
                    rewound_to_composer: Some(true),
                })
                .unwrap(),
            ),
            (
                "#/$defs/requests/session~1cancel/params",
                serde_json::to_value(CancelParams::default()).unwrap(),
            ),
            (
                "#/$defs/requests/session~1select_model/params",
                serde_json::to_value(SelectModelParams {
                    model: "opus-5".to_owned(),
                })
                .unwrap(),
            ),
            (
                "#/$defs/requests/session~1select_provider/params",
                serde_json::to_value(SelectProviderParams {
                    provider: "anthropic".to_owned(),
                    model: Some("opus-5".to_owned()),
                })
                .unwrap(),
            ),
        ];
        for (pointer, params) in cases {
            let errors = schema.validate(&params, pointer);
            assert!(errors.is_empty(), "{pointer}: {}", errors.join("; "));
        }
    }

    #[test]
    fn the_results_this_client_decodes_match_their_declared_schemas() {
        let schema = Schema::load();

        let steer = json!({"delivery":"steered","pending":2});
        assert!(schema
            .validate(&steer, "#/$defs/requests/session~1steer/result")
            .is_empty());
        let decoded: SteerResult = serde_json::from_value(steer).unwrap();
        assert_eq!(decoded.delivery, SteerDelivery::Steered);
        assert_eq!(decoded.pending, Some(2));

        let providers = json!({"current":"anthropic","available":["anthropic","openai"]});
        assert!(schema
            .validate(&providers, "#/$defs/requests/session~1providers/result")
            .is_empty());
        let decoded: ProvidersResult = serde_json::from_value(providers).unwrap();
        assert_eq!(decoded.available.len(), 2);

        let selection = json!({"provider":"anthropic","model":"opus-5"});
        assert!(schema
            .validate(&selection, "#/$defs/requests/session~1select_model/result")
            .is_empty());
        let decoded: ModelSelection = serde_json::from_value(selection).unwrap();
        assert_eq!(decoded.model, "opus-5");

        let listed = json!([
            {"sessionId":"s-1","name":"purple-falcon","path":"/tmp/a.jsonl","active":true,
             "firstPrompt":"fix the retry ladder","updatedAtMs":1_754_733_600_000_i64,
             "messages":34},
            {"sessionId":"s-2","name":"bare","path":"/tmp/b.jsonl","active":false},
        ]);
        assert!(schema
            .validate(&listed, "#/$defs/requests/session~1list/result")
            .is_empty());
        let decoded: Vec<SessionSummary> = serde_json::from_value(listed).unwrap();
        assert!(decoded[0].active);
        // The row is addressable: this is the id `session/update` frames carry.
        assert_eq!(decoded[0].session_id, "s-1");
        // And previewable, when the daemon measured it.
        assert_eq!(decoded[0].first_prompt.as_deref(), Some("fix the retry ladder"));
        assert_eq!(decoded[0].updated_at_ms, Some(1_754_733_600_000));
        assert_eq!(decoded[0].messages, Some(34));
        // The three preview fields are independently optional: an older daemon's
        // row still decodes, and says "not measured" rather than zero.
        assert_eq!(decoded[1].first_prompt, None);
        assert_eq!(decoded[1].updated_at_ms, None);
        assert_eq!(decoded[1].messages, None);
        assert!(decoded[1].extra.is_empty(), "no field is swallowed by the catch-all");

        let snapshot = json!({
            "descriptor":{"sessionId":"s-1","name":"purple-falcon","path":"/tmp/a.jsonl",
                          "headId":"e-3","createdAt":"2026-08-09T10:00:00.000Z"},
            "entries":[{"id":"e-1"}],
            "provider":"anthropic","model":"opus-5","apiType":"anthropic_messages",
            "workspace":"main","turnActive":true,"pendingSteer":1,
            "usage":{"session":{"inputTokens":120,"outputTokens":40,"costMicroUsd":4_321},
                     "contextTokens":4_200,"contextWindow":200_000}
        });
        assert!(schema
            .validate(&snapshot, "#/$defs/requests/session~1snapshot/result")
            .is_empty());
        let decoded: SessionSnapshot = serde_json::from_value(snapshot).unwrap();
        assert_eq!(decoded.api_type, Some(ApiType::AnthropicMessages));
        assert_eq!(decoded.pending_steer, Some(1));
        assert_eq!(
            decoded.usage.expect("usage").context_window,
            Some(200_000)
        );
    }

    /// The interactive surfaces' half of the contract.
    ///
    /// `session/commands` and `session/complete` are consumed as `Value` in
    /// [`crate::app`] rather than through generated types — their payloads are
    /// display data, not session state — so the tripwire is here: these are the
    /// exact documents the app builds and reads, validated against the schema.
    #[test]
    fn the_completion_and_command_registry_documents_validate_both_ways() {
        let schema = Schema::load();

        // What `Wire::send` builds for `Call::Complete`.
        let complete = json!({
            "sessionId": "s-1",
            "kind": "file",
            "query": "src/au",
            "limit": 40,
        });
        let errors = schema.validate(&complete, "#/$defs/requests/session~1complete/params");
        assert!(errors.is_empty(), "{}", errors.join("; "));

        // What `App::adopt_completions` reads, order included.
        let items = json!({
            "items": [
                {"value":"src/auth.ts","label":"auth.ts","detail":"src/"},
                {"value":"src/auth/token.ts","label":"token.ts","detail":"src/auth/"}
            ],
            "truncated": false,
        });
        let errors = schema.validate(&items, "#/$defs/requests/session~1complete/result");
        assert!(errors.is_empty(), "{}", errors.join("; "));

        // What `App::adopt_commands` reads.
        let commands = json!({
            "commands": [
                {"name":"model","description":"Switch model.","usage":"[id]","resultKind":"models"},
                {"name":"health","description":"Show reliability metrics.","resultKind":"health"}
            ]
        });
        let errors = schema.validate(&commands, "#/$defs/requests/session~1commands/result");
        assert!(errors.is_empty(), "{}", errors.join("; "));

        // And what `ui::results` renders.
        let answer = json!({
            "command": "health",
            "resultKind": "health",
            "output": {
                "turns": 12, "successfulTurns": 11, "compactions": 0,
                "contextRepairs": 0, "malformedMetrics": 0,
                "turnLatencyMs": {"p50":100,"p95":900,"p99":1500},
                "retries": {"rate_limit":2},
                "tools": {"read":{"calls":8,"successes":8,
                                  "firstCallSuccessRate":1.0,"latencyP95Ms":12}}
            }
        });
        let errors = schema.validate(&answer, "#/$defs/requests/session~1command/result");
        assert!(errors.is_empty(), "{}", errors.join("; "));
    }

    /// The provider-setup wizard's three methods, both directions.
    ///
    /// This is the whole contract for a surface that runs **before there is a
    /// provider**: a drifted field here does not degrade a picker, it strands a
    /// first-run user with no way to configure anything.
    #[test]
    fn the_provider_setup_documents_validate_both_ways() {
        let schema = Schema::load();

        // -- provider/setup_options ---------------------------------------
        let errors = schema.validate(
            &json!({}),
            "#/$defs/requests/provider~1setup_options/params",
        );
        assert!(errors.is_empty(), "{}", errors.join("; "));

        let options = setup_options_sample();
        let errors = schema.validate(&options, "#/$defs/requests/provider~1setup_options/result");
        assert!(errors.is_empty(), "{}", errors.join("; "));
        let decoded: ProviderSetupOptions =
            serde_json::from_value(options.clone()).expect("the catalog decodes");
        assert_eq!(decoded.presets.len(), 2);
        assert_eq!(decoded.presets[0].auth_env_var.as_deref(), Some("OPENAI_API_KEY"));
        assert!(decoded.presets[1].custom, "the custom row pre-fills nothing");
        assert_eq!(
            decoded
                .persist_option(&ProviderPersist::Keychain)
                .map(|option| option.available),
            Some(true)
        );
        assert_eq!(
            serde_json::to_value(&decoded).expect("re-encodes"),
            options,
            "the catalog lost or invented a field on the way back out"
        );

        // -- provider/verify ----------------------------------------------
        let probes = vec![
            VerifyProviderParams {
                provider: Some("openai".to_owned()),
                base_url: "https://api.openai.com/v1".to_owned(),
                api_type: ConfigurableApiType::OpenAiResponses,
                api_key: Some(Secret::new("sk-live-probe")),
                auth_env_var: None,
                timeout_ms: Some(4_000),
            },
            // The other half of the surface: a probe that names a variable, and
            // the bare minimum the schema requires.
            VerifyProviderParams {
                provider: None,
                base_url: "http://localhost:11434/v1".to_owned(),
                api_type: ConfigurableApiType::OpenAiCompletions,
                api_key: None,
                auth_env_var: Some("OPENAI_API_KEY".to_owned()),
                timeout_ms: None,
            },
        ];
        for probe in &probes {
            let params = serde_json::to_value(probe).expect("params encode");
            let errors = schema.validate(&params, "#/$defs/requests/provider~1verify/params");
            assert!(errors.is_empty(), "{params}: {}", errors.join("; "));
        }

        for result in [
            json!({"ok":true,"models":42,"sample":["gpt-5.6","gpt-5.6-luna"]}),
            json!({"ok":false,"error":{"classification":"auth","message":"invalid api key",
                                       "code":"invalid_api_key","status":401}}),
        ] {
            let errors = schema.validate(&result, "#/$defs/requests/provider~1verify/result");
            assert!(errors.is_empty(), "{result}: {}", errors.join("; "));
            let decoded: VerifyProviderResult =
                serde_json::from_value(result.clone()).expect("a probe answer decodes");
            assert_eq!(decoded.ok, result["ok"], "the outcome survives the round trip");
            assert_eq!(serde_json::to_value(&decoded).expect("re-encodes"), result);
        }

        // -- provider/add --------------------------------------------------
        for (persist, params) in add_params_samples() {
            let encoded = serde_json::to_value(&params).expect("params encode");
            let errors = schema.validate(&encoded, "#/$defs/requests/provider~1add/params");
            assert!(errors.is_empty(), "{persist}: {}", errors.join("; "));
        }

        let saved = json!({"ok":true,"provider":"openai","model":"gpt-5.6","auth":"keychain",
                           "path":"/home/dev/.lyra/providers.toml",
                           "warnings":["ANTHROPIC_API_KEY is not set in this process."]});
        let errors = schema.validate(&saved, "#/$defs/requests/provider~1add/result");
        assert!(errors.is_empty(), "{}", errors.join("; "));
        let decoded: AddProviderResult = serde_json::from_value(saved.clone()).expect("decodes");
        assert!(decoded.ok);
        assert_eq!(decoded.auth, ProviderAuthSource::Keychain);
        assert_eq!(decoded.warnings.len(), 1);
        assert_eq!(serde_json::to_value(&decoded).expect("re-encodes"), saved);
    }

    /// The reshaped contract, checked against the schema the moment it lands.
    ///
    /// This client codes against methods `protocol.json` does not declare yet —
    /// `provider/detect` and `model/add` — and against two changes to methods it
    /// does: `provider/add` params without a `model`, and its result carrying
    /// `modelsDiscovered`. That is the established shape for a two-sided change:
    /// the adapter is real and tested against a scripted daemon, and the schema
    /// half of the tripwire arms itself when the declaration appears rather than
    /// being written twice.
    #[test]
    fn the_reshaped_provider_and_model_contract_validates_as_soon_as_the_schema_declares_it() {
        let schema = Schema::load();
        for (change, pointer, document) in pending_contract_samples() {
            if !change.landed(&schema) {
                continue;
            }
            let errors = schema.validate(&document, pointer);
            assert!(
                errors.is_empty(),
                "{change:?} at {pointer}: {} — the schema carries this change now, \
                 and what the client sends or reads no longer matches it",
                errors.join("; ")
            );
        }

        // The half that needs no schema: these are the documents the client
        // actually builds and decodes.
        let detect: DetectProviderResult = serde_json::from_value(
            json!({"apiTypes":["openai_completions","anthropic_messages"],
                   "suggestedName":"localhost","authRequired":false}),
        )
        .expect("a detection answer decodes");
        assert_eq!(detect.api_types.len(), 2, "the dual-protocol case");
        assert_eq!(detect.auth_required, Some(false));
        assert_eq!(detect.suggested_name.as_deref(), Some("localhost"));

        let empty: DetectProviderResult =
            serde_json::from_value(json!({})).expect("an answer that learned nothing decodes");
        assert!(
            empty.api_types.is_empty(),
            "detection that learned nothing is an empty list, never a failure"
        );

        let added: AddModelResult =
            serde_json::from_value(json!({"ok":true,"provider":"local","model":"qwen2.5"}))
                .expect("model/add decodes");
        assert!(added.ok);

        // Both model listings, through one type: grouped, and the flat one a
        // daemon that predates the reshape still answers with.
        let grouped: ModelsResult = serde_json::from_value(
            json!({"current":"anthropic/opus-5",
                   "providers":[{"provider":"anthropic","models":[{"id":"opus-5"}]},
                                {"provider":"local","models":[]}]}),
        )
        .expect("the cross-provider listing decodes");
        assert_eq!(grouped.providers.len(), 2);
        assert_eq!(grouped.current.as_deref(), Some("anthropic/opus-5"));
        assert!(
            grouped.providers[1].models.is_empty(),
            "a provider whose discovery failed still appears"
        );
        let flat: ModelsResult = serde_json::from_value(
            json!({"provider":"anthropic","current":"opus-5","models":[{"id":"opus-5"}]}),
        )
        .expect("the flat listing still decodes");
        assert!(flat.providers.is_empty());
        assert_eq!(flat.models.len(), 1);

        // `modelsDiscovered` absent is *unknown*, not zero — the whole
        // distinction the saved line draws.
        let discovered: AddProviderResult = serde_json::from_value(
            json!({"ok":true,"provider":"local","auth":"none","path":"/tmp/p.toml",
                   "modelsDiscovered":12}),
        )
        .expect("a save with discovery decodes");
        assert_eq!(discovered.models_discovered, Some(12));
        assert_eq!(discovered.model, None, "a saved provider need not name a model");
        let silent: AddProviderResult = serde_json::from_value(
            json!({"ok":true,"provider":"local","model":"m","auth":"none","path":"/tmp/p.toml"}),
        )
        .expect("a save without discovery decodes");
        assert_eq!(silent.models_discovered, None);

        // `provider/get` — the edit form's pre-fill, and the one answer about a
        // provider that is *guaranteed* to be safe to render.
        let info: ProviderInfo = serde_json::from_value(
            json!({"provider":"openai","baseUrl":"https://api.openai.com/v1",
                   "apiType":"openai_responses","authType":"keychain",
                   "authDetail":"dev.lyra.provider.openai",
                   "models":["gpt-5.6"],"inUse":true}),
        )
        .expect("provider/get decodes");
        assert_eq!(info.auth_summary(), "keychain · dev.lyra.provider.openai");
        assert!(info.removable_credential(), "a keychain entry is Lyra's to delete");
        assert!(!info.credential_goes_with_it());
        assert!(info.in_use, "and the session is on it, so a removal will be refused");
        let printed = serde_json::to_string(&info).expect("re-encodes");
        assert!(
            !printed.contains("apiKey") && !printed.contains("Secret"),
            "there is no field on this result a credential could be in: {printed}"
        );

        let local: ProviderInfo = serde_json::from_value(
            json!({"provider":"local","baseUrl":"http://localhost:11434/v1",
                   "apiType":"openai_completions","authType":"none"}),
        )
        .expect("a credential-less provider decodes");
        assert!(
            !local.removable_credential(),
            "nothing is stored, so a removal is not asked whether to remove it"
        );
        // The one source whose credential is destroyed by the removal itself,
        // and the one this client must therefore state rather than ask about.
        let plaintext: ProviderInfo = serde_json::from_value(
            json!({"provider":"gateway","baseUrl":"https://gw/v1",
                   "apiType":"openai_completions","authType":"static",
                   "models":[],"inUse":false}),
        )
        .expect("a plaintext-backed provider decodes");
        assert!(!plaintext.removable_credential() && plaintext.credential_goes_with_it());
        // And a helper this client did not install and cannot replace.
        let plugin: ProviderInfo = serde_json::from_value(
            json!({"provider":"corp","baseUrl":"https://corp/v1",
                   "apiType":"anthropic_messages","authType":"plugin",
                   "authDetail":"corp-credential-helper","models":[],"inUse":false}),
        )
        .expect("a plugin-backed provider decodes");
        assert!(!plugin.auth_type.is_unknown(), "the schema declares it, so this build models it");
        assert!(!plugin.removable_credential() && !plugin.credential_goes_with_it());
        assert_eq!(plugin.auth_summary(), "plugin · corp-credential-helper");
        assert_eq!(local.auth_summary(), "none");
        assert!(local.models.is_empty() && !local.in_use, "absent reads as empty, not unknown");

        // `provider/remove` — the facts a confirmation line is built from,
        // including the repointed default the daemon writes so the next boot
        // never crashes on a role naming a provider that is gone.
        let removed: RemoveProviderResult = serde_json::from_value(
            json!({"ok":true,"provider":"openai","path":"/tmp/p.toml",
                   "credentialRemoved":true,"danglingRoles":["fast","merge"],
                   "defaultRepointedTo":"claude-max/claude-opus-5"}),
        )
        .expect("provider/remove decodes");
        assert_eq!(removed.credential_removed, Some(true));
        assert_eq!(removed.dangling_roles, vec!["fast".to_owned(), "merge".to_owned()]);
        assert_eq!(
            removed.default_repointed_to.as_deref(),
            Some("claude-max/claude-opus-5")
        );
        let cleared: RemoveProviderResult = serde_json::from_value(
            json!({"ok":true,"provider":"last-one","path":"/tmp/p.toml",
                   "rolesCleared":["default","fast","merge"]}),
        )
        .expect("a last-provider removal decodes");
        assert_eq!(cleared.roles_cleared.len(), 3);
        assert!(cleared.default_repointed_to.is_none(), "nothing left to repoint at");
        let quiet: RemoveProviderResult =
            serde_json::from_value(json!({"ok":true,"provider":"local","path":"/tmp/p.toml"}))
                .expect("a removal with nothing to say decodes");
        assert_eq!(
            quiet.credential_removed, None,
            "absent is 'there was nothing stored', which is not 'it was kept'"
        );
        assert!(quiet.dangling_roles.is_empty());

        // The endpoint's canonical shape, which the form adopts.
        let normalised: DetectProviderResult = serde_json::from_value(
            json!({"apiTypes":["openai_responses"],
                   "normalizedBaseUrl":"https://api.openai.com/v1"}),
        )
        .expect("a normalising answer decodes");
        assert_eq!(
            normalised.normalized_base_url.as_deref(),
            Some("https://api.openai.com/v1")
        );
        assert_eq!(
            empty.normalized_base_url, None,
            "an answer that normalises nothing says nothing"
        );
    }

    /// Every property the catalog declares is read by this client.
    ///
    /// The same tripwire the update union has: a pre-fill the daemon starts
    /// sending and the wizard silently ignores is a form that asks a question
    /// the answer to which was already on the wire.
    #[test]
    fn every_declared_preset_property_is_exercised_by_the_catalog_sample() {
        let schema = Schema::load();
        let sample = setup_options_sample();
        for (pointer, present) in [
            ("#/$defs/providerPreset", &sample["presets"][0]),
            ("#/$defs/providerPersistOption", &sample["persist"][0]),
            ("#/$defs/providerApiTypeOption", &sample["apiTypes"][0]),
            ("#/$defs/providerSetupOptionsResult", &sample),
        ] {
            let declared = schema.resolve(pointer)["properties"]
                .as_object()
                .expect("an object schema");
            let object = present.as_object().expect("an object sample");
            for property in declared.keys() {
                assert!(
                    object.contains_key(property),
                    "{pointer}.{property} is declared but not sampled here — \
                     the wizard would ignore a pre-fill the daemon already sends"
                );
            }
        }
    }

    /// The credential-shaped rule, asserted on the bytes.
    ///
    /// `persist: env` and `persist: none` have nowhere to put a token, and the
    /// daemon *rejects* a request that carries one — so a wizard that sent it
    /// anyway would fail at the last step. This proves the encoder cannot.
    #[test]
    fn a_persist_mode_with_nowhere_to_put_a_token_never_carries_one() {
        let keep = serde_json::to_string(&keep_params_sample()).expect("keep params encode");
        assert_eq!(
            serde_json::from_str::<Value>(&keep).expect("valid json")["persist"],
            json!("keep")
        );
        assert!(
            !keep.contains("apiKey") && !keep.contains("authEnvVar"),
            "an edit that keeps its credential says nothing at all about one: {keep}"
        );

        for (persist, params) in add_params_samples() {
            let encoded = serde_json::to_string(&params).expect("params encode");
            match persist {
                ProviderPersist::Env | ProviderPersist::NoCredential | ProviderPersist::Keep => assert!(
                    !encoded.contains("apiKey"),
                    "{persist} must not carry a credential: {encoded}"
                ),
                _ => assert!(encoded.contains("apiKey"), "{persist}: {encoded}"),
            }
            // And whatever the mode, the credential is never in a debug dump.
            let printed = format!("{params:?}");
            assert!(!printed.contains("sk-"), "a credential reached Debug: {printed}");
        }
    }

    /// An unconfigured daemon is distinguishable from an old one.
    #[test]
    fn a_snapshot_reports_an_unconfigured_daemon_and_absence_means_configured() {
        let schema = Schema::load();
        let unconfigured = json!({
            "descriptor":{"sessionId":"s-1","name":"first-run","path":"/tmp/a.jsonl",
                          "headId":"e-0","createdAt":"2026-08-09T10:00:00.000Z"},
            "entries":[], "provider":"", "model":"", "providerConfigured": false,
            "usage":{"session":{"inputTokens":0,"outputTokens":0}}
        });
        let errors = schema.validate(&unconfigured, "#/$defs/requests/session~1snapshot/result");
        assert!(errors.is_empty(), "{}", errors.join("; "));
        let decoded: SessionSnapshot = serde_json::from_value(unconfigured).expect("decodes");
        assert!(!decoded.is_provider_configured());

        let legacy = json!({
            "descriptor":{"sessionId":"s-1","name":"old","path":"/tmp/a.jsonl",
                          "headId":"e-0","createdAt":"2026-08-09T10:00:00.000Z"},
            "entries":[], "provider":"anthropic", "model":"opus-5",
            "usage":{"session":{"inputTokens":0,"outputTokens":0}}
        });
        let decoded: SessionSnapshot = serde_json::from_value(legacy).expect("decodes");
        assert!(
            decoded.is_provider_configured(),
            "a daemon that predates the field must not be mistaken for an unconfigured one"
        );
    }

    /// Every method this client can put on the wire is one the schema declares.
    ///
    /// The gap this closes is the one `session/rewind` fell into: a client can
    /// name a method that does not exist and find out at runtime, one `-32601`
    /// per gesture, with the failure surfacing as "the key did nothing". The
    /// three that are *not* in `#/$defs/requests` are named here individually,
    /// because each is a deliberate exception rather than an oversight.
    #[test]
    fn every_method_this_client_can_send_is_declared_by_the_schema() {
        use crate::acp::types::method;
        let schema = Schema::load();
        let requests = schema.resolve("#/$defs/requests");
        // The notification the daemon sends *us*, the JSON-RPC control frame,
        // and the one request that travels daemon→client.
        let exceptions = [
            method::SESSION_UPDATE,
            method::CANCEL_REQUEST,
            method::SESSION_REQUEST_PERMISSION,
        ];
        for name in [
            method::INITIALIZE,
            method::SESSION_NEW,
            method::SESSION_LOAD,
            method::SESSION_LIST,
            method::SESSION_SNAPSHOT,
            method::SESSION_PROMPT,
            method::SESSION_STEER,
            method::SESSION_CANCEL,
            method::SESSION_FORK,
            method::SESSION_REWIND,
            method::SESSION_COMMAND,
            method::SESSION_COMMANDS,
            method::SESSION_COMPLETE,
            method::SESSION_MODELS,
            method::SESSION_SELECT_MODEL,
            method::SESSION_PROVIDERS,
            method::SESSION_SELECT_PROVIDER,
            method::PROVIDER_SETUP_OPTIONS,
            method::PROVIDER_DETECT,
            method::PROVIDER_VERIFY,
            method::PROVIDER_ADD,
            method::PROVIDER_GET,
            method::PROVIDER_REMOVE,
            method::MODEL_ADD,
            method::CHECKPOINT_LIST,
            method::CHECKPOINT_DIFF,
            method::CHECKPOINT_RESTORE,
            method::CONTEXT_INSPECT,
        ] {
            assert!(
                requests.get(name).is_some(),
                "{name} is a method this client sends and the schema does not declare"
            );
        }
        for name in exceptions {
            assert!(
                requests.get(name).is_none(),
                "{name} is declared as a client→daemon request now; move it out of the exceptions"
            );
        }
    }

    /// The rewind surface, both directions.
    ///
    /// Four methods and two command shapes, and the reason they are one test is
    /// that they are one gesture: `Esc Esc` reads `checkpoint/list`, sends
    /// `session/rewind` and `checkpoint/restore`, and renders what
    /// `checkpointRestoreResult` says was *not* done. A drift in any of them
    /// turns the one destructive surface in this client into a guess.
    #[test]
    fn the_rewind_documents_validate_both_ways() {
        let schema = Schema::load();

        // -- what this client sends ---------------------------------------
        for (pointer, params) in [
            (
                "#/$defs/requests/checkpoint~1list/params",
                json!({ "limit": 100 }),
            ),
            (
                "#/$defs/requests/checkpoint~1restore/params",
                serde_json::to_value(RestoreParams {
                    checkpoint: "c-9".to_owned(),
                    force: true,
                })
                .expect("restore params encode"),
            ),
            (
                "#/$defs/requests/checkpoint~1restore/params",
                serde_json::to_value(RestoreParams {
                    checkpoint: "latest".to_owned(),
                    force: false,
                })
                .expect("restore params encode"),
            ),
            (
                "#/$defs/requests/session~1rewind/params",
                serde_json::to_value(RewindParams {
                    entry_id: Some("e-42".to_owned()),
                })
                .expect("rewind params encode"),
            ),
            (
                "#/$defs/requests/session~1rewind/params",
                serde_json::to_value(RewindParams::default()).expect("rewind params encode"),
            ),
        ] {
            let errors = schema.validate(&params, pointer);
            assert!(errors.is_empty(), "{pointer}: {}", errors.join("; "));
        }
        // A restore that is not forcing says nothing about forcing: the daemon's
        // default is not to, and the flag is the one thing behind a confirmation.
        let quiet = serde_json::to_string(&RestoreParams {
            checkpoint: "c-1".to_owned(),
            force: false,
        })
        .expect("encodes");
        assert!(!quiet.contains("force"), "{quiet}");

        // -- what this client decodes -------------------------------------
        let checkpoint = json!({"id":"c-9","kind":"pre_tool","label":"before edit src/auth.ts",
                                "createdAt":"2026-08-10T09:00:00.000Z","changedFiles":3,
                                "entryId":"e-42","tool":"edit","callId":"call-1",
                                "excluded":[".lyra","node_modules"]});
        let listed = json!({"checkpoints":[checkpoint.clone()],"available":true});
        assert!(schema
            .validate(&listed, "#/$defs/requests/checkpoint~1list/result")
            .is_empty());
        // The same document is `/checkpoints`'s declared output, which is the
        // whole argument for the kind: one shape, two ways to ask for it.
        assert!(schema.validate(&listed, "#/$defs/checkpointsResult").is_empty());
        let decoded: CheckpointListResult = serde_json::from_value(listed).expect("decodes");
        assert_eq!(decoded.checkpoints[0].anchored(), Some("e-42"));
        assert_eq!(decoded.checkpoints[0].kind, CheckpointKind::PreTool);
        assert_eq!(decoded.checkpoints[0].title(), "before edit src/auth.ts");

        // Unavailable is a different answer from empty, and the client renders
        // the reason rather than an empty list that reads as "nothing yet".
        let nowhere = json!({"checkpoints":[],"available":false,
                             "unavailable":"no git in PATH"});
        assert!(schema
            .validate(&nowhere, "#/$defs/requests/checkpoint~1list/result")
            .is_empty());
        let decoded: CheckpointListResult = serde_json::from_value(nowhere).expect("decodes");
        assert!(!decoded.available && decoded.unavailable.is_some());

        let diff = json!({
            "from":{"kind":"checkpoint","id":"c-9","label":"turn start",
                    "createdAt":"2026-08-10T09:00:00.000Z"},
            "to":{"kind":"worktree"},
            "files":[{"path":"src/auth.ts","status":"modified","additions":12,"deletions":4,
                      "binary":false,"patch":"--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1 @@\n-old\n+new\n",
                      "patchTruncated":false},
                     {"path":"logo.png","status":"added","binary":true},
                     {"path":"src/new.ts","status":"renamed","oldPath":"src/old.ts",
                      "additions":0,"deletions":0}],
            "truncated":false,"available":true});
        assert!(schema
            .validate(&diff, "#/$defs/requests/checkpoint~1diff/result")
            .is_empty());
        let decoded: CheckpointDiffResult = serde_json::from_value(diff.clone()).expect("decodes");
        assert_eq!(decoded.to.describe(), "the working tree");
        assert!(decoded.files[1].binary && decoded.files[1].patch.is_none());
        assert_eq!(decoded.files[2].old_path.as_deref(), Some("src/old.ts"));
        // A binary file's counts are *absent*, never zero — the distinction the
        // renderer needs to say "binary" instead of "+0 −0".
        assert_eq!(decoded.files[1].additions, None);

        // `/review` carries that same diff, so one renderer serves both.
        let review = json!({"diff": diff, "agents": [
            {"name":"activity-module","path":"/tmp/w","origin":"/repo","state":"active",
             "mode":"worktree","createdAt":"t","updatedAt":"t",
             "integration":{"hint":["git fetch /tmp/w"]}}]});
        assert!(schema.validate(&review, "#/$defs/reviewResult").is_empty());

        let restored = json!({
            "target": checkpoint.clone(),
            "safety": {"id":"c-10","kind":"pre_restore","label":"before restore",
                       "createdAt":"2026-08-10T09:05:00.000Z","changedFiles":3,"excluded":[]},
            "restored":["src/auth.ts"],"preserved":["README.md"],"forced":false,
            "excluded":[".lyra"]});
        assert!(schema
            .validate(&restored, "#/$defs/requests/checkpoint~1restore/result")
            .is_empty());
        let decoded: CheckpointRestoreResult = serde_json::from_value(restored).expect("decodes");
        assert_eq!(decoded.preserved, vec!["README.md".to_owned()]);
        assert!(!decoded.forced);
        // The undo, named. A restore a client cannot offer to undo is a restore
        // it should not have offered to make.
        assert_eq!(decoded.safety.id, "c-10");

        let rewound = json!({"descriptor":{"sessionId":"s-1","name":"purple-falcon",
                                           "path":"/tmp/a.jsonl","headId":"e-42",
                                           "createdAt":"2026-08-09T10:00:00.000Z"},
                             "entryId":"e-42","removedMessages":4});
        assert!(schema
            .validate(&rewound, "#/$defs/requests/session~1rewind/result")
            .is_empty());
        let decoded: RewindResult = serde_json::from_value(rewound).expect("decodes");
        assert_eq!(decoded.removed_messages, Some(4));
        assert_eq!(decoded.descriptor.head_id.as_deref(), Some("e-42"));
        // Absent is "not counted", which the client renders as silence rather
        // than as "nothing moved".
        let uncounted: RewindResult = serde_json::from_value(
            json!({"descriptor":{"sessionId":"s-1","name":"n","path":"/p","headId":"e-1",
                                 "createdAt":"t"},"entryId":"e-1"}),
        )
        .expect("decodes");
        assert_eq!(uncounted.removed_messages, None);
    }

    /// A snapshot's `agents`: the presence strip, hydrated.
    #[test]
    fn a_snapshot_carries_the_children_a_presence_strip_is_drawn_from() {
        let schema = Schema::load();
        let snapshot = json!({
            "descriptor":{"sessionId":"s-1","name":"swarm","path":"/tmp/a.jsonl",
                          "headId":"e-3","createdAt":"2026-08-09T10:00:00.000Z"},
            "entries":[], "provider":"anthropic", "model":"opus-5",
            "workspace":"/home/dev/project",
            "usage":{"session":{"inputTokens":0,"outputTokens":0}},
            "agents":[{"id":"spawn-1","peer":"activity-module","workspace":"/home/dev/project",
                       "status":"awaiting_tool","startedAt":1_700_000_000_000_i64,
                       "label":"activity","model":"gpt-5.6-terra","toolCalls":7,
                       "filesModified":["src/a.ts","src/b.ts"]},
                      {"id":"spawn-2","peer":"qa-checker","workspace":"/home/dev/project",
                       "status":"timed_out","startedAt":1_700_000_000_000_i64,
                       "error":"deadline expired"}]
        });
        let errors = schema.validate(&snapshot, "#/$defs/requests/session~1snapshot/result");
        assert!(errors.is_empty(), "{}", errors.join("; "));
        let decoded: SessionSnapshot = serde_json::from_value(snapshot).expect("decodes");
        assert_eq!(decoded.agents.len(), 2);
        // The handle knows paths and a transition knows a count; folding one
        // into the other is a length, never an invented number.
        let update = decoded.agents[0].as_update();
        assert_eq!(update.files_modified, Some(2));
        assert_eq!(update.peer, "activity-module");
        assert_eq!(decoded.agents[1].status, AgentState::TimedOut);
        // And the header's last field is a real path, printed as it arrived.
        assert_eq!(decoded.workspace.as_deref(), Some("/home/dev/project"));

        // A daemon that predates the field says nothing rather than "none".
        let older: SessionSnapshot = serde_json::from_value(json!({
            "descriptor":{"sessionId":"s-1","name":"n","path":"/p","headId":"e-1",
                          "createdAt":"t"},
            "entries":[], "provider":"p", "model":"m",
            "usage":{"session":{"inputTokens":0,"outputTokens":0}}
        }))
        .expect("decodes");
        assert!(older.agents.is_empty());
    }

    /// Every shape the daemon can name has a renderer that is not a JSON dump.
    #[test]
    fn every_declared_command_result_kind_has_a_renderer() {
        let schema = Schema::load();
        let Value::Array(declared) = &schema.resolve("#/$defs/commandResultKind")["enum"] else {
            panic!("commandResultKind must declare an enum");
        };
        let mut declared: Vec<&str> = declared.iter().filter_map(Value::as_str).collect();
        let mut modelled: Vec<&str> = crate::ui::results::KINDS.to_vec();
        declared.sort_unstable();
        modelled.sort_unstable();
        assert_eq!(
            declared, modelled,
            "a kind the daemon can send would fall back to the key/value tree \
             instead of the table it deserves"
        );
    }

    /// Every closed string enum in the schema is modelled by a `wire_enum!`, and
    /// each accepts precisely the values the schema declares.
    #[test]
    fn every_declared_enum_value_maps_onto_a_modelled_variant() {
        let schema = Schema::load();
        /// A schema `$defs` name paired with the predicate that says whether
        /// `acp::types` models a value of it.
        type EnumCase = (&'static str, fn(&str) -> bool);
        let cases: Vec<EnumCase> = vec![
            ("providerClassification", |value| {
                !decodes_to::<Classification>(value).is_unknown()
            }),
            ("stopReason", |value| {
                !decodes_to::<StopReason>(value).is_unknown()
            }),
            ("apiType", |value| {
                !decodes_to::<ApiType>(value).is_unknown()
            }),
            ("deltaField", |value| {
                !decodes_to::<DeltaField>(value).is_unknown()
            }),
            ("toolStatus", |value| {
                !decodes_to::<ToolStatus>(value).is_unknown()
            }),
            ("turnStatus", |value| {
                !decodes_to::<TurnStatus>(value).is_unknown()
            }),
            ("pauseKind", |value| {
                !decodes_to::<PauseKind>(value).is_unknown()
            }),
            ("providerPersist", |value| {
                !decodes_to::<ProviderPersist>(value).is_unknown()
            }),
            ("configurableApiType", |value| {
                !decodes_to::<ConfigurableApiType>(value).is_unknown()
            }),
            ("agentState", |value| {
                !decodes_to::<AgentState>(value).is_unknown()
            }),
        ];
        for (name, modelled) in cases {
            let declared = schema.resolve(&format!("#/$defs/{name}"))["enum"]
                .as_array()
                .expect("an enum")
                .clone();
            for value in declared.iter().filter_map(Value::as_str) {
                assert!(
                    modelled(value),
                    "{name} declares {value} but acp::types does not model it"
                );
            }
        }
    }

    /// The enums the schema declares **inline**, on a variant of the update
    /// union rather than under `$defs`.
    ///
    /// [`every_declared_enum_value_maps_onto_a_modelled_variant`] resolves
    /// `#/$defs/<name>` and therefore cannot see these, which is exactly how
    /// `steer.source` and `agent.event` — both wave-3 fields, both closed string
    /// enums, both load-bearing for who or what a row is about — got a modelled
    /// type with no tripwire on it.
    #[test]
    fn every_inline_enum_on_the_update_union_maps_onto_a_modelled_variant() {
        let schema = Schema::load();
        /// A variant title, one of its properties, and the predicate saying
        /// whether `acp::types` models a value of it.
        type InlineCase = (&'static str, &'static str, fn(&str) -> bool);
        let cases: Vec<InlineCase> = vec![
            ("steer", "source", |value| {
                !decodes_to::<SteerSource>(value).is_unknown()
            }),
            ("agent", "event", |value| {
                !decodes_to::<AgentTransition>(value).is_unknown()
            }),
        ];
        for (title, property, modelled) in cases {
            let branch = schema.resolve("#/$defs/update")["oneOf"]
                .as_array()
                .expect("the update union is a oneOf")
                .iter()
                .find(|branch| branch["title"].as_str() == Some(title))
                .unwrap_or_else(|| panic!("no variant titled {title}"))
                .clone();
            let declared = branch["properties"][property]["enum"]
                .as_array()
                .unwrap_or_else(|| {
                    panic!("{title}.{property} is no longer an inline enum — move it to a $def")
                })
                .clone();
            assert!(!declared.is_empty(), "{title}.{property} declares nothing");
            for value in declared.iter().filter_map(Value::as_str) {
                assert!(
                    modelled(value),
                    "{title}.{property} declares {value} but acp::types does not model it"
                );
            }
        }
    }

    /// A revival is a transition the *state* cannot express.
    ///
    /// `started` and `revived` both leave a child `running`, so a client reading
    /// only `status` sees one thing where the daemon said two. This is the
    /// tripwire on the field that fixes it: the sample validates, decodes, and
    /// round-trips, and a daemon that predates the field still decodes to
    /// `None` rather than to a fabricated transition.
    #[test]
    fn an_agent_update_carries_the_transition_the_status_cannot_express() {
        let schema = Schema::load();
        for transition in ["spawned", "started", "completed", "failed", "cancelled",
                           "timed_out", "revived"] {
            let sample = json!({"sessionUpdate":"agent","id":"spawn-1","peer":"activity-module",
                                "status":"running","event":transition});
            let errors = schema.validate(&sample, "#/$defs/update");
            assert!(errors.is_empty(), "{transition}: {}", errors.join("; "));
            let decoded = Update::from_json(sample.clone());
            let Update::Agent(agent) = &decoded else {
                panic!("{transition} decoded to {decoded:?} rather than an agent update");
            };
            assert!(
                agent.event.as_ref().is_some_and(|event| !event.is_unknown()),
                "{transition} is not modelled"
            );
            assert_eq!(decoded.to_json(), sample, "{transition} lost something");
        }

        // And the daemon that predates the field: absent stays absent, so
        // nothing downstream can mistake a silence for a declared `started`.
        let older = json!({"sessionUpdate":"agent","id":"spawn-1","peer":"p","status":"running"});
        let Update::Agent(agent) = Update::from_json(older.clone()) else {
            panic!("an agent update without `event` must still decode");
        };
        assert_eq!(agent.event, None);
        assert_eq!(Update::from_json(older.clone()).to_json(), older);
    }

    fn decodes_to<T: serde::de::DeserializeOwned>(value: &str) -> T {
        serde_json::from_value(Value::String(value.to_owned())).expect("a string enum decodes")
    }
}
