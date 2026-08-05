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
export interface IrcBusOptions { maxWaitMs?: number; now?: () => number; id?: () => string; }
