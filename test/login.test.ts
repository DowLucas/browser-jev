import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { chromium } from "playwright";
import { createHandler, Runner } from "../src/runner/server.ts";
import { parseSetup, runSetupStep } from "../src/setup.ts";

const DEMO_PORT = 4196;
const TOKEN = "test-token-0123456789abcdef";

describe("saved login sessions", () => {
  let demo: ChildProcess;
  let runner: Runner;
  let server: Server;
  let base: string;
  let dataDir: string;

  before(async () => {
    demo = spawn("node", ["demo/server.mjs"], { env: { ...process.env, PORT: String(DEMO_PORT) } });
    await once(demo.stdout!, "data");
    dataDir = await mkdtemp(join(tmpdir(), "jev-login-"));
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

  const api = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(base + path, {
      ...init,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    });
    return { status: res.status, body: await res.json() };
  };
  const post = (path: string, body: unknown) => api(path, { method: "POST", body: JSON.stringify(body) });

  it("logs in through the remote input API, saves the session, and lists it without secrets", async () => {
    const { body: started } = await post("/logins", { url: `http://127.0.0.1:${DEMO_PORT}/login` });
    const page = runner.logins.pageOf(started.id)!;
    await page.waitForSelector("input[name=username]");

    // The stream starts with the page's URL and then frames.
    const stream = await fetch(`${base}/logins/${started.id}/stream`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const reader = stream.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /event: meta/);
    await reader.cancel();

    // Click where the username field is, as the UI would: fractions of the viewport.
    const box = (await page.locator("input[name=username]").boundingBox())!;
    const vp = page.viewportSize()!;
    const click = { type: "click", x: (box.x + box.width / 2) / vp.width, y: (box.y + box.height / 2) / vp.height };
    assert.equal((await post(`/logins/${started.id}/input`, click)).status, 200);
    await post(`/logins/${started.id}/input`, { type: "type", text: "tester" });
    await post(`/logins/${started.id}/input`, { type: "key", key: "Tab" });
    await post(`/logins/${started.id}/input`, { type: "type", text: "hunter2" });
    await post(`/logins/${started.id}/input`, { type: "key", key: "Enter" });
    await page.waitForURL(/\/account$/);

    const saved = await post(`/logins/${started.id}/save`, { name: "demo-login" });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.domains, ["127.0.0.1"]);
    assert.equal(saved.body.cookies, 1);
    assert.ok(saved.body.expiresAt, "a persistent session cookie has an expiry");

    const file = join(dataDir, "auth", "demo-login.json");
    assert.equal((await stat(file)).mode & 0o777, 0o600, "saved sessions are owner-only");
    assert.match(await readFile(file, "utf8"), /tester-session/);

    const listed = await api("/auth-states");
    assert.deepEqual(listed.body.map((s: { name: string }) => s.name), ["demo-login"]);
    assert.doesNotMatch(JSON.stringify(listed.body), /tester-session/, "the API never returns cookie values");
    assert.equal(runner.logins.pageOf(started.id), undefined, "saving closes the login browser");
  });

  it("uses a saved session in a run", async () => {
    const run = await post("/runs", { startUrl: `http://127.0.0.1:${DEMO_PORT}/account`, authState: "demo-login", useModel: false, sessions: 1, steps: 1 });
    assert.equal(run.status, 201);
    for (let i = 0; i < 100 && (await api(`/runs/${run.body.id}`)).body.status !== "done"; i++) await new Promise((r) => setTimeout(r, 200));
    const log = await fetch(`${base}/runs/${run.body.id}/log`, { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.text());
    assert.match(log, /\/account/, "the run stayed on the signed-in page instead of being sent to /login");
    assert.doesNotMatch(log, /\/login/);
  });

  it("records setup steps from clicks and typing, never the password, and the recording replays", async () => {
    const { status, body: started } = await post("/logins", { url: `http://127.0.0.1:${DEMO_PORT}/login`, record: true });
    assert.equal(status, 201);
    const page = runner.logins.pageOf(started.id)!;
    await page.waitForSelector("input[name=username]");
    const vp = page.viewportSize()!;
    const clickOn = async (selector: string) => {
      const box = (await page.locator(selector).boundingBox())!;
      await post(`/logins/${started.id}/input`, { type: "click", x: (box.x + box.width / 2) / vp.width, y: (box.y + box.height / 2) / vp.height });
    };
    await clickOn("input[name=username]");
    await post(`/logins/${started.id}/input`, { type: "type", text: "test" });
    await post(`/logins/${started.id}/input`, { type: "type", text: "er" });
    await clickOn("input[name=password]");
    await post(`/logins/${started.id}/input`, { type: "type", text: "hunter2" });
    await clickOn("button[type=submit]");
    await page.waitForURL(/\/account$/);

    const { body } = await api(`/logins/${started.id}/steps`);
    const lines: string[] = body.steps.trim().split("\n");
    assert.deepEqual(lines.filter((l) => !l.startsWith("#")), ['goto /login', 'fill textbox "Username" with "tester"', 'click button "Sign in"']);
    assert.ok(lines.some((l) => l.startsWith("# not recorded: the password")), "the password field is noted, not recorded");
    assert.doesNotMatch(body.steps, /hunter2/);
    await api(`/logins/${started.id}`, { method: "DELETE" });

    // The recorded steps parse, and replay on a fresh page up to the password the recorder left out.
    const steps = parseSetup(body.steps);
    const fresh = await (await chromium.launch()).newPage();
    try {
      for (const step of steps.slice(0, 2)) await runSetupStep(fresh, step, `http://127.0.0.1:${DEMO_PORT}/`, 5_000);
      assert.equal(await fresh.inputValue("input[name=username]"), "tester");
    } finally {
      await fresh.context().browser()!.close();
    }
  });

  it("rejects bad input, bad names and non-session uploads; deletes", async () => {
    assert.equal((await post("/logins/nope/input", { type: "click", x: 0.5, y: 0.5 })).status, 400);
    const { body: started } = await post("/logins", { url: `http://127.0.0.1:${DEMO_PORT}/login` });
    assert.equal((await post(`/logins/${started.id}/input`, { type: "key", key: "Control+Shift+I" })).status, 400);
    assert.equal((await post(`/logins/${started.id}/input`, { type: "click", x: 2, y: 0 })).status, 400);
    assert.equal((await api(`/logins/${started.id}`, { method: "DELETE" })).status, 200);

    const put = (name: string, body: unknown) => api(`/auth-states/${name}`, { method: "PUT", body: JSON.stringify(body) });
    assert.equal((await put("..%2F..%2Fetc", { cookies: [], origins: [] })).status, 400);
    assert.equal((await put("uploaded", { hello: "world" })).status, 400);
    assert.equal((await put("uploaded", { cookies: [{ name: "a", value: "b", domain: "x.test" }], origins: [] })).status, 200);
    assert.equal((await api("/auth-states/uploaded", { method: "DELETE" })).status, 200);
    assert.equal((await api("/auth-states/uploaded", { method: "DELETE" })).status, 404);
  });
});
