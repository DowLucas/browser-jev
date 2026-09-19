import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { PERSONA_NAMES, type PersonaName } from "./personas.ts";
import type { FreeCategory } from "./signals.ts";

export interface Thresholds {
  /** Minimum yes-probability for a judgment to be reported at all (as a warning). */
  warnConfidence: number;
  /**
   * In the uncertain band (warnConfidence up to strongConfidence), a judgment must also reach this
   * expected severity (0-4); below 1 the model itself rates it "nothing is wrong". Judgments at or
   * above strongConfidence are reported regardless: a confident dead end can still be rated minor.
   */
  warnSeverity: number;
  strongConfidence: number;
  /** Minimum yes-probability for a judgment to fail the build. */
  failConfidence: number;
  /** Minimum expected severity (0-4 rubric) for a judgment to fail the build. */
  failSeverity: number;
}

export interface Config {
  startUrl: string;
  /** Hosts the browser may talk to; the start URL's host is always included. Everything else is blocked. */
  allowedHosts: string[];
  /** Hostname patterns that mark a target as production; the run refuses to start on a match. */
  productionPatterns: string[];
  /** Accessible-name / href patterns for controls that are never touched. */
  forbiddenPatterns: string[];
  /** Request URL patterns excluded from the HTTP oracle (e.g. favicon). */
  ignoreRequestPatterns: string[];
  /** Console error patterns that are not app bugs, e.g. side effects of the network fence. */
  ignoreConsolePatterns: string[];
  sessions: number;
  workers: number;
  steps: number;
  personas: PersonaName[];
  /** false = free oracle only with a random explorer (build step 1). */
  useModel: boolean;
  thresholds: Thresholds;
  freeOracleFailOn: FreeCategory[];
  /** Path to a spec / ticket / PR description; tells the model what is intended. */
  specPath?: string;
  /** Playwright storage state for a throwaway, pre-authenticated test account. */
  storageStatePath?: string;
  /** Fingerprints from a known-good build that are suppressed. */
  baselinePath?: string;
  /** Write every fingerprint of this run to this path (calibration against a healthy build). */
  writeBaselinePath?: string;
  /** Shell command run per failing finding; `{ticket}` is replaced with the ticket path. */
  escalateCommand?: string;
  outDir: string;
  maxSnapshotChars: number;
  maxActions: number;
  actionTimeoutMs: number;
  headless: boolean;
  /** Block every non-GET/HEAD request to the target, so nothing is ever submitted. For live sites. */
  readOnly: boolean;
  /** Visible, slowed-down browsers with an on-page banner and target highlighting. */
  watch: boolean;
  slowMoMs: number;
}

export const DEFAULTS: Omit<Config, "startUrl" | "allowedHosts"> = {
  productionPatterns: ["^www\\.", "(^|[.-])prod(uction)?([.-]|$)", "(^|[.-])live([.-]|$)"],
  forbiddenPatterns: [
    "delete",
    "remove",
    "destroy",
    "deactivate",
    "close account",
    "cancel subscription",
    "subscribe",
    "checkout",
    "check out",
    "\\bpay(ment)?\\b",
    "purchase",
    "\\bbuy\\b",
    "billing",
    "invite",
    "export all",
    "sign ?out",
    "log ?out",
    "transfer",
    "send email",
    "reset password",
  ],
  ignoreRequestPatterns: ["/favicon\\.ico$"],
  // Error reporters failing to reach their (blocked) third-party endpoint.
  ignoreConsolePatterns: ["Failed to send event to Sentry"],
  sessions: 4,
  workers: 2,
  steps: 25,
  personas: [...PERSONA_NAMES],
  useModel: true,
  thresholds: { warnConfidence: 0.6, warnSeverity: 1, strongConfidence: 0.75, failConfidence: 0.9, failSeverity: 3 },
  freeOracleFailOn: ["page-error", "http-5xx", "crash", "xss-dialog"],
  outDir: "out",
  maxSnapshotChars: 60_000,
  maxActions: 120,
  actionTimeoutMs: 5_000,
  headless: true,
  readOnly: false,
  watch: false,
  slowMoMs: 300,
};

const USAGE = `Usage: npm run explore -- [options]

  --config <file>          JSON config file (merged over defaults, under flags)
  --url <url>              Start URL
  --allow <host>           Extra allowlisted host (repeatable); the start URL's host is always allowed
  --sessions <n>           Total sessions (default ${DEFAULTS.sessions})
  --workers <n>            Parallel browser contexts (default ${DEFAULTS.workers})
  --steps <n>              Steps per session (default ${DEFAULTS.steps})
  --persona <name>         Persona to use (repeatable): ${PERSONA_NAMES.join(", ")}
  --no-model               Free oracle only, random exploration, no Jev calls
  --spec <file>            Spec / ticket describing intended behavior
  --storage-state <file>   Playwright storage state for the test account
  --baseline <file>        Suppress fingerprints listed in this file
  --write-baseline <file>  Write this run's fingerprints (use on a known-good build)
  --escalate <cmd>         Command per failing finding, {ticket} = ticket path
  --out <dir>              Output directory (default ${DEFAULTS.outDir})
  --headed                 Show the browser
  --watch                  Show the browsers tiled and slowed down, with a banner and highlighted targets
  --slow-mo <ms>           Delay per browser operation in --watch (default ${DEFAULTS.slowMoMs}; lower is faster)
  --read-only              Block all non-GET requests to the target (use on live sites)
`;

export async function loadConfig(argv: string[]): Promise<Config> {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: "string" },
      url: { type: "string" },
      allow: { type: "string", multiple: true },
      sessions: { type: "string" },
      workers: { type: "string" },
      steps: { type: "string" },
      persona: { type: "string", multiple: true },
      "no-model": { type: "boolean" },
      spec: { type: "string" },
      "storage-state": { type: "string" },
      baseline: { type: "string" },
      "write-baseline": { type: "string" },
      escalate: { type: "string" },
      out: { type: "string" },
      headed: { type: "boolean" },
      watch: { type: "boolean" },
      "slow-mo": { type: "string" },
      "read-only": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const file: Partial<Config> = values.config
    ? JSON.parse(await readFile(values.config, "utf8"))
    : {};

  const flags: Partial<Config> = dropUndefined({
    startUrl: values.url,
    allowedHosts: values.allow,
    sessions: toInt(values.sessions, "sessions"),
    workers: toInt(values.workers, "workers"),
    steps: toInt(values.steps, "steps"),
    personas: values.persona as PersonaName[] | undefined,
    useModel: values["no-model"] ? false : undefined,
    specPath: values.spec,
    storageStatePath: values["storage-state"],
    baselinePath: values.baseline,
    writeBaselinePath: values["write-baseline"],
    escalateCommand: values.escalate,
    outDir: values.out,
    headless: values.headed || values.watch ? false : undefined,
    watch: values.watch,
    slowMoMs: toInt(values["slow-mo"], "slow-mo"),
    readOnly: values["read-only"],
  });

  return resolveConfig(file, flags);
}

/** A partial config, where thresholds may also be partial. */
export type ConfigLayer = Partial<Omit<Config, "thresholds">> & { thresholds?: Partial<Thresholds> };

/** Defaults, then each layer in order (later wins), validated. Shared by the CLI and the runner. */
export function resolveConfig(...layers: ConfigLayer[]): Config {
  const merged: ConfigLayer = Object.assign({}, DEFAULTS, ...layers);
  merged.thresholds = Object.assign({}, DEFAULTS.thresholds, ...layers.map((l) => l.thresholds));
  return validate(merged as Partial<Config>);
}

function validate(cfg: Partial<Config>): Config {
  if (!cfg.startUrl) throw new Error(`Missing start URL (--url).\n\n${USAGE}`);
  let startHost: string;
  try {
    startHost = new URL(cfg.startUrl).hostname;
  } catch {
    throw new Error(`Invalid start URL "${cfg.startUrl}"`);
  }
  // The start URL's host is always allowed; extra hosts (an API or CDN domain) are added to it.
  cfg.allowedHosts = [...new Set([startHost, ...(cfg.allowedHosts ?? [])])];
  for (const p of cfg.personas ?? []) {
    if (!PERSONA_NAMES.includes(p)) throw new Error(`Unknown persona "${p}"`);
  }
  for (const key of ["sessions", "workers", "steps"] as const) {
    if (!(Number(cfg[key]) >= 1)) throw new Error(`${key} must be >= 1`);
  }
  return cfg as Config;
}

function toInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) throw new Error(`--${name} must be a number`);
  return n;
}

function dropUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
