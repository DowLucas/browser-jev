import { readFile } from "node:fs/promises";
import { type Focus, NO_FOCUS, validateFocus } from "./focus.ts";
import { forbiddenMatcher, isAppUrl } from "./safety.ts";
import { formatStep, parseSetup, resolveSetupUrl, type SetupStep, stepSubjects } from "./setup.ts";
import { parseArgs } from "node:util";
import { BUILT_IN_NAMES, BUILT_IN_PERSONAS, type Persona, resolvePersonas } from "./personas.ts";
import { type Mode, MODES } from "./safety.ts";
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
  /** Resolved definitions; config layers may give built-in names or inline definitions. */
  personas: Persona[];
  /** false = free oracle only with a random explorer (build step 1). */
  useModel: boolean;
  thresholds: Thresholds;
  freeOracleFailOn: FreeCategory[];
  /** Where to concentrate: instructions for the model, and paths enforced in code. */
  focus: Focus;
  /** Steps replayed before each session to reach state exploration alone would not. */
  setup: SetupStep[];
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
  /**
   * How long to keep waiting after an action while its own work is visibly pending (a request it
   * started, a loading or typing indicator): slow submits and AI replies. Hasty personas never wait this long.
   */
  maxWaitMs: number;
  headless: boolean;
  /** What may reach the server: see MODES in safety.ts. */
  mode: Mode;
  /** For observe-writes: exact paths ("/entity"), or a prefix ending in "/*" ("/api/*"). */
  allowedWritePaths: string[];
  /** Interact mode sends real submissions; the run must confirm the target is disposable. */
  confirmDisposable: boolean;
  /** Visible, slowed-down browsers with an on-page banner and target highlighting. */
  watch: boolean;
  slowMoMs: number;
}

/**
 * Most sessions open at once, per run and across the runner. Each is a browser context doing full
 * page loads, and every step is a model call; past this, memory and rate limits go before coverage gains.
 */
export const MAX_PARALLEL_SESSIONS = 10;

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
  personas: [...BUILT_IN_PERSONAS],
  useModel: true,
  focus: NO_FOCUS,
  setup: [],
  thresholds: { warnConfidence: 0.6, warnSeverity: 1, strongConfidence: 0.75, failConfidence: 0.9, failSeverity: 3 },
  // A failed setup means the sessions tested nothing they were meant to: that must not pass quietly.
  freeOracleFailOn: ["page-error", "http-5xx", "crash", "xss-dialog", "setup-failed"],
  outDir: "out",
  maxSnapshotChars: 60_000,
  maxActions: 120,
  actionTimeoutMs: 5_000,
  maxWaitMs: 45_000,
  headless: true,
  mode: "observe",
  allowedWritePaths: [],
  confirmDisposable: false,
  watch: false,
  slowMoMs: 300,
};

const USAGE = `Usage: npm run explore -- [options]

  --config <file>          JSON config file (merged over defaults, under flags)
  --url <url>              Start URL
  --allow <host>           Extra allowlisted host (repeatable); the start URL's host is always allowed
  --sessions <n>           Total sessions (default ${DEFAULTS.sessions})
  --workers <n>            Parallel browser contexts, at most ${MAX_PARALLEL_SESSIONS} (default ${DEFAULTS.workers})
  --steps <n>              Steps per session (default ${DEFAULTS.steps})
  --persona <name>         Persona to use (repeatable): ${BUILT_IN_NAMES.join(", ")},
                           or a name defined under "personas" in the config file
  --no-model               Free oracle only, random exploration, no Jev calls
  --focus <text>           What to concentrate on, e.g. "the checkout flow: cart, shipping, payment"
  --focus-path <path>      Stay within this path (repeatable): /cart, or /checkout/* for it and below
  --exclude-path <path>    Never enter this path (repeatable), same syntax
                           The start URL is the entry point: sessions return to it when they leave the area
  --max-wait <seconds>     Wait up to this long for a slow response after an action (default ${DEFAULTS.maxWaitMs / 1000})
  --setup <file>           Setup steps replayed before each session (goto, click, fill, select, press, wait for, back)
  --spec <file>            Spec / ticket describing intended behavior
  --storage-state <file>   Playwright storage state for the test account
  --baseline <file>        Suppress fingerprints listed in this file
  --write-baseline <file>  Write this run's fingerprints (use on a known-good build)
  --escalate <cmd>         Command per failing finding, {ticket} = ticket path
  --out <dir>              Output directory (default ${DEFAULTS.outDir})
  --headed                 Show the browser
  --watch                  Show the browsers tiled and slowed down, with a banner and highlighted targets
  --slow-mo <ms>           Delay per browser operation in --watch (default ${DEFAULTS.slowMoMs}; lower is faster)
  --mode <mode>            observe (default): nothing but reads reach the server
                           observe-writes: also writes to the paths given with --allow-write
                           interact: all submissions go through (disposable environments only)
  --allow-write <path>     Write path allowed in observe-writes (repeatable): /entity, or /api/*
  --confirm-disposable     Required for interact: confirms the target's data may be changed
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
      focus: { type: "string" },
      setup: { type: "string" },
      "max-wait": { type: "string" },
      "focus-path": { type: "string", multiple: true },
      "exclude-path": { type: "string", multiple: true },
      spec: { type: "string" },
      "storage-state": { type: "string" },
      baseline: { type: "string" },
      "write-baseline": { type: "string" },
      escalate: { type: "string" },
      out: { type: "string" },
      headed: { type: "boolean" },
      watch: { type: "boolean" },
      "slow-mo": { type: "string" },
      mode: { type: "string" },
      "allow-write": { type: "string", multiple: true },
      "confirm-disposable": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const file: ConfigLayer = values.config
    ? JSON.parse(await readFile(values.config, "utf8"))
    : {};

  const flags: ConfigLayer = dropUndefined({
    startUrl: values.url,
    allowedHosts: values.allow,
    sessions: toInt(values.sessions, "sessions"),
    workers: toInt(values.workers, "workers"),
    steps: toInt(values.steps, "steps"),
    personas: values.persona,
    useModel: values["no-model"] ? false : undefined,
    specPath: values.spec,
    setup: values.setup === undefined ? undefined : await readFile(values.setup, "utf8"),
    storageStatePath: values["storage-state"],
    baselinePath: values.baseline,
    writeBaselinePath: values["write-baseline"],
    escalateCommand: values.escalate,
    outDir: values.out,
    headless: values.headed || values.watch ? false : undefined,
    watch: values.watch,
    slowMoMs: toInt(values["slow-mo"], "slow-mo"),
    maxWaitMs: values["max-wait"] === undefined ? undefined : toInt(values["max-wait"], "max-wait")! * 1000,
    mode: values.mode as Mode | undefined,
    allowedWritePaths: values["allow-write"],
    confirmDisposable: values["confirm-disposable"],
  });

  // Focus flags refine the file's focus field by field rather than replacing it.
  const focusFlags = dropUndefined({
    instructions: values.focus,
    includePaths: values["focus-path"],
    excludePaths: values["exclude-path"],
  });
  if (Object.keys(focusFlags).length) flags.focus = { ...NO_FOCUS, ...file.focus, ...focusFlags };
  // --persona picks by name, including personas the config file defines inline.
  if (flags.personas && file.personas) {
    const defined = file.personas.filter((p): p is Persona => typeof p !== "string");
    flags.personas = flags.personas.map((name) => defined.find((p) => typeof name === "string" && p.name === name) ?? name);
  }
  return resolveConfig(file, flags);
}

/** A partial config, where thresholds may also be partial. */
export type ConfigLayer = Partial<Omit<Config, "thresholds" | "personas" | "focus" | "setup">> & {
  /** Setup script text or lines (see setup.ts), or already parsed steps. */
  setup?: string | string[] | SetupStep[];
  /** Paths may be left out; they default to none. */
  focus?: Partial<Focus>;
  thresholds?: Partial<Thresholds>;
  /** Built-in names, or full definitions. */
  personas?: (string | Persona)[];
};

/** Defaults, then each layer in order (later wins), validated. Shared by the CLI and the runner. */
export function resolveConfig(...layers: ConfigLayer[]): Config {
  const merged: ConfigLayer = Object.assign({}, DEFAULTS, ...layers);
  merged.thresholds = Object.assign({}, DEFAULTS.thresholds, ...layers.map((l) => l.thresholds));
  return validate(merged);
}

function validate(layer: ConfigLayer): Config {
  const cfg = layer as Partial<Config>;
  if (!cfg.startUrl) throw new Error(`Missing start URL (--url).\n\n${USAGE}`);
  let startHost: string;
  try {
    startHost = new URL(cfg.startUrl).hostname;
  } catch {
    throw new Error(`Invalid start URL "${cfg.startUrl}"`);
  }
  // The start URL's host is always allowed; extra hosts (an API or CDN domain) are added to it.
  cfg.allowedHosts = [...new Set([startHost, ...(cfg.allowedHosts ?? [])])];
  cfg.focus = validateFocus(layer.focus, cfg.startUrl);
  cfg.setup = toSetupSteps(layer.setup);
  if (!Array.isArray(layer.personas) || !layer.personas.length) throw new Error("At least one persona is needed");
  cfg.personas = resolvePersonas(layer.personas);
  for (const key of ["sessions", "workers", "steps"] as const) {
    if (!(Number(cfg[key]) >= 1)) throw new Error(`${key} must be >= 1`);
  }
  if (!(Number(cfg.maxWaitMs) >= 1_000 && Number(cfg.maxWaitMs) <= 300_000)) throw new Error("max wait must be 1-300 seconds");
  if (Number(cfg.workers) > MAX_PARALLEL_SESSIONS) {
    throw new Error(`workers must be at most ${MAX_PARALLEL_SESSIONS} (sessions open at once)`);
  }
  assertModeAllowed(cfg);
  assertSetupAllowed(cfg as Config);
  return cfg as Config;
}

function toSetupSteps(setup: ConfigLayer["setup"]): SetupStep[] {
  if (setup === undefined) return [];
  if (typeof setup === "string") return parseSetup(setup);
  // Parsed steps (e.g. re-resolving a resolved config) round-trip through the text form, which validates them.
  return parseSetup(setup.map((s) => (typeof s === "string" ? s : formatStep(s))));
}

/**
 * Setup gets no exemptions: its steps stay on the allowlisted hosts and never touch a forbidden
 * control, the same as exploration. Call again after adding forbidden patterns.
 */
export function assertSetupAllowed(cfg: Config): void {
  const forbidden = forbiddenMatcher(cfg.forbiddenPatterns);
  cfg.setup.forEach((step, i) => {
    const line = `Setup step ${i + 1} (${formatStep(step)})`;
    if (step.kind === "goto" && !isAppUrl(resolveSetupUrl(step.url, cfg.startUrl), cfg.allowedHosts)) {
      throw new Error(`${line} leaves the allowed hosts (${cfg.allowedHosts.join(", ")})`);
    }
    const hit = stepSubjects(step).find(forbidden);
    if (hit !== undefined) {
      throw new Error(
        `${line} touches "${hit}", which matches a forbidden-control pattern. The forbidden list applies to ` +
          "setup too; reach that page with a goto instead, or drop the step.",
      );
    }
  });
}

function assertModeAllowed(cfg: Partial<Config>): void {
  if (!MODES.includes(cfg.mode as Mode)) throw new Error(`mode must be one of: ${MODES.join(", ")}`);
  const paths = cfg.allowedWritePaths ?? [];
  const bad = paths.find((p) => !p.startsWith("/"));
  if (bad) throw new Error(`Write path "${bad}" must start with "/" (e.g. /entity or /api/*)`);
  if (cfg.mode === "observe-writes" && !paths.length) {
    throw new Error("observe-writes needs at least one allowed write path (--allow-write /path)");
  }
  if (cfg.mode === "interact" && !cfg.confirmDisposable) {
    throw new Error(
      "Refusing to start: interact mode sends real submissions and changes data on the target. " +
        "Confirm the environment is disposable (--confirm-disposable, or the checkbox in the UI).",
    );
  }
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
