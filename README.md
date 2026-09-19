# browser-jev

Adversarial browser exploration. Playwright drives the clicks, but no script decides where they go. Jev decides where to go next and whether each page state looks broken.

Every step makes **one** Jev call. It carries six oracle nouls (broken, count mismatch, untranslated text, confusing, leaks internals, dead end), one severity score and one next-action choice. The state is read once and every question is answered in parallel. Code-only checks run first at no cost.

## Setup

```sh
npm install
npx playwright install chromium
echo "TYPESAFE_API_KEY=..." > .env   # gitignored; npm scripts load it
npm run jev:check          # one tiny call to verify the key and question shapes
```

## Run

```sh
# Demo app with planted bugs (http://127.0.0.1:4173)
npm run demo:server

# Build step 1: free oracle only, random explorer, no model
npm run explore -- --url http://127.0.0.1:4173/ --allow 127.0.0.1 --no-model

# Build step 2: Jev judgment and action selection, one worker, one persona
npm run explore -- --url http://127.0.0.1:4173/ --allow 127.0.0.1 --sessions 1 --workers 1 --persona sloppy

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

## Runner service (queue + HTTP API)

`src/runner/server.ts` runs exploration jobs from a queue on one shared browser. A global cap on open browser contexts (`RUNNER_CONTEXTS`) is the memory limit. Free slots rotate between active runs, so a big run can't starve a small one. Jobs are files on disk: a restart re-queues whatever was running, and `SIGTERM` lets runs finish their current step and keep their reports.

```sh
RUNNER_TOKEN=$(openssl rand -hex 32) TYPESAFE_API_KEY=... npm run runner

curl -X POST localhost:8080/runs -H "Authorization: Bearer $RUNNER_TOKEN" -H 'content-type: application/json' \
  -d '{"startUrl":"https://staging.example.dev/","allowedHosts":["staging.example.dev"],"sessions":20,"workers":4,"authState":"staging"}'
```

| Endpoint | |
|---|---|
| `GET /health` | Queue depth and slot usage (no auth) |
| `POST /runs` | Submit a run. Read-only by default; unknown or mistyped fields are rejected |
| `GET /runs`, `GET /runs/:id` | Status and outcome |
| `GET /runs/:id/log` | Live progress log |
| `GET /runs/:id/report`, `/report.json` | Findings |
| `POST /runs/:id/cancel` | Cancel a queued run, or stop a running one (it keeps its report) |

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
| Personas shape the action set (double-clicks, adversarial input, direct URL entry, unvisited-page hints) and the choice prompt | `src/personas.ts`, `src/actions.ts` |
| Warning band: fail only on high confidence **and** high severity | `classifyJudgment` in `src/judge.ts` |
| Fingerprint: category + normalized path (ids and UUIDs collapsed) + trigger. Every way of just arriving at a page counts as one trigger | `src/findings.ts`, `triggerKey` in `src/actions.ts` |
| Safety: explicit allowlist, refuse production-looking hosts, block all off-allowlist requests, skip forbidden controls by name and href | `src/safety.ts`, `src/config.ts` |
| One browser, many contexts | `src/cli.ts` |
| Spec/ticket in the state, so intended changes are not flagged | `--spec <file>` |

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
