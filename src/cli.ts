import { join } from "node:path";
import { chromium } from "playwright";
import { loadConfig } from "./config.ts";
import { executeRun } from "./run.ts";
import { assertSafeTarget } from "./safety.ts";
import { FairSlots } from "./slots.ts";
import { detectScreen } from "./watch.ts";

async function main(): Promise<number> {
  const cfg = await loadConfig(process.argv.slice(2));
  assertSafeTarget(cfg);

  // One browser, many contexts: each context is an isolated session at a fraction of a browser's cost.
  const browser = await chromium.launch({
    // We own Ctrl+C (see stop below), so a partial run still gets its report.
    handleSIGINT: false,
    headless: cfg.headless,
    slowMo: cfg.watch ? cfg.slowMoMs : undefined,
  });
  // Ctrl+C or a closed browser stops new sessions but still writes the report for what ran.
  let stopReason: string | undefined;
  let finished = false;
  const stop = (reason: string) => {
    if (stopReason || finished) return;
    stopReason = reason;
    console.log(`\n${reason}; finishing the current steps, saving traces and writing the report (Ctrl+C again to quit).`);
    process.once("SIGINT", () => process.exit(130));
  };
  process.once("SIGINT", () => stop("Interrupted"));
  browser.on("disconnected", () => stop("Browser closed"));

  try {
    const outcome = await executeRun(cfg, {
      browser,
      slots: new FairSlots(cfg.workers),
      runId: "cli",
      outDir: join(cfg.outDir, `run-${new Date().toISOString().replace(/[:.]/g, "-")}`),
      shouldStop: () => stopReason !== undefined,
      screen: cfg.watch ? await detectScreen() : undefined,
    });
    return outcome.failing > 0 ? 1 : 0;
  } finally {
    finished = true;
    await browser.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err: Error) => {
    console.error(err.message);
    process.exit(2);
  },
);
