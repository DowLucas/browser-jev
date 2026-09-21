// Runner service: queues exploration runs and executes them on one shared browser, with a global
// cap on open browser contexts (the real memory limit) shared fairly between runs.
//
// Environment:
//   RUNNER_TOKEN          required; clients send "Authorization: Bearer <token>"
//   RUNNER_PORT           default 8080
//   RUNNER_DATA           default ./runner-data (jobs, run outputs, saved login sessions in auth/)
//   RUNNER_CONTEXTS       default and maximum 10; browser contexts (sessions) open at once across all runs
//   RUNNER_ACTIVE_RUNS    default 2; runs executing at once (the rest wait in the queue)
//   RUNNER_WATCH          "1" launches a headed browser (for Xvfb + noVNC)
//   NTFY_URL              optional; e.g. https://ntfy.example.com/jev, notified when a run ends
//   RUNNER_BLOCKED_SUFFIXES  comma-separated domains that may never be targeted (e.g. your own infra)
//   RUNNER_METRICS_PORT   optional; serves Prometheus metrics at /metrics on this port, no auth. Only
//                         publish it where the scraper sits (e.g. a docker network), never to the internet.
//   RUNNER_ALLOW_PRIVATE  "1" allows localhost/private-IP targets (local use only, never on a shared network)
//   TYPESAFE_API_KEY      Jev key, used by runs with useModel (the default)
import { createWriteStream } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { type Browser, chromium } from "playwright";
import { DEFAULTS, MAX_PARALLEL_SESSIONS } from "../config.ts";
import { focusPrompt, parseFocusSuggestion } from "../focus-prompt.ts";
import { LiveHub } from "../live.ts";
import { BUILT_IN_NAMES, TRAITS } from "../personas.ts";
import { executeRun } from "../run.ts";
import type { RunLog } from "../session.ts";
import { FairSlots } from "../slots.ts";
import { detectScreen } from "../watch.ts";
import { type Job, JobStore, RequestError, type RunRequest, type TargetPolicy } from "./jobs.ts";
import { LoginManager } from "./login.ts";
import { RunnerMetrics } from "./metrics.ts";

export interface RunnerOptions {
  token: string;
  dataDir: string;
  contexts: number;
  activeRuns: number;
  watch: boolean;
  ntfyUrl?: string;
  targets?: TargetPolicy;
}

export class Runner {
  readonly store: JobStore;
  readonly slots: FairSlots;
  readonly live = new LiveHub();
  readonly logins: LoginManager;
  readonly metrics = new RunnerMetrics();
  readonly #active = new Map<string, { cancel: () => void }>();
  #browser: Promise<Browser> | undefined;
  #draining = false;

  constructor(readonly opts: RunnerOptions) {
    this.store = new JobStore(opts.dataDir, opts.targets);
    this.slots = new FairSlots(opts.contexts);
    this.logins = new LoginManager(() => this.#getBrowser(), this.slots, this.store);
  }

  async start(): Promise<void> {
    await this.store.init();
    // Runs that were executing when the process died start over from the queue.
    for (const job of await this.store.list()) {
      if (job.status === "running") await this.store.save({ ...job, status: "queued", startedAt: undefined });
    }
    void this.pump();
  }

  async submit(request: RunRequest): Promise<Job> {
    const job = await this.store.create(request);
    void this.pump();
    return job;
  }

  async cancel(id: string): Promise<Job | undefined> {
    const job = await this.store.get(id);
    if (!job) return undefined;
    if (job.status === "queued") {
      const cancelled: Job = { ...job, status: "cancelled", finishedAt: new Date().toISOString() };
      await this.store.save(cancelled);
      return cancelled;
    }
    // A running job stops at its next step boundary and still writes its report.
    this.#active.get(id)?.cancel();
    return job;
  }

  status() {
    return { active: [...this.#active.keys()], slotsInUse: this.slots.inUse, capacity: this.slots.capacity };
  }

  async metricsText(): Promise<string> {
    const jobs = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0, interrupted: 0 };
    for (const j of await this.store.list()) jobs[j.status]++;
    return this.metrics.render({
      slotsCapacity: this.slots.capacity,
      slotsInUse: this.slots.inUse,
      activeRuns: this.#active.size,
      liveSessions: this.live.liveSessions,
      loginBrowsers: this.logins.open,
      jobs,
    });
  }

  /** Stop taking new work; running jobs finish their current step, write reports, and are marked interrupted. */
  async drain(): Promise<void> {
    this.#draining = true;
    await this.logins.closeAll();
    for (const { cancel } of this.#active.values()) cancel();
    while (this.#active.size) await new Promise((r) => setTimeout(r, 200));
    await (await this.#browser)?.close().catch(() => {});
  }

  /** Start queued jobs, oldest first, while there is room. */
  async pump(): Promise<void> {
    if (this.#draining) return;
    const queued = (await this.store.list()).filter((j) => j.status === "queued");
    for (const job of queued) {
      if (this.#active.size >= this.opts.activeRuns) return;
      if (this.#active.has(job.id)) continue;
      this.#execute(job);
    }
  }

  #getBrowser(): Promise<Browser> {
    this.#browser ??= chromium.launch({ headless: !this.opts.watch, handleSIGINT: false, handleSIGTERM: false });
    return this.#browser.then((b) => {
      if (b.isConnected()) return b;
      this.#browser = undefined;
      return this.#getBrowser();
    });
  }

  #execute(queued: Job): void {
    let cancelled = false;
    this.#active.set(queued.id, { cancel: () => (cancelled = true) });
    void (async () => {
      const outDir = this.store.runDir(queued.id);
      await rm(outDir, { recursive: true, force: true });
      const job: Job = { ...queued, status: "running", startedAt: new Date().toISOString() };
      await this.store.save(job);
      const logFile = createWriteStream(this.store.logPath(job.id), { flags: "w" });
      const line = (level: string, text: string) => {
        logFile.write(`${new Date().toISOString()} ${level} ${text}\n`);
        console.log(`[run ${job.id.slice(0, 8)}] ${text}`);
      };
      const log: RunLog = { info: (t) => line("info", t), warn: (t) => line("warn", t) };
      let outcome: Awaited<ReturnType<typeof executeRun>> | undefined;
      try {
        const cfg = this.store.toConfig(job.request, job.personas ?? (await this.store.listPersonas()));
        outcome = await executeRun(cfg, {
          browser: await this.#getBrowser(),
          slots: this.slots,
          runId: job.id,
          outDir,
          spec: job.request.spec,
          log,
          shouldStop: () => cancelled,
          live: this.live.forRun(job.id),
          screen: this.opts.watch ? await detectScreen() : undefined,
        });
        job.outcome = {
          failing: outcome.failing,
          warnings: outcome.groups.length - outcome.failing,
          suppressed: outcome.suppressed.length,
          sessionsRun: outcome.sessionsRun,
          stopped: outcome.stopped,
          summary: outcome.summary,
        };
        job.status = !cancelled ? "done" : this.#draining ? "interrupted" : "cancelled";
      } catch (err) {
        job.status = "failed";
        job.error = (err as Error).message;
        log.warn(`Run failed: ${job.error}`);
      } finally {
        job.finishedAt = new Date().toISOString();
        await this.store.save(job);
        this.metrics.recordRun(job.status, Date.parse(job.finishedAt) - Date.parse(job.startedAt!), outcome);
        logFile.end();
        this.#active.delete(job.id);
        await this.#notify(job);
        void this.pump();
      }
    })();
  }

  async #notify(job: Job): Promise<void> {
    if (!this.opts.ntfyUrl) return;
    const o = job.outcome;
    const body = o
      ? `${job.status}: ${o.failing} failing, ${o.warnings} warnings (${o.sessionsRun} sessions) on ${job.request.startUrl}`
      : `${job.status}: ${job.error ?? ""} (${job.request.startUrl})`;
    await fetch(this.opts.ntfyUrl, {
      method: "POST",
      body,
      headers: { Title: `Jev run ${job.id.slice(0, 8)}`, Tags: o?.failing ? "warning" : "white_check_mark" },
    }).catch((err: Error) => console.warn(`ntfy failed: ${err.message}`));
  }
}

// --- HTTP ------------------------------------------------------------------------------------------

const COOKIE = "jev_token";
const UI_HTML = readFile(new URL("./ui.html", import.meta.url), "utf8");

export function createHandler(runner: Runner) {
  const token = Buffer.from(runner.opts.token);
  const matches = (candidate: string) => {
    const given = Buffer.from(candidate);
    return given.length === token.length && timingSafeEqual(given, token);
  };
  // API clients send a bearer token; the browser UI (and EventSource, which cannot set headers) uses a cookie.
  const authorized = (req: IncomingMessage) =>
    matches((req.headers.authorization ?? "").replace(/^Bearer /, "")) || matches(cookie(req, COOKIE) ?? "");

  return async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown, type = "application/json") => {
      res.writeHead(status, { "content-type": type });
      // A string is already the body (e.g. report.json read from disk); encoding it again would quote it.
      res.end(type === "application/json" && typeof body !== "string" ? JSON.stringify(body, null, 2) : String(body));
    };
    const { pathname } = new URL(req.url ?? "/", "http://runner");
    const parts = pathname.split("/").filter(Boolean);

    try {
      if (req.method === "GET" && pathname === "/") return send(200, await UI_HTML, "text/html; charset=utf-8");
      if (req.method === "POST" && pathname === "/login") {
        const { token: given } = await readJson<{ token?: string }>(req);
        if (typeof given !== "string" || !matches(given)) return send(401, { error: "wrong token" });
        const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
        res.setHeader("set-cookie", `${COOKIE}=${given}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure}`);
        return send(200, { ok: true });
      }
      if (req.method === "GET" && pathname === "/health") {
        const queued = (await runner.store.list()).filter((j) => j.status === "queued").length;
        return send(200, { ok: true, queued, ...runner.status() });
      }
      if (!authorized(req)) return send(401, { error: "unauthorized" });
      if (req.method === "GET" && pathname === "/live") return runner.live.subscribe(res);

      // Saved login sessions. Summaries only: cookie and storage values never leave the server.
      if (parts[0] === "auth-states") {
        const name = parts[1];
        if (!name && req.method === "GET") return send(200, await runner.store.listAuthStates());
        if (name && req.method === "PUT") return send(200, await runner.store.saveAuthState(name, await readJson(req, 5_000_000)));
        if (name && req.method === "DELETE") {
          runner.store.authPath(name);
          return (await runner.store.deleteAuthState(name)) ? send(200, { deleted: name }) : send(404, { error: "no such login" });
        }
        return send(404, { error: "not found" });
      }

      // Remote, interactive login browsers.
      if (parts[0] === "logins") {
        const [, id, sub] = parts;
        if (!id && req.method === "POST") {
          const { url, record, authState } = await readJson<{ url?: unknown; record?: unknown; authState?: unknown }>(req);
          if (typeof url !== "string") throw new RequestError("url is required");
          if (record !== undefined && typeof record !== "boolean") throw new RequestError("record must be a boolean");
          if (authState !== undefined && typeof authState !== "string") throw new RequestError("authState must be a string");
          return send(201, await runner.logins.start(url, { record, authState: authState || undefined }));
        }
        if (id && sub === "steps" && req.method === "GET") return send(200, runner.logins.steps(id));
        if (id && sub === "stream" && req.method === "GET") {
          if (!runner.logins.subscribe(id, res)) return send(404, { error: "no such login session" });
          return;
        }
        if (id && sub === "input" && req.method === "POST") {
          await runner.logins.input(id, await readJson(req));
          return send(200, { ok: true });
        }
        if (id && sub === "save" && req.method === "POST") {
          const { name } = await readJson<{ name?: unknown }>(req);
          if (typeof name !== "string") throw new RequestError("name is required");
          return send(200, await runner.logins.save(id, name));
        }
        if (id && !sub && req.method === "DELETE") {
          await runner.logins.close(id);
          return send(200, { closed: id });
        }
        return send(404, { error: "not found" });
      }

      // Persona library: the adversarial agents a run can pick from.
      if (parts[0] === "personas") {
        const name = parts[1] && decodeURIComponent(parts[1]);
        if (!name && req.method === "GET") {
          return send(200, { personas: await runner.store.listPersonas(), traits: TRAITS, builtIn: BUILT_IN_NAMES });
        }
        if (!name && req.method === "POST") return send(201, await runner.store.savePersona(await readJson(req)));
        if (name === "restore-built-ins" && !parts[2] && req.method === "POST") return send(200, await runner.store.restoreBuiltInPersonas());
        if (name && req.method === "PUT") return send(200, await runner.store.savePersona(await readJson(req), name));
        if (name && req.method === "DELETE") {
          return (await runner.store.deletePersona(name)) ? send(200, { deleted: name }) : send(404, { error: "no such persona" });
        }
        return send(404, { error: "not found" });
      }

      // A prompt for Claude Code that writes a run's Focus and setup, and validation of its answer.
      if (req.method === "POST" && (pathname === "/focus-prompt" || pathname === "/focus-suggestion")) {
        const body = await readJson<{ startUrl?: unknown; goal?: unknown; text?: unknown }>(req, 200_000);
        if (typeof body.startUrl !== "string" || !/^https?:\/\//.test(body.startUrl)) throw new RequestError("Enter a start URL (http or https) first");
        try {
          new URL(body.startUrl);
          if (pathname === "/focus-prompt") {
            if (body.goal !== undefined && typeof body.goal !== "string") throw new Error("goal must be a string");
            return send(200, { prompt: focusPrompt({ startUrl: body.startUrl, goal: body.goal ?? "", forbiddenPatterns: DEFAULTS.forbiddenPatterns }) });
          }
          if (typeof body.text !== "string" || !body.text.trim()) throw new Error("Paste Claude Code's answer first");
          return send(200, parseFocusSuggestion(body.text, body.startUrl, DEFAULTS.forbiddenPatterns));
        } catch (err) {
          throw err instanceof RequestError ? err : new RequestError((err as Error).message);
        }
      }

      if (parts[0] !== "runs") return send(404, { error: "not found" });
      if (parts.length === 1 && req.method === "POST") return send(201, await runner.submit(await readJson(req)));
      if (parts.length === 1 && req.method === "GET") return send(200, (await runner.store.list()).reverse().slice(0, 100));

      const job = await runner.store.get(parts[1] ?? "");
      if (!job) return send(404, { error: "no such run" });
      const [, , sub] = parts;
      if (!sub && req.method === "GET") return send(200, job);
      if (sub === "cancel" && req.method === "POST") return send(200, await runner.cancel(job.id));
      if (req.method === "GET" && (sub === "log" || sub === "report" || sub === "report.json")) {
        const file =
          sub === "log"
            ? runner.store.logPath(job.id)
            : join(runner.store.runDir(job.id), sub === "report" ? "report.md" : "report.json");
        const text = await readFile(file, "utf8").catch(() => undefined);
        if (text === undefined) return send(404, { error: `${sub} not available yet` });
        return send(200, text, sub === "report.json" ? "application/json" : "text/plain; charset=utf-8");
      }
      return send(404, { error: "not found" });
    } catch (err) {
      if (err instanceof RequestError || err instanceof SyntaxError) return send(400, { error: err.message });
      console.error(err);
      return send(500, { error: "internal error" });
    }
  };
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

async function readJson<T = RunRequest>(req: IncomingMessage, maxBytes = 1_000_000): Promise<T> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > maxBytes) throw new RequestError("Request body too large");
  }
  const body = JSON.parse(raw) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new RequestError("Body must be a JSON object");
  return body as T;
}

// --- Entry point -------------------------------------------------------------------------------------

async function main() {
  const token = process.env.RUNNER_TOKEN;
  if (!token || token.length < 24) throw new Error("RUNNER_TOKEN must be set (at least 24 characters).");
  const runner = new Runner({
    token,
    dataDir: process.env.RUNNER_DATA ?? "runner-data",
    contexts: Math.min(Number(process.env.RUNNER_CONTEXTS ?? MAX_PARALLEL_SESSIONS), MAX_PARALLEL_SESSIONS),
    activeRuns: Number(process.env.RUNNER_ACTIVE_RUNS ?? 2),
    watch: process.env.RUNNER_WATCH === "1",
    ntfyUrl: process.env.NTFY_URL || undefined,
    targets: {
      allowPrivate: process.env.RUNNER_ALLOW_PRIVATE === "1",
      blockedSuffixes: (process.env.RUNNER_BLOCKED_SUFFIXES ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    },
  });
  await runner.start();
  const port = Number(process.env.RUNNER_PORT ?? 8080);
  const server = createServer(createHandler(runner)).listen(port, () =>
    console.log(`Runner on :${port}, ${runner.slots.capacity} contexts, ${runner.opts.activeRuns} active runs`),
  );
  // Metrics on their own port, so the reverse proxy in front of the API never serves them.
  const metricsPort = Number(process.env.RUNNER_METRICS_PORT ?? 0);
  const metricsServer = metricsPort
    ? createServer((req, res) => {
        if (req.method !== "GET" || req.url !== "/metrics") return void res.writeHead(404).end();
        runner.metricsText().then(
          (text) => res.writeHead(200, { "content-type": "text/plain; version=0.0.4" }).end(text),
          (err: Error) => res.writeHead(500).end(err.message),
        );
      }).listen(metricsPort, () => console.log(`Metrics on :${metricsPort}/metrics`))
    : undefined;
  // Watchtower and `docker stop` send SIGTERM: finish current steps, keep reports, then exit.
  const shutdown = async () => {
    console.log("Shutting down: finishing current steps and writing reports.");
    server.close();
    metricsServer?.close();
    await runner.drain();
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
}
