// PROD-T07: learning questions carry their permitted source + version; answers are replay-safe attempts whose
// grading is a separate step; a correction invalidates affected scores in the open. Synthetic data only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const Q = loadTs("lib/reading-questions.ts");
const S = loadTs("lib/reading-questions-server.ts");
const P = loadTs("lib/reading-practice.ts");
const R = loadTs("lib/reading.ts");
const C = loadTs("lib/client-cache.ts");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const sql = fs.readFileSync(path.join(SRC, "..", "..", "sql", "reading_learning_questions.sql"), "utf8");

let serial = 0;
const key = () => `00000000-0000-4000-8000-${String(++serial).padStart(12, "0")}`;
const answerBody = (o = {}) => ({
  op: "answer", op_key: key(), question_key: key(), prompt: "What does the synthetic passage claim?", rubric: "Synthetic rubric",
  source_kind: "highlight", source_ref: 41, answer: "  A synthetic answer  ", ...o,
});

function fakeClient({ answer = { ok: true, replayed: false }, rpcError = null, book = { book_id: 7, slug: "synthetic-book", title: "Synthetic Book" } } = {}) {
  const calls = { rpc: [], writes: [] };
  const client = {
    rpc: async (name, args) => {
      calls.rpc.push({ name, args: structuredClone(args) });
      return { data: answer, error: rpcError };
    },
    from: (table) => {
      const q = {
        select: () => q, eq: () => q, order: () => q, limit: () => q,
        then: (yes, no) => Promise.resolve({ data: book ? [book] : [], error: null }).then(yes, no),
      };
      for (const verb of ["insert", "update", "upsert", "delete"]) q[verb] = () => (calls.writes.push({ table, verb }), q);
      return q;
    },
  };
  return { client, calls };
}

test("parsing: only highlight / session / chapter sources; unknown fields, bad keys and oversize text are refused", () => {
  const ok = Q.parseQuestionOp(answerBody({ quiz_key: key(), book: "synthetic-book" }));
  assert.equal(ok.ok, true);
  assert.equal(ok.op.answer, "  A synthetic answer  ", "the answer is kept exactly as given");
  assert.equal(Q.parseQuestionOp({ op: "grade", attempt_key: key(), correct: false, grader: "model", feedback: " ok " }).op.feedback, "ok");
  assert.equal(Q.parseQuestionOp({ op: "correct", op_key: key(), question_key: key(), expected_version: 1, prompt: "Fixed synthetic prompt", source_kind: "chapter", source_ref: 3, reason: "typo" }).ok, true);
  for (const bad of [
    answerBody({ source_kind: "journal" }), answerBody({ source_kind: "email" }), answerBody({ source_ref: -1 }), answerBody({ source_ref: 1.5 }),
    answerBody({ prompt: " " }), answerBody({ prompt: "x".repeat(Q.PROMPT_MAX + 1) }), answerBody({ rubric: "x".repeat(Q.RUBRIC_MAX + 1) }),
    answerBody({ answer: "   " }), answerBody({ answer: "x".repeat(Q.ANSWER_MAX + 1) }), answerBody({ op_key: "nope" }),
    answerBody({ question_key: null }), answerBody({ quiz_key: "nope" }), answerBody({ extra: true }), answerBody({ book: "Bad Slug" }),
    { op: "grade", attempt_key: key(), correct: "yes", grader: "model" }, { op: "grade", attempt_key: key(), correct: true, grader: "someone" },
    { op: "grade", attempt_key: key(), correct: true, grader: "self", feedback: "x".repeat(Q.FEEDBACK_MAX + 1) },
    { op: "correct", op_key: key(), question_key: key(), expected_version: 0, prompt: "p", source_kind: "chapter", source_ref: 3, reason: "r" },
    { op: "correct", op_key: key(), question_key: key(), expected_version: 1, prompt: "p", source_kind: "chapter", source_ref: 3 },
    { op: "delete", op_key: key() }, null, [],
  ]) assert.equal(Q.parseQuestionOp(bad).ok, false, JSON.stringify(bad)?.slice(0, 80));
});

test("an answer is one atomic call carrying the book, the source reference and the quiz key; no direct writes", async () => {
  const f = fakeClient({ answer: { ok: true, attempt_key: "k", question_id: 3, question_key: "q", version: 1, source_hash: "0".repeat(64), grading_status: "pending", replayed: false } });
  const op = Q.parseQuestionOp(answerBody({ quiz_key: key() })).op;
  const r = await S.applyQuestionOp(f.client, op);
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  assert.equal(r.body.grading_status, "pending", "an answer is stored before, and apart from, its grading");
  assert.equal(r.body.ok, undefined);
  assert.equal(f.calls.writes.length, 0);
  assert.equal(f.calls.rpc.length, 1);
  const p = f.calls.rpc[0].args.p;
  assert.equal(f.calls.rpc[0].name, "reading_question_apply");
  assert.deepEqual(
    { kind: p.kind, op_key: p.op_key, book_id: p.book_id, source_kind: p.source_kind, source_ref: p.source_ref, quiz_key: p.quiz_key },
    { kind: "answer", op_key: op.op_key, book_id: 7, source_kind: "highlight", source_ref: 41, quiz_key: op.quiz_key },
  );
  assert.equal("source_hash" in p, false, "the source hash is computed by the database from the source row, never sent");
});

test("grading is its own call keyed by the attempt; replays and conflicts pass through as codes", async () => {
  const g = Q.parseQuestionOp({ op: "grade", attempt_key: key(), correct: true, grader: "model" }).op;
  assert.deepEqual(Q.questionRpcArgs(g, null), { kind: "grade", op_key: g.attempt_key, correct: true, grader: "model", feedback: null });
  const replay = fakeClient({ answer: { ok: true, attempt_key: g.attempt_key, grading_status: "graded", correct: true, replayed: true } });
  assert.equal((await S.applyQuestionOp(replay.client, g)).body.replayed, true);
  for (const [answer, status, error] of [
    [{ ok: false, http: 409, code: "already_graded" }, 409, "already_graded"],
    [{ ok: false, http: 409, code: "invalidated" }, 409, "invalidated"],
    [{ ok: false, http: 409, code: "key_reused" }, 409, "key_reused"],
    [{ ok: false, http: 404, code: "not_found" }, 404, "not_found"],
  ]) {
    const f = fakeClient({ answer });
    const r = await S.applyQuestionOp(f.client, g);
    assert.equal(r.status, status);
    assert.equal(r.body.error, error);
  }
  const changed = fakeClient({ answer: { ok: false, http: 409, code: "question_changed", version: 2 } });
  const r = await S.applyQuestionOp(changed.client, Q.parseQuestionOp(answerBody()).op);
  assert.deepEqual(r.body, { error: "question_changed", version: 2 });
  const missing = fakeClient({ rpcError: { code: "PGRST202" } });
  assert.deepEqual((await S.applyQuestionOp(missing.client, g)).body, { error: "practice_unavailable" });
  assert.equal(missing.calls.writes.length, 0, "no fallback write when the function is missing");
  const noBook = fakeClient({ book: null });
  const nb = await S.applyQuestionOp(noBook.client, Q.parseQuestionOp(answerBody()).op);
  assert.equal(nb.status, 404);
  assert.equal(noBook.calls.rpc.length, 0);
});

test("inspection / export is one read call; a missing function is 503, not an empty list", async () => {
  const f = fakeClient({ answer: { questions: [{ question_key: "q", version: 2, source_status: "changed" }], attempts: [] } });
  const r = await S.exportQuestions(f.client, "synthetic-book");
  assert.equal(r.status, 200);
  assert.equal(f.calls.rpc[0].name, "reading_questions_export");
  assert.deepEqual(f.calls.rpc[0].args, { p_book: 7 });
  assert.equal(r.body.questions[0].source_status, "changed");
  const missing = fakeClient({ rpcError: { code: "42883" } });
  assert.deepEqual(await S.exportQuestions(missing.client, null), { status: 503, body: { error: "practice_unavailable" } });
});

test("quiz results: legacy = unverifiable (still counted), corrected = shown but not counted; trigger codes map to 409", () => {
  assert.equal(Q.quizVerification({}), "unverified");
  assert.equal(Q.quizVerification({ question_count: null, invalidated_count: null }), "unverified");
  assert.equal(Q.quizVerification({ question_count: 5, invalidated_count: null }), "verified");
  assert.equal(Q.quizVerification({ question_count: 5, invalidated_count: 1 }), "invalidated");
  const book = { book_id: 7, slug: "synthetic-book", title: "Synthetic Book", author: null, total_chapters: 10, start_date: "2026-03-01", target_date: "2026-03-31", status: "reading", finished_on: null, notion_page_id: null, habit_name: null, asin: null, last_position: null, last_position_at: null, total_positions: null };
  const base = { book_id: 7, notes: null, quiz_date: "2026-03-05", total: 5 };
  const quizzes = [
    { ...base, quiz_id: 1, checkpoint: "ch3", score: 5, question_count: 5, invalidated_count: 1 },
    { ...base, quiz_id: 2, checkpoint: "ch7", score: 4 },
    { ...base, quiz_id: 3, checkpoint: "ch10", score: 3, question_count: 5, invalidated_count: 0 },
  ];
  const o = R.computeOverview({ book, today: "2026-03-10", sessions: [], highlights: [], reviews: [], quizzes });
  assert.equal(o.xp.quizzes, (4 + 3) * R.XP.perQuizPoint, "the corrected result earns nothing; legacy and verified count");
  assert.deepEqual(o.quizzes.map((q) => q.verification), ["invalidated", "unverified", "verified"], "every result stays listed");
  assert.equal(o.badges.find((b) => b.key === "quiz-master").earned, true, "the 4/5 legacy result still passes");
  const onlyCorrected = R.computeOverview({ book, today: "2026-03-10", sessions: [], highlights: [], reviews: [], quizzes: [quizzes[0]] });
  assert.equal(onlyCorrected.badges.find((b) => b.key === "quiz-master").earned, false, "a corrected 5/5 is not a pass");
  assert.equal(R.summarizeForChat(onlyCorrected).quizzes[0].verification, "invalidated");
  assert.deepEqual(P.rpcFailure(null, { code: "OXQ01" }), { ok: false, status: 409, error: "attempts_pending" });
  assert.deepEqual(P.rpcFailure(null, { code: "OXQ02" }), { ok: false, status: 409, error: "score_mismatch" });
  assert.deepEqual(P.rpcFailure(null, { code: "OXQ03" }), { ok: false, status: 409, error: "quiz_other_book" });
});

test("checkpoint tile: the newest result still counted wins over a newer corrected one", () => {
  const book = { book_id: 7, slug: "synthetic-book", title: "Synthetic Book", author: null, total_chapters: 10, start_date: "2026-03-01", target_date: "2026-03-31", status: "reading", finished_on: null, notion_page_id: null, habit_name: null, asin: null, last_position: null, last_position_at: null, total_positions: null };
  const base = { book_id: 7, notes: null, quiz_date: "2026-03-05", total: 5, checkpoint: "ch3" };
  // Newest first, as the overview read orders them (taken_at desc).
  const corrected = { ...base, quiz_id: 9, score: 5, question_count: 5, invalidated_count: 1 };
  const older = { ...base, quiz_id: 4, score: 4 };
  const o = R.computeOverview({ book, today: "2026-03-10", sessions: [], highlights: [], reviews: [], quizzes: [corrected, older] });
  assert.equal(o.checkpoints.find((c) => c.key === "ch3").quiz.quiz_id, 4);
  const only = R.computeOverview({ book, today: "2026-03-10", sessions: [], highlights: [], reviews: [], quizzes: [corrected] });
  assert.equal(only.checkpoints.find((c) => c.key === "ch3").quiz.verification, "invalidated", "a corrected result alone is still shown");
  const tile = read("app/reading/ReadingClient.tsx");
  assert.match(tile, /verification === "unverified" \? " · unverified"/, "an unverified score is labelled, not shown like a verified one");
});

test("SQL: one book per quiz, at answer time and when the result is recorded", () => {
  const apply = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION pds.reading_question_apply"), sql.indexOf("CREATE OR REPLACE FUNCTION pds.reading_quiz_link_attempts"));
  assert.ok(apply.indexOf("'code', 'quiz_other_book'") > 0 && apply.indexOf("'code', 'quiz_other_book'") < apply.indexOf("INSERT INTO pds.reading_question_attempts"));
  assert.match(apply, /WHERE a\.quiz_key = v_quiz AND q\.book_id <> v_book/);
  const trig = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION pds.reading_quiz_link_attempts"), sql.indexOf("CREATE OR REPLACE TRIGGER"));
  assert.match(trig, /JOIN pds\.reading_questions q ON q\.question_id = a\.question_id/);
  assert.match(trig, /count\(\*\) FILTER \(WHERE q\.book_id <> NEW\.book_id\)/);
  assert.match(trig, /ERRCODE = 'OXQ03'/);
  assert.ok(trig.indexOf("ERRCODE = 'OXQ03'") < trig.indexOf("NEW.question_count := v_total"), "refused before it is marked verified");
});

test("raw answers stay off the disk: the questions route is a memory-only cache key; the overview is unchanged", () => {
  assert.equal(C.isSensitiveKey("/api/reading/questions"), true);
  assert.equal(C.isSensitiveKey("/api/reading/questions?book=synthetic-book"), true);
  assert.equal(C.isSensitiveKey("/api/reading"), false);
  assert.equal(C.isSensitiveKey("/api/reading?book=synthetic-book"), false);
  assert.equal(C.isSensitiveKey("/api/reading/list"), false);
});

test("route: owner session only, same-origin JSON with a cap, no-store; never a CI-token route", () => {
  const src = read("app/api/reading/questions/route.ts");
  assert.match(src, /checkVoiceRequest\(req\.headers, req\.nextUrl\.origin, QUESTIONS_MAX_BODY_BYTES\)/);
  assert.equal((src.match(/"Cache-Control": "no-store"/g) || []).length >= 3, true);
  assert.doesNotMatch(src, /\.from\(|\.insert\(|\.update\(/);
  const mw = read("middleware.ts");
  const ci = mw.slice(mw.indexOf("function isCiRoute"), mw.indexOf("}", mw.indexOf("function isCiRoute")));
  assert.doesNotMatch(ci, /\/api\/reading\/questions/);
});

test("SQL: permitted sources only, hashes made by the database, lock before writes, invalidate never delete", () => {
  assert.match(sql, /source_kind\s+TEXT\s+NOT NULL CHECK \(source_kind IN \('highlight', 'session', 'chapter'\)\)/);
  const src = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION pds.reading_source_text"), sql.indexOf("CREATE OR REPLACE FUNCTION pds.reading_sha256"));
  assert.match(src, /SELECT s\.recall\s+FROM pds\.reading_sessions s/);
  assert.doesNotMatch(src, /s\.question/, "a session's question for a client is never a source");
  assert.match(src, /NOT h\.archived/);
  assert.match(src, /h\.book_id = p_book/, "a source must belong to the same book");
  const apply = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION pds.reading_question_apply"), sql.indexOf("CREATE OR REPLACE FUNCTION pds.reading_quiz_link_attempts"));
  const at = (s, from = 0) => {
    const i = apply.indexOf(s, from);
    assert.ok(i >= 0, `found: ${s}`);
    return i;
  };
  const lock = at("pg_advisory_xact_lock(hashtext('pds.reading_practice'))");
  assert.ok(lock < at("INSERT INTO pds.reading_questions") && lock < at("UPDATE pds.reading_question_attempts"));
  assert.ok(at("FROM pds.reading_question_attempts WHERE attempt_key = v_key;") < at("INSERT INTO pds.reading_question_attempts"), "replay check first");
  assert.ok(at("v_src := pds.reading_source_text(v_book, v_skind, v_sref)") < at("INSERT INTO pds.reading_questions"));
  assert.match(apply, /v_shash := pds\.reading_sha256\(v_src\)/);
  assert.match(apply, /'code', 'question_changed'/, "an edited question or source is never answered silently under the old version");
  assert.ok(at("'code', 'already_answered'") < at("INSERT INTO pds.reading_question_attempts"), "one counted answer per question per quiz");
  assert.ok(at("FROM pds.reading_question_attempts WHERE attempt_key = v_key;") < at("'code', 'already_answered'"), "a replay of the same answer is answered before that check");
  assert.match(apply, /SET grading_status = 'invalidated'/);
  assert.match(apply, /SET invalidated_count = COALESCE\(qz\.invalidated_count, 0\) \+ x\.n/);
  assert.doesNotMatch(sql, /\bDELETE\b/i, "corrections and retention never delete rows");
  const trig = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION pds.reading_quiz_link_attempts"), sql.indexOf("CREATE OR REPLACE TRIGGER"));
  assert.match(trig, /ERRCODE = 'OXQ01'/);
  assert.match(trig, /ERRCODE = 'OXQ02'/);
  assert.match(trig, /IF v_all = 0 THEN RETURN NEW; END IF;/, "a result without answers stays as before (unverifiable)");
  assert.ok(trig.indexOf("IF v_all = 0") < trig.indexOf("NEW.total <> v_total"), "answers that were all invalidated leave nothing to match: refused, not unverifiable");
  const ret = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION pds.reading_clear_question_answers"));
  assert.match(ret, /p_days < 30/);
  assert.doesNotMatch(sql, /cron\.schedule/, "retention is defined, not scheduled, by this file");
  for (const t of ["reading_questions", "reading_question_attempts"]) assert.match(sql, new RegExp(`ALTER TABLE pds\\.${t} ENABLE ROW LEVEL SECURITY`));
  assert.match(sql, /REVOKE ALL ON pds\.reading_questions, pds\.reading_question_attempts FROM PUBLIC, anon, authenticated/);
  assert.doesNotMatch(sql, /\bGRANT\b[^;]*\bTO\b[^;]*\b(anon|authenticated)\b/i, "owner access through the server only");
  assert.doesNotMatch(sql, /\bDROP\b/i);
  const alter = sql.slice(sql.indexOf("ALTER TABLE pds.reading_quizzes"), sql.indexOf(";", sql.indexOf("ALTER TABLE pds.reading_quizzes")));
  assert.doesNotMatch(alter, /NOT NULL|DEFAULT/, "columns added to the existing quiz table are nullable, no rewrite");
});
