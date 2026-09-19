import type { BrowserContext } from "playwright";
import type { Config } from "./config.ts";

export class SafetyError extends Error {}

/** Refuse to run unless the target is explicitly allowlisted and does not look like production. */
export function assertSafeTarget(cfg: Config): void {
  const host = new URL(cfg.startUrl).hostname;
  if (!cfg.allowedHosts.includes(host)) {
    throw new SafetyError(
      `Refusing to start: start URL host "${host}" is not in the allowlist [${cfg.allowedHosts.join(", ")}].`,
    );
  }
  const prodPatterns = cfg.productionPatterns.map((p) => new RegExp(p, "i"));
  for (const h of cfg.allowedHosts) {
    const hit = prodPatterns.find((re) => re.test(h));
    if (hit) {
      throw new SafetyError(
        `Refusing to start: allowlisted host "${h}" looks like production (matches /${hit.source}/). ` +
          "Run only against disposable staging.",
      );
    }
  }
}

export function isAllowedUrl(url: string, allowedHosts: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (["data:", "blob:", "about:"].includes(parsed.protocol)) return true;
  return allowedHosts.includes(parsed.hostname);
}

/** A page of the app under test: http(s) on an allowlisted host. */
export function isAppUrl(url: string, allowedHosts: readonly string[]): boolean {
  return /^https?:/.test(url) && isAllowedUrl(url, allowedHosts);
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * What may reach the server:
 * - observe: page loads and reads only; every write (POST, PUT, ..., WebSocket) is blocked
 * - observe-writes: as observe, plus writes to the listed paths (for apps that read via POST)
 * - interact: all writes; only for disposable environments, confirmed per run
 */
export const MODES = ["observe", "observe-writes", "interact"] as const;
export type Mode = (typeof MODES)[number];

export type BlockReason = "off-allowlist" | "write-blocked";

export interface WritePolicy {
  mode: Mode;
  /** For observe-writes: exact paths ("/entity"), or a prefix ending in "/*" ("/api/*"). */
  allowedWritePaths: readonly string[];
}

/**
 * Exact path match by default, so allowing "/counterparties" does not also allow
 * "/counterparties/create". A trailing "/*" allows everything below that path.
 */
export function writeAllowed(url: string, policy: WritePolicy): boolean {
  if (policy.mode === "interact") return true;
  if (policy.mode === "observe") return false;
  const path = new URL(url).pathname;
  return policy.allowedWritePaths.some((p) => (p.endsWith("/*") ? path.startsWith(p.slice(0, -1)) : path === p));
}

/**
 * Abort every request that leaves the allowlisted hosts, so nothing reaches third parties, and
 * every write the mode does not allow. WebSockets bypass `route`, so they get their own handler:
 * any message on one can be a write, so a socket is a write to its path.
 */
export async function installNetworkFence(
  context: BrowserContext,
  opts: WritePolicy & { allowedHosts: readonly string[] },
  onBlocked: (url: string, reason: BlockReason) => void,
  onWrite: (write: string) => void = () => {},
): Promise<void> {
  await context.route("**/*", (route) => {
    const request = route.request();
    const url = request.url();
    if (!isAllowedUrl(url, opts.allowedHosts)) {
      onBlocked(url, "off-allowlist");
      return route.abort("blockedbyclient");
    }
    if (!READ_METHODS.has(request.method())) {
      const write = `${request.method()} ${new URL(url).pathname}`;
      if (!writeAllowed(url, opts)) {
        onBlocked(write, "write-blocked");
        return route.abort("blockedbyclient");
      }
      onWrite(write);
    }
    return route.continue();
  });
  await context.routeWebSocket(/.*/, (ws) => {
    const url = ws.url();
    if (!isAllowedUrl(url, opts.allowedHosts)) {
      onBlocked(url, "off-allowlist");
      return ws.close();
    }
    const write = `WEBSOCKET ${new URL(url).pathname}`;
    if (!writeAllowed(url, opts)) {
      onBlocked(write, "write-blocked");
      return ws.close();
    }
    onWrite(write);
    ws.connectToServer();
  });
}

export function forbiddenMatcher(patterns: readonly string[]): (text: string) => boolean {
  const res = patterns.map((p) => new RegExp(p, "i"));
  return (text) => res.some((re) => re.test(text));
}
