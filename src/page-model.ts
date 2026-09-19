import type { Page } from "playwright";

export const TARGET_ATTR = "data-jev-id";

export type ElementRole =
  | "link"
  | "button"
  | "textbox"
  | "combobox"
  | "checkbox"
  | "radio"
  | "tab"
  | "menuitem"
  | "switch"
  | "option";

export interface InteractiveElement {
  /** Value of the TARGET_ATTR attribute stamped on the element for this step. */
  id: string;
  role: ElementRole;
  name: string;
  /** For textboxes: the input type (email, number, ...). */
  inputType?: string;
  href?: string;
  /** For comboboxes: the option values. */
  options?: string[];
}

/**
 * In-page enumeration, shipped as source text: a transpiled function would carry bundler helpers
 * (e.g. esbuild's `__name`) that do not exist inside the page.
 */
const ENUMERATE_SCRIPT = String.raw`(attr) => {
  const SELECTOR = [
    "a[href]", "button", "input:not([type=hidden]):not([type=file])", "select", "textarea", "summary",
    "[role=button]", "[role=link]", "[role=tab]", "[role=menuitem]", "[role=checkbox]", "[role=switch]",
    "[role=option]", "[contenteditable='']", "[contenteditable=true]",
  ].join(",");

  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "select") return "combobox";
    if (tag === "textarea" || el.hasAttribute("contenteditable")) return "textbox";
    if (tag === "input") {
      if (["submit", "button", "reset", "image"].includes(el.type)) return "button";
      if (el.type === "checkbox" || el.type === "radio") return el.type;
      return "textbox";
    }
    return "button";
  };

  const text = (s) => (s || "").replace(/\s+/g, " ").trim();
  // Only the label's own text: a wrapping label also contains the control (and a select's options).
  const labelText = (label) =>
    label ? [...label.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join(" ") : "";
  const nameOf = (el) => {
    const labelledBy = el.getAttribute("aria-labelledby");
    const fromLabelledBy = labelledBy
      ? labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent).join(" ")
      : "";
    return text(
      el.getAttribute("aria-label") ||
        fromLabelledBy ||
        labelText(el.labels?.[0]) ||
        el.innerText ||
        el.getAttribute("placeholder") ||
        el.getAttribute("title") ||
        el.querySelector("img")?.getAttribute("alt") ||
        (["submit", "button"].includes(el.type) ? el.value : "") ||
        el.getAttribute("name"),
    ).slice(0, 80);
  };

  for (const el of document.querySelectorAll("[" + attr + "]")) el.removeAttribute(attr);

  const out = [];
  let i = 0;
  for (const el of document.querySelectorAll(SELECTOR)) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (rect.width === 0 || rect.height === 0) continue;
    if (style.visibility === "hidden" || style.display === "none") continue;
    if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;

    const id = "e" + i++;
    el.setAttribute(attr, id);
    const role = roleOf(el);
    out.push({
      id,
      role,
      name: nameOf(el),
      inputType: role === "textbox" ? el.type || "text" : undefined,
      href: el instanceof HTMLAnchorElement ? el.href : undefined,
      options: el instanceof HTMLSelectElement ? [...el.options].map((o) => o.value).slice(0, 10) : undefined,
    });
  }
  return out;
}`;

/**
 * Stamp every visible, enabled interactive element with a step-local id and describe it.
 * Ids are rewritten every step so stale ids never resolve.
 */
export async function enumerateElements(page: Page): Promise<InteractiveElement[]> {
  return page.evaluate(`(${ENUMERATE_SCRIPT})(${JSON.stringify(TARGET_ATTR)})`) as Promise<InteractiveElement[]>;
}

/** Semantic ARIA snapshot of the page: small, and stable across CSS changes. */
export async function ariaSnapshot(page: Page, maxChars: number): Promise<string> {
  const snapshot = await page.locator("body").ariaSnapshot({ timeout: 5_000 }).catch(() => "");
  return snapshot.length > maxChars ? `${snapshot.slice(0, maxChars)}\n... (truncated)` : snapshot;
}

/**
 * Fields the browser's native validation currently rejects. A blocked submit shows only a tooltip,
 * which the ARIA snapshot cannot see; without this, a correctly blocked submit looks like a dead button.
 */
export async function invalidFields(page: Page): Promise<string[]> {
  return page
    .evaluate(() =>
      [...document.querySelectorAll<HTMLInputElement>("input:invalid, select:invalid, textarea:invalid")]
        .slice(0, 10)
        .map((el) => `${el.labels?.[0]?.textContent?.trim() || el.name}: ${el.validationMessage}`),
    )
    .catch(() => []);
}

export async function isBlank(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const body = document.body;
      if (!body) return true;
      return body.innerText.trim().length === 0 && !body.querySelector("img, svg, canvas, video");
    })
    .catch(() => false);
}
