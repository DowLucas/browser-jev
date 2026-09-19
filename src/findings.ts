import { createHash } from "node:crypto";

export type Level = "fail" | "warn";

export interface Finding {
  fingerprint: string;
  category: string;
  source: "free" | "judgment";
  level: Level;
  message: string;
  url: string;
  /** Description of the action that led to this state ("start" for the initial load). */
  trigger: string;
  /** Normalized trigger used in the fingerprint (see `triggerKey`). */
  triggerKey: string;
  sessionId: string;
  persona: string;
  step: number;
  /** Action log up to and including the trigger, for reproduction. */
  actionLog: string[];
  /** What happened after the trigger, as the model was told ("the page did not change", ...). */
  observed?: string;
  /** Judgment details: yes-probability and expected severity (0-4). */
  confidence?: number;
  severity?: number;
  tracePath?: string;
}

export interface FindingGroup {
  fingerprint: string;
  level: Level;
  category: string;
  count: number;
  sessions: string[];
  /** The first occurrence, kept as the representative. */
  example: Finding;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Path with UUIDs, numeric ids and long hex ids collapsed, so /orders/17 and /orders/42 match. */
export function normalizePath(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return url;
  }
  return path
    .replace(UUID, ":uuid")
    .split("/")
    .map((seg) => (/^\d+$/.test(seg) ? ":id" : /^[0-9a-f]{12,}$/i.test(seg) ? ":hex" : seg))
    .join("/");
}

const STATIC_ASSET = /\.(js|mjs|css|map|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|avif|ico)$/i;

/**
 * Request path for grouping: normalizePath, plus build-hashed asset names collapsed to `*.ext`,
 * so `/_next/static/chunks/c1cf3-8a2e.js` and every other chunk in that folder are one shape.
 */
export function normalizeRequestPath(url: string): string {
  const path = normalizePath(url);
  if (!STATIC_ASSET.test(path)) return path;
  const slash = path.lastIndexOf("/");
  const ext = path.slice(path.lastIndexOf("."));
  return `${path.slice(0, slash + 1)}*${ext}`;
}

/** Fingerprint on the shape of a finding (category, normalized path, trigger), never on its text. */
export function fingerprint(parts: { category: string; url: string; triggerKey: string; shape?: string }): string {
  const key = [parts.category, normalizePath(parts.url), parts.triggerKey, parts.shape ?? ""].join("\n");
  return createHash("sha1").update(key).digest("hex").slice(0, 12);
}

export class FindingStore {
  readonly #groups = new Map<string, FindingGroup>();

  add(finding: Finding): void {
    const group = this.#groups.get(finding.fingerprint);
    if (!group) {
      this.#groups.set(finding.fingerprint, {
        fingerprint: finding.fingerprint,
        level: finding.level,
        category: finding.category,
        count: 1,
        sessions: [finding.sessionId],
        example: finding,
      });
      return;
    }
    group.count++;
    if (!group.sessions.includes(finding.sessionId)) group.sessions.push(finding.sessionId);
    if (finding.level === "fail" && group.level === "warn") {
      group.level = "fail";
      group.example = finding;
    }
  }

  groups(): FindingGroup[] {
    const rank = (g: FindingGroup) => (g.level === "fail" ? 0 : 1);
    return [...this.#groups.values()].sort((a, b) => rank(a) - rank(b) || b.count - a.count);
  }
}
