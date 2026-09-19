import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { candidateActions, explainActionFailure, triggerKey } from "../src/actions.ts";
import { type Config, DEFAULTS } from "../src/config.ts";
import { FindingStore, fingerprint, normalizePath, type Finding } from "../src/findings.ts";
import { classifyJudgment, type Judgment } from "../src/judge.ts";
import type { InteractiveElement } from "../src/page-model.ts";
import { assertSafeTarget, forbiddenMatcher, isAllowedUrl, SafetyError } from "../src/safety.ts";
import { freeOracle } from "../src/signals.ts";
import { assertPublicTarget } from "../src/runner/jobs.ts";
import { tileBounds } from "../src/watch.ts";

const cfg = (over: Partial<Config>): Config => ({
  ...DEFAULTS,
  startUrl: "http://127.0.0.1:4173/",
  allowedHosts: ["127.0.0.1"],
  ...over,
});

describe("safety", () => {
  it("refuses a start host outside the allowlist", () => {
    assert.throws(() => assertSafeTarget(cfg({ startUrl: "https://staging.acme.dev/" })), SafetyError);
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

describe("candidate actions", () => {
  const elements: InteractiveElement[] = [
    { id: "e0", role: "link", name: "Products", href: "http://127.0.0.1/products" },
    { id: "e1", role: "link", name: "Delete account", href: "http://127.0.0.1/account/delete" },
    { id: "e2", role: "link", name: "Bye", href: "http://127.0.0.1/logout" },
    { id: "e3", role: "textbox", name: "Name", inputType: "text" },
    { id: "e4", role: "button", name: "Save" },
  ];
  const base = { elements, visited: [], isForbidden: forbiddenMatcher(DEFAULTS.forbiddenPatterns), maxActions: 100, random: () => 0.3 };

  it("skips forbidden controls by name and by href", () => {
    const { actions, skipped } = candidateActions({ ...base, persona: "completionist" });
    assert.equal(skipped, 2);
    assert.ok(!actions.some((a) => a.target === "e1" || a.target === "e2"));
  });

  it("gives the sloppy persona adversarial inputs and the impatient persona double clicks", () => {
    const sloppy = candidateActions({ ...base, persona: "sloppy" }).actions.filter((a) => a.kind === "fill");
    assert.ok(sloppy.length > 1);
    const impatient = candidateActions({ ...base, persona: "impatient" }).actions;
    assert.ok(impatient.some((a) => a.kind === "dblclick"));
  });

  it("caps the action count while keeping navigation actions", () => {
    const { actions } = candidateActions({ ...base, persona: "sloppy", maxActions: 4 });
    assert.equal(actions.length, 4);
    assert.ok(actions.some((a) => a.kind === "back"));
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
