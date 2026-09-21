# Security policy

## Reporting a vulnerability

Please report security issues privately, not in a public issue: use **Report a vulnerability** under
this repository's **Security** tab (GitHub private vulnerability reporting). Include what an attacker
can do, and the steps to reproduce it.

You can expect a first reply within a week. Fixes land on `main`, and the runner image is rebuilt from it.

## What counts

Especially interesting, because the tool acts on live sites and holds login sessions:

- a way past the network fence, the write fence of a mode, the forbidden-controls list or the
  production-hostname check
- a way for a runner API client or a target page to read saved login sessions, or files on the runner
- a way to point the runner at private or internal addresses it should refuse
- authentication bypass on the runner's API or UI

Findings browser-jev reports *about the site under test* are not vulnerabilities in browser-jev.

## Supported versions

Only the latest `main` (and the `latest` runner image) is supported.
