// Runner service: queues exploration runs and executes them on one shared browser, with a global
// cap on open browser contexts (the real memory limit) shared fairly between runs.
//
// Environment:
//   RUNNER_TOKEN          required; clients send "Authorization: Bearer <token>"
//   RUNNER_PORT           default 8080
//   RUNNER_DATA           default ./runner-data (jobs, run outputs, saved login sessions in auth/)
//   RUNNER_CONTEXTS       default 6; browser contexts open at once across all runs
//   RUNNER_ACTIVE_RUNS    default 2; runs executing at once (the rest wait in the queue)
//   RUNNER_WATCH          "1" launches a headed browser (for Xvfb + noVNC)
//   NTFY_URL              optional; e.g. https://ntfy.example.com/jev, notified when a run ends
//   RUNNER_BLOCKED_SUFFIXES  comma-separated domains that may never be targeted (e.g. your own infra)
//   RUNNER_ALLOW_PRIVATE  "1" allows localhost/private-IP targets (local use only, never on a shared network)
//   TYPESAFE_API_KEY      Jev key, used by runs with useModel (the default)
import { createWriteStream } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { type Browser, chromium } from "playwright";
import { executeRun } from "../run.ts";
import type { RunLog } from "../session.ts";
import { FairSlots } from "../slots.ts";
import { detectScreen } from "../watch.ts";
import { type Job, JobStore, RequestError, type RunRequest, type TargetPolicy } from "./jobs.ts";

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
  readonly #active = new Map<string, { cancel: () => void }>();
  #browser: Promise<Browser> | undefined;
  #draining = false;

  constructor(readonly opts: RunnerOptions) {
    this.store = new JobStore(opts.dataDir, opts.targets);
    this.slots = new FairSlots(opts.contexts);
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

  /** Stop taking new work; running jobs finish their current step, write reports, and are marked interrupted. */
  async drain(): Promise<void> {
    this.#draining = true;
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
      try {
        const cfg = this.store.toConfig(job.request);
        const outcome = await executeRun(cfg, {
          browser: await this.#getBrowser(),
          slots: this.slots,
          runId: job.id,
          outDir,
          spec: job.request.spec,
          log,
          shouldStop: () => cancelled,
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

export function createHandler(runner: Runner) {
  const token = Buffer.from(runner.opts.token);
  const authorized = (req: IncomingMessage) => {
    const given = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /, ""));
    return given.length === token.length && timingSafeEqual(given, token);
  };

  return async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown, type = "application/json") => {
      res.writeHead(status, { "content-type": type });
      res.end(type === "application/json" ? JSON.stringify(body, null, 2) : String(body));
    };
    const { pathname } = new URL(req.url ?? "/", "http://runner");
    const parts = pathname.split("/").filter(Boolean);

    try {
      if (req.method === "GET" && pathname === "/health") {
        const queued = (await runner.store.list()).filter((j) => j.status === "queued").length;
        return send(200, { ok: true, queued, ...runner.status() });
      }
      if (!authorized(req)) return send(401, { error: "unauthorized" });

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

async function readJson(req: IncomingMessage): Promise<RunRequest> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new RequestError("Request body too large");
  }
  const body = JSON.parse(raw) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new RequestError("Body must be a JSON object");
  return body as RunRequest;
}

// --- Entry point -------------------------------------------------------------------------------------

async function main() {
  const token = process.env.RUNNER_TOKEN;
  if (!token || token.length < 24) throw new Error("RUNNER_TOKEN must be set (at least 24 characters).");
  const runner = new Runner({
    token,
    dataDir: process.env.RUNNER_DATA ?? "runner-data",
    contexts: Number(process.env.RUNNER_CONTEXTS ?? 6),
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
  // Watchtower and `docker stop` send SIGTERM: finish current steps, keep reports, then exit.
  const shutdown = async () => {
    console.log("Shutting down: finishing current steps and writing reports.");
    server.close();
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
