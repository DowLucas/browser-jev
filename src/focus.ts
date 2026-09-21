/**
 * Focus: point a run at one flow or area. The instructions steer the model; the paths are enforced in
 * code, so a session cannot wander off however the model chooses. The start URL is the entry point.
 */
export interface Focus {
  /** What to concentrate on, in words, e.g. "the checkout flow: cart, shipping, payment". */
  instructions?: string;
  /** Paths the run stays within; empty means the whole app. Exact ("/cart"), or "/checkout/*". */
  includePaths: string[];
  /** Paths the run never enters, even inside an included area. */
  excludePaths: string[];
}

export const NO_FOCUS: Focus = { includePaths: [], excludePaths: [] };
export const MAX_FOCUS_CHARS = 2000;

/** "/checkout/*" covers "/checkout" itself and everything below it, but not "/checkout-old". */
export function focusPathMatches(path: string, pattern: string): boolean {
  if (!pattern.endsWith("/*")) return path === pattern;
  const prefix = pattern.slice(0, -2);
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function inFocus(url: string, focus: Focus): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  if (focus.excludePaths.some((p) => focusPathMatches(path, p))) return false;
  return !focus.includePaths.length || focus.includePaths.some((p) => focusPathMatches(path, p));
}

export function hasFocus(focus: Focus): boolean {
  return !!focus.instructions || focus.includePaths.length > 0 || focus.excludePaths.length > 0;
}

/** One line for logs and reports. */
export function describeFocus(focus: Focus): string {
  if (!hasFocus(focus)) return "none (whole app)";
  const parts = [
    focus.instructions && `"${focus.instructions.length > 120 ? `${focus.instructions.slice(0, 117)}...` : focus.instructions}"`,
    focus.includePaths.length && `within ${focus.includePaths.join(", ")}`,
    focus.excludePaths.length && `never ${focus.excludePaths.join(", ")}`,
  ].filter(Boolean);
  return parts.join("; ");
}

/** Normalize and check a focus from a config file, the API or the UI. */
export function validateFocus(value: unknown, startUrl: string): Focus {
  if (value === undefined) return NO_FOCUS;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("focus must be an object { instructions, includePaths, excludePaths }");
  }
  const { instructions, includePaths = [], excludePaths = [], ...rest } = value as Record<string, unknown>;
  const extra = Object.keys(rest);
  if (extra.length) throw new Error(`Unknown focus field(s): ${extra.join(", ")}`);
  if (instructions !== undefined && typeof instructions !== "string") throw new Error("focus.instructions must be a string");
  if (typeof instructions === "string" && instructions.length > MAX_FOCUS_CHARS) {
    throw new Error(`focus.instructions exceeds ${MAX_FOCUS_CHARS} characters`);
  }
  for (const [key, list] of [["includePaths", includePaths], ["excludePaths", excludePaths]] as const) {
    if (!Array.isArray(list) || !list.every((p) => typeof p === "string")) throw new Error(`focus.${key} must be an array of paths`);
    const bad = list.find((p) => !p.startsWith("/"));
    if (bad !== undefined) throw new Error(`Focus path "${bad}" must start with "/" (e.g. /checkout or /checkout/*)`);
  }
  const focus: Focus = {
    ...(typeof instructions === "string" && instructions.trim() ? { instructions: instructions.trim() } : {}),
    includePaths: includePaths as string[],
    excludePaths: excludePaths as string[],
  };
  // Sessions return to the start URL whenever they leave the area, so it has to be inside it.
  if (!inFocus(startUrl, focus)) {
    throw new Error(
      `The start URL ${new URL(startUrl).pathname} is outside the focus paths. It is where every session ` +
        "starts and returns to, so start inside the area (or add its path to the focus paths).",
    );
  }
  return focus;
}
