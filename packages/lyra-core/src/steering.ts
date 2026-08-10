/**
 * Steering and hub asides: text injected into a *running* turn.
 *
 * Two invariants come straight from the TUI design (§0.2):
 *
 * 1. Steering text lands as a **standalone synthetic user turn** — never appended to a
 *    tool result — so compaction, replay, and `/context` attribute it to the user.
 * 2. Steering **aborts interruptible wait-class tools**, and the model is told so in the
 *    tool result rather than being left to guess why the wait returned early.
 *
 * A hub aside (LYRA.md §9, "delivery to a running agent is a non-interrupting aside, folded
 * into its next turn") rides the same queue and lands at the same boundary, with two
 * deliberate differences: it names its sender in the transcript, and it does **not**
 * interrupt a blocked wait. A message from another agent is information; only the user
 * gets to cut a wait short.
 *
 * The queue itself is deliberately inert: it holds entries and notifies waiters. The agent
 * loop owns the drain points (a tool boundary, or the boundary where the turn would
 * otherwise end), which is what makes delivery timing unambiguous.
 */

/** Exact model-facing sentence a steer-interrupted wait reports. */
export const WAIT_INTERRUPT_MESSAGE = "Wait interrupted: the user sent a message.";

/**
 * Tools whose executions block on an external event and are therefore steer-interruptible.
 *
 * `spawn` is on the list because collecting a child is a wait like any other: the observed
 * failure was a parent parked for the whole delegation deadline with no way for the user to
 * say "stop waiting, do it yourself". Interrupting the wait never touches the child — the
 * job keeps running and stays collectable by id.
 */
export const DEFAULT_WAIT_CLASS_TOOLS: readonly string[] = Object.freeze(["hub", "spawn"]);

/** Abort reason used when steering interrupts a wait-class tool. */
export class SteerInterrupt extends Error {
  constructor() {
    super(WAIT_INTERRUPT_MESSAGE);
    this.name = "SteerInterrupt";
  }
}

/** A message from another agent on the bus, folded into this agent's next turn. */
export interface HubAside {
  /** The peer that sent it. Named in the transcript so a reply has an address. */
  from: string;
  text?: string;
  data?: unknown;
  /** The bus message id, so a copy the agent already read through `hub` can be dropped. */
  messageId?: string;
}

/** One queued injection: the user speaking, or another agent speaking. */
export type SteerEntry =
  | { kind: "user"; text: string }
  | ({ kind: "hub" } & HubAside);

/**
 * The exact text a hub aside becomes in the transcript.
 *
 * It is a real user-role message so `/context`, compaction, and replay all attribute it,
 * and it carries a marker naming the sender so the model can tell an aside from the user
 * and knows the address to answer on.
 */
export function renderHubAside(entry: HubAside): string {
  const body = entry.text ?? "";
  const payload = entry.data === undefined ? "" : `\n${safeJson(entry.data)}`;
  return `[hub message from ${entry.from}] ${body}${payload}\n(Reply with hub { op: "send", to: "${entry.from}", message: "..." }. This is another agent speaking, not the user.)`;
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value) ?? String(value); } catch { return "<unserializable payload>"; }
}

export class SteerQueue {
  #pending: SteerEntry[] = [];
  readonly #listeners = new Set<() => void>();

  get size(): number {
    return this.#pending.length;
  }

  /** A read-only view for surfacing "N queued" without consuming the queue. */
  peek(): readonly SteerEntry[] {
    return [...this.#pending];
  }

  /**
   * Enqueues one steering message and interrupts every registered wait immediately, so a
   * turn parked in a blocking tool does not sit on the message until its deadline.
   */
  push(text: string): number {
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new TypeError("Steering text must be a non-empty string.");
    }
    this.#pending.push({ kind: "user", text });
    for (const listener of [...this.#listeners]) listener();
    return this.#pending.length;
  }

  /**
   * Enqueues one hub aside. Deliberately silent: it lands at the next tool boundary and
   * never cuts a wait short, because an agent that is waiting on the bus is *already* the
   * right place for a message to arrive (the bus resolves that wait itself).
   */
  aside(entry: HubAside): number {
    if (!entry || typeof entry.from !== "string" || entry.from.length === 0) {
      throw new TypeError("A hub aside must name the peer it came from.");
    }
    if (entry.text === undefined && entry.data === undefined) {
      throw new TypeError("A hub aside must carry text or data.");
    }
    this.#pending.push({
      kind: "hub",
      from: entry.from,
      ...(entry.text === undefined ? {} : { text: entry.text }),
      ...(entry.data === undefined ? {} : { data: entry.data }),
      ...(entry.messageId === undefined ? {} : { messageId: entry.messageId }),
    });
    return this.#pending.length;
  }

  /**
   * Drop queued asides the agent has since read through `hub` itself.
   *
   * Without this, a message that resolved a peer's own `hub wait` would arrive a second
   * time at the next tool boundary — the same sentence twice, one of them unexplained.
   */
  consume(messageIds: readonly string[]): number {
    if (!Array.isArray(messageIds) || messageIds.length === 0) return 0;
    const ids = new Set(messageIds.filter((id) => typeof id === "string" && id.length > 0));
    if (ids.size === 0) return 0;
    const before = this.#pending.length;
    this.#pending = this.#pending.filter((entry) => entry.kind !== "hub" || entry.messageId === undefined || !ids.has(entry.messageId));
    return before - this.#pending.length;
  }

  /** Removes and returns everything queued. Each entry becomes one synthetic user turn. */
  drain(): SteerEntry[] {
    const drained = this.#pending;
    this.#pending = [];
    return drained;
  }

  /**
   * Registers an interruptible wait. Fires immediately when *user* text is already queued —
   * a wait started after the steer must not swallow it. Hub asides never fire it.
   */
  subscribe(listener: () => void): () => void {
    if (typeof listener !== "function") throw new TypeError("Wait interrupt listener must be a function.");
    this.#listeners.add(listener);
    if (this.#pending.some((entry) => entry.kind === "user")) listener();
    return () => {
      this.#listeners.delete(listener);
    };
  }
}
