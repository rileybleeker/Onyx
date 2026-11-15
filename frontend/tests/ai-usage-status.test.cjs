// Run: node --test tests/ai-usage-status.test.cjs
// AI tool usage (tools/ai_usage_harvest on Riley's PC): the /status card is wired in the three places
// AGENTS.md "Every integration must appear on /status" names, and it reads the heartbeat only (the
// route never selects rows of pds.ai_tool_usage_daily). Static checks; no network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SRC } = require("./helpers/load-ts.cjs");

const route = fs.readFileSync(path.join(SRC, "app/api/status/route.ts"), "utf8");
const page = fs.readFileSync(path.join(SRC, "app/status/page.tsx"), "utf8");

test("the status route has a cadence, a method, its own heartbeat read and a card", () => {
  assert.match(route, /^\s+ai_usage: "Every 3h/m);
  assert.match(route, /^\s+ai_usage:\s+\{ method: "automated"/m);
  assert.match(route, /\["ai_usage", "sessions"\]/);
  assert.match(route, /latestBySrcType\["ai_usage\|sessions"\]/);
  assert.match(route, /label: "AI Tool Usage"/);
  assert.doesNotMatch(route, /from\("ai_tool_usage_daily"\)/, "the card is heartbeat-driven; no usage rows are read");
});

test("the status page lists the card and labels its history", () => {
  assert.match(page, /ai_usage: "PC"/);
  assert.match(page, /ai_usage: "text-/);
  assert.match(page, /SOURCE_ORDER = \[[^\]]*"ai_usage"/s);
  assert.match(page, /ai_usage: "AI Tool Usage"/);
  assert.match(page, /sessions: "Sessions"/);
});
