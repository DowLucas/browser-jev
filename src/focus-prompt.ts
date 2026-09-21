import { assertSetupAllowed, resolveConfig } from "./config.ts";
import { validateFocus } from "./focus.ts";
import { formatStep, parseSetup, SETUP_ROLES } from "./setup.ts";

/**
 * A prompt for Claude Code, run inside the target app's repository, that writes the Focus and setup
 * section of a run. The repo has what the runner cannot see: the routes, and the exact button and
 * label text that setup steps must match. The answer is one JSON object, validated by
 * parseFocusSuggestion before anything reaches the form.
 */
export interface FocusSuggestion {
  /** Replaces the start URL when the flow is better entered elsewhere; same origin. */
  startUrl?: string;
  instructions?: string;
  includePaths: string[];
  excludePaths: string[];
  /** Setup script text, normalized. */
  setup: string;
  /** Write paths setup needs, for observe-writes. */
  allowedWritePaths: string[];
  /** How long to wait for slow responses, when the flow has them (e.g. an LLM behind a chat box). */
  maxWaitSeconds?: number;
  notes?: string;
}

export function focusPrompt(opts: { startUrl: string; goal: string; forbiddenPatterns: readonly string[] }): string {
  const goal = opts.goal.trim() || "(not given: ask me what flow or area to focus on before writing anything)";
  return `I use browser-jev, an adversarial browser tester: AI agents click, type and navigate a web app
looking for bugs. I want a run focused on one part of the app. You are in the app's repository.
Read the code and write the run's Focus and setup section.

What I want to test: ${goal}
The run's start URL is: ${opts.startUrl}

Read the routes/pages for this flow, the components on them, and how the flow gets its state
(forms, API calls, cookies, local storage). Then answer with ONE \`\`\`json code block, and nothing
after it, in exactly this shape:

\`\`\`json
{
  "startUrl": "/path",
  "instructions": "...",
  "includePaths": ["/path", "/area/*"],
  "excludePaths": [],
  "setup": ["goto /...", "click button \\"...\\""],
  "allowedWritePaths": [],
  "maxWaitSeconds": 45,
  "notes": "..."
}
\`\`\`

## instructions: what the agents concentrate on
- At most 4 sentences and 600 characters. Name the flow's steps and what is most likely to break:
  calculations, state carried between steps, validation, edge cases specific to this code. Point at
  risks you saw in the code; say what to exercise, not how to verify it.
- Concrete and narrow beats broad. Do not restate generic testing advice; the agents already probe
  inputs, double submits, back/forward and edited URLs on their own.

## includePaths / excludePaths: where the agents may go (enforced in code)
- Each is a URL path: exact ("/cart") or a prefix ending in /* ("/checkout/*" covers /checkout and
  everything below it, but not /checkout-old). Only the path counts; query strings are ignored.
- includePaths: every page of the flow, including pages it redirects between, or agents are sent back
  whenever the flow moves on. Empty means the whole app. Do not list "/x" next to "/x/*": the
  prefix already covers it.
- excludePaths: pages inside that area the agents must never open (payment, destructive actions).
- The start URL is the entry point: it must be inside includePaths and not excluded. Sessions start
  there after setup and return there whenever they leave the area.

## startUrl: the entry point (optional)
- A path on the same site as ${opts.startUrl}, if the flow is better entered from another page.
  Leave it out to keep the current start URL.

## setup: steps run before every session to create the state the flow needs (optional)
Use it only when the entry page needs prior state (an item in the cart, a created draft). One step
per string, in this grammar:

  goto <path or same-site URL>
  click <role> "<accessible name>"          e.g. click button "Add to cart"
  click "<visible text>"
  fill <role> "<accessible name>" with "<value>"
  fill "<label text>" with "<value>"
  select <role> "<accessible name>" option "<option text>"
  press <Key>                               Enter, Escape, Tab, ArrowDown, ...
  wait for "<text that appears on the page>"
  back

- Append nth <k> (1-based) to a target when several elements share the name.
- Roles: ${SETUP_ROLES.join(", ")}.
- Names must be the exact accessible name as rendered: aria-label if set, else the visible text of the
  button/link, or the <label> text of a field. Resolve i18n keys and components to the final
  English text. If you cannot be sure of a name, prefer goto to a URL over clicking.
- End with a wait for "<text>" that only appears when setup succeeded, so a silent failure is caught.
- Setup runs in the same sandbox as the run, so it must follow the same rules:
  - Stay on ${new URL(opts.startUrl).host}.
  - Never click or fill anything whose name or URL matches these patterns (case-insensitive regex):
    ${opts.forbiddenPatterns.join(" | ")}
    To get past such a button, goto the page it leads to instead.
  - Never put a password or real credential in setup. Signing in is done with a saved login in the
    runner; say in notes if the flow needs one.

## allowedWritePaths: writes that must reach the server (optional)
By default the run blocks every POST/PUT/PATCH/DELETE. List the exact paths (or /prefix/*), taken from
the code, that setup must write to (e.g. the add-to-cart endpoint), and the flow's own submit if its
later pages can only be reached through it. Keep it minimal: every agent's writes to these paths go
through too and change data on the target, so say in notes that the target must be a disposable
staging environment when you list any.

## maxWaitSeconds: how long a slow response may take (optional)
After an action, agents keep waiting while the page is visibly still working, up to this many seconds
(default 45, max 300). Raise it when the flow calls something slow: an LLM or other AI service, report
generation, payment or third-party APIs. Look at what the endpoints behind the flow call, and any
timeouts in the code. Leave it out otherwise.

## notes
One or two sentences: what I must do in the runner (pick a saved login, a mode) or anything you were
unsure about.`;
}

/**
 * Pull the JSON out of Claude Code's answer (a ```json block, or the bare object) and check it with
 * the same rules a run uses, so a bad suggestion fails here with a reason instead of at run time.
 */
export function parseFocusSuggestion(text: string, startUrl: string, forbiddenPatterns: readonly string[]): FocusSuggestion {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]!);
  const candidates = fenced.length ? fenced : [text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)];
  let raw: Record<string, unknown> | undefined;
  for (const c of candidates.reverse()) {
    try {
      const v = JSON.parse(c) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        raw = v as Record<string, unknown>;
        break;
      }
    } catch {
      // try the next block
    }
  }
  if (!raw) throw new Error("No JSON object found. Paste Claude Code's whole answer, including the ```json block.");

  const strings = (key: string): string[] => {
    const v = raw![key] ?? [];
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new Error(`"${key}" must be a list of strings`);
    return v.map((x) => x.trim()).filter(Boolean);
  };
  const text_ = (key: string): string | undefined => {
    const v = raw![key];
    if (v === undefined || v === null || v === "") return undefined;
    if (typeof v !== "string") throw new Error(`"${key}" must be a string`);
    return v.trim();
  };

  const start = text_("startUrl");
  let entry = startUrl;
  if (start) {
    entry = new URL(start, startUrl).href;
    if (new URL(entry).origin !== new URL(startUrl).origin) {
      throw new Error(`"startUrl" ${start} is on another site than ${startUrl}; it must stay on the same site`);
    }
  }
  const setupValue = raw.setup;
  const setupLines = typeof setupValue === "string" ? setupValue.split(/\r?\n/) : strings("setup");
  const steps = parseSetup(setupLines);
  const focus = validateFocus({ instructions: text_("instructions"), includePaths: strings("includePaths"), excludePaths: strings("excludePaths") }, entry);
  const allowedWritePaths = strings("allowedWritePaths");
  const maxWait = raw.maxWaitSeconds;
  if (maxWait !== undefined && maxWait !== null && !(Number.isInteger(maxWait) && (maxWait as number) >= 1 && (maxWait as number) <= 300)) {
    throw new Error('"maxWaitSeconds" must be a whole number from 1 to 300');
  }
  const bad = allowedWritePaths.find((p) => !p.startsWith("/"));
  if (bad) throw new Error(`Write path "${bad}" must start with "/"`);
  // The same allowlist and forbidden-control checks as a run.
  const cfg = resolveConfig({ startUrl: entry, focus, setup: steps, useModel: false });
  cfg.forbiddenPatterns = [...forbiddenPatterns];
  assertSetupAllowed(cfg);

  return {
    ...(start ? { startUrl: entry } : {}),
    ...(focus.instructions ? { instructions: focus.instructions } : {}),
    includePaths: focus.includePaths,
    excludePaths: focus.excludePaths,
    setup: steps.map(formatStep).join("\n"),
    allowedWritePaths,
    ...(typeof maxWait === "number" ? { maxWaitSeconds: maxWait } : {}),
    ...(text_("notes") ? { notes: text_("notes") } : {}),
  };
}
