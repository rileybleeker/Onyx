// Run: node --test tests/screen-time-v1-retired.test.cjs
// The v1 Shortcuts open/close path (pds.phone_app_events) was retired 2026-11-13: it never received
// a row. These checks keep its route and its /status card from coming back, and keep the v2 card.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SRC } = require("./helpers/load-ts.cjs");

const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

test("the v1 event route is gone; the app's routes remain", () => {
  assert.equal(fs.existsSync(path.join(SRC, "app/api/screen-time/event")), false);
  for (const r of ["usage/route.ts", "token/route.ts", "manifest/[slug]/route.ts"]) {
    assert.ok(fs.existsSync(path.join(SRC, "app/api/screen-time", r)), r);
  }
});

test("/api/status no longer reads the v1 table and has no v1 card", () => {
  const route = read("app/api/status/route.ts");
  assert.ok(!route.includes("phone_app_events"));
  assert.ok(!/^\s*screen_time:/m.test(route), "a screen_time card / CADENCE / METHOD entry is back");
  assert.ok(!route.includes("screenTimeRes"));
});

test("the v2 Screen Time app card is still wired end to end", () => {
  const route = read("app/api/status/route.ts");
  assert.match(route, /^\s*screen_usage: \(\(\) => \{/m);
  assert.match(route, /label: "Screen Time app"/);
  assert.match(route, /\.eq\("source", "screen_time"\)\.eq\("data_type", "usage"\)/);
  assert.equal((route.match(/^\s*screen_usage:/gm) || []).length, 3); // CADENCE, METHOD, the card

  const page = read("app/status/page.tsx");
  assert.equal((page.match(/^\s*screen_usage:/gm) || []).length, 2); // badge + badge colour
  assert.match(page, /^\s*"screen_usage",$/m); // SOURCE_ORDER
  assert.ok(!/^\s*"screen_time",$/m.test(page));
  // The sync history still labels the app's heartbeat source (sync_log.source = 'screen_time').
  assert.match(page, /screen_time: "Screen Time app"/);
});

test("the token carve-out no longer lists the v1 path; the app's upload path is still exact", () => {
  const mw = read("middleware.ts");
  const fn = mw.slice(mw.indexOf("function isCiRoute"), mw.indexOf("// Routes reachable with NO session"));
  assert.ok(!fn.includes("/api/screen-time/event"));
  assert.match(fn, /pathname === "\/api\/screen-time\/usage"/);
  assert.ok(!/startsWith\("\/api\/screen-time/.test(fn), "the screen-time carve-out must stay an exact path");
});
