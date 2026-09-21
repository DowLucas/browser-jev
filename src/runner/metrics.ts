import type { FindingGroup } from "../findings.ts";
import { ORACLE_CATEGORIES } from "../judge.ts";
import type { RunOutcome } from "../run.ts";
import { FREE_CATEGORIES } from "../signals.ts";
import type { JobStatus } from "./jobs.ts";

/**
 * Every known label set starts at 0. increase() and rate() treat a series' first sample as its
 * baseline, so a counter that first appears already at 1 (the first failed run after a restart)
 * would never be counted; runs are rare enough for that to matter.
 */
const RUN_STATUSES = ["done", "failed", "cancelled", "interrupted"] as const;
const LEVELS = ["fail", "warn"] as const;
const CATEGORIES = [...FREE_CATEGORIES, ...Object.values(ORACLE_CATEGORIES)];

/** Run durations in seconds: from a quick check to an overnight sweep. */
const DURATION_BUCKETS = [30, 60, 120, 300, 600, 1200, 1800, 3600, 7200, 14400];

export interface RunnerGauges {
  slotsCapacity: number;
  slotsInUse: number;
  activeRuns: number;
  liveSessions: number;
  loginBrowsers: number;
  /** Jobs on disk by status: the queue, and everything the runner has ever done. */
  jobs: Record<JobStatus, number>;
}

/**
 * Prometheus metrics for the runner, in the text exposition format (no client library needed).
 * Counters are per process: they reset when the runner restarts, which rate() and increase()
 * handle. Labels are bounded: run status, finding level and category, never URLs or run ids.
 */
export class RunnerMetrics {
  readonly #runs = new Map<string, number>(RUN_STATUSES.map((s) => [s, 0]));
  readonly #findings = new Map<string, number>(LEVELS.flatMap((l) => CATEGORIES.map((c): [string, number] => [`${l}\u0000${c}`, 0])));
  readonly #durationBuckets = DURATION_BUCKETS.map(() => 0);
  #durationSum = 0;
  #durationCount = 0;
  #sessions = 0;
  #jevCalls = 0;
  #inputTokens = 0;
  #judgeErrors = 0;
  #lastFinished = 0;

  /** Record a finished run. `outcome` is absent when the run failed before producing a report. */
  recordRun(status: JobStatus, durationMs: number, outcome?: Pick<RunOutcome, "groups" | "summary" | "sessionsRun">): void {
    this.#runs.set(status, (this.#runs.get(status) ?? 0) + 1);
    const seconds = durationMs / 1000;
    DURATION_BUCKETS.forEach((b, i) => {
      if (seconds <= b) this.#durationBuckets[i]!++;
    });
    this.#durationSum += seconds;
    this.#durationCount++;
    this.#lastFinished = Date.now() / 1000;
    if (!outcome) return;
    this.#sessions += outcome.sessionsRun;
    this.#jevCalls += outcome.summary.jevCalls;
    this.#inputTokens += outcome.summary.inputTokens;
    this.#judgeErrors += outcome.summary.judgeErrors;
    for (const g of outcome.groups) this.#countFinding(g);
  }

  #countFinding(g: FindingGroup): void {
    const key = `${g.level}\u0000${g.category}`;
    this.#findings.set(key, (this.#findings.get(key) ?? 0) + 1);
  }

  render(g: RunnerGauges): string {
    const lines: string[] = [];
    const metric = (name: string, type: "gauge" | "counter", help: string, samples: [string, number][]) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      for (const [labels, value] of samples) lines.push(`${name}${labels} ${value}`);
    };
    const label = (pairs: Record<string, string>) =>
      `{${Object.entries(pairs)
        .map(([k, v]) => `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`)
        .join(",")}}`;

    metric("jev_runner_slots_capacity", "gauge", "Browser contexts (sessions) that may be open at once.", [["", g.slotsCapacity]]);
    metric("jev_runner_slots_in_use", "gauge", "Browser contexts open now: sessions plus login browsers.", [["", g.slotsInUse]]);
    metric("jev_runner_active_runs", "gauge", "Runs executing now.", [["", g.activeRuns]]);
    metric("jev_runner_live_sessions", "gauge", "Sessions exploring now.", [["", g.liveSessions]]);
    metric("jev_runner_login_browsers", "gauge", "Remote login or recording browsers open now.", [["", g.loginBrowsers]]);
    metric(
      "jev_runner_jobs",
      "gauge",
      "Jobs on disk by status; queued is the queue length.",
      Object.entries(g.jobs).map(([status, n]) => [label({ status }), n]),
    );
    metric(
      "jev_runner_runs_finished_total",
      "counter",
      "Runs finished since the runner started, by final status.",
      [...this.#runs].map(([status, n]) => [label({ status }), n]),
    );
    metric(
      "jev_runner_findings_total",
      "counter",
      "Distinct findings (deduplicated groups) in finished runs, by level and category.",
      [...this.#findings].map(([key, n]) => {
        const [level, category] = key.split("\u0000") as [string, string];
        return [label({ level, category }), n];
      }),
    );
    metric("jev_runner_sessions_total", "counter", "Sessions run in finished runs.", [["", this.#sessions]]);
    metric("jev_runner_jev_calls_total", "counter", "Model (Jev) calls made by finished runs.", [["", this.#jevCalls]]);
    metric("jev_runner_jev_input_tokens_total", "counter", "Model input tokens used by finished runs.", [["", this.#inputTokens]]);
    metric("jev_runner_jev_errors_total", "counter", "Model calls that failed in finished runs.", [["", this.#judgeErrors]]);
    metric("jev_runner_last_run_finished_timestamp_seconds", "gauge", "When the last run finished (0: none since start).", [
      ["", Math.round(this.#lastFinished)],
    ]);
    // A histogram's samples are <name>_bucket{le}, <name>_sum and <name>_count under one TYPE line.
    lines.push("# HELP jev_runner_run_duration_seconds Wall time of finished runs.", "# TYPE jev_runner_run_duration_seconds histogram");
    DURATION_BUCKETS.forEach((b, i) => lines.push(`jev_runner_run_duration_seconds_bucket${label({ le: String(b) })} ${this.#durationBuckets[i]}`));
    lines.push(
      `jev_runner_run_duration_seconds_bucket${label({ le: "+Inf" })} ${this.#durationCount}`,
      `jev_runner_run_duration_seconds_sum ${this.#durationSum}`,
      `jev_runner_run_duration_seconds_count ${this.#durationCount}`,
    );
    return `${lines.join("\n")}\n`;
  }
}
