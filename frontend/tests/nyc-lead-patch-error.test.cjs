// Offline source-text check for the NYC lead PATCH route (app/api/nyc/leads/[id]/route.ts). A failed save must answer
// with a fixed plain sentence, never the raw exception text (Notion or database details). The raw error goes to the
// server log only. Reads the source with fs; no network, no real data.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = fs.readFileSync(
  path.join(__dirname, "..", "src", "app", "api", "nyc", "leads", "[id]", "route.ts"),
  "utf8",
);

test("failed saves return the fixed sentences", () => {
  assert.ok(SRC.includes(`"This page is not in the NYC Leads database."`));
  assert.ok(SRC.includes(`"Couldn't save this lead. Try again."`));
});

test("the route body never references the raw exception message", () => {
  assert.ok(!SRC.includes("error: message"));
  assert.ok(!/e as Error\)\.message[^;]*NextResponse/.test(SRC));
});

test("the raw error is logged on the server", () => {
  assert.ok(SRC.includes(`console.error("nyc lead patch failed:", e)`));
});
