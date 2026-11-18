// Offline tests for the sign-in registry (lib/signin-registry.ts). Synthetic facts only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const reg = loadTs("lib/signin-registry.ts");
const NOW = Date.parse("2026-11-17T17:00:00Z"); // noon ET
const facts = (sourceStatus = {}, expiry = {}) => ({ sourceStatus, expiry });
const entry = (over) => ({
  id: "x", label: "X", mechanism: "oauth-refresh", renewal: "riley", howTo: "do it", lifetime: "l",
  sources: [], expiry: { kind: "none" }, ...over,
});

test("fixed date boundaries: 22 days ok, 21 due soon, today due soon, yesterday needs Riley", () => {
  const at = (d) => reg.signinState(entry({ expiry: { kind: "fixed", date: d } }), facts(), NOW);
  assert.equal(at("2026-12-09"), "ok"); // 22 days
  assert.equal(at("2026-12-08"), "due_soon"); // 21 days
  assert.equal(at("2026-11-17"), "due_soon"); // today
  assert.equal(at("2026-11-16"), "needs_riley"); // passed
});

test("derived expiry reads facts; missing derived date with no heartbeat is unknown", () => {
  const e = entry({ sources: ["spotify"], expiry: { kind: "derived", key: "spotify" } });
  assert.equal(reg.signinState(e, facts({}, { spotify: "2026-12-01" }), NOW), "due_soon");
  assert.equal(reg.signinState(e, facts({ spotify: "unknown" }, { spotify: null }), NOW), "unknown");
  assert.equal(reg.signinState(e, facts({ spotify: "success" }, { spotify: null }), NOW), "ok");
});

test("heartbeat health: riley-renewed failed = needs Riley, partial = due soon; self failed = due soon", () => {
  const r = entry({ sources: ["a"] });
  assert.equal(reg.signinState(r, facts({ a: "failed" }), NOW), "needs_riley");
  assert.equal(reg.signinState(r, facts({ a: "partial" }), NOW), "due_soon");
  assert.equal(reg.signinState(r, facts({ a: "success" }), NOW), "ok");
  const s = entry({ renewal: "self", sources: ["a"] });
  assert.equal(reg.signinState(s, facts({ a: "failed" }), NOW), "due_soon");
  assert.equal(reg.signinState(s, facts({ a: "partial" }), NOW), "ok");
});

test("worst of several sources wins; not-live is unknown; no-auth is ok", () => {
  const e = entry({ sources: ["a", "b"] });
  assert.equal(reg.signinState(e, facts({ a: "success", b: "failed" }), NOW), "needs_riley");
  assert.equal(reg.signinState(entry({ live: false, sources: ["a"] }), facts({ a: "failed" }), NOW), "unknown");
  assert.equal(reg.signinState(entry({ mechanism: "no-auth" }), facts(), NOW), "ok");
});

test("monthly list: within 45 days or needing Riley, sorted, self and not-live left out", () => {
  const entries = [
    entry({ id: "far", label: "Far", expiry: { kind: "fixed", date: "2027-03-01" } }),
    entry({ id: "d40", label: "D40", expiry: { kind: "fixed", date: "2026-12-27" } }),
    entry({ id: "d46", label: "D46", expiry: { kind: "fixed", date: "2027-01-02" } }),
    entry({ id: "d10", label: "D10", expiry: { kind: "fixed", date: "2026-11-27" } }),
    entry({ id: "bad", label: "Bad", sources: ["s"] }),
    entry({ id: "self", label: "Self", renewal: "self", sources: ["s"] }),
    entry({ id: "off", label: "Off", live: false, sources: ["s"] }),
  ];
  const list = reg.monthlyRenewals(entries, facts({ s: "failed" }), NOW);
  assert.equal(list.windowDays, 45);
  assert.deepEqual(list.items.map((i) => i.id), ["bad", "d10", "d40"]);
});

test("statuses carry only id, label, state and renewBy", () => {
  const out = reg.signinStatuses(reg.SIGNIN_REGISTRY, facts({}, { spotify: "2027-05-01" }), NOW);
  assert.equal(out.length, reg.SIGNIN_REGISTRY.length);
  for (const s of out) assert.deepEqual(Object.keys(s).sort(), ["id", "label", "renewBy", "state"]);
  assert.equal(out.find((s) => s.id === "apple-signing").renewBy, "2027-11-10");
});

test("registry ids are unique and every referenced source key is a known /api/status source", () => {
  const ids = reg.SIGNIN_REGISTRY.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
  const route = fs.readFileSync(path.join(SRC, "app/api/status/route.ts"), "utf8");
  const cadence = route.slice(route.indexOf("const CADENCE"), route.indexOf("const METHOD"));
  const known = new Set([...cadence.matchAll(/^ {2}([a-z_0-9]+):/gm)].map((m) => m[1]));
  for (const e of reg.SIGNIN_REGISTRY) {
    for (const k of e.sources) assert.ok(known.has(k), `${e.id}: unknown status source ${k}`);
    if (e.expiry.kind === "derived") assert.ok(route.includes(`${e.expiry.key}:`), `${e.id}: derived key not supplied by the route`);
  }
});

test("registry file is import-free and holds no secret-looking values", () => {
  const src = fs.readFileSync(path.join(SRC, "lib/signin-registry.ts"), "utf8");
  assert.ok(!/^import /m.test(src));
  assert.ok(!/(sk-|xox|eyJ)/.test(src));
});
