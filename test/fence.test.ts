import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { after, before, describe, it } from "node:test";
import { type Browser, chromium } from "playwright";
import { type BlockReason, installNetworkFence } from "../src/safety.ts";

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

  async function submitOrder(readOnly: boolean) {
    const context = await browser.newContext();
    const blocked: [string, BlockReason][] = [];
    await installNetworkFence(context, { allowedHosts: ["127.0.0.1"], readOnly }, (url, reason) =>
      blocked.push([url, reason]),
    );
    const page = await context.newPage();
    await page.goto(`${BASE}/orders/new`);
    await page.getByLabel("Name").fill("Fence test");
    await page.getByRole("button", { name: "Place order" }).click();
    await page.waitForLoadState("domcontentloaded");
    await context.close();
    return blocked;
  }

  const orderCount = async () => ((await (await fetch(`${BASE}/orders`)).text()).match(/Order #/g) ?? []).length;

  it("blocks off-allowlist hosts", async () => {
    const blocked = await submitOrder(false);
    assert.ok(blocked.some(([url, reason]) => url.includes("cdn.example.com") && reason === "off-allowlist"));
  });

  it("in read-only mode, blocks the form POST so it never reaches the server", async () => {
    const before = await orderCount();
    const blocked = await submitOrder(true);
    assert.ok(blocked.some(([url, reason]) => url === `POST ${BASE}/orders` && reason === "write-in-read-only"));
    assert.equal(await orderCount(), before);
  });

  async function openSocket(url: string, readOnly: boolean) {
    const context = await browser.newContext();
    const blocked: [string, BlockReason][] = [];
    await installNetworkFence(context, { allowedHosts: ["127.0.0.1"], readOnly }, (u, reason) =>
      blocked.push([u, reason]),
    );
    const page = await context.newPage();
    await page.goto(`${BASE}/help`);
    await page.evaluate(
      (u) => new Promise((done) => Object.assign(new WebSocket(u), { onclose: done, onerror: done })),
      url,
    );
    await context.close();
    return blocked;
  }

  it("blocks WebSockets to off-allowlist hosts", async () => {
    const blocked = await openSocket("wss://chat.example.com/socket", false);
    assert.ok(blocked.some(([u, reason]) => u === "wss://chat.example.com/socket" && reason === "off-allowlist"));
  });

  it("in read-only mode, blocks WebSockets to the target too", async () => {
    const blocked = await openSocket(`ws://127.0.0.1:${PORT}/socket`, true);
    assert.ok(
      blocked.some(([u, reason]) => u === `WEBSOCKET ws://127.0.0.1:${PORT}/socket` && reason === "write-in-read-only"),
    );
  });

  it("without read-only mode, the same POST goes through (control)", async () => {
    const before = await orderCount();
    await submitOrder(false);
    assert.equal(await orderCount(), before + 1);
  });
});
