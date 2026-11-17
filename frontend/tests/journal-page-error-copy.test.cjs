// Offline source-text check for the Journal page's load errors (app/journal/page.tsx). Every failed load must show
// a fixed plain sentence; raw server text (data.error) or a thrown error (String(e)) must never reach setError or
// setEntryError, because those strings render into the DOM. Reads the source with fs; no network, no real data.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "src", "app", "journal", "page.tsx"), "utf8");

test("list load failures use the fixed sentence", () => {
  assert.ok(SRC.includes(`setError("Couldn't load your journal. Try again.")`));
});

test("entry open failures use the fixed sentence", () => {
  assert.ok(SRC.includes(`setEntryError("Couldn't load that entry. Try again.")`));
  assert.ok(SRC.includes(`setEntryError("Couldn't open that entry. Try again.")`));
});

test("setError and setEntryError are never given data.error or String(e)", () => {
  const calls = [...SRC.matchAll(/setEntryError\(([^;]*)\);|setError\(([^;]*)\);/g)].map((m) => m[1] ?? m[2]);
  assert.ok(calls.length >= 4, "expected the load and open error setters");
  for (const arg of calls) {
    assert.doesNotMatch(arg, /data\.error|String\(e\)/, `raw text passed to a setter: ${arg}`);
  }
});

test("raw error text is not rendered into the DOM", () => {
  // Only console.error may see the detail; no JSX expression may print data.error, String(e) or the caught error.
  const jsx = SRC.split("\n").filter((l) => !l.includes("console.error"));
  for (const line of jsx) {
    assert.doesNotMatch(line, /\{\s*(data\.error|String\(e\)|e\.message)\s*\}/);
  }
});
