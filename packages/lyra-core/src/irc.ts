import type {
  IrcBusOptions,
  IrcDelivery,
  IrcMessage,
  IrcPeer,
  IrcPeerSink,
  IrcPeerState,
} from "./irc-types.ts";

const MAX_WAIT_MS = 600_000;
const MAX_NAME_LENGTH = 128;
const MAX_TEXT_LENGTH = 100_000;

export interface IrcRegisterOptions {
  state?: IrcPeerState;
  label?: string;
  /** Called when a message wakes this peer from `parked`. The only resume primitive (§9). */
  onRevive?: IrcReviveHandler;
}

/**
 * What a parked peer does when a message wakes it.
 *
 * Returning `true` — synchronously — means the handler took the message *as* the agent's
 * next instruction, so the bus does not also leave a copy in its inbox. That is the revival
 * case: an agent restarted with "fix the failing test" should not then read "fix the failing
 * test" out of its own mailbox and wonder whether it is a second request. Anything else
 * (including a promise) leaves the message queued, because a handler that might not have
 * acted on it must not be able to lose it.
 */
export type IrcReviveHandler = (peer: IrcPeer, message: IrcMessage) => boolean | void | Promise<boolean | void>;

export interface IrcSendRequest<T = unknown> {
  from: string;
  to: string;
  text?: string;
  data?: T;
  /** Wait for a revived recipient to acknowledge before the send resolves. */
  await?: boolean;
}

export interface IrcPublishRequest<T = unknown> {
  from?: string;
  channel: string;
  text?: string;
  data?: T;
  await?: boolean;
}

export interface IrcWaitRequest {
  peer?: string;
  channel?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface IrcSubscription {
  peer: string;
  channel: string;
}

export interface IrcBusConstructorOptions extends IrcBusOptions {
  onRevive?: IrcReviveHandler;
}

export class IrcValidationError extends TypeError {
  readonly code = "IRC_INVALID_INPUT";
  constructor(message: string) {
    super(message);
    this.name = "IrcValidationError";
  }
}

type PendingWait = {
  kind: "peer" | "channel";
  target: string;
  resolve: (messages: IrcMessage[]) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
};

/**
 * The process-global mailbox bus (LYRA.md §9).
 *
 * Every method here is called by something. There used to be roughly forty percent more
 * surface than that — `setPeerState`/`updateState`/`transition` for one setter, `list`/
 * `peersList`/`getPeers` for one reader, positional overloads beside every request object,
 * and a `parseSubscription` that *guessed* whether it had been handed `(peer, channel)` or
 * `(channel, peer)` by checking which one happened to be registered. Guessing produced a
 * silently wrong subscription whenever neither name was known yet, which is exactly when a
 * child is being wired up. The class now says what it does: one spelling per operation, and
 * arguments in a declared order.
 */
export class IrcBus {
  private readonly peers = new Map<string, IrcPeer>();
  private readonly inboxes = new Map<string, IrcMessage[]>();
  private readonly channels = new Map<string, Set<string>>();
  private readonly channelInboxes = new Map<string, IrcMessage[]>();
  private readonly reviveHandlers = new Map<string, IrcReviveHandler>();
  private readonly sinks = new Map<string, IrcPeerSink>();
  private readonly deliveries: IrcDelivery[] = [];
  private readonly waits = new Set<PendingWait>();
  private readonly now: () => number;
  private readonly makeId: () => string;
  private readonly defaultRevive: IrcReviveHandler | undefined;
  private readonly configuredMaxWaitMs: number;
  private sequence = 0;
  private closed = false;

  constructor(options: IrcBusConstructorOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.configuredMaxWaitMs = this.normalizeMaxWait(options.maxWaitMs);
    this.defaultRevive = options.onRevive;
    this.makeId = options.id ?? (() => {
      this.sequence += 1;
      return `irc-${this.sequence.toString(36).padStart(8, "0")}`;
    });
  }

  register(name: string, options: IrcRegisterOptions = {}): IrcPeer {
    this.assertName(name, "peer name");
    if (this.peers.has(name)) throw new IrcValidationError(`Peer already registered: ${name}`);
    const state = options.state ?? "running";
    this.assertState(state);
    const peer: IrcPeer = { name, state, createdAt: this.now() };
    const label = options.label;
    if (label !== undefined) {
      if (typeof label !== "string" || label.trim() !== label) {
        throw new IrcValidationError("Peer label must be a trimmed string");
      }
      peer.label = label;
    }
    this.peers.set(name, peer);
    this.inboxes.set(name, []);
    const handler = options.onRevive ?? this.defaultRevive;
    if (handler) this.reviveHandlers.set(name, handler);
    return this.clonePeer(peer);
  }

  unregister(name: string): boolean {
    this.assertName(name, "peer name");
    if (!this.peers.delete(name)) return false;
    this.inboxes.delete(name);
    this.reviveHandlers.delete(name);
    this.sinks.delete(name);
    for (const [channel, members] of this.channels) {
      members.delete(name);
      if (members.size === 0) this.channels.delete(channel);
    }
    for (const wait of [...this.waits]) {
      if (wait.kind === "peer" && wait.target === name) this.finishWait(wait, []);
    }
    return true;
  }

  setState(name: string, state: IrcPeerState): IrcPeer {
    this.assertName(name, "peer name");
    this.assertState(state);
    const peer = this.peers.get(name);
    if (!peer) throw new IrcValidationError(this.unknownPeer(name));
    peer.state = state;
    return this.clonePeer(peer);
  }

  getPeer(name: string): IrcPeer | undefined {
    this.assertName(name, "peer name");
    const peer = this.peers.get(name);
    return peer ? this.clonePeer(peer) : undefined;
  }

  list(): IrcPeer[] {
    return [...this.peers.values()].map((peer) => this.clonePeer(peer));
  }

  /**
   * Attach a live agent's turn to its mailbox.
   *
   * `deliver` is what makes a message to a *running* agent an aside folded into its next
   * turn rather than an item in a queue it has to remember to read; `consume` is what stops
   * a message the agent already read through `hub` from arriving a second time as one. The
   * returned function detaches, and a peer with nothing attached simply queues as before.
   */
  attach(peer: string, sink: IrcPeerSink): () => void {
    this.assertName(peer, "peer name");
    if (!sink || typeof sink !== "object") throw new IrcValidationError("A peer sink must be an object with deliver and/or consume");
    this.sinks.set(peer, sink);
    return () => { if (this.sinks.get(peer) === sink) this.sinks.delete(peer); };
  }

  subscribe(subscription: IrcSubscription): boolean {
    const { peer, channel } = this.assertSubscription(subscription);
    if (!this.peers.has(peer)) throw new IrcValidationError(this.unknownPeer(peer));
    let members = this.channels.get(channel);
    if (!members) {
      members = new Set();
      this.channels.set(channel, members);
    }
    const before = members.size;
    members.add(peer);
    return members.size !== before;
  }

  unsubscribe(subscription: IrcSubscription): boolean {
    const { peer, channel } = this.assertSubscription(subscription);
    const members = this.channels.get(channel);
    if (!members) return false;
    const removed = members.delete(peer);
    if (members.size === 0) this.channels.delete(channel);
    return removed;
  }

  subscribers(channel: string): string[] {
    this.assertChannel(channel);
    return [...(this.channels.get(channel) ?? [])];
  }

  send<T = unknown>(request: IrcSendRequest<T> & { await: true }): Promise<IrcDelivery>;
  send<T = unknown>(request: IrcSendRequest<T>): IrcDelivery;
  send<T = unknown>(request: IrcSendRequest<T>): IrcDelivery | Promise<IrcDelivery> {
    this.assertName(request?.from, "sender name");
    this.assertName(request.to, "recipient name");
    this.assertContent(request.text, request.data);
    this.assertRegisteredSender(request.from);
    const message = this.makeMessage({ from: request.from, to: request.to, text: request.text, data: request.data });
    const acks: Promise<void>[] = [];
    const delivery = this.deliver(message, request.to, acks);
    return request.await === true ? Promise.all(acks).then(() => this.cloneDelivery(delivery)) : delivery;
  }

  publish<T = unknown>(request: IrcPublishRequest<T> & { await: true }): Promise<IrcDelivery[]>;
  publish<T = unknown>(request: IrcPublishRequest<T>): IrcDelivery[];
  publish<T = unknown>(request: IrcPublishRequest<T>): IrcDelivery[] | Promise<IrcDelivery[]> {
    this.assertChannel(request?.channel);
    if (request.from !== undefined) {
      this.assertName(request.from, "sender name");
      this.assertRegisteredSender(request.from);
    }
    this.assertContent(request.text, request.data);
    const message = this.makeMessage({ from: request.from ?? "system", channel: request.channel, text: request.text, data: request.data });
    const recipients = [...(this.channels.get(request.channel) ?? [])];
    const acks: Promise<void>[] = [];
    const output = recipients.map((peer) => this.deliver(message, peer, acks));
    this.enqueueChannel(message);
    this.notify("channel", request.channel);
    const result = output.map((delivery) => this.cloneDelivery(delivery));
    return request.await === true ? Promise.all(acks).then(() => result.map((delivery) => this.cloneDelivery(delivery))) : result;
  }

  /** Drain a peer's non-interrupting inbox. */
  inbox(peer: string): IrcMessage[] {
    this.assertName(peer, "peer name");
    const queue = this.inboxes.get(peer);
    if (!queue) return [];
    this.inboxes.set(peer, []);
    const drained = queue.map((message) => this.cloneMessage(message));
    this.reportConsumed(peer, drained);
    return drained;
  }

  /** Look without draining, for a client rendering "N waiting". */
  peekInbox(peer: string): IrcMessage[] {
    this.assertName(peer, "peer name");
    return (this.inboxes.get(peer) ?? []).map((message) => this.cloneMessage(message));
  }

  wait(request: IrcWaitRequest): Promise<IrcMessage[]> {
    const selected = request?.peer !== undefined ? { kind: "peer" as const, target: request.peer } :
      request?.channel !== undefined ? { kind: "channel" as const, target: request.channel } : undefined;
    if (!selected) throw new IrcValidationError("Wait requires a peer or channel");
    if (selected.kind === "peer") this.assertName(selected.target, "peer name");
    else this.assertChannel(selected.target);
    const existing = selected.kind === "peer" ? this.drainPeer(selected.target) : this.drainChannel(selected.target);
    if (existing.length) return Promise.resolve(existing);
    if (request.signal?.aborted) return Promise.reject(request.signal.reason);
    const timeout = this.waitDuration(request.timeoutMs);
    if (timeout <= 0 || (selected.kind === "peer" && !this.peers.has(selected.target))) return Promise.resolve([]);
    const { promise, resolve, reject } = Promise.withResolvers<IrcMessage[]>();
    const pending: PendingWait = { ...selected, resolve, reject, timer: setTimeout(() => this.finishWait(pending, []), timeout), ...(request.signal === undefined ? {} : { signal: request.signal }) };
    pending.onAbort = (): void => { if (!this.waits.delete(pending)) return; clearTimeout(pending.timer); pending.signal?.removeEventListener("abort", pending.onAbort!); pending.reject(pending.signal?.reason); };
    this.waits.add(pending);
    if (request.signal?.aborted) pending.onAbort(); else request.signal?.addEventListener("abort", pending.onAbort, { once: true });
    return promise;
  }

  /** The delivery log, for tests and audit surfaces. */
  getDeliveries(): IrcDelivery[] {
    return this.deliveries.map((delivery) => this.cloneDelivery(delivery));
  }

  close(): void {
    this.closed = true;
    for (const wait of [...this.waits]) this.finishWait(wait, []);
    this.peers.clear();
    this.inboxes.clear();
    this.channels.clear();
    this.channelInboxes.clear();
    this.reviveHandlers.clear();
    this.sinks.clear();
  }

  /**
   * Hand one message to one peer. `acks` collects the revive acknowledgements a caller that
   * asked to `await` will wait on — held by the caller rather than in a map keyed by message
   * id, because only the caller knows when it is done with them and a map nobody drains is
   * a leak that grows with every revival.
   */
  private deliver(message: IrcMessage, recipient: string, acks: Promise<void>[]): IrcDelivery {
    const peer = this.peers.get(recipient);
    const delivery: IrcDelivery = { message: this.cloneMessage(message), delivered: false };
    if (!peer || peer.state === "completed" || peer.state === "failed" || this.closed) {
      this.deliveries.push(this.cloneDelivery(delivery));
      return delivery;
    }
    let consumedByRevival = false;
    if (peer.state === "parked") {
      // The handler decides, and only then is the peer's state changed. Marking it running
      // first meant a *declined* revival — a child that has aged out of retention — left a
      // dead agent reported as running forever, holding a message nobody would ever drain,
      // while the sender was told `revived: true`.
      const revive = this.reviveHandlers.get(recipient);
      let outcome: boolean | void | Promise<boolean | void> = undefined;
      let revived = revive === undefined;
      if (revive !== undefined) {
        try {
          outcome = revive(this.clonePeer({ ...peer, state: "running", revivedAt: this.now() }), this.cloneMessage(message));
          // A promise cannot be judged here, so it is trusted: an asynchronous handler that
          // was asked to revive is treated as having accepted, and the message is still
          // queued because only a synchronous `true` proves it became the next prompt.
          revived = outcome !== false;
          consumedByRevival = outcome === true;
        } catch { revived = false; }
      }
      if (revived) {
        peer.state = "running";
        peer.revivedAt = this.now();
        delivery.revived = true;
        if (outcome !== undefined && typeof outcome === "object") acks.push(Promise.resolve(outcome).then(() => undefined, () => undefined));
      }
    } else {
      // A live peer is told now, so the message lands as an aside in its running turn rather
      // than sitting in a queue nobody drains. It stays in the inbox too: `hub inbox` is
      // still the explicit read, and `consume` is what stops it arriving twice.
      const sink = this.sinks.get(recipient);
      if (sink?.deliver) {
        try { sink.deliver(this.cloneMessage(message)); } catch { /* an aside that cannot be folded is still in the inbox */ }
      }
    }
    const queue = this.inboxes.get(recipient);
    if (queue && !consumedByRevival) queue.push(this.cloneMessage(message));
    delivery.delivered = Boolean(queue);
    this.deliveries.push(this.cloneDelivery(delivery));
    if (!consumedByRevival) this.notify("peer", recipient);
    return delivery;
  }

  private makeMessage<T>(parts: { from: string; to?: string | undefined; channel?: string | undefined; text?: string | undefined; data?: T | undefined }): IrcMessage<T> {
    const message: IrcMessage<T> = {
      id: this.makeId(), from: parts.from, createdAt: this.now(),
    };
    if (parts.to !== undefined) message.to = parts.to;
    if (parts.channel !== undefined) message.channel = parts.channel;
    if (parts.text !== undefined) message.text = parts.text;
    if (parts.data !== undefined) message.data = this.cloneData(parts.data);
    return message;
  }

  private enqueueChannel(message: IrcMessage): void {
    let queue = this.channelInboxes.get(message.channel as string);
    if (!queue) { queue = []; this.channelInboxes.set(message.channel as string, queue); }
    queue.push(this.cloneMessage(message));
  }

  private drainPeer(peer: string): IrcMessage[] {
    const queue = this.inboxes.get(peer);
    if (!queue) return [];
    this.inboxes.set(peer, []);
    const drained = queue.map((message) => this.cloneMessage(message));
    this.reportConsumed(peer, drained);
    return drained;
  }

  private drainChannel(channel: string): IrcMessage[] {
    const queue = this.channelInboxes.get(channel) ?? [];
    this.channelInboxes.set(channel, []);
    return queue.map((message) => this.cloneMessage(message));
  }

  /** Tell an attached turn which messages it has now read for itself. */
  private reportConsumed(peer: string, messages: readonly IrcMessage[]): void {
    if (messages.length === 0) return;
    const sink = this.sinks.get(peer);
    if (!sink?.consume) return;
    try { sink.consume(messages.map((message) => message.id)); } catch { /* bookkeeping never fails a read */ }
  }

  private notify(kind: "peer" | "channel", target: string): void {
    for (const wait of [...this.waits]) {
      if (wait.kind !== kind || wait.target !== target) continue;
      const messages = kind === "peer" ? this.drainPeer(target) : this.drainChannel(target);
      if (messages.length) this.finishWait(wait, messages);
    }
  }

  private finishWait(wait: PendingWait, messages: IrcMessage[]): void {
    if (!this.waits.delete(wait)) return;
    clearTimeout(wait.timer);
    if (wait.signal && wait.onAbort) wait.signal.removeEventListener("abort", wait.onAbort);
    wait.resolve(messages.map((message) => this.cloneMessage(message)));
  }

  private assertSubscription(subscription: unknown): IrcSubscription {
    if (!subscription || typeof subscription !== "object") throw new IrcValidationError("A subscription is { peer, channel }");
    const { peer, channel } = subscription as Partial<IrcSubscription>;
    this.assertName(peer, "peer name");
    this.assertChannel(channel);
    return { peer, channel };
  }

  private assertRegisteredSender(name: string): void {
    if (!this.peers.has(name)) throw new IrcValidationError(this.unknownPeer(name, "sender"));
  }

  /**
   * Why a name is not on the bus, and what puts it there.
   *
   * The old message was `Unknown sender peer: root`, which named neither how peers come to
   * exist nor which ones do. Registration is never something a model does by hand: the main
   * session registers itself at boot and every child registers at `spawn`, so an unknown
   * name is nearly always a typo or a child that has already been pruned.
   */
  private unknownPeer(name: string, role = "peer"): string {
    const known = [...this.peers.keys()];
    return `No ${role} named ${JSON.stringify(name)} is on the bus. ` +
      (known.length === 0 ? "No peer is registered." : `Registered peers: ${known.join(", ")}.`) +
      ` Peers are not created by hand: the main session registers itself, and each child registers under the "peer" name its spawn result reports. Use that name, or spawn the agent you meant to talk to.`;
  }

  private assertName(value: unknown, label: string): asserts value is string {
    if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f\s]/u.test(value)) {
      throw new IrcValidationError(`Invalid ${label}: a peer name is a single word without spaces, such as the "peer" a spawn result reports.`);
    }
  }

  private assertChannel(value: unknown): asserts value is string {
    if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f\s]/u.test(value)) {
      throw new IrcValidationError("Invalid channel: a channel is a single word without spaces, such as \"agents\".");
    }
  }

  private assertContent(text: unknown, data: unknown): void {
    if (text !== undefined && (typeof text !== "string" || text.length === 0 || text.length > MAX_TEXT_LENGTH)) {
      throw new IrcValidationError("Invalid message text");
    }
    // Refused rather than delivered empty: an empty message is reported as delivered, folds
    // into nothing at the recipient, and tells whoever sent it exactly as much as not
    // sending would have.
    if (text === undefined && data === undefined) {
      throw new IrcValidationError("A message needs text or data; an empty one carries nothing to act on.");
    }
    if (data !== undefined) this.cloneData(data);
  }

  private cloneData<T>(data: T): T {
    try { return structuredClone(data); } catch (error) {
      throw new IrcValidationError(`Message data is not cloneable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private cloneMessage<T>(message: IrcMessage<T>): IrcMessage<T> {
    return this.cloneData(message);
  }

  private cloneDelivery(delivery: IrcDelivery): IrcDelivery {
    return this.cloneData(delivery);
  }

  private clonePeer(peer: IrcPeer): IrcPeer {
    return { ...peer };
  }

  private assertState(state: unknown): asserts state is IrcPeerState {
    if (state !== "running" && state !== "idle" && state !== "parked" && state !== "completed" && state !== "failed") {
      throw new IrcValidationError("Invalid peer state");
    }
  }

  private waitDuration(requested: number | undefined): number {
    if (requested !== undefined && (typeof requested !== "number" || !Number.isFinite(requested) || requested < 0)) {
      throw new IrcValidationError("Invalid wait timeout");
    }
    return Math.min(MAX_WAIT_MS, this.configuredMaxWaitMs, requested ?? this.configuredMaxWaitMs);
  }

  private normalizeMaxWait(value: number | undefined): number {
    if (value === undefined) return MAX_WAIT_MS;
    if (!Number.isFinite(value) || value < 0) throw new IrcValidationError("Invalid max wait timeout");
    return value;
  }
}

export const IRC_MAX_WAIT_MS = MAX_WAIT_MS;
