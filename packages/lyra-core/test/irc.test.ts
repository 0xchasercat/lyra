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
    bus.subscribe("a", "results");
    bus.subscribe("b", "results");
    const waiting = bus.waitChannel("results", 100);
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
    const empty = await bus.wait("a", 1);
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
    expect(() => bus.subscribe("a", "bad channel")).toThrow(IrcValidationError);
    expect(bus.unregister("b")).toBe(true);
    expect(() => bus.send({ from: "a", to: "b", text: "x" })).not.toThrow();
    expect(bus.inbox("a")).toEqual([]);
  });
});
