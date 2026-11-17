// Synthetic tests for the Shortcuts-push rules (src/lib/phone-messages-ingest.ts).
// No network, no credentials, no real messages. Run: node scripts/test-phone-messages-ingest.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/phone-messages-ingest.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const lib = await import("data:text/javascript;base64," + Buffer.from(outputText).toString("base64"));
const { parseIngestBody, looksLikeOneTimeCode, parseAllowList, senderAllowed, normalizeSender, MAX_BATCH } = lib;

const NOW = Date.parse("2026-11-17T15:00:00Z");

test("a single synthetic text is accepted", () => {
  const r = parseIngestBody({ sender: "Alex Example", text: "lunch at noon?", received_at: "2026-11-17T14:59:00Z" }, NOW, []);
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].receivedAt, "2026-11-17T14:59:00.000Z");
});

test("a batch is accepted up to the cap, not beyond", () => {
  const one = { sender: "A", text: "hi" };
  assert.equal(parseIngestBody({ messages: Array(MAX_BATCH).fill(one) }, NOW, []).ok, true);
  assert.equal(parseIngestBody({ messages: Array(MAX_BATCH + 1).fill(one) }, NOW, []).ok, false);
  assert.equal(parseIngestBody({ messages: [] }, NOW, []).ok, false);
});

test("missing, unreadable or future time means now; a text older than 30 days is skipped", () => {
  const iso = new Date(NOW).toISOString();
  assert.equal(parseIngestBody({ sender: "A", text: "x" }, NOW, []).items[0].receivedAt, iso);
  assert.equal(parseIngestBody({ sender: "A", text: "x", received_at: "Nov 17 at 3pm" }, NOW, []).items[0].receivedAt, iso);
  assert.equal(parseIngestBody({ sender: "A", text: "x", received_at: "2027-01-01T00:00:00Z" }, NOW, []).items[0].receivedAt, iso);
  const old = parseIngestBody({ sender: "A", text: "x", received_at: "2026-09-01T00:00:00Z" }, NOW, []);
  assert.equal(old.items.length, 0);
  assert.equal(old.skippedInvalid, 1);
});

test("one-time codes are dropped, ordinary numbers are kept", () => {
  assert.equal(looksLikeOneTimeCode("Your verification code is 482913"), true);
  assert.equal(looksLikeOneTimeCode("Use 123-456 to sign in. Do not share."), true);
  assert.equal(looksLikeOneTimeCode("G-482913 is your Example login code"), true);
  assert.equal(looksLikeOneTimeCode("Dinner is at 7, table for 4"), false);
  assert.equal(looksLikeOneTimeCode("Your code review is at 3:30"), false);
  const r = parseIngestBody({ messages: [{ sender: "Bank", text: "Your code is 123456" }, { sender: "Pal", text: "see you at 8" }] }, NOW, []);
  assert.equal(r.items.length, 1);
  assert.equal(r.skippedCodes, 1);
});

test("the sender allow-list restricts when set and is open when empty", () => {
  const allow = parseAllowList("+1 (404) 555-0100, Alex Example");
  assert.equal(senderAllowed("4045550100", allow), true);
  assert.equal(senderAllowed("+14045550100", allow), true);
  assert.equal(senderAllowed("alex example", allow), true);
  assert.equal(senderAllowed("Someone Else", allow), false);
  assert.equal(senderAllowed("Someone Else", []), true);
  const r = parseIngestBody({ messages: [{ sender: "Someone Else", text: "hi" }] }, NOW, allow);
  assert.equal(r.items.length, 0);
  assert.equal(r.skippedScope, 1);
  assert.equal(normalizeSender("  Alex  "), "alex");
});

test("bad shapes are refused or counted without echoing the text", () => {
  assert.equal(parseIngestBody(null, NOW, []).ok, false);
  assert.equal(parseIngestBody([], NOW, []).ok, false);
  const r = parseIngestBody({ messages: [{ sender: "", text: "SYNTHETIC-SECRET" }, { sender: "A", text: "x".repeat(4001) }, 5] }, NOW, []);
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 0);
  assert.equal(r.skippedInvalid, 3);
  assert.equal(JSON.stringify(r).includes("SYNTHETIC-SECRET"), false);
});

test("the module has no imports, fetch, fs or process access", () => {
  assert.equal(/^\s*import\s/m.test(source), false);
  assert.equal(/\bfetch\(|\bprocess\.|require\(/.test(source), false);
});
