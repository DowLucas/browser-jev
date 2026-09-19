import { createHash } from "node:crypto";
import { join } from "node:path";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import type { Browser } from "playwright";
import {
  actionSignature,
  candidateActions,
  describeAction,
  executeAction,
  explainActionFailure,
  StaleTargetError,
  triggerKey,
  type Action,
} from "./actions.ts";
import type { Config } from "./config.ts";
import { fingerprint, type Finding } from "./findings.ts";
import { classifyJudgment, judgeStep, type Judgment } from "./judge.ts";
import { ariaSnapshot, enumerateElements, invalidFields, isBlank, layoutIssues } from "./page-model.ts";
import { PERSONAS, type PersonaName } from "./personas.ts";
import { forbiddenMatcher, installNetworkFence, isAppUrl } from "./safety.ts";
import { type LiveSink, startScreencast } from "./live.ts";
import { Settler } from "./settle.ts";
import { placeWindow, showNextAction, type WindowBounds } from "./watch.ts";
import {
  type FreeCategory,
  type FreeResult,
  freeOracle,
  isGatewayError,
  NETWORK_FAILURE,
  SignalCollector,
  summarizeSignals,
} from "./signals.ts";

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
    // Without it, "copy" buttons fail silently in headless Chromium and look broken.
    permissions: ["clipboard-read", "clipboard-write"],
    ...(cfg.watch ? { viewport: null } : {}),
  });
  /** Requests the fence blocked since the last signal drain; their fallout is not an app bug. */
  let blockedSinceDrain = 0;
  await installNetworkFence(context, cfg, (url, reason) => {
    blockedSinceDrain++;
    if (reason === "write-in-read-only") blockedWrites.add(url);
    else blocked.add(new URL(url).host);
  });
  await context.tracing.start({ screenshots: true, snapshots: true });
  await Settler.install(context);
  const page = await context.newPage();
  const settler = new Settler(page);
  const settle = () => settler.wait(page, SETTLE[personaName === "impatient" ? "impatient" : "normal"]);
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
  let popupOpened = false;
  context.on("page", (p) => {
    if (p === page) return;
    popupOpened = true;
    p.close().catch(() => {});
  });
  let canGoForward = false;

  const collector = new SignalCollector(cfg);
  collector.attach(page);

  let trigger = "start";
  let lastAction: Action | undefined;
  let lastActionError: string | undefined;
  /** Why an unchanged page after the last action is expected, if it is. */
  let lastActionNote: string | undefined;
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

  const recordFree = (results: FreeResult[], url: string, step: number, fenceBlocked = 0) => {
    for (const r of results) {
      // A page that reports "Failed to fetch" right after our fence aborted one of its requests is
      // reacting to the test harness. Keep it visible, but not as an app error.
      const fenceEffect = fenceBlocked > 0 && /error$/.test(r.category) && NETWORK_FAILURE.test(r.message);
      const category = fenceEffect ? "fence-side-effect" : r.category;
      const message = fenceEffect ? `${r.message} (likely caused by the test's network fence blocking a request)` : r.message;
      const level = !fenceEffect && cfg.freeOracleFailOn.includes(r.category) ? "fail" : "warn";
      record(
        { category, source: "free", level, message, url, trigger, step },
        { shape: r.shape, pageIndependent: r.pageIndependent, triggerIndependent: r.triggerIndependent },
      );
    }
  };
  const recordCode = (category: FreeCategory, message: string, url: string, step: number, opts: FingerprintOptions) =>
    record(
      { category, source: "free", level: cfg.freeOracleFailOn.includes(category) ? "fail" : "warn", message, url, trigger, step },
      opts,
    );

  try {
    await page.goto(cfg.startUrl, { timeout: cfg.actionTimeoutMs * 3 });

    for (let step = 0; step < cfg.steps; step++) {
      // Per-step failures are caught below, so a dead page would otherwise be stepped through to the end.
      if (page.isClosed() || !browser.isConnected()) throw new Error("its page or browser was closed");
      if (deps.shouldStop?.()) {
        log.info(`[${sessionId}] stopping after ${step} steps`);
        break;
      }
      await settle();
      // Back/forward can leave the app (e.g. to about:blank); return to the start instead of judging that.
      if (!isAppUrl(page.url(), cfg.allowedHosts)) {
        await page.goto(cfg.startUrl, { timeout: cfg.actionTimeoutMs * 3 });
        await settle();
        collector.drain();
        trigger = "start";
        lastAction = undefined;
      }
      const url = page.url();
      if (visited.at(-1) !== url) visited.push(url);

      // 1. Free oracle: code-only checks, before any model call.
      const signals = collector.drain();
      const fenceBlocked = blockedSinceDrain;
      blockedSinceDrain = 0;
      recordFree(freeOracle(signals, await isBlank(page)), url, step, fenceBlocked);
      if (signals.crashed) break;
      // While the service is down, every page is the outage page; judging it again is noise.
      const outage = signals.httpErrors.some((e) => isGatewayError(e.status));

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
      // Code-only structural checks on what was just enumerated.
      const covers = new Map<string, string[]>();
      for (const el of elements) {
        if (el.coveredBy && !el.coveredByModal) covers.set(el.coveredBy, [...(covers.get(el.coveredBy) ?? []), `${el.role} "${el.name}"`]);
        if (el.anchor === "missing") {
          recordCode("broken-anchor", `Link ${el.role} "${el.name}" points to ${new URL(el.href!).hash}, which is not on the page`, url, step, {
            shape: new URL(el.href!).hash,
            triggerIndependent: true,
          });
        }
      }
      for (const [cover, controls] of covers) {
        recordCode("covered-control", `"${cover}" covers ${controls.length} control(s) that no scroll position reveals, e.g. ${controls.slice(0, 3).join(", ")}`, url, step, {
          shape: cover.replace(/\d+/g, "#"),
          pageIndependent: true,
          triggerIndependent: true,
        });
      }
      const layout = await layoutIssues(page);
      if (layout.horizontalOverflow) {
        const { px, culprits } = layout.horizontalOverflow;
        recordCode("horizontal-overflow", `Page is ${px}px wider than the viewport; sticking out: ${culprits.join(", ") || "unknown"}`, url, step, {
          triggerIndependent: true,
        });
      }
      for (const clipped of layout.clipped) {
        recordCode("clipped-text", `Text is cut off without an ellipsis: "${clipped}"`, url, step, {
          shape: clipped.replace(/\d+/g, "#"),
          triggerIndependent: true,
        });
      }

      const { actions, skipped } = candidateActions({
        persona: personaName,
        currentUrl: url,
        isInApp: (href) => isAppUrl(href, cfg.allowedHosts),
        canGoForward,
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
        : lastActionNote
          ? lastActionNote
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
          for (const issue of outage ? [] : classifyJudgment(j, cfg.thresholds)) {
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
      lastActionNote = expectedNoChange(action);
      popupOpened = false;
      try {
        await executeAction(page, action, cfg.actionTimeoutMs);
        const moved = page.url() !== url;
        if (popupOpened) lastActionNote = "the action opened a new tab or window, which the tester closed, so the current page is not expected to change";
        else if ((action.kind === "back" || action.kind === "forward") && !moved) {
          lastActionNote = `there was no page to go ${action.kind} to, so nothing is expected to change`;
        }
        // Forward only makes sense straight after going back.
        if (moved) canGoForward = action.kind === "back";
      } catch (err) {
        if (err instanceof StaleTargetError) {
          lastActionNote = `nothing was clicked: the targeted element re-rendered before the click (a test-harness timing issue, not an app bug)`;
          continue;
        }
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
    await settle();
    recordFree(freeOracle(collector.drain(), false), page.url(), cfg.steps, blockedSinceDrain);
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

/** Actions after which an unchanged page is the correct outcome, and why, for the model's state. */
function expectedNoChange(a: Action): string | undefined {
  if (a.inPage) return "the link jumps to a section of the current page, so the page content is not expected to change";
  if (a.kind === "dblclick") return "a double-click on a control that toggles returns it to its original state, so no change may be expected";
  return undefined;
}

function describeTarget(a: Action): string {
  return a.role ? `${a.role} "${a.name ?? ""}"` : "the target";
}

/**
 * How long to wait for the page to settle before judging it. The impatient persona acts on a short
 * fuse (that is the point), but every persona is judged on a page that has stopped changing:
 * judging a half-rendered page is how "the click did nothing" false positives happen.
 */
const SETTLE = {
  normal: { quietMs: 300, timeoutMs: 6_000 },
  impatient: { quietMs: 150, timeoutMs: 1_500 },
} as const;

function actionNotes(a: Action, tried: Map<string, number>, visited: readonly string[]): string {
  const count = tried.get(actionSignature(a)) ?? 0;
  const notes: string[] = [];
  if (count) notes.push(`tried ${count}x`);
  if (a.inPage) notes.push("jumps within this page");
  else if (a.href && !visited.includes(a.href)) notes.push("leads to an unvisited page");
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
