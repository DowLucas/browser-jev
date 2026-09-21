import type { Page } from "playwright";
import { normalizeRequestPath } from "./findings.ts";

/** Marker embedded in injection-shaped input; a dialog carrying it means script injection executed. */
export const XSS_MARKER = "jev-xss";

/** Categories found by code, without the model. A list, so metrics can start every one at zero. */
export const FREE_CATEGORIES = [
  "console-error",
  "page-error",
  "http-4xx",
  "http-5xx",
  "crash",
  "blank-render",
  "xss-dialog",
  "click-intercepted",
  "service-unavailable",
  "covered-control",
  "clipped-text",
  "horizontal-overflow",
  "broken-anchor",
  "fence-side-effect",
  "setup-failed",
  "slow-response",
] as const;
export type FreeCategory = (typeof FREE_CATEGORIES)[number];

export interface HttpError {
  method: string;
  url: string;
  status: number;
}

/** Everything the free oracle observed since the last drain. */
export interface Signals {
  consoleErrors: string[];
  pageErrors: string[];
  httpErrors: HttpError[];
  dialogs: string[];
  crashed: boolean;
}

export interface FreeResult {
  category: FreeCategory;
  message: string;
  /** Extra shape for the fingerprint, e.g. the failing request path. */
  shape?: string;
  /**
   * The finding is identified by its shape, not the page it surfaced on. An exception thrown by a
   * click can be reported after the page has already navigated away.
   */
  pageIndependent?: boolean;
  /** The finding is identified by its shape, not the action that surfaced it. */
  triggerIndependent?: boolean;
}

/** Gateway errors mean the service itself was unavailable, not that one endpoint is broken. */
export const isGatewayError = (status: number) => status === 502 || status === 503 || status === 504;

/** Network-level failures a page reports when a request it made was aborted, e.g. by our fence. */
export const NETWORK_FAILURE = /Failed to fetch|NetworkError when attempting|Load failed|ERR_BLOCKED_BY_CLIENT/i;

const DUPLICATE_CONSOLE_ERRORS = [
  // Our own network fence; blocked hosts are reported separately.
  /ERR_BLOCKED_BY_CLIENT/,
  // Chrome's echo of an HTTP error response; the HTTP oracle already reports it with more detail.
  /^Failed to load resource: the server responded with a status of \d+/,
];

const emptySignals = (): Signals => ({
  consoleErrors: [],
  pageErrors: [],
  httpErrors: [],
  dialogs: [],
  crashed: false,
});

export class SignalCollector {
  #buffer = emptySignals();
  readonly #ignoreRequests: RegExp[];
  readonly #ignoreConsole: RegExp[];

  constructor(opts: { ignoreRequestPatterns: readonly string[]; ignoreConsolePatterns: readonly string[] }) {
    this.#ignoreRequests = opts.ignoreRequestPatterns.map((p) => new RegExp(p, "i"));
    this.#ignoreConsole = [...DUPLICATE_CONSOLE_ERRORS, ...opts.ignoreConsolePatterns.map((p) => new RegExp(p, "i"))];
  }

  attach(page: Page): void {
    page.on("console", (msg) => {
      if (msg.type() === "error" && !this.#ignoreConsole.some((re) => re.test(msg.text()))) {
        this.#buffer.consoleErrors.push(msg.text());
      }
    });
    page.on("pageerror", (err) => this.#buffer.pageErrors.push(err.stack ?? err.message));
    page.on("response", (res) => {
      const url = res.url();
      if (res.status() >= 400 && !this.#ignoreRequests.some((re) => re.test(url))) {
        this.#buffer.httpErrors.push({ method: res.request().method(), url, status: res.status() });
      }
    });
    page.on("crash", () => {
      this.#buffer.crashed = true;
    });
    // Dialogs block the page; record and dismiss (dismissing a confirm() is the safe answer).
    page.on("dialog", (dialog) => {
      this.#buffer.dialogs.push(dialog.message());
      dialog.dismiss().catch(() => {});
    });
  }

  drain(): Signals {
    const signals = this.#buffer;
    this.#buffer = emptySignals();
    return signals;
  }
}

/** Code-only checks that cost nothing and run before any model call. */
export function freeOracle(signals: Signals, blankRender: boolean): FreeResult[] {
  const results: FreeResult[] = [];
  for (const text of signals.consoleErrors) {
    results.push({ category: "console-error", message: firstLine(text) });
  }
  for (const stack of signals.pageErrors) {
    const message = firstLine(stack);
    results.push({ category: "page-error", message, shape: message.replace(/\d+/g, "#"), pageIndependent: true });
  }
  // One finding for an outage, however many requests it failed: that is one root cause.
  const gateway = signals.httpErrors.filter((e) => isGatewayError(e.status));
  if (gateway.length) {
    const statuses = [...new Set(gateway.map((e) => e.status))].join("/");
    const first = gateway[0]!;
    results.push({
      category: "service-unavailable",
      message: `${gateway.length} request(s) returned ${statuses}, e.g. ${first.method} ${new URL(first.url).pathname}`,
      shape: "gateway",
      pageIndependent: true,
      triggerIndependent: true,
    });
  }
  for (const err of signals.httpErrors.filter((e) => !isGatewayError(e.status))) {
    results.push({
      category: err.status >= 500 ? "http-5xx" : "http-4xx",
      message: `${err.method} ${err.url} -> ${err.status}`,
      shape: `${err.method} ${normalizeRequestPath(err.url)}`,
    });
  }
  for (const message of signals.dialogs) {
    if (message.includes(XSS_MARKER)) {
      results.push({ category: "xss-dialog", message: `Injected script executed: ${message}` });
    }
  }
  if (signals.crashed) results.push({ category: "crash", message: "Page crashed" });
  if (blankRender) results.push({ category: "blank-render", message: "Page rendered no visible content" });
  return results;
}

/** Compact summary of signals for the model's state. */
export function summarizeSignals(signals: Signals) {
  return {
    consoleErrors: signals.consoleErrors.slice(0, 5).map(firstLine),
    uncaughtExceptions: signals.pageErrors.slice(0, 5).map(firstLine),
    failedRequests: signals.httpErrors.slice(0, 10).map((e) => `${e.method} ${e.url} -> ${e.status}`),
  };
}

function firstLine(text: string): string {
  return (text.split("\n")[0] ?? "").slice(0, 300);
}
