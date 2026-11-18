// Run: node --test tests/signins-card-unknown.test.cjs
// Source-text checks for the /status Sign-ins card: "Nothing due" must never show while status is missing
// or while a live credential is unknown, and the page must not pass an empty list in place of missing data.
// Reads the .tsx sources as text only - no rendering, no network, no credentials.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");
const card = fs.readFileSync(path.join(SRC, "components", "SigninsCard.tsx"), "utf8");
const page = fs.readFileSync(path.join(SRC, "app", "status", "page.tsx"), "utf8");

const NOTHING_DUE = "Nothing due in the next 45 days";

test("'Nothing due' appears once, only in a branch gated on defined status and no unknown entries", () => {
  const occurrences = card.split(NOTHING_DUE).length - 1;
  assert.equal(occurrences, 1, "the 'Nothing due' string should appear exactly once");

  const index = card.indexOf(NOTHING_DUE);
  // The branch condition is computed once and must include both checks.
  assert.match(card, /const nothingDue = signins !== undefined && unknown\.length === 0 && items\.length === 0 && problems\.length === 0;/);
  // The string is rendered only under that condition.
  const before = card.slice(Math.max(0, index - 300), index);
  assert.match(before, /nothingDue \?/, "the 'Nothing due' line must sit in the nothingDue branch");
});

test("status page does not turn missing signins into an empty list", () => {
  const signinsLine = page.split("\n").find((l) => l.includes("<SigninsCard"));
  assert.ok(signinsLine, "page renders SigninsCard");
  assert.ok(!signinsLine.includes("?? []"), "SigninsCard must receive undefined, not []");
  assert.match(signinsLine, /signins=\{data\?\.signins\}/);
});

test("SigninsCard accepts and handles an undefined signins prop", () => {
  assert.match(card, /signins: SigninStatus\[\] \| undefined/);
  assert.match(card, /signins === undefined/, "the card has a branch for missing status");
  assert.match(card, /Sign-in status is not available yet\. Reload to try again\./);
  assert.match(card, /\(signins \?\? \[\]\)/, "lookup map tolerates undefined");
});

test("unknown live entries are listed with the Unknown style, and missing rows count as unknown", () => {
  assert.match(card, /live\.filter\(\(e\) => \(byId\.get\(e\.id\)\?\.state \?\? "unknown"\) === "unknown"\)/);
  assert.match(card, /\{unknown\.map\(\(e\) => \(/);
  assert.match(card, /STATE_COLOR\.unknown/);
});
