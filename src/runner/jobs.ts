import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
import { assertSetupAllowed, type Config, MAX_PARALLEL_SESSIONS, resolveConfig } from "../config.ts";
import { BUILT_IN_PERSONAS, type Persona, resolvePersonas, validatePersona } from "../personas.ts";
import type { RunSummary } from "../report.ts";
import { assertSafeTarget, type Mode, MODES } from "../safety.ts";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled" | "interrupted";

/** What a client may submit. Anything else is rejected, so the API cannot read files or run commands. */
export interface RunRequest {
  startUrl: string;
  /** Extra hosts beyond the start URL's, which is always allowed. */
  allowedHosts?: string[];
  sessions?: number;
  workers?: number;
  steps?: number;
  /** Names from the runner's persona library; all of them when left out. */
  personas?: string[];
  useModel?: boolean;
  /** What may reach the server; defaults to observe (nothing but reads). */
  mode?: Mode;
  /** For observe-writes: exact paths ("/entity"), or a prefix ending in "/*" ("/api/*"). */
  allowedWritePaths?: string[];
  /** Required for interact mode: the caller confirms the target's data may be changed. */
  confirmDisposable?: boolean;
  thresholds?: Partial<Config["thresholds"]>;
  /** Added to the default forbidden-control patterns; the defaults cannot be removed. */
  extraForbiddenPatterns?: string[];
  /** Where to concentrate: { instructions?, includePaths?, excludePaths? }. The start URL is the entry point. */
  focus?: { instructions?: string; includePaths?: string[]; excludePaths?: string[] };
  /** Wait up to this long for a slow response after an action (AI replies, slow submits). */
  maxWaitSeconds?: number;
  /** Setup script run before each session: one step per line (goto, click, fill, select, press, wait for, back). */
  setup?: string;
  /** Inline spec / ticket text. */
  spec?: string;
  /** Name of a saved login session in <data>/auth, e.g. "staging" for auth/staging.json. */
  authState?: string;
}

export interface RunOutcomeSummary {
  failing: number;
  warnings: number;
  suppressed: number;
  sessionsRun: number;
  stopped: boolean;
  summary: RunSummary;
}

export interface Job {
  id: string;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  request: RunRequest;
  /** The persona definitions as they were at submission, so a later edit does not change a queued run. */
  personas?: Persona[];
  outcome?: RunOutcomeSummary;
  error?: string;
}

export class RequestError extends Error {}

/** What the UI may know about a saved login: never cookie or storage values. */
export interface AuthStateSummary {
  name: string;
  /** Sites the session holds cookies or storage for. */
  domains: string[];
  cookies: number;
  /** Latest cookie expiry (ISO), or null when all cookies end with the browser session. */
  expiresAt: string | null;
  savedAt: string;
}

/** Shape of a Playwright storage state, checked before an uploaded file is stored. */
function isStorageState(v: unknown): v is { cookies: { domain: string; expires?: number }[]; origins: { origin: string }[] } {
  if (!v || typeof v !== "object") return false;
  const s = v as { cookies?: unknown; origins?: unknown };
  return (
    Array.isArray(s.cookies) &&
    Array.isArray(s.origins) &&
    s.cookies.every((c) => c && typeof c === "object" && typeof (c as { name?: unknown }).name === "string" && typeof (c as { domain?: unknown }).domain === "string") &&
    s.origins.every((o) => o && typeof o === "object" && typeof (o as { origin?: unknown }).origin === "string")
  );
}

/** Upper bounds per run, so one request cannot monopolise the runner for days. */
export const LIMITS = { sessions: 1000, steps: 500, workers: MAX_PARALLEL_SESSIONS } as const;

type Check = (v: unknown) => boolean;
const isString: Check = (v) => typeof v === "string";
const isStringArray: Check = (v) => Array.isArray(v) && v.every(isString);
const isBool: Check = (v) => typeof v === "boolean";
const isIntUpTo = (max: number): Check => (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= max;
const isProbability: Check = (v) => typeof v === "number" && v >= 0 && v <= 1;
const isThresholds: Check = (v) =>
  !!v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.entries(v).every(([k, x]) =>
    ["failSeverity", "warnSeverity"].includes(k)
      ? typeof x === "number" && x >= 0 && x <= 4
      : ["warnConfidence", "strongConfidence", "failConfidence"].includes(k) && isProbability(x),
  );

/**
 * Type of every accepted field. Exact types matter: a string where an array is expected would,
 * for example, turn the network fence's exact host match into a substring match.
 */
const REQUEST_SCHEMA: Record<keyof RunRequest, { check: Check; expected: string }> = {
  startUrl: { check: isString, expected: "a string" },
  allowedHosts: { check: isStringArray, expected: "an array of strings" },
  sessions: { check: isIntUpTo(LIMITS.sessions), expected: `an integer 1-${LIMITS.sessions}` },
  workers: { check: isIntUpTo(LIMITS.workers), expected: `an integer 1-${LIMITS.workers}` },
  steps: { check: isIntUpTo(LIMITS.steps), expected: `an integer 1-${LIMITS.steps}` },
  personas: { check: isStringArray, expected: "an array of persona names" },
  useModel: { check: isBool, expected: "a boolean" },
  mode: { check: (v) => MODES.includes(v as Mode), expected: `one of ${MODES.join(", ")}` },
  allowedWritePaths: { check: isStringArray, expected: "an array of paths like /entity or /api/*" },
  confirmDisposable: { check: isBool, expected: "a boolean" },
  thresholds: { check: isThresholds, expected: "{warnConfidence, strongConfidence, failConfidence: 0-1, warnSeverity, failSeverity: 0-4}" },
  extraForbiddenPatterns: { check: isStringArray, expected: "an array of regex strings" },
  // Field-level checks (paths start with "/", the start URL is inside) happen in validateFocus.
  focus: {
    check: (v) =>
      !!v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      Object.entries(v).every(([k, x]) => (k === "instructions" ? isString(x) : ["includePaths", "excludePaths"].includes(k) && isStringArray(x))),
    expected: "{ instructions?: string, includePaths?: string[], excludePaths?: string[] }",
  },
  maxWaitSeconds: { check: isIntUpTo(300), expected: "an integer 1-300" },
  setup: { check: (v) => isString(v) && (v as string).length <= 20_000, expected: "a string of setup steps, one per line" },
  spec: { check: isString, expected: "a string" },
  authState: { check: isString, expected: "a string" },
};

export interface TargetPolicy {
  /** Allow localhost, private IPs and single-label hosts (tests and local use only). */
  allowPrivate: boolean;
  /** Host suffixes that may never be targeted, e.g. the runner's own infrastructure domains. */
  blockedSuffixes: string[];
}

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^0\./];

/**
 * The runner sits on a network next to other services. Refuse targets that would point the browser
 * at them: localhost, private and Tailscale (CGNAT) IPs, bare container names, and blocked suffixes.
 */
export function assertPublicTarget(host: string, policy: TargetPolicy): void {
  if (policy.allowPrivate) return;
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  const kind = isIP(h);
  const privateHost =
    h === "localhost" ||
    h.endsWith(".localhost") ||
    (kind === 0 && !h.includes(".")) ||
    (kind === 4 && PRIVATE_V4.some((re) => re.test(h))) ||
    (kind === 6 && /^(::1?$|f[cd]|fe[89ab]|::ffff:)/.test(h));
  if (privateHost) throw new RequestError(`Refusing private or internal target "${host}"`);
  const suffix = policy.blockedSuffixes.find((s) => h === s.replace(/^\./, "") || h.endsWith(s.startsWith(".") ? s : `.${s}`));
  if (suffix) throw new RequestError(`Refusing target "${host}": the ${suffix} domain is blocked on this runner`);
}

export class JobStore {
  readonly jobsDir: string;
  readonly runsDir: string;
  readonly authDir: string;
  readonly personasPath: string;
  /** Persona edits are read-modify-write on one file; this keeps them in order. */
  #personaWrites: Promise<unknown> = Promise.resolve();

  constructor(
    readonly dataDir: string,
    readonly policy: TargetPolicy = { allowPrivate: false, blockedSuffixes: [] },
  ) {
    this.jobsDir = join(dataDir, "jobs");
    this.runsDir = join(dataDir, "runs");
    this.authDir = join(dataDir, "auth");
    this.personasPath = join(dataDir, "personas.json");
  }

  async init(): Promise<void> {
    for (const dir of [this.jobsDir, this.runsDir, this.authDir]) await mkdir(dir, { recursive: true });
  }

  /**
   * Validate a request the same way a run would, so bad requests fail at submission, not later.
   * Persona names resolve against `library`: the runner's library at submission, the job's snapshot after.
   */
  toConfig(request: RunRequest, library: readonly Persona[]): Config {
    const unknown = Object.keys(request).filter((k) => !(k in REQUEST_SCHEMA));
    if (unknown.length) throw new RequestError(`Unknown field(s): ${unknown.join(", ")}`);
    for (const [key, value] of Object.entries(request)) {
      const rule = REQUEST_SCHEMA[key as keyof RunRequest];
      if (value !== undefined && !rule.check(value)) throw new RequestError(`${key} must be ${rule.expected}`);
    }
    if (!request.startUrl) throw new RequestError("startUrl is required");
    const { extraForbiddenPatterns = [], spec: _spec, authState, personas, maxWaitSeconds, ...rest } = request;
    let cfg: Config;
    try {
      const chosen = personas ? resolvePersonas(personas, library) : [...library];
      cfg = resolveConfig({
        ...rest,
        personas: chosen,
        storageStatePath: authState && this.authPath(authState),
        ...(maxWaitSeconds ? { maxWaitMs: maxWaitSeconds * 1000 } : {}),
      });
      cfg.forbiddenPatterns = [...cfg.forbiddenPatterns, ...extraForbiddenPatterns];
      for (const p of cfg.forbiddenPatterns) new RegExp(p);
      assertSetupAllowed(cfg);
      assertSafeTarget(cfg);
      for (const host of cfg.allowedHosts) assertPublicTarget(host, this.policy);
    } catch (err) {
      throw new RequestError((err as Error).message);
    }
    return cfg;
  }

  authPath(name: string): string {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name)) throw new RequestError(`Invalid authState name "${name}"`);
    return resolve(this.authDir, `${name}.json`);
  }

  /** Store a login session (captured in the UI, or uploaded). Owner-only: it is a credential. */
  async saveAuthState(name: string, state: unknown): Promise<AuthStateSummary> {
    const path = this.authPath(name);
    if (!isStorageState(state)) throw new RequestError("Not a Playwright storage state (expected { cookies: [...], origins: [...] })");
    await writeFile(`${path}.tmp`, JSON.stringify(state), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
    return (await this.authSummary(name))!;
  }

  async listAuthStates(): Promise<AuthStateSummary[]> {
    const names = (await readdir(this.authDir)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
    const all = await Promise.all(names.map((n) => this.authSummary(n).catch(() => undefined)));
    return all.filter((s): s is AuthStateSummary => s !== undefined).sort((a, b) => a.name.localeCompare(b.name));
  }

  async deleteAuthState(name: string): Promise<boolean> {
    return unlink(this.authPath(name)).then(
      () => true,
      () => false,
    );
  }

  async authSummary(name: string): Promise<AuthStateSummary | undefined> {
    const path = this.authPath(name);
    const [raw, info] = await Promise.all([readFile(path, "utf8").catch(() => undefined), stat(path).catch(() => undefined)]);
    if (!raw || !info) return undefined;
    const state = JSON.parse(raw) as unknown;
    if (!isStorageState(state)) return undefined;
    const expiries = state.cookies.map((c) => c.expires ?? -1).filter((e) => e > 0);
    const domains = new Set([
      ...state.cookies.map((c) => c.domain.replace(/^\./, "")),
      ...state.origins.map((o) => new URL(o.origin).hostname),
    ]);
    return {
      name,
      domains: [...domains].sort(),
      cookies: state.cookies.length,
      expiresAt: expiries.length ? new Date(Math.max(...expiries) * 1000).toISOString() : null,
      savedAt: info.mtime.toISOString(),
    };
  }

  /** The persona library: the built-ins until someone edits it, then whatever was saved. */
  async listPersonas(): Promise<Persona[]> {
    const raw = await readFile(this.personasPath, "utf8").catch(() => undefined);
    if (raw === undefined) return [...BUILT_IN_PERSONAS];
    return (JSON.parse(raw) as unknown[]).map(validatePersona);
  }

  /** Add a persona, or replace the one named `previousName` (which may differ, for a rename). */
  savePersona(value: unknown, previousName?: string): Promise<Persona> {
    return this.#editPersonas((list) => {
      let persona: Persona;
      try {
        persona = validatePersona(value);
      } catch (err) {
        throw new RequestError((err as Error).message);
      }
      const at = previousName === undefined ? -1 : list.findIndex((p) => p.name === previousName);
      if (previousName !== undefined && at < 0) throw new RequestError(`No persona "${previousName}"`);
      if (list.some((p, i) => p.name === persona.name && i !== at)) throw new RequestError(`A persona named "${persona.name}" already exists`);
      if (at >= 0) list[at] = persona;
      else list.push(persona);
      return { list, result: persona };
    });
  }

  deletePersona(name: string): Promise<boolean> {
    return this.#editPersonas((list) => {
      const rest = list.filter((p) => p.name !== name);
      if (rest.length === list.length) return { list, result: false };
      if (!rest.length) throw new RequestError("Keep at least one persona: a run needs someone to explore with");
      return { list: rest, result: true };
    });
  }

  /** Put the built-ins back as shipped (edited ones are reset, deleted ones return); custom personas stay. */
  restoreBuiltInPersonas(): Promise<Persona[]> {
    return this.#editPersonas((list) => {
      const custom = list.filter((p) => !BUILT_IN_PERSONAS.some((b) => b.name === p.name));
      const next = [...BUILT_IN_PERSONAS, ...custom];
      return { list: next, result: next };
    });
  }

  #editPersonas<T>(edit: (list: Persona[]) => { list: Persona[]; result: T }): Promise<T> {
    const run = this.#personaWrites.then(async () => {
      const { list, result } = edit(await this.listPersonas());
      await writeFile(`${this.personasPath}.tmp`, JSON.stringify(list, null, 2));
      await rename(`${this.personasPath}.tmp`, this.personasPath);
      return result;
    });
    this.#personaWrites = run.catch(() => {});
    return run;
  }

  runDir(id: string): string {
    return join(this.runsDir, id);
  }

  logPath(id: string): string {
    return join(this.runsDir, `${id}.log`);
  }

  async create(request: RunRequest): Promise<Job> {
    const { personas } = this.toConfig(request, await this.listPersonas());
    if (request.authState) {
      await access(this.authPath(request.authState)).catch(() => {
        throw new RequestError(`No saved login session "${request.authState}" in ${this.authDir}`);
      });
    }
    const job: Job = { id: randomUUID(), status: "queued", createdAt: new Date().toISOString(), request, personas };
    await this.save(job);
    return job;
  }

  async get(id: string): Promise<Job | undefined> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
    try {
      return JSON.parse(await readFile(join(this.jobsDir, `${id}.json`), "utf8")) as Job;
    } catch {
      return undefined;
    }
  }

  /** All jobs, oldest first. */
  async list(): Promise<Job[]> {
    const files = (await readdir(this.jobsDir)).filter((f) => f.endsWith(".json"));
    const jobs = await Promise.all(files.map((f) => this.get(f.slice(0, -5))));
    return jobs.filter((j): j is Job => j !== undefined).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Write-then-rename, so a crash mid-write never leaves a corrupt job file. */
  async save(job: Job): Promise<void> {
    const path = join(this.jobsDir, `${job.id}.json`);
    await writeFile(`${path}.tmp`, JSON.stringify(job, null, 2));
    await rename(`${path}.tmp`, path);
  }
}
