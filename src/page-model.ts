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
  /** A form's submit button: where double submits and navigate-away races matter. */
  submit?: boolean;
  /** For "#section" links on the current page: whether the target section exists. */
  anchor?: "ok" | "missing";
  /** Something that no scroll position can move out of the way sits on top of this control. */
  coveredBy?: string;
  /** The cover is an intentional modal dialog (the control is still unclickable, but not a bug). */
  coveredByModal?: boolean;
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
  const describe = (el) =>
    text(el.getAttribute("aria-label") || el.innerText || "").slice(0, 60) ||
    (el.id ? "#" + el.id : el.tagName.toLowerCase() + (el.classList[0] ? "." + el.classList[0] : ""));

  const pinned = (el) => {
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const pos = getComputedStyle(e).position;
      if (pos === "fixed" || pos === "sticky") return e;
    }
    return null;
  };
  const MODAL = "dialog[open], [aria-modal=true], [role=dialog], [role=alertdialog]";

  // Hidden without display:none: inside a collapsed accordion (height 0, overflow hidden), or
  // in inert / aria-hidden content. Its own box still has a size, so the rect check alone would
  // count it as clickable, and whatever sits on top would look like a covering bug. Scroll
  // containers (auto/scroll) do not hide anything: the user can scroll to it.
  const hiddenByAncestor = (el, rect) => {
    if (el.closest("[inert], [aria-hidden=true]")) return true;
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const st = getComputedStyle(a);
      const clips = (v) => v === "hidden" || v === "clip";
      if (!clips(st.overflowX) && !clips(st.overflowY)) continue;
      const r = a.getBoundingClientRect();
      const w = Math.min(rect.right, r.right) - Math.max(rect.left, r.left);
      const h = Math.min(rect.bottom, r.bottom) - Math.max(rect.top, r.top);
      if ((clips(st.overflowX) && w < 1) || (clips(st.overflowY) && h < 1)) return true;
    }
    return false;
  };
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - innerHeight);

  // Covered = the element that would receive a click at the control's center is unrelated to it,
  // and no scroll position moves the control out from under it (a sticky header over content you
  // can scroll past is fine; a fixed banner over the last footer links is not).
  const coverOf = (el, rect) => {
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    if (cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight) return null;
    const hit = document.elementFromPoint(cx, cy);
    if (!hit || hit === el || el.contains(hit) || hit.contains(el)) return null;
    const layer = pinned(hit);
    if (layer && !pinned(el)) {
      const c = layer.getBoundingClientRect();
      const docCy = cy + scrollY;
      const lo = Math.max(0, docCy - maxScroll);
      const hi = Math.min(innerHeight, docCy);
      const reachable = lo < c.top || hi > c.bottom;
      if (reachable) return null;
    }
    return { by: describe(layer || hit), modal: !!hit.closest(MODAL) };
  };

  const SUBMIT_NAME = /\b(save|send|submit|place|order|book|create|add|confirm|pay|register|sign ?up|apply|continue|next|spara|skicka|boka|skapa|bekr)/i;

  for (const el of document.querySelectorAll("[" + attr + "]")) el.removeAttribute(attr);

  const out = [];
  let i = 0;
  for (const el of document.querySelectorAll(SELECTOR)) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (rect.width === 0 || rect.height === 0) continue;
    if (style.visibility === "hidden" || style.display === "none") continue;
    if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
    if (hiddenByAncestor(el, rect)) continue;

    const id = "e" + i++;
    el.setAttribute(attr, id);
    const role = roleOf(el);
    const name = nameOf(el);
    const cover = coverOf(el, rect);
    let anchor;
    if (el instanceof HTMLAnchorElement && el.hash && el.pathname === location.pathname && el.origin === location.origin) {
      const target = decodeURIComponent(el.hash.slice(1));
      anchor = !target || document.getElementById(target) || document.getElementsByName(target).length ? "ok" : "missing";
    }
    out.push({
      id,
      role,
      name,
      inputType: role === "textbox" ? el.type || "text" : undefined,
      href: el instanceof HTMLAnchorElement ? el.href : undefined,
      options: el instanceof HTMLSelectElement ? [...el.options].map((o) => o.value).slice(0, 10) : undefined,
      submit: role === "button" && ((el.form && (el.type === "submit" || el.type === "image")) || SUBMIT_NAME.test(name)) || undefined,
      anchor,
      coveredBy: cover ? cover.by : undefined,
      coveredByModal: cover ? cover.modal : undefined,
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

export interface LayoutIssues {
  /** Pixels the page is wider than the viewport, and what sticks out. */
  horizontalOverflow?: { px: number; culprits: string[] };
  /** Text cut off by overflow:hidden without an ellipsis. */
  clipped: string[];
}

const LAYOUT_SCRIPT = String.raw`() => {
  const text = (s) => (s || "").replace(/\s+/g, " ").trim();
  const describe = (el) =>
    text(el.getAttribute("aria-label") || el.innerText || "").slice(0, 60) ||
    (el.id ? "#" + el.id : el.tagName.toLowerCase() + (el.classList[0] ? "." + el.classList[0] : ""));
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
  };

  const result = { clipped: [] };
  const root = document.documentElement;
  const bodyStyle = getComputedStyle(document.body);
  const overflowPx = root.scrollWidth - innerWidth;
  if (overflowPx > 1 && bodyStyle.overflowX !== "hidden" && getComputedStyle(root).overflowX !== "hidden") {
    const culprits = [];
    for (const el of document.body.querySelectorAll("*")) {
      if (culprits.length >= 3) break;
      const r = el.getBoundingClientRect();
      // The innermost element sticking out, not every ancestor that contains it.
      if (r.right > innerWidth + 1 && visible(el) && ![...el.children].some((c) => c.getBoundingClientRect().right > innerWidth + 1)) {
        culprits.push(describe(el));
      }
    }
    result.horizontalOverflow = { px: Math.round(overflowPx), culprits };
  }

  const TEXTY = "a, button, label, h1, h2, h3, h4, h5, h6, p, span, td, th, li, dt, dd";
  let checked = 0;
  for (const el of document.querySelectorAll(TEXTY)) {
    if (checked++ > 1500 || result.clipped.length >= 10) break;
    if (![...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim())) continue;
    const st = getComputedStyle(el);
    if (!["hidden", "clip"].includes(st.overflowX) || st.textOverflow === "ellipsis") continue;
    // Screen-reader-only text ("sr-only": a 1px box, clipped) is hidden on purpose.
    if (el.clientWidth <= 1 || el.clientHeight <= 1 || st.clip.startsWith("rect(0") || st.clipPath.startsWith("inset(50%")) continue;
    if (el.scrollWidth > el.clientWidth + 1 && visible(el)) result.clipped.push(describe(el));
  }
  return result;
}`;

/** Code-only layout checks: horizontal page overflow and clipped text. */
export async function layoutIssues(page: Page): Promise<LayoutIssues> {
  return (page.evaluate(`(${LAYOUT_SCRIPT})()`) as Promise<LayoutIssues>).catch(() => ({ clipped: [] }));
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
