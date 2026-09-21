import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { type Browser, chromium, type Page } from "playwright";
import { candidateActions } from "../src/actions.ts";
import { resolveConfig } from "../src/config.ts";
import { runSession } from "../src/session.ts";
import { Settler } from "../src/settle.ts";

const PORT = 4195;
const BASE = `http://127.0.0.1:${PORT}`;
const QUIET = { quietMs: 300, timeoutMs: 6_000 };

describe("waiting for slow responses", () => {
  let demo: ChildProcess;
  let browser: Browser;

  before(async () => {
    demo = spawn("node", ["demo/server.mjs"], { env: { ...process.env, PORT: String(PORT) } });
    await once(demo.stdout!, "data");
    browser = await chromium.launch();
  });
  after(async () => {
    await browser.close();
    demo.kill();
  });

  /** The demo assistant, with a settler watching it. */
  const open = async (): Promise<{ page: Page; settler: Settler }> => {
    const context = await browser.newContext();
    await Settler.install(context);
    const page = await context.newPage();
    const settler = new Settler(page);
    await page.goto(`${BASE}/assistant`);
    await settler.wait(page, QUIET);
    return { page, settler };
  };
  const ask = async (page: Page, settler: Settler, q: string) => {
    await page.getByLabel("Message").fill(q);
    await settler.markAction();
    await page.getByRole("button", { name: "Send" }).click();
  };

  it("waits out an AI-style answer that thinks, then streams for longer than the old 6 s cap", async () => {
    const { page, settler } = await open();
    await ask(page, settler, "shipping times");
    const r = await settler.wait(page, { ...QUIET, maxWaitMs: 30_000 });
    assert.equal(r.settled, true, JSON.stringify(r));
    assert.ok(r.waitedMs > 6_000, `waited ${r.waitedMs} ms`);
    assert.match(await page.locator("#log").innerText(), /Answer complete/);
    await page.context().close();
  });

  it("without the long wait (a hasty persona), stops early and says what is still pending", async () => {
    const { page, settler } = await open();
    await ask(page, settler, "shipping times");
    const r = await settler.wait(page, { quietMs: 150, timeoutMs: 1_500 });
    assert.equal(r.settled, false);
    assert.match(r.pending ?? "", /\/api\/assistant|Thinking/);
    assert.doesNotMatch(await page.locator("#log").innerText(), /Answer complete/);
    await page.context().close();
  });

  it("gives up at the max wait on an answer that never comes, naming what hung", async () => {
    const { page, settler } = await open();
    await ask(page, settler, "");
    const r = await settler.wait(page, { ...QUIET, maxWaitMs: 8_000 });
    assert.equal(r.settled, false);
    assert.ok(r.waitedMs >= 7_500 && r.waitedMs < 11_000, `waited ${r.waitedMs} ms`);
    assert.match(r.pending ?? "", /Thinking|\/api\/assistant/);
    await page.context().close();
  });

  it("does not wait on a long request that was already open before the action", async () => {
    const { page, settler } = await open();
    await page.evaluate(() => void fetch("/api/assistant?q=").catch(() => {}));
    await settler.markAction();
    const r = await settler.wait(page, { ...QUIET, maxWaitMs: 30_000 });
    assert.ok(r.waitedMs < 8_000, `waited ${r.waitedMs} ms for a background request`);
    assert.equal(r.pending, undefined);
    await page.context().close();
  });

  it("lets a request the action started lapse after 5 s when the page shows no progress (a long-poll)", async () => {
    const { page, settler } = await open();
    await page.evaluate(() => {
      const b = document.createElement("button");
      b.textContent = "Poll";
      b.onclick = () => void fetch("/api/assistant?q=").catch(() => {});
      document.body.append(b);
    });
    await settler.wait(page, QUIET);
    await settler.markAction();
    await page.getByRole("button", { name: "Poll" }).click();
    const r = await settler.wait(page, { ...QUIET, maxWaitMs: 30_000 });
    assert.ok(r.waitedMs < 8_000, `waited ${r.waitedMs} ms for a silent long-poll`);
    await page.context().close();
  });

  it("reports a response that outlasts the max wait as a slow-response finding in a session", async () => {
    const cfg = resolveConfig({
      startUrl: `${BASE}/assistant`,
      useModel: false,
      steps: 2,
      personas: ["completionist"],
      focus: { includePaths: ["/assistant"] },
      maxWaitMs: 3_000,
    });
    const traceDir = await mkdtemp(join(tmpdir(), "jev-settle-"));
    try {
      // Offline picks are weighted-random; 0.4 lands on "click Send" among fill / Send / back / reload.
      const result = await runSession(
        { browser, cfg, client: null, traceDir, random: () => 0.4, log: { info: () => {}, warn: () => {} } },
        "s-slow",
        cfg.personas[0]!,
      );
      assert.match(result.actionLog[0] ?? "", /click button "Send"/);
      const slow = result.findings.find((f) => f.category === "slow-response");
      assert.ok(slow, JSON.stringify(result.findings.map((f) => f.category)));
      assert.match(slow.message, /Still working [3-9]s after "click button \"Send\"": (GET \/api\/assistant|text: Thinking)/);
      assert.equal(slow.level, "warn");
    } finally {
      await rm(traceDir, { recursive: true, force: true });
    }
  });
});

describe("the wait action", () => {
  it("is offered only while the page is still working", () => {
    const base = {
      persona: { name: "x", strategy: "x", traits: [] },
      elements: [],
      currentUrl: "http://h/",
      isInApp: () => true,
      canGoForward: false,
      visited: [],
      isForbidden: () => false,
      maxActions: 50,
      random: () => 0.5,
    };
    assert.ok(candidateActions({ ...base, pageBusy: true }).actions.some((a) => a.kind === "wait"));
    assert.ok(!candidateActions(base).actions.some((a) => a.kind === "wait"));
  });
});
