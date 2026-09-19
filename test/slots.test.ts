import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FairSlots } from "../src/slots.ts";

describe("FairSlots", () => {
  it("hands out free slots immediately, up to capacity", async () => {
    const slots = new FairSlots(2);
    const a = await slots.acquire("run1");
    const b = await slots.acquire("run1");
    assert.deepEqual([a.index, b.index], [0, 1]);
    assert.equal(slots.inUse, 2);
  });

  it("rotates freed slots between runs instead of serving the longest queue", async () => {
    const slots = new FairSlots(1);
    const first = await slots.acquire("big");
    const order: string[] = [];
    const wait = (key: string) =>
      slots.acquire(key).then((s) => {
        order.push(key);
        s.release();
      });
    // The big run queues three sessions before the small run queues one.
    const pending = [wait("big"), wait("big"), wait("big"), wait("small")];
    first.release();
    await Promise.all(pending);
    assert.deepEqual(order, ["big", "small", "big", "big"]);
  });

  it("reuses the released index and ignores double release", async () => {
    const slots = new FairSlots(2);
    const a = await slots.acquire("r");
    await slots.acquire("r");
    a.release();
    a.release();
    assert.equal(slots.inUse, 1);
    assert.equal((await slots.acquire("r")).index, 0);
  });
});
