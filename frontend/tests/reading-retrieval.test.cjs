// PROD-T08: sourced retrieval session rules (lib/reading-retrieval.ts): deck order, delayed 7 / 21-day checks measured
// from the first graded attempt, invalid and pending answers left out of the report, session caps with resume without
// penalty, and the pending request that keeps its keys. Synthetic data only; no network.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const R = loadTs("lib/reading-retrieval.ts");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

const Q = (id, key, o = {}) => ({
  question_id: id, question_key: key, version: 1, prompt: `Synthetic question ${id}`, rubric: null,
  source_kind: "highlight", source_ref: id, source_status: "same", superseded_at: null, ...o,
});
const A = (id, qid, date, correct, o = {}) => ({
  attempt_key: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`, question_id: qid, attempt_date: date,
  answer: "Synthetic answer", answered_at: `${date}T12:00:00Z`, grading_status: "graded", correct, ...o,
});
const H = (id, o = {}) => ({ highlight_id: id, chapter: 2, concept: null, passage: `Synthetic passage ${id}`, comment: null, archived: false, ...o });
const K1 = "00000000-0000-4000-8000-0000000000a1";
const K2 = "00000000-0000-4000-8000-0000000000a2";

test("daysBetween is whole days", () => {
  assert.equal(R.daysBetween("2026-03-01", "2026-03-08"), 7);
  assert.equal(R.daysBetween("2026-03-07", "2026-03-09"), 2);
});

test("a delayed check is due from 7 days after the first graded attempt, once per bucket", () => {
  const one = [A(1, 1, "2026-03-01", true)];
  assert.equal(R.dueBucket(one, "2026-03-07"), null);
  assert.equal(R.dueBucket(one, "2026-03-08"), "7");
  assert.equal(R.dueBucket(one, "2026-03-22"), "21");
  const done7 = [...one, A(2, 1, "2026-03-09", false)];
  assert.equal(R.dueBucket(done7, "2026-03-15"), null);
  assert.equal(R.dueBucket(done7, "2026-03-22"), "21");
  assert.equal(R.dueBucket([...done7, A(3, 1, "2026-03-23", true)], "2026-04-30"), null);
});

test("the deck: ungraded answers first, then 21-day before 7-day, then new highlights not yet used", () => {
  const questions = [Q(1, K1), Q(2, K2, { source_ref: 2 }), Q(3, "00000000-0000-4000-8000-0000000000a3", { source_ref: 3 })];
  const attempts = [
    A(1, 1, "2026-02-20", true),
    A(2, 2, "2026-03-10", true),
    A(3, 3, "2026-03-19", true, { grading_status: "pending", correct: null }),
  ];
  const deck = R.buildDeck({ questions, attempts, highlights: [H(1), H(2), H(3), H(4), H(5, { archived: true })], today: "2026-03-20" });
  assert.deepEqual(deck.map((c) => c.id.split(":")[0] + (c.bucket ? c.bucket : "")), ["finish", "recall21", "recall7", "new"]);
  assert.equal(deck.at(-1).highlight.highlight_id, 4);
  const skipped = R.buildDeck({ questions, attempts, highlights: [H(4)], today: "2026-03-20", taken: new Set([deck[0].id]) });
  assert.ok(!skipped.some((c) => c.kind === "finish"));
});

test("a question whose source is gone, or an answer to an older version, is not offered", () => {
  const questions = [Q(1, K1, { source_status: "removed" }), Q(2, K2, { version: 1, superseded_at: "2026-03-05T00:00:00Z" }), Q(3, K2, { version: 2, source_ref: 2 })];
  const attempts = [A(1, 1, "2026-03-01", true), A(2, 2, "2026-03-01", false, { grading_status: "pending", correct: null })];
  const deck = R.buildDeck({ questions, attempts, highlights: [], today: "2026-03-20" });
  assert.equal(deck.length, 0);
});

test("the report keeps delayed recall apart and leaves out invalidated and pending answers", () => {
  const questions = [Q(1, K1), Q(2, K2, { source_ref: 2 })];
  const attempts = [
    A(1, 1, "2026-03-01", true), A(2, 1, "2026-03-03", false), A(3, 1, "2026-03-09", true), A(4, 1, "2026-03-25", false),
    A(5, 2, "2026-03-01", false), A(6, 2, "2026-03-10", true, { grading_status: "invalidated" }),
    A(7, 2, "2026-03-12", null, { grading_status: "pending", correct: null }),
  ];
  const r = R.recallReport(questions, attempts);
  assert.deepEqual(r.first, { n: 2, correct: 1 });
  assert.deepEqual(r.delayed7, { n: 1, correct: 1 });
  assert.deepEqual(r.delayed21, { n: 1, correct: 0 });
  assert.equal(r.pending, 1);
  assert.equal(r.invalidated, 1);
  assert.equal(R.percent({ n: 0, correct: 0 }), "—");
});

test("session caps are checked between cards; a long pause is not counted; skipping is not counted", () => {
  let s = R.startSession("synthetic-book", "2026-03-10", 3, 5, 0);
  s = R.takeCard(s, "a", true, 60_000);
  s = R.takeCard(s, "b", false, 120_000);
  assert.equal(s.done, 1);
  assert.deepEqual(s.taken, ["a", "b"]);
  assert.equal(R.sessionEnded(s), null);
  // away for two hours: only the capped gap is used
  s = R.touch(s, 120_000 + 2 * 3600 * 1000);
  assert.equal(s.usedMs, 120_000 + R.ACTIVE_GAP_MS);
  assert.equal(R.sessionEnded(s), "time");
  s = R.startSession("synthetic-book", "2026-03-10", 2, null, 0);
  s = R.takeCard(R.takeCard(s, "a", true, 1), "b", true, 2);
  assert.equal(R.sessionEnded(s), "cards");
  assert.equal(R.minutesLeft(R.startSession("b", "d", 3, null, 0)), null);
});

test("a stored session only resumes for the same book and day", () => {
  const s = R.startSession("synthetic-book", "2026-03-10", 3, null, 5);
  const raw = JSON.stringify(s);
  assert.equal(R.parseSession(raw, "synthetic-book", "2026-03-10").cards, 3);
  assert.equal(R.parseSession(raw, "other-book", "2026-03-10"), null);
  assert.equal(R.parseSession(raw, "synthetic-book", "2026-03-11"), null);
  assert.equal(R.parseSession("not json", "synthetic-book", "2026-03-10"), null);
});

test("a pending request round-trips with its own keys and refuses a foreign or malformed one", () => {
  const p = {
    kind: "answer", book: "synthetic-book", attempt_key: K1, question_key: K2, prompt: "Synthetic?", rubric: null,
    source_kind: "highlight", source_ref: 4, answer: "Synthetic", cardId: "new:4",
  };
  const back = R.parsePending(JSON.stringify(p), "synthetic-book");
  assert.deepEqual(R.pendingBody(back), {
    op: "answer", op_key: K1, book: "synthetic-book", question_key: K2, prompt: "Synthetic?",
    source_kind: "highlight", source_ref: 4, answer: "Synthetic",
  });
  assert.equal(R.parsePending(JSON.stringify(p), "other-book"), null);
  assert.equal(R.parsePending(JSON.stringify({ ...p, attempt_key: "x" }), "synthetic-book"), null);
  const g = { kind: "grade", book: "synthetic-book", attempt_key: K1, correct: false, cardId: "finish:" + K1, question_key: K2, version: 1 };
  assert.deepEqual(R.pendingBody(R.parsePending(JSON.stringify(g), "synthetic-book")), { op: "grade", attempt_key: K1, correct: false, grader: "self" });
});

test("the component writes only after a tap and never adds a table, a key route or a CI path", () => {
  const c = read("app/reading/RetrievalSession.tsx");
  assert.ok(/aria-live="polite"/.test(c) && /role="alert"/.test(c));
  // the only POST is the one helper that every button handler calls; the mount effect only GETs
  assert.equal((c.match(/method: "POST"/g) || []).length, 1);
  const m = c.match(/useEffect\(\(\) => \{\s*void load\(\);[\s\S]*?const persistSession/);
  assert.ok(m, "mount effect found");
  const effect = m[0];
  assert.ok(!/post\(|sendAnswer|sendGrade|retryPending/.test(effect));
  assert.ok(!/isCiRoute/.test(read("lib/reading-retrieval.ts")));
});
