// Run: node --test tests/ui-preferences.test.cjs
// UI preferences that follow Riley across devices (lib/ui-preferences.ts, /api/ui/preferences,
// sql/ui_preferences.sql): key and body rules, the write checks, the answer shape and the access model.
// SYNTHETIC DATA ONLY.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const P = loadTs("lib/ui-preferences.ts");
const ROOT = path.join(SRC, "..", "..");

const headers = (h) => ({ get: (k) => (k.toLowerCase() in h ? h[k.toLowerCase()] : null) });
const ok = { origin: "https://onyx.example", host: "onyx.example", "content-type": "application/json", "content-length": "40" };

test("keys: lower-case dotted names only", () => {
  for (const k of ["overview.cards", "sidebar.order", "a", "x1.y-2_z"]) assert.equal(P.isUiPrefKey(k), true, k);
  for (const k of ["", "Overview.cards", ".a", "a.", "a..b", "a b", "1a", "a/b", "x".repeat(65), null, 3]) assert.equal(P.isUiPrefKey(k), false, String(k));
  assert.equal(P.uiPrefUrl("overview.cards"), "/api/ui/preferences?key=overview.cards");
});

test("body: {key, value} with an object or array value under the size cap", () => {
  assert.deepEqual(P.parsePrefBody({ key: "overview.cards", value: { v: 1, order: ["a"], hidden: [] } }), { ok: true, key: "overview.cards", value: { v: 1, order: ["a"], hidden: [] } });
  assert.equal(P.parsePrefBody({ key: "overview.cards", value: ["a", "b"] }).ok, true);
  for (const bad of [null, [], "x", { key: "overview.cards" }, { key: "overview.cards", value: "text" }, { key: "overview.cards", value: 3 }, { key: "overview.cards", value: null },
    { key: "BAD", value: {} }, { key: "overview.cards", value: {}, extra: 1 }, { key: "overview.cards", value: { big: "x".repeat(5000) } }]) {
    assert.equal(P.parsePrefBody(bad).ok, false, JSON.stringify(bad)?.slice(0, 60));
  }
});

test("write checks: same origin, JSON, declared size", () => {
  assert.equal(P.checkPrefWrite(headers(ok), "https://onyx.example"), null);
  assert.equal(P.checkPrefWrite(headers({ ...ok, origin: undefined }), "https://onyx.example").status, 403);
  assert.equal(P.checkPrefWrite(headers({ ...ok, origin: "https://evil.example" }), "https://onyx.example").status, 403);
  assert.equal(P.checkPrefWrite(headers({ ...ok, "content-type": "text/plain" }), "https://onyx.example").status, 415);
  assert.equal(P.checkPrefWrite(headers({ ...ok, "content-length": "9000" }), "https://onyx.example").status, 413);
  assert.equal(P.checkPrefWrite(headers({ ...ok, "content-length": "12abc" }), "https://onyx.example").status, 413);
});

test("answers: parseUiPref accepts the route's shape and refuses anything else", () => {
  assert.deepEqual(P.parseUiPref({ key: "overview.cards", value: null, updatedAt: null }, "overview.cards"), { key: "overview.cards", value: null, updatedAt: null });
  assert.deepEqual(P.parseUiPref({ key: "overview.cards", value: { v: 1 }, updatedAt: "2031-01-01T00:00:00Z" }).value, { v: 1 });
  assert.throws(() => P.parseUiPref({ key: "sidebar.order", value: null, updatedAt: null }, "overview.cards"));
  assert.throws(() => P.parseUiPref({ key: "overview.cards", updatedAt: null }));
  assert.throws(() => P.parseUiPref({ key: "overview.cards", value: {}, updatedAt: 5 }));
  assert.throws(() => P.parseUiPref(null));
});

test("access model: never a CI route; the route checks the request before reading the body", () => {
  const mw = fs.readFileSync(path.join(SRC, "middleware.ts"), "utf8");
  const m = /function isCiRoute\(pathname: string\): boolean \{([\s\S]*?)\n\}/.exec(mw);
  assert.ok(m, "isCiRoute not found");
  const isCiRoute = new Function("pathname", m[1]);
  for (const p of ["/api/ui/preferences", "/api/ui", "/api/ui/preferences/x"]) assert.equal(isCiRoute(p), false, p);
  assert.ok(!/\/api\/ui/.test(m[1]), "isCiRoute must not mention /api/ui");
  const route = fs.readFileSync(path.join(SRC, "app/api/ui/preferences/route.ts"), "utf8");
  assert.ok(route.indexOf("checkPrefWrite(") < route.indexOf("req.text()"), "checks come before the body is read");
  assert.match(route, /MAX_UI_PREF_BODY_BYTES/);
  assert.doesNotMatch(route, /console\.(log|error)\([^)]*value/, "never logs a value");
});

test("sql: owner_read, no anon access, no statement that removes anything", () => {
  const sql = fs.readFileSync(path.join(ROOT, "sql", "ui_preferences.sql"), "utf8");
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /CREATE POLICY owner_read ON pds\.ui_preferences FOR SELECT TO authenticated/);
  assert.match(sql, /REVOKE ALL ON pds\.ui_preferences FROM anon, authenticated/);
  assert.doesNotMatch(sql, /GRANT[^;]*TO anon/i);
  assert.doesNotMatch(sql, /GRANT (INSERT|UPDATE|DELETE|ALL)[^;]*TO authenticated/i);
  assert.doesNotMatch(sql, /\bdrop\b/i, "the Supabase MCP connector declines any text containing that word");
});
