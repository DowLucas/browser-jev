// Capture a logged-in session for a throwaway test account, for use with --storage-state.
//
//   npm run auth:save -- <url> [out-file]
//
// Opens a visible browser at <url>. Log in by hand, then close the window. The session is saved
// and re-checked, and the hosts and request methods the app used are printed, so the explorer's
// allowlist and mode (e.g. observe-writes paths for apps that read via POST) can be set to match.
import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { chromium } from "playwright";

const [url, out = "auth/state.json"] = process.argv.slice(2);
if (!url) {
  console.error("Usage: npm run auth:save -- <url> [out-file]");
  process.exit(2);
}

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();

/** "METHOD host" -> count, plus one example path each. */
const traffic = new Map<string, { count: number; example: string }>();
context.on("request", (req) => {
  const u = new URL(req.url());
  if (!u.protocol.startsWith("http")) return;
  const key = `${req.method().padEnd(6)} ${u.host}`;
  const entry = traffic.get(key) ?? { count: 0, example: u.pathname };
  entry.count++;
  traffic.set(key, entry);
});

await page.goto(url);
console.log("\nLog in in the browser window. Once you see the logged-in app, close the window.\n");
await page.waitForEvent("close", { timeout: 0 });

await mkdir(dirname(out), { recursive: true });
await context.storageState({ path: out, indexedDB: true });
await chmod(out, 0o600);
console.log(`Saved session to ${out} (readable only by you; it is a credential, keep it out of git).`);

console.log("\nTraffic during login (method, host, requests, example path):");
for (const [key, { count, example }] of [...traffic].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`  ${key}  ×${count}  ${example}`);
}

// Re-open with only the saved state and see where we land.
const check = await browser.newContext({ storageState: out });
const checkPage = await check.newPage();
await checkPage.goto(url);
await checkPage.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
console.log(`\nCheck with the saved session only: landed on ${checkPage.url()} ("${await checkPage.title()}")`);
console.log("If that is a login page, the app keeps its session somewhere Playwright cannot save (e.g. sessionStorage).");
await browser.close();
