// PROD-T02: review grades and quiz results are one atomic, replay-safe database call each.
// Synthetic data only (no production database, no real titles, passages or scores).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const P = loadTs("lib/reading-practice.ts");
const R = loadTs("lib/reading.ts");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const sql = fs.readFileSync(path.join(SRC, "..", "..", "sql", "reading_practice_receipts.sql"), "utf8");

let serial = 0;
const key = () => `00000000-0000-4000-8000-${String(++serial).padStart(12, "0")}`;
const TODAY = "2026-03-10";

const highlight = (o = {}) => ({
  highlight_id: 41, book_id: 7, chapter: 2, location: null, passage: "Synthetic passage", comment: "Synthetic note",
  concept: null, source: "manual", review_count: 0, ease: 2.5, interval_days: 0, next_review: null, last_reviewed: null,
  archived: false, notion_block_id: null, created_at: "2026-03-01T12:00:00Z", position: null, position_end: null,
  page: null, highlighted_at: null, note_at: null, behavioral_date: null, ...o,
});

/**
 * A fake service-role client: reads answer from `rows`, the RPCs answer from `answers` (in order), and ANY
 * insert / update / upsert / delete is recorded as a direct write (the code must never make one).
 */
function fakeClient({ rows = [highlight()], answers = [], rpcError = null, readError = null } = {}) {
  const calls = { rpc: [], reads: 0, writes: [] };
  let rowIndex = 0;
  const client = {
    rpc: async (name, args) => {
      calls.rpc.push({ name, args: structuredClone(args) });
      if (name === "behavioral_today_now") return { data: TODAY, error: null };
      const next = answers.shift();
      return { data: next === undefined ? null : next, error: rpcError };
    },
    from: (table) => {
      const q = {
        select: () => q, eq: () => q, order: () => q, limit: () => q, neq: () => q,
        maybeSingle: async () => {
          calls.reads++;
          if (readError) return { data: null, error: readError };
          const r = rows[Math.min(rowIndex++, rows.length - 1)];
          return { data: table === "books" ? { book_id: 7, slug: "synthetic-book", title: "Synthetic Book" } : r ?? null, error: null };
        },
        then: (yes, no) => Promise.resolve({ data: [{ book_id: 7, slug: "synthetic-book", title: "Synthetic Book" }], error: null }).then(yes, no),
      };
      for (const verb of ["insert", "update", "upsert", "delete"]) {
        q[verb] = (...a) => {
          calls.writes.push({ table, verb, a });
          return q;
        };
      }
      return q;
    },
  };
  return { client, calls };
}

const applied = (o = {}) => ({
  ok: true, review_id: 900, highlight_id: 41, grade: "good", review_date: TODAY, first_review_today: true, ease: 2.5,
  interval_days: 1, next_review: "2026-03-11", review_count: 1, replayed: false, highlight: highlight({ review_count: 1, interval_days: 1, next_review: "2026-03-11" }), ...o,
});

test("parsing: unknown fields, bad keys, bad grades and fractional scores are refused", () => {
  const k = key();
  assert.equal(P.parseReviewBody({ highlight_id: 41, grade: "good", op_key: k, expected_review_count: 0 }).ok, true);
  assert.equal(P.parseReviewBody({ highlight_id: 41, grade: "good" }).ok, true, "an older page without a key is still accepted");
  for (const bad of [
    null, [], { highlight_id: 41, grade: "hard" }, { highlight_id: "41", grade: "good" }, { highlight_id: 0, grade: "good" },
    { highlight_id: 41, grade: "good", op_key: "not-a-uuid" }, { highlight_id: 41, grade: "good", extra: 1 },
    { highlight_id: 41, grade: "good", expected_review_count: -1 },
  ]) assert.equal(P.parseReviewBody(bad).ok, false, JSON.stringify(bad));
  assert.equal(P.parseQuizBody({ checkpoint: "ch12", score: 4, total: 5, op_key: k }).ok, true);
  for (const bad of [
    { checkpoint: "", score: 1, total: 5 }, { checkpoint: "ch12", score: 6, total: 5 }, { checkpoint: "ch12", score: 1.5, total: 5 },
    { checkpoint: "ch12", score: 1, total: 0 }, { checkpoint: "ch12", score: 1, total: 5, op_key: "x" },
    { checkpoint: "ch12", score: 1, total: 5, notes: "n".repeat(P.QUIZ_NOTES_MAX + 1) }, { checkpoint: "x".repeat(41), score: 1, total: 5 },
    { checkpoint: "ch12", score: 1, total: 5, book: "Not A Slug" }, { checkpoint: "ch12", score: 1, total: 5, unknown: true },
  ]) assert.equal(P.parseQuizBody(bad).ok, false, JSON.stringify(bad));
});

test("a valid quiz note always fits the body cap; failures that may have been stored are told apart by status", () => {
  const worst = JSON.stringify({ book: "b".repeat(80), checkpoint: "\u0001".repeat(P.QUIZ_CHECKPOINT_MAX), score: 1000, total: 1000, notes: "\u0001".repeat(P.QUIZ_NOTES_MAX), op_key: key() });
  assert.ok(Buffer.byteLength(worst, "utf8") <= P.PRACTICE_MAX_BODY_BYTES, `worst-case body ${Buffer.byteLength(worst, "utf8")} bytes`);
  for (const status of [400, 404, 409, 413, 503]) assert.equal(P.failureMayHaveWritten({ status }), false, `${status} wrote nothing`);
  assert.equal(P.failureMayHaveWritten({ status: 500 }), true, "a 500 (or a lost answer) may have committed");
  assert.equal(P.failureMayHaveWritten(P.rpcFailure(null, { code: "" })), true, "supabase-js reports a lost answer as an error without a code");
  assert.equal(P.failureMayHaveWritten(P.rpcFailure(null, { code: "PGRST202" })), false, "the function is not applied: nothing written");
});

test("chat quiz tool: a failure that may have been stored is reported as incomplete, never as not recorded", () => {
  const src = read("app/api/chat/route.ts");
  const branch = src.slice(src.indexOf('if (name === "record_reading_quiz")'), src.indexOf("if (name ===", src.indexOf('if (name === "record_reading_quiz")') + 10));
  assert.match(src, /import \{ failureMayHaveWritten \} from "@\/lib\/reading-practice";/);
  assert.match(branch, /failureMayHaveWritten\(result\)/, "classified by status, never by the message text");
  assert.match(branch, /incomplete: true/, "the receipt then says 'may be incomplete' and to check before repeating");
  assert.doesNotMatch(branch, /if \(!result\.ok\) return JSON\.stringify\(\{ error: result\.error \}\);/);
  const receipts = loadTs("lib/chat-receipts.ts");
  const maybe = receipts.buildWriteReceipt("record_reading_quiz", { checkpoint: "ch3", score: 4, total: 5 }, JSON.stringify({ error: "Synthetic failure", incomplete: true }));
  assert.equal(maybe.status, "unknown", "not 'not_saved': the result may be stored");
  const refused = receipts.buildWriteReceipt("record_reading_quiz", { checkpoint: "ch3", score: 9, total: 5 }, JSON.stringify({ error: "score must be between 0 and total" }));
  assert.equal(refused.status, "not_saved", "a refusal wrote nothing");
});

test("a grade is ONE call of the atomic function, carrying the state its schedule was computed from", async () => {
  const f = fakeClient({ answers: [applied()] });
  const k = key();
  const r = await R.gradeHighlight(f.client, { highlight_id: 41, grade: "good", op_key: k, expected_review_count: 0, date: TODAY });
  assert.equal(r.ok, true);
  assert.equal(f.calls.writes.length, 0, "no direct insert/update: the review and the schedule commit inside the function");
  const calls = f.calls.rpc.filter((c) => c.name === "reading_grade_review");
  assert.equal(calls.length, 1);
  const p = calls[0].args.p;
  assert.equal(p.op_key, k);
  assert.deepEqual(p.basis, { review_count: 0, interval_days: 0, ease: 2.5 });
  assert.deepEqual(p.schedule, { ease: 2.5, interval_days: 1, next_review: "2026-03-11" }, "first Good = 1 day, the scheduler's own answer");
  assert.equal(p.client_review_count, 0);
  assert.equal(p.review_date, TODAY);
  assert.equal(r.firstReviewToday, true);
  assert.equal(r.receipt.next_review, "2026-03-11");
  assert.equal(r.replayed, false);
});

test("lost answer: the same key answers the stored receipt again and nothing new is written", async () => {
  const k = key();
  // The highlight already moved on (the first try committed): the replay must not be refused as 'changed'.
  const f = fakeClient({ rows: [highlight({ review_count: 1, interval_days: 1 })], answers: [{ ...applied(), highlight: undefined, replayed: true }] });
  const r = await R.gradeHighlight(f.client, { highlight_id: 41, grade: "good", op_key: k, expected_review_count: 0, date: TODAY });
  assert.equal(r.ok, true);
  assert.equal(r.replayed, true);
  assert.equal(r.receipt.review_id, 900);
  assert.equal(r.receipt.op_key, k);
  assert.equal(f.calls.writes.length, 0);
  assert.equal(f.calls.rpc.filter((c) => c.name === "reading_grade_review").length, 1);
});

test("day boundary: a retry after midnight sends the same key, and the grade's identity excludes the day", async () => {
  const k = key();
  const tomorrow = "2026-03-11";
  // First try before midnight: no answer reached the screen. Retry after midnight: the receipt of the first try.
  const f = fakeClient({ rows: [highlight(), highlight({ review_count: 1, interval_days: 1 })], answers: [applied(), { ...applied(), highlight: undefined, replayed: true }] });
  await R.gradeHighlight(f.client, { highlight_id: 41, grade: "good", op_key: k, expected_review_count: 0, date: TODAY });
  const r = await R.gradeHighlight(f.client, { highlight_id: 41, grade: "good", op_key: k, expected_review_count: 0, date: tomorrow });
  const [p1, p2] = f.calls.rpc.filter((c) => c.name === "reading_grade_review").map((c) => c.args.p);
  assert.equal(p1.op_key, p2.op_key);
  assert.notEqual(p1.review_date, p2.review_date, "the server's day moved on between the tries");
  assert.equal(r.ok && r.replayed, true);
  assert.equal(r.receipt.review_date, TODAY, "the stored grade keeps the day it was made, no second review on the new day");
  const review = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION pds.reading_grade_review"), sql.indexOf("CREATE OR REPLACE FUNCTION pds.reading_record_quiz"));
  assert.match(
    review,
    /v_hash := encode\(sha256\(convert_to\(jsonb_build_object\('highlight_id', v_hid, 'grade', v_grade\)::text, 'UTF8'\)\), 'hex'\);/,
    "the request identity is the highlight and the grade only, so the replay is not refused as another request",
  );
  // A quiz without an explicit date hashes a null day, so its retry after midnight also replays.
  const quiz = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION pds.reading_record_quiz"));
  assert.match(quiz, /'quiz_date', v_date\)::text/);
  assert.match(quiz, /v_date := NULLIF\(p->>'quiz_date', ''\)::date;/);
});

test("a write landing between the read and the lock: re-read and recompute, at most three tries", async () => {
  const raced = { ok: false, http: 409, code: "raced" };
  const once = fakeClient({ rows: [highlight(), highlight({ review_count: 1, interval_days: 1 })], answers: [raced, applied({ review_count: 2, interval_days: 3 })] });
  const r = await R.gradeHighlight(once.client, { highlight_id: 41, grade: "good", op_key: key(), date: TODAY });
  assert.equal(r.ok, true);
  const tries = once.calls.rpc.filter((c) => c.name === "reading_grade_review");
  assert.equal(tries.length, 2);
  assert.equal(tries[1].args.p.schedule.interval_days, 3, "the second try is scheduled from the re-read row");
  assert.equal(tries[0].args.p.op_key, tries[1].args.p.op_key, "one operation, one key");
  const always = fakeClient({ answers: [raced, raced, raced, raced] });
  const r2 = await R.gradeHighlight(always.client, { highlight_id: 41, grade: "good", op_key: key(), date: TODAY });
  assert.deepEqual(r2, { ok: false, status: 409, error: "changed" });
  assert.equal(always.calls.rpc.filter((c) => c.name === "reading_grade_review").length, 3);
});

test("refusals and failures are never success and never fall back to separate writes", async () => {
  for (const [rpcError, status, error] of [[{ code: "PGRST202" }, 503, "practice_unavailable"], [{ code: "42883" }, 503, "practice_unavailable"], [{ code: "57014" }, 500, "failed"]]) {
    const f = fakeClient({ rpcError });
    const r = await R.gradeHighlight(f.client, { highlight_id: 41, grade: "again", op_key: key(), date: TODAY });
    assert.deepEqual(r, { ok: false, status, error });
    assert.equal(f.calls.writes.length, 0);
  }
  for (const [answer, status, error] of [
    [{ ok: false, http: 409, code: "key_reused" }, 409, "key_reused"],
    [{ ok: false, http: 409, code: "changed", review_count: 3 }, 409, "changed"],
    [{ ok: false, http: 409, code: "archived" }, 409, "archived"],
    [{ ok: false, http: 404, code: "not_found" }, 404, "not_found"],
    [null, 500, "failed"],
  ]) {
    const f = fakeClient({ answers: [answer] });
    const r = await R.gradeHighlight(f.client, { highlight_id: 41, grade: "easy", op_key: key(), date: TODAY });
    assert.deepEqual(r, { ok: false, status, error });
    assert.equal(f.calls.writes.length, 0);
  }
  const unreadable = fakeClient({ readError: { code: "57014" } });
  assert.deepEqual(await R.gradeHighlight(unreadable.client, { highlight_id: 41, grade: "good", date: TODAY }), { ok: false, status: 500, error: "failed" });
  assert.equal(unreadable.calls.rpc.filter((c) => c.name === "reading_grade_review").length, 0);
  assert.deepEqual(await R.gradeHighlight(fakeClient().client, { highlight_id: 41, grade: "hard", date: TODAY }), { ok: false, status: 400, error: "bad_grade" });
});

test("a missing highlight still asks the function, so an earlier try's receipt answers first", async () => {
  const f = fakeClient({ rows: [null], answers: [{ ...applied(), highlight: undefined, replayed: true }] });
  const r = await R.gradeHighlight(f.client, { highlight_id: 41, grade: "good", op_key: key(), date: TODAY });
  assert.equal(r.ok, true);
  const p = f.calls.rpc.find((c) => c.name === "reading_grade_review").args.p;
  assert.equal(p.basis, null);
  assert.equal(p.schedule, null);
});

test("a quiz result is one call; the same key replays; no key still gets one (atomic, not retry-safe)", async () => {
  const k = key();
  const answer = { ok: true, quiz_id: 5, book_id: 7, checkpoint: "ch12", score: 4, total: 5, quiz_date: TODAY, passed: true };
  const f = fakeClient({ answers: [{ ...answer, replayed: false }, { ...answer, replayed: true }] });
  const first = await R.recordQuiz(f.client, { book_id: 7, checkpoint: "ch12", score: 4, total: 5, notes: " synthetic ", op_key: k });
  const again = await R.recordQuiz(f.client, { book_id: 7, checkpoint: "ch12", score: 4, total: 5, notes: " synthetic ", op_key: k });
  assert.equal(first.ok && again.ok, true);
  assert.equal(first.replayed, false);
  assert.equal(again.replayed, true);
  assert.equal(again.quiz.quiz_id, first.quiz.quiz_id, "the replay names the same stored attempt");
  assert.equal(f.calls.writes.length, 0, "no direct insert into reading_quizzes");
  const ps = f.calls.rpc.filter((c) => c.name === "reading_record_quiz").map((c) => c.args.p);
  assert.deepEqual(ps[0], ps[1], "a retry sends the identical request");
  assert.equal(ps[0].notes, "synthetic");
  assert.equal(ps[0].quiz_date, null, "the day is the server's behavioral today unless one is given");
  const keyless = fakeClient({ answers: [{ ...answer, replayed: false }] });
  const r = await R.recordQuiz(keyless.client, { book_id: 7, checkpoint: "ch12", score: 4, total: 5 });
  assert.equal(r.ok, true);
  assert.ok(P.isOpKey(r.op_key));
  const missing = fakeClient({ rpcError: { code: "PGRST202" } });
  assert.deepEqual(await R.recordQuiz(missing.client, { book_id: 7, checkpoint: "ch12", score: 4, total: 5, op_key: key() }), { ok: false, status: 503, error: "practice_unavailable" });
  assert.equal(missing.calls.writes.length, 0);
  const conflict = fakeClient({ answers: [{ ok: false, http: 409, code: "key_reused" }] });
  assert.deepEqual(await R.recordQuiz(conflict.client, { book_id: 7, checkpoint: "ch12", score: 3, total: 5, op_key: k }), { ok: false, status: 409, error: "key_reused" });
  assert.deepEqual(await R.recordQuiz(fakeClient().client, { book_id: 7, checkpoint: "ch12", score: 6, total: 5 }), { ok: false, status: 400, error: "score must be between 0 and total" });
});

test("XP counts durable stored attempts only: a replayed quiz adds no row, so the overview's points do not change", () => {
  const book = { book_id: 7, slug: "synthetic-book", title: "Synthetic Book", author: null, total_chapters: 10, start_date: "2026-03-01", target_date: "2026-03-31", status: "reading", finished_on: null, notion_page_id: null, habit_name: null, asin: null, last_position: null, last_position_at: null, total_positions: null };
  const quiz = { quiz_id: 5, book_id: 7, checkpoint: "ch3", score: 4, total: 5, notes: null, quiz_date: TODAY };
  const o = R.computeOverview({ book, today: TODAY, sessions: [], highlights: [], reviews: [], quizzes: [quiz] });
  assert.equal(o.xp.quizzes, 4 * R.XP.perQuizPoint);
  // Two legacy rows (stored before keys existed) stay two attempts: nothing is deduplicated after the fact.
  const legacy = R.computeOverview({ book, today: TODAY, sessions: [], highlights: [], reviews: [], quizzes: [quiz, { ...quiz, quiz_id: 6 }] });
  assert.equal(legacy.xp.quizzes, 8 * R.XP.perQuizPoint);
});

test("routes: same-origin JSON with a size cap; codes only in errors; no direct table write in either route", () => {
  for (const rel of ["app/api/reading/review/route.ts", "app/api/reading/quiz/route.ts"]) {
    const src = read(rel);
    assert.match(src, /checkVoiceRequest\(req\.headers, req\.nextUrl\.origin, PRACTICE_MAX_BODY_BYTES\)/);
    assert.match(src, /Buffer\.byteLength\(raw, "utf8"\) > PRACTICE_MAX_BODY_BYTES/);
    assert.doesNotMatch(src, /\.from\(|\.insert\(|\.update\(/);
  }
  const mw = read("middleware.ts");
  const ci = mw.slice(mw.indexOf("function isCiRoute"), mw.indexOf("}", mw.indexOf("function isCiRoute")));
  assert.doesNotMatch(ci, /\/api\/reading\/(review|quiz)/, "never a CI-token route");
});

test("SQL: lock, then receipt, then row lock, then review + schedule + receipt in the same function; service role only", () => {
  const review = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION pds.reading_grade_review"), sql.indexOf("CREATE OR REPLACE FUNCTION pds.reading_record_quiz"));
  const at = (s) => {
    const i = review.indexOf(s);
    assert.ok(i >= 0, `found: ${s}`);
    return i;
  };
  assert.ok(at("pg_advisory_xact_lock(hashtext('pds.reading_practice'))") < at("FROM pds.reading_practice_ops WHERE op_key = v_key"));
  assert.ok(at("FROM pds.reading_practice_ops WHERE op_key = v_key") < at("WHERE highlight_id = v_hid FOR UPDATE"));
  assert.ok(at("RETURN v_prior.result || jsonb_build_object('replayed', true)") < at("WHERE highlight_id = v_hid FOR UPDATE"), "a replay answers before any state check");
  assert.ok(at("'code', 'changed'") < at("INSERT INTO pds.reading_reviews"));
  assert.ok(at("'code', 'raced'") < at("INSERT INTO pds.reading_reviews"));
  assert.ok(at("INSERT INTO pds.reading_reviews") < at("UPDATE pds.book_highlights") && at("UPDATE pds.book_highlights") < at("INSERT INTO pds.reading_practice_ops"));
  assert.match(review, /v_next IS DISTINCT FROM v_date \+ v_interval/, "the stored next review must follow from the stored interval");
  const casts = review.slice(0, review.indexOf("EXCEPTION WHEN others"));
  for (const c of ["client_review_count", "'basis'->>'review_count'", "'basis'->>'ease'", "'schedule'->>'interval_days'", "'schedule'->>'next_review'"]) {
    assert.ok(casts.includes(c), `${c} is cast inside the block that answers 400 bad_request`);
  }
  const quiz = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION pds.reading_record_quiz"));
  assert.ok(quiz.indexOf("pg_advisory_xact_lock") < quiz.indexOf("INSERT INTO pds.reading_quizzes"));
  assert.ok(quiz.indexOf("v_prior.payload_hash <> v_hash") < quiz.indexOf("INSERT INTO pds.reading_quizzes"));
  for (const fn of ["reading_grade_review", "reading_record_quiz"]) {
    assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION pds\\.${fn}\\(JSONB\\) FROM PUBLIC, anon, authenticated`));
    assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION pds\\.${fn}\\(JSONB\\) TO service_role`));
  }
  assert.match(sql, /SECURITY INVOKER/);
  assert.match(sql, /REVOKE ALL ON pds\.reading_practice_ops FROM PUBLIC, anon, authenticated/);
  assert.doesNotMatch(sql, /\bGRANT\b[^;]*\bTO\b[^;]*\banon\b/i, "nothing granted to anon");
  assert.doesNotMatch(sql, /\bDROP\b/i, "additive only (the Supabase connector refuses DROP)");
  assert.doesNotMatch(sql, /\bDELETE\s+FROM\b/i, "no history is deleted or deduplicated");
  assert.doesNotMatch(sql, /ALTER TABLE[^;]*ADD COLUMN[^;]*NOT NULL/i, "new columns on existing tables are nullable");
});
