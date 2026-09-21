import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { Browser, BrowserContext, Page } from "playwright";
import { startScreencast } from "../live.ts";
import { BUILT_IN_PERSONAS } from "../personas.ts";
import { formatStep, SETUP_ROLES, type SetupRole, type SetupStep, type SetupTarget } from "../setup.ts";
import type { FairSlots, Slot } from "../slots.ts";
import { type AuthStateSummary, type JobStore, RequestError } from "./jobs.ts";

/** What the UI can do in a remote login browser. Coordinates are fractions (0-1) of the viewport. */
export type LoginInput =
  | { type: "click"; x: number; y: number }
  | { type: "type"; text: string }
  | { type: "key"; key: string }
  | { type: "scroll"; dy: number }
  | { type: "back" };

const VIEWPORT = { width: 1280, height: 800 };
/** An abandoned login browser is closed after this long without input. */
const IDLE_MS = 15 * 60_000;
const KEYS = new Set([
  "Enter",
  "Tab",
  "Shift+Tab",
  "Backspace",
  "Delete",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

interface LoginSession {
  id: string;
  context: BrowserContext;
  page: Page;
  slot: Slot;
  clients: Set<ServerResponse>;
  lastFrame?: string;
  stopScreencast: () => void;
  idle: NodeJS.Timeout;
  /** Set when the browser records setup steps instead of (or as well as) a login. */
  recording?: Recording;
}

interface Recording {
  /** Setup lines so far; comments explain what was left out. */
  lines: string[];
  /** The field the last line fills, so further typing updates that line instead of adding one. */
  fillKey?: string;
  origin: string;
}

/** Marks the element a recorded action is about, for the moment it takes to describe it. */
const REC_ATTR = "data-jev-rec";

/** Source text, like the other in-page scripts (see page-model.ts): no bundler helpers in the page. */
const STAMP_AT_POINT = String.raw`({ x, y, attr }) => {
  const el = document.elementFromPoint(x, y);
  if (!el) return false;
  const control = el.closest("a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab]," +
    "[role=menuitem],[role=checkbox],[role=radio],[role=switch],[role=option],[role=combobox],[role=textbox]");
  (control || el).setAttribute(attr, "");
  return true;
}`;
const STAMP_FOCUSED = String.raw`(attr) => {
  const el = document.activeElement;
  if (!el || el === document.body) return undefined;
  el.setAttribute(attr, "");
  const tag = el.tagName.toLowerCase();
  if (tag === "select") return { kind: "select", value: el.selectedOptions[0] ? el.selectedOptions[0].text.trim() : "" };
  return { kind: "fill", password: tag === "input" && el.type === "password", value: "value" in el ? el.value : el.textContent };
}`;

/**
 * Remote, interactive login browsers for a headless server: the UI shows the browser's screen and
 * forwards clicks and keys; when the user is logged in, the session's cookies and storage are saved
 * under a name that runs can use. Unlike runs, the login browser is not fenced to one host: single
 * sign-on redirects through identity providers on other domains.
 */
export class LoginManager {
  readonly #sessions = new Map<string, LoginSession>();

  constructor(
    private readonly browser: () => Promise<Browser>,
    private readonly slots: FairSlots,
    private readonly store: JobStore,
  ) {}

  /**
   * Open a remote browser on `url`. With `record`, what the user does becomes setup steps; with
   * `authState`, it starts signed in, so a flow behind a login can be recorded as that user.
   */
  async start(url: string, opts: { record?: boolean; authState?: string } = {}): Promise<{ id: string }> {
    // Same production and internal-address checks as a run on this URL.
    this.store.toConfig({ startUrl: url }, BUILT_IN_PERSONAS);
    const storageState = opts.authState ? this.store.authPath(opts.authState) : undefined;
    if (storageState && !(await this.store.authSummary(opts.authState!))) throw new RequestError(`No saved login "${opts.authState}"`);
    const slot = await this.slots.acquire("login");
    const context = await (await this.browser()).newContext({
      viewport: VIEWPORT,
      permissions: ["clipboard-read", "clipboard-write"],
      storageState,
    });
    const page = await context.newPage();
    const id = randomUUID();
    const session: LoginSession = {
      id,
      context,
      page,
      slot,
      clients: new Set(),
      stopScreencast: () => {},
      idle: setTimeout(() => void this.close(id), IDLE_MS),
    };
    if (opts.record) {
      const start = new URL(url);
      session.recording = { lines: [`goto ${start.pathname}${start.search}`], origin: start.origin };
    }
    this.#sessions.set(id, session);
    // Links that open a new tab (common on identity-provider buttons) stay in this one page.
    context.on("page", (popup) => {
      if (popup === page) return;
      const target = popup.url();
      void popup.close().catch(() => {});
      if (/^https?:/.test(target)) void page.goto(target).catch(() => {});
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) this.#broadcast(session, "meta", { url: frame.url() });
    });
    // Full resolution: a login form has to be readable, unlike a grid thumbnail.
    session.stopScreencast = await startScreencast(
      page,
      (jpeg) => {
        session.lastFrame = jpeg;
        this.#broadcast(session, "frame", { jpeg });
      },
      { maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height, quality: 80 },
    );
    await page.goto(url).catch(() => {});
    return { id };
  }

  subscribe(id: string, res: ServerResponse): boolean {
    const session = this.#sessions.get(id);
    if (!session) return false;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" });
    session.clients.add(res);
    res.on("close", () => session.clients.delete(res));
    write(res, "meta", { url: session.page.url(), viewport: VIEWPORT });
    if (session.lastFrame) write(res, "frame", { jpeg: session.lastFrame });
    if (session.recording) write(res, "steps", { lines: session.recording.lines });
    return true;
  }

  async input(id: string, input: LoginInput): Promise<void> {
    const session = this.#get(id);
    session.idle.refresh();
    const { page, recording } = session;
    switch (input?.type) {
      case "click": {
        if (!isFraction(input.x) || !isFraction(input.y)) throw new RequestError("click needs x and y between 0 and 1");
        const x = input.x * VIEWPORT.width;
        const y = input.y * VIEWPORT.height;
        // Describe the target before clicking: the click may navigate it away.
        if (recording) {
          const target = (await page.evaluate(`(${STAMP_AT_POINT})(${JSON.stringify({ x, y, attr: REC_ATTR })})`).catch(() => false)) ? await describeStamped(page) : undefined;
          // Clicking into a field only focuses it; the fill line that follows says which field.
          const focusOnly = target?.role === "textbox" || target?.role === "searchbox" || target?.role === "combobox";
          if (target && !focusOnly) this.#record(session, { kind: "click", target });
          else if (!target) this.#note(session, "# a click here was not recorded: nothing with a role, name or short text was under it");
        }
        return page.mouse.click(x, y);
      }
      case "type":
        if (typeof input.text !== "string" || input.text.length > 2000) throw new RequestError("type needs text up to 2000 characters");
        await page.keyboard.type(input.text);
        if (recording) await this.#recordFocusedValue(session);
        return;
      case "key":
        if (!KEYS.has(input.key)) throw new RequestError(`Unsupported key "${input.key}"`);
        await page.keyboard.press(input.key);
        if (recording) {
          if (["Backspace", "Delete", "ArrowUp", "ArrowDown"].includes(input.key)) await this.#recordFocusedValue(session);
          else if (input.key === "Enter" || input.key === "Escape") this.#record(session, { kind: "press", key: input.key });
        }
        return;
      case "scroll":
        if (typeof input.dy !== "number" || Math.abs(input.dy) > 5000) throw new RequestError("scroll needs dy up to ±5000");
        return page.mouse.wheel(0, input.dy);
      case "back":
        await page.goBack().catch(() => {});
        if (recording) this.#record(session, { kind: "back" });
        return;
      default:
        throw new RequestError("Unknown input type");
    }
  }

  /** Save the logged-in state under `name` and close the browser. */
  async save(id: string, name: string): Promise<AuthStateSummary> {
    const session = this.#get(id);
    this.store.authPath(name);
    const state = await session.context.storageState({ indexedDB: true });
    const summary = await this.store.saveAuthState(name, state);
    await this.close(id);
    return summary;
  }

  /** The setup lines recorded so far, as text for the run form. */
  steps(id: string): { steps: string } {
    const { recording } = this.#get(id);
    if (!recording) throw new RequestError("This browser is not recording setup steps");
    return { steps: `${recording.lines.join("\n")}\n` };
  }

  #record(session: LoginSession, step: SetupStep, fillKey?: string): void {
    const rec = session.recording!;
    const line = formatStep(step);
    if (fillKey && rec.fillKey === fillKey) rec.lines[rec.lines.length - 1] = line;
    else rec.lines.push(line);
    rec.fillKey = fillKey;
    this.#broadcast(session, "steps", { lines: rec.lines });
  }

  #note(session: LoginSession, comment: string): void {
    const rec = session.recording!;
    if (rec.lines.at(-1) !== comment) rec.lines.push(comment);
    rec.fillKey = undefined;
    this.#broadcast(session, "steps", { lines: rec.lines });
  }

  /** Typing into a field becomes one fill line with the field's current value, updated as typing goes on. */
  async #recordFocusedValue(session: LoginSession): Promise<void> {
    const { page } = session;
    const focused = (await page.evaluate(`(${STAMP_FOCUSED})(${JSON.stringify(REC_ATTR)})`).catch(() => undefined)) as
      | { kind: "fill" | "select"; password?: boolean; value: string }
      | undefined;
    if (!focused) return;
    const target = await describeStamped(page);
    if (!target) return this.#note(session, "# typing here was not recorded: the field has no role and name to find it by");
    const key = JSON.stringify(target);
    // Never write a password into a script: sign in with a saved login instead.
    if (focused.password) {
      return this.#note(session, `# not recorded: the password typed into ${formatStep({ kind: "click", target }).slice(6)}. Use a saved login to sign in.`);
    }
    if (focused.kind === "select") this.#record(session, { kind: "select", target, value: focused.value }, key);
    else this.#record(session, { kind: "fill", target, value: focused.value }, key);
  }

  async close(id: string): Promise<void> {
    const session = this.#sessions.get(id);
    if (!session) return;
    this.#sessions.delete(id);
    clearTimeout(session.idle);
    session.stopScreencast();
    for (const res of session.clients) {
      write(res, "closed", {});
      res.end();
    }
    await session.context.close().catch(() => {});
    session.slot.release();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#sessions.keys()].map((id) => this.close(id)));
  }

  /** Login and recording browsers open now. */
  get open(): number {
    return this.#sessions.size;
  }

  /** For tests: the page behind a login session. */
  pageOf(id: string): Page | undefined {
    return this.#sessions.get(id)?.page;
  }

  #get(id: string): LoginSession {
    const session = this.#sessions.get(id);
    if (!session) throw new RequestError("No such login session (it may have timed out)");
    return session;
  }

  #broadcast(session: LoginSession, event: string, data: unknown): void {
    for (const res of session.clients) write(res, event, data);
  }
}

const isFraction = (v: unknown) => typeof v === "number" && v >= 0 && v <= 1;

/**
 * Role and accessible name of the stamped element, as Playwright computes them (via its ARIA
 * snapshot), so a recorded line resolves to the same element on replay. Falls back to short visible
 * text. `nth` is added only when the name is ambiguous. Always removes the stamp.
 */
async function describeStamped(page: Page): Promise<SetupTarget | undefined> {
  const stamped = page.locator(`[${REC_ATTR}]`).first();
  const indexIn = (all: ReturnType<Page["getByRole"]>) =>
    all.evaluateAll((els, attr) => ({ at: els.findIndex((e) => e.hasAttribute(attr as string)), of: els.length }), REC_ATTR);
  try {
    const first = (await stamped.ariaSnapshot({ timeout: 1_000 })).split("\n")[0] ?? "";
    const m = first.match(/^- ([a-z]+) "((?:[^"\\]|\\.)*)"/);
    if (m && SETUP_ROLES.includes(m[1] as SetupRole)) {
      const role = m[1] as SetupRole;
      const name = unquote(m[2]!);
      const { at, of } = await indexIn(page.getByRole(role, { name, exact: true }));
      if (at >= 0) return { role, name, ...(of > 1 ? { nth: at + 1 } : {}) };
    }
    const text = (await stamped.innerText({ timeout: 1_000 })).trim().replace(/\s+/g, " ");
    if (text && text.length <= 80) {
      const { at, of } = await indexIn(page.getByText(text, { exact: true }));
      if (at >= 0) return { name: text, ...(of > 1 ? { nth: at + 1 } : {}) };
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    await page.evaluate((attr) => document.querySelectorAll(`[${attr}]`).forEach((e) => e.removeAttribute(attr)), REC_ATTR).catch(() => {});
  }
}

function unquote(s: string): string {
  try {
    return JSON.parse(`"${s}"`) as string;
  } catch {
    return s;
  }
}

function write(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
