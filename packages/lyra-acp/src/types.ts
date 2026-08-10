// The single source of truth for this list is schema/protocol.json; a conformance test
// fails the build if the two ever disagree.
export const ACP_METHODS = [
  "session/new", "session/load", "session/list", "session/snapshot", "session/prompt", "session/steer",
  "session/cancel", "session/fork", "session/rewind", "session/command", "session/commands", "session/complete",
  "session/models", "session/select_model", "session/providers", "session/select_provider",
  "provider/setup_options", "provider/detect", "provider/verify", "provider/add",
  "provider/get", "provider/remove",
  "model/add",
  "workspace/list", "workspace/create", "workspace/drop",
  "agent/list", "agent/spawn", "agent/cancel", "agent/message",
  "git/preview", "git/apply",
  "checkpoint/list", "checkpoint/diff", "checkpoint/restore",
  "context/inspect", "settings/get", "settings/set",
] as const;

/**
 * The declared shapes a slash command's `output` can take, in the same order the schema
 * declares them. A kind K other than "report" means the output validates against
 * `#/$defs/KResult`; "report" is the open `{report, detail?}` shape every free-form
 * command uses. A conformance test keeps this list and the schema's enum identical.
 */
export const ACP_COMMAND_RESULT_KINDS = [
  "models", "sessions", "workspaces", "agents", "health", "context", "skills", "mcp",
  "checkpoints", "review", "report",
] as const;
export type AcpCommandResultKind = typeof ACP_COMMAND_RESULT_KINDS[number];

/** One row of `session/commands`: what the `/` popup renders and what the palette invokes. */
export interface AcpCommandDescriptor {
  name: string;
  description: string;
  /** Present only when the command takes arguments. */
  usage?: string;
  resultKind: AcpCommandResultKind;
}
export interface AcpCommandsResult { commands: readonly AcpCommandDescriptor[]; }

/** One already-ranked completion candidate. `value` is inserted verbatim by the client. */
export interface AcpCompletionItem { value: string; label?: string; detail?: string; }
export interface AcpCompletionResult { items: AcpCompletionItem[]; truncated: boolean; }
/** A popup shows a handful of rows; a bigger page would cost latency nobody sees. */
export const ACP_COMPLETION_LIMIT_DEFAULT = 10;
export const ACP_COMPLETION_LIMIT_MAX = 50;

/**
 * The provider-setup surface (`provider/setup_options`, `provider/verify`, `provider/add`).
 *
 * `apiKey` is the one field on this wire that is a credential. It crosses the local stdio
 * pipe because that pipe is the daemon and the client it was spawned by — one trust domain —
 * and it stops there: no handler logs its parameters, no result echoes it, and no
 * `session/update` notification carries it. The result names the auth *source* only.
 */
export type AcpProviderPersist = "keychain" | "plaintext" | "env" | "none" | "keep";
/** The credential sources a configured provider can name. `plugin` is hand-written only. */
export type AcpProviderAuthType = "keychain" | "env" | "static" | "none" | "plugin";
export type AcpConfigurableApiType = "openai_completions" | "openai_responses" | "anthropic_messages";
export interface AcpProviderPreset {
  id: string; label: string; detail?: string;
  provider?: string; baseUrl?: string; apiType?: AcpConfigurableApiType;
  model?: string; fastModel?: string; mergeModel?: string; websocket?: "auto" | "on" | "off";
  /** A variable *name*, never its contents. */
  authEnvVar?: string;
  needsKey: boolean; envVarSet?: boolean; configured?: boolean; custom: boolean;
}
export interface AcpProviderSetupOptions {
  presets: readonly AcpProviderPreset[];
  persist: ReadonlyArray<{ id: AcpProviderPersist; label: string; detail?: string; available: boolean }>;
  apiTypes: ReadonlyArray<{ id: AcpConfigurableApiType; label: string; detail?: string }>;
  path: string;
  configured: readonly string[];
}
export interface AcpAddProviderParams {
  provider: string; baseUrl: string; apiType: AcpConfigurableApiType;
  /** Absent per the add-never-switches design: models are chosen later via `/model`. */
  model?: string;
  fastModel?: string; mergeModel?: string; websocket?: "auto" | "on" | "off";
  persist: AcpProviderPersist;
  /** SECRET. Present only for keychain/plaintext persistence. */
  apiKey?: string;
  authEnvVar?: string;
}
export interface AcpAddProviderResult {
  ok: true; provider: string;
  /** Present only when the add carried a model (legacy callers); the redesigned wizard sends none. */
  model?: string;
  auth: AcpProviderAuthType;
  path: string; warnings?: string[];
  /**
   * How many models the new provider turned out to have, when asking was possible. Absent
   * means "not known" — an endpoint with no `/models` route, one that did not answer in time,
   * or one that refused the credential. Never zero-as-unknown: a provider is added either way.
   */
  modelsDiscovered?: number;
}
/**
 * `provider/detect`: what protocol an endpoint speaks, asked before anything is saved.
 *
 * `apiKey` is a credential in flight under the same terms as `provider/verify` — used for the
 * probes and dropped. Nothing about a detection is cached or written anywhere.
 */
export interface AcpDetectProviderParams { baseUrl: string; apiKey?: string }
export interface AcpDetectProviderResult {
  /** The API families the endpoint was shown to speak, most capable first. Empty means unreachable or unrecognised. */
  apiTypes: AcpConfigurableApiType[];
  /** A provider id derived from the host, offered as the form's default. */
  suggestedName?: string;
  /** True when a probe was refused for want of a credential; absent when nothing was learned. */
  authRequired?: boolean;
  /**
   * The base URL to save, in Lyra's canonical form — measured when a probe answered, and the
   * canonical rewrite of what was given when none did. Absent only when the URL did not parse.
   */
  normalizedBaseUrl?: string;
}

/** `provider/get`: one configured provider, as the edit form needs it. Never a credential. */
export interface AcpGetProviderParams { provider: string }
export interface AcpGetProviderResult {
  provider: string;
  baseUrl: string;
  apiType: AcpConfigurableApiType;
  websocket?: "auto" | "on" | "off";
  authType: AcpProviderAuthType;
  /** The credential's *address* — a variable name, a keychain service/account, a plugin id. */
  authDetail?: string;
  models: string[];
  /** True when this is the provider the live session is running on. */
  inUse: boolean;
}

/** `provider/remove`: delete a provider's declaration, and optionally its stored credential. */
export interface AcpRemoveProviderParams { provider: string; removeCredential?: boolean }
export interface AcpRemoveProviderResult {
  ok: true;
  provider: string;
  path: string;
  /** Present only when `removeCredential` was asked for: true if an entry was actually deleted. */
  credentialRemoved?: boolean;
  /** Roles still pointing at the removed provider. Left in place on purpose; named so a client can say so. */
  danglingRoles?: string[];
}
/** How long one detection probe is given. Three run concurrently, so this is the whole call's cost. */
export const ACP_DETECT_PROBE_TIMEOUT_MS = 3_000;

/** `model/add`: declare a model id for a provider whose endpoint cannot list its own. */
export interface AcpAddModelParams { provider: string; model: string }
export interface AcpAddModelResult { ok: true; provider: string; model: string }

/** One provider's model catalogue in the cross-provider `session/models` answer. */
export interface AcpProviderModels {
  provider: string;
  models: ReadonlyArray<{ id: string; ownedBy?: string; contextWindow?: number; inputPricePerMillion?: number; outputPricePerMillion?: number }>;
}
/**
 * `session/models`: every configured provider's models, not just the active one's.
 *
 * `/model` is the single switching surface in the redesigned UX, and it switches across
 * providers — so the listing it renders from has to span them too. `current` is a full
 * `provider/model` reference, and it is absent exactly when nothing is configured.
 */
export interface AcpModelsResult {
  current?: string;
  providers: readonly AcpProviderModels[];
  roles?: Readonly<Record<string, string>>;
  refreshed?: boolean;
}
export interface AcpVerifyProviderParams {
  provider?: string; baseUrl: string; apiType: AcpConfigurableApiType;
  /** SECRET. */
  apiKey?: string;
  authEnvVar?: string; timeoutMs?: number;
}
export interface AcpVerifyProviderResult {
  ok: boolean; models?: number; sample?: string[];
  error?: { classification: string; message: string; code?: string; status?: number };
}
/** Bounds on `provider/verify`: long enough for a cold TLS handshake, short enough that a wizard never feels hung. */
export const ACP_VERIFY_TIMEOUT_DEFAULT_MS = 8_000;
export const ACP_VERIFY_TIMEOUT_MIN_MS = 250;
export const ACP_VERIFY_TIMEOUT_MAX_MS = 30_000;

/**
 * The prompt-class methods: the ones whose handler *runs a turn* instead of answering a
 * question about one.
 *
 * §3.4 gives a total turn 30 minutes; every other ACP call is a question that must come
 * back inside the generic deadline. Collapsing the two is what killed a live
 * `session/prompt` at 60s while the model was legitimately spawning a subagent — so the
 * daemon reads the class off this list and gives these `turnTimeoutMs` instead.
 *
 * `session/cancel` is deliberately **not** here: it is issued *while* a turn is running
 * and has to answer promptly, which is the whole point of it.
 */
export const ACP_TURN_METHODS = [
  "session/prompt",
  // Steering awaits the next tool boundary of a turn that may be minutes from one.
  "session/steer",
  // `/compact`, `/test`, and every other slash command whose router runs a turn.
  "session/command",
  // A blocking spawn waits out a child turn. The spawn manager keeps its own §3.4
  // deadline; this is only the bound on the ACP request that is waiting for it.
  "agent/spawn",
] as const satisfies readonly AcpMethod[];
export type AcpTurnMethod = typeof ACP_TURN_METHODS[number];
/** §3.4's total-turn deadline: the default for [`ACP_TURN_METHODS`]. */
export const ACP_DEFAULT_TURN_TIMEOUT_MS = 1_800_000;

/**
 * The rewind surface, as a client sees it.
 *
 * Checkpoints are taken by the daemon before every state-changing tool call and at both
 * turn boundaries; `entryId` anchors one to the transcript entry it precedes, which is what
 * lets a client offer "rewind to before this message" and move code and conversation
 * together. `id` is stable across the thinning that `/cleanup` performs, so a client may
 * hold one between calls.
 */
export interface AcpCheckpoint {
  id: string;
  kind: "turn_start" | "pre_tool" | "turn_end" | "pre_restore" | "manual";
  label: string;
  createdAt: string;
  /** How many paths differ from the checkpoint before this one. */
  changedFiles: number;
  entryId?: string;
  tool?: string;
  callId?: string;
  /** Paths outside the snapshot entirely, e.g. node_modules. */
  excluded: string[];
}
export interface AcpCheckpointListResult {
  checkpoints: AcpCheckpoint[];
  available: boolean;
  /** Why checkpointing is off, when it is. A client renders this instead of an empty list. */
  unavailable?: string;
}
export interface AcpCheckpointFileChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "type_changed";
  oldPath?: string;
  additions?: number;
  deletions?: number;
  binary?: true;
  /** Unified diff for this one path, present only when `patches` was requested. */
  patch?: string;
  patchTruncated?: true;
}
export interface AcpCheckpointDiffResult {
  from: { kind: "checkpoint" | "worktree" | "empty"; id?: string; label?: string; createdAt?: string };
  to: { kind: "checkpoint" | "worktree" | "empty"; id?: string; label?: string; createdAt?: string };
  files: AcpCheckpointFileChange[];
  truncated: boolean;
  available: boolean;
  unavailable?: string;
}
export interface AcpCheckpointRestoreResult {
  target: AcpCheckpoint;
  /** The checkpoint of the replaced state. Restoring it undoes the restore. */
  safety: AcpCheckpoint;
  restored: string[];
  /** Changed outside Lyra's own tool calls, and therefore left exactly as they were. */
  preserved: string[];
  forced: boolean;
  excluded: string[];
}

/** Daemon-to-client requests. Bidirectional ACP: these are the only points a turn blocks on a human. */
export const ACP_CLIENT_METHODS = ["session/request_permission"] as const;
export type AcpClientMethod = typeof ACP_CLIENT_METHODS[number];
export type AcpMethod = typeof ACP_METHODS[number];
export type JsonRpcId = string | number;
export interface AcpHandlerContext { id: JsonRpcId; signal: AbortSignal; notify(method: string, params?: unknown): Promise<void>; requestClient(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>; }
export type AcpHandler = (params: unknown, context: AcpHandlerContext) => Promise<unknown> | unknown;
export type AcpHandlers = Partial<Record<AcpMethod, AcpHandler>>;
export interface AcpDaemonOptions {
  handlers: AcpHandlers;
  /** Deadline for a question-class request. Defaults to 60s. */
  requestTimeoutMs?: number;
  /** Deadline for an [`ACP_TURN_METHODS`] request. Defaults to [`ACP_DEFAULT_TURN_TIMEOUT_MS`]. */
  turnTimeoutMs?: number;
  maxFrameBytes?: number; maxConcurrentRequests?: number; serverName?: string; serverVersion?: string;
}
export interface AcpWriter { write(data: string | Uint8Array): void | Promise<void>; }
export interface AcpCapabilities { methods: readonly AcpMethod[]; bidirectional: boolean; cancellation: boolean; transport: "stdio"; }
