import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createHandler, Runner } from "../src/runner/server.ts";

const DEMO_PORT = 4197;
const TOKEN = "test-token-0123456789abcdef";
const demoRun = { startUrl: `http://127.0.0.1:${DEMO_PORT}/`, useModel: false, steps: 4 };

describe("runner service", () => {
  let demo: ChildProcess;
  let runner: Runner;
  let server: Server;
  let base: string;
  let dataDir: string;

  before(async () => {
    demo = spawn("node", ["demo/server.mjs"], { env: { ...process.env, PORT: String(DEMO_PORT) } });
    await once(demo.stdout!, "data");
    dataDir = await mkdtemp(join(tmpdir(), "jev-runner-"));
    runner = new Runner({
      token: TOKEN,
      dataDir,
      contexts: 2,
      activeRuns: 1,
      watch: false,
      targets: { allowPrivate: true, blockedSuffixes: [] },
    });
    await runner.start();
    server = createServer(createHandler(runner)).listen(0);
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(async () => {
    await runner.drain();
    server.close();
    demo.kill();
    await rm(dataDir, { recursive: true, force: true });
  });

  const api = async (path: string, init: RequestInit = {}, token = TOKEN) => {
    const res = await fetch(base + path, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
    return { status: res.status, body: res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text() };
  };
  const submit = (body: unknown) => api("/runs", { method: "POST", body: JSON.stringify(body) });
  const waitFor = async (id: string, statuses: string[]) => {
    for (let i = 0; i < 300; i++) {
      const { body } = await api(`/runs/${id}`);
      if (statuses.includes(body.status)) return body;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`run ${id} never reached ${statuses}`);
  };

  it("serves health without auth but everything else only with the token", async () => {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await api("/runs", {}, "wrong-token-0123456789abcd")).status, 401);
  });

  it("rejects unsafe or malformed requests at submission", async () => {
    const cases: [unknown, RegExp][] = [
      [{ ...demoRun, escalateCommand: "rm -rf /" }, /Unknown field/],
      [{ ...demoRun, allowedHosts: "127.0.0.1" }, /allowedHosts must be an array/],
      [{ ...demoRun, startUrl: "https://www.acme.com/" }, /looks like production/],
      [{ ...demoRun, startUrl: "not a url" }, /Invalid start URL/],
      [{ ...demoRun, allowedHosts: ["api.example.dev", "prod.example.dev"] }, /looks like production/],
      [{ ...demoRun, authState: "../../etc/passwd" }, /Invalid authState/],
      [{ ...demoRun, authState: "missing" }, /No saved login session/],
      [{ ...demoRun, steps: 100000 }, /steps must be an integer/],
    ];
    for (const [body, error] of cases) {
      const res = await submit(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(res.body.error, error);
    }
  });

  it("queues runs beyond the active limit, runs them in order, and cancels a queued one", async () => {
    const a = (await submit({ ...demoRun, sessions: 2 })).body;
    const b = (await submit({ ...demoRun, sessions: 1 })).body;
    const c = (await submit({ ...demoRun, sessions: 1 })).body;
    assert.equal((await api(`/runs/${c.id}/cancel`, { method: "POST" })).body.status, "cancelled");

    const doneA = await waitFor(a.id, ["done", "failed"]);
    const doneB = await waitFor(b.id, ["done", "failed"]);
    assert.equal(doneA.status, "done", doneA.error);
    assert.equal(doneB.status, "done", doneB.error);
    assert.equal(doneA.outcome.sessionsRun, 2);
    // activeRuns = 1: b could only start after a finished.
    assert.ok(doneB.startedAt >= doneA.finishedAt);
    assert.equal((await api(`/runs/${c.id}`)).body.status, "cancelled");

    const report = await api(`/runs/${a.id}/report`);
    assert.equal(report.status, 200);
    assert.match(report.body, /# Adversarial exploration report/);
    assert.match((await api(`/runs/${a.id}/log`)).body, /s000-impatient\] done/);
  });
});
