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
  /**
   * Whether the sender can still be answered. Absent means yes.
   *
   * It rides the message because only the sender knows: a lifecycle notice for a child that
   * failed *at resolution* is unanswerable the moment it is written, and by the time the
   * recipient renders it the peer is already gone from the bus — too late for a lookup, and
   * the announcement itself has to be sent while the name is still registered.
   */
  reply?: boolean;
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
