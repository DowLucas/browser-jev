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
const TRACKED = new Set(["document", "fetch", "xhr", "script"]);
/** Requests open longer than this are long-polls or streams, not pending renders. */
const LONG_LIVED_MS = 5_000;

export interface SettleOptions {
  /** How long both the DOM and the network must be quiet. */
  quietMs: number;
  /** Give up after this long; the page may be animating or polling forever. */
  timeoutMs: number;
}

/**
 * "Settled" for a single-page app: no DOM mutations and no in-flight data requests for a quiet
 * window. Load-state events are not enough, because client-side navigation loads no new document:
 * `networkidle` is reached once per document, so waiting for it after an in-app link click returns
 * at once and the old page is captured under the new URL.
 */
export class Settler {
  readonly #inflight = new Map<Request, number>();
  #lastNetworkActivity = Date.now();

  static async install(context: BrowserContext): Promise<void> {
    await context.addInitScript({ content: MUTATION_CLOCK });
  }

  constructor(page: Page) {
    const touch = () => {
      this.#lastNetworkActivity = Date.now();
    };
    page.on("request", (req) => {
      if (!TRACKED.has(req.resourceType())) return;
      this.#inflight.set(req, Date.now());
      touch();
    });
    const done = (req: Request) => {
      if (this.#inflight.delete(req)) touch();
    };
    page.on("requestfinished", done);
    page.on("requestfailed", done);
  }

  #networkQuietFor(): number {
    const now = Date.now();
    for (const [req, started] of this.#inflight) {
      if (now - started > LONG_LIVED_MS) this.#inflight.delete(req);
    }
    return this.#inflight.size ? 0 : now - this.#lastNetworkActivity;
  }

  async wait(page: Page, { quietMs, timeoutMs }: SettleOptions): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    // Give a click-triggered fetch or render a moment to start before measuring quiet.
    await page.waitForTimeout(Math.min(100, quietMs));
    while (Date.now() < deadline) {
      const domQuiet = (await page
        .evaluate("performance.now() - (window.__jevLastMutation ?? 0)")
        .catch(() => 0)) as number;
      if (domQuiet >= quietMs && this.#networkQuietFor() >= quietMs) break;
      await page.waitForTimeout(100);
    }
    await page.evaluate(FINITE_ANIMATIONS).catch(() => {});
  }
}
