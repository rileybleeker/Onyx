// #362 review: an operation key is bound to the book its first try was stored for. After a committed request lost its
// answer, the active book can change (the session itself finished the book, or another book was started); the
// identical keyed retry WITHOUT a book must still get its stored receipt, never 409 key_reused or 404.
// Covers the three keyed writes: a reading session (logSession), a quiz result (recordQuiz) and a question answer
// (applyQuestionOp). Synthetic data only (no production database, no real titles, passages or scores).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");

const R = loadTs("lib/reading.ts");
const P = loadTs("lib/reading-practice.ts");
const Q = loadTs("lib/reading-questions.ts");
const S = loadTs("lib/reading-questions-server.ts");

let serial = 0;
const key = () => `00000000-0000-4000-8000-${String(++serial).padStart(12, "0")}`;
const TODAY = "2026-03-10";

const book = (o) => ({
  book_id: 7, slug: "synthetic-book", title: "Synthetic Book", author: null, total_chapters: 10, start_date: "2026-03-01",
  target_date: "2026-03-31", status: "reading", finished_on: null, notion_page_id: null, habit_name: null, asin: null,
  last_position: null, last_position_at: null, total_positions: null, created_at: "2026-03-01T12:00:00Z", ...o,
});
/** The book the first try was stored for, now finished, and a later one that is active now. */
const FINISHED = book({ book_id: 7, status: "finished", finished_on: "2026-03-09" });
const NEXT = book({ book_id: 8, slug: "next-synthetic-book", title: "Next Synthetic Book", created_at: "2026-03-09T20:00:00Z" });

/**
 * A table-backed fake service-role client: reads filter `tables` by their eq / neq filters, `readErrors[table]`
 * makes every read of that table fail, `rpc[name]` answers that function (a function of its args), and ANY insert /
 * update / upsert / delete is recorded as a direct write.
 */
function fakeDb({ tables = {}, readErrors = {}, rpc = {} } = {}) {
  const calls = { rpc: [], reads: [], writes: [] };
  const client = {
    rpc: async (name, args) => {
      calls.rpc.push({ name, args: structuredClone(args) });
      if (name === "behavioral_today_now") return { data: TODAY, error: null };
      return { data: rpc[name] ? rpc[name](args) : null, error: null };
    },
    from: (table) => {
      const filters = [];
      const run = () => {
        calls.reads.push({ table, filters: filters.slice() });
        if (readErrors[table]) return { data: null, error: readErrors[table] };
        const rows = (tables[table] ?? []).filter((r) =>
          filters.every(([op, k, v]) => (op === "eq" ? String(r[k]) === String(v) : String(r[k]) !== String(v))),
        );
        return { data: rows, error: null };
      };
      const q = {
        select: () => q,
        eq: (k, v) => (filters.push(["eq", k, v]), q),
        neq: (k, v) => (filters.push(["neq", k, v]), q),
        order: () => q,
        limit: () => q,
        maybeSingle: async () => {
          const r = run();
          return { data: r.data ? r.data[0] ?? null : null, error: r.error };
        },
        then: (yes, no) => Promise.resolve(run()).then(yes, no),
      };
      for (const verb of ["insert", "update", "upsert", "delete"]) {
        q[verb] = () => {
          calls.writes.push({ table, verb });
          return q;
        };
      }
      return q;
    },
  };
  return { client, calls };
}

/** Whether the code looked for "the active book" (getBook with no slug). */
const askedActiveBook = (calls) => calls.reads.some((r) => r.table === "books" && r.filters.some(([, k]) => k === "status"));

/* ------------------------------------------------------------------ */
/* Reading session (logSession, client_key)                             */
/* ------------------------------------------------------------------ */

test("session: the retry of a create that finished the book gets its stored session, not 'No active book found'", async () => {
  const K = key();
  const stored = { session_id: 41, book_id: 7, session_date: "2026-03-09", chapter_from: 9, chapter_through: 10, minutes: 30, medium: "paper", recall: null, question: null, client_key: K, source: "manual" };
  // The first try stored the last chapter and flipped the book to finished; its answer was lost. No book is active.
  const db = fakeDb({ tables: { books: [FINISHED], reading_sessions: [stored] } });
  const r = await R.logSession(db.client, { chapter_through: 10, medium: "paper", client_key: K });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.replayed, true);
  assert.equal(r.session.session_id, 41);
  assert.equal(r.book.book_id, 7, "the session's own book, read by its id");
  assert.equal(db.calls.writes.length, 0, "nothing written: no second session, habit stamp or finish");
  assert.equal(askedActiveBook(db.calls), false, "the key is looked up before any active book is resolved");
});

test("session: the same retry while another book is active still answers the stored session of the first book", async () => {
  const K = key();
  const stored = { session_id: 42, book_id: 7, session_date: "2026-03-09", chapter_from: 9, chapter_through: 10, minutes: null, medium: null, recall: null, question: null, client_key: K, source: "manual" };
  const db = fakeDb({ tables: { books: [FINISHED, NEXT], reading_sessions: [stored] } });
  const r = await R.logSession(db.client, { chapter_through: 10, client_key: K.toUpperCase() });
  assert.equal(r.ok && r.replayed, true);
  assert.equal(r.book.book_id, 7);
  assert.equal(db.calls.writes.length, 0);
});

test("session: a key with nothing stored under it still needs an active book", async () => {
  const db = fakeDb({ tables: { books: [FINISHED], reading_sessions: [] } });
  assert.deepEqual(await R.logSession(db.client, { chapter_through: 3, client_key: key() }), { ok: false, error: "No active book found" });
  assert.equal(db.calls.writes.length, 0);
});

/* ------------------------------------------------------------------ */
/* Quiz result (recordQuiz, op_key)                                     */
/* ------------------------------------------------------------------ */

/** pds.reading_record_quiz as the hash check sees it: the key's receipt was stored for book 7. */
const quizFunction = (K) => (args) =>
  args.p.op_key === K && args.p.book_id === 7
    ? { ok: true, quiz_id: 5, book_id: 7, checkpoint: "ch12", score: 4, total: 5, quiz_date: "2026-03-09", passed: true, replayed: true }
    : args.p.op_key === K
      ? { ok: false, http: 409, code: "key_reused" }
      : { ok: true, quiz_id: 6, book_id: args.p.book_id, checkpoint: args.p.checkpoint, score: args.p.score, total: args.p.total, quiz_date: TODAY, passed: true, replayed: false };

const quizReceipt = (K, kind = "quiz") => ({ op_key: K, kind, payload_hash: "0".repeat(64), result: kind === "quiz" ? { ok: true, quiz_id: 5, book_id: 7 } : { ok: true, review_id: 9, highlight_id: 41 } });

test("quiz: a keyed retry without a book uses the book its receipt was stored for, so it replays instead of key_reused", async () => {
  const K = key();
  for (const books of [[FINISHED, NEXT], [FINISHED]]) {
    const db = fakeDb({ tables: { books, reading_practice_ops: [quizReceipt(K)] }, rpc: { reading_record_quiz: quizFunction(K) } });
    const r = await R.recordQuiz(db.client, { checkpoint: "ch12", score: 4, total: 5, op_key: K });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.replayed, true);
    assert.equal(r.quiz.quiz_id, 5, "the stored attempt, not a new one");
    assert.equal(db.calls.rpc.find((c) => c.name === "reading_record_quiz").args.p.book_id, 7);
    assert.equal(askedActiveBook(db.calls), false);
    assert.equal(db.calls.writes.length, 0);
  }
});

test("quiz: no receipt under the key (or a review's) means the active book; a named book is never looked up by key", async () => {
  const fresh = key();
  const db = fakeDb({ tables: { books: [FINISHED, NEXT], reading_practice_ops: [] }, rpc: { reading_record_quiz: quizFunction(key()) } });
  const r = await R.recordQuiz(db.client, { checkpoint: "ch3", score: 3, total: 5, op_key: fresh });
  assert.equal(r.ok && r.replayed, false);
  assert.equal(db.calls.rpc.find((c) => c.name === "reading_record_quiz").args.p.book_id, 8);

  const K = key();
  const review = fakeDb({ tables: { books: [NEXT], reading_practice_ops: [quizReceipt(K, "review")] }, rpc: { reading_record_quiz: quizFunction(key()) } });
  await R.recordQuiz(review.client, { checkpoint: "ch3", score: 3, total: 5, op_key: K });
  assert.equal(review.calls.rpc.find((c) => c.name === "reading_record_quiz").args.p.book_id, 8, "a review receipt names no book; the function answers key_reused");

  const named = fakeDb({ tables: { books: [FINISHED, NEXT], reading_practice_ops: [quizReceipt(K)] }, rpc: { reading_record_quiz: quizFunction(K) } });
  await R.recordQuiz(named.client, { slug: "next-synthetic-book", checkpoint: "ch12", score: 4, total: 5, op_key: K });
  assert.equal(named.calls.reads.some((x) => x.table === "reading_practice_ops"), false, "a named book is part of the request");
  assert.equal(named.calls.rpc.find((c) => c.name === "reading_record_quiz").args.p.book_id, 8);
});

test("quiz: a failed receipt read is a failure that may have written, never a guessed active book", async () => {
  const K = key();
  const broken = fakeDb({ tables: { books: [NEXT] }, readErrors: { reading_practice_ops: { code: "XX000" } }, rpc: { reading_record_quiz: quizFunction(K) } });
  const r = await R.recordQuiz(broken.client, { checkpoint: "ch12", score: 4, total: 5, op_key: K });
  assert.deepEqual(r, { ok: false, status: 500, error: "failed" });
  assert.equal(P.failureMayHaveWritten(r), true, "the caller keeps the key and retries");
  assert.equal(broken.calls.rpc.some((c) => c.name === "reading_record_quiz"), false);
  const missing = fakeDb({ tables: { books: [NEXT] }, readErrors: { reading_practice_ops: { code: "42P01" } } });
  assert.deepEqual(await R.recordQuiz(missing.client, { checkpoint: "ch12", score: 4, total: 5, op_key: key() }), { ok: false, status: 503, error: "practice_unavailable" });
  // Without a key there is nothing to look up: the active book, one fresh key, as before.
  const keyless = fakeDb({ tables: { books: [NEXT] }, readErrors: { reading_practice_ops: { code: "XX000" } }, rpc: { reading_record_quiz: quizFunction(key()) } });
  const k = await R.recordQuiz(keyless.client, { checkpoint: "ch3", score: 3, total: 5 });
  assert.equal(k.ok, true);
  assert.equal(keyless.calls.reads.some((x) => x.table === "reading_practice_ops"), false);
});

/* ------------------------------------------------------------------ */
/* Question answer (applyQuestionOp op "answer", op_key = attempt_key)  */
/* ------------------------------------------------------------------ */

const answerBody = (o = {}) => ({
  op: "answer", op_key: key(), question_key: key(), prompt: "What does the synthetic passage claim?", rubric: null,
  source_kind: "highlight", source_ref: 41, answer: "A synthetic answer", ...o,
});

/** pds.reading_question_apply as its request hash sees it: attempt K was stored for book 7. */
const answerFunction = (K) => (args) =>
  args.p.op_key === K && args.p.book_id === 7
    ? { ok: true, attempt_key: K, question_id: 3, question_key: args.p.question_key, version: 1, source_hash: "0".repeat(64), grading_status: "pending", replayed: true }
    : args.p.op_key === K
      ? { ok: false, http: 409, code: "key_reused" }
      : { ok: true, attempt_key: args.p.op_key, question_id: 4, question_key: args.p.question_key, version: 1, source_hash: "0".repeat(64), grading_status: "pending", source_revised: false, replayed: false };

test("answer: a keyed retry without a book uses its stored attempt's book, so it replays instead of key_reused or 404", async () => {
  const op = Q.parseQuestionOp(answerBody()).op;
  for (const books of [[FINISHED, NEXT], [FINISHED]]) {
    const db = fakeDb({
      tables: { books, reading_question_attempts: [{ attempt_key: op.op_key, question_id: 3 }], reading_questions: [{ question_id: 3, book_id: 7 }] },
      rpc: { reading_question_apply: answerFunction(op.op_key) },
    });
    const r = await S.applyQuestionOp(db.client, op);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.replayed, true);
    assert.equal(r.body.attempt_key, op.op_key);
    assert.equal(db.calls.rpc[0].args.p.book_id, 7);
    assert.equal(askedActiveBook(db.calls), false);
    assert.equal(db.calls.writes.length, 0);
  }
});

test("answer: a new key uses the active book; a named book skips the key lookup; a failed lookup never guesses", async () => {
  const fresh = Q.parseQuestionOp(answerBody()).op;
  const db = fakeDb({ tables: { books: [FINISHED, NEXT], reading_question_attempts: [], reading_questions: [] }, rpc: { reading_question_apply: answerFunction(key()) } });
  const r = await S.applyQuestionOp(db.client, fresh);
  assert.equal(r.status, 200);
  assert.equal(r.body.replayed, false);
  assert.equal(db.calls.rpc[0].args.p.book_id, 8);

  const named = Q.parseQuestionOp(answerBody({ book: "next-synthetic-book" })).op;
  const n = fakeDb({ tables: { books: [FINISHED, NEXT] }, rpc: { reading_question_apply: answerFunction(key()) } });
  await S.applyQuestionOp(n.client, named);
  assert.equal(n.calls.reads.some((x) => x.table === "reading_question_attempts"), false);
  assert.equal(n.calls.rpc[0].args.p.book_id, 8);

  const nobook = fakeDb({ tables: { books: [FINISHED], reading_question_attempts: [] } });
  assert.deepEqual((await S.applyQuestionOp(nobook.client, Q.parseQuestionOp(answerBody()).op)).body, { error: "book_not_found" });

  for (const [code, status, error] of [["XX000", 500, "failed"], ["42P01", 503, "practice_unavailable"]]) {
    const broken = fakeDb({ tables: { books: [NEXT] }, readErrors: { reading_question_attempts: { code } }, rpc: { reading_question_apply: answerFunction(key()) } });
    const b = await S.applyQuestionOp(broken.client, Q.parseQuestionOp(answerBody()).op);
    assert.deepEqual({ status: b.status, body: b.body }, { status, body: { error } });
    assert.equal(broken.calls.rpc.length, 0, "no write after a failed lookup");
  }
});
