import type { Locator, Page } from "playwright";
import { TARGET_ATTR, type InteractiveElement } from "./page-model.ts";
import type { PersonaName } from "./personas.ts";
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
  | "goto";

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
  persona: PersonaName;
  elements: InteractiveElement[];
  /** The page the elements are on; links back to it are left out. */
  currentUrl: string;
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

  const here = withoutHash(ctx.currentUrl);
  for (const el of ctx.elements) {
    if (ctx.isForbidden(el.name) || (el.href && ctx.isForbidden(el.href))) {
      skipped++;
      continue;
    }
    // A covered control cannot be clicked; the cover itself is reported as a finding.
    if (el.coveredBy) continue;
    const inPage = el.href !== undefined && withoutHash(el.href) === here;
    // A link to the page we are on tests nothing and reads as "the click did nothing".
    if (inPage && (!new URL(el.href!).hash || el.href === ctx.currentUrl)) continue;
    const base = { target: el.id, role: el.role, name: el.name, href: el.href, ...(inPage ? { inPage } : {}) };
    switch (el.role) {
      case "textbox":
        for (const v of fillValues(ctx.persona, el.inputType, ctx.random)) {
          actions.push({ ...base, kind: "fill", value: v.value, valueLabel: v.label });
        }
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
        if (ctx.persona === "impatient" && el.submit) {
          actions.push({ ...base, kind: "dblclick" }, { ...base, kind: "click-and-leave" });
        }
        break;
      default:
        actions.push({ ...base, kind: "click" });
    }
  }

  actions.push({ kind: "back" }, { kind: "reload" });
  if (ctx.persona === "out-of-order") {
    actions.push({ kind: "forward" });
    for (const url of new Set(ctx.visited.slice(-8))) actions.push({ kind: "goto", url });
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

function fillValues(persona: PersonaName, inputType = "text", random: () => number): FillValue[] {
  const plausible = { label: "plausible", value: PLAUSIBLE_INPUTS[inputType] ?? "Test input" };
  if (persona !== "sloppy") return [plausible];
  return [plausible, ...shuffle(ADVERSARIAL_INPUTS, random).slice(0, 4)];
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
      return `enter URL directly: ${a.url}`;
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
  return [a.kind, a.role ?? "", name, a.valueLabel ?? "", a.url ? new URL(a.url).pathname : ""].join("|");
}

const NAVIGATION_KINDS: ReadonlySet<ActionKind> = new Set(["back", "forward", "reload", "goto"]);

/**
 * The trigger as it goes into a fingerprint. Every way of merely arriving at a page (back, reload,
 * direct entry, following a link) collapses to one key, so a bug on load is one finding, not five.
 */
export function triggerKey(a: Action | undefined): string {
  if (!a || NAVIGATION_KINDS.has(a.kind) || (a.kind === "click" && a.role === "link")) return "navigate";
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
  }
}
