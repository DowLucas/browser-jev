import { choice, type JsonValue, noul, score, type TypeSafeClient } from "@typesafe-ai/sdk";
import { describeAction, type Action } from "./actions.ts";
import type { Thresholds } from "./config.ts";
import type { Level } from "./findings.ts";
import type { Persona } from "./personas.ts";

/**
 * Oracle questions: key in the Jev request -> finding category.
 * Keep each question narrow. Measured on the demo app, a focused question ("is any text an
 * untranslated key?") scores 0.98 on the bug and 0.02 on a healthy page, while the same example
 * tucked into a broad question scored 0.30. Questions are nearly free, so split rather than stuff.
 */
export const ORACLE_CATEGORIES = {
  broken: "broken",
  count_mismatch: "count-mismatch",
  untranslated: "untranslated-text",
  confusing: "confusing",
  leaks_internals: "leaks-internals",
  dead_end: "dead-end",
} as const;
type OracleKey = keyof typeof ORACLE_CATEGORIES;

const SEVERITY_RUBRIC = [
  "Nothing is wrong",
  "Cosmetic: a typo or minor polish issue",
  "Minor: annoying, but the user can continue",
  "Major: a feature is broken or the data shown is wrong",
  "Critical: data loss, security exposure, crash, or the user is fully blocked",
] as const;

export interface Judgment {
  oracle: Record<OracleKey, number>;
  /** Expected severity on the 0-4 rubric. */
  severity: number;
  /** Index into the candidate actions. */
  actionIndex: number;
  actionConfidence: number;
  inputTokens: number;
}

export interface JudgedIssue {
  category: string;
  level: Level;
  confidence: number;
  severity: number;
  message: string;
}

/**
 * One Jev call per step answering the oracle questions and the next-action question together:
 * the state is read once and every question is evaluated in parallel against it.
 */
export async function judgeStep(
  client: TypeSafeClient,
  state: { [key: string]: JsonValue },
  actions: readonly Action[],
  persona: Persona,
  actionNotes: (a: Action) => string,
  random: () => number,
  /** The run's focus instructions, if any: they narrow where the tester goes, not what counts as a bug. */
  focus?: string,
): Promise<Judgment> {
  const actionCriteria = Object.fromEntries(
    actions.map((a, i) => [`a${i}`, `${describeAction(a)}${actionNotes(a)}`]),
  );

  const { answers, usage } = await client.systemOne({
    state,
    questions: {
      broken: noul(
        "Does the current page show clear evidence that something is broken? For example: an error " +
          "page, missing data where data is expected, or the last action visibly doing nothing. " +
          "A submit blocked by browser validation (see fieldsBlockedByBrowserValidation) is working " +
          "as intended. Behavior described in the spec as intended is not broken. If pageStillWorking " +
          "is set, the app has not finished responding yet: a missing answer or result is not evidence " +
          "of breakage on its own.",
      ),
      count_mismatch: noul(
        "Look at the ariaSnapshot. Is there a heading or text stating a count of results or items, " +
          "directly followed by a list with a different number of listitem entries? A '- list' line " +
          "with nothing under it has zero entries.",
        {
          true: "A stated count disagrees with the items listed",
          false: "Counts match the items listed, or no count is stated",
        },
      ),
      untranslated: noul(
        "Is any visible text an untranslated localization key, i.e. a dot.separated.identifier such " +
          "as settings.notifications.title shown instead of human-readable copy?",
      ),
      confusing: noul(
        "Would a typical end user be confused or stuck here? For example: an error message or error " +
          "code with no stated way to recover, contradictory instructions, or unlabeled controls.",
      ),
      leaks_internals: noul(
        "Does the page show internal implementation details to the end user? For example: stack " +
          "traces, SQL, server file paths, exception class names, raw JSON error bodies, debug output, " +
          "or unrendered template syntax like {{name}}. Text the tester typed (valuesTypedThisSession) " +
          "shown back as data is user input, not a leak.",
      ),
      dead_end: noul(
        "Is this page a dead end, with no visible way for the user to continue or return other than " +
          "the browser's back button? A page that is still loading (pageStillWorking) is not a dead end.",
      ),
      severity: score("If anything is wrong on this page, how severe is it for the end user?", SEVERITY_RUBRIC),
      next_action: choice(
        `You are exploring this web app as a tester. ${persona.strategy} ` +
          (focus
            ? `This run is focused on: ${focus}. Stay in that area and work through it in depth; ` +
              "pick actions elsewhere only when they lead back into it. "
            : "") +
          "Pick the next action most likely to uncover a bug nobody has tested for. " +
          "Prefer actions that have not been tried yet.",
        actionCriteria,
      ),
    },
  });

  const picked = sampleChoice(answers.next_action.probabilities, random) ?? answers.next_action.choice;
  return {
    oracle: {
      broken: answers.broken.noul,
      count_mismatch: answers.count_mismatch.noul,
      untranslated: answers.untranslated.noul,
      confusing: answers.confusing.noul,
      leaks_internals: answers.leaks_internals.noul,
      dead_end: answers.dead_end.noul,
    },
    severity: answers.severity.score,
    actionIndex: Number(picked.slice(1)),
    actionConfidence: answers.next_action.probabilities[picked] ?? 0,
    inputTokens: usage.input_tokens,
  };
}

/**
 * Sample from the model's distribution instead of taking the argmax, so parallel workers with the
 * same persona diverge rather than all walking the same path.
 */
function sampleChoice(probabilities: Record<string, number>, random: () => number): string | undefined {
  const entries = Object.entries(probabilities);
  const total = entries.reduce((sum, [, p]) => sum + p, 0);
  let r = random() * total;
  for (const [label, p] of entries) {
    r -= p;
    if (r <= 0) return label;
  }
  return entries.at(-1)?.[0];
}

/** Apply the warning band: only high-confidence, high-severity judgments fail the build. */
export function classifyJudgment(j: Judgment, t: Thresholds): JudgedIssue[] {
  const issues: JudgedIssue[] = [];
  for (const [key, category] of Object.entries(ORACLE_CATEGORIES) as [OracleKey, string][]) {
    const confidence = j.oracle[key];
    if (confidence < t.warnConfidence) continue;
    if (confidence < t.strongConfidence && j.severity < t.warnSeverity) continue;
    const level: Level = confidence >= t.failConfidence && j.severity >= t.failSeverity ? "fail" : "warn";
    issues.push({
      category,
      level,
      confidence,
      severity: j.severity,
      message: `Judged ${category} (p=${confidence.toFixed(2)}, severity=${j.severity.toFixed(2)}/4: ${
        SEVERITY_RUBRIC[Math.round(j.severity)]
      })`,
    });
  }
  return issues;
}

export const ORACLE_KEYS = Object.keys(ORACLE_CATEGORIES) as OracleKey[];
