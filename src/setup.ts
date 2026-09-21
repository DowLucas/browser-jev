import type { Locator, Page } from "playwright";

/**
 * Setup steps: a short script run before each session to reach state that exploration alone would
 * not (an item in the cart, a draft half-filled). One step per line, targets by role and accessible
 * name like the explorer, so it survives restyling and can be written by hand or recorded:
 *
 *   goto /products/3
 *   click button "Add to cart"
 *   fill textbox "Coupon" with "SAVE10"
 *   select combobox "Size" option "M"
 *   press Enter
 *   wait for "Added to cart"
 *   back
 *
 * A target is `<role> "<name>"`, or just `"<text>"` (visible text for click, the field's label for
 * fill and select), optionally followed by `nth <k>` (1-based) when several elements match.
 */
export type SetupStep =
  | { kind: "goto"; url: string }
  | { kind: "click"; target: SetupTarget }
  | { kind: "fill"; target: SetupTarget; value: string }
  | { kind: "select"; target: SetupTarget; value: string }
  | { kind: "press"; key: string }
  | { kind: "wait-for"; text: string }
  | { kind: "back" };

export interface SetupTarget {
  /** ARIA role; absent means match by visible text (click) or label (fill, select). */
  role?: SetupRole;
  name: string;
  /** 1-based, when several elements match. */
  nth?: number;
}

export const SETUP_ROLES = [
  "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "tab", "menuitem",
  "option", "spinbutton", "slider", "listbox", "treeitem", "row", "cell", "heading",
] as const;
export type SetupRole = (typeof SETUP_ROLES)[number];

export const MAX_SETUP_STEPS = 50;
const KEY = /^(?:(?:Shift|Control|Alt|Meta)\+)*(?:Enter|Escape|Tab|Backspace|Delete|Space|Arrow(?:Up|Down|Left|Right)|Home|End|PageUp|PageDown|[A-Za-z0-9])$/;

export class SetupParseError extends Error {}

/** Parse setup text (or lines); blank lines and `#` comments are skipped. Errors name the line. */
export function parseSetup(source: string | readonly string[]): SetupStep[] {
  const lines = typeof source === "string" ? source.split(/\r?\n/) : source;
  const steps: SetupStep[] = [];
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    try {
      steps.push(parseLine(line));
    } catch (err) {
      throw new SetupParseError(`Setup line ${i + 1} ("${line.length > 60 ? `${line.slice(0, 57)}...` : line}"): ${(err as Error).message}`);
    }
  });
  if (steps.length > MAX_SETUP_STEPS) throw new SetupParseError(`Setup has ${steps.length} steps; at most ${MAX_SETUP_STEPS}`);
  return steps;
}

type Token = { quoted: boolean; text: string };

function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  const re = /\s*("(?:[^"\\]|\\.)*"|\S+)/gy;
  let m: RegExpExecArray | null;
  // A failed sticky match resets lastIndex to 0, so track how far the matches got.
  let consumed = 0;
  while ((m = re.exec(line)) && m[1] !== undefined) {
    consumed = re.lastIndex;
    const t = m[1];
    if (t.startsWith('"')) {
      if (t.length < 2 || !t.endsWith('"')) throw new Error("unclosed quote");
      tokens.push({ quoted: true, text: JSON.parse(t) as string });
    } else if (t.includes('"')) {
      throw new Error(`stray quote in ${t}`);
    } else {
      tokens.push({ quoted: false, text: t });
    }
  }
  if (line.slice(consumed).trim()) throw new Error("unclosed quote");
  return tokens;
}

function parseLine(line: string): SetupStep {
  const tokens = tokenize(line);
  const word = (i: number) => (tokens[i] && !tokens[i]!.quoted ? tokens[i]!.text : undefined);
  const command = word(0)?.toLowerCase();
  let pos = 1;
  const quoted = (what: string) => {
    const t = tokens[pos];
    if (!t?.quoted) throw new Error(`expected ${what} in "double quotes"`);
    pos++;
    return t.text;
  };
  const keyword = (kw: string) => {
    if (word(pos)?.toLowerCase() !== kw) throw new Error(`expected "${kw}"`);
    pos++;
  };
  const target = (): SetupTarget => {
    let role: SetupRole | undefined;
    const first = word(pos);
    if (first !== undefined) {
      if (!SETUP_ROLES.includes(first as SetupRole)) throw new Error(`unknown role "${first}" (use one of ${SETUP_ROLES.join(", ")}, or just "text")`);
      role = first as SetupRole;
      pos++;
    }
    const name = quoted(role ? `the ${role}'s name` : "the text or label");
    if (!name.trim()) throw new Error("the name is empty");
    let nth: number | undefined;
    if (word(pos)?.toLowerCase() === "nth") {
      pos++;
      nth = Number(word(pos));
      if (!Number.isInteger(nth) || nth < 1) throw new Error("nth needs a whole number from 1");
      pos++;
    }
    return { ...(role ? { role } : {}), name, ...(nth ? { nth } : {}) };
  };
  const done = <T extends SetupStep>(step: T): T => {
    if (pos < tokens.length) throw new Error(`unexpected "${tokens[pos]!.text}"`);
    return step;
  };

  switch (command) {
    case "goto": {
      const url = word(1) ?? tokens[1]?.text;
      if (!url) throw new Error("goto needs a URL or a path");
      if (!/^(https?:\/\/|\/)/.test(url)) throw new Error("goto needs an http(s) URL or a path starting with /");
      pos = 2;
      return done({ kind: "goto", url });
    }
    case "click":
      return done({ kind: "click", target: target() });
    case "fill": {
      const t = target();
      keyword("with");
      return done({ kind: "fill", target: t, value: quoted("the value") });
    }
    case "select": {
      const t = target();
      keyword("option");
      return done({ kind: "select", target: t, value: quoted("the option") });
    }
    case "press": {
      const key = word(1);
      if (!key || !KEY.test(key)) throw new Error("press needs a key such as Enter, Escape, Tab or ArrowDown");
      pos = 2;
      return done({ kind: "press", key });
    }
    case "wait": {
      keyword("for");
      return done({ kind: "wait-for", text: quoted("the text to wait for") });
    }
    case "back":
      return done({ kind: "back" });
    default:
      throw new Error(`unknown step "${word(0) ?? tokens[0]?.text ?? ""}" (use goto, click, fill, select, press, wait for, back)`);
  }
}

/** The line that parses back to `step`; the recorder writes these. */
export function formatStep(step: SetupStep): string {
  const q = (s: string) => JSON.stringify(s);
  const t = (x: SetupTarget) => `${x.role ? `${x.role} ` : ""}${q(x.name)}${x.nth ? ` nth ${x.nth}` : ""}`;
  switch (step.kind) {
    case "goto":
      return `goto ${step.url}`;
    case "click":
      return `click ${t(step.target)}`;
    case "fill":
      return `fill ${t(step.target)} with ${q(step.value)}`;
    case "select":
      return `select ${t(step.target)} option ${q(step.value)}`;
    case "press":
      return `press ${step.key}`;
    case "wait-for":
      return `wait for ${q(step.text)}`;
    case "back":
      return "back";
  }
}

/** Names and URLs a step would touch, for the forbidden-controls check. */
export function stepSubjects(step: SetupStep): string[] {
  switch (step.kind) {
    case "goto":
      return [step.url];
    case "click":
    case "fill":
    case "select":
      return [step.target.name];
    default:
      return [];
  }
}

export function resolveSetupUrl(url: string, startUrl: string): string {
  return new URL(url, startUrl).href;
}

function locate(page: Page, step: { kind: string; target: SetupTarget }): Locator {
  const { role, name, nth } = step.target;
  const all = role
    ? page.getByRole(role, { name, exact: true })
    : step.kind === "click"
      ? page.getByText(name, { exact: true })
      : page.getByLabel(name, { exact: true });
  return nth ? all.nth(nth - 1) : all.first();
}

/** Run one step. Throws with a message fit for a report when the step cannot be done. */
export async function runSetupStep(page: Page, step: SetupStep, startUrl: string, timeout: number): Promise<void> {
  switch (step.kind) {
    case "goto":
      await page.goto(resolveSetupUrl(step.url, startUrl), { timeout: timeout * 3 });
      return;
    case "click":
      await locate(page, step).click({ timeout });
      return;
    case "fill":
      await locate(page, step).fill(step.value, { timeout });
      return;
    case "select":
      await locate(page, step).selectOption(step.value, { timeout });
      return;
    case "press":
      await page.keyboard.press(step.key);
      return;
    case "wait-for":
      await page.getByText(step.text).first().waitFor({ state: "visible", timeout: timeout * 2 });
      return;
    case "back":
      await page.goBack({ timeout });
      return;
  }
}
