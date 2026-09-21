import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { Browser } from "playwright";
import type { Config } from "./config.ts";
import { FindingStore, type FindingGroup } from "./findings.ts";
import { describeFocus, hasFocus } from "./focus.ts";
import { type RunSummary, writeOutputs } from "./report.ts";
import { assertSafeTarget } from "./safety.ts";
import { consoleLog, type RunLog, runSession, type SessionResult } from "./session.ts";
import type { LiveSink } from "./live.ts";
import type { FairSlots } from "./slots.ts";
import { tileBounds } from "./watch.ts";

export interface RunDeps {
  /** Shared browser; every session gets its own context in it. */
  browser: Browser;
  /** Global context slots. A run never holds more than `cfg.workers` of them at once. */
  slots: FairSlots;
  /** Identifies this run to the slot pool, so slots rotate fairly between runs. */
  runId: string;
  outDir: string;
  /** Inline spec text; takes precedence over cfg.specPath. */
  spec?: string;
  log?: RunLog;
  /** Checked between sessions and at every step; true stops the run and keeps what it found. */
  shouldStop?: () => boolean;
  /** In --watch, the screen to tile slot windows over. */
  screen?: { width: number; height: number };
  /** Live grid sink for this run's sessions. */
  live?: LiveSink;
}

export interface RunOutcome {
  summary: RunSummary;
  groups: FindingGroup[];
  suppressed: FindingGroup[];
  failing: number;
  sessionsRun: number;
  stopped: boolean;
  reportPath: string;
}

export function describeMode(cfg: Config): string {
  if (cfg.mode === "observe") return "observe (no writes reach the server)";
  if (cfg.mode === "observe-writes") return `observe-writes (only ${cfg.allowedWritePaths.join(", ")})`;
  return "INTERACT (all submissions reach the server)";
}

function sumCounts(counts: Record<string, number>[]): Record<string, number> {
  const total: Record<string, number> = {};
  for (const c of counts) for (const [k, n] of Object.entries(c)) total[k] = (total[k] ?? 0) + n;
  return total;
}

export async function executeRun(cfg: Config, deps: RunDeps): Promise<RunOutcome> {
  assertSafeTarget(cfg);
  const log = deps.log ?? consoleLog;
  const client = cfg.useModel ? new TypeSafeClient() : null;
  const spec = deps.spec ?? (cfg.specPath ? await readFile(cfg.specPath, "utf8") : undefined);
  const baseline = new Set<string>(
    cfg.baselinePath ? JSON.parse(await readFile(cfg.baselinePath, "utf8")).fingerprints : [],
  );
  const traceDir = join(deps.outDir, "traces");
  await mkdir(traceDir, { recursive: true });

  log.info(
    `Exploring ${cfg.startUrl}: ${cfg.sessions} sessions × ${cfg.steps} steps, up to ${cfg.workers} at once, ` +
      `${client ? "Jev judgment on" : "free oracle only"}, mode ${describeMode(cfg)}` +
      (hasFocus(cfg.focus) ? `, focus ${describeFocus(cfg.focus)}` : ""),
  );

  const started = Date.now();
  const stopped = () => deps.shouldStop?.() === true || !deps.browser.isConnected();
  const results: SessionResult[] = [];
  let next = 0;
  // Per-run workers bound this run's parallelism; the shared slots bound everyone's.
  const worker = async () => {
    while (next < cfg.sessions && !stopped()) {
      const index = next++;
      const slot = await deps.slots.acquire(deps.runId);
      try {
        if (stopped()) break;
        const persona = cfg.personas[index % cfg.personas.length]!;
        const sessionId = `s${String(index).padStart(3, "0")}-${persona.name}`;
        const window = deps.screen && tileBounds(slot.index, deps.slots.capacity, deps.screen);
        const result = await runSession(
          { browser: deps.browser, cfg, client, spec, traceDir, window, log, live: deps.live, shouldStop: stopped },
          sessionId,
          persona,
        );
        log.info(`[${sessionId}] done: ${result.findings.length} raw findings`);
        results.push(result);
      } finally {
        slot.release();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(cfg.workers, cfg.sessions) }, worker));

  const store = new FindingStore();
  for (const f of results.flatMap((r) => r.findings)) store.add(f);
  const all = store.groups();
  const groups = all.filter((g) => !baseline.has(g.fingerprint));
  const suppressed = all.filter((g) => baseline.has(g.fingerprint));
  const judgments = results.flatMap((r) => r.judgments);
  const summary: RunSummary = {
    startUrl: cfg.startUrl,
    sessions: cfg.sessions,
    steps: cfg.steps,
    jevCalls: judgments.length,
    judgeErrors: results.reduce((s, r) => s + r.judgeErrors, 0),
    inputTokens: judgments.reduce((s, j) => s + j.inputTokens, 0),
    blockedHosts: [...new Set(results.flatMap((r) => r.blockedHosts))],
    mode: describeMode(cfg),
    focus: describeFocus(cfg.focus),
    pagesCovered: [...new Set(results.flatMap((r) => r.pagesCovered))],
    focusReturns: results.reduce((s, r) => s + r.focusReturns, 0),
    blockedWrites: [...new Set(results.flatMap((r) => r.blockedWrites))],
    writesSent: sumCounts(results.map((r) => r.writesSent)),
    durationMs: Date.now() - started,
  };
  await writeOutputs(deps.outDir, { summary, groups, suppressed, judgments }, cfg.escalateCommand);

  if (cfg.writeBaselinePath) {
    await writeFile(cfg.writeBaselinePath, JSON.stringify({ fingerprints: all.map((g) => g.fingerprint) }, null, 2));
    log.info(`Wrote ${all.length} fingerprints to ${cfg.writeBaselinePath}`);
  }

  const failing = groups.filter((g) => g.level === "fail").length;
  const wasStopped = results.length < cfg.sessions;
  if (wasStopped) log.info(`Partial run: ${results.length}/${cfg.sessions} sessions.`);
  const reportPath = join(deps.outDir, "report.md");
  log.info(`${failing} failing, ${groups.length - failing} warning, ${suppressed.length} suppressed. Report: ${reportPath}`);
  return { summary, groups, suppressed, failing, sessionsRun: results.length, stopped: wasStopped, reportPath };
}
