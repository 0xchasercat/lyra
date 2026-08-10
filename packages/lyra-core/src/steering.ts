/**
 * Steering: a user message injected into a *running* turn.
 *
 * Two invariants come straight from the TUI design (§0.2):
 *
 * 1. Steering text lands as a **standalone synthetic user turn** — never appended to a
 *    tool result — so compaction, replay, and `/context` attribute it to the user.
 * 2. Steering **aborts interruptible wait-class tools**, and the model is told so in the
 *    tool result rather than being left to guess why the wait returned early.
 *
 * The queue itself is deliberately inert: it holds text and notifies waiters. The agent
 * loop owns the drain points (a tool boundary, or the boundary where the turn would
 * otherwise end), which is what makes delivery timing unambiguous.
 */

/** Exact model-facing sentence a steer-interrupted wait reports. */
export const WAIT_INTERRUPT_MESSAGE = "Wait interrupted: the user sent a message.";

/** Tools whose executions block on an external event and are therefore steer-interruptible. */
export const DEFAULT_WAIT_CLASS_TOOLS: readonly string[] = Object.freeze(["hub"]);

/** Abort reason used when steering interrupts a wait-class tool. */
export class SteerInterrupt extends Error {
  constructor() {
    super(WAIT_INTERRUPT_MESSAGE);
    this.name = "SteerInterrupt";
  }
}

export class SteerQueue {
  #pending: string[] = [];
  readonly #listeners = new Set<() => void>();

  get size(): number {
    return this.#pending.length;
  }

  /** A read-only view for surfacing "N queued" without consuming the queue. */
  peek(): readonly string[] {
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
    this.#pending.push(text);
    for (const listener of [...this.#listeners]) listener();
    return this.#pending.length;
  }

  /** Removes and returns everything queued. Each entry becomes one synthetic user turn. */
  drain(): string[] {
    const drained = this.#pending;
    this.#pending = [];
    return drained;
  }

  /**
   * Registers an interruptible wait. Fires immediately when text is already queued — a
   * wait started after the steer must not swallow it.
   */
  subscribe(listener: () => void): () => void {
    if (typeof listener !== "function") throw new TypeError("Wait interrupt listener must be a function.");
    this.#listeners.add(listener);
    if (this.#pending.length > 0) listener();
    return () => {
      this.#listeners.delete(listener);
    };
  }
}
