# Lyra

> A ruthlessly pragmatic coding agent for 2026 models.

**Canonical spec.** Self-contained: this document is the complete source of truth. No prior
conversation, design doc, or external context is required to implement Lyra from it.
`lyra-research-and-plan.md` is a superseded earlier draft — do not treat it as
authoritative; where it conflicts with this document, it is wrong.

---

## 0. How to use this document

### Read these first, in order

§1 Thesis, §2 Positioning, §3 Correctness. They are not preamble — they are the constraints
that decide every question the later sections do not explicitly answer. A change that
violates §2 or §3 is wrong even if it is locally reasonable.

### Precedence when sections conflict

1. **§3 Correctness** — beats everything. When correctness conflicts with a feature, the
   feature loses.
2. **§2 Positioning** — beats capability. When a capability requires an extension surface,
   the capability loses.
3. **§13 Context discipline** — beats convenience. Nothing enters context unasked.
4. Everything else.

### Defaulting decisions

This document does not anticipate every question. When one arises, resolve it with these,
in order:

| Question shape | Default |
|---|---|
| Should this ship, or be an extension point? | **Ship it finished, or not at all.** There is no hook-and-hope tier (§2). |
| Should this be configurable? | **No.** Pick the right default. Add config only when reasonable users genuinely disagree, and the default must work with zero config (§2). |
| Should the model be told how to do this? | **No.** Give it the capability and the environment facts. If it misuses a tool, the tool is wrong (§3.7). |
| Should this be a new tool? | **Almost never.** Thirteen tools (§15). New surface must justify itself against unbounded reach (§2's three hatches). |
| Should this be a new primitive alongside an existing one? | **No.** Look for the unification — `spawn` (§7) is the worked example. |
| How much should go in the system prompt? | **Less.** Environment facts and a capability index. Never instructions (§14). |
| Fail loudly or degrade silently? | **Loudly, with an actionable message.** Never silently (§3.7, §3.8). |
| Retry, or surface? | **Classify first** (§3.2). An unclassified error is our bug and is never retried. |
| Add a safety gate? | **No.** YOLO. Log it and make it visible instead (§1, §12). |
| Guess, or ask? | **Neither — make it visible.** Loop detectors and merge conflicts both surface rather than guessing or blocking (§3.5, §12). |
| Optimize or simplify? | **Simplify**, unless the optimization is a documented multiple (WebSocket's ~40% is why it ships default-on, §5.3). |
| Model-facing text feels like it needs a warning? | **Fix the tool.** A prompt telling the model to be careful is a design failure (§3.7). |

### The one-line test

> Would a user hit this and think *"why is this half-built"* or *"why do I have to configure
> this"*? If yes, it is not finished.

### Deliberate rejections

§26 Credits records what was **taken and rejected** from each source, with reasons. Consult
it before adding something a peer tool has — several absences are decisions, not oversights.
Notably absent by design: extension system, hooks, approval modes, prompt templates,
built-in `web_search`, todo tool, Windows support.

### External artifacts

Three existing repositories are load-bearing:

| Repo | Role | Status |
|---|---|---|
| [Flywheel](https://github.com/0xchasercat/flywheel) | TUI compositor (§4, §19) | Vendored. V2 widget system extended with Lyra components. |
| [sa3p](https://github.com/0xchasercat/sa3p) | Edit engine tiers + hash guard (§6.5) | Vendor `sa3p-engine`'s `apply_edit_with_tiers` only. Two fixes required before use — see §6.5. |
| [Draco](https://github.com/0xchasercat/draco) | Local scraping / search (§17) | Not bundled. One-keypress install via its `install.sh`, registered as MCP. |

### Platform scope

**macOS and Linux only. Windows is not supported, and there is no plan to support it.** Not
an oversight: no reflink primitive (§10), no cgroups (§11), and a different enough terminal
story to roughly double TUI cost (§19). Do not add Windows paths, Windows CI, or
Windows-conditional code.

---

## Contents

0. [How to use this document](#0-how-to-use-this-document) — **read first**
1. [Thesis](#1-thesis)
2. [Positioning: minimal-and-complete](#2-positioning-minimal-and-complete)
3. [Correctness as the primary requirement](#3-correctness-as-the-primary-requirement)
4. [Stack](#4-stack)
5. [Provider layer](#5-provider-layer)
6. [The edit tool](#6-the-edit-tool)
7. [Delegation: one primitive](#7-delegation-one-primitive)
8. [JIT runtime](#8-jit-runtime)
9. [IRC bus](#9-irc-bus)
10. [Workspaces](#10-workspaces)
11. [Process execution](#11-process-execution)
12. [Git pipeline](#12-git-pipeline)
13. [Context discipline](#13-context-discipline)
14. [System prompt](#14-system-prompt)
15. [Tools](#15-tools)
16. [Skills](#16-skills)
17. [MCP](#17-mcp)
18. [Session persistence](#18-session-persistence)
19. [TUI](#19-tui)
20. [Steering and interrupts](#20-steering-and-interrupts)
21. [ACP daemon](#21-acp-daemon)
22. [Slash commands](#22-slash-commands)
23. [Config](#23-config)
24. [Build sequence](#24-build-sequence)
25. [Open questions](#25-open-questions)
26. [Credits](#26-credits)

---

## 1. Thesis

Every existing harness was designed for models that needed hand-holding: guardrails,
verbose system prompts, a separate primitive for every slightly different task shape,
tone instructions, "think step by step." Models in 2026 do not need any of it. They
perform correctly with an empty system prompt.

The harness exists to deliver capability. Not guidance.

1. **The model does not need to be taught.** It needs to know what environment it is in
   and what it can reach. That is the entire system prompt.
2. **Context is the scarce resource.** Not model capability. Nothing is injected that the
   model did not ask for.
3. **Velocity over safety.** YOLO by default, for people who chose that tradeoff
   deliberately. Conservative users have Claude Code.
4. **Correctness is not negotiable.** See §3. This is the requirement that constrains
   every other one.

### The load-bearing evidence

The Bun Rust rewrite (July 2026) is the highest-scale proof of what a harness must
support: 64 agents, 11 days continuous, 6,778 commits, 5.9B input tokens, 1.4M assertions
green on three platforms. Two lessons are structural:

**Orchestration must live outside the main context window.** If the top-level model
decides turn-by-turn what to spawn, its context accumulates every spawn result and every
loop iteration. It compacts, loses the plan, and dies. Claude Code's docs state it
directly: *"A workflow script holds the loop, the branching, and the intermediate results
itself, so Claude's context holds only the final answer."* See §8.

**The bottleneck is the host, not the model.** Their failures: agents running `git stash`
and `git reset` on each other; disk exhaustion from worktrees; the machine freezing
because *"one slow `grep` command was all it took to freeze disk reads & writes for
minutes"*; tests exhausting TCP sockets and spawning 10k processes until `systemd-run`
cgroups were required. See §10 and §11.

A third lesson is about process and ships as a skill (§16): adversarial review with split
context windows, 1 implementer to 2 reviewers, and the reviewer rule *"if you need a
paragraph-long comment to justify why the workaround is OK, the code is wrong — fix the
code."*

### What the Bun post does not say

It does not say "build your tools in Rust." Bun's bug class — use-after-free, double-free,
leaks in error paths — came from mixing JavaScriptCore's GC'd values with manually-managed
memory in a language without destructors. That is a language-runtime problem. A coding
agent harness is I/O-bound orchestration with no manual memory lifetimes to get wrong.

The actual data point in that post: Claude Code runs **on** Bun and gained 10% startup
when Bun's internals went Rust. The application stayed TypeScript. See §4.

---

## 2. Positioning: minimal-and-complete

Two different kinds of small tool exist. Lyra is the second.

|  | Minimal-and-hackable | **Minimal-and-complete** |
|---|---|---|
| Ships | Almost nothing | A small set of finished capabilities |
| Expects | You to assemble your workflow | Nothing |
| Extension surface | Everything | Three narrow hatches |
| Example | Pi | **Lyra** |

Pi's stance is *"if I don't need it, it won't be built"* — no subagents, no plan mode, no
MCP, no background bash; use tmux and write extensions. That is a toolkit, and a
legitimate design. It is not this.

> **The rule:** if a capability is essential to velocity, it ships working and configured
> on first launch. If it is not essential, it does not exist. There is no middle tier of
> "here's a hook, go finish it."

The feature count is low because 2026 models need few primitives — not because the user is
expected to complete the product.

### Zero-config is a hard requirement

`lyra` in a git repo with one API key in the environment, no config file:

- CoW workspace created, named, ready
- `spawn` live, IRC bus live, exec semaphore sized to the host
- Git pipeline armed in `observe` mode; preview / apply / rollback available
- ACP daemon on stdio
- Bundled skills discovered and indexed
- **LSP running for every detected language.** `Cargo.toml` present means rust-analyzer is
  already up. OMP makes you configure this. That is a battery we ship.
- Draco offered on the first web search, one keypress to install

The config file exists to **override**, never to **enable**.

### Deleted on principle

- **Extension system.** No TS extension loading, no `extensions:` config, no marketplace,
  no plugin-authored tools.
- **Hooks.** No pre/post-tool interceptors, no event subscribers.
- **Theme plugins.** Themes are a color table. Ship three.
- **Prompt templates.** The model does not need templates.
- **Approval modes.** One mode.
- **Agent definition registry as a headline feature.** `spawn` takes an inline task, model,
  and schema; the model defines its agents at runtime (§7). Markdown agent files may exist
  as a convenience but are not the primary path.
- **`/settings` as a config-schema GUI.** A viewer plus the toggles that matter at runtime.

### The three escape hatches

Each absorbs **unbounded** surface area that would otherwise become built-in tool count.
Anything with bounded surface area ships as a battery instead.

| Hatch | Why it must exist | Why it stays narrow |
|---|---|---|
| **Auth plugins** | Subscription/OAuth flows are per-provider, undocumented, and change without notice. We cannot own twenty. | One function: return a bearer token. |
| **MCP client** | The ecosystem exists and we do not get to delete it. | Client only, never a host. No server-authoring surface. |
| **JIT tooling** | The model writes a working integration in a minute. Fifty built-in integrations is bloat plus a capability ceiling. | It is the *model's* hatch, not the user's. |

### Config is data, never code

TOML in, no execution. The only executable extension point is an auth plugin with a
one-function contract.

This is what keeps "batteries included" from decaying into "framework." Every harness that
added an extension API ended up maintaining it as a product, then implementing its own
features *as extensions* — which is how you get 124 documentation files. Lyra's feature
list should fit in your head, and every item on it should be finished.

---

## 3. Correctness as the primary requirement

**This section constrains every other section. When correctness conflicts with a feature,
the feature loses.**

The reason to build this is not that OMP lacks features. It is that OMP has too much
surface area to keep correct, and the result is: API errors of every kind, the model
silently stopping mid-turn, sessions hanging, sessions looping, and occasionally a session
whose context is so corrupted it has to be discarded. When you are trying to get work
done, that is the worst possible failure — not because any single bug is fatal, but
because you cannot trust the environment, and an untrustworthy environment costs more than
a missing feature ever does.

A small surface has no excuse for any of it.

> Every session runs smoothly, every tool works exactly as specified, and the model is
> able to use every tool proficiently on the first attempt. As far as anything is within
> our control, none of the failures above ever happen.

### 3.1 The failure taxonomy

Each of these is a real observed failure. Each gets a named mechanism, not a hope.

| # | Failure | Mechanism |
|---|---|---|
| F1 | API error mid-session | §3.2 error classification and recovery |
| F2 | Model stops replying / empty turn | §3.3 turn liveness watchdog |
| F3 | Session hangs | §3.4 universal deadlines |
| F4 | Session loops | §3.5 loop detection |
| F5 | Context corrupted, session unusable | §3.6 context integrity invariants |
| F6 | Tool fails in a way the model can't recover from | §3.7 tool contract |
| F7 | Silent truncation / dropped content | §3.8 no silent loss |
| F8 | Edit applied to the wrong place | §6 |

### 3.2 Every API error is classified

The single largest source of broken sessions is treating provider errors as opaque. They
are not. Every error maps to exactly one class, and each class has exactly one response.

| Class | Examples | Response |
|---|---|---|
| `transient` | 429, 502, 503, 529, connection reset, stream truncation | Retry, exponential backoff + jitter, honor `Retry-After`. Up to 8 attempts. |
| `context_overflow` | context_length_exceeded, prompt too long | Compact (§13), retry once. Never surface raw. |
| `content_shape` | Invalid role sequence, orphaned tool_use, bad image, unsupported block | **Repair and retry** (§3.6). This is the class that corrupts sessions elsewhere. |
| `auth` | 401, 403, expired token | Refresh via auth plugin, retry once, then prompt. |
| `quota` | Insufficient credits, hard rate ceiling | Surface immediately with the provider's message. Not retryable, do not burn attempts. |
| `model_unavailable` | Model deprecated / overloaded / not found | Offer fallback from the role table; do not switch silently. |
| `bad_request` | Genuinely malformed by us | **Bug.** Log full request, surface with a report link. Never retry — a retry hides a defect. |
| `refusal` | Provider-side content refusal | Surface verbatim. Never retry, never rephrase. |

Rules:

- **No unclassified errors.** An unrecognized error is classified `bad_request` and treated
  as our bug. Silently retrying an unknown error is how a session dies confusingly.
- **The error message the user sees is the provider's, plus what we did about it.** Never a
  generic "Something went wrong."
- **Retries are visible.** A retrying request shows in the composer footer with attempt
  count and reason. A silent 40-second retry is indistinguishable from a hang (F2/F3).
- **Retries never duplicate side effects.** Retry happens at the request layer, before any
  tool executes. A turn that already ran tools is never replayed wholesale.

### 3.3 Turn liveness watchdog

F2 — "the model just stops" — is almost always one of: a stream that ended without a stop
reason, a stream that stalled without closing, or an assistant turn with no content and no
tool call. All three are detectable.

- **Stall detection.** No token for `stream_stall_timeout` (default 45s) with the socket
  still open → cancel, classify `transient`, retry from the last clean boundary.
- **Malformed completion.** Stream ends with no stop reason, or with an unterminated tool
  call → `content_shape`, repair, retry once.
- **Empty turn.** Assistant turn with no text, no thinking, and no tool call is **not** a
  valid end state. Retry once; if it recurs, surface it plainly rather than sitting idle.
- **A turn is never silently over.** Every turn ends in exactly one of: content, a tool
  call, a classified error, or a user cancel. There is no fifth state, and no state where
  the UI is waiting on nothing.

### 3.4 Universal deadlines

F3 — hangs. Nothing in Lyra blocks forever. Every await has a deadline, and every deadline
has a defined expiry behavior.

| Operation | Deadline | On expiry |
|---|---|---|
| HTTP request headers | 30s | `transient`, retry |
| Stream token gap | 45s | §3.3 |
| Total turn | 30m | Cancel, keep partial, surface |
| ACP request | 60s — except `session/prompt`, `session/steer`, `session/command` and `agent/spawn`, which carry a turn and get `reliability.turn_timeout` | Abort the handler, answer `-32001` |
| Tool call (default) | 120s | Kill, return timeout to model |
| `bash` heavy | Unbounded (job) | Never blocks — §11 |
| Semaphore acquire | 300s | Return queued handle, do not block |
| `spawn` blocking | 60m | Cancel child, return partial |
| IRC `wait` | Caller's, capped 10m | Return empty, never hang |
| LSP request | 20s | Degrade to text tools, warn once |
| MCP call | 60s | Return error to model |
| WebSocket idle | 55m | Proactive reconnect before the 60m cap (§5.3) |

A deadline that fires is **never** a silent no-op. It produces a result the model can act
on.

### 3.5 Loop detection

F4 — the session spins. Three independent detectors, because loops have three shapes:

1. **Identical tool call.** Same tool, byte-identical args, 3× consecutively → the third
   result carries a note that the call is repeating with no state change.
2. **No-progress cycle.** Over 10 turns: no file modified, no new file read, no command
   with a novel exit code → surface a progress warning to the model *and* the TUI.
3. **Oscillation.** File content returns to a previous hash after ≥2 edits (A→B→A) →
   flagged in the edit result.

None of these abort the turn. Aborting is patronizing and sometimes wrong. All three make
the loop **visible** — to the model, so it can break out, and to the user, so they can
steer (§20). The failure mode we are eliminating is the *invisible* loop that burns an
hour and $40.

`/loop` (§22) additionally hard-stops on detector 2, since an unattended loop has no user
watching.

### 3.6 Context integrity invariants

F5 — the session whose context is broken and must be discarded — is the worst failure
because all prior work is lost. It is entirely preventable: it always comes from a
malformed message sequence, and the sequence is checkable.

**Validated before every request, and repaired, not rejected:**

| Invariant | Repair |
|---|---|
| Every `tool_use` has a matching `tool_result` | Synthesize `tool_result` with `"interrupted"` |
| Every `tool_result` has a preceding `tool_use` | Drop the orphan |
| Roles alternate as the provider requires | Merge adjacent same-role turns |
| No empty content blocks | Drop |
| Thinking blocks precede content in the same turn | Reorder |
| Thinking signatures intact where the provider requires them | Drop the turn's thinking rather than send an invalid signature |
| Image blocks well-formed and under the size cap | Downscale or drop with a marker |
| Total tokens under the model's window | Compact (§13) |

**Repair is always logged and always visible in `/context`.** A silent repair is a lie
about what the model saw.

**The transcript is never the wire format.** The JSONL transcript (§18) is append-only
truth; the request payload is *derived* from it on every turn. This is the structural
reason a corrupted request can never corrupt a session: the derivation is a pure function,
and a bad derivation is a bug to fix, not a state to recover from. Fix the function,
re-derive, continue. Nothing is discarded.

**Cross-provider switching re-derives from scratch** rather than transforming the previous
payload, so provider-specific artifacts cannot leak across a switch.

### 3.7 Tool contract

F6 — a tool fails in a way the model cannot recover from. Every Lyra tool obeys all five:

1. **Failures are actionable.** An error states what was wrong and what to do instead. Not
   a stack trace, not `ENOENT`. `File not found: src/authh.ts. Did you mean src/auth.ts?`
2. **Errors are results, never exceptions.** A tool failure is a normal tool result the
   model can read and respond to. A thrown exception is a harness bug.
3. **Partial success is reported as partial.** A 3-file edit where file 2 fails reports
   exactly which landed and which did not. Never "success" and never "failure" for a
   mixed outcome.
4. **Deterministic given the same inputs.** No hidden state, no time-dependent behavior,
   no ordering surprises.
5. **The schema is the contract.** If the schema permits it, it works. No undocumented
   required combinations, no "this field is ignored unless."

**Proficiency is a harness responsibility, not a model one.** If a model misuses a tool,
the tool's schema or description is wrong. The fix is in the tool, never in a prompt
telling the model to be careful. Every tool ships with:

- A description that states its purpose in one sentence and its constraints in the schema
- Argument names that mean what they say
- Errors that teach the correct call

Measured directly: **first-call success rate per tool** (§3.9). Any tool below 98% is a
defect with a fix in the tool, not the prompt.

### 3.8 No silent loss

F7. Anywhere content is dropped, truncated, or summarized, it is **marked in-band** and
recoverable:

- Truncated tool output → `[truncated: 45,231 of 120,000 bytes — artifact://a1b2 for full]`
- Compaction → visible boundary with token delta; pre-boundary history retained in the
  transcript (§13)
- Repaired context → listed in `/context`
- Dropped image → marker block
- Cancelled turn → partial output kept in the transcript, marked cancelled

The user can always answer "what did the model actually see?" via `/context`, and "what
actually happened?" via the transcript. Both must be true even after a crash.

### 3.9 How this is enforced

Principles without enforcement are decoration.

**Provider conformance suite.** Every API type (§5) runs the same scenario matrix against
recorded fixtures *and* live smoke tests: multi-turn tool use, parallel tool calls,
thinking blocks, streaming interruption mid-tool-call, every error class in §3.2,
context-overflow recovery, cross-provider switching. A provider ships when the whole matrix
is green. **This is the highest-value test surface in the product** — it is where the
observed failures actually live.

**Chaos harness.** A fault-injecting provider mock that randomly: drops connections
mid-stream, returns each error class, stalls the stream, truncates JSON in a tool call,
returns malformed tool arguments, returns an empty turn. The suite asserts the session
always reaches a defined state and is always resumable. CI runs it on every commit.

**Tool fuzzing.** Each tool gets adversarial and malformed args. Assert: never throws,
always returns an actionable result, never corrupts state.

**Long-run soak.** A weekly 24-hour `/loop` against a real repo. Assert: no hang, no
unbounded memory, no orphaned processes, no workspace leak, coherent goal after multiple
compactions.

**Telemetry, local and off by default.** First-call tool success rate, error class
frequency, retry counts, turn latency percentiles, compaction frequency. Written to
`.lyra/metrics.jsonl` for `/health`. This is how a regression is caught before it becomes
a report.

**No known-issues list.** A bug is fixed or the feature is removed. There is no third
option, because a documented papercut in a terminal tool is a papercut you hit every day.

---

## 4. Stack

**TypeScript on Bun for the core. Two Rust native addons for the two things that need
them.**

```
packages/
  lyra-tui/          # Rust (napi-rs) — Flywheel compositor bindings
  lyra-host/         # Rust (napi-rs) — CoW workspaces, exec semaphore, fs probes
  lyra-core/         # TS — agent loop, tool dispatch, spawn, IRC, compaction
  lyra-provider/     # TS — 4 transports, error classification, conformance suite
  lyra-edit/         # TS — the edit engine (§6)
  lyra-git/          # TS — preview assembly, transactional apply/rollback
  lyra-jit/          # TS — JIT runtime + `lyra:runtime` API
  lyra-mcp/          # TS — MCP client, lazy schema hydration
  lyra-acp/          # TS — ACP server
  lyra-session/      # TS — JSONL transcript, SQLite prompt index
  lyra-app/          # TS — TUI composition, slash commands, entry
```

### Why TS/Bun for the core

- Every harness that shipped is TS/Bun: Claude Code, OMP, Pi. Not laziness — it is where
  maintenance cost actually lands.
- **Provider API churn is the dominant ongoing cost**, and §3 makes it the dominant
  *correctness* cost too. Responses API, WebSocket mode, thinking blocks, cache control,
  service tiers, per-vendor streaming quirks. Cheap to chase in TS, expensive in Rust — and
  chasing it fast is what keeps §3.2 honest.
- JIT tooling (§8) needs a JS/TS runtime anyway. A Rust core means embedding one and
  maintaining a bridge for the most important subsystem in the product.
- MCP's ecosystem is TS-first.

### Why Rust for exactly these two

Both are **narrow, stable, syscall-bound** — where compile-time guarantees pay and the API
will not churn.

- **`lyra-tui`** — Flywheel solves this already. 3-actor pipeline (Input → Main →
  Renderer), double-buffered diffing, fast-path append emitting ~20 bytes of ANSI instead
  of re-diffing the grid, `#![forbid(unsafe_code)]` core.
- **`lyra-host`** — `clonefile()`, `ioctl(FICLONE)`, `statfs` probes, the semaphore.

Flywheel is **vendored**, not depended upon.

---

## 5. Provider layer

Given §3, this is the most correctness-critical subsystem in Lyra. Four transports, one
internal representation, one error classifier.

### 5.1 Transports

| Transport | Endpoint | Notes |
|---|---|---|
| `openai_completions` | `POST /chat/completions` | SSE. The lingua franca — local models, Gemini's compat endpoint, most vendors. |
| `openai_responses` | `POST /responses` | SSE. Stateful chaining via `previous_response_id`, server-side compaction, reasoning items. |
| `openai_websocket` | `wss://…/v1/responses` | §5.3. Persistent socket, incremental turns. |
| `anthropic_messages` | `POST /messages` | SSE. Thinking blocks, cache control, tool use. |

Three *shapes*, four transports — WebSocket is Responses over a socket, sharing its event
model and payload schema, not a fifth semantic.

Google's native Generative AI API is skipped; Gemini exposes an OpenAI-compatible
endpoint and a fourth transformer is not worth its maintenance cost under §3.

### 5.2 Responses API

Full support, not a Completions shim.

- **`previous_response_id` chaining**, with the full input window retained locally so any
  chain break is recoverable by replay (§5.3).
- **Reasoning items** preserved verbatim, including encrypted content. Never reconstructed,
  never reordered, never partially dropped — a mangled reasoning item is a `content_shape`
  error waiting to happen.
- **Server-side compaction** via `context_management` with `compact_threshold` where
  available; otherwise the standalone `/responses/compact` endpoint. Its returned window is
  passed **as-is** — the docs are explicit that it must not be pruned, and pruning it is
  exactly the kind of clever mistake that corrupts a session.
- **`store=false` by default.** ZDR-compatible, no server-side retention we did not ask
  for.

### 5.3 WebSocket mode

The Responses API supports a persistent WebSocket at `wss://api.openai.com/v1/responses`.
Each turn sends `response.create` with `previous_response_id` plus **only new input items**;
the service keeps the previous-response state in a connection-local in-memory cache.
OpenAI reports **up to ~40% faster end-to-end execution for rollouts with 20+ tool calls**.

An agentic coding session is precisely that workload. Lyra's turns are dominated by tool
round-trips, so this is the single largest latency win available on OpenAI models, and it
is ZDR-compatible.

**Default on for `openai_responses` providers when the endpoint supports it.** Not opt-in
— a 40% latency reduction on the dominant workload is a battery (§2).

The failure modes are documented, finite, and each has a defined recovery:

| Condition | Behavior |
|---|---|
| Connection open | Continue with `previous_response_id` + incremental input |
| `previous_response_not_found` | Cache miss. Rebuild the full input window locally and start a new chain with `previous_response_id: null`. **We always retain the full window**, so this is never fatal — it costs latency, not correctness. |
| Turn fails 4xx/5xx | The service evicts the cached previous-response. Treat the chain as broken and rebuild, in addition to §3.2 handling. |
| `websocket_connection_limit_reached` | 60-minute cap. **Reconnect proactively at 55m** (§3.4) so this is never hit mid-turn. |
| Socket closes unexpectedly | Reconnect, rebuild the chain, replay the pending turn. Idempotent because retry precedes tool execution (§3.2). |
| Sequential execution | One in-flight response per connection, no multiplexing. Concurrent spawns get their own connections. |

**Warmup.** `response.create` with `generate: false` prepares request state without
producing output and returns a chainable response ID. Lyra issues warmup at session start
and after model or tool-set changes, so the first real turn starts faster.

**Fallback is automatic and silent-to-the-model.** If the socket cannot be established or
repeatedly fails, the provider falls back to HTTP Responses for the session and notes it
once in the TUI. WebSocket is a latency optimization; it is never a correctness
dependency.

### 5.4 Anthropic Messages

- Thinking blocks with signatures preserved byte-exact. Where a signature cannot be
  preserved validly, the turn's thinking is dropped rather than sent invalid (§3.6).
- `cache_control` breakpoints placed per §13, never mid-session-mutated.
- Parallel tool use, and interleaved thinking where the model supports it.

### 5.5 Configuration

```toml
[providers.anthropic]
base_url = "https://api.anthropic.com/v1"
api_type = "anthropic_messages"
auth     = { type = "env", var = "ANTHROPIC_API_KEY" }

[providers.openai]
base_url  = "https://api.openai.com/v1"
api_type  = "openai_responses"
websocket = "auto"                        # auto | on | off
auth      = { type = "env", var = "OPENAI_API_KEY" }

[providers.local]
base_url = "http://localhost:8080/v1"
api_type = "openai_completions"
auth     = { type = "none" }

[providers.claude-max]
base_url = "https://api.anthropic.com/v1"
api_type = "anthropic_messages"
auth     = { type = "plugin", plugin = "claude-oauth" }
```

**`base_url` is the exact prefix routes hang off** — one rule for every `api_type`, so a
provider that was detected at one path shape cannot be requested at another:

| api_type             | request                   |
| -------------------- | ------------------------- |
| `openai_completions` | `{base_url}/chat/completions` |
| `openai_responses`   | `{base_url}/responses`    |
| `openai_websocket`   | `{base_url}/responses` over `ws(s)` |
| `anthropic_messages` | `{base_url}/messages`     |
| *(all)*              | `{base_url}/models`       |

Canonically that prefix carries the API version segment — `https://api.openai.com/v1`,
`https://api.anthropic.com/v1`, a gateway's own `https://host/api/v1` unchanged — and
`provider/add` stores what it was given in exactly that form (trailing slash and a pasted
full route trimmed, a bare origin given `/v1`). `provider/detect` probes both shapes and
reports the one that answered as `normalizedBaseUrl`, so the form is filled from a
measurement rather than a convention.

Hand-written configs predate the rule, so it is forgiving: a request that comes back `404`
before anything has streamed is retried once against the base with its `/v1` added or
removed. If that works, the shape is remembered for the session and a one-line notice names
the `base_url` to write down — a healed provider is never a silent divergence from its own
configuration. A `404` that survives both attempts is reported with the full URL it went to,
because a 404 is a statement about a path and the path is the one thing its body never has.

**Model discovery.** `GET {base_url}/models` on first use, cached to
`~/.lyra/providers/<name>/models.json`, refreshed every 24h in the background, `/model
refresh` to force. If it 404s, models are declared manually. Auto-fetched entries are
augmented with locally-known context windows and pricing, since `/models` rarely reports
either.

**Auth plugins** — the one executable hatch, one required function:

```typescript
interface AuthPlugin {
  id: string                                                   // must equal the directory name
  headers?: Record<string, string>                             // extra headers the endpoint mandates
  systemPrefix?: string                                        // one static line, prepended as the FIRST system block
  login?(): Promise<void>                                      // interactive; only `lyra plugins login <id>` runs it
  getToken(): Promise<{ token: string, expiresAt?: string }>   // non-interactive; throws actionably with no creds
}
```

At `~/.lyra/plugins/<id>/plugin.ts` (or `index.ts`), default-exported. Lyra caches the token
until shortly before `expiresAt`, and on a 401 drops the cache, re-asks, and retries once — the
existing auth recovery in `ReliableProvider`, connected to the one credential source that can
actually recover. The community owns Claude Max, ChatGPT, Copilot, and whatever comes next —
every subscription resolves to an OpenAI- or Anthropic-compatible endpoint, and only token
acquisition differs.

Three fields beyond `getToken`, because a subscription endpoint checks three things, not one:

- **`headers`** — merged over the provider's own on every request. A plugin returns a *bearer*
  token by contract, so plugin auth on `anthropic_messages` sends `Authorization: Bearer`, where
  an API key would have gone in `x-api-key`.
- **`systemPrefix`** — the reason this is not a one-function interface. Some endpoints check
  that the first system block is the vendor client's identity line. The workaround in the wild
  is a proxy injecting that client's *entire* system prompt, which buys access by replacing
  Lyra's instructions with someone else's — instruction-following contaminated at the root. A
  declared prefix pays the one line that is actually checked, as its own system block ahead of
  Lyra's, leaving §14 in authority. It is provider-mandated overhead, so it is added in the
  provider layer beside the request headers, is excluded from the 4,000-character system prompt
  budget, and is static for the session, leaving the §13 cache breakpoint where it was.
- **`login`** — never called during a turn. `getToken` runs inside streaming responses and
  inside spawned children; an interactive flow there is a hung turn. It throws instead, and Lyra
  appends `run \`lyra plugins login <id>\``.

Managed with `lyra plugins install|list|update|remove|login`. Install is a shallow clone (or a
copy, for a local directory) into `~/.lyra/plugins/<id>`, preceded by a line naming the source
and stating that the code will run with the user's environment — YOLO, made visible rather than
gated (§1, §12). Full contract, trust model, and a worked skeleton: `docs/plugins.md`.

**Roles:**

```toml
[roles]
default = "anthropic/claude-opus-5"
fast    = "anthropic/claude-haiku-4.5"
merge   = "anthropic/claude-opus-5"
```

`spawn({ model: '@fast' })` resolves through this.

**Switching mid-session** re-derives the whole payload from the transcript (§3.6). Lossy
conversions are flagged in the TUI. Streaming is mandatory on all four transports.

---

## 6. The edit tool

Editing is the single most-invoked capability in a coding agent, so its failure rate sets
the floor for §3.

### 6.1 Evidence

**ACL 2026 ("To Diff or Not to Diff?")** — the first systematic training-based study of
edit formats:

| Format | pass@1 |
|---|---|
| Number-indexed diffs (line numbers) | 14–37 |
| Content-addressed (search/replace) | ~54 |
| Structure-aware block rewrites | ~56, matches full-code |

The gap between search/replace and block-rewrites is statistical noise at the frontier.
**Line numbers are the problem**, not content matching. Eliminating them closes almost all
of the gap; adding AST parsing to the model's output side is not the lever.

For frontier models (Opus 5, GPT-5.6): the early workarounds for whitespace
hallucination and indentation drift are mostly obsolete. These models rarely get exact
characters wrong when copying from context. Tier-1 exact match resolves the overwhelming
majority of calls; the fuzzy tiers are a safety net for edge cases, not the common path.
The tier that fired is always reported in the result, so nothing is silent.

### 6.2 Three modes

**Mode 1: Search / replace (default)**

```
<<<<<<< SEARCH
function validateToken(token: string) {
  return jwt.verify(token, SECRET)
}
=======
function validateToken(token: string, audience?: string) {
  return jwt.verify(token, SECRET, { audience })
}
>>>>>>> REPLACE
```

Tiered matching, most exact first:

1. **Exact** — byte-for-byte. Must be unique: 0 matches → error with the closest near-match
   shown; >1 match → error naming each enclosing symbol so the model can add context.
2. **Whitespace-agnostic** — trim each line, sliding-window comparison. Fires when
   indentation in the model's block differs from the file only in normalized whitespace.
3. **Levenshtein anchor** — threshold `len/3` after whitespace normalization. Fires rarely
   with frontier models; exists for the genuine edge case, not as an excuse to be loose.

**Mode 2: AST symbol replace**

For whole-function / whole-class rewrites without transmitting the full body as a search
block:

```json
{
  "symbol": "UserService.processPayment",
  "replace": "async processPayment(user: User): Promise<void> {\n  ...\n}"
}
```

tree-sitter resolves the symbol name to exact byte range. No string matching at all.
Deterministic even when the function body is large.

**Mode 3: Line-range replace**

When the model has already read the file with numbered lines and wants unambiguous,
zero-matching replacement:

```json
{ "start_line": 45, "end_line": 62, "replace": "    // new content" }
```

Paired with `read` emitting `[N] line content` output. Fast, no matching overhead.

### 6.3 The `#TAG` guard

Every `read` and every successful `edit` returns a `#TAG` — a short hash over normalized
file content. An `edit` must supply the `#TAG` from the most recent read of that file. If
the file changed in between (another agent, another tool, the user's editor), the edit is
refused with a "re-read" instruction. This is F8 in §3 and what makes concurrent agents
correct by construction.

### 6.4 Whole-file write

`write` is a first-class edit path, not a fallback. New files, files under ~80 lines, and
pervasive change (>50% of lines) are all better served by `write` than by a search/replace
chain. The tool description states this and the model chooses.

### 6.5 Implementation: sa3p

`sa3p-engine` (Rust, MIT) implements exactly the mode-1 tiers: `apply_exact` →
`apply_whitespace_agnostic` (sliding window, `.trim()` comparison) →
`apply_contextual_anchor` (Levenshtein, threshold `len/3`). The `#TAG` guard
(`known_hashes` + stale-hash detection) is also there. It handles SEARCH/REPLACE markers,
`<search>/<replace>` XML blocks, and unified diff hunks through one `finalize_apply_edit`
function. Already tested.

**Vendor:** the `apply_edit_with_tiers` logic and hash-guard from `sa3p-engine`, wrapped in
the `lyra-host` Rust native addon (napi-rs). Not the XML parser or binary frame protocol —
those are sa3p's own transport layer and irrelevant here.

**Two additions before vendoring:**
1. Uniqueness check in tier 1: `apply_exact` currently uses `str::find` and silently picks
   the first of multiple matches. Add an occurrence count; >1 → return an error.
2. Modes 2 and 3 (AST symbol, line-range) are absent from sa3p and built fresh with
   tree-sitter.

### 6.6 Guarantees

- Atomic: parsed and validated in full before any byte is written.
- Partial success named exactly (§3.7).
- Post-write hash verified; returned `#TAG` is the real new state.
- No-op is an error — a patch reproducing existing bytes means the model's belief diverged.
- Formatting is not editing. Run the project's formatter afterward.

---

## 7. Delegation: one primitive

A dynamic workflow is a subagent with a typed output contract. A subagent is a workflow
with an implicit one. Shipping both is redundant surface, and Claude Code, Codex, and the
OpenAI Agents SDK all pay for the split — Handoffs, Agents-as-Tools, subagents, and
workflows are four names for spawning a context window with a job.

One tool.

```typescript
spawn({
  task: string,
  context?: string,

  output_schema?: JSONSchema,     // present ⇒ typed contract. absent ⇒ prose.
  schema_mode?: 'permissive' | 'strict',

  model?: string,                 // '@fast', concrete id, or inherit
  tools?: string[],               // default: all

  isolated?: boolean,             // own CoW workspace (§10)
  workspace?: string,             // or an existing one by name

  blocking?: boolean,             // default false — returns a job handle
  label?: string,
})
```

`output_schema` is the entire difference between the two concepts. Presence makes the
deliverable machine-checkable; absence makes it prose. The unification is only real because
the field exists — a `spawn` whose task is a bare string has renamed subagents, not unified
anything.

Non-blocking by default. Returns a handle immediately; the child's name is its workspace
name (§10), so `/agents` and IRC read in English.

**Model selection.** Inherit unless told otherwise. The model picks from the live model list
when it has reason to — cheap tier for mechanical work, top tier for design. `@`-roles keep
that out of hardcoded strings.

**Depth.** Default max 2. A child at the cap loses `spawn`. Prevents accidental
exponential fan-out.

**Concurrency.** Bounded by the exec semaphore (§11), not by an arbitrary agent count. 64
agents reading files is fine; 64 agents running `cargo check` is not, and that is a process
problem with a process solution.

---

## 8. JIT runtime

Two problems, one mechanism.

**Problem one: capability ceiling.** A 2026 model writes a working 300-line integration in
under a minute. Shipping fifty built-in integrations is bloat *and* a hard ceiling.

**Problem two — the load-bearing one: orchestration must leave the main context.** From §1:
if the top model runs the loop, its context accumulates every result and every iteration
until it compacts and forgets the plan. That is why dynamic workflows exist. But a separate
workflow primitive is redundant (§7). Both statements are true, and one line resolves them:

> **JIT tool scripts get a `lyra:runtime` API, and it includes `lyra.spawn()`.**

```typescript
import { lyra } from 'lyra:runtime'

const files = await lyra.glob('src/**/*.zig')

for (const batch of chunk(files, 16)) {
  const impls = await Promise.all(batch.map(f =>
    lyra.spawn({ task: `Port ${f} to Rust per PORTING.md and LIFETIMES.tsv.`,
                 isolated: true })
  ))

  // 1 implementer : 2 adversarial reviewers, split contexts
  const reviews = await Promise.all(impls.flatMap(i => [0, 1].map(() =>
    lyra.spawn({
      task: `Find every reason the port in ${i.workspace} is wrong. Do not implement.`,
      output_schema: { type: 'object', required: ['findings'], properties: {
        findings: { type: 'array', items: { type: 'object', properties: {
          file: { type: 'string' }, severity: { enum: ['blocker','warn'] },
          detail: { type: 'string' } } } } } },
    })
  )))

  const blockers = reviews.flatMap(r => r.findings).filter(f => f.severity === 'blocker')
  if (blockers.length) await lyra.spawn({ task: `Apply: ${JSON.stringify(blockers)}` })

  lyra.report(`batch: ${batch.length} files, ${blockers.length} blockers fixed`)
}
```

`spawn` remains the only delegation primitive. Dynamic workflows are what you get for free
once JIT tooling can reach it. The loop, the branching, and every intermediate result live
in code the model wrote, running out-of-context — and only `lyra.report()` reaches the main
window. That is the property that makes an 11-day run survivable.

### The runtime API

Deliberately the same surface as ACP (§21) — one control plane, two entry points.

```typescript
lyra.spawn(opts)                 // → { output, workspace, id }
lyra.exec(cmd, opts?)            // semaphore-gated (§11)
lyra.read/write/edit/glob/grep   // same engines as the tools
lyra.irc.send/publish/wait       // §9
lyra.git.preview/apply/rollback  // §12
lyra.workspace.create/list/drop  // §10
lyra.report(msg)                 // ← the only thing that reaches main context
lyra.checkpoint(state)           // resumable across restart
```

### Mechanics

- Declared via the `jit` tool → `.lyra/runtime/<session>/<name>.ts`
- Bun subprocess, JSON in / JSON out, stderr straight back to the model
- **Self-healing**: a runtime error is just a debugging task on a file the model wrote
  seconds ago
- `lyra.checkpoint()` persists progress, so a long orchestration resumes rather than
  restarts
- Session-scoped; `--keep` promotes one to `.lyra/tools/`
- No sandbox. YOLO (§2).

---

## 9. IRC bus

Process-global mailbox bus. Named peers, direct messages, and channels.

```typescript
hub({ op: 'send',      to: 'purple-falcon', message: '...' })
hub({ op: 'send',      to: 'purple-falcon', message: '...', await: true })
hub({ op: 'publish',   channel: 'build-results', data: {...} })
hub({ op: 'subscribe', channel: 'build-results' })
hub({ op: 'wait',      channel: 'build-results', timeoutMs: 60_000 })
hub({ op: 'inbox' })
hub({ op: 'list' })
```

- **Names are workspace names** (§10), never UUIDs. `/agents` and message logs stay legible.
- **Channels, not only point-to-point.** Fan-out/fan-in needs a bus, and OMP's peer-only
  model forces N sends.
- **Delivery to a running agent is a non-interrupting aside**, folded into its next turn.
  Replies are real turns.
- **A message revives a parked agent.** The only resume primitive; there is no separate
  resume call.
- **Every wait has a deadline** (§3.4) and returns empty rather than hanging.
- **ACP-exposed** (§21), so external harnesses join the same bus. Two agents needing a
  protocol richer than prose write one at runtime (§8) and hand over the endpoint.

---

## 10. Workspaces

### The problem, from the field

Bun's rewrite hit all four within minutes of scaling up:

1. **Shared state.** *"one Claude ran `git stash` before committing. Another ran `git stash
   pop`. And then `git reset HEAD --hard`. They were stepping on each other."*
2. **Isolation cost.** *"if I put each Claude into a separate worktree, I would run out of
   disk space."*
3. **Host starvation.** 64 concurrent builds.
4. **The orchestration trap.** Their fix was prompt-engineering: *"never run `git stash` or
   `git reset`… No `cargo` either. No slow commands at all."* Tokens spent, autonomy lost,
   and a rule the model can violate.

Filesystem isolation is the correct layer. Then no rule is needed.

### Mechanism

```
<project>/.lyra/workspaces/purple-falcon/
```

| Platform | Call | Cost |
|---|---|---|
| macOS APFS | `clonefile()` | ms, 0 bytes |
| Linux btrfs / XFS(reflink=1) | `ioctl(FICLONE)` | ms, 0 bytes |
| Anything else | `git worktree` + per-file reflink where possible | cheap |
| Last resort | plain `git worktree` | working tree only |

**Never refuses, never hard-copies.** ext4 is the majority Linux filesystem; a plain
worktree already shares `.git/objects` and copies only the working tree. Degraded, not
broken.

**Names are memorable.** `purple-falcon`, `hollow-peak`, `amber-forge` — adjective + noun
from curated lists, ~1M combinations. You will be reading this directory a lot; UUIDs make
that miserable.

**Never `/tmp`.** Persistent and crash-recoverable: if the host dies or context drops, the
work is on disk and reproducible.

### The clone is an independent repository

A `clonefile()` of the project copies `.git` too. So each CoW workspace is a *complete
independent repo*, not a worktree. This is the property that makes it work:

- Agents run `commit`, `reset --hard`, `stash`, `rebase`, `bisect` with total freedom. No
  prompt rule, no coordination, no possible collision.
- Refs diverge from origin by design. Assembly is therefore
  `git fetch <workspace-path> HEAD:agent/<name>` — cheap, and it never touches the main
  working tree.

**Worktree mode has the opposite semantics** — shared refs, so `reset --hard` and same-branch
checkout are constrained. Independent-repo is canonical; worktree mode is documented as
degraded, and the TUI says so when active.

### Lifecycle

```
created → active → paused → resumed → archived → dropped
```

`paused` matters: the agent's context is gone but the workspace is intact, so work is
recoverable and resumable. `archived` keeps completed work for review. `dropped` is explicit
or age-based via `/cleanup`.

---

## 11. Process execution

Bun's actual failure was not CPU. It was disk: *"One slow `grep` command was all it took to
freeze disk reads & writes for minutes."* And their memory/pid isolation required
`systemd-run` cgroups because *"this needed stronger isolation than 'please'"* — the machine
still ran out of disk and crashed several times.

So the semaphore is classed, and capped below core count.

| Class | Limit | Examples |
|---|---|---|
| `heavy` | `min(nproc, 8)` | cargo, tsc, webpack, docker, make, test suites |
| `io` | 4 | recursive grep, large reads, archive ops |
| `light` | `nproc × 2` | git status, lint, single-file reads |
| `free` | ∞ | cheap commands |

8 is a ceiling regardless of `nproc`, because IOPS does not scale with cores.

**Classification is by command, not by the model's declaration.** A pattern table maps
binaries to classes. The model cannot accidentally starve the host by mislabeling, and does
not have to think about it.

**Everything heavy is a job.** `bash` returns a handle immediately — never a blocked agent
behind a 3-minute build. Poll or `hub wait`. Composes with `lyra.exec()` in orchestration
scripts (§8), which is where 64-way concurrency actually happens.

**cgroups on Linux, opt-in.** `exec.cgroup = true` wraps heavy jobs in `systemd-run` with
memory and CPU limits and a private pid namespace. A counting semaphore does not stop one
agent from OOMing the box; this does.

**Nothing is orphaned.** Session end kills its process tree. Verified by the soak test
(§3.9).

---

## 12. Git pipeline

Three modes. One command.

```
/gitmode observe   (default)  never touches the main repo
/gitmode stage                accumulate, assemble on request, apply on request
/gitmode auto                 fully hands-free including merge
```

`auto` requires explicit confirmation the first time and shows persistently in the header.
It is the one place where the tool imposes on the repository, so it is never a default.

### Assemble

`/review`, or the model calling `git.preview()` — the one action that asks permission, asked
plainly rather than defensively:

> Three workspaces have work. Assemble a preview at `.lyra/previews/2026-08-05-1246/` and
> open in Fork?

A fresh CoW clone, then one `git fetch` per workspace:

```
.lyra/previews/2026-08-05-1246/
  main
  agent/purple-falcon    fix token validation
  agent/hollow-peak      optimize hot loop
  agent/amber-forge      add integration tests
```

Open it in Fork, GitKraken, VS Code, `git log --graph`. Reviewing dozens of patches as
terminal text is not a thing anyone should do; the starburst graph in a real GUI is.
Auto-detected from PATH, overridable.

### Apply

```
lyra apply [--preview <name>]     # snapshot, then apply
lyra rollback [--to <name>]       # restore
lyra snapshot list
```

A CoW snapshot is taken **before** any change — instant, zero bytes. Post-apply, if a
hallucination surfaces at runtime, `lyra rollback` restores exactly. Both directions are
milliseconds, which is what makes applying AI-authored work reasonable at all.

### Merge conflicts

Isolation is the primary answer: independent repos never collide *while working*. Conflicts
only exist at assembly.

There, a **resolver** agent (`@merge` role, minimal prompt, own context) receives both
sides, the conflict, and — importantly — **both agents' original task contracts**, so it
resolves toward intent rather than toward syntax. It reports in those terms:

> Resolved 3 conflicts in `src/auth.rs`. Kept purple-falcon's token validation and
> hollow-peak's rate limiting; both applied to the same handler.

If it cannot resolve honestly, it stops. Notifies via IRC and the TUI, shows the conflict in
the diff viewer, and waits. A resolver that guesses is worse than one that asks. In
`observe`/`stage` mode it is not invoked at all — conflicts surface in the preview repo and
you resolve them in your GUI.

### Visibility

Destructive git operations are never blocked (YOLO) and always logged to the activity feed.
You always know what agents did to your history.

---

## 13. Context discipline

### Prompt caching is a correctness feature

Mishandled caching costs money and latency, and — because it changes what the provider
accepts mid-session — it is also a §3.6 corruption source. Rules:

- **The system prompt is a stable prefix for the whole session.** No git branch, no active
  agents, no token counts, no timestamps. Anything that changes goes in a user-turn
  preamble.
- **The tool array never mutates mid-session.** This forbids "hydrate schemas on demand"
  for built-ins (§17) — every mutation invalidates the cache and risks a shape error.
- **Cache breakpoints** after the system prompt and after stable context files; never
  inside the live tail.
- **Adding an MCP server starts a new turn boundary** with a fresh cache, and says so.

### Compaction

Context fills. Under `/loop` it fills fast. Unmanaged, it is the most common way a long
session dies.

- Threshold at 80% of the window, or provider-native compaction where offered (§5.2).
- Produces a **boundary entry** with `firstKeptEntry`; the model context starts at the
  boundary. **The transcript keeps everything** — export and `/context` still show
  pre-boundary history (§3.8).
- Preserved verbatim across a boundary: the active plan, open file set, the last N turns,
  every pending tool call.
- Boundaries are visible in the TUI with the token delta. Never silent.
- `/compact` forces it; `/clear` sets a hard boundary without summarizing.

### Everything is inspectable

`/context` shows the exact payload: system prompt, tool array, every message, every repair
(§3.6), every truncation (§3.8), cache breakpoints, token counts per section. If you cannot
answer "what did the model actually see," you cannot debug a bad session — and Lyra's whole
premise is that bad sessions are a bug, not weather.

---

## 14. System prompt

```
# Lyra
OS: darwin 27.0.0 arm64
Workspace: /Users/mx/proj/.lyra/workspaces/purple-falcon
Origin: /Users/mx/proj
Session: swift-tide-4f2a

## Tools
read    — files, directories, URLs, images
write   — create or overwrite a file
edit    — content-anchored search/replace patch
bash    — run a command; heavy commands return a job handle
grep    — regex search
glob    — file patterns
lsp     — definition, references, rename, diagnostics
spawn   — delegate to a subagent; add output_schema for a typed contract
hub     — messaging, channels, job control
skill   — load a skill's instructions
jit     — declare and run a runtime-authored tool
mcp     — describe and call MCP tools
git     — git operations in this workspace

## Skills
adversarial-review — implementer/reviewer split for high-stakes changes
draco              — local scraping and web search
...
```

Environment manifest and capability index. Nothing else.

No "you are a helpful coding assistant." No tone rules, no length limits, no "think step by
step," no "do not hallucinate." No coding style. No persona. Under ~500 tokens including
tool schemas.

Dynamic state — branch, active agents, token counts — is **not here** (§13). It goes in the
turn preamble where it cannot break the cache.

---

## 15. Tools

Thirteen. Each finished.

| Tool | Notes |
|---|---|
| `read` | Files, directories, URLs, images, `skill://`, `artifact://`. Line ranges. Returns `#TAG`. |
| `write` | Create or overwrite. First-class edit path for small files and pervasive change (§6.4). |
| `edit` | §6. |
| `bash` | Semaphore-classed (§11). Heavy → job handle. |
| `grep` | Regex, ripgrep-backed, `io`-classed. |
| `glob` | Patterns, gitignore-aware. |
| `lsp` | definition, references, hover, rename, diagnostics, code actions. **Auto-started per detected language** (§2). Degrades to text tools on timeout, warns once. |
| `spawn` | §7. |
| `hub` | §9. |
| `skill` | §16. |
| `jit` | §8. |
| `mcp` | §17. |
| `git` | Workspace git. Destructive ops logged, never blocked. |

No `web_search` built in — it arrives via Draco's MCP (§17), which is the correct layer.

No todo tool. 2026 models track their own plans; a todo tool is 2024-era scaffolding. (§25
revisits this if `/loop` soak testing shows plan drift.)

---

## 16. Skills

Lazily-loaded **instructions**. Not toolsets — they do not gate tool access.

- Discovered from `.lyra/skills/<name>/SKILL.md`; project overrides user overrides bundled.
- Frontmatter: `name`, `description`. Nothing else is required.
- The system prompt carries **name + one line**. The body loads only when the model calls
  `skill(name)`.
- **No `alwaysApply`.** Everything is lazy. Persistent project instructions are `AGENTS.md`.

### Bundled

**`adversarial-review`** — the Bun rewrite's process, which is the only multi-agent code
review methodology proven at that scale. 1 implementer : 2 reviewers, split context windows,
reviewers never implement, implementers never review. Includes the rule that made it work:

> *If you need a paragraph-long comment to justify why the workaround is OK, the code is
> wrong — fix the code.*

And the stub-detection rule, from their observed failure where *"Claude interpreted 'let's
get all the crates to compile' as 'stub out the functions with compilation errors'"* — a
failure mode any large mechanical task will reproduce.

Shipped as a skill, not hardcoded as a workflow: the model composes it via `spawn` when the
task warrants, which is the §2 line between a battery and a framework.

**`draco`** — local scraping and search.

---

## 17. MCP

Client only. Never a host, no server-authoring surface.

### Progressive disclosure applies here, not to built-ins

A model cannot call a tool absent from the API's `tools` array. So "index the built-ins and
hydrate on demand" costs a round trip on every first use *and* mutates the tool array,
which breaks prompt caching (§13). Thirteen built-in schemas are ~1.5k tokens — that is the
harness contract, not bloat.

MCP is the unbounded surface, and a single enterprise server can inject 10k–17k tokens of
schema. So MCP gets exactly two stable tools:

```typescript
mcp({ op: 'describe', server: 'linear', tool: 'create_issue' })   // → full schema
mcp({ op: 'call',     server: 'linear', tool: 'create_issue', args: {...} })
```

The tool array never changes; the *index* of available MCP tools lives in the tool
description as names plus one-liners. Schema hydration is a normal tool call, so N servers
cost N one-liners rather than N schema dumps.

### Draco

First offered the first time the model reaches for web search:

> No search backend. Install Draco? Local scraping and search, no API key, no per-request
> cost. [Enter] install · [Esc] skip

One keypress: fetch `install.sh`, install, register as an MCP server. Draco returns clean
markdown in ~300ms without a browser, has its own MCP server, and is free. Exa and Tavily
remain available as ordinary MCP servers for what Draco cannot do — no preference, same
registration path.

---

## 18. Session persistence

**Append-only JSONL for the transcript. SQLite for the prompt index.**

```
.lyra/sessions/<name>-<id>.jsonl    # truth
~/.lyra/history.db                  # FTS over prompts
```

JSONL because it is crash-resilient (a torn tail loses one entry, not the session),
human-inspectable, and append-only. Entries carry `id` + `parentId`, so the session is a
tree and branching moves a pointer instead of mutating history — which is what makes
`/fork` and rewind safe.

SQLite only for prompt-history search, where FTS earns its keep.

**The transcript is not the wire format** (§3.6). The request is derived on every turn. A
bad derivation is a bug to fix and re-derive, never a session to discard. This is the
structural guarantee behind F5.

Writes are synchronous on turn completion. A crash costs at most the in-flight turn, and
the partial is retained and marked (§3.8).

---

## 19. TUI

Flywheel-backed. Zero flicker is a floor, not a feature.

### Position

Pi is clean but it is now everyone's TUI. Crush's gradients and ASCII art are decoration
that competes with the work. OMP's animated splash screens are the clearest case of motion
with no information content — you open a coding tool and watch an animation.

**Information density, one ambient indicator, zero decorative motion.**

```
┌──────────────────────────────────────────────────┐
│ lyra   proj   main   opus-5   purple-falcon      │
├──────────────────────────────────────────────────┤
│                                                  │
│  messages · tool calls · diffs                   │
│                                                  │
├──────────────────────────────────────────────────┤
│ ◎ hollow-peak  ◎ amber-forge  ○ 2 queued         │
├──────────────────────────────────────────────────┤
│ ▸ _                                              │
│   42k/200k  $0.12  1.2s                          │
└──────────────────────────────────────────────────┘
```

**The signature: the composer border.** A single soft accent that shifts when the model is
streaming. A state change, not an animation — no pulse, no travel, no shimmer. It encodes
liveness, which is exactly what you need peripherally while reading output above it. This is
Crush's lesson applied correctly: distinctive *because* it is functional.

**Tool calls collapse by default.** One line: `▸ edit  src/auth.ts  +12 −4`. Tab expands.

**The activity strip is one line.** Presence dots for live agents, a count for queued. Not a
panel, not a graph.

**Reliability is visible** (§3):

- Retrying: `⟳ retry 2/8 · rate limited · 4s` in the footer. Never a silent stall.
- Loop detected: an inline note, not a modal.
- Compaction: a boundary line with the token delta.
- Context repair: a footer marker linking to `/context`.

**Two accent colors maximum**, everything else neutral. Pure monospace. Unicode
box-drawing only — no Nerd Font dependency. Three bundled themes. No splash screen.

---

## 20. Steering and interrupts

Absent from most harnesses and a top source of terminal friction. If the only way to correct
a wrong turn is Ctrl+C and lose it, you stop trusting long turns.

| Input | Behavior |
|---|---|
| **Enter** while streaming | **Steer** — injected into the current turn at the next tool boundary. Course-correct without losing work. |
| **Ctrl+Enter** while streaming | **Queue** — delivered as the next turn. |
| **Esc** | Cancel the turn. Partial output retained and marked (§3.8). |
| **Esc Esc** | Rewind to the previous user turn. |
| **Ctrl+C** | Cancel; twice exits. Always responsive — the input actor is never blocked by the renderer. |

Steering lands at a tool boundary rather than mid-token, so the message arrives in a
coherent state. Both queues are visible in the composer while pending — nothing is silently
swallowed.

---

## 21. ACP daemon

Lyra's core is the daemon. The TUI is one client with no privileged path. Anything the TUI
can do, any ACP client can do — which is what makes an ADE on top of this possible.

ACP (Zed + JetBrains) is LSP for coding agents: JSON-RPC, stdio locally, HTTP/WebSocket
remote, capability handshake, bidirectional so the agent can request permission or open a
terminal.

```
initialize
session/new · load · prompt · update · cancel · fork
session/models · select_model · providers · select_provider
provider/setup_options · detect · verify · add · get · remove
model/add
workspace/list · create · drop
agent/list · spawn · cancel · message
git/preview · apply · rollback · snapshot
context/inspect
settings/get · set
```

The method surface is deliberately the same as the JIT runtime API (§8). One control plane,
two entry points — anything reachable in an orchestration script is reachable over ACP, and
they are validated by the same tests.

**The daemon boots without a provider.** `provider/*` is answerable when nothing is
configured, because that is the only moment it matters: a first run comes up with a real
session whose prompts are refused with an actionable error, `session/snapshot` reports
`providerConfigured: false`, and the client runs setup over `provider/setup_options` →
`provider/detect` → `provider/verify` → `provider/add` → `session/select_provider`. A
credential crosses this pipe once, in `apiKey`; it is never persisted except where `persist`
says, never logged, and never echoed by a result or a notification.

**Editing and deleting are the same surface.** `provider/get` reads one provider back for the
form — including where its credential comes from, never what it is — and `provider/add` with
an existing id replaces it, with `persist: "keep"` for the common edit whose key field was
left empty. `provider/remove` deletes a declaration through the same non-destructive merge,
refuses while the session is running on that provider, cleans the OS-keychain entry only when
asked, and reports the roles left pointing at the removed name rather than repointing them.

**Lyra as ACP client too.** `spawn({ acp: 'claude' })` runs an external harness as a
subagent, bridged onto the IRC bus (§9). Lyra orchestrates other harnesses using the same
primitive as its own agents.

stdio ships first. Remote transport requires auth and is gated behind it.

---

## 22. Slash commands

| Command | |
|---|---|
| `/copy` | Copy last message, or pick one |
| `/dump` | Full transcript to clipboard |
| `/settings` | Runtime toggles |
| `/provider [name [model]\|edit <name>\|delete <name>]` | Switch, add, edit, or delete |
| `/model [refresh]` | Switch model; refresh the `/models` cache |
| `/loop <n \| duration \| until "cond">` | Re-run the goal on every turn end |
| `/context` | Exact payload inspection (§13) |
| `/compact` · `/clear` | Force a boundary |
| `/agents` · `/kill <name>` | Live agents |
| `/workspaces` · `/cleanup` | CoW workspaces |
| `/gitmode <observe\|stage\|auto>` | §12 |
| `/review` · `/apply` · `/rollback` | §12 |
| `/skills` · `/mcp` · `/install <tool>` | Capability management |
| `/fork` · `/resume` · `/sessions` | Session tree |
| `/health` | Metrics from §3.9 |

`/loop` detail: `/loop 10`, `/loop 30m`, `/loop until "tests pass"`. The goal is re-sent on
each turn end with prior output in context. **Hard-stops on the no-progress detector**
(§3.5) — an unattended loop has nobody watching it burn.

---

## 23. Config

TOML. Data only, never code (§2). Every value has a working default; the file only
overrides.

```toml
[roles]
default = "anthropic/claude-opus-5"
fast    = "anthropic/claude-haiku-4.5"
merge   = "anthropic/claude-opus-5"

[exec]
heavy  = 8          # default min(nproc, 8)
io     = 4
cgroup = false      # linux: systemd-run isolation

[git]
mode = "observe"
gui  = "auto"

[workspace]
enabled  = true
archive_after = "7d"

[tui]
theme  = "default"
accent = "#7aa2f7"

[reliability]
stream_stall_timeout = "45s"
turn_timeout         = "30m"
max_retries          = 8
compact_at           = 0.80
```

---

## 24. Build sequence

No dates. Velocity is unknown and any estimate would be wrong. Sequenced by dependency.

**1 — Provider layer + conformance harness.** All four transports, the §3.2 classifier, the
chaos harness. This is first because §3 makes it the highest-risk subsystem, and everything
downstream inherits its reliability. Nothing else starts until the matrix is green.

**2 — Agent loop + context integrity.** Turn loop, tool dispatch, §3.6 invariants, JSONL
transcript, compaction.

**3 — Edit engine.** §6, with a correctness corpus across languages and file sizes. Measure
first-call success; iterate the tool, never the prompt.

**4 — Core tools.** read, write, bash, grep, glob, git. Fuzz each (§3.9).

**5 — TUI.** Flywheel binding, streaming, collapsed tool calls, composer border, steering
(§20), the §19 reliability surfaces.

**6 — LSP.** Auto-detect and auto-start. A battery, not a config.

**7 — Host layer.** `lyra-host`: CoW workspaces, filesystem probes, classed semaphore,
cgroups.

**8 — spawn + IRC.** §7, §9. Depends on 7 for isolation.

**9 — JIT runtime.** `lyra:runtime` including `lyra.spawn()` and `lyra.checkpoint()`. This
is where dynamic workflows appear.

**10 — Git pipeline.** Preview assembly, transactional apply/rollback, resolver agent.

**11 — MCP + Draco.** `mcp` tool, lazy hydration, one-keypress Draco.

**12 — Skills.** Discovery, `skill://`, bundled `adversarial-review`.

**13 — ACP.** stdio first. Same surface as 9.

**14 — Soak.** 24h `/loop` against a real repo. Then `/health`, `/context`, polish.

---

## 25. Open questions

**Edit format validation.** §6 is reasoned from the ACL 2026 results, not from measurement
on this codebase. Build the corpus in step 3 and answer: how often does tier 1 (exact)
actually resolve, do tiers 2–3 ever fire at the frontier, does mode 2 (AST symbol) beat
mode 1 for whole-function rewrites, and does the `#TAG` guard ever produce a false rejection
that costs more than it saves? Instrument all three modes and all three tiers from day one.

**`write` vs `edit` boundary.** §6.4 leaves it to the model. Watch whether it over-uses
`write` on large files (token waste) or under-uses it on pervasive change (failed anchors).

**Steering delivery point.** Next tool boundary is the proposal. If turns run long with no
tool calls, that is too coarse — may need a token-boundary path with a coherence guard.

**Todo tool.** Excluded (§15). If soak testing shows plan drift across compactions, the fix
might be a todo tool, or it might be better compaction preservation. Compaction first.

**Resolver autonomy in `auto` mode.** How aggressive before it must stop? A wrong silent
merge is much worse than a pause.

**Snapshot retention.** Time-based, count-based, or size-based. CoW makes them nearly free,
which argues for generous retention.

**Remote ACP auth.** Required before remote transport ships. Token, mTLS, or OS keychain.

**`/loop until` evaluation.** Which context does the condition-checking model see? Full
transcript is expensive; last turn only may be insufficient.

**Cross-provider thinking-block fidelity.** Anthropic thinking ↔ OpenAI reasoning items do
not map cleanly. §5.5 re-derives rather than transforms, but the loss should be measured and
surfaced precisely.

---

## 26. Credits

| Source | Taken |
|---|---|
| **Bun Rust rewrite** | The 64-agent scaling failures and their real causes: git collisions, disk/IOPS starvation, cgroup necessity. Adversarial review with split contexts. "Fix the process, not the code." The evidence that orchestration must live outside the main context. Explicitly **not** the language conclusion — that was a runtime problem, not an application one. |
| **Flywheel** | The rendering engine. 3-actor pipeline, double-buffered diffing, fast-path append. |
| **Draco** | Free local scraping and search, first-class. |
| **ACL 2026 "To Diff or Not to Diff?"** | The edit format evidence: line numbers are catastrophic, structure-aware block rewrites match full-code, anchors need context for uniqueness, adaptive full-file for pervasive change. |
| **omp.sh** | IRC as a first-class primitive; process supervision; the snapshot-tag guard on edits. Deliberately **not** hashline's line anchoring, its grammar, or its surface area. |
| **Claude Code** | Dynamic workflows, and the precise reason they exist: keeping intermediate results out of the orchestrator's context. |
| **Pi** | Minimal system prompt, YOLO default, context transparency. Deliberately **not** its extension-first architecture — Lyra ships fewer features, but every one is complete. |
| **Crush** | That polish is a real differentiator. Not the maximalism. |
| **OpenAI Codex / Agents SDK** | Isolated-worktree agents, review queues. Handoffs and Agents-as-Tools as further evidence the delegation split is artificial. |
| **ACP** | The protocol. Every capability reachable programmatically. |
| **T3 Code** | That someone will build an ADE on this, so the daemon must be the real interface. |
