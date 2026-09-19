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

export type BlockReason = "off-allowlist" | "write-in-read-only";

/**
 * Abort every request that leaves the allowlisted hosts, so nothing reaches third parties.
 * In read-only mode, also abort every write (POST, PUT, ...) so no form ever submits.
 * WebSockets bypass `route`, so they get their own handler: off-allowlist sockets are always
 * refused, and in read-only mode every socket is, since any message on one can be a write.
 */
export async function installNetworkFence(
  context: BrowserContext,
  opts: { allowedHosts: readonly string[]; readOnly: boolean },
  onBlocked: (url: string, reason: BlockReason) => void,
): Promise<void> {
  await context.route("**/*", (route) => {
    const request = route.request();
    const url = request.url();
    if (!isAllowedUrl(url, opts.allowedHosts)) {
      onBlocked(url, "off-allowlist");
      return route.abort("blockedbyclient");
    }
    if (opts.readOnly && !READ_METHODS.has(request.method())) {
      onBlocked(`${request.method()} ${url}`, "write-in-read-only");
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  await context.routeWebSocket(/.*/, (ws) => {
    const url = ws.url();
    if (!isAllowedUrl(url, opts.allowedHosts)) {
      onBlocked(url, "off-allowlist");
      return ws.close();
    }
    if (opts.readOnly) {
      onBlocked(`WEBSOCKET ${url}`, "write-in-read-only");
      return ws.close();
    }
    ws.connectToServer();
  });
}

export function forbiddenMatcher(patterns: readonly string[]): (text: string) => boolean {
  const res = patterns.map((p) => new RegExp(p, "i"));
  return (text) => res.some((re) => re.test(text));
}
