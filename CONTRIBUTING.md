# Contributing

Thanks for helping. Bug reports, false-positive reports and pull requests are all welcome.

## Setup

Node 20 or later.

```sh
npm install
npx playwright install chromium
npm run typecheck
npm test             # unit tests plus browser tests against the demo app; no API key needed
```

Most work needs no model key: `npm run explore -- --url http://127.0.0.1:4173/ --no-model` runs the free
oracle and a random explorer against the demo app (`npm run demo:server`). Judgment and navigation by
Jev need a `TYPESAFE_API_KEY` in `.env`; `npm run bench` measures recall on the demo app's planted bugs
with one.

## Pull requests

- Keep a change to one thing, and say in the description what it fixes and how you checked it.
- Add or update a test. Browser behaviour belongs in a test against `demo/server.mjs`; if you need a new
  kind of bug to find, plant it there and tag it `PLANTED`.
- `npm run typecheck` and `npm test` must pass; CI runs both on every pull request.
- Match the surrounding code: comments explain *why*, not what.

## Safety rules the code keeps

The explorer clicks and submits things on real sites, so a few rules are load-bearing. A change that
weakens one needs a strong reason in the pull request:

- Observe mode is the default and lets no writes through.
- The forbidden-controls list and the production-hostname check apply in every mode, including setup steps.
- Requests to hosts outside the allowlist are blocked.
- Saved logins never leave the runner: the API returns summaries, never cookie or storage values.

## Reporting a false positive

A finding that is not a bug is worth an issue: include the report's finding (category, message,
trigger) and, if you can, the trace from `out/run-*/traces/`. Remove anything private from the trace
first: it holds screenshots and page contents.
