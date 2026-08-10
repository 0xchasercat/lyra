# Lyra TUI v2 — Design

Governing document for the ground-up TUI rewrite. Supersedes the frame-renderer
architecture and amends LYRA.md §19–20 where noted. Decisions here were made
2026-08-09 from source-level studies of ante, Claude Code (via the openclaude
reconstruction — design lessons only, no code lifted), opencode, and grok-build.

## 0. The two owner decisions

1. **Stack: Rust + Flywheel, standalone binary, full ACP client.** The TUI owns
   input, state, and rendering. It speaks ACP (JSON-RPC over stdio) to the
   daemon and nothing else. The old split — input/state in TS, stateless Rust
   renderer fed whole-UI frames — is the root defect this rewrite removes:
   every mechanism a good TUI needs (stable-prefix parsing, local echo latency,
   per-region diffing, commit-to-scrollback) requires the client to own layout
   and state. Flywheel's 3-actor pipeline and fast-path append are exactly the
   engine the scrollback architecture below needs.

2. **Steering (amends §20): queue by default, steer explicitly.**
   - `Enter` while streaming → **queue**. Visible above the composer
     (`N queued · ctrl+s to steer now`, with previews). Auto-submits when the
     turn ends.
   - `Ctrl+S` → **flush the queue into the running turn** as steering,
     delivered at the next tool boundary (the §20 interjection engine and
     drain points are unchanged — only the trigger moves).
   - `Esc` → cancel turn, keep partial output, marked. `Esc Esc` → rewind.
     `Ctrl+C` → cancel; twice exits.
   - **Rewind is two decisions, so it asks.** `Esc Esc` (and `/rewind`, which is
     the same surface reached through a checkpoint picker) re-reads
     `checkpoint/list` and opens a confirmation offering *the conversation
     only*, *the code as well*, or — for a checkpoint anchored to no transcript
     entry — the code alone, said out loud. Moving the head is `session/rewind`;
     taking the working directory back is `checkpoint/restore`; they are
     separate calls because rewinding what was said and reverting what was
     written are independent choices. A restore never clobbers files that
     changed outside Lyra's own tool calls: it reports them **by name** and only
     then offers the `--force` that would revert them too.
   - Evidence: grok-build shipped bare-key mid-turn steering and migrated off
     it (a mid-turn message is ambiguous between "also do this" and "stop
     that"); ante ships queue+flush; Claude Code queues only. Explicit steer
     removes the delivery-timing ambiguity and frees `Ctrl+Enter`.
   - Steering text lands as a **standalone synthetic user turn**, never
     appended to a tool result, so compaction/replay/`/context` attribute it
     correctly (grok-build's rule, adopted verbatim).
   - Steer aborts interruptible waits: a blocked `wait`-class tool returns
     "Wait interrupted: the user sent a message" to the model.
   - Cancel keeps partial output; only a zero-output turn is trimmed from
     history, and only when the client has rewound the prompt into the
     composer (prevents the send+cancel double-prompt bug).

## 1. Scrollback architecture (the load-bearing choice)

**Native terminal scrollback. One UI mode. No alt-screen, no internal
viewport, no mouse capture.**

- Finished output is printed to the terminal **once** and never touched again.
  Only a bottom **live region** is diffed and redrawn: the current streaming
  block, activity strip, queue display, presence strip, composer, hint line,
  footer (§3 has the full order). Bounded height (~last 24 rows), and *bounded*
  rather than fixed: an overlay or completion popup borrows rows and gives them
  back when it closes, which is how a panel floats without a second rendering
  mode.
- Streaming commits **only provably-stable rows** into scrollback: text/code
  hold back the final row (it may reflow); markdown commits whole blocks as
  they stabilize (opencode's `RunScrollbackStream` protocol — the only serious
  answer to "native scrollback and rich streaming layout").
- Why: Claude Code keeps the whole transcript in a live diffable buffer and
  pays forever — message caps, offscreen-freeze hacks, a parallel alt-screen
  mode, per-terminal special cases. Content above the fold must be immutable.
- **Resize** is the tax. Two modes (ante's design, adopted):
  `conservative` (default: never rewrite scrollback; stale wrapping possible)
  and `purge` (CSI 3 J + replay recent transcript at new width; capped ~2000
  lines, debounced 250ms). Purge is opt-in because CSI 3 J support is
  undetectable; always-purge under tmux/zellij where it is reliable.
- The terminal keeps selection, copy, search, and scrolling. We never take the
  mouse.

## 2. Process & protocol

```
lyra (bun cli.ts, thin) ──spawn──▶ lyra-tui (Rust binary)
        │                              │
        └── AcpDaemon ◀── ACP/stdio ───┘
```

- `cli.ts` shrinks to: arg parsing, entry-mode dispatch, spawning the TUI
  binary wired to the same `AcpDaemon` that `--acp` serves externally. All
  `FrameRequest`/`UiRow`/`InteractiveUi`/`ProviderSetupUi`/`TuiBridge` code is
  deleted.
- **No hand-mirrored schema.** The protocol is ACP itself. A single canonical
  schema file (JSON Schema, `packages/lyra-acp/schema/protocol.json`) defines
  every method and notification, and both sides are checked against *it* rather
  than against each other: `protocol.test.ts` on the daemon side, and
  `acp::conformance` on the client side, which embeds the schema with
  `include_str!` so the file moving is a compile error and a drifted variant,
  field, method name, `resultKind` or enum value is a red test. A drifted field
  is a build failure, not a runtime surprise.
- Events are **semantic deltas**, not UI state: `{sessionId, messageId,
  partId, field, delta}` for streaming; tool-call lifecycle
  (start/update/end with status); retry (attempt, max, reason, retry-at);
  compaction boundary (token delta, first-kept); context repairs; usage;
  spawned-child lifecycle (`agent`, one event per transition, carrying the
  transition itself as well as the state it left the child in — `started` and
  `revived` are both `running`, so a client reading only the state sees one
  thing where the daemon said two — and counts rather than paths, because the
  paths belong to the child's own result). That is what the
  presence strip and its audit rows are drawn from, and what
  `session/snapshot`'s `agents` hydrates for a client that attached mid-session
  (a transition already applied wins over the snapshot in flight beside it).
  Raw measurements over the wire — token counts as numbers, percentages
  derived client-side, absent limit ⇒ render nothing rather than a wrong
  number. Explicit turn-resume event closes every pause bracket.
- Event coalescing client-side, without a frame timer: the loop parks on the
  event channel, drains everything queued (bounded per tick so a loud turn
  cannot starve the keyboard), and renders **once**. A burst therefore costs one
  frame; an isolated event wakes the park and renders immediately. The only
  timers are the ones a *surface* needs — a 1 Hz retry countdown, the spinner's
  frame, an expiring armed gesture — and they set the park length, not the
  flush. None of them is a *judgement*: no client-side timer decides that a turn
  has gone wrong (see Motion, §3).

## 3. Visual system (§19, made concrete)

- **Layout** (top→bottom): transcript flowing into native scrollback → live
  streaming block → activity strip (one line) → transient notice (when armed)
  → queue display (when nonempty) → **agent presence strip** (when this session
  has children) → completion popup (when open) → composer → contextual hint
  line → footer. An overlay is modal: it replaces everything from the streaming
  block down to the popup, so a panel never has to be squeezed in beside them.
  A one-line header prints once at session start into scrollback
  (`lyra · daemon name+version · session name · model · directory`) — every
  field after `lyra` comes from `initialize` and `session/snapshot`, and a field
  the daemon did not supply is omitted rather than faked. No persistent header
  row, no splash, no mascot, no tips. The directory is `session/snapshot`'s
  `workspace` field, which since the §10 redesign is the launch directory itself
  for a main session (and a workspace path only for an isolated agent). It is a
  real path the user can `cd` into, so it is rendered verbatim rather than
  abbreviated to a workspace name.
- **The presence strip** is §19's presence dots: one glyph per live child with
  its peer name, a count for the ones still queued, coloured by state (accent
  running, agent-tint inside a tool call, plain `✓` briefly on finish, error on
  failure), degrading by shedding *names* into an honest `+N` rather than by
  lying about how many there are. It is the only place the present tense of a
  child lives — nothing a child does streams into the transcript while it works,
  because six children each reporting every tool call would bury the
  conversation they were spawned to serve. It is *chrome*, so the anti-jitter
  rule below applies with one refinement — it **grows the region the moment a
  child appears** (that is information arriving) and **shrinks only at a turn
  boundary**, so a child finishing mid-stream never collapses the row underneath
  the composer.
- **Lifecycle rows** are the other half, and the split is the same one the tool
  grammar makes between the activity strip and the collapsed `▸` row. The
  transitions worth *history* — appeared, revived, finished, failed — commit as
  dim one-line audit rows, run-collapsed like tool calls so a swarm costs a line
  rather than a page, and counting **children** rather than transitions so a
  child that spawned and finished inside one run is one agent with two things
  said about it. A failure is never folded into a count of something else.
  `started`, `running` and `awaiting_tool` earn nothing, because the present
  tense belongs in the live region. A revival earns a row for the same reason it
  earns a distinct wire event: it is the only way a child produces two `✓` rows
  in one session, and a reader who never saw the restart cannot account for the
  second one. The transition the daemon *declares* wins over one inferred from a
  status diff; the diff is only the fallback for a daemon that predates the
  field, and it is knowably weaker — a revival is invisible to it.
- **Hub asides**: another agent speaking into this turn, which the daemon flags
  as `steer.source: "hub"`, is **not** a `>` user band. It gets one dim
  `⇄ peer: …` row, and the envelope the daemon wraps it in for the *model's*
  benefit — a preamble naming the speaker and an instruction on how to reply —
  is peeled off before it is shown, because the row already says both. Replay
  reads the same envelope back off the persisted user-role message, so a
  reloaded session does not re-attribute another agent's words to the person at
  the keyboard.
- **The signature** stays: the composer border is the single ambient
  indicator — a color state change while streaming (agent-identity tinted),
  no pulse, no travel, no shimmer.
- **Transcript grammar**: `▸ edit src/auth.ts +12 −4` collapsed tool rows
  (dim while pending, accent on run, plain on success, error on failure);
  `└─` tree children for results/detail (`Tab` expands the *last* tool call,
  never mouse-only); `> user text` bands; dim one-line audit rows.
- **Command results are rendered, never dumped.** A brace on the terminal is a
  bug. Every `session/command` answer names its own shape with `resultKind`,
  declared up front by `session/commands` and repeated on the answer, so the
  client dispatches to a renderer instead of sniffing the payload: aligned
  tables with a `▸` on the current row for `models`/`sessions`/`workspaces`/
  `agents`/`skills`/`mcp`/`checkpoints`, label-value rows for `health`, raw
  token counts for `context`, markdown for `report`. `/review` is the one that
  answers *through the transcript* rather than beside it — its per-file rows
  **are** collapsed tool rows, drawn by the same renderer and expandable by the
  same `Tab` — and `/checkpoints` renders the rewind list as a table rather than
  as a sentence. A kind this build has never heard of falls through to an
  indented key/value tree, which is why no daemon change can put JSON on screen.
- **Reliability, visible** ("never render nothing"):
  `⟳ rate limited · retry 2/8 · 4s` with a live 1 Hz countdown in the footer,
  escalating to full detail at attempt ≥4; `─ compacted · −38k tokens ─`
  boundary line; context-repair marker linking `/context`; loop-detection
  inline note; queue always visible while pending.
- **Color**: two accents maximum (accent + agent-identity tint), semantic
  error/warning/success, and a dim-first neutral ramp — evidence from both
  big TUIs: ~6 tokens carry >90% of colored output. Small semantic token set;
  three bundled themes; terminal-adaptive `system` theme from the 16-color
  palette with background alpha 0; live re-theme on DEC 2031; OSC 11
  luminance for auto light/dark.
- **Glyphs**: pure Unicode (`● ◆ ▸ └─ ⟳ ∴`, plus the child vocabulary
  `◎ ◍ ○ ✓ ✗ ↻ ⇄`), zero Nerd Font, zero PUA.
- **Thinking traces** are rendered, and the split is by *surface* rather than by
  secrecy. Live, reasoning streams into the live region under a dim `∴ thinking`
  marker — transient by construction, so it costs nothing permanent and answers
  "what is it doing" during the long silence before a reasoning model speaks.
  Committed, the whole trace collapses to one dim line, `∴ thought for 23s`
  (client-timed from `part_start` to `part_end`; the figure is omitted rather
  than guessed when the part was not seen opening), because scrollback buried
  under deliberation is scrollback nobody reads (§19). `Tab` still expands the
  last *tool call* and nothing else — expanding a thought would need its own
  affordance, and the trace is already in the session store for `/context` and
  any future viewer to show. Reading a model's output and debugging a model's
  reasoning want opposite things from the same bytes, so `[tui] thinking =
  "collapsed" | "full" | "off"` (default `collapsed`) chooses: `full` commits the
  dim trace itself, `off` renders none of it on any surface. History replay obeys
  the same setting. The signature sealing a thinking block is never rendered in
  any mode — opaque provider bytes are not reasoning — so a redacted part earns
  its one-liner and nothing else.
- **Anti-jitter rules** (Claude Code's lessons, adopted): fixed-height chrome
  rows that never collapse 0↔1; transient hints display ≥700ms; width
  degradation leaves a visible `…`; wide content truncates, the page never
  scrolls horizontally.
- **Diffs**: one renderer for every surface (inline edit results, expanded
  view, theme preview). Word-level intra-line highlight with a 40% bail-out;
  uniformly dimmed line-number gutter.
- **Markdown**: line-boundary streaming publish (render once per completed
  line, never per token) + monotonic stable-prefix parsing (only the trailing
  unstable block re-parses). h2/h3 modest, code spans accent-colored, tables
  degrade to key-value when narrow.
- **Motion**: zero decorative, and exactly one non-decorative exception — the
  activity glyph spins **smoothly and continuously for as long as the turn
  runs**, carrying one bit ("this turn is still ours") and nothing finer. It does
  *not* stop or change colour on the client's own estimate of a stall: a model
  thinking silently for a minute is the workload, not a fault, and this client
  holds no provider connection, no request deadline and no way to tell a long
  thought from a hang. The daemon owns stall truth and reports it — `round_start`
  says a request is in flight (the strip says "waiting for the model"), and a
  `retry` says the round is in trouble, which is the only thing that turns the
  glyph amber. It keeps spinning while amber, because the retry countdown beside
  it is ticking. `prefers-reduced-motion` honored by not needing it.

## 4. Input

- **Kitty keyboard protocol** negotiated (required for Enter/Shift+Enter/
  Ctrl+Enter discrimination); full legacy fallback parsing; capability
  detection via DA1-sentinel batch probing (zero timeouts, SSH-safe) and
  XTVERSION identity.
- **Keybinding registry as the single source of truth**: every action declares
  key, context, description, hint priority — the cheatsheet, `?` help, and
  contextual hint bar are generated from it (grok-build's structure). No
  scattered handlers. User remapping via `[tui.keys]` in config (data, not
  code).
- **Esc policy is one ordered function** — overlay dismiss → completion popup
  dismiss → composer clear (armed) → unqueue the newest queued entry back into
  the composer → cancel turn → rewind (armed) — documented order, no
  fall-through surprises, and an `Esc` that reaches the end does nothing at all.
  The unqueue rung is composer-adjacent state, which is why it sits with the
  input rungs rather than after cancel: the ladder reads top to bottom as *undo
  my most recent input intent, then stop the machine*. `Ctrl+C` still cancels
  unconditionally at any depth.
- **The mash is part of the policy.** The gesture a user makes when a turn goes
  wrong is not one `Esc`, it is five, and a plain ordered function walked at
  mash speed turns a cancel into a rewind. So the ladder is deaf for a
  burst-length grace after any rung *acts*, and the same window is the floor on
  confirming an arm — a press cannot confirm a destructive rung whose hint had
  not yet been on screen when it was made. Holding `Esc` down therefore clears
  and rewinds nothing.
- **Composer**: readline/emacs set with kill-ring; undo groups (checkpoint on
  kind-change/cursor-jump; composite operations are one undo step); multiline
  via Shift+Enter (kitty) / Alt+Enter (fallback); paste chips — ≥3 lines or
  >150 chars collapses to `[pasted ~N lines]` as an extmark-backed
  placeholder, individually deletable, expanded losslessly at submit;
  repaste-to-expand; `@` file mentions (server-ranked, not re-sorted);
  `/` commands with recognized-command highlight; `!` bash mode (border flips
  color, one-shot); history (↑ at buffer start; no chord); IME cursor parked
  at the caret.
- **Slash/palette/keybind unified**: one command declaration is reachable by
  key, palette (`Ctrl+P`), and `/name` — descriptions feed help. No drift.

## 5. What is deliberately absent

No mouse capture (and therefore no selection/copy reimplementation), no
alt-screen, no internal scrolling, no splash/logo/mascot, no tips, no
rotating verbs, no ambient LLM calls (predicted phrases, ghost suggestions),
no shimmer/rainbow/animated backgrounds, no sound, no in-TUI terminal
multiplexing, no second rendering mode, no Nerd Fonts, no Windows.

## 6. Build phases

1. **Protocol** — canonical ACP schema file; daemon emits every event in §2
   with raw measurements; conformance tests both sides; Rust types generated.
2. **Engine** — Flywheel integration: commit-stable-rows scrollback writer,
   live-region compositor, fast-path append, resize replay (both modes),
   BSU/ESU, capability probing.
3. **State** — session store with delta application, binary-search inserts,
   tool lifecycle, queue/steer state machine, hydration race guards
   (live event during snapshot fetch: live wins).
4. **Composer + input** — keybinding registry, Esc policy, editor, chips,
   completion, history.
5. **Content** — markdown streaming, diff renderer, tool rows, reliability
   surfaces, themes.
6. **Integration** — slim cli.ts, packaging, pickers/wizards as ACP flows,
   steering daemon-side (synthetic user turns, wait interruption).
7. **Soak** — long-session memory bounds, resize storms, tmux/zellij/kitty/
   ghostty/iterm2/terminal.app matrix, latency measurement (TTFD tracked).
