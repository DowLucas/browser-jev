import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
import { type Config, resolveConfig } from "../config.ts";
import type { RunSummary } from "../report.ts";
import { assertSafeTarget } from "../safety.ts";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled" | "interrupted";

/** What a client may submit. Anything else is rejected, so the API cannot read files or run commands. */
export interface RunRequest {
  startUrl: string;
  /** Extra hosts beyond the start URL's, which is always allowed. */
  allowedHosts?: string[];
  sessions?: number;
  workers?: number;
  steps?: number;
  personas?: Config["personas"];
  useModel?: boolean;
  /** Defaults to true on the runner: nothing is submitted unless a run explicitly opts out. */
  readOnly?: boolean;
  thresholds?: Partial<Config["thresholds"]>;
  /** Added to the default forbidden-control patterns; the defaults cannot be removed. */
  extraForbiddenPatterns?: string[];
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
  outcome?: RunOutcomeSummary;
  error?: string;
}

export class RequestError extends Error {}

/** Upper bounds per run, so one request cannot monopolise the runner for days. */
export const LIMITS = { sessions: 1000, steps: 500, workers: 16 } as const;

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
      : ["warnConfidence", "failConfidence"].includes(k) && isProbability(x),
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
  readOnly: { check: isBool, expected: "a boolean" },
  thresholds: { check: isThresholds, expected: "{warnConfidence, failConfidence: 0-1, warnSeverity, failSeverity: 0-4}" },
  extraForbiddenPatterns: { check: isStringArray, expected: "an array of regex strings" },
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

  constructor(
    readonly dataDir: string,
    readonly policy: TargetPolicy = { allowPrivate: false, blockedSuffixes: [] },
  ) {
    this.jobsDir = join(dataDir, "jobs");
    this.runsDir = join(dataDir, "runs");
    this.authDir = join(dataDir, "auth");
  }

  async init(): Promise<void> {
    for (const dir of [this.jobsDir, this.runsDir, this.authDir]) await mkdir(dir, { recursive: true });
  }

  /** Validate a request the same way a run would, so bad requests fail at submission, not later. */
  toConfig(request: RunRequest): Config {
    const unknown = Object.keys(request).filter((k) => !(k in REQUEST_SCHEMA));
    if (unknown.length) throw new RequestError(`Unknown field(s): ${unknown.join(", ")}`);
    for (const [key, value] of Object.entries(request)) {
      const rule = REQUEST_SCHEMA[key as keyof RunRequest];
      if (value !== undefined && !rule.check(value)) throw new RequestError(`${key} must be ${rule.expected}`);
    }
    if (!request.startUrl) throw new RequestError("startUrl is required");
    const { extraForbiddenPatterns = [], spec: _spec, authState, readOnly = true, ...rest } = request;
    let cfg: Config;
    try {
      cfg = resolveConfig({ ...rest, readOnly, storageStatePath: authState && this.authPath(authState) });
      cfg.forbiddenPatterns = [...cfg.forbiddenPatterns, ...extraForbiddenPatterns];
      for (const p of cfg.forbiddenPatterns) new RegExp(p);
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

  runDir(id: string): string {
    return join(this.runsDir, id);
  }

  logPath(id: string): string {
    return join(this.runsDir, `${id}.log`);
  }

  async create(request: RunRequest): Promise<Job> {
    this.toConfig(request);
    if (request.authState) {
      await access(this.authPath(request.authState)).catch(() => {
        throw new RequestError(`No saved login session "${request.authState}" in ${this.authDir}`);
      });
    }
    const job: Job = { id: randomUUID(), status: "queued", createdAt: new Date().toISOString(), request };
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
