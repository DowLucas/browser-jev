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
import { fingerprint, type Finding, normalizePath } from "./findings.ts";
import { classifyJudgment, judgeStep, type Judgment } from "./judge.ts";
import { ariaSnapshot, enumerateElements, invalidFields, isBlank, layoutIssues } from "./page-model.ts";
import type { Persona } from "./personas.ts";
import { forbiddenMatcher, installNetworkFence, isAppUrl } from "./safety.ts";
import { inFocus } from "./focus.ts";
import { formatStep, runSetupStep } from "./setup.ts";
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
  type Signals,
  summarizeSignals,
} from "./signals.ts";

export interface JudgmentRecord {
  sessionId: string;
  persona: string;
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
  persona: string;
  findings: Finding[];
  judgments: JudgmentRecord[];
  actionLog: string[];
  blockedHosts: string[];
  /** Writes the mode blocked, e.g. "POST /orders". */
  blockedWrites: string[];
  /** Writes that reached the server, with how often each was sent. */
  writesSent: Record<string, number>;
  judgeErrors: number;
  /** Distinct pages (ids collapsed) judged inside the focus area; with no focus, the whole app. */
  pagesCovered: string[];
  /** Times the session left the focus area and was returned to the entry page. */
  focusReturns: number;
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
  persona: Persona,
): Promise<SessionResult> {
  const { browser, cfg, client } = deps;
  const log = deps.log ?? consoleLog;
  const random = deps.random ?? Math.random;
  const personaName = persona.name;
  const isForbidden = forbiddenMatcher(cfg.forbiddenPatterns);

  const result: SessionResult = {
    sessionId,
    persona: personaName,
    findings: [],
    judgments: [],
    actionLog: [],
    blockedHosts: [],
    blockedWrites: [],
    writesSent: {},
    judgeErrors: 0,
    pagesCovered: [],
    focusReturns: 0,
  };
  const covered = new Set<string>();
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
  /** Writes the mode blocked, in order; setup reads the ones its steps caused. */
  const blockedWriteLog: string[] = [];
  await installNetworkFence(
    context,
    cfg,
    (url, reason) => {
      blockedSinceDrain++;
      if (reason === "write-blocked") {
        blockedWrites.add(url);
        blockedWriteLog.push(url);
      }
      else blocked.add(new URL(url).host);
    },
    (write) => {
      result.writesSent[write] = (result.writesSent[write] ?? 0) + 1;
    },
  );
  await context.tracing.start({ screenshots: true, snapshots: true });
  await Settler.install(context);
  const page = await context.newPage();
  const settler = new Settler(page);
  const hasty = persona.traits.includes("hasty");
  /** Settle before judging. A hasty persona never waits long: acting on a short fuse is its point. */
  const settle = () => settler.wait(page, { ...SETTLE[hasty ? "hasty" : "normal"], maxWaitMs: hasty ? SETTLE.hasty.timeoutMs : cfg.maxWaitMs });
  /** Wait for a slow response whoever is testing: setup steps, and the explicit wait action. */
  const settleLong = () => settler.wait(page, { ...SETTLE.normal, maxWaitMs: cfg.maxWaitMs });
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

  /**
   * Replay the setup steps. Their signals are findings like any other; a step that cannot be done
   * ends the session, since everything after it would test the wrong state.
   */
  const runSetup = async (): Promise<boolean> => {
    if (cfg.setup[0]?.kind !== "goto") await page.goto(cfg.startUrl, { timeout: cfg.actionTimeoutMs * 3 });
    const blockedBefore = blockedWriteLog.length;
    for (const [i, step] of cfg.setup.entries()) {
      trigger = `setup step ${i + 1}: ${formatStep(step)}`;
      result.actionLog.push(`${trigger}  [on ${page.url()}]`);
      live?.step(sessionId, { step: 0, url: new URL(page.url()).pathname, next: trigger, flags: [] });
      let failure: string | undefined;
      try {
        await settler.markAction();
        await runSetupStep(page, step, cfg.startUrl, cfg.actionTimeoutMs);
        const r = await settleLong();
        if (!r.settled && r.pending) throw new Error(`the page was still working after ${Math.round(r.waitedMs / 1000)}s (${r.pending})`);
      } catch (err) {
        failure = (err as Error).message.split("\n")[0];
      }
      const url = page.url();
      recordFree(freeOracle(collector.drain(), false), url, 0, blockedSinceDrain);
      blockedSinceDrain = 0;
      if (!failure) continue;
      const blockedInSetup = blockedWriteLog.slice(blockedBefore);
      const hint = blockedInSetup.length
        ? `. The ${cfg.mode} mode blocked ${blockedInSetup.slice(0, 3).join(", ")} during setup; if the step depended ` +
          "on that, allow the path with observe-writes (--allow-write) or run in interact mode"
        : "";
      record(
        {
          category: "setup-failed",
          source: "free",
          level: cfg.freeOracleFailOn.includes("setup-failed") ? "fail" : "warn",
          message: `Setup step ${i + 1} (${formatStep(step)}) failed, so the session did not explore: ${failure}${hint}`,
          url,
          trigger,
          step: 0,
        },
        { shape: String(i + 1), pageIndependent: true, triggerIndependent: true },
      );
      log.warn(`[${sessionId}] setup step ${i + 1} failed: ${failure}`);
      return false;
    }
    const blockedInSetup = blockedWriteLog.slice(blockedBefore);
    if (blockedInSetup.length) {
      log.warn(`[${sessionId}] setup finished, but ${cfg.mode} mode blocked ${blockedInSetup.slice(0, 3).join(", ")} during it`);
    }
    return true;
  };

  try {
    if (cfg.setup.length && !(await runSetup())) return result;
    // Sessions start at the entry point, wherever setup ended.
    if (!cfg.setup.length || page.url() !== cfg.startUrl) await page.goto(cfg.startUrl, { timeout: cfg.actionTimeoutMs * 3 });
    trigger = "start";

    for (let step = 0; step < cfg.steps; step++) {
      // Per-step failures are caught below, so a dead page would otherwise be stepped through to the end.
      if (page.isClosed() || !browser.isConnected()) throw new Error("its page or browser was closed");
      if (deps.shouldStop?.()) {
        log.info(`[${sessionId}] stopping after ${step} steps`);
        break;
      }
      const work = await settle();
      /** The last action's work (a request, a loading indicator) had not finished when the wait ended. */
      const stillWorking = !work.settled && work.pending && lastAction ? work : undefined;
      if (stillWorking && !hasty && stillWorking.waitedMs >= cfg.maxWaitMs - 250) {
        recordCode(
          "slow-response",
          `Still working ${Math.round(stillWorking.waitedMs / 1000)}s after "${trigger}": ${stillWorking.pending}`,
          page.url(),
          step,
          {},
        );
      }
      // Back/forward can leave the app (e.g. to about:blank); return to the start instead of judging that.
      if (!isAppUrl(page.url(), cfg.allowedHosts)) {
        await page.goto(cfg.startUrl, { timeout: cfg.actionTimeoutMs * 3 });
        await settle();
        collector.drain();
        trigger = "start";
        lastAction = undefined;
      }
      // A submit or a script can still leave the focus area. Keep what that page signalled, then go back in.
      if (!inFocus(page.url(), cfg.focus)) {
        const left = page.url();
        recordFree(freeOracle(collector.drain(), false), left, step, blockedSinceDrain);
        blockedSinceDrain = 0;
        await page.goto(cfg.startUrl, { timeout: cfg.actionTimeoutMs * 3 });
        await settle();
        if (!inFocus(page.url(), cfg.focus)) {
          throw new Error(
            `the entry page redirects outside the focus area (to ${new URL(page.url()).pathname}); ` +
              "if that is a login page, the run needs a saved login",
          );
        }
        collector.drain();
        result.focusReturns++;
        trigger = "start";
        lastAction = undefined;
        lastActionError = undefined;
        lastActionNote =
          `the last action led outside the focus area (${new URL(left).pathname}), so the test harness returned ` +
          "to the entry page; this return is not app behaviour";
      }
      const url = page.url();
      covered.add(normalizePath(url));
      if (visited.at(-1) !== url) visited.push(url);

      // 1. Free oracle: code-only checks, before any model call.
      const signals = withoutExpectedRejection(collector.drain(), lastAction);
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
        persona,
        currentUrl: url,
        isInApp: (href) => isAppUrl(href, cfg.allowedHosts),
        inFocus: (href) => inFocus(href, cfg.focus),
        canGoForward,
        pageBusy: !!stillWorking,
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
        : stillWorking
          ? `the page was still working on the last action when this was captured, after ${Math.round(stillWorking.waitedMs / 1000)}s ` +
            `(${stillWorking.pending}); a result that is missing may simply not have arrived yet`
        : lastActionNote
          ? lastActionNote
          : unchanged && step > 0
            ? "the page did not change after the last action"
            : "the page changed";
      if (client) {
        const state = {
          persona: persona.strategy,
          ...(cfg.focus.instructions ? { focus: cfg.focus.instructions } : {}),
          spec: deps.spec ?? "No spec provided.",
          url,
          title: await page.title().catch(() => ""),
          lastAction: trigger,
          lastActionResult: observed,
          ...(stillWorking ? { pageStillWorking: `${stillWorking.pending}, after ${Math.round(stillWorking.waitedMs / 1000)}s` } : {}),
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
          const j = await judgeStep(client, state, actions, persona, notes, random, cfg.focus.instructions);
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
        if (action.kind === "wait") {
          // Not a new action: the previous one's requests stay its work, so do not markAction.
          const r = await settleLong();
          lastActionNote = r.settled
            ? `the tester waited ${Math.round(r.waitedMs / 1000)}s and the page finished responding`
            : `the tester waited ${Math.round(r.waitedMs / 1000)}s and the page was still working (${r.pending})`;
          continue;
        }
        await settler.markAction();
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
    result.pagesCovered = [...covered];
    result.blockedWrites = [...blockedWrites];
  }
  return result;
}

/** Actions after which an unchanged page is the correct outcome, and why, for the model's state. */
function expectedNoChange(a: Action): string | undefined {
  if (a.inPage) return "the link jumps to a section of the current page, so the page content is not expected to change";
  if (a.kind === "dblclick") return "a double-click on a control that toggles returns it to its original state, so no change may be expected";
  if (a.kind === "press" && !a.target) {
    return `${a.key} only has an effect while a dialog, menu or popup is open; with none open, no change is expected`;
  }
  if (a.tamper) {
    return (
      `the tester deliberately edited the URL (${a.tamper}). A clear not-found, invalid-request or access-denied page ` +
      "is the correct response and not a bug; a crash, raw error, stack trace, blank page or another record's data is"
    );
  }
  return undefined;
}

/**
 * A 4xx on the very URL the tester edited is the app correctly refusing it, as is the browser's
 * console line about that response. Everything else, including a 5xx there, still counts.
 */
function withoutExpectedRejection(signals: Signals, last: Action | undefined): Signals {
  if (!last?.tamper || !last.url) return signals;
  const refused = (e: Signals["httpErrors"][number]) => e.method === "GET" && e.url === last.url && e.status >= 400 && e.status < 500;
  if (!signals.httpErrors.some(refused)) return signals;
  return {
    ...signals,
    httpErrors: signals.httpErrors.filter((e) => !refused(e)),
    consoleErrors: signals.consoleErrors.filter((c) => !/^Failed to load resource: the server responded with a status of 4\d\d/.test(c)),
  };
}

function describeTarget(a: Action): string {
  return a.role ? `${a.role} "${a.name ?? ""}"` : "the target";
}

/**
 * How long to wait for the page to settle before judging it. A hasty persona acts on a short
 * fuse (that is the point), but every persona is judged on a page that has stopped changing:
 * judging a half-rendered page is how "the click did nothing" false positives happen.
 */
const SETTLE = {
  normal: { quietMs: 300, timeoutMs: 6_000 },
  hasty: { quietMs: 150, timeoutMs: 1_500 },
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
