import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Page } from "playwright";
import { TARGET_ATTR } from "./page-model.ts";

/** How long the highlighted target stays visible, relative to the slow-mo delay. */
const HIGHLIGHT_FACTOR = 2;

/**
 * Banner and outline for a human watching. The banner lives in a closed shadow root marked
 * aria-hidden, so it never appears in the ARIA snapshot or in the enumerated actions.
 * Shipped as source text for the same reason as the enumeration script (see page-model.ts).
 */
const SHOW_SCRIPT = String.raw`({ attr, target, text }) => {
  const HOST_ID = "__jev_watch";
  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:2147483647;pointer-events:none;";
    const root = host.attachShadow({ mode: "closed" });
    const box = document.createElement("div");
    box.style.cssText =
      "font:13px/1.4 ui-monospace,monospace;background:#111;color:#fff;padding:8px 12px;" +
      "border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.4);max-width:560px;white-space:pre-wrap;";
    root.appendChild(box);
    host.__box = box;
    document.documentElement.appendChild(host);
  }
  host.__box.textContent = text;
  for (const el of document.querySelectorAll("[data-jev-highlight]")) {
    el.style.outline = el.dataset.jevHighlight;
    el.removeAttribute("data-jev-highlight");
  }
  const el = target && document.querySelector("[" + attr + '="' + target + '"]');
  if (el) {
    el.dataset.jevHighlight = el.style.outline;
    el.style.outline = "3px solid #ff3b7f";
    el.scrollIntoView({ block: "center", behavior: "instant" });
  }
}`;

export async function showNextAction(
  page: Page,
  text: string,
  target: string | undefined,
  slowMoMs: number,
): Promise<void> {
  await page
    .evaluate(`(${SHOW_SCRIPT})(${JSON.stringify({ attr: TARGET_ATTR, target, text })})`)
    .catch(() => {});
  await page.waitForTimeout(slowMoMs * HIGHLIGHT_FACTOR);
}

export interface WindowBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Tile `count` windows in a near-square grid over the screen; `index` picks the tile. */
export function tileBounds(index: number, count: number, screen: { width: number; height: number }): WindowBounds {
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const width = Math.floor(screen.width / cols);
  const height = Math.floor(screen.height / rows);
  return { left: (index % cols) * width, top: Math.floor(index / cols) * height, width, height };
}

/** Move and resize the page's browser window (Chromium only, via CDP). */
export async function placeWindow(page: Page, bounds: WindowBounds): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const { windowId } = await cdp.send("Browser.getWindowForTarget");
  await cdp.send("Browser.setWindowBounds", { windowId, bounds: { ...bounds, windowState: "normal" } });
  await cdp.detach();
}

/** Screen size from xrandr; falls back to 1920x1080 when it cannot be read. */
export async function detectScreen(): Promise<{ width: number; height: number }> {
  try {
    const { stdout } = await promisify(execFile)("xrandr", ["--current"]);
    const m = stdout.match(/current (\d+) x (\d+)/);
    if (m) return { width: Number(m[1]), height: Number(m[2]) };
  } catch {
    // No xrandr (e.g. macOS or Wayland without XWayland): use the fallback.
  }
  return { width: 1920, height: 1080 };
}
