import type { ServerResponse } from "node:http";
import type { Page } from "playwright";

/** Where a session reports what it is doing, for the live grid. Bound to one run. */
export interface LiveSink {
  started(sessionId: string, info: { persona: string; steps: number }): void;
  step(sessionId: string, info: { step: number; url: string; next: string; flags: string[] }): void;
  frame(sessionId: string, jpegBase64: string): void;
  ended(sessionId: string, info: { findings: number }): void;
}

interface LiveSession {
  key: string;
  runId: string;
  sessionId: string;
  persona: string;
  steps: number;
  step: number;
  url: string;
  next: string;
  flags: string[];
  ended: boolean;
  findings?: number;
  frame?: string;
  frameDirty: boolean;
}

/** How often changed frames go out; the newest frame wins, older ones are dropped. */
const FRAME_INTERVAL_MS = 330;
/** How long an ended session's tile stays on screen. */
const ENDED_TILE_MS = 15_000;

/**
 * Fans live session state and screen frames out to connected browsers over Server-Sent Events.
 * Frames are throttled per session, so bandwidth stays bounded however fast pages change.
 */
export class LiveHub {
  readonly #sessions = new Map<string, LiveSession>();
  readonly #clients = new Set<ServerResponse>();

  constructor() {
    setInterval(() => this.#flushFrames(), FRAME_INTERVAL_MS).unref();
  }

  /** Sessions exploring now (ended tiles that are still on screen do not count). */
  get liveSessions(): number {
    return [...this.#sessions.values()].filter((s) => !s.ended).length;
  }

  forRun(runId: string): LiveSink {
    const key = (sessionId: string) => `${runId}/${sessionId}`;
    const get = (sessionId: string) => this.#sessions.get(key(sessionId));
    return {
      started: (sessionId, { persona, steps }) => {
        const s: LiveSession = {
          key: key(sessionId),
          runId,
          sessionId,
          persona,
          steps,
          step: 0,
          url: "",
          next: "starting…",
          flags: [],
          ended: false,
          frameDirty: false,
        };
        this.#sessions.set(s.key, s);
        this.#send("meta", meta(s));
      },
      step: (sessionId, info) => {
        const s = get(sessionId);
        if (!s) return;
        Object.assign(s, info);
        this.#send("meta", meta(s));
      },
      frame: (sessionId, jpeg) => {
        const s = get(sessionId);
        if (!s) return;
        s.frame = jpeg;
        s.frameDirty = true;
      },
      ended: (sessionId, { findings }) => {
        const s = get(sessionId);
        if (!s) return;
        s.ended = true;
        s.findings = findings;
        this.#send("meta", meta(s));
        setTimeout(() => {
          this.#sessions.delete(s.key);
          this.#send("remove", { key: s.key });
        }, ENDED_TILE_MS).unref();
      },
    };
  }

  /** Attach an SSE client: it first receives every current session and its latest frame. */
  subscribe(res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      // Stop reverse proxies from buffering the stream.
      "x-accel-buffering": "no",
    });
    this.#clients.add(res);
    res.on("close", () => this.#clients.delete(res));
    for (const s of this.#sessions.values()) {
      write(res, "meta", meta(s));
      if (s.frame) write(res, "frame", { key: s.key, jpeg: s.frame });
    }
  }

  #flushFrames(): void {
    for (const s of this.#sessions.values()) {
      if (!s.frameDirty || !s.frame) continue;
      s.frameDirty = false;
      this.#send("frame", { key: s.key, jpeg: s.frame });
    }
  }

  #send(event: string, data: unknown): void {
    for (const res of this.#clients) write(res, event, data);
  }
}

function meta(s: LiveSession) {
  const { frame: _frame, frameDirty: _dirty, ...rest } = s;
  return rest;
}

function write(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export interface ScreencastQuality {
  maxWidth: number;
  maxHeight: number;
  /** JPEG quality, 0-100. */
  quality: number;
}

/** Small and cheap: fine for many grid thumbnails at once. */
export const THUMBNAIL: ScreencastQuality = { maxWidth: 640, maxHeight: 400, quality: 55 };

/**
 * Stream the page's screen as JPEG frames via Chromium's screencast, which works headless.
 * Returns a stop function; errors after the page closes are expected and ignored.
 */
export async function startScreencast(
  page: Page,
  onFrame: (jpegBase64: string) => void,
  size: ScreencastQuality = THUMBNAIL,
): Promise<() => void> {
  const cdp = await page.context().newCDPSession(page);
  cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
    onFrame(data);
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", ...size });
  return () => {
    cdp.send("Page.stopScreencast").catch(() => {});
    cdp.detach().catch(() => {});
  };
}
