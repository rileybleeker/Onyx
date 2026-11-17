// Run: node --test tests/youtube-status.test.cjs
// YouTube watch history (tools/youtube_history on the collector PC): the /status card is wired in the three places
// AGENTS.md names and reads the heartbeat only (never rows of pds.youtube_watch_events). Static checks.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SRC } = require("./helpers/load-ts.cjs");

const route = fs.readFileSync(path.join(SRC, "app/api/status/route.ts"), "utf8");
const page = fs.readFileSync(path.join(SRC, "app/status/page.tsx"), "utf8");

test("the status route has a cadence, a method, its own heartbeat read and a card", () => {
  assert.match(route, /^\s+youtube: "Daily look/m);
  assert.match(route, /^\s+youtube:\s+\{ method: "semi-automated"/m);
  assert.match(route, /\["youtube", "history"\]/);
  assert.match(route, /latestBySrcType\["youtube\|history"\]/);
  assert.match(route, /label: "YouTube History"/);
  assert.doesNotMatch(route, /from\("youtube_watch_events"\)/, "heartbeat-driven; no watch rows are read");
});

test("the status page lists the card and labels its history", () => {
  assert.match(page, /youtube: "TAKEOUT"/);
  assert.match(page, /youtube: "text-/);
  assert.match(page, /SOURCE_ORDER = \[[^\]]*"youtube"/s);
  assert.match(page, /youtube: "YouTube History"/);
  assert.match(page, /history: "Watch history"/);
});
