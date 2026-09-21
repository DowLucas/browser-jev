// Recall benchmark: runs the explorer against the demo app and reports which planted bugs it found.
// Run it before and after changing judgment thresholds or exploration, so that reducing false
// positives on one site cannot silently reduce what the tester finds.
//
//   npm run demo:server &   npm run bench [-- --sessions 12 --steps 25]
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { resolveConfig } from "../src/config.ts";
import type { FindingGroup } from "../src/findings.ts";
import { executeRun } from "../src/run.ts";
import { FairSlots } from "../src/slots.ts";

const { values } = parseArgs({ options: { sessions: { type: "string" }, steps: { type: "string" }, url: { type: "string" } } });
const base = values.url ?? "http://127.0.0.1:4173/";

type Check = (g: FindingGroup) => boolean;
const at = (g: FindingGroup, path: string) => new URL(g.example.url).pathname.startsWith(path);
/** Each planted bug in demo/server.mjs (tagged PLANTED) and what counts as finding it. */
const PLANTED: Record<string, Check> = {
  "Save handler throws (uncaught ReferenceError)": (g) => g.example.message.includes("saveProfile"),
  "500 with stack trace on /products/7": (g) => at(g, "/products/7"),
  "missing /api/preferences (404)": (g) => g.example.message.includes("/api/preferences"),
  "'Showing 12 results' over a shorter list": (g) => g.category === "count-mismatch",
  "untranslated i18n keys": (g) => g.category === "untranslated-text",
  "ERR_EMPTY_COLLECTION with no way to recover": (g) => at(g, "/orders") && ["confusing", "broken", "dead-end"].includes(g.category),
  "dead end on /help": (g) => g.category === "dead-end" && at(g, "/help"),
  "promo banner covers the navigation": (g) => g.category === "covered-control",
  "reflected XSS on /search": (g) => g.category === "xss-dialog",
  "500 on a long order name (POST /orders)": (g) => g.category === "http-5xx" && g.example.message.startsWith("POST"),
  "assistant never answers an empty message": (g) => g.category === "slow-response" && at(g, "/assistant"),
};

const cfg = resolveConfig({
  startUrl: base,
  sessions: Number(values.sessions ?? 12),
  workers: 6,
  steps: Number(values.steps ?? 25),
  // The demo app is disposable, and some planted bugs only show once a submission reaches it.
  mode: "interact",
  confirmDisposable: true,
});
const browser = await chromium.launch();
const outDir = await mkdtemp(join(tmpdir(), "jev-bench-"));
const outcome = await executeRun(cfg, {
  browser,
  slots: new FairSlots(cfg.workers),
  runId: "bench",
  outDir,
  log: { info: () => {}, warn: () => {} },
});
await browser.close();

const groups = [...outcome.groups, ...outcome.suppressed];
let found = 0;
for (const [bug, check] of Object.entries(PLANTED)) {
  const hit = groups.some(check);
  found += Number(hit);
  console.log(`${hit ? "FOUND " : "missed"}  ${bug}`);
}
const unplanted = groups.filter((g) => !Object.values(PLANTED).some((check) => check(g)));
console.log(`\nrecall ${found}/${Object.keys(PLANTED).length} planted bugs · ${groups.length} finding groups · ${unplanted.length} not matching a planted bug`);
console.log(`${outcome.summary.jevCalls} Jev calls · report: ${outcome.reportPath}`);
