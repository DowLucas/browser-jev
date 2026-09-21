import type { Locator, Page } from "playwright";
import { TARGET_ATTR, type InteractiveElement } from "./page-model.ts";
import type { Persona } from "./personas.ts";
import { XSS_MARKER } from "./signals.ts";

export type ActionKind =
  | "click"
  | "dblclick"
  | "click-and-leave"
  | "fill"
  | "select"
  | "back"
  | "forward"
  | "reload"
  | "goto"
  | "press"
  | "wait";

export interface Action {
  kind: ActionKind;
  /** TARGET_ATTR value of the element acted on. */
  target?: string;
  role?: string;
  name?: string;
  href?: string;
  value?: string;
  /** Human label for `value`, e.g. "600 chars"; keeps descriptions and fingerprints short. */
  valueLabel?: string;
  url?: string;
  /** For "press": the key, e.g. "Enter". */
  key?: string;
  /** For a "goto" that edits a URL on purpose: what was changed, e.g. "id 7 -> 999999999". */
  tamper?: string;
  /** A "#section" link on the current page: it scrolls, so an unchanged page is expected. */
  inPage?: boolean;
}

interface FillValue {
  label: string;
  value: string;
}

const ADVERSARIAL_INPUTS: FillValue[] = [
  { label: "emoji", value: "😀🔥👩‍👩‍👧‍👦 test ✨" },
  { label: "non-Latin", value: "Ωμέγα 日本語 مرحبا עברית" },
  { label: "600 chars", value: "A".repeat(600) },
  { label: "empty", value: "" },
  { label: "whitespace only", value: "   " },
  { label: "SQL-shaped", value: "' OR '1'='1'; --" },
  { label: "HTML-shaped", value: `<img src=x onerror=alert('${XSS_MARKER}')>` },
  { label: "negative number", value: "-1" },
];

/** Edge values per input type. Each is a value the browser accepts for that type, so fill() succeeds. */
const BOUNDARY_INPUTS: Record<string, FillValue[]> = {
  number: [
    { label: "zero", value: "0" },
    { label: "negative number", value: "-1" },
    { label: "fraction", value: "0.5" },
    { label: "huge number", value: "99999999999999999999" },
    { label: "leading zeros", value: "007" },
  ],
  date: [
    { label: "leap day", value: "2024-02-29" },
    { label: "year 0001", value: "0001-01-01" },
    { label: "year 9999", value: "9999-12-31" },
  ],
  email: [
    { label: "minimal email", value: "a@b" },
    { label: "uppercase email", value: "JEV.TESTER@EXAMPLE.TEST" },
    { label: "254-char email", value: `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(57)}.test` },
  ],
  text: [
    { label: "one character", value: "a" },
    { label: "256 chars", value: "B".repeat(256) },
    { label: "surrounding spaces", value: "  padded value  " },
    { label: "literal null", value: "null" },
    { label: "zero", value: "0" },
  ],
};

const PLAUSIBLE_INPUTS: Record<string, string> = {
  email: "jev.tester@example.test",
  number: "2",
  tel: "+46 70 123 45 67",
  url: "https://example.test",
  date: "2026-01-15",
  password: "Test-password-1",
  search: "test",
};

export interface CandidateContext {
  persona: Persona;
  elements: InteractiveElement[];
  /** The page the elements are on; links back to it are left out. */
  currentUrl: string;
  /** Whether a URL belongs to the app under test; links elsewhere are not followed. */
  isInApp: (url: string) => boolean;
  /** Whether a URL is inside the run's focus area; links and direct entries elsewhere are not offered. */
  inFocus?: (url: string) => boolean;
  /** Offer "browser forward" only when there is somewhere to go forward to. */
  canGoForward: boolean;
  /** The page is still working on the last action (a request or loading indicator): offer to wait for it. */
  pageBusy?: boolean;
  /** URLs visited in this session, oldest first. */
  visited: string[];
  isForbidden: (text: string) => boolean;
  maxActions: number;
  random: () => number;
}

/** Enumerate what can be done from here, shaped by persona, with forbidden controls removed. */
export function candidateActions(ctx: CandidateContext): { actions: Action[]; skipped: number } {
  const actions: Action[] = [];
  let skipped = 0;
  const has = (t: Persona["traits"][number]) => ctx.persona.traits.includes(t);
  const inFocus = ctx.inFocus ?? (() => true);

  const here = withoutHash(ctx.currentUrl);
  for (const el of ctx.elements) {
    if (ctx.isForbidden(el.name) || (el.href && ctx.isForbidden(el.href))) {
      skipped++;
      continue;
    }
    // A covered control cannot be clicked; the cover itself is reported as a finding.
    if (el.coveredBy) continue;
    // Links out of the app (stores, social, mailto:) are blocked or open a tab we close: they
    // test nothing here and read as "the click did nothing".
    if (el.href !== undefined && !ctx.isInApp(el.href)) continue;
    // Leaving the focus area would only get the session sent back to the entry page.
    if (el.href !== undefined && !inFocus(el.href)) continue;
    const inPage = el.href !== undefined && withoutHash(el.href) === here;
    // A link to the page we are on tests nothing and reads as "the click did nothing".
    if (inPage && (!new URL(el.href!).hash || el.href === ctx.currentUrl)) continue;
    const base = { target: el.id, role: el.role, name: el.name, href: el.href, ...(inPage ? { inPage } : {}) };
    switch (el.role) {
      case "textbox":
        for (const v of fillValues(ctx.persona, el.inputType, ctx.random)) {
          actions.push({ ...base, kind: "fill", value: v.value, valueLabel: v.label });
        }
        // Enter in a field is how keyboard users submit a form.
        if (has("keyboard")) actions.push({ ...base, kind: "press", key: "Enter" });
        break;
      case "combobox":
        for (const option of el.options ?? []) {
          actions.push({ ...base, kind: "select", value: option, valueLabel: option });
        }
        break;
      case "button":
        actions.push({ ...base, kind: "click" });
        // Double submits and navigate-away races live on submit buttons. On a toggle, a
        // double-click just restores the original state, which reads as "did nothing".
        if (has("double-submit") && el.submit) {
          actions.push({ ...base, kind: "dblclick" }, { ...base, kind: "click-and-leave" });
        }
        if (has("keyboard")) actions.push({ ...base, kind: "press", key: "Enter" });
        break;
      default:
        actions.push({ ...base, kind: "click" });
        // A control built from a div with a click handler does nothing on Enter: a real bug.
        if (has("keyboard") && (el.role === "link" || el.role === "tab" || el.role === "menuitem")) {
          actions.push({ ...base, kind: "press", key: "Enter" });
        }
    }
  }

  actions.push({ kind: "back" }, { kind: "reload" });
  if (ctx.pageBusy) actions.push({ kind: "wait" });
  if (has("keyboard")) actions.push({ kind: "press", key: "Escape" });
  if (has("history")) {
    if (ctx.canGoForward) actions.push({ kind: "forward" });
    for (const url of new Set(ctx.visited.slice(-8))) if (inFocus(url)) actions.push({ kind: "goto", url });
  }
  if (has("url-tamper")) {
    const tampered = shuffle(tamperedUrls(ctx.currentUrl), ctx.random).slice(0, MAX_TAMPERED);
    for (const t of tampered) if (ctx.isInApp(t.url) && inFocus(t.url)) actions.push({ kind: "goto", url: t.url, tamper: t.change });
  }

  return { actions: capActions(actions, ctx.maxActions, ctx.random), skipped };
}

function withoutHash(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href;
  } catch {
    return url;
  }
}

function fillValues(persona: Persona, inputType = "text", random: () => number): FillValue[] {
  const values = [{ label: "plausible", value: PLAUSIBLE_INPUTS[inputType] ?? "Test input" }];
  if (persona.traits.includes("adversarial-input")) values.push(...shuffle(ADVERSARIAL_INPUTS, random).slice(0, 4));
  if (persona.traits.includes("boundary-input")) {
    // Types without their own edge set (tel, url, search) get the text ones, which they all accept.
    const edges = BOUNDARY_INPUTS[inputType] ?? (inputType === "date" || inputType === "number" ? [] : BOUNDARY_INPUTS.text!);
    values.push(...shuffle(edges, random).slice(0, 4));
  }
  return values;
}

/** Tampered URLs offered per step; each is a full page load, so a few is plenty. */
const MAX_TAMPERED = 4;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Edits of the current URL that a curious user makes in the address bar: ids moved to a neighbour,
 * zero or a huge value, query values emptied or made negative, and the parent path.
 */
export function tamperedUrls(current: string): { url: string; change: string }[] {
  let base: URL;
  try {
    base = new URL(current);
  } catch {
    return [];
  }
  base.hash = "";
  const out = new Map<string, string>();
  const add = (edit: (u: URL) => void, change: string) => {
    const u = new URL(base.href);
    edit(u);
    if (u.href !== base.href && !out.has(u.href)) out.set(u.href, change);
  };
  const segments = base.pathname.split("/");
  segments.forEach((seg, i) => {
    const setSeg = (value: string) => (u: URL) => {
      const copy = [...segments];
      copy[i] = value;
      u.pathname = copy.join("/");
    };
    if (/^\d+$/.test(seg)) {
      const n = BigInt(seg);
      add(setSeg(String(n + 1n)), `id ${seg} -> ${n + 1n}`);
      if (n > 0n) add(setSeg(String(n - 1n)), `id ${seg} -> ${n - 1n}`);
      add(setSeg("0"), `id ${seg} -> 0`);
      add(setSeg("999999999"), `id ${seg} -> 999999999`);
      add(setSeg("-1"), `id ${seg} -> -1`);
    } else if (UUID.test(seg)) {
      add(setSeg("00000000-0000-0000-0000-000000000000"), "uuid -> all zeros");
      add(setSeg(seg.slice(0, -1)), "uuid truncated");
    }
  });
  const parent = segments.filter(Boolean);
  if (parent.length > 1) add((u) => (u.pathname = `/${parent.slice(0, -1).join("/")}`), "parent path");
  for (const [key, value] of base.searchParams) {
    add((u) => u.searchParams.set(key, ""), `?${key} emptied`);
    if (/^\d+$/.test(value)) {
      add((u) => u.searchParams.set(key, "-1"), `?${key}=${value} -> -1`);
      add((u) => u.searchParams.set(key, "999999999"), `?${key}=${value} -> 999999999`);
    } else {
      add((u) => u.searchParams.set(key, "jev-unknown"), `?${key} -> unknown value`);
    }
  }
  return [...out].map(([url, change]) => ({ url, change }));
}

/** Keep navigation actions, sample the rest, so the choice stays within the question limit. */
function capActions(actions: Action[], max: number, random: () => number): Action[] {
  if (actions.length <= max) return actions;
  const nav = actions.filter((a) => !a.target);
  const targeted = shuffle(
    actions.filter((a) => a.target),
    random,
  ).slice(0, max - nav.length);
  return [...targeted, ...nav];
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}

export function describeAction(a: Action): string {
  const target = a.role ? `${a.role} "${a.name ?? ""}"` : "";
  switch (a.kind) {
    case "fill":
      return `fill ${target} with ${a.valueLabel ?? "text"} input`;
    case "select":
      return `select "${a.valueLabel}" in ${target}`;
    case "click-and-leave":
      return `click ${target} and immediately navigate back`;
    case "goto":
      return a.tamper ? `enter edited URL (${a.tamper}): ${a.url}` : `enter URL directly: ${a.url}`;
    case "press":
      return a.target ? `press ${a.key} on ${target}` : `press ${a.key}`;
    case "wait":
      return "wait for the page to finish responding";
    case "back":
    case "forward":
    case "reload":
      return `browser ${a.kind}`;
    default:
      return `${a.kind} ${target}`;
  }
}

/** Stable identity of an action, independent of step-local ids and digits in names. */
export function actionSignature(a: Action): string {
  const name = (a.name ?? "").toLowerCase().replace(/\d+/g, "#");
  return [a.kind, a.role ?? "", name, a.valueLabel ?? a.key ?? a.tamper?.replace(/\d+/g, "#") ?? "", a.url && !a.tamper ? new URL(a.url).pathname : ""].join("|");
}

const NAVIGATION_KINDS: ReadonlySet<ActionKind> = new Set(["back", "forward", "reload", "goto"]);

/**
 * The trigger as it goes into a fingerprint. Every way of merely arriving at a page (back, reload,
 * direct entry, following a link) collapses to one key, so a bug on load is one finding, not five.
 */
export function triggerKey(a: Action | undefined): string {
  // Enter on a link and an edited URL are ways of arriving too; the finding's trigger text keeps which.
  const followsLink = (a?.kind === "click" || a?.kind === "press") && a.role === "link";
  if (!a || NAVIGATION_KINDS.has(a.kind) || followsLink) return "navigate";
  return actionSignature(a);
}

export interface ActionFailure {
  summary: string;
  /** Accessible name of the element that caught the click, when an overlay was in the way. */
  interceptedBy?: string;
}

/**
 * Make an action error explain itself. Playwright's call log names the element that intercepted a
 * click ("<button aria-label=\"Accept cookies\" ...>Accept</button> ... intercepts pointer events"),
 * which is a real finding: something visibly covers a control the user wants to press.
 */
export function explainActionFailure(err: Error): ActionFailure {
  const summary = err.message.split("\n")[0] ?? err.message;
  const line = err.message.split("\n").findLast((l) => l.includes("intercepts pointer events"));
  if (!line) return { summary };
  const tag = line.match(/<[a-z][^>]*>([^<]*)/i);
  const attr = (name: string) => tag?.[0].match(new RegExp(`${name}="([^"]+)"`))?.[1];
  // Playwright abbreviates an element's children to "…", which names nothing.
  const text = tag?.[1]?.replace(/…/g, "").trim() || undefined;
  const interceptedBy = (attr("aria-label") ?? text ?? attr("id") ?? tag?.[0].slice(0, 60) ?? "unknown")
    .replace(/\s+/g, " ")
    .slice(0, 80);
  return { summary: `the click was blocked by an overlapping element "${interceptedBy}"`, interceptedBy };
}

/** The element this step chose is gone: the page re-rendered between choosing and clicking. */
export class StaleTargetError extends Error {}

const ARIA_ROLES = new Set(["link", "button", "textbox", "combobox", "checkbox", "radio", "tab", "menuitem", "switch", "option"]);

/**
 * The stamped element if it still exists; frameworks that re-render or hydrate replace DOM nodes
 * and drop our stamp, so fall back to the same role and exact accessible name. If neither exists,
 * the target really is gone, which is a harness timing issue, not an app failure.
 */
async function resolveTarget(page: Page, a: Action): Promise<Locator> {
  const stamped = page.locator(`[${TARGET_ATTR}="${a.target}"]`);
  const byRole =
    a.role && ARIA_ROLES.has(a.role) && a.name
      ? page.getByRole(a.role as Parameters<Page["getByRole"]>[0], { name: a.name, exact: true }).first()
      : undefined;
  for (const candidate of [stamped, byRole]) {
    if (!candidate || !(await candidate.count())) continue;
    // Playwright scrolls a target just into view, which can leave it under a sticky header; a
    // user would scroll it to where they can see it.
    await candidate.evaluate((el) => el.scrollIntoView({ block: "center", inline: "center" })).catch(() => {});
    return candidate;
  }
  throw new StaleTargetError(`${describeAction(a)}: the element re-rendered before the click and no longer exists`);
}

export async function executeAction(page: Page, a: Action, timeout: number): Promise<void> {
  const target = () => resolveTarget(page, a);
  switch (a.kind) {
    case "click":
      return (await target()).click({ timeout });
    case "dblclick":
      return (await target()).dblclick({ timeout });
    case "click-and-leave":
      await (await target()).click({ timeout });
      await page.goBack({ waitUntil: "commit", timeout });
      return;
    case "fill":
      return (await target()).fill(a.value ?? "", { timeout });
    case "select":
      await (await target()).selectOption(a.value ?? "", { timeout });
      return;
    case "back":
      await page.goBack({ timeout });
      return;
    case "forward":
      await page.goForward({ timeout });
      return;
    case "reload":
      await page.reload({ timeout });
      return;
    case "goto":
      await page.goto(a.url ?? "", { timeout });
      return;
    case "press":
      if (a.target) await (await target()).press(a.key ?? "Enter", { timeout });
      else await page.keyboard.press(a.key ?? "Escape");
      return;
    case "wait":
      // The session does the waiting, with the long settle; there is nothing to do on the page.
      return;
  }
}
