import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { after, before, describe, it } from "node:test";
import { type Browser, chromium } from "playwright";
import { type BlockReason, installNetworkFence, type Mode } from "../src/safety.ts";

const PORT = 4199;
const BASE = `http://127.0.0.1:${PORT}`;

describe("network fence against the demo app", () => {
  let server: ChildProcess;
  let browser: Browser;

  before(async () => {
    server = spawn("node", ["demo/server.mjs"], { env: { ...process.env, PORT: String(PORT) } });
    await once(server.stdout!, "data");
    browser = await chromium.launch();
  });

  after(async () => {
    await browser.close();
    server.kill();
  });

  type Policy = { mode: Mode; allowedWritePaths?: string[] };
  async function fenced(policy: Policy) {
    const context = await browser.newContext();
    const blocked: [string, BlockReason][] = [];
    const sent: string[] = [];
    await installNetworkFence(
      context,
      { allowedHosts: ["127.0.0.1"], allowedWritePaths: [], ...policy },
      (url, reason) => blocked.push([url, reason]),
      (write) => sent.push(write),
    );
    return { context, blocked, sent };
  }

  async function submitOrder(policy: Policy) {
    const { context, blocked, sent } = await fenced(policy);
    const page = await context.newPage();
    await page.goto(`${BASE}/orders/new`);
    await page.getByLabel("Name").fill("Fence test");
    await page.getByRole("button", { name: "Place order" }).click();
    await page.waitForLoadState("domcontentloaded");
    await context.close();
    return { blocked, sent };
  }

  async function openSocket(url: string, policy: Policy) {
    const { context, blocked } = await fenced(policy);
    const page = await context.newPage();
    await page.goto(`${BASE}/help`);
    await page.evaluate(
      (u) => new Promise((done) => Object.assign(new WebSocket(u), { onclose: done, onerror: done })),
      url,
    );
    await context.close();
    return blocked;
  }

  const orderCount = async () => ((await (await fetch(`${BASE}/orders`)).text()).match(/Order #/g) ?? []).length;

  it("blocks off-allowlist hosts in every mode", async () => {
    const { blocked } = await submitOrder({ mode: "interact" });
    assert.ok(blocked.some(([url, reason]) => url.includes("cdn.example.com") && reason === "off-allowlist"));
    const socket = await openSocket("wss://chat.example.com/socket", { mode: "interact" });
    assert.ok(socket.some(([u, reason]) => u === "wss://chat.example.com/socket" && reason === "off-allowlist"));
  });

  it("observe: blocks the form POST so it never reaches the server", async () => {
    const before = await orderCount();
    const { blocked, sent } = await submitOrder({ mode: "observe" });
    assert.ok(blocked.some(([w, reason]) => w === "POST /orders" && reason === "write-blocked"));
    assert.deepEqual(sent, []);
    assert.equal(await orderCount(), before);
  });

  it("observe: blocks WebSockets to the target too", async () => {
    const blocked = await openSocket(`ws://127.0.0.1:${PORT}/socket`, { mode: "observe" });
    assert.ok(blocked.some(([u, reason]) => u === "WEBSOCKET /socket" && reason === "write-blocked"));
  });

  it("observe-writes: lets only listed paths through, matching exactly unless the path ends in /*", async () => {
    const before = await orderCount();
    const other = await submitOrder({ mode: "observe-writes", allowedWritePaths: ["/orders/new", "/order"] });
    assert.ok(other.blocked.some(([w]) => w === "POST /orders"), "exact match: /order and /orders/new do not allow /orders");
    assert.equal(await orderCount(), before);

    const listed = await submitOrder({ mode: "observe-writes", allowedWritePaths: ["/orders"] });
    assert.deepEqual(listed.sent, ["POST /orders"]);
    assert.equal(await orderCount(), before + 1);
  });

  it("interact: the POST goes through and is reported as sent", async () => {
    const before = await orderCount();
    const { sent } = await submitOrder({ mode: "interact" });
    assert.deepEqual(sent, ["POST /orders"]);
    assert.equal(await orderCount(), before + 1);
  });
});
