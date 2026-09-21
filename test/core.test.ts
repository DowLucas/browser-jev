import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { candidateActions, explainActionFailure, tamperedUrls, triggerKey } from "../src/actions.ts";
import { type Config, DEFAULTS, MAX_PARALLEL_SESSIONS, resolveConfig } from "../src/config.ts";
import { BUILT_IN_PERSONAS, resolvePersonas, validatePersona } from "../src/personas.ts";
import { describeFocus, focusPathMatches, inFocus, NO_FOCUS, validateFocus } from "../src/focus.ts";
import { formatStep, parseSetup } from "../src/setup.ts";
import { focusPrompt, parseFocusSuggestion } from "../src/focus-prompt.ts";
import { FindingStore, fingerprint, normalizePath, normalizeRequestPath, type Finding } from "../src/findings.ts";
import { classifyJudgment, type Judgment } from "../src/judge.ts";
import type { InteractiveElement } from "../src/page-model.ts";
import { assertSafeTarget, forbiddenMatcher, isAllowedUrl, SafetyError, writeAllowed } from "../src/safety.ts";
import { freeOracle } from "../src/signals.ts";
import { assertPublicTarget } from "../src/runner/jobs.ts";
import { tileBounds } from "../src/watch.ts";

const cfg = (over: Partial<Config>): Config => ({
  ...DEFAULTS,
  startUrl: "http://127.0.0.1:4173/",
  allowedHosts: ["127.0.0.1"],
  ...over,
});

const persona = (name: string) => BUILT_IN_PERSONAS.find((p) => p.name === name)!;

describe("safety", () => {
  it("refuses a start host outside the allowlist", () => {
    assert.throws(() => assertSafeTarget(cfg({ startUrl: "https://staging.acme.dev/" })), SafetyError);
  });

  it("always allows the start URL's host, keeping extra hosts", () => {
    assert.deepEqual(resolveConfig({ startUrl: "https://staging.acme.dev/x" }).allowedHosts, ["staging.acme.dev"]);
    assert.deepEqual(
      resolveConfig({ startUrl: "https://staging.acme.dev/", allowedHosts: ["api.acme.dev", "staging.acme.dev"] }).allowedHosts,
      ["staging.acme.dev", "api.acme.dev"],
    );
  });

  it("still refuses a production-looking start host once it is auto-allowed", () => {
    assert.throws(() => assertSafeTarget(resolveConfig({ startUrl: "https://www.acme.com/" })), /looks like production/);
  });

  it("refuses production-looking hosts even when allowlisted", () => {
    for (const host of ["www.acme.com", "app.prod.acme.com", "prod-api.acme.com", "acme-production.io"]) {
      assert.throws(
        () => assertSafeTarget(cfg({ startUrl: `https://${host}/`, allowedHosts: [host] })),
        SafetyError,
        host,
      );
    }
  });

  it("accepts an allowlisted staging host", () => {
    assert.doesNotThrow(() =>
      assertSafeTarget(cfg({ startUrl: "https://staging.acme.dev/", allowedHosts: ["staging.acme.dev"] })),
    );
  });

  it("only lets allowlisted hosts through the fence", () => {
    assert.equal(isAllowedUrl("http://127.0.0.1:4173/x", ["127.0.0.1"]), true);
    assert.equal(isAllowedUrl("https://cdn.example.com/a.css", ["127.0.0.1"]), false);
    assert.equal(isAllowedUrl("data:text/plain,hi", ["127.0.0.1"]), true);
  });

  it("matches forbidden controls widely but not innocuous ones", () => {
    const forbidden = forbiddenMatcher(DEFAULTS.forbiddenPatterns);
    for (const name of ["Delete account", "Sign out", "Logout", "Proceed to checkout", "Pay now", "Invite team", "Subscribe"]) {
      assert.equal(forbidden(name), true, name);
    }
    for (const name of ["Display name", "Save", "Search", "Payload viewer"]) {
      assert.equal(forbidden(name), false, name);
    }
  });
});

describe("modes", () => {
  const start = { startUrl: "https://staging.acme.dev/" };

  it("defaults to observe everywhere", () => {
    assert.equal(resolveConfig(start).mode, "observe");
  });

  it("refuses interact without confirming the environment is disposable", () => {
    assert.throws(() => resolveConfig({ ...start, mode: "interact" }), /Confirm the environment is disposable/);
    assert.equal(resolveConfig({ ...start, mode: "interact", confirmDisposable: true }).mode, "interact");
  });

  it("requires valid write paths for observe-writes", () => {
    assert.throws(() => resolveConfig({ ...start, mode: "observe-writes" }), /at least one allowed write path/);
    assert.throws(() => resolveConfig({ ...start, mode: "observe-writes", allowedWritePaths: ["entity"] }), /must start with/);
    assert.throws(() => resolveConfig({ ...start, mode: "bogus" as never }), /mode must be one of/);
  });

  it("matches write paths exactly, or as a prefix only with /*", () => {
    const policy = { mode: "observe-writes" as const, allowedWritePaths: ["/entity", "/api/*"] };
    assert.equal(writeAllowed("https://a.test/entity?page=1", policy), true);
    assert.equal(writeAllowed("https://a.test/entity/create", policy), false);
    assert.equal(writeAllowed("https://a.test/api/graphql", policy), true);
    assert.equal(writeAllowed("https://a.test/apix", policy), false);
    assert.equal(writeAllowed("https://a.test/anything", { mode: "observe", allowedWritePaths: [] }), false);
    assert.equal(writeAllowed("https://a.test/anything", { mode: "interact", allowedWritePaths: [] }), true);
  });
});

describe("candidate actions", () => {
  const elements: InteractiveElement[] = [
    { id: "e0", role: "link", name: "Products", href: "http://127.0.0.1/products" },
    { id: "e1", role: "link", name: "Delete account", href: "http://127.0.0.1/account/delete" },
    { id: "e2", role: "link", name: "Bye", href: "http://127.0.0.1/logout" },
    { id: "e3", role: "textbox", name: "Name", inputType: "text" },
    { id: "e4", role: "button", name: "Save", submit: true },
    { id: "e5", role: "button", name: "Show details" },
    { id: "e6", role: "link", name: "Home", href: "http://127.0.0.1/start" },
    { id: "e7", role: "link", name: "Pricing section", href: "http://127.0.0.1/start#pricing" },
    { id: "e8", role: "link", name: "Privacy", href: "http://127.0.0.1/privacy", coveredBy: "We use cookies" },
    { id: "e9", role: "link", name: "Get it on Google Play", href: "https://play.google.com/store/apps/x" },
    { id: "e10", role: "link", name: "Email us", href: "mailto:hi@example.test" },
  ];
  const base = {
    elements,
    currentUrl: "http://127.0.0.1/start",
    isInApp: (u: string) => u.startsWith("http://127.0.0.1/"),
    canGoForward: false,
    visited: [],
    isForbidden: forbiddenMatcher(DEFAULTS.forbiddenPatterns),
    maxActions: 100,
    random: () => 0.3,
  };

  it("skips forbidden controls by name and by href", () => {
    const { actions, skipped } = candidateActions({ ...base, persona: persona("completionist") });
    assert.equal(skipped, 2);
    assert.ok(!actions.some((a) => a.target === "e1" || a.target === "e2"));
  });

  it("gives the sloppy persona adversarial inputs and the impatient persona double clicks on submits only", () => {
    const sloppy = candidateActions({ ...base, persona: persona("sloppy") }).actions.filter((a) => a.kind === "fill");
    assert.ok(sloppy.length > 1);
    const impatient = candidateActions({ ...base, persona: persona("impatient") }).actions;
    assert.ok(impatient.some((a) => a.kind === "dblclick" && a.name === "Save"));
    assert.ok(!impatient.some((a) => a.kind !== "click" && a.name === "Show details"));
  });

  it("leaves out links to the current page and covered controls, and marks in-page anchors", () => {
    const { actions } = candidateActions({ ...base, persona: persona("completionist") });
    const names = actions.map((a) => a.name);
    assert.ok(!names.includes("Home"), "self-link");
    assert.ok(!names.includes("Privacy"), "covered");
    assert.ok(!names.includes("Get it on Google Play") && !names.includes("Email us"), "leaves the app");
    assert.equal(actions.find((a) => a.name === "Pricing section")?.inPage, true);
  });

  it("offers browser forward only when there is somewhere to go forward to", () => {
    const kinds = (canGoForward: boolean) => candidateActions({ ...base, persona: persona("out-of-order"), canGoForward }).actions.map((a) => a.kind);
    assert.ok(!kinds(false).includes("forward"));
    assert.ok(kinds(true).includes("forward"));
  });

  it("gives the boundary persona edge values and plain personas only a plausible value", () => {
    const fills = (name: string) => candidateActions({ ...base, persona: persona(name) }).actions.filter((a) => a.kind === "fill");
    assert.deepEqual(fills("completionist").map((a) => a.valueLabel), ["plausible"]);
    const edges = fills("boundary").map((a) => a.valueLabel);
    assert.ok(edges.length > 1 && edges.includes("plausible"));
    const numberField = candidateActions({ ...base, elements: [{ id: "n", role: "textbox", name: "Qty", inputType: "number" }], persona: persona("boundary") });
    for (const a of numberField.actions.filter((x) => x.kind === "fill")) assert.match(a.value!, /^-?[\d.]+$/, "number fields only get numbers");
  });

  it("gives the keyboard persona Enter on fields, buttons and links and a targetless Escape", () => {
    const { actions } = candidateActions({ ...base, persona: persona("keyboard") });
    const presses = actions.filter((a) => a.kind === "press");
    assert.ok(presses.some((a) => a.key === "Enter" && a.name === "Name"));
    assert.ok(presses.some((a) => a.key === "Enter" && a.name === "Save"));
    assert.ok(presses.some((a) => a.key === "Enter" && a.name === "Products"));
    assert.ok(presses.some((a) => a.key === "Escape" && !a.target));
    assert.ok(!candidateActions({ ...base, persona: persona("sloppy") }).actions.some((a) => a.kind === "press"));
  });

  it("gives the url-tamperer edited URLs of the current page, inside the app only", () => {
    const { actions } = candidateActions({ ...base, currentUrl: "http://127.0.0.1/orders/7?page=2", persona: persona("url-tamperer") });
    const edits = actions.filter((a) => a.tamper);
    assert.ok(edits.length > 0 && edits.length <= 4);
    for (const a of edits) assert.ok(a.url!.startsWith("http://127.0.0.1/") && a.url !== "http://127.0.0.1/orders/7?page=2");
  });

  it("caps the action count while keeping navigation actions", () => {
    const { actions } = candidateActions({ ...base, persona: persona("sloppy"), maxActions: 4 });
    assert.equal(actions.length, 4);
    assert.ok(actions.some((a) => a.kind === "back"));
  });
});

describe("url tampering", () => {
  it("moves ids to neighbours, zero and huge values, edits query values and offers the parent path", () => {
    const urls = tamperedUrls("http://h/orders/7/items?page=2&sort=name#top").map((t) => t.url);
    for (const u of ["http://h/orders/8/items?page=2&sort=name", "http://h/orders/6/items?page=2&sort=name", "http://h/orders/0/items?page=2&sort=name", "http://h/orders/999999999/items?page=2&sort=name", "http://h/orders/7?page=2&sort=name", "http://h/orders/7/items?page=-1&sort=name", "http://h/orders/7/items?page=2&sort="]) {
      assert.ok(urls.includes(u), u);
    }
    assert.ok(!urls.some((u) => u.includes("#")), "the fragment is dropped");
  });

  it("zeroes UUIDs, keeps precision on long ids, and has nothing to edit on a bare root", () => {
    const uuid = tamperedUrls("http://h/u/3f2b8c1e-1d2a-4b3c-9d8e-7f6a5b4c3d2e").map((t) => t.url);
    assert.ok(uuid.includes("http://h/u/00000000-0000-0000-0000-000000000000"));
    assert.ok(tamperedUrls("http://h/p/9007199254740993").some((t) => t.url === "http://h/p/9007199254740994"));
    assert.deepEqual(tamperedUrls("http://h/"), []);
  });

  it("counts an edited URL and Enter on a link as arriving, like any other navigation", () => {
    assert.equal(triggerKey({ kind: "goto", url: "http://h/orders/8", tamper: "id 7 -> 8" }), "navigate");
    assert.equal(triggerKey({ kind: "press", key: "Enter", role: "link", name: "Orders", target: "e1" }), "navigate");
    assert.notEqual(triggerKey({ kind: "press", key: "Enter", role: "button", name: "Save", target: "e2" }), "navigate");
  });
});

describe("focus", () => {
  it("matches a path exactly, or it and everything below with /*, never a lookalike prefix", () => {
    assert.ok(focusPathMatches("/checkout", "/checkout/*"));
    assert.ok(focusPathMatches("/checkout/shipping/2", "/checkout/*"));
    assert.ok(!focusPathMatches("/checkout-old", "/checkout/*"));
    assert.ok(focusPathMatches("/cart", "/cart") && !focusPathMatches("/cart/1", "/cart"));
  });

  it("keeps a URL in focus when an include matches and no exclude does; no includes means the whole app", () => {
    const focus = { includePaths: ["/cart", "/checkout/*"], excludePaths: ["/checkout/pay"] };
    assert.ok(inFocus("http://h/checkout/shipping?x=1", focus));
    assert.ok(!inFocus("http://h/checkout/pay", focus), "excluded inside an included area");
    assert.ok(!inFocus("http://h/products", focus));
    assert.ok(inFocus("http://h/anything", NO_FOCUS));
    assert.ok(!inFocus("http://h/admin/users", { includePaths: [], excludePaths: ["/admin/*"] }));
  });

  it("validates a focus and requires the start URL, the entry point, to be inside it", () => {
    assert.deepEqual(validateFocus(undefined, "http://h/"), NO_FOCUS);
    assert.deepEqual(validateFocus({ instructions: "  the cart  ", includePaths: ["/cart"] }, "http://h/cart"), {
      instructions: "the cart",
      includePaths: ["/cart"],
      excludePaths: [],
    });
    assert.throws(() => validateFocus({ includePaths: ["/checkout/*"] }, "http://h/"), /start URL \/ is outside the focus paths/);
    assert.throws(() => validateFocus({ excludePaths: ["/"] }, "http://h/"), /outside the focus paths/);
    assert.throws(() => validateFocus({ includePaths: ["checkout"] }, "http://h/checkout"), /must start with "\/"/);
    assert.throws(() => validateFocus({ paths: ["/x"] }, "http://h/"), /Unknown focus field/);
    assert.equal(describeFocus(NO_FOCUS), "none (whole app)");
    assert.match(describeFocus({ instructions: "cart", includePaths: ["/cart"], excludePaths: [] }), /"cart"; within \/cart/);
  });

  it("offers no links, revisits or edited URLs outside the focus area", () => {
    const elements: InteractiveElement[] = [
      { id: "e0", role: "link", name: "Shipping", href: "http://127.0.0.1/checkout/shipping" },
      { id: "e1", role: "link", name: "Blog", href: "http://127.0.0.1/blog" },
      { id: "e2", role: "button", name: "Next" },
    ];
    const focus = { includePaths: ["/checkout/*"], excludePaths: [] };
    const { actions } = candidateActions({
      elements,
      currentUrl: "http://127.0.0.1/checkout/7",
      isInApp: () => true,
      inFocus: (u) => inFocus(u, focus),
      canGoForward: false,
      visited: ["http://127.0.0.1/blog", "http://127.0.0.1/checkout/7"],
      isForbidden: () => false,
      maxActions: 100,
      random: () => 0.3,
      persona: { name: "x", strategy: "x", traits: ["history", "url-tamper"] },
    });
    assert.ok(actions.some((a) => a.name === "Shipping") && actions.some((a) => a.name === "Next"));
    for (const a of actions) {
      const url = a.href ?? a.url;
      if (url) assert.ok(inFocus(url, focus), `${a.kind} ${url} is outside the focus`);
    }
    assert.ok(actions.some((a) => a.tamper), "edits inside the area are still offered");
  });

  it("resolves focus in a config layer", () => {
    const c = resolveConfig({ startUrl: "http://127.0.0.1/cart", focus: { includePaths: ["/cart"] } });
    assert.deepEqual(c.focus, { includePaths: ["/cart"], excludePaths: [] });
    assert.deepEqual(resolveConfig({ startUrl: "http://127.0.0.1/" }).focus, NO_FOCUS);
  });
});

describe("setup steps", () => {
  const script = `
    # sign in, then fill the cart
    goto /products/3
    click button "Add to cart"
    click "Widget 3" nth 2
    fill textbox "Coupon" with "SAVE \\"10\\""
    fill "Email" with "a@b.test"
    select combobox "Size" option "M"
    press Enter
    press Shift+Tab
    wait for "Added to cart"
    back
  `;

  it("parses every kind of step, skipping comments and blank lines", () => {
    const steps = parseSetup(script);
    assert.equal(steps.length, 10);
    assert.deepEqual(steps[0], { kind: "goto", url: "/products/3" });
    assert.deepEqual(steps[2], { kind: "click", target: { name: "Widget 3", nth: 2 } });
    assert.deepEqual(steps[3], { kind: "fill", target: { role: "textbox", name: "Coupon" }, value: 'SAVE "10"' });
    assert.deepEqual(steps[4], { kind: "fill", target: { name: "Email" }, value: "a@b.test" });
    assert.deepEqual(steps[8], { kind: "wait-for", text: "Added to cart" });
  });

  it("formats steps back into lines that parse to the same steps", () => {
    const steps = parseSetup(script);
    assert.deepEqual(parseSetup(steps.map(formatStep)), steps);
  });

  it("names the line and the problem when a step does not parse", () => {
    const bad: [string, RegExp][] = [
      ['clik button "Save"', /unknown step "clik"/],
      ['click buton "Save"', /unknown role "buton"/],
      ['click button "Save', /unclosed quote/],
      ['click button Save', /unknown role "Save"|expected the button's name/],
      ['fill textbox "Email" "x"', /expected "with"/],
      ["press F13", /press needs a key/],
      ["goto products", /http\(s\) URL or a path/],
      ['click button "Save" nth 0', /nth needs a whole number/],
      ['click button "Save" now', /unexpected "now"/],
      ['click button ""', /name is empty/],
    ];
    for (const [line, error] of bad) assert.throws(() => parseSetup(`goto /\n\n${line}`), (err: Error) => {
      assert.match(err.message, error, line);
      assert.match(err.message, /^Setup line 3 /, line);
      return true;
    });
    assert.throws(() => parseSetup(Array.from({ length: 51 }, () => "back")), /at most 50/);
  });

  it("holds setup to the same allowlist and forbidden controls as exploration", () => {
    const base = { startUrl: "http://127.0.0.1/cart" };
    assert.equal(resolveConfig({ ...base, setup: 'goto /products/1\nclick button "Add to cart"' }).setup.length, 2);
    assert.throws(() => resolveConfig({ ...base, setup: "goto https://evil.test/" }), /leaves the allowed hosts/);
    assert.throws(() => resolveConfig({ ...base, setup: 'click button "Proceed to checkout"' }), /forbidden-control pattern/);
    assert.throws(() => resolveConfig({ ...base, setup: "goto /account/delete" }), /forbidden-control pattern/);
  });
});

describe("Claude Code focus prompt", () => {
  const start = "https://staging.example.dev/cart";
  const answer = (obj: object, prose = "Here is the focus:\n\n") => `${prose}\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\`\n`;
  const good = {
    startUrl: "/cart",
    instructions: "Cart totals after quantity changes and discount codes.",
    includePaths: ["/cart", "/checkout/*"],
    excludePaths: ["/checkout/pay"],
    setup: ["goto /products/3", 'click button "Add to cart"', 'wait for "Added to cart"'],
    allowedWritePaths: ["/api/cart/*"],
    notes: "Needs no login.",
  };

  it("carries the goal, the start URL, the step grammar and the forbidden patterns", () => {
    const prompt = focusPrompt({ startUrl: start, goal: "discount codes", forbiddenPatterns: DEFAULTS.forbiddenPatterns });
    for (const part of ["discount codes", start, 'click <role> "<accessible name>"', "checkout", "staging.example.dev", "```json"]) {
      assert.ok(prompt.includes(part), part);
    }
    assert.match(focusPrompt({ startUrl: start, goal: " ", forbiddenPatterns: [] }), /ask me what flow/);
  });

  it("takes the JSON out of a whole reply and normalizes it", () => {
    const s = parseFocusSuggestion(answer(good), start, DEFAULTS.forbiddenPatterns);
    assert.equal(s.startUrl, start);
    assert.deepEqual(s.includePaths, ["/cart", "/checkout/*"]);
    assert.equal(s.setup, 'goto /products/3\nclick button "Add to cart"\nwait for "Added to cart"');
    assert.deepEqual(s.allowedWritePaths, ["/api/cart/*"]);
    assert.equal(s.notes, "Needs no login.");
    // Bare JSON, setup as one string, no startUrl: the current start URL stays.
    const bare = parseFocusSuggestion(JSON.stringify({ ...good, startUrl: undefined, setup: "goto /products/3" }), start, []);
    assert.equal(bare.startUrl, undefined);
    assert.equal(bare.setup, "goto /products/3");
  });

  it("rejects an answer a run would reject, with the reason", () => {
    const bad: [object, RegExp][] = [
      [{ ...good, startUrl: "https://other.test/cart" }, /another site/],
      [{ ...good, includePaths: ["/checkout/*"] }, /start URL \/cart is outside the focus paths/],
      [{ ...good, setup: ['click button "Proceed to checkout"'] }, /forbidden-control pattern/],
      [{ ...good, setup: ["clik"] }, /Setup line 1/],
      [{ ...good, includePaths: "/cart" }, /"includePaths" must be a list/],
      [{ ...good, allowedWritePaths: ["api/cart"] }, /must start with "\/"/],
    ];
    for (const [obj, error] of bad) assert.throws(() => parseFocusSuggestion(answer(obj), start, DEFAULTS.forbiddenPatterns), error);
    assert.throws(() => parseFocusSuggestion("I could not find the flow.", start, []), /No JSON object found/);
    assert.throws(() => parseFocusSuggestion(answer({ ...good, maxWaitSeconds: 900 }), start, []), /maxWaitSeconds/);
    assert.equal(parseFocusSuggestion(answer({ ...good, maxWaitSeconds: 90 }), start, []).maxWaitSeconds, 90);
  });
});

describe("personas", () => {
  it("resolves built-in names and inline definitions, and rejects unknown names, duplicates and bad fields", () => {
    const custom = { name: "checkout-hunter", strategy: "Go to checkout.", traits: ["history" as const] };
    assert.deepEqual(resolvePersonas(["sloppy", custom]).map((p) => p.name), ["sloppy", "checkout-hunter"]);
    assert.throws(() => resolvePersonas(["slopy"]), /Unknown persona "slopy"/);
    assert.throws(() => resolvePersonas(["sloppy", "sloppy"]), /listed twice/);
    assert.throws(() => validatePersona({ ...custom, traits: ["telepathy"] }), /traits must be/);
    assert.throws(() => validatePersona({ ...custom, name: "Has Spaces" }), /lowercase/);
    assert.throws(() => validatePersona({ ...custom, strategy: "  " }), /instructions/);
    assert.throws(() => validatePersona({ ...custom, color: "red" }), /Unknown persona field/);
  });

  it("gives every built-in a distinct name and a trait set the code knows", () => {
    const names = BUILT_IN_PERSONAS.map((p) => p.name);
    assert.equal(new Set(names).size, names.length);
    for (const p of BUILT_IN_PERSONAS) assert.deepEqual(validatePersona(p), p);
  });

  it("resolves names in a config layer and caps sessions open at once", () => {
    const c = resolveConfig({ startUrl: "http://127.0.0.1/", personas: ["keyboard"] });
    assert.deepEqual(c.personas.map((p) => p.traits), [["keyboard"]]);
    assert.equal(resolveConfig({ startUrl: "http://127.0.0.1/", workers: MAX_PARALLEL_SESSIONS }).workers, MAX_PARALLEL_SESSIONS);
    assert.throws(() => resolveConfig({ startUrl: "http://127.0.0.1/", workers: MAX_PARALLEL_SESSIONS + 1 }), /at most 10/);
    assert.throws(() => resolveConfig({ startUrl: "http://127.0.0.1/", personas: [] }), /At least one persona/);
    assert.throws(() => resolveConfig({ startUrl: "http://127.0.0.1/", maxWaitMs: 500 }), /max wait must be 1-300 seconds/);
  });
});

describe("action failures", () => {
  it("names the overlay that intercepted a click (real error shape from a cookie banner)", () => {
    const err = new Error(
      [
        "locator.click: Timeout 5000ms exceeded.",
        "Call log:",
        '  - waiting for locator(\'[data-jev-id="e79"]\')',
        "  - attempting click action",
        '    - <button data-jev-id="e82" id="rcc-confirm-button" aria-label="Accept cookies" class="bg-primary">Accept</button> from <div class="CookieConsent">…</div> subtree intercepts pointer events',
        "  - retrying click action",
      ].join("\n"),
    );
    const failure = explainActionFailure(err);
    assert.equal(failure.interceptedBy, "Accept cookies");
    assert.match(failure.summary, /blocked by an overlapping element "Accept cookies"/);
  });

  it("names a container overlay by id when its text is abbreviated", () => {
    const err = new Error(
      '  - <div id="promo" style="position:fixed">…</div> intercepts pointer events',
    );
    assert.equal(explainActionFailure(err).interceptedBy, "promo");
  });

  it("falls back to the first line for other errors", () => {
    const failure = explainActionFailure(new Error("locator.click: Timeout 5000ms exceeded.\nCall log: ..."));
    assert.equal(failure.interceptedBy, undefined);
    assert.equal(failure.summary, "locator.click: Timeout 5000ms exceeded.");
  });
});

describe("trigger keys", () => {
  it("collapses every way of arriving at a page, but keeps interactions distinct", () => {
    assert.equal(triggerKey({ kind: "back" }), "navigate");
    assert.equal(triggerKey({ kind: "click", role: "link", name: "Settings" }), "navigate");
    assert.equal(triggerKey(undefined), "navigate");
    assert.equal(
      triggerKey({ kind: "click", role: "button", name: "Order 12" }),
      triggerKey({ kind: "click", role: "button", name: "Order 7" }),
    );
    assert.notEqual(triggerKey({ kind: "dblclick", role: "button", name: "Save" }), "navigate");
  });
});

describe("findings", () => {
  it("collapses ids and uuids in paths", () => {
    assert.equal(normalizePath("http://h/orders/42/items/9"), "/orders/:id/items/:id");
    assert.equal(normalizePath("http://h/u/3f2b1c4d-1111-2222-3333-444455556666"), "/u/:uuid");
  });

  it("fingerprints on shape, not ids", () => {
    const a = fingerprint({ category: "broken", url: "http://h/orders/1", triggerKey: "navigate" });
    const b = fingerprint({ category: "broken", url: "http://h/orders/77", triggerKey: "navigate" });
    const c = fingerprint({ category: "confusing", url: "http://h/orders/1", triggerKey: "navigate" });
    assert.equal(a, b);
    assert.notEqual(a, c);
  });

  it("deduplicates and escalates a group to fail if any occurrence fails", () => {
    const store = new FindingStore();
    const f = (sessionId: string, level: "fail" | "warn"): Finding => ({
      fingerprint: "abc",
      category: "broken",
      source: "judgment",
      level,
      message: "",
      url: "http://h/",
      trigger: "start",
      triggerKey: "navigate",
      sessionId,
      persona: "sloppy",
      step: 0,
      actionLog: [],
    });
    store.add(f("s1", "warn"));
    store.add(f("s2", "fail"));
    store.add(f("s2", "warn"));
    const [group] = store.groups();
    assert.equal(group?.count, 3);
    assert.deepEqual(group?.sessions, ["s1", "s2"]);
    assert.equal(group?.level, "fail");
  });
});

describe("thresholds", () => {
  const judgment = (p: number, severity: number): Judgment => ({
    oracle: { broken: p, count_mismatch: 0.1, untranslated: 0.1, confusing: 0.1, leaks_internals: 0.1, dead_end: 0.1 },
    severity,
    actionIndex: 0,
    actionConfidence: 1,
    inputTokens: 0,
  });

  it("drops uncertain judgments the model rates as nothing wrong, but keeps confident minor ones", () => {
    // Real-site false positive: leaks-internals at p=0.60, severity 0.49 ("nothing is wrong").
    assert.equal(classifyJudgment(judgment(0.6, 0.49), DEFAULTS.thresholds).length, 0);
    // Planted dead end: p=0.83 but rated minor (0.72). Dropping it was a recall regression.
    assert.equal(classifyJudgment(judgment(0.83, 0.72), DEFAULTS.thresholds)[0]?.level, "warn");
  });

  it("fails only on high confidence and high severity; warns in the band", () => {
    const t = DEFAULTS.thresholds;
    assert.equal(classifyJudgment(judgment(0.95, 3.5), t)[0]?.level, "fail");
    assert.equal(classifyJudgment(judgment(0.95, 1.5), t)[0]?.level, "warn");
    assert.equal(classifyJudgment(judgment(0.7, 3.5), t)[0]?.level, "warn");
    assert.equal(classifyJudgment(judgment(0.3, 4), t).length, 0);
  });
});

describe("runner target policy", () => {
  const policy = { allowPrivate: false, blockedSuffixes: [".internal.example", ".ts.net"] };

  it("refuses internal targets the runner's neighbours live on", () => {
    for (const host of ["localhost", "127.0.0.1", "10.0.0.2", "192.168.1.10", "172.18.0.5", "100.100.1.2", "vaultwarden", "::1", "[fd7a::53]", "jev.internal.example", "internal.example", "box.tailnet-1234.ts.net"]) {
      assert.throws(() => assertPublicTarget(host, policy), /Refusing/, host);
    }
  });

  it("allows public hosts, and private ones only when explicitly enabled", () => {
    for (const host of ["staging.acme.dev", "8.8.8.8", "notinternal.example"]) {
      assert.doesNotThrow(() => assertPublicTarget(host, policy), host);
    }
    assert.doesNotThrow(() => assertPublicTarget("127.0.0.1", { ...policy, allowPrivate: true }));
  });
});

describe("window tiling", () => {
  it("tiles five windows 3x2 over an ultrawide screen without overlap", () => {
    const screen = { width: 3440, height: 1440 };
    const tiles = [0, 1, 2, 3, 4].map((i) => tileBounds(i, 5, screen));
    assert.deepEqual(tiles[0], { left: 0, top: 0, width: 1146, height: 720 });
    assert.deepEqual(tiles[4], { left: 1146, top: 720, width: 1146, height: 720 });
    for (const t of tiles) assert.ok(t.left + t.width <= screen.width && t.top + t.height <= screen.height);
  });
});

describe("root-cause grouping", () => {
  const signals = (httpErrors: { method: string; url: string; status: number }[]) => ({
    consoleErrors: [],
    pageErrors: [],
    httpErrors,
    dialogs: [],
    crashed: false,
  });

  it("turns any number of gateway errors into one service-unavailable finding", () => {
    const results = freeOracle(
      signals([
        { method: "GET", url: "https://app.test/home", status: 503 },
        { method: "GET", url: "https://app.test/_next/static/chunks/c1cf3-8a2e91.js", status: 503 },
        { method: "GET", url: "https://app.test/api/branding/logo", status: 502 },
      ]),
      false,
    );
    assert.equal(results.length, 1);
    assert.equal(results[0]?.category, "service-unavailable");
    assert.match(results[0]!.message, /3 request\(s\) returned 503\/502/);
    assert.equal(results[0]?.pageIndependent && results[0]?.triggerIndependent, true);
  });

  it("keeps a plain 500 per endpoint, with hashed asset names collapsed", () => {
    const [chunk] = freeOracle(signals([{ method: "GET", url: "https://app.test/_next/static/chunks/c1cf3-8a2e91.js?dpl=9", status: 500 }]), false);
    assert.equal(chunk?.category, "http-5xx");
    assert.equal(chunk?.shape, "GET /_next/static/chunks/*.js");
  });

  it("collapses build-hashed asset paths but leaves pages alone", () => {
    assert.equal(normalizeRequestPath("https://a.test/_next/static/css/4fd2d3b9a1.css"), "/_next/static/css/*.css");
    assert.equal(normalizeRequestPath("https://a.test/orders/42"), "/orders/:id");
  });
});

describe("free oracle", () => {
  it("classifies http errors and detects executed injections", () => {
    const results = freeOracle(
      {
        consoleErrors: [],
        pageErrors: [],
        httpErrors: [
          { method: "GET", url: "http://h/api/x", status: 404 },
          { method: "POST", url: "http://h/orders", status: 500 },
        ],
        dialogs: ["jev-xss", "Are you sure?"],
        crashed: false,
      },
      false,
    );
    assert.deepEqual(
      results.map((r) => r.category),
      ["http-4xx", "http-5xx", "xss-dialog"],
    );
  });
});
