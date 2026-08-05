import type {
  IrcBusOptions,
  IrcDelivery,
  IrcMessage,
  IrcPeer,
  IrcPeerState,
} from "./irc-types.ts";

const MAX_WAIT_MS = 600_000;
const MAX_NAME_LENGTH = 128;
const MAX_TEXT_LENGTH = 100_000;

export interface IrcRegisterOptions {
  state?: IrcPeerState;
  label?: string;
  onRevive?: IrcReviveHandler;
  revive?: IrcReviveHandler;
}

export type IrcReviveHandler = (peer: IrcPeer, message: IrcMessage) => void | Promise<void>;

export interface IrcSendRequest<T = unknown> {
  from: string;
  to: string;
  text?: string;
  data?: T;
  await?: boolean;
  awaitAck?: boolean;
}

export interface IrcPublishRequest<T = unknown> {
  from?: string;
  channel: string;
  text?: string;
  data?: T;
  await?: boolean;
  awaitAck?: boolean;
}

export interface IrcWaitRequest {
  peer?: string;
  channel?: string;
  timeoutMs?: number;
}

export interface IrcBusConstructorOptions extends IrcBusOptions {
  onRevive?: IrcReviveHandler;
  revive?: IrcReviveHandler;
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
  timer: ReturnType<typeof setTimeout>;
};
export class IrcBus {
  private readonly peers = new Map<string, IrcPeer>();
  private readonly inboxes = new Map<string, IrcMessage[]>();
  private readonly channels = new Map<string, Set<string>>();
  private readonly channelInboxes = new Map<string, IrcMessage[]>();
  private readonly reviveHandlers = new Map<string, IrcReviveHandler>();
  private readonly reviveAcks = new Map<string, Promise<void>[]>();
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
    this.defaultRevive = options.onRevive ?? options.revive;
    this.makeId = options.id ?? (() => {
      this.sequence += 1;
      return `irc-${this.sequence.toString(36).padStart(8, "0")}`;
    });
  }
  register(name: string, options?: IrcRegisterOptions): IrcPeer;
  register(peer: IrcPeer, options?: IrcRegisterOptions): IrcPeer;
  register(nameOrPeer: string | IrcPeer, options: IrcRegisterOptions = {}): IrcPeer {
    const name = typeof nameOrPeer === "string" ? nameOrPeer : nameOrPeer.name;
    const source = typeof nameOrPeer === "string" ? undefined : nameOrPeer;
    this.assertName(name, "peer name");
    if (this.peers.has(name)) throw new IrcValidationError(`Peer already registered: ${name}`);
    const state = options.state ?? source?.state ?? "running";
    this.assertState(state);
    const peer: IrcPeer = { name, state, createdAt: source?.createdAt ?? this.now() };
    const label = options.label ?? source?.label;
    if (label !== undefined) {
      if (typeof label !== "string" || label.trim() !== label) {
        throw new IrcValidationError("Peer label must be a trimmed string");
      }
      peer.label = label;
    }
    this.peers.set(name, peer);
    this.inboxes.set(name, []);
    const handler = options.onRevive ?? options.revive ?? this.defaultRevive;
    if (handler) this.reviveHandlers.set(name, handler);
    return this.clonePeer(peer);
  }

  setPeerState(name: string, state: IrcPeerState): IrcPeer {
    return this.setState(name, state);
  }

  unregister(name: string): boolean {
    this.assertName(name, "peer name");
    if (!this.peers.delete(name)) return false;
    this.inboxes.delete(name);
    this.reviveHandlers.delete(name);
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
    if (!peer) throw new IrcValidationError(`Unknown peer: ${name}`);
    peer.state = state;
    return this.clonePeer(peer);
  }

  updateState(name: string, state: IrcPeerState): IrcPeer {
    return this.setState(name, state);
  }

  transition(name: string, state: IrcPeerState): IrcPeer {
    return this.setState(name, state);
  }

  getPeer(name: string): IrcPeer | undefined {
    this.assertName(name, "peer name");
    const peer = this.peers.get(name);
    return peer ? this.clonePeer(peer) : undefined;
  }

  list(): IrcPeer[] {
    return [...this.peers.values()].map((peer) => this.clonePeer(peer));
  }

  peersList(): IrcPeer[] {
    return this.list();
  }

  subscribe(peer: string, channel: string): boolean;
  subscribe(request: { peer: string; channel: string }): boolean;
  subscribe(first: string | { peer: string; channel: string }, second?: string): boolean {
    const parsed = typeof first === "string" ? this.parseSubscription(first, second) : first;
    this.assertName(parsed.peer, "peer name");
    this.assertChannel(parsed.channel);
    if (!this.peers.has(parsed.peer)) throw new IrcValidationError(`Unknown peer: ${parsed.peer}`);
    let members = this.channels.get(parsed.channel);
    if (!members) {
      members = new Set();
      this.channels.set(parsed.channel, members);
    }
    const before = members.size;
    members.add(parsed.peer);
    return members.size !== before;
  }

  unsubscribe(peer: string, channel: string): boolean;
  unsubscribe(request: { peer: string; channel: string }): boolean;
  unsubscribe(first: string | { peer: string; channel: string }, second?: string): boolean {
    const parsed = typeof first === "string" ? this.parseSubscription(first, second) : first;
    this.assertName(parsed.peer, "peer name");
    this.assertChannel(parsed.channel);
    const members = this.channels.get(parsed.channel);
    if (!members) return false;
    const removed = members.delete(parsed.peer);
    if (members.size === 0) this.channels.delete(parsed.channel);
    return removed;
  }

  subscribers(channel: string): string[] {
    this.assertChannel(channel);
    return [...(this.channels.get(channel) ?? [])];
  }

  send<T = unknown>(request: IrcSendRequest<T> & { await: true }): Promise<IrcDelivery>;
  send<T = unknown>(request: IrcSendRequest<T>): IrcDelivery;
  send<T = unknown>(from: string, to: string, text?: string, data?: T, options?: { await: true; awaitAck?: boolean }): Promise<IrcDelivery>;
  send<T = unknown>(from: string, to: string, text?: string, data?: T, options?: { await?: boolean; awaitAck?: boolean }): IrcDelivery;
  send<T = unknown>(
    requestOrFrom: IrcSendRequest<T> | string,
    to?: string,
    text?: string,
    data?: T,
    options: { await?: boolean; awaitAck?: boolean } = {},
  ): IrcDelivery | Promise<IrcDelivery> {
    const request: IrcSendRequest<T> = typeof requestOrFrom === "string"
      ? { from: requestOrFrom, to: to as string, ...(text === undefined ? {} : { text }), ...(data === undefined ? {} : { data }), ...(options.await === undefined ? {} : { await: options.await }), ...(options.awaitAck === undefined ? {} : { awaitAck: options.awaitAck }) }
      : requestOrFrom;
    this.assertName(request.from, "sender name");
    this.assertName(request.to, "recipient name");
    this.assertContent(request.text, request.data);
    this.assertRegisteredSender(request.from);
    const message = this.makeMessage({ from: request.from, to: request.to, text: request.text, data: request.data });
    const delivery = this.deliver(message, request.to);
    return request.await || request.awaitAck ? this.awaitDelivery(message.id, delivery) : delivery;
  }

  async sendAsync<T = unknown>(request: IrcSendRequest<T>): Promise<IrcDelivery> {
    return await this.send(request as IrcSendRequest<T> & { await: true });
  }

  publish<T = unknown>(request: IrcPublishRequest<T> & { await: true }): Promise<IrcDelivery[]>;
  publish<T = unknown>(request: IrcPublishRequest<T>): IrcDelivery[];
  publish<T = unknown>(channel: string, data?: T, from?: string, options?: { text?: string; await: true; awaitAck?: boolean }): Promise<IrcDelivery[]>;
  publish<T = unknown>(channel: string, data?: T, from?: string, options?: { text?: string; await?: boolean; awaitAck?: boolean }): IrcDelivery[];
  publish<T = unknown>(
    requestOrChannel: IrcPublishRequest<T> | string,
    data?: T,
    from?: string,
    options: { text?: string; await?: boolean; awaitAck?: boolean } = {},
  ): IrcDelivery[] | Promise<IrcDelivery[]> {
    const request: IrcPublishRequest<T> = typeof requestOrChannel === "string"
      ? { channel: requestOrChannel, ...(data === undefined ? {} : { data }), ...(from === undefined ? {} : { from }), ...(options.text === undefined ? {} : { text: options.text }), ...(options.await === undefined ? {} : { await: options.await }), ...(options.awaitAck === undefined ? {} : { awaitAck: options.awaitAck }) }
      : requestOrChannel;
    this.assertChannel(request.channel);
    if (request.from !== undefined) {
      this.assertName(request.from, "sender name");
      this.assertRegisteredSender(request.from);
    }
    this.assertContent(request.text, request.data);
    const message = this.makeMessage({ from: request.from ?? "system", channel: request.channel, text: request.text, data: request.data });
    const recipients = [...(this.channels.get(request.channel) ?? [])];
    const output = recipients.map((peer) => this.deliver(message, peer));
    this.enqueueChannel(message);
    this.notify("channel", request.channel);
    const result = output.map((delivery) => this.cloneDelivery(delivery));
    return request.await || request.awaitAck ? this.awaitDeliveries(message.id, result) : result;
  }

  /** Drain a peer's non-interrupting inbox. */
  inbox(peer: string): IrcMessage[];
  inbox(): Record<string, IrcMessage[]>;
  inbox(peer?: string): IrcMessage[] | Record<string, IrcMessage[]> {
    if (peer !== undefined) {
      this.assertName(peer, "peer name");
      const queue = this.inboxes.get(peer);
      if (!queue) return [];
      this.inboxes.set(peer, []);
      return queue.map((message) => this.cloneMessage(message));
    }
    const result: Record<string, IrcMessage[]> = {};
    for (const name of this.peers.keys()) result[name] = this.inbox(name) as IrcMessage[];
    return result;
  }

  peekInbox(peer: string): IrcMessage[] {
    this.assertName(peer, "peer name");
    return (this.inboxes.get(peer) ?? []).map((message) => this.cloneMessage(message));
  }

  wait(request: IrcWaitRequest): Promise<IrcMessage[]>;
  wait(peer: string, timeoutMs?: number): Promise<IrcMessage[]>;
  wait(peerOrRequest: string | IrcWaitRequest, timeoutMs?: number): Promise<IrcMessage[]> {
    const request: IrcWaitRequest = typeof peerOrRequest === "string"
      ? { peer: peerOrRequest, ...(timeoutMs === undefined ? {} : { timeoutMs }) }
      : peerOrRequest;
    const selected = request.peer !== undefined ? { kind: "peer" as const, target: request.peer } :
      request.channel !== undefined ? { kind: "channel" as const, target: request.channel } : undefined;
    if (!selected) throw new IrcValidationError("Wait requires a peer or channel");
    if (selected.kind === "peer") this.assertName(selected.target, "peer name");
    else this.assertChannel(selected.target);
    const existing = selected.kind === "peer" ? this.drainPeer(selected.target) : this.drainChannel(selected.target);
    if (existing.length) return Promise.resolve(existing);
    const timeout = this.waitDuration(request.timeoutMs);
    if (timeout <= 0 || (selected.kind === "peer" && !this.peers.has(selected.target))) return Promise.resolve([]);
    return new Promise<IrcMessage[]>((resolve) => {
      const pending: PendingWait = { ...selected, resolve, timer: setTimeout(() => this.finishWait(pending, []), timeout) };
      this.waits.add(pending);
    });
  }

  waitPeer(peer: string, timeoutMs?: number): Promise<IrcMessage[]> {
    return timeoutMs === undefined ? this.wait({ peer }) : this.wait({ peer, timeoutMs });
  }

  waitChannel(channel: string, timeoutMs?: number): Promise<IrcMessage[]> {
    return timeoutMs === undefined ? this.wait({ channel }) : this.wait({ channel, timeoutMs });
  }

  getDeliveries(): IrcDelivery[] {
    return this.deliveries.map((delivery) => this.cloneDelivery(delivery));
  }

  get deliveryLog(): IrcDelivery[] {
    return this.getDeliveries();
  }

  clearDeliveries(): void {
    this.deliveries.length = 0;
  }

  close(): void {
    this.closed = true;
    for (const wait of [...this.waits]) this.finishWait(wait, []);
    this.peers.clear();
    this.inboxes.clear();
    this.channels.clear();
    this.channelInboxes.clear();
    this.reviveHandlers.clear();
  }

  private deliver(message: IrcMessage, recipient: string): IrcDelivery {
    const peer = this.peers.get(recipient);
    const delivery: IrcDelivery = { message: this.cloneMessage(message), delivered: false };
    if (!peer || peer.state === "completed" || peer.state === "failed" || this.closed) {
      this.deliveries.push(this.cloneDelivery(delivery));
      return delivery;
    }
    if (peer.state === "parked") {
      peer.state = "running";
      peer.revivedAt = this.now();
      delivery.revived = true;
      const revive = this.reviveHandlers.get(recipient);
      if (revive) {
        try {
          const ack = Promise.resolve(revive(this.clonePeer(peer), this.cloneMessage(message))).catch(() => undefined);
          const pending = this.reviveAcks.get(message.id) ?? [];
          pending.push(ack);
          this.reviveAcks.set(message.id, pending);
        } catch { /* delivery remains actionable */ }
      }
    }
    const queue = this.inboxes.get(recipient);
    if (queue) queue.push(this.cloneMessage(message));
    delivery.delivered = Boolean(queue);
    this.deliveries.push(this.cloneDelivery(delivery));
    this.notify("peer", recipient);
    return delivery;
  }
  get logs(): IrcDelivery[] {
    return this.getDeliveries();
  }

  getPeers(): IrcPeer[] {
    return this.list();
  }

  getInbox(peer: string): IrcMessage[] {
    return this.inbox(peer) as IrcMessage[];
  }

  private awaitDelivery(id: string, delivery: IrcDelivery): Promise<IrcDelivery> {
    return Promise.all(this.reviveAcks.get(id) ?? []).then(() => {
      this.reviveAcks.delete(id);
      return this.cloneDelivery(delivery);
    });
  }

  private awaitDeliveries(id: string, deliveries: IrcDelivery[]): Promise<IrcDelivery[]> {
    return Promise.all(this.reviveAcks.get(id) ?? []).then(() => {
      this.reviveAcks.delete(id);
      return deliveries.map((delivery) => this.cloneDelivery(delivery));
    });
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
    return queue.map((message) => this.cloneMessage(message));
  }

  private drainChannel(channel: string): IrcMessage[] {
    const queue = this.channelInboxes.get(channel) ?? [];
    this.channelInboxes.set(channel, []);
    return queue.map((message) => this.cloneMessage(message));
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
    wait.resolve(messages.map((message) => this.cloneMessage(message)));
  }

  private parseSubscription(first: string, second?: string): { peer: string; channel: string } {
    if (second === undefined) throw new IrcValidationError("Subscription requires a peer and channel");
    // Support both subscribe(peer, channel) and subscribe(channel, peer); the
    // existing registered name disambiguates the ergonomic channel-first form.
    if (this.peers.has(first)) return { peer: first, channel: second };
    if (this.peers.has(second)) return { peer: second, channel: first };
    return { peer: first, channel: second };
  }

  private assertRegisteredSender(name: string): void {
    if (!this.peers.has(name)) throw new IrcValidationError(`Unknown sender peer: ${name}`);
  }

  private assertName(value: unknown, label: string): asserts value is string {
    if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f\s]/u.test(value)) {
      throw new IrcValidationError(`Invalid ${label}`);
    }
  }

  private assertChannel(value: unknown): asserts value is string {
    if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f\s]/u.test(value)) {
      throw new IrcValidationError("Invalid channel");
    }
  }

  private assertContent(text: unknown, data: unknown): void {
    if (text !== undefined && (typeof text !== "string" || text.length === 0 || text.length > MAX_TEXT_LENGTH)) {
      throw new IrcValidationError("Invalid message text");
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
