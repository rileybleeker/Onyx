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

// ─── Last night's sleep and the journal draft (2026-11-14) ──────────────────────────────────────────────────
const sleepQs = [...C.SLEEP_QUESTIONS];
const TODAY = "2031-03-05";
const LAST_NIGHT = C.sleepAnswerDate(TODAY); // 2031-03-04

test("voiceSleepNames keeps only sleep questions and sleep-flagged items", () => {
  const items = [
    { name: "Question A?", sleep: false },
    { name: sleepQs[0], sleep: false },
    { name: "Question B?", sleep: true },
  ];
  assert.deepEqual(V.voiceSleepNames(items), [sleepQs[0], "Question B?"]);
});

test("sleep validator keeps allowed sleep Yes/No for a night that already happened", () => {
  const raw = { sleep_answers: [{ question: sleepQs[0], answer: "Yes" }, { question: sleepQs[1], answer: "No" }, { question: sleepQs[0], answer: "No" }] };
  assert.deepEqual({ ...V.parseSleepAnswers(raw, sleepQs, LAST_NIGHT, TODAY) }, { [sleepQs[0]]: "Yes", [sleepQs[1]]: "No" });
});

test("sleep validator drops daytime questions, unknown names and non-Yes/No answers", () => {
  const raw = { sleep_answers: [{ question: "Question A?", answer: "Yes" }, { question: sleepQs[0], answer: "maybe" }, { question: "Not asked?", answer: "Yes" }, null] };
  assert.deepEqual({ ...V.parseSleepAnswers(raw, [...sleepQs, "Question A?"], LAST_NIGHT, TODAY) }, {});
  assert.deepEqual({ ...V.parseSleepAnswers({ sleep_answers: [{ question: sleepQs[0], answer: "Yes" }] }, [], LAST_NIGHT, TODAY) }, {}, "not in the allowed list");
});

test("sleep validator never answers tonight or a later night (sleepDateError)", () => {
  const raw = { sleep_answers: [{ question: sleepQs[0], answer: "Yes" }] };
  assert.deepEqual({ ...V.parseSleepAnswers(raw, sleepQs, TODAY, TODAY) }, {});
  assert.deepEqual({ ...V.parseSleepAnswers(raw, sleepQs, C.addDays(TODAY, 1), TODAY) }, {});
});

test("voiceResult returns the day, last night and the journal labels", async () => {
  const model = {
    answers: [{ question: "Question A?", answer: "Yes" }, { question: sleepQs[0], answer: "Yes" }],
    sleep_answers: [{ question: sleepQs[0], answer: "No" }, { question: "Question B?", answer: "Yes" }],
    journal: { title: "Synthetic gym day and early night", mood: "good", confidence: "high", topics: ["gym", "Sleep", "gym", "bad tag!"] },
  };
  const r = await V.voiceResult(async () => JSON.stringify(model), ALLOWED, { names: sleepQs, date: LAST_NIGHT, today: TODAY });
  assert.deepEqual({ ...r.answers }, { "Question A?": "Yes" }, "a sleep question never lands on the day");
  assert.equal(r.night.date, LAST_NIGHT);
  assert.deepEqual({ ...r.night.answers }, { [sleepQs[0]]: "No" });
  assert.deepEqual({ ...r.journal, topics: [...r.journal.topics] }, { title: "Synthetic gym day and early night", mood: "good", confidence: "high", topics: ["gym", "sleep"] });
});

test("voiceResult without sleep questions has no night; missing labels give a blank draft", async () => {
  const r = await V.voiceResult(async () => out([{ question: "Question A?", answer: "No" }]), ALLOWED);
  assert.equal(r.night, null);
  assert.deepEqual({ ...r.journal, topics: [...r.journal.topics] }, { title: "", mood: null, confidence: "medium", topics: [] });
});

test("#say= hand-off: decodes the words, ignores other hashes, caps the length", () => {
  assert.equal(V.sayFromHash("#say=Synthetic%20words%2C%20one%20%2B%20two"), "Synthetic words, one + two");
  assert.equal(V.sayFromHash("#say=Synthetic+form+encoded"), "Synthetic form encoded");
  assert.equal(V.sayFromHash("#say=%20%20"), null);
  assert.equal(V.sayFromHash("#say=%E0%A4%A"), null, "malformed encoding");
  assert.equal(V.sayFromHash("#other=x"), null);
  assert.equal(V.sayFromHash(""), null);
  assert.equal(V.sayFromHash("#say=" + "x".repeat(V.VOICE_MAX_TEXT_CHARS + 50)).length, V.VOICE_MAX_TEXT_CHARS);
});

test("request checks take a larger cap when asked (the journal route)", () => {
  const h = (o) => ({ get: (k) => o[k.toLowerCase()] ?? null });
  const base = { origin: "https://app.example", host: "app.example", "content-type": "application/json", "content-length": "20000" };
  assert.equal(V.checkVoiceRequest(h(base), "https://app.example").status, 413);
  assert.equal(V.checkVoiceRequest(h(base), "https://app.example", 32 * 1024), null);
});

test("route rules: last night is sleepAnswerDate(today), a stale screen gets 409, still read-only", () => {
  const route = fs.readFileSync(path.join(SRC, "app/api/habits/checkin/voice/route.ts"), "utf8");
  assert.match(route, /sleepAnswerDate\(today\)/);
  assert.match(route, /voiceSleepNames/);
  assert.match(route, /stale: true/);
  assert.match(route, /status: 409/);
  assert.match(route, /sleep_answers/);
  assert.match(route, /known_topics/);
  assert.equal(/journal\/entry|api\.notion\.com/.test(route.replace(/^\/\/.*$/gm, "")), false, "the voice route never writes the journal");
});

test("the screen puts last night's answers in that night's block and offers a journal draft", () => {
  const client = fs.readFileSync(path.join(SRC, "app/check-in/CheckInClient.tsx"), "utf8");
  assert.match(client, /applyRef\.current\(nightDate, nightPatch\)/);
  assert.match(client, /night\.date < now\.today && now\.nights\.some/);
  assert.match(client, /today: page\.today/);
  assert.match(client, /\/api\/journal\/entry/);
  assert.match(client, /Save to journal/);
  assert.match(client, /sayFromHash\(/);
  assert.match(client, /history\.replaceState/);
});

test("the screen applies answers as draft taps and marks them 'from what you said'", () => {
  const client = fs.readFileSync(path.join(SRC, "app/check-in/CheckInClient.tsx"), "utf8");
  assert.match(client, /\/api\/habits\/checkin\/voice/);
  assert.match(client, /from what you said/);
  assert.match(client, /apply(?:Ref\.current)?\(null, patch\)/); // the newest apply: the answer arrives after a round trip
  assert.match(client, /Filled \$\{n\} answer/);
  assert.match(client, /Nothing in the text matched a question\./);
});
