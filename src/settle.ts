import type { BrowserContext, Page, Request } from "playwright";

/**
 * Records the time of the last DOM mutation on every page, from document start. Shipped as source
 * text for the same reason as the other in-page scripts (see page-model.ts).
 */
const MUTATION_CLOCK = `(() => {
  const mark = () => { window.__jevLastMutation = performance.now(); };
  mark();
  new MutationObserver(mark).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
})();`;

/** Waits for finite animations (accordions, transitions) to finish; infinite ones (spinners) are ignored. */
const FINITE_ANIMATIONS = `Promise.race([
  Promise.all(document.getAnimations()
    .filter((a) => a.playState === "running" && a.effect && a.effect.getComputedTiming().endTime !== Infinity)
    .map((a) => a.finished.catch(() => {}))),
  new Promise((r) => setTimeout(r, 1500)),
]).then(() => true)`;

/** Request types that mean the page is still fetching what it is about to render. */
const TRACKED = new Set(["document", "fetch", "xhr", "script", "eventsource"]);
/**
 * Background requests open longer than this are long-polls or streams, not pending renders. Requests
 * the last action started are exempt: an AI answer streaming in over one request is exactly the
 * response the tester is waiting for.
 */
const LONG_LIVED_MS = 5_000;
/** How often the (comparatively costly) busy-indicator scan runs while waiting. */
const BUSY_SCAN_MS = 500;

/**
 * Visible signs that the page is working on something: aria-busy, progress bars, loading or typing
 * indicators, and "Thinking..." style text. Source text, like the other in-page scripts. Returns
 * short descriptions, capped, so a before/after comparison can tell new signs from standing ones.
 */
const BUSY_SCAN = String.raw`(() => {
  const out = [];
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.05;
  };
  const label = (el) => {
    const text = (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
    return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (text ? ' "' + text + '"' : "");
  };
  const add = (what) => { if (out.length < 8 && !out.includes(what)) out.push(what); };
  for (const el of document.querySelectorAll('[aria-busy="true"], [role=progressbar], progress:not([value])')) {
    if (visible(el)) add("busy: " + label(el));
  }
  const CLASS = /(^|[-_\s])(spinner|spinning|loading|loader|typing|thinking|generating|skeleton)([-_\s]|$)/i;
  for (const el of document.querySelectorAll("[class]")) {
    const cls = typeof el.className === "string" ? el.className : el.getAttribute("class") || "";
    if (CLASS.test(cls) && visible(el)) add("indicator: ." + (cls.match(CLASS) || [])[2] + " " + label(el));
    if (out.length >= 8) break;
  }
  const TEXT = /\b(thinking|generating|typing|loading|processing|working on it)\s*(\.\.\.|…)/i;
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(), seen = 0; n && seen < 5000; n = walker.nextNode(), seen++) {
    if (TEXT.test(n.textContent) && n.parentElement && visible(n.parentElement)) add("text: " + n.textContent.trim().slice(0, 40));
  }
  return out;
})()`;

export interface SettleOptions {
  /** How long both the DOM and the network must be quiet. */
  quietMs: number;
  /** Give up after this long when nothing the last action started is still pending. */
  timeoutMs: number;
  /**
   * Keep waiting up to this long while the last action's own work is visibly pending: a request it
   * started, a new busy indicator. Slow submits and AI replies take seconds, not milliseconds.
   * Defaults to timeoutMs (no extended wait).
   */
  maxWaitMs?: number;
}

export interface SettleResult {
  settled: boolean;
  waitedMs: number;
  /** When it stopped waiting while the action's work was still pending: what was pending. */
  pending?: string;
}

/**
 * "Settled" for a single-page app: no DOM mutations and no in-flight data requests for a quiet
 * window. Load-state events are not enough, because client-side navigation loads no new document:
 * `networkidle` is reached once per document, so waiting for it after an in-app link click returns
 * at once and the old page is captured under the new URL.
 *
 * Call markAction() just before each action. From then on, requests the page starts count as the
 * action's work: they are waited on past LONG_LIVED_MS, up to maxWaitMs, and so are busy indicators
 * that were not already showing before the action.
 */
export class Settler {
  readonly #inflight = new Map<Request, { started: number; fromAction: boolean }>();
  #lastNetworkActivity = Date.now();
  #actionAt = 0;
  /** Busy signs showing when the action started; a spinner that was always there is not the action's. */
  #busyBefore = new Set<string>();

  static async install(context: BrowserContext): Promise<void> {
    await context.addInitScript({ content: MUTATION_CLOCK });
  }

  constructor(private readonly page: Page) {
    const touch = () => {
      this.#lastNetworkActivity = Date.now();
    };
    page.on("request", (req) => {
      if (!TRACKED.has(req.resourceType())) return;
      this.#inflight.set(req, { started: Date.now(), fromAction: this.#actionAt > 0 });
      touch();
    });
    const done = (req: Request) => {
      if (this.#inflight.delete(req)) touch();
    };
    page.on("requestfinished", done);
    page.on("requestfailed", done);
    // Chat apps often answer over a socket: incoming frames are network activity like a response.
    page.on("websocket", (ws) => {
      ws.on("framereceived", touch);
      ws.on("framesent", touch);
    });
  }

  /** The next action starts now: work the page begins from here on is that action's to finish. */
  async markAction(): Promise<void> {
    this.#busyBefore = new Set(await this.#busy());
    this.#actionAt = Date.now();
    // Requests already open are background work, whatever they were before.
    for (const entry of this.#inflight.values()) entry.fromAction = false;
  }

  async #busy(): Promise<string[]> {
    return ((await this.page.evaluate(BUSY_SCAN).catch(() => [])) as string[]) ?? [];
  }

  /**
   * Quiet time, and what the action is still waiting on. Past LONG_LIVED_MS, a request the action
   * started only stays pending while the page shows progress (it changed recently, or a busy sign is
   * up): a streaming answer does, a long-poll the new page opened just sits there.
   */
  #network(progressing: boolean): { quietFor: number; pendingRequest?: string } {
    const now = Date.now();
    let pendingRequest: string | undefined;
    for (const [req, entry] of this.#inflight) {
      const age = now - entry.started;
      if (entry.fromAction && age > LONG_LIVED_MS && !progressing) entry.fromAction = false;
      if (entry.fromAction) pendingRequest ??= `${req.method()} ${shortUrl(req.url())} open ${Math.round(age / 1000)}s`;
      else if (age > LONG_LIVED_MS) this.#inflight.delete(req);
    }
    return { quietFor: this.#inflight.size ? 0 : now - this.#lastNetworkActivity, pendingRequest };
  }

  async wait(page: Page, { quietMs, timeoutMs, maxWaitMs = timeoutMs }: SettleOptions): Promise<SettleResult> {
    const started = Date.now();
    const baseDeadline = started + timeoutMs;
    const maxDeadline = started + Math.max(timeoutMs, maxWaitMs);
    let newBusy: string[] = [];
    let lastScan = 0;
    let settled = false;
    let pending: string | undefined;
    /** When the action's work was last seen pending; finishing it earns a fresh short window to settle. */
    let lastPendingAt = 0;
    // Give a click-triggered fetch or render a moment to start before measuring quiet.
    await page.waitForTimeout(Math.min(100, quietMs));
    for (;;) {
      const now = Date.now();
      if (now - lastScan >= BUSY_SCAN_MS) {
        lastScan = now;
        newBusy = (await this.#busy()).filter((b) => !this.#busyBefore.has(b));
      }
      const domQuiet = (await page
        .evaluate("performance.now() - (window.__jevLastMutation ?? 0)")
        .catch(() => 0)) as number;
      const net = this.#network(domQuiet < LONG_LIVED_MS || newBusy.length > 0);
      pending = net.pendingRequest ?? newBusy[0];
      if (pending) lastPendingAt = Date.now();
      if (domQuiet >= quietMs && net.quietFor >= quietMs && !newBusy.length) {
        settled = true;
        break;
      }
      // Nothing of the action's is pending: the page is just animating or polling. Past the short
      // deadline, judge it as it is. While the action's work is pending, allow up to maxWaitMs.
      const deadline = pending ? maxDeadline : Math.min(maxDeadline, Math.max(baseDeadline, lastPendingAt + timeoutMs));
      if (Date.now() >= deadline) break;
      await page.waitForTimeout(100);
    }
    await page.evaluate(FINITE_ANIMATIONS).catch(() => {});
    return { settled, waitedMs: Date.now() - started, ...(settled || !pending ? {} : { pending }) };
  }
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + (u.search.length > 40 ? `${u.search.slice(0, 40)}…` : u.search);
  } catch {
    return url.slice(0, 60);
  }
}
