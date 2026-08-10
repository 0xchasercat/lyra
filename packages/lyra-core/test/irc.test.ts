import { describe, expect, test } from "bun:test";
import { IrcBus, IrcValidationError } from "../src/irc.ts";

describe("process-global IRC bus", () => {
  test("delivers direct messages, revives parked peers, and awaits revive acknowledgement", async () => {
    const revived: string[] = [];
    const bus = new IrcBus({ id: (() => { let n = 0; return () => `m-${++n}`; })() });
    bus.register("sender");
    bus.register("parked", { state: "parked", onRevive: async (peer) => { revived.push(peer.name); } });
    const delivery = await bus.send({ from: "sender", to: "parked", text: "continue", await: true });
    expect(delivery).toMatchObject({ delivered: true, revived: true, message: { id: "m-1", text: "continue" } });
    expect(revived).toEqual(["parked"]);
    expect(bus.inbox("parked")[0]?.text).toBe("continue");
  });

  test("publishes only to subscribers and supports fan-in channel waits", async () => {
    const bus = new IrcBus({ maxWaitMs: 1000 });
    bus.register("a");
    bus.register("b");
    bus.register("c");
    bus.subscribe({ peer: "a", channel: "results" });
    bus.subscribe({ peer: "b", channel: "results" });
    const waiting = bus.wait({ channel: "results", timeoutMs: 100 });
    const deliveries = bus.publish({ from: "a", channel: "results", data: { ok: true } });
    expect(deliveries).toHaveLength(2);
    expect((await waiting)[0]?.data).toEqual({ ok: true });
    expect(bus.inbox("c")).toEqual([]);
    expect(bus.inbox("b")).toHaveLength(1);
  });

  test("wait returns empty at its deadline and payloads are cloned", async () => {
    const bus = new IrcBus({ maxWaitMs: 25 });
    bus.register("a");
    const started = Date.now();
    const empty = await bus.wait({ peer: "a", timeoutMs: 1 });
    expect(empty).toEqual([]);
    expect(Date.now() - started).toBeLessThan(100);
    const payload = { nested: { value: 1 } };
    bus.register("b");
    bus.send({ from: "a", to: "b", data: payload });
    payload.nested.value = 9;
    expect(bus.inbox("b")[0]?.data).toEqual({ nested: { value: 1 } });
  });

  test("validation rejects unknown senders and invalid channels", () => {
    const bus = new IrcBus();
    bus.register("a");
    bus.register("b");
    expect(() => bus.send({ from: "missing", to: "b", text: "x" })).toThrow(IrcValidationError);
    expect(() => bus.subscribe({ peer: "a", channel: "bad channel" })).toThrow(IrcValidationError);
    expect(bus.unregister("b")).toBe(true);
    expect(() => bus.send({ from: "a", to: "b", text: "x" })).not.toThrow();
    expect(bus.inbox("a")).toEqual([]);
  });
});

describe("revival and asides on the bus", () => {
  test("a declined revival leaves the peer parked and the message readable", () => {
    const bus = new IrcBus();
    bus.register("sender");
    // The handler says no: the child aged out of the spawn manager's retention.
    bus.register("gone", { state: "parked", onRevive: () => false });
    const delivery = bus.send({ from: "sender", to: "gone", text: "carry on" });
    expect(delivery.revived).toBeUndefined();
    expect(bus.getPeer("gone")?.state).toBe("parked");
    // Nothing was lost: it is still readable, which a `revived: true` lie would have hidden.
    expect(bus.inbox("gone").map((message) => message.text)).toEqual(["carry on"]);
  });

  test("a revival that took the message as its prompt does not also queue it", () => {
    const bus = new IrcBus();
    bus.register("sender");
    const seen: string[] = [];
    bus.register("child", { state: "parked", onRevive: (_peer, message) => { seen.push(message.text!); return true; } });
    const delivery = bus.send({ from: "sender", to: "child", text: "the lexer too" });
    expect(delivery).toMatchObject({ delivered: true, revived: true });
    expect(seen).toEqual(["the lexer too"]);
    expect(bus.peekInbox("child")).toEqual([]);
  });

  test("a live peer's running turn is told directly, and a message it read itself is marked consumed", () => {
    const bus = new IrcBus();
    bus.register("sender");
    bus.register("worker");
    const folded: string[] = [];
    const consumed: string[] = [];
    const detach = bus.attach("worker", { deliver: (message) => folded.push(message.text!), consume: (ids) => consumed.push(...ids) });
    const delivery = bus.send({ from: "sender", to: "worker", text: "an aside" });
    expect(folded).toEqual(["an aside"]);
    // It is in the inbox too, so an explicit read still finds it — and that read says so.
    expect(bus.inbox("worker")).toHaveLength(1);
    expect(consumed).toEqual([delivery.message.id]);
    detach();
    bus.send({ from: "sender", to: "worker", text: "after detach" });
    expect(folded).toEqual(["an aside"]);
  });

  test("a message with nothing in it is refused rather than delivered empty", () => {
    const bus = new IrcBus();
    bus.register("a");
    bus.register("b");
    expect(() => bus.send({ from: "a", to: "b" })).toThrow(IrcValidationError);
    expect(() => bus.publish({ from: "a", channel: "results" })).toThrow(IrcValidationError);
  });

  test("an unknown peer error names how peers come to exist", () => {
    const bus = new IrcBus();
    bus.register("main");
    expect(() => bus.send({ from: "ghost", to: "main", text: "x" })).toThrow(/spawn result/);
    expect(() => bus.subscribe({ peer: "ghost", channel: "agents" })).toThrow(/Registered peers: main/);
  });
});
