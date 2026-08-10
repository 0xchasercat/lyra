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
  block, activity strip, queue display, composer, footer. Bounded height
  (~last 24 rows).
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
  schema file (JSON Schema, checked into lyra-acp) defines every method and
  notification; Rust serde types are generated/validated from it in CI. A
  drifted field is a build failure, not a runtime surprise.
- Events are **semantic deltas**, not UI state: `{sessionId, messageId,
  partId, field, delta}` for streaming; tool-call lifecycle
  (start/update/end with status); retry (attempt, max, reason, retry-at);
  compaction boundary (token delta, first-kept); context repairs; usage.
  Raw measurements over the wire — token counts as numbers, percentages
  derived client-side, absent limit ⇒ render nothing rather than a wrong
  number. Explicit turn-resume event closes every pause bracket.
- Event coalescing client-side: flush on a 16ms timer only when events are
  already bursty; isolated events render immediately.

## 3. Visual system (§19, made concrete)

- **Layout** (top→bottom): transcript flowing into native scrollback → live
  streaming block → activity strip (one line) → queue display (when nonempty)
  → composer → footer. A one-line header prints once at session start into
  scrollback (`lyra · project · branch · model · workspace`) — no persistent
  header row, no splash, no mascot, no tips.
- **The signature** stays: the composer border is the single ambient
  indicator — a color state change while streaming (agent-identity tinted),
  no pulse, no travel, no shimmer.
- **Transcript grammar**: `▸ edit src/auth.ts +12 −4` collapsed tool rows
  (dim while pending, accent on run, plain on success, error on failure);
  `└─` tree children for results/detail (`Tab` expands the *last* tool call,
  never mouse-only); `> user text` bands; dim one-line audit rows.
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
- **Glyphs**: pure Unicode (`● ◆ ▸ └─ ⟳`), zero Nerd Font, zero PUA.
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
- **Motion**: zero decorative. Spinner is a minimal state glyph; stall >3s
  shifts it toward error color (state, not animation). `prefers-reduced-motion`
  honored by not needing it.

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
- **Esc policy is one ordered function** — overlay dismiss → composer clear
  (armed) → cancel turn → rewind (armed) — documented order, no fall-through
  surprises.
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
