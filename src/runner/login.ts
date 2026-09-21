import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { Browser, BrowserContext, Page } from "playwright";
import { startScreencast } from "../live.ts";
import { BUILT_IN_PERSONAS } from "../personas.ts";
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
}

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

  async start(url: string): Promise<{ id: string }> {
    // Same production and internal-address checks as a run on this URL.
    this.store.toConfig({ startUrl: url }, BUILT_IN_PERSONAS);
    const slot = await this.slots.acquire("login");
    const context = await (await this.browser()).newContext({
      viewport: VIEWPORT,
      permissions: ["clipboard-read", "clipboard-write"],
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
    return true;
  }

  async input(id: string, input: LoginInput): Promise<void> {
    const session = this.#get(id);
    session.idle.refresh();
    const { page } = session;
    switch (input?.type) {
      case "click":
        if (!isFraction(input.x) || !isFraction(input.y)) throw new RequestError("click needs x and y between 0 and 1");
        return page.mouse.click(input.x * VIEWPORT.width, input.y * VIEWPORT.height);
      case "type":
        if (typeof input.text !== "string" || input.text.length > 2000) throw new RequestError("type needs text up to 2000 characters");
        return page.keyboard.type(input.text);
      case "key":
        if (!KEYS.has(input.key)) throw new RequestError(`Unsupported key "${input.key}"`);
        return page.keyboard.press(input.key);
      case "scroll":
        if (typeof input.dy !== "number" || Math.abs(input.dy) > 5000) throw new RequestError("scroll needs dy up to ±5000");
        return page.mouse.wheel(0, input.dy);
      case "back":
        await page.goBack().catch(() => {});
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

function write(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
