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
      [{ ...demoRun, mode: "interact" }, /Confirm the environment is disposable/],
      [{ ...demoRun, mode: "observe-writes" }, /at least one allowed write path/],
      [{ ...demoRun, mode: "yolo" }, /mode must be one of/],
      [{ ...demoRun, workers: 11 }, /workers must be an integer 1-10/],
      [{ ...demoRun, personas: ["no-such-agent"] }, /Unknown persona "no-such-agent"/],
      [{ ...demoRun, personas: [{ name: "inline", strategy: "x", traits: [] }] }, /personas must be an array of persona names/],
      [{ ...demoRun, focus: { includePaths: ["/products/*"] } }, /start URL \/ is outside the focus paths/],
      [{ ...demoRun, focus: { includePaths: "/products/*" } }, /focus must be/],
      [{ ...demoRun, setup: 'click button "Checkout"' }, /forbidden-control pattern/],
      [{ ...demoRun, setup: "teleport /x" }, /Setup line 1 .*unknown step/],
      [{ ...demoRun, maxWaitSeconds: 301 }, /maxWaitSeconds must be an integer 1-300/],
    ];
    for (const [body, error] of cases) {
      const res = await submit(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(res.body.error, error);
    }
  });

  it("keeps a persona library: add, edit, rename, delete, restore, and snapshot it into submitted runs", async () => {
    const { body: initial } = await api("/personas");
    assert.ok(initial.personas.some((p: { name: string }) => p.name === "url-tamperer"));
    assert.ok("keyboard" in initial.traits);

    const agent = { name: "checkout-hunter", strategy: "You go straight to checkout.", traits: ["history"] };
    assert.equal((await api("/personas", { method: "POST", body: JSON.stringify(agent) })).status, 201);
    assert.match((await api("/personas", { method: "POST", body: JSON.stringify(agent) })).body.error, /already exists/);
    assert.match((await api("/personas", { method: "POST", body: JSON.stringify({ ...agent, name: "x2", traits: ["mind-reading"] }) })).body.error, /traits must be/);

    // A queued run keeps the definition it was submitted with, whatever happens to the library later.
    const { body: job } = await submit({ ...demoRun, personas: ["checkout-hunter"] });
    assert.equal(job.personas[0].strategy, agent.strategy);

    const renamed = { ...agent, name: "cart-hunter", strategy: "You live in the cart." };
    assert.equal((await api("/personas/checkout-hunter", { method: "PUT", body: JSON.stringify(renamed) })).status, 200);
    const { body: after } = await api("/personas");
    assert.ok(after.personas.some((p: { name: string }) => p.name === "cart-hunter"));
    assert.ok(!after.personas.some((p: { name: string }) => p.name === "checkout-hunter"));
    assert.match((await submit({ ...demoRun, personas: ["checkout-hunter"] })).body.error, /Unknown persona/);

    assert.equal((await api("/personas/sloppy", { method: "DELETE" })).status, 200);
    assert.equal((await api("/personas/sloppy", { method: "DELETE" })).status, 404);
    const { body: restored } = await api("/personas/restore-built-ins", { method: "POST" });
    assert.ok(restored.some((p: { name: string }) => p.name === "sloppy"));
    assert.ok(restored.some((p: { name: string }) => p.name === "cart-hunter"), "custom agents survive a restore");

    await api(`/runs/${job.id}/cancel`, { method: "POST" });
    await waitFor(job.id, ["cancelled", "done"]);
    await api("/personas/cart-hunter", { method: "DELETE" });
  });

  it("keeps a focused run inside its area and reports what it covered", async () => {
    const { status, body: job } = await submit({
      ...demoRun,
      startUrl: `http://127.0.0.1:${DEMO_PORT}/products`,
      steps: 8,
      sessions: 2,
      workers: 2,
      personas: ["out-of-order", "url-tamperer"],
      focus: { instructions: "The product catalogue", includePaths: ["/products/*"], excludePaths: ["/products/7"] },
    });
    assert.equal(status, 201, JSON.stringify(job));
    const done = await waitFor(job.id, ["done", "failed"]);
    assert.equal(done.status, "done", done.error);
    const { body: report } = await api(`/runs/${job.id}/report.json`);
    const covered: string[] = report.summary.pagesCovered;
    assert.ok(covered.length > 0);
    for (const page of covered) assert.match(page, /^\/products(\/|$)/, `covered ${page}, outside the focus`);
    assert.match(report.summary.focus, /The product catalogue/);
  });

  it("serves the Claude Code focus prompt and validates a pasted answer", async () => {
    const startUrl = `http://127.0.0.1:${DEMO_PORT}/account`;
    const { status, body } = await api("/focus-prompt", { method: "POST", body: JSON.stringify({ startUrl, goal: "the account page" }) });
    assert.equal(status, 200);
    assert.match(body.prompt, /the account page/);
    const text = '```json\n{"includePaths": ["/account"], "setup": ["goto /login"], "allowedWritePaths": ["/login"]}\n```';
    const ok = await api("/focus-suggestion", { method: "POST", body: JSON.stringify({ startUrl, text }) });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.includePaths, ["/account"]);
    const bad = await api("/focus-suggestion", { method: "POST", body: JSON.stringify({ startUrl, text: '{"includePaths": ["/orders/*"]}' }) });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /outside the focus paths/);
    assert.equal((await api("/focus-prompt", { method: "POST", body: JSON.stringify({ goal: "x" }) })).status, 400);
  });

  const signIn = 'goto /login\nfill "Username" with "tester"\nfill "Password" with "hunter2"\nclick button "Sign in"\nwait for "Signed in as tester."';
  const setupRun = (extra: object) =>
    submit({ ...demoRun, startUrl: `http://127.0.0.1:${DEMO_PORT}/account`, steps: 2, sessions: 1, setup: signIn, focus: { includePaths: ["/account"] }, ...extra });

  it("replays setup before each session, so a focused run starts in the state it needs", async () => {
    const { status, body: job } = await setupRun({ mode: "observe-writes", allowedWritePaths: ["/login"] });
    assert.equal(status, 201, JSON.stringify(job));
    const done = await waitFor(job.id, ["done", "failed"]);
    assert.equal(done.status, "done", done.error);
    const { body: report } = await api(`/runs/${job.id}/report.json`);
    assert.ok(!report.findings.some((g: { category: string }) => g.category === "setup-failed"), JSON.stringify(report.findings));
    assert.deepEqual(report.summary.pagesCovered, ["/account"], "signed in, so /account did not redirect to /login");
    const { body: log } = await api(`/runs/${job.id}/log`);
    assert.match(log, /setup|\/account/);
  });

  it("fails a setup step with the reason, and points at the write the mode blocked", async () => {
    const { body: job } = await setupRun({});
    await waitFor(job.id, ["done", "failed"]);
    const { body: report } = await api(`/runs/${job.id}/report.json`);
    const failed = report.findings.find((g: { category: string }) => g.category === "setup-failed");
    assert.ok(failed, JSON.stringify(report.findings.map((g: { category: string }) => g.category)));
    assert.equal(failed.level, "fail");
    assert.match(failed.example.message, /Setup step 5 \(wait for "Signed in as tester\."\) failed/);
    assert.match(failed.example.message, /blocked POST .*\/login/);
    assert.deepEqual(report.summary.pagesCovered, [], "a failed setup explores nothing");
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

  it("exposes Prometheus metrics for runs, slots, findings and model use", async () => {
    const text = await runner.metricsText();
    // Every sample line is valid exposition format: name, optional labels, a number.
    for (const line of text.trim().split("\n")) {
      if (line.startsWith("#")) assert.match(line, /^# (HELP|TYPE) jev_runner_\w+ /);
      else assert.match(line, /^jev_runner_\w+(\{[a-z_]+="[^"]*"(,[a-z_]+="[^"]*")*\})? -?[\d.e+]+$/, line);
    }
    const value = (series: string) => Number(text.match(new RegExp(`^${series.replace(/[{}"+]/g, "\\$&")} (\\S+)$`, "m"))?.[1]);
    assert.equal(value("jev_runner_slots_capacity"), 2);
    assert.equal(value("jev_runner_jobs{status=\"queued\"}"), 0);
    // Earlier tests in this suite ran and cancelled runs against the demo app.
    assert.ok(value("jev_runner_runs_finished_total{status=\"done\"}") >= 1, text);
    assert.ok(value("jev_runner_sessions_total") >= 1);
    assert.ok(value("jev_runner_run_duration_seconds_count") >= 1);
    assert.equal(value("jev_runner_run_duration_seconds_bucket{le=\"+Inf\"}"), value("jev_runner_run_duration_seconds_count"));
    assert.doesNotMatch(text, /^jev_runner_run_duration_seconds\{/m, "histogram buckets carry the _bucket suffix");
    assert.match(text, /^jev_runner_findings_total\{level="(warn|fail)",category="[a-z0-9-]+"\} \d+$/m);
    assert.doesNotMatch(text, /127\.0\.0\.1|http:/, "no target URLs in metrics");
  });
});
