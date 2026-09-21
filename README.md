# browser-jev

[![CI](https://github.com/DowLucas/browser-jev/actions/workflows/ci.yml/badge.svg)](https://github.com/DowLucas/browser-jev/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Adversarial browser exploration. Playwright drives the clicks, but no script decides where they go. Jev decides where to go next and whether each page state looks broken.

Every step makes **one** Jev call. It carries six oracle nouls (broken, count mismatch, untranslated text, confusing, leaks internals, dead end), one severity score and one next-action choice. The state is read once and every question is answered in parallel. Code-only checks run first at no cost.

## Setup

Needs Node 20 or later. Jev is the model behind the judgments, called through [`@typesafe-ai/sdk`](https://docs.typesafe.ai/sdk/javascript) with a `TYPESAFE_API_KEY`. Without a key, `--no-model` still runs the free checks (errors, crashes, broken requests, layout) with a random explorer, and the test suite needs no key at all.

```sh
npm install
npx playwright install chromium
echo "TYPESAFE_API_KEY=..." > .env   # gitignored; npm scripts load it
npm run jev:check          # one tiny call to verify the key and question shapes
npm run bench              # recall on the demo app's planted bugs (needs npm run demo:server)
```

## Run

```sh
# Demo app with planted bugs (http://127.0.0.1:4173)
npm run demo:server

# Build step 1: free oracle only, random explorer, no model
npm run explore -- --url http://127.0.0.1:4173/ --no-model

# Build step 2: Jev judgment and action selection, one worker, one persona
npm run explore -- --url http://127.0.0.1:4173/ --sessions 1 --workers 1 --persona sloppy

# Or use a config file (see explorer.config.example.json)
npm run explore -- --config explorer.config.json
```

Each run writes to `out/run-<timestamp>/`:

| File | Contents |
|---|---|
| `report.md` / `report.json` | Deduplicated findings (failures, then warnings) and a calibration table |
| `judgments.jsonl` | Every Jev judgment, for calibration |
| `traces/<session>.zip` | Playwright trace. Only sessions with findings keep one. Open with `npx playwright show-trace` |
| `escalations/<fingerprint>.md` | One ticket per failing finding. `--escalate "<cmd {ticket}>"` passes it to a coding agent |

The exit code is 1 if any non-baselined finding fails, so the run can gate CI.

## Adversarial agents (personas)

Each session runs as one agent. An agent has **instructions**, which are sent to Jev at every step and steer which action it picks. It also has **behaviours** (`traits`), which decide in code which actions exist to pick from. Sessions go round-robin over the chosen agents.

| Agent | Behaviours | Hunts for |
|---|---|---|
| `impatient` | `double-submit`, `hasty` | duplicate submissions, races |
| `sloppy` | `adversarial-input` | validation gaps, encoding bugs, injection |
| `out-of-order` | `history` | broken multi-step state machines |
| `completionist` | none | empty states and rarely visited pages |
| `boundary` | `boundary-input` | off-by-one errors, overflow, rounding, accepted-but-invalid values |
| `url-tamperer` | `url-tamper` | crashes and raw errors on edited ids and query values, records it should not reach |
| `keyboard` | `keyboard` | mouse-only controls, forms that ignore Enter, dialogs Escape cannot close |

A 4xx on a URL the tamperer edited is the app correctly refusing it, so it is not reported. A 5xx, a crash or a stack trace still is.

**Your own agents:** in the runner UI, under *Adversarial agents*, add, edit or delete agents, or restore the built-ins. The library is stored in `<data>/personas.json`. A queued run keeps the agent definitions it was submitted with. On the CLI, define them inline in the config file's `personas` list (see `explorer.config.example.json`); `--persona <name>` then picks them by name.

**At most 10 sessions run at once**: `workers` per run, and `RUNNER_CONTEXTS` across the whole runner.

## Focus: one flow or area

By default a run explores the whole app. Focus points it at one part:

| Part | What it does |
|---|---|
| Instructions (`--focus`) | Given to every agent alongside its own instructions: what to concentrate on, e.g. "the checkout flow: cart, shipping, payment" |
| Include paths (`--focus-path`, repeatable) | Enforced in code. Links, revisits and edited URLs outside these paths are never offered. `/cart` is exact, `/checkout/*` covers `/checkout` and everything below it |
| Exclude paths (`--exclude-path`, repeatable) | Never entered, even inside an included area |

The start URL is the entry point, so it must be inside the area. A submit or a script can still land outside the area. When that happens, the session records what that page signalled (a 500 there still counts) and returns to the entry page. If the entry page itself redirects outside the area (usually to a login page), the session stops and says so: add a saved login. The report lists the focus, the distinct pages covered, and how often sessions had to be sent back.

```sh
npm run explore -- --url https://staging.example.dev/cart --focus "Checkout: quantities, discount codes, totals" \
  --focus-path /cart --focus-path "/checkout/*" --exclude-path /checkout/pay
```

In the runner UI it is the *Focus and setup* section of the *New run* form. In the API it is `"focus": {"instructions", "includePaths", "excludePaths"}`.

### Let Claude Code write the Focus section

In the runner UI, *Focus and setup → Let Claude Code write this section* builds a prompt from what you want to test and the start URL. Paste it into Claude Code, opened in the app's repository: it reads the routes and the exact button and field names that setup steps must match, and answers with one JSON block. Paste the whole reply back and *Apply to the form*. The answer is checked with the same rules a run uses (setup syntax, focus paths, forbidden controls, same site) before it fills anything. If the setup needs writes, the mode is widened from Observe to Observe + allowed writes for exactly those paths, never further. API: `POST /focus-prompt {startUrl, goal}` and `POST /focus-suggestion {startUrl, text}`.

### Setup steps: reach the state first

Some flows need state before there is anything to test, for example an item in the cart. Setup steps run before each session. Then the session goes to the start URL and explores from there. There is one step per line. Targets are found by role and accessible name, like the explorer finds them, so restyling does not break them:

```
goto /products/3
click button "Add to cart"
fill textbox "Coupon" with "SAVE10"
select combobox "Size" option "M"
press Enter
wait for "Added to cart"
back
```

A target is `<role> "<name>"`, or just `"<text>"` (visible text for `click`, the field's label for `fill` and `select`). Add `nth <k>` when several elements match. `#` starts a comment.

- **Record instead of writing:** *Record steps…* in the run form opens the start URL in a live browser on the runner, signed in with the chosen saved login. What you click and type becomes steps, and you can edit them before starting the run. Passwords are never recorded: sign in with a saved login. Recording uses a real, unfenced browser, so what you do there reaches the site.
- **Same safety as the run:** setup stays on the allowed hosts, never touches a forbidden control (use `goto` to reach a page behind one), and its requests pass through the mode's fence.
- **Failures are loud:** a step that cannot be done ends the session with a `setup-failed` finding, which fails the run by default. It names the step and the reason. If the mode blocked a write during setup (an add-to-cart POST in observe mode, say), it names that write too: allow the path with `observe-writes`. End a setup with `wait for "<text>"` so a step that silently did nothing is caught.

CLI: `--setup <file>`. Config file: `"setup"` as text or a list of lines. API: `"setup": "<text>"`.

## Modes: what may reach the server

The tester always clicks, types and submits. The mode decides which of the resulting requests reach the server:

| Mode | Writes that reach the server | Use for |
|---|---|---|
| `observe` (default) | None: POST/PUT/DELETE and WebSockets are blocked | Live sites, and a first look at anything |
| `observe-writes` | Only listed paths: exact (`/entity`), or a prefix ending in `/*` (`/api/*`) | Apps that load data with POST (e.g. Next.js server actions, GraphQL queries) |
| `interact` | All of them, after an explicit per-run confirmation that the environment is disposable | Staging with throwaway data: finds double submits and server-side validation bugs |

```sh
npm run explore -- --url https://staging.example.dev/ --mode observe-writes --allow-write /entity --allow-write /api/*
npm run explore -- --url https://staging.example.dev/ --mode interact --confirm-disposable
```

The forbidden-controls list and the production-hostname check apply in every mode. Every report lists the writes that were sent and the ones that were blocked.

## Saved logins

Runs can start signed in, using a saved login session: cookies, localStorage and IndexedDB. Use a throwaway test account, never a real one.

- **In the runner UI (works on a headless server):** under *Saved logins*, enter the site's login URL and click *Log in to a site…*. A live view of a browser on the runner opens; click and type in it as usual (single sign-on redirects work), then name the login and save it.
- **Upload** a session file captured elsewhere, e.g. with `npm run auth:save -- <url> auth/name.json` on a machine with a display.

Saved logins are stored owner-only in `<data>/auth/`. The API and UI show only which sites they cover, how many cookies they hold, and when they expire, never the values. Pick one in the *New run* form, or pass `"authState": "<name>"` to the API.

## Runner service (queue + HTTP API)

`src/runner/server.ts` runs exploration jobs from a queue on one shared browser. A global cap on open browser contexts (`RUNNER_CONTEXTS`, default and maximum 10) is the memory limit. Free slots rotate between active runs, so a big run can't starve a small one. Jobs are files on disk: a restart re-queues whatever was running, and `SIGTERM` lets runs finish their current step and keep their reports.

```sh
RUNNER_TOKEN=$(openssl rand -hex 32) TYPESAFE_API_KEY=... npm run runner

curl -X POST localhost:8080/runs -H "Authorization: Bearer $RUNNER_TOKEN" -H 'content-type: application/json' \
  -d '{"startUrl":"https://staging.example.dev/","sessions":20,"workers":4,"authState":"staging"}'
```

| Endpoint | |
|---|---|
| `GET /health` | Queue depth and slot usage (no auth) |
| `POST /runs` | Submit a run. Read-only by default; unknown or mistyped fields are rejected |
| `GET /runs`, `GET /runs/:id` | Status and outcome |
| `GET /runs/:id/log` | Live progress log |
| `GET /runs/:id/report`, `/report.json` | Findings, plus the run summary (focus, pages covered) |
| `POST /runs/:id/cancel` | Cancel a queued run, or stop a running one (it keeps its report) |
| `GET /personas` | The agent library, the behaviours they can use, and which agents are built-in |
| `POST /personas`, `PUT /personas/:name`, `DELETE /personas/:name` | Add, edit (or rename), delete an agent: `{"name","strategy","traits":[]}` |
| `POST /personas/restore-built-ins` | Reset edited built-ins and bring back deleted ones; your own agents stay |

`authState` names a session saved with `npm run auth:save` and copied to `<data>/auth/<name>.json`. The runner refuses private, loopback and single-label targets, and any domain in `RUNNER_BLOCKED_SUFFIXES`, so it can't be pointed at its neighbours.

**Deploy:** CI builds `ghcr.io/dowlucas/browser-jev-runner:latest` on every push to `main`. `deploy/docker-compose.yml` runs it with a Watchtower label, so hosts running Watchtower pick up new images automatically.

## Calibration (build step 3: do this before trusting failures)

```sh
# Against a build you know is healthy:
npm run explore -- --config explorer.config.json --write-baseline baseline.json
# Read the report's calibration table. Any judgment at or above your fail threshold is a
# false positive; raise thresholds.failConfidence / failSeverity until it is tolerable.
# Later runs:
npm run explore -- --config explorer.config.json --baseline baseline.json
```

## How it maps to the design

| Design point | Where |
|---|---|
| ARIA snapshot, URL, title, history, console errors and failed requests as state | `src/session.ts`, `src/page-model.ts` |
| Free oracle: console errors, uncaught exceptions, 4xx/5xx, crash, blank render, executed injections | `src/signals.ts` |
| One call, all questions | `src/judge.ts` |
| Personas shape the action set through their traits (double-clicks, adversarial and boundary input, direct and edited URLs, keyboard keys) and the choice prompt through their instructions | `src/personas.ts`, `src/actions.ts` |
| Warning band: fail only on high confidence **and** high severity | `classifyJudgment` in `src/judge.ts` |
| Fingerprint: category + normalized path (ids and UUIDs collapsed) + trigger. Every way of just arriving at a page counts as one trigger | `src/findings.ts`, `triggerKey` in `src/actions.ts` |
| Safety: allowlist (start URL host + explicit extras), refuse production-looking hosts, block all off-allowlist requests, skip forbidden controls by name and href | `src/safety.ts`, `src/config.ts` |
| One browser, many contexts | `src/cli.ts` |
| Spec/ticket in the state, so intended changes are not flagged | `--spec <file>` |
| Setup steps replayed before each session, recorded in the remote browser | `src/setup.ts`, `src/runner/login.ts`, `--setup` |
| Focus: instructions in the state and the action question; include/exclude paths enforced on candidate actions, with a return to the entry page | `src/focus.ts`, `--focus`, `--focus-path` |

Next actions are sampled from Jev's probability distribution rather than taking the top choice. That way parallel workers with the same persona spread out instead of walking the same path.

## What calibration on the demo app taught us

- **Narrow questions beat broad ones by a wide margin.** Untranslated keys scored 0.30 as an example inside the broad "confusing" question and 0.99 as their own question, with 0.02 on a healthy page. Questions are nearly free, so split instead of adding examples.
- **Give the model the context a human would have.** Two false positives came from missing context, not a weak model:
  - A submit blocked by the browser's own validation looks like a dead button, because the tooltip isn't in the ARIA snapshot. Fix: `fieldsBlockedByBrowserValidation` in the state.
  - The sloppy persona's `' OR '1'='1'` shown back on an order page scored leaks = 0.83. Fix: `valuesTypedThisSession` in the state, which brings it to 0.20.
- **The same state can score differently between calls** (0.72 to 0.87 on one page). That is why only high confidence **and** high severity fail a build.

## Known blind spots

- **Visual.** The state is text only, so overlapping elements, z-index, contrast and collapsed layouts are invisible to it. Pair this suite with pixel diffing.
- **Intent.** Without `--spec`, deliberate redesigns will be flagged.
- The fill actions use fixed persona input palettes. Jev picks among them but does not write text.

## Contributing

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Please report security
issues privately, as described in [SECURITY.md](SECURITY.md). Everyone taking part follows the
[code of conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE)
