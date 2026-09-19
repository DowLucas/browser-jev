import { createHash } from "node:crypto";
import { join } from "node:path";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import type { Browser, Page } from "playwright";
import {
  actionSignature,
  candidateActions,
  describeAction,
  executeAction,
  explainActionFailure,
  triggerKey,
  type Action,
} from "./actions.ts";
import type { Config } from "./config.ts";
import { fingerprint, type Finding } from "./findings.ts";
import { classifyJudgment, judgeStep, type Judgment } from "./judge.ts";
import { ariaSnapshot, enumerateElements, invalidFields, isBlank } from "./page-model.ts";
import { PERSONAS, type PersonaName } from "./personas.ts";
import { forbiddenMatcher, installNetworkFence, isAppUrl } from "./safety.ts";
import { type LiveSink, startScreencast } from "./live.ts";
import { placeWindow, showNextAction, type WindowBounds } from "./watch.ts";
import { type FreeResult, freeOracle, SignalCollector, summarizeSignals } from "./signals.ts";

export interface JudgmentRecord {
  sessionId: string;
  persona: PersonaName;
  step: number;
  url: string;
  oracle: Judgment["oracle"];
  severity: number;
  action: string;
  actionConfidence: number;
  inputTokens: number;
}

export interface SessionResult {
  sessionId: string;
  persona: PersonaName;
  findings: Finding[];
  judgments: JudgmentRecord[];
  actionLog: string[];
  blockedHosts: string[];
  /** Writes aborted by read-only mode ("POST https://..."). */
  blockedWrites: string[];
  judgeErrors: number;
  tracePath?: string;
}

export interface SessionDeps {
  browser: Browser;
  cfg: Config;
  /** Null in free-oracle-only mode. */
  client: TypeSafeClient | null;
  spec?: string;
  traceDir: string;
  random?: () => number;
  /** Checked at each step boundary; true ends the session cleanly, keeping its trace. */
  shouldStop?: () => boolean;
  /** In --watch, where this session's window goes on screen. */
  window?: WindowBounds;
  /** Where progress lines go; defaults to the console. */
  log?: RunLog;
  /** Live grid: session state and screen frames. */
  live?: LiveSink;
}

const HISTORY_IN_STATE = 10;

export interface RunLog {
  info(line: string): void;
  warn(line: string): void;
}

export const consoleLog: RunLog = { info: (l) => console.log(l), warn: (l) => console.warn(l) };

export async function runSession(
  deps: SessionDeps,
  sessionId: string,
  personaName: PersonaName,
): Promise<SessionResult> {
  const { browser, cfg, client } = deps;
  const log = deps.log ?? consoleLog;
  const random = deps.random ?? Math.random;
  const persona = PERSONAS[personaName];
  const isForbidden = forbiddenMatcher(cfg.forbiddenPatterns);

  const result: SessionResult = {
    sessionId,
    persona: personaName,
    findings: [],
    judgments: [],
    actionLog: [],
    blockedHosts: [],
    blockedWrites: [],
    judgeErrors: 0,
  };
  const blocked = new Set<string>();
  const blockedWrites = new Set<string>();
  const visited: string[] = [];
  const tried = new Map<string, number>();
  /** Values this session typed, so echoes of its own input are not mistaken for leaks. */
  const typed = new Set<string>();

  // In --watch the page fills its tiled window instead of a fixed 1280x720 viewport.
  const context = await browser.newContext({
    storageState: cfg.storageStatePath,
    ...(cfg.watch ? { viewport: null } : {}),
  });
  await installNetworkFence(context, cfg, (url, reason) => {
    if (reason === "write-in-read-only") blockedWrites.add(url);
    else blocked.add(new URL(url).host);
  });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  const live = deps.live;
  live?.started(sessionId, { persona: personaName, steps: cfg.steps });
  const stopScreencast = live
    ? await startScreencast(page, (jpeg) => live.frame(sessionId, jpeg)).catch((err: Error) => {
        log.warn(`[${sessionId}] live view unavailable: ${err.message.split("\n")[0]}`);
        return undefined;
      })
    : undefined;
  if (deps.window) {
    await placeWindow(page, deps.window).catch((err: Error) =>
      log.warn(`[${sessionId}] could not place window: ${err.message.split("\n")[0]}`),
    );
  }
  // Popups are a side channel; keep the session to one page.
  context.on("page", (p) => {
    if (p !== page) p.close().catch(() => {});
  });

  const collector = new SignalCollector(cfg);
  collector.attach(page);

  let trigger = "start";
  let lastAction: Action | undefined;
  let lastActionError: string | undefined;
  let previousSnapshotHash: string | undefined;

  type FindingInput = Omit<Finding, "fingerprint" | "triggerKey" | "sessionId" | "persona" | "actionLog">;
  interface FingerprintOptions {
    shape?: string;
    /** Identify by shape alone, not the page it surfaced on. */
    pageIndependent?: boolean;
    /** Identify by shape alone, not the action that surfaced it. */
    triggerIndependent?: boolean;
  }
  const record = (partial: FindingInput, opts: FingerprintOptions = {}) => {
    const key = triggerKey(lastAction);
    result.findings.push({
      ...partial,
      triggerKey: key,
      fingerprint: fingerprint({
        category: partial.category,
        url: opts.pageIndependent ? "" : partial.url,
        triggerKey: opts.triggerIndependent ? "" : key,
        shape: opts.shape,
      }),
      sessionId,
      persona: personaName,
      actionLog: [...result.actionLog],
    });
  };

  const recordFree = (results: FreeResult[], url: string, step: number) => {
    for (const r of results) {
      const level = cfg.freeOracleFailOn.includes(r.category) ? "fail" : "warn";
      record(
        { category: r.category, source: "free", level, message: r.message, url, trigger, step },
        { shape: r.shape, pageIndependent: r.pageIndependent },
      );
    }
  };

  try {
    await page.goto(cfg.startUrl, { timeout: cfg.actionTimeoutMs * 3 });

    for (let step = 0; step < cfg.steps; step++) {
      // Per-step failures are caught below, so a dead page would otherwise be stepped through to the end.
      if (page.isClosed() || !browser.isConnected()) throw new Error("its page or browser was closed");
      if (deps.shouldStop?.()) {
        log.info(`[${sessionId}] stopping after ${step} steps`);
        break;
      }
      await settle(page, personaName);
      // Back/forward can leave the app (e.g. to about:blank); return to the start instead of judging that.
      if (!isAppUrl(page.url(), cfg.allowedHosts)) {
        await page.goto(cfg.startUrl, { timeout: cfg.actionTimeoutMs * 3 });
        await settle(page, personaName);
        collector.drain();
        trigger = "start";
        lastAction = undefined;
      }
      const url = page.url();
      if (visited.at(-1) !== url) visited.push(url);

      // 1. Free oracle: code-only checks, before any model call.
      const signals = collector.drain();
      recordFree(freeOracle(signals, await isBlank(page)), url, step);
      if (signals.crashed) break;

      // 2. Capture state.
      const snapshot = await ariaSnapshot(page, cfg.maxSnapshotChars);
      const snapshotHash = createHash("sha1").update(snapshot).digest("hex");
      const unchanged = previousSnapshotHash === snapshotHash;
      previousSnapshotHash = snapshotHash;

      // 3. Enumerate actions.
      const elements = await enumerateElements(page).catch((err: Error) => {
        // Usually a navigation racing the evaluate; the step still has back/reload available.
        log.warn(`[${sessionId}] element enumeration failed at step ${step}: ${err.message.split("\n")[0]}`);
        return [];
      });
      const { actions, skipped } = candidateActions({
        persona: personaName,
        elements,
        visited,
        isForbidden,
        maxActions: cfg.maxActions,
        random,
      });

      // 4. One Jev call: oracle questions + next action.
      let action: Action;
      const flagged: string[] = [];
      const observed = lastActionError
        ? `the action failed: ${lastActionError}`
        : unchanged && step > 0
          ? "the page did not change after the last action"
          : "the page changed";
      if (client) {
        const state = {
          persona: persona.strategy,
          spec: deps.spec ?? "No spec provided.",
          url,
          title: await page.title().catch(() => ""),
          lastAction: trigger,
          lastActionResult: observed,
          fieldsBlockedByBrowserValidation: await invalidFields(page),
          recentActions: result.actionLog.slice(-HISTORY_IN_STATE),
          valuesTypedThisSession: [...typed],
          pagesVisited: visited.length,
          ...summarizeSignals(signals),
          controlsSkippedForSafety: skipped,
          ariaSnapshot: snapshot,
        };
        const notes = (a: Action) => actionNotes(a, tried, visited);
        try {
          const j = await judgeStep(client, state, actions, persona, notes, random);
          for (const issue of classifyJudgment(j, cfg.thresholds)) {
            record({ ...issue, source: "judgment", url, trigger, step, observed });
            flagged.push(`${issue.level === "fail" ? "FAIL" : "warn"} ${issue.category} ${issue.confidence.toFixed(2)}`);
          }
          action = actions[j.actionIndex] ?? pickOffline(actions, tried, random);
          result.judgments.push({
            sessionId,
            persona: personaName,
            step,
            url,
            oracle: j.oracle,
            severity: j.severity,
            action: describeAction(action),
            actionConfidence: j.actionConfidence,
            inputTokens: j.inputTokens,
          });
        } catch (err) {
          result.judgeErrors++;
          log.warn(`[${sessionId}] Jev call failed at step ${step}: ${(err as Error).message}`);
          action = pickOffline(actions, tried, random);
        }
      } else {
        action = pickOffline(actions, tried, random);
      }

      // 5. Execute and record.
      const next = describeAction(action);
      const where = new URL(url).pathname + new URL(url).search;
      log.info(`[${sessionId}] ${String(step).padStart(2)} ${where}  → ${next}${flagged.length ? `   ⚑ ${flagged.join(", ")}` : ""}`);
      live?.step(sessionId, { step: step + 1, url: where, next, flags: flagged });
      if (cfg.watch) {
        const banner = [
          `Jev explorer · ${personaName} · session ${sessionId} · step ${step + 1}/${cfg.steps}`,
          ...flagged.map((f) => `⚑ ${f}`),
          `next → ${next}`,
        ].join("\n");
        await showNextAction(page, banner, action.target, cfg.slowMoMs);
      }
      lastAction = action;
      if (action.kind === "fill" && action.value?.trim()) typed.add(action.value.slice(0, 80));
      trigger = next;
      result.actionLog.push(`${trigger}  [on ${url}]`);
      const sig = actionSignature(action);
      tried.set(sig, (tried.get(sig) ?? 0) + 1);
      lastActionError = undefined;
      try {
        await executeAction(page, action, cfg.actionTimeoutMs);
      } catch (err) {
        const failure = explainActionFailure(err as Error);
        lastActionError = failure.summary;
        if (failure.interceptedBy) {
          // One finding per covering element, however many controls it covers and wherever.
          record(
            {
              category: "click-intercepted",
              source: "free",
              level: cfg.freeOracleFailOn.includes("click-intercepted") ? "fail" : "warn",
              message: `"${failure.interceptedBy}" covers ${describeTarget(action)}, so the click cannot reach it`,
              url,
              trigger,
              step,
            },
            { shape: failure.interceptedBy, pageIndependent: true, triggerIndependent: true },
          );
        }
      }
    }
    // Signals from the final action.
    await settle(page, personaName);
    recordFree(freeOracle(collector.drain(), false), page.url(), cfg.steps);
  } catch (err) {
    log.warn(`[${sessionId}] session ended early: ${(err as Error).message.split("\n")[0]}`);
  } finally {
    stopScreencast?.();
    live?.ended(sessionId, { findings: result.findings.length });
    // Keep a trace only when there is something to reproduce.
    if (result.findings.length) {
      result.tracePath = join(deps.traceDir, `${sessionId}.zip`);
      await context.tracing.stop({ path: result.tracePath }).catch(() => {});
      for (const f of result.findings) f.tracePath = result.tracePath;
    } else {
      await context.tracing.stop().catch(() => {});
    }
    await context.close().catch(() => {});
    result.blockedHosts = [...blocked];
    result.blockedWrites = [...blockedWrites];
  }
  return result;
}

function describeTarget(a: Action): string {
  return a.role ? `${a.role} "${a.name ?? ""}"` : "the target";
}

async function settle(page: Page, persona: PersonaName): Promise<void> {
  // The impatient persona does not wait for anything; that is the point.
  if (persona === "impatient") {
    await page.waitForTimeout(100);
    return;
  }
  await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => {});
}

function actionNotes(a: Action, tried: Map<string, number>, visited: readonly string[]): string {
  const count = tried.get(actionSignature(a)) ?? 0;
  const notes: string[] = [];
  if (count) notes.push(`tried ${count}x`);
  if (a.href && !visited.includes(a.href)) notes.push("leads to an unvisited page");
  return notes.length ? ` (${notes.join(", ")})` : "";
}

/** Model-free fallback: random, weighted towards actions not tried yet. */
function pickOffline(actions: readonly Action[], tried: Map<string, number>, random: () => number): Action {
  const weights = actions.map((a) => 1 / (1 + 2 * (tried.get(actionSignature(a)) ?? 0)));
  let r = random() * weights.reduce((s, w) => s + w, 0);
  for (let i = 0; i < actions.length; i++) {
    r -= weights[i] ?? 0;
    if (r <= 0) return actions[i] as Action;
  }
  return actions.at(-1) as Action;
}
