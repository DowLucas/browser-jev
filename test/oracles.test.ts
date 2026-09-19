import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { type Browser, chromium, type Page } from "playwright";
import { ariaSnapshot, enumerateElements, type InteractiveElement, layoutIssues } from "../src/page-model.ts";
import { Settler } from "../src/settle.ts";

describe("in-page oracles", () => {
  let browser: Browser;
  let page: Page;
  before(async () => {
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  });
  after(() => browser.close());

  const elements = async (html: string, scrollY = 0) => {
    await page.setContent(`<!doctype html><body style="margin:0">${html}</body>`);
    if (scrollY) await page.evaluate((y) => window.scrollTo(0, y), scrollY);
    return enumerateElements(page);
  };
  const byName = (els: InteractiveElement[], name: string) => els.find((e) => e.name === name)!;

  it("flags controls under a fixed banner that no scroll can move them out from under", async () => {
    const els = await elements(`
      <nav><a href="/a">Orders</a> <a href="/b">Settings</a></nav>
      <div style="position:fixed;top:0;left:0;right:0;height:60px;background:#ffe">Spring sale! <button aria-label="Dismiss promo">x</button></div>`);
    assert.equal(byName(els, "Orders").coveredBy, "Spring sale! x");
    assert.equal(byName(els, "Dismiss promo").coveredBy, undefined);
  });

  it("does not flag content scrolled under a sticky header, since the user can scroll it back", async () => {
    const els = await elements(
      `<header style="position:sticky;top:0;height:80px;background:#eee">Header</header>
       <div style="height:300px"></div><a href="/x">Deep link</a><div style="height:2000px"></div>`,
      260,
    );
    assert.equal(byName(els, "Deep link").coveredBy, undefined);
  });

  it("flags footer links under a bottom cookie bar on a page too short to scroll them clear", async () => {
    const els = await elements(`
      <main style="height:560px">Content</main>
      <footer><a href="/privacy">Privacy Policy</a></footer>
      <div style="position:fixed;bottom:0;left:0;right:0;height:90px;background:#222;color:#fff">We use cookies</div>`);
    assert.equal(byName(els, "Privacy Policy").coveredBy, "We use cookies");
  });

  it("marks controls behind an open modal dialog as modal-covered, not a bug", async () => {
    const els = await elements(`
      <a href="/behind">Behind</a>
      <div role="dialog" aria-modal="true" style="position:fixed;inset:0;background:rgba(0,0,0,.5)">
        <button>Close</button></div>`);
    assert.equal(byName(els, "Behind").coveredByModal, true);
    assert.equal(byName(els, "Close").coveredBy, undefined);
  });

  it("ignores links inside a collapsed accordion answer instead of calling them covered", async () => {
    // One answer open at a time: the closed answer is height 0 with overflow hidden, and the next
    // question's button sits where its link would be.
    const els = await elements(`
      <div><button>01 Open question</button><div style="height:auto">Open answer <a href="/a">Read more</a></div></div>
      <div><button>02 Closed question</button>
        <div style="height:0;overflow:hidden"><p>Closed answer</p><a href="/daily-limit">The daily limit, explained</a></div></div>
      <div><button>03 Next question</button></div>
      <div inert><a href="/inert">Inert link</a></div>
      <div style="height:40px;overflow:auto"><div style="height:200px"></div><a href="/scrolled">Scrollable link</a></div>`);
    const names = els.map((e) => e.name);
    assert.ok(!names.includes("The daily limit, explained"), "collapsed answer link must not be enumerated");
    assert.ok(!names.includes("Inert link"));
    assert.ok(names.includes("Read more") && names.includes("Scrollable link"));
    assert.ok(els.every((e) => !e.coveredBy));
  });

  it("detects missing in-page anchors and submit buttons", async () => {
    const els = await elements(`
      <a href="#features">Features</a> <a href="#nowhere">Broken</a> <section id="features">F</section>
      <form><input name="q"><button type="submit">Go</button></form>
      <button>Toggle details</button> <button>Save</button>`);
    assert.equal(byName(els, "Features").anchor, "ok");
    assert.equal(byName(els, "Broken").anchor, "missing");
    assert.equal(byName(els, "Go").submit, true);
    assert.equal(byName(els, "Save").submit, true);
    assert.equal(byName(els, "Toggle details").submit, undefined);
  });

  it("reports horizontal overflow with its culprit, and clipped text without an ellipsis", async () => {
    await page.setContent(`<!doctype html><body style="margin:0">
      <div style="width:1400px">Wide export table</div>
      <p style="width:80px;overflow:hidden;white-space:nowrap">Free shipping on all orders this week</p>
      <p style="width:80px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">Intentionally truncated text</p>
    </body>`);
    const issues = await layoutIssues(page);
    assert.equal(issues.horizontalOverflow?.px, 600);
    assert.deepEqual(issues.horizontalOverflow?.culprits, ["Wide export table"]);
    assert.deepEqual(issues.clipped, ["Free shipping on all orders this week"]);
  });

  it("does not flag screen-reader-only text as clipped", async () => {
    await page.setContent(`<!doctype html><body>
      <span style="position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0">Rated 5.0 out of 5 on the App Store</span>
    </body>`);
    assert.deepEqual((await layoutIssues(page)).clipped, []);
  });

  it("waits for a client-side navigation to render before the page counts as settled", async () => {
    // A single-page app: the link click pushes a URL, fetches data, and only then re-renders.
    const context = await browser.newContext();
    await Settler.install(context);
    const spa = await context.newPage();
    const settler = new Settler(spa);
    await spa.route("https://spa.test/", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: `<main><h1>Home</h1><a href="/security" id="go">Security</a></main>
          <script>
            document.getElementById("go").addEventListener("click", async (e) => {
              e.preventDefault();
              history.pushState({}, "", "/security");
              const html = await (await fetch("/api/page?security")).text();
              document.querySelector("main").innerHTML = html;
            });
          </script>`,
      }),
    );
    await spa.route("https://spa.test/api/page?security", async (r) => {
      await new Promise((d) => setTimeout(d, 600));
      await r.fulfill({ contentType: "text/html", body: "<h1>Security</h1><p>What is in place today</p>" });
    });
    await spa.goto("https://spa.test/");
    await settler.wait(spa, { quietMs: 300, timeoutMs: 6000 });
    await spa.click("#go");
    await settler.wait(spa, { quietMs: 300, timeoutMs: 6000 });
    assert.match(await ariaSnapshot(spa, 10_000), /heading "Security"/);
    await context.close();
  });

  it("reports nothing on a clean page", async () => {
    await page.setContent(`<!doctype html><body><h1>Fine</h1><p>Short text</p><a href="/x">Link</a></body>`);
    assert.deepEqual(await layoutIssues(page), { clipped: [] });
    assert.equal((await enumerateElements(page))[0]?.coveredBy, undefined);
  });
});
