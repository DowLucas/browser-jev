import { exec } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { FindingGroup } from "./findings.ts";
import { ORACLE_KEYS } from "./judge.ts";
import type { JudgmentRecord } from "./session.ts";

const execAsync = promisify(exec);

export interface RunSummary {
  startUrl: string;
  sessions: number;
  steps: number;
  jevCalls: number;
  judgeErrors: number;
  inputTokens: number;
  blockedHosts: string[];
  mode: string;
  /** describeFocus() of the run's focus. */
  focus: string;
  /** Distinct pages judged (ids collapsed): inside the focus area when there is one. */
  pagesCovered: string[];
  /** Times sessions left the focus area and were returned to the entry page. */
  focusReturns: number;
  blockedWrites: string[];
  /** Writes that reached the server, with counts. */
  writesSent: Record<string, number>;
  durationMs: number;
}

export interface ReportInput {
  summary: RunSummary;
  groups: FindingGroup[];
  suppressed: FindingGroup[];
  judgments: JudgmentRecord[];
}

const BUCKETS = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95];

/** For calibration: how many judgments cross each confidence level, per oracle question. */
export function calibrationTable(judgments: readonly JudgmentRecord[]): string {
  const header = `| question | ${BUCKETS.map((b) => `≥${b}`).join(" | ")} |`;
  const divider = `|---|${BUCKETS.map(() => "---").join("|")}|`;
  const rows = ORACLE_KEYS.map((key) => {
    const counts = BUCKETS.map((b) => judgments.filter((j) => j.oracle[key] >= b).length);
    return `| ${key} | ${counts.join(" | ")} |`;
  });
  return [header, divider, ...rows].join("\n");
}

export function renderMarkdown({ summary, groups, suppressed, judgments }: ReportInput): string {
  const fails = groups.filter((g) => g.level === "fail");
  const warns = groups.filter((g) => g.level === "warn");
  const section = (title: string, list: FindingGroup[]) =>
    list.length
      ? `## ${title} (${list.length})\n\n${list.map(renderGroup).join("\n")}`
      : `## ${title} (0)\n\nNone.\n`;

  return `# Adversarial exploration report

- Start URL: ${summary.startUrl}
- Sessions: ${summary.sessions} × ${summary.steps} steps
- Jev calls: ${summary.jevCalls} (${summary.judgeErrors} errors), ${summary.inputTokens} input tokens
- Duration: ${(summary.durationMs / 1000).toFixed(1)}s
- Blocked off-origin hosts: ${summary.blockedHosts.join(", ") || "none"}
- Mode: ${summary.mode}
- Focus: ${summary.focus}
- Pages covered: ${summary.pagesCovered.length}${listPages(summary.pagesCovered)}${
    summary.focusReturns ? `\n- Returned to the entry page after leaving the focus area: ${summary.focusReturns}×` : ""
  }
- Writes sent to the server: ${listWrites(summary.writesSent)}
- Writes blocked: ${summary.blockedWrites.length ? summary.blockedWrites.map((w) => `\`${w}\``).join(", ") : "none"}
- Suppressed by baseline: ${suppressed.length}

${section("Failures", fails)}
${section("Warnings", warns)}
## Calibration

Judgments crossing each confidence level (${judgments.length} judgments). Run against a known-good
build: anything counted here at your fail threshold is a false positive.

${calibrationTable(judgments)}
`;
}

function listWrites(writes: Record<string, number>): string {
  const entries = Object.entries(writes).sort((a, b) => b[1] - a[1]);
  return entries.length ? entries.map(([w, n]) => `\`${w}\` ×${n}`).join(", ") : "none";
}

function listPages(pages: readonly string[]): string {
  if (!pages.length) return "";
  const shown = [...pages].sort().slice(0, 30).map((p) => `\`${p}\``);
  return ` (${shown.join(", ")}${pages.length > 30 ? `, and ${pages.length - 30} more` : ""})`;
}

function renderGroup(g: FindingGroup): string {
  const f = g.example;
  return `### [${g.level.toUpperCase()}] ${g.category} — ${f.url}

- Fingerprint: \`${g.fingerprint}\` — seen ${g.count}× in ${g.sessions.length} session(s)
- ${f.message}
- Trigger: ${f.trigger} (persona: ${f.persona}, step ${f.step})${f.observed ? `\n- Observed after trigger: ${f.observed}` : ""}
${f.tracePath ? `- Trace: \`npx playwright show-trace ${f.tracePath}\`\n` : ""}`;
}

/** A self-contained ticket for a failing finding; this is what the coding agent receives. */
export function renderTicket(g: FindingGroup): string {
  const f = g.example;
  return `# ${g.category} on ${new URL(f.url).pathname}

Found by adversarial exploration (${f.source} oracle). Seen ${g.count}× across ${g.sessions.length} session(s).

## What was observed

${f.message}

URL: ${f.url}
${f.observed ? `After the last step: ${f.observed}\n` : ""}${f.confidence !== undefined ? `Confidence: ${f.confidence.toFixed(2)}, severity ${f.severity?.toFixed(2)}/4\n` : ""}
## Steps taken (persona: ${f.persona})

1. Open the start page
${f.actionLog.map((a, i) => `${i + 2}. ${a}`).join("\n")}

## Evidence

${f.tracePath ? `Playwright trace (DOM snapshots, screenshots, network, console for every step):\n\n    npx playwright show-trace ${resolve(f.tracePath)}\n` : "No trace recorded."}

## Task

Reproduce this with a Playwright test that fails on the current build, find the root cause, and fix it.
If the behavior is intended, say so and explain which spec covers it.
`;
}

export async function writeOutputs(outDir: string, input: ReportInput, escalateCommand?: string) {
  await writeFile(join(outDir, "report.md"), renderMarkdown(input));
  await writeFile(
    join(outDir, "report.json"),
    JSON.stringify({ summary: input.summary, findings: input.groups, suppressed: input.suppressed }, null, 2),
  );
  await writeFile(
    join(outDir, "judgments.jsonl"),
    input.judgments.map((j) => JSON.stringify(j)).join("\n"),
  );

  const fails = input.groups.filter((g) => g.level === "fail");
  if (!fails.length) return;
  const ticketDir = join(outDir, "escalations");
  await mkdir(ticketDir, { recursive: true });
  for (const g of fails) {
    const ticketPath = resolve(ticketDir, `${g.fingerprint}.md`);
    await writeFile(ticketPath, renderTicket(g));
    if (!escalateCommand) continue;
    const command = escalateCommand.replaceAll("{ticket}", ticketPath);
    console.log(`Escalating ${g.fingerprint}: ${command}`);
    await execAsync(command).catch((err: Error) => console.warn(`Escalation failed: ${err.message}`));
  }
}
