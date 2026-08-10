export type IrcPeerState = "running" | "idle" | "parked" | "completed" | "failed";
export interface IrcPeer {
  name: string;
  state: IrcPeerState;
  label?: string;
  createdAt: number;
  revivedAt?: number;
}
export interface IrcMessage<T = unknown> {
  id: string;
  from: string;
  to?: string;
  channel?: string;
  text?: string;
  data?: T;
  createdAt: number;
}
export interface IrcDelivery {
  message: IrcMessage;
  delivered: boolean;
  revived?: boolean;
}

/**
 * A live agent's turn, as the bus sees it.
 *
 * Attached while an agent is actually running (see [`IrcBus.attach`]). `deliver` folds a
 * message into that turn as an aside; `consume` says which messages the agent has since
 * read for itself, so the same sentence never arrives twice.
 */
export interface IrcPeerSink {
  deliver?(message: IrcMessage): void;
  consume?(messageIds: readonly string[]): void;
}
export interface IrcBusOptions { maxWaitMs?: number; now?: () => number; id?: () => string; }
