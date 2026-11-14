// Run: node --test tests/checkin-voice.test.cjs
// The /check-in "Say it once" box: the answer validator (lib/checkin-voice.ts) and the rules of
// POST /api/habits/checkin/voice. SYNTHETIC question names and text only; no network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const V = loadTs("lib/checkin-voice.ts");
const C = loadTs("lib/checkin.ts");

const ALLOWED = ["Question A?", "Question B?", "Question C?"];
const sleepQ = [...C.SLEEP_QUESTIONS][0];
const out = (answers) => ({ answers });

test("validator keeps allowed Yes/No answers", () => {
  const r = V.parseVoiceAnswers(out([{ question: "Question A?", answer: "Yes" }, { question: "Question B?", answer: "No" }]), ALLOWED);
  assert.deepEqual({ ...r }, { "Question A?": "Yes", "Question B?": "No" });
});

test("validator accepts the model's JSON as text", () => {
  const r = V.parseVoiceAnswers(JSON.stringify(out([{ question: "Question C?", answer: "Yes" }])), ALLOWED);
  assert.deepEqual({ ...r }, { "Question C?": "Yes" });
});

test("validator drops an unknown question", () => {
  const r = V.parseVoiceAnswers(out([{ question: "Not a question", answer: "Yes" }, { question: "question a?", answer: "Yes" }]), ALLOWED);
  assert.deepEqual({ ...r }, {});
});

test("validator drops anything that is not exactly Yes or No", () => {
  const r = V.parseVoiceAnswers(
    out([
      { question: "Question A?", answer: "Maybe" },
      { question: "Question B?", answer: "yes" },
      { question: "Question C?", answer: null },
      { answer: "Yes" },
      null,
    ]),
    ALLOWED
  );
  assert.deepEqual({ ...r }, {});
});

test("validator: the first answer wins on a duplicate", () => {
  const r = V.parseVoiceAnswers(out([{ question: "Question A?", answer: "No" }, { question: "Question A?", answer: "Yes" }]), ALLOWED);
  assert.deepEqual({ ...r }, { "Question A?": "No" });
});

test("validator drops a sleep question even when it is in the allowed list", () => {
  const r = V.parseVoiceAnswers(out([{ question: sleepQ, answer: "Yes" }, { question: "Question A?", answer: "Yes" }]), [...ALLOWED, sleepQ]);
  assert.deepEqual({ ...r }, { "Question A?": "Yes" });
});

test("validator: output that is not the expected shape is null", () => {
  assert.equal(V.parseVoiceAnswers("not json", ALLOWED), null);
  assert.equal(V.parseVoiceAnswers({ answers: "x" }, ALLOWED), null);
  assert.equal(V.parseVoiceAnswers(null, ALLOWED), null);
});

test("voiceQuestionNames leaves out sleep questions and sleep-flagged items", () => {
  const items = [
    { name: "Question A?", sleep: false },
    { name: sleepQ, sleep: false },
    { name: "Question B?", sleep: true },
  ];
  assert.deepEqual(V.voiceQuestionNames(items), ["Question A?"]);
});

test("text: empty, blank, non-string and over-long are rejected; trimmed otherwise", () => {
  assert.equal(V.parseVoiceText("").ok, false);
  assert.equal(V.parseVoiceText("   \n ").ok, false);
  assert.equal(V.parseVoiceText(5).ok, false);
  assert.equal(V.parseVoiceText("x".repeat(V.VOICE_MAX_TEXT_CHARS + 1)).ok, false);
  assert.equal(V.parseVoiceText("x".repeat(V.VOICE_MAX_TEXT_CHARS)).ok, true);
  assert.equal(V.parseVoiceText("  hello  ").text, "hello");
});

test("model failure maps to {failed: true}", async () => {
  assert.deepEqual(await V.voiceResult(async () => { throw new Error("boom"); }, ALLOWED), { failed: true });
  assert.deepEqual(await V.voiceResult(async () => "garbage", ALLOWED), { failed: true });
  const ok = await V.voiceResult(async () => out([{ question: "Question A?", answer: "Yes" }]), ALLOWED);
  assert.deepEqual({ ...ok.answers }, { "Question A?": "Yes" });
});

test("request checks: same origin, JSON, 8 KB cap", () => {
  const h = (o) => ({ get: (k) => o[k.toLowerCase()] ?? null });
  const base = { origin: "https://app.example", host: "app.example", "content-type": "application/json" };
  assert.equal(V.checkVoiceRequest(h(base), "https://app.example"), null);
  assert.equal(V.checkVoiceRequest(h({ ...base, origin: undefined }), "https://app.example").status, 403);
  assert.equal(V.checkVoiceRequest(h({ ...base, origin: "https://evil.example" }), "https://app.example").status, 403);
  assert.equal(V.checkVoiceRequest(h({ ...base, "content-type": "text/plain" }), "https://app.example").status, 415);
  assert.equal(V.checkVoiceRequest(h({ ...base, "content-length": "9000" }), "https://app.example").status, 413);
});

test("route rules: POST only, body cap, under /api/habits, read-only, text never logged", () => {
  const file = path.join(SRC, "app/api/habits/checkin/voice/route.ts");
  assert.ok(fs.existsSync(file));
  const route = fs.readFileSync(file, "utf8");
  assert.deepEqual([...route.matchAll(/export (?:async )?(?:function|const) (\w+)/g)].map((m) => m[1]).filter((n) => n !== "maxDuration"), ["POST"]);
  assert.match(route, /8 \* 1024/);
  assert.match(route, /checkVoiceRequest/);
  assert.ok(path.relative(SRC, file).split(path.sep).join("/").startsWith("app/api/habits/"));
  assert.equal(/\.(upsert|insert|update|delete)\(/.test(route), false);
  assert.equal(/console\.(log|info)/.test(route), false);
  for (const line of route.split("\n").filter((l) => /console\./.test(l))) assert.equal(/text|body|answers/i.test(line.replace(/\[checkin-voice\]/, "")), false, line);
  assert.match(route, /claude-sonnet-5-5/);
  assert.match(route, /effort: "low"/);
  const mw = fs.readFileSync(path.join(SRC, "middleware.ts"), "utf8");
  const ci = mw.slice(mw.indexOf("function isCiRoute"), mw.indexOf("function isCiRoute") + 2500);
  assert.equal(/voice/i.test(ci.slice(0, ci.indexOf("\n}\n"))), false);
});

test("the screen applies answers as draft taps and marks them 'from what you said'", () => {
  const client = fs.readFileSync(path.join(SRC, "app/check-in/CheckInClient.tsx"), "utf8");
  assert.match(client, /\/api\/habits\/checkin\/voice/);
  assert.match(client, /from what you said/);
  assert.match(client, /apply\(null, patch\)/);
  assert.match(client, /Filled \$\{n\} answer/);
  assert.match(client, /Nothing in the text matched a question\./);
});
