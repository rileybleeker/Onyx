// READ-QUIZ-01 S5: the chapter map, the checkpoint quiz, XP and the Today line.
//  - lib/reading.ts: the question bank's summary in the overview (fail-open, in parallel with the book), practice XP and
//    the review/practice day union, the Reviewer badge, the chat summary's counts, checkpoint chapters and the offer;
//  - lib/reading-map.ts: the map's and the sheet's parsers, tile states, the spoiler rule on screen (narrative books
//    hide locked titles, no statement before an idea was asked), header numbers, the quiz result's request and answers;
//  - lib/reading-checkpoint.ts + lib/reading-checkpoint-server.ts + sql/reading_bank_checkpoint.sql: which ideas a
//    checkpoint quiz asks (one per idea, half from the latest act, the 7-day rest, explain questions, resume);
//  - the real components under the hook harness: the chapter map, the sheet, the quiz host, and the practice runner in
//    checkpoint mode (answers carry the quiz key, no Skip, no Again, Done waits for every grade and records once).
// Offline and synthetic: an invented book ("The Lighthouse Ledger"), invented chapters, ideas and answers; fake
// fetch and fake database; no network, no storage.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { createClient } = require("@supabase/supabase-js");
const { loadTs } = require("./helpers/load-ts.cjs");
const { mountClient, response, withGlobals } = require("./helpers/hook-harness.cjs");

const R = loadTs("lib/reading.ts");
const M = loadTs("lib/reading-map.ts");
const K = loadTs("lib/reading-checkpoint.ts");
const RC = loadTs("lib/reading-recall.ts");
const C = loadTs("lib/reading-practice-client.ts");

const TODAY = "2026-03-10";
const SLUG = "lighthouse-ledger";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPO = path.join(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");
const addDays = (d, n) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

/* ------------------------------------------------------------------ */
/* Fixtures                                                             */
/* ------------------------------------------------------------------ */

const book = {
  book_id: 7,
  slug: SLUG,
  title: "The Lighthouse Ledger",
  author: "A. Writer",
  total_chapters: 20,
  start_date: "2026-03-01",
  target_date: "2026-03-31",
  status: "reading",
  finished_on: null,
  notion_page_id: null,
  habit_name: null,
  asin: null,
  last_position: null,
  last_position_at: null,
  total_positions: null,
};

/** What pds.reading_bank_summary answers. */
const summaryRaw = (o = {}) => ({
  book_id: 7,
  today: TODAY,
  enabled: true,
  paused_reason: null,
  approved_cents: 1900,
  spent_cents: 420,
  mapping: "ok",
  quiz_through: 13,
  due: 5,
  new_ready: 6,
  stages: { new: 20, seen: 10, recalled: 8, explained: 4, kept: 2 },
  chapters: [
    { chapter: 1, status: "ready", ideas: 8, questions: 20, sources: 6 },
    { chapter: 2, status: "thin", ideas: 3, questions: 8, sources: 2 },
  ],
  xp: { correct: 5, partial: 3 },
  practice_days: ["2026-03-08", "2026-03-09"],
  voided: 1,
  pending: 2,
  recall_7d: { n: 23, right: 18 },
  recall_21d: { n: 10, right: 7 },
  ...o,
});

const overview = (practice, extra = {}) => R.computeOverview({ book, today: TODAY, sessions: [], highlights: [], reviews: [], quizzes: [], practice, ...extra });
const review = (id, day) => ({ review_id: id, highlight_id: 1, review_date: day, grade: "good" });

/* ------------------------------------------------------------------ */
/* lib/reading.ts: the summary, XP, badges, chat, checkpoints           */
/* ------------------------------------------------------------------ */

test("practice XP and the review-day union: a review and a practice on one day are one day; the numbers equal the client's", () => {
  const p = R.parsePracticeSummary(summaryRaw());
  const o = overview(p, { reviews: [review(1, "2026-03-08")] });
  assert.equal(R.XP.perPracticeCorrect, 2);
  assert.equal(R.XP.perPracticePartial, 1);
  assert.deepEqual({ ...C.PRACTICE_XP }, { correct: R.XP.perPracticeCorrect, partial: R.XP.perPracticePartial }, "the runner's summary and the overview agree");
  assert.equal(o.xp.practice, 5 * 2 + 3 * 1);
  assert.equal(o.xp.reviews, 2 * R.XP.perReviewDay, "03-08 has a review and a practice: one day, not two; 03-09 is the second");
  assert.equal(o.xp.total, o.xp.reviews + o.xp.practice, "nothing else was earned");
  const none = overview(null, { reviews: [review(1, "2026-03-08")] });
  assert.equal(none.practice, null, "no summary: no practice block");
  assert.equal(none.xp.practice, 0);
  assert.equal(none.xp.reviews, R.XP.perReviewDay);
});

test("the Reviewer badge counts practice days with review days (5 different days)", () => {
  const p = R.parsePracticeSummary(summaryRaw({ practice_days: ["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05"] }));
  const reviews = [review(1, "2026-03-01"), review(2, "2026-03-02")];
  const badge = (o) => o.badges.find((b) => b.key === "reviewer");
  assert.equal(badge(overview(p, { reviews })).earned, true);
  assert.equal(badge(overview(p, { reviews })).earnedOn, "2026-03-05", "the fifth distinct day of the union");
  assert.equal(badge(overview(null, { reviews })).earned, false, "two review days alone are not five");
  assert.equal(badge(overview(null, { reviews })).description, "Practice on 5 different days");
  assert.equal(overview(p).badges.length, 10, "no new badge");
});

test("a checkpoint quiz passed at 80% still earns Quiz Master through the same quiz rows; an invalidated one does not", () => {
  const quiz = { quiz_id: 1, book_id: 7, checkpoint: "ch6", score: 9, total: 10, notes: null, quiz_date: TODAY, question_count: 10, invalidated_count: 0 };
  const earned = (o) => o.badges.find((b) => b.key === "quiz-master").earned;
  assert.equal(earned(overview(null, { quizzes: [quiz] })), true);
  assert.equal(earned(overview(null, { quizzes: [{ ...quiz, invalidated_count: 2 }] })), false);
});

test("parsePracticeSummary: not an answer is null; counts are whole numbers >= 0; days are days", () => {
  assert.equal(R.parsePracticeSummary(null), null);
  assert.equal(R.parsePracticeSummary("2026-03-10"), null);
  assert.equal(R.parsePracticeSummary({ error: "x" }), null);
  assert.equal(R.parsePracticeSummary([]), null);
  const bad = R.parsePracticeSummary(
    summaryRaw({ due: -3, new_ready: "x", xp: { correct: -1, partial: 2.9 }, practice_days: ["2026-03-08", "nope", 5, "2026-03-08"], recall_7d: { n: 2, right: 9 }, paused_reason: "other", mapping: "odd" }),
  );
  assert.equal(bad.due, 0);
  assert.equal(bad.newReady, 0);
  assert.deepEqual(bad.counted, { correct: 0, partial: 2 });
  assert.deepEqual(bad.days, ["2026-03-08"]);
  assert.deepEqual(bad.recall7d, { n: 2, right: 2 }, "right never exceeds n");
  assert.equal(bad.pausedReason, null);
  assert.equal(bad.mapping, "unknown");
  const ok = R.parsePracticeSummary(summaryRaw({ paused_reason: "budget" }));
  assert.equal(ok.enabled, true);
  assert.equal(ok.pausedReason, "budget");
  assert.equal(ok.chapters.length, 2);
  assert.equal(ok.quizThrough, 13);
});

test("practiceReady: due plus new ideas, at most a round, 0 while the bank is off (Today shows no line)", () => {
  assert.equal(R.practiceReady(R.parsePracticeSummary(summaryRaw({ due: 2, new_ready: 3 }))), 5);
  assert.equal(R.practiceReady(R.parsePracticeSummary(summaryRaw({ due: 20, new_ready: 30 }))), 8, "a backlog never makes the round longer");
  assert.equal(R.practiceReady(R.parsePracticeSummary(summaryRaw({ enabled: false }))), 0);
  assert.equal(R.practiceReady(null), 0);
  assert.equal(R.practiceReady(undefined), 0);
  const today = read("frontend/src/app/today/TodayClient.tsx");
  assert.match(today, /book\?\.practice\?\.enabled/, "Today reads the overview's own summary");
  assert.match(today, /Practice · <span className="font-mono">\{practiceReady\}<\/span> ready/);
  assert.match(today, /href="\/reading"[^>]*>Practice/, "the line links to /reading");
  assert.doesNotMatch(today, /\/api\/reading\/(practice|bank)/, "no new request on Today");
});

test("summarizeForChat carries the practice counts only, and null while the bank is off", () => {
  const on = R.summarizeForChat(overview(R.parsePracticeSummary(summaryRaw())));
  assert.deepEqual(Object.keys(on.practice).sort(), ["due", "new_ready", "quiz_through", "recall_21d", "recall_7d", "stages"]);
  assert.equal(on.practice.due, 5);
  assert.deepEqual(on.practice.recall_7d, { n: 23, right: 18 });
  assert.doesNotMatch(JSON.stringify(on.practice), /xp|days|chapters|spent|approved/);
  assert.equal(R.summarizeForChat(overview(null)).practice, null);
  assert.equal(R.summarizeForChat(overview(R.parsePracticeSummary(summaryRaw({ enabled: false })))).practice, null);
});

/** A PostgREST stand-in for getOverview (the same approach as tests/read-contracts.test.cjs). */
function fakeSupabase(respond) {
  const requests = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    requests.push({ url: u, method: init.method || "GET", body: init.body ? String(init.body) : null });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    const [status, body] = respond(u);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  const client = createClient("https://db.example.test", "anon-test-key", { db: { schema: "pds" }, global: { fetch }, auth: { persistSession: false } });
  return { client, requests, maxInFlight: () => maxInFlight };
}
const bookRow = { ...book, created_at: "2026-03-01T00:00:00Z", reading_sessions: [], book_highlights: [], reading_quizzes: [], book_chapters: [] };
const routes = (summary) => (u) => {
  if (u.pathname === "/rest/v1/rpc/behavioral_today_now") return [200, TODAY];
  if (u.pathname === "/rest/v1/rpc/reading_bank_summary") return summary;
  if (u.pathname === "/rest/v1/books") return [200, [bookRow]];
  return [404, { message: `unexpected ${u.pathname}` }];
};

test("getOverview: the summary is one RPC in parallel with the book and today, named by the same slug rule", async () => {
  const db = fakeSupabase(routes([200, summaryRaw()]));
  const o = await R.getOverview(db.client, SLUG);
  assert.equal(o.practice.enabled, true);
  assert.equal(o.practice.quizThrough, 13);
  assert.equal(db.requests.length, 3, "the book, today, the summary: no extra round trip");
  assert.equal(db.maxInFlight(), 3, "all three in flight together");
  const rpc = db.requests.find((r) => r.url.pathname.endsWith("/reading_bank_summary"));
  assert.equal(rpc.method, "POST");
  assert.deepEqual(JSON.parse(rpc.body), { p_slug: SLUG });
  const dflt = fakeSupabase(routes([200, summaryRaw()]));
  await R.getOverview(dflt.client);
  assert.deepEqual(JSON.parse(dflt.requests.find((r) => r.url.pathname.endsWith("/reading_bank_summary")).body), { p_slug: null }, "no slug: the active book, resolved by the database");
});

test("getOverview fails open: a missing function, an error or a malformed answer is no summary, never an error", async () => {
  for (const [name, answer] of [
    ["missing function", [404, { code: "PGRST202", message: "Could not find the function" }]],
    ["42883", [404, { code: "42883", message: "function does not exist" }]],
    ["server error", [500, { code: "XX000", message: "boom" }]],
    ["not an object", [200, "garbage"]],
    ["no book", [200, null]],
  ]) {
    const db = fakeSupabase(routes(answer));
    const o = await R.getOverview(db.client, SLUG);
    assert.ok(o, `${name}: the overview still comes`);
    assert.equal(o.practice, null, `${name}: no practice block`);
    assert.equal(o.book.slug, SLUG);
  }
});

test("checkpoints: the chapters, the acts and the offer of the in-app quiz", () => {
  assert.deepEqual(R.checkpointChapters(20), [6, 13, 20]);
  assert.deepEqual(R.checkpointChapters(40), [12, 26, 40]);
  assert.deepEqual(R.checkpointChapters(0), []);
  assert.equal(R.checkpointKey(13), "ch13");
  assert.equal(R.checkpointActStart(20, 6), 1);
  assert.equal(R.checkpointActStart(20, 13), 7);
  assert.equal(R.checkpointActStart(20, 20), 14);
  assert.equal(R.CHECKPOINT_SIZE, 10);
  assert.equal(R.CHECKPOINT_PASS, 0.8);
  assert.deepEqual(overview(null).checkpoints.map((c) => [c.key, c.chapter]), [["ch6", 6], ["ch13", 13], ["ch20", 20]]);

  const chapters = (n, ideas) => Array.from({ length: n }, (_, i) => ({ chapter: i + 1, status: "ready", ideas, questions: 5, sources: 3 }));
  const rich = overview(R.parsePracticeSummary(summaryRaw({ quiz_through: 13, chapters: chapters(7, 2) })));
  const [c6, c13, c20] = rich.checkpoints;
  assert.equal(R.checkpointOffer(rich, c6), true, "quizzable and 12 ideas up to it");
  assert.equal(R.checkpointOffer(rich, c13), true, "14 ideas up to ch 13");
  assert.equal(R.checkpointOffer(rich, c20), false, "not quizzable yet");
  const thin = overview(R.parsePracticeSummary(summaryRaw({ quiz_through: 13, chapters: chapters(6, 1) })));
  assert.equal(R.checkpointOffer(thin, thin.checkpoints[0]), false, "6 ideas are fewer than a quiz");
  const off = overview(R.parsePracticeSummary(summaryRaw({ enabled: false, quiz_through: 13, chapters: chapters(7, 2) })));
  assert.equal(R.checkpointOffer(off, off.checkpoints[0]), false, "the bank is off");
  assert.equal(R.checkpointOffer(overview(null), overview(null).checkpoints[0]), false, "no summary, no offer");
  const quiz = (o) => ({ quiz_id: 1, book_id: 7, checkpoint: "ch6", score: 9, total: 10, notes: null, quiz_date: "2026-03-01", verification: "verified", ...o });
  assert.equal(R.checkpointOffer(rich, { ...c6, quiz: quiz({}) }), false, "passed: done");
  assert.equal(R.checkpointOffer(rich, { ...c6, quiz: quiz({ score: 5 }) }), true, "failed on an earlier day: again");
  assert.equal(R.checkpointOffer(rich, { ...c6, quiz: quiz({ score: 5, quiz_date: TODAY }) }), false, "recorded today: the quiz key is one per day");
  assert.equal(R.checkpointOffer(rich, { ...c6, quiz: quiz({ verification: "invalidated" }) }), true, "a corrected result does not close the checkpoint");
});

/* ------------------------------------------------------------------ */
/* lib/reading-map.ts                                                   */
/* ------------------------------------------------------------------ */

const chap = (n, o = {}) => ({ chapter: n, title: `Harbour ${n}`, locked: false, status: "ready", ideas: 8, recalled: 0, covered: false, needs_review: false, sources: 4, ...o });
const FLAG_KEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const bankRaw = (chapters, o = {}) => ({
  book_id: 7,
  enabled: true,
  paused_reason: null,
  approved_cents: 1900,
  spent_cents: 100,
  quiz_through: 6,
  total_chapters: chapters.length,
  mapping: "ok",
  narrative: false,
  hold_chapter: null,
  hold_flag_key: null,
  chapters,
  estimate: { book_cents: 1500, remaining_cents: 1200, cap_cents: 1900, per_chapter_cents: 40 },
  ...o,
});

test("tile states: locked, building, failed, few sources, progress in four steps, covered, needs review", () => {
  const st = (o) => M.tileState(M.parseMap(bankRaw([chap(1, o)])).chapters[0]);
  assert.deepEqual(st({}), { kind: "progress", step: 0, recalled: 0, ideas: 8 });
  assert.equal(st({ recalled: 2 }).step, 1, "a quarter");
  assert.equal(st({ recalled: 3 }).step, 2);
  assert.equal(st({ recalled: 4 }).step, 2, "a half");
  assert.equal(st({ recalled: 5 }).step, 3);
  assert.equal(st({ recalled: 6 }).step, 3, "three quarters");
  assert.equal(st({ recalled: 7 }).step, 4);
  assert.equal(st({ recalled: 8 }).step, 4, "all recalled but not every core idea explained: still in progress");
  assert.equal(st({ recalled: 8, covered: true }).kind, "covered");
  assert.equal(st({ recalled: 8, covered: true, needs_review: true }).kind, "review", "two or more lapses in 7 days beat covered");
  assert.deepEqual(st({ status: "pending", ideas: 0, recalled: 0 }), { kind: "building", failed: false });
  assert.deepEqual(st({ status: "failed", ideas: 0, recalled: 0 }), { kind: "building", failed: true });
  assert.equal(st({ status: "thin", ideas: 3, recalled: 0 }).kind, "few");
  assert.equal(st({ status: "no_sources", ideas: 0, recalled: 0 }).kind, "few");
  assert.equal(st({ status: "thin", ideas: 3, recalled: 1 }).kind, "progress", "a thin chapter keeps its progress once something was recalled");
  assert.equal(st({ locked: true, ideas: 5, recalled: 5, covered: true }).kind, "locked", "locked first");
  const locked = M.parseMap(bankRaw([chap(1, { locked: true, ideas: 5, recalled: 5, covered: true, needs_review: true, sources: 3 })])).chapters[0];
  assert.deepEqual([locked.ideas, locked.recalled, locked.covered, locked.needsReview, locked.sources], [null, null, null, null, null], "nothing about a locked chapter is read");
  for (const kind of ["locked", "building", "few", "progress", "covered", "review"]) assert.ok(M.TILE_WORD[kind], `${kind} has a word, not only a color`);
});

test("the spoiler rule on screen: a narrative book hides locked titles, a nonfiction book shows them", () => {
  const rows = [chap(1), chap(2, { locked: true, title: "A secret harbour", ideas: null, recalled: null, covered: null, needs_review: null, sources: null })];
  const narrative = M.parseMap(bankRaw(rows, { narrative: true, quiz_through: 1 }));
  assert.equal(narrative.chapters[1].title, null, "even when the server sent one");
  assert.equal(M.chapterLabel(narrative.chapters[1], true), "Ch 2");
  assert.equal(M.chapterLabel(narrative.chapters[0], true), "Ch 1 · Harbour 1", "an unlocked chapter of a narrative book shows its title");
  assert.equal(M.tileTitle({ ...narrative.chapters[1], title: "X" }, true), null);
  const plain = M.parseMap(bankRaw(rows, { narrative: false, quiz_through: 1 }));
  assert.equal(plain.chapters[1].title, "A secret harbour", "a nonfiction book's titles are its own Kindle contents");
  assert.equal(M.chapterLabel(plain.chapters[1], false), "Ch 2 · A secret harbour");
});

test("parseMap: not a map is null; chapters sorted; the hold, the estimate and the signature", () => {
  assert.equal(M.parseMap(null), null);
  assert.equal(M.parseMap({ error: "x" }), null);
  assert.equal(M.parseMap({ book_id: "7" }), null);
  const m = M.parseMap(bankRaw([chap(3), chap(1), { chapter: 0, title: "Whole book" }, chap(2)], { hold_chapter: 4, hold_flag_key: FLAG_KEY.toUpperCase(), paused_reason: "budget" }));
  assert.deepEqual(m.chapters.map((c) => c.chapter), [1, 2, 3], "chapter 0 is not a tile");
  assert.equal(m.holdChapter, 4);
  assert.equal(m.holdFlagKey, FLAG_KEY);
  assert.equal(m.pausedReason, "budget");
  assert.equal(m.perChapterCents, 40);
  assert.equal(M.parseMap(bankRaw([chap(1)], { hold_flag_key: "not-a-key" })).holdFlagKey, null);
  assert.equal(M.parseMap({ ...bankRaw([chap(1)]), estimate: undefined }).perChapterCents, null);
  const a = R.parsePracticeSummary(summaryRaw());
  const b = R.parsePracticeSummary(summaryRaw({ stages: { new: 20, seen: 10, recalled: 9, explained: 4, kept: 2 } }));
  assert.notEqual(M.mapSignature(a), M.mapSignature(b), "a stage that moved makes the map read again");
  assert.equal(M.mapSignature(a), M.mapSignature(R.parsePracticeSummary(summaryRaw())));
  assert.equal(M.mapSignature(null), "-");
});

test("the map's header: recalled of all ideas, Kept, and the 7- and 21-day recall with their n", () => {
  const m = M.parseMap(bankRaw([chap(1, { ideas: 10, recalled: 4 }), chap(2, { ideas: 6, recalled: 6 }), chap(3, { locked: true })], { quiz_through: 2 }));
  const p = R.parsePracticeSummary(summaryRaw());
  const h = M.mapHeader(m, p);
  assert.deepEqual([h.recalled, h.ideas, h.kept], [10, 16, 2], "a locked chapter is not counted");
  assert.deepEqual(h.recall7, { n: 23, pct: 78 });
  assert.deepEqual(h.recall21, { n: 10, pct: 70 });
  assert.equal(M.recallLine(7, h.recall7), "7-day recall 78% (n 23)");
  assert.equal(M.recallLine(21, h.recall21), "21-day recall 70% (n 10)");
  assert.equal(M.recallLine(7, { n: 0, pct: null }), "7-day recall · none yet");
  assert.deepEqual(M.mapHeader(m, null).recall7, { n: 0, pct: null });
});

test("the sheet: a statement shows only after the idea was asked; flags keep valid kinds only", () => {
  const s = M.parseSheet({
    chapter: 6,
    title: "Harbour 6",
    status: "ready",
    built_at: "2026-03-09T15:00:00Z",
    prompt_version: "bank-test.1",
    rebuilds: 1,
    ideas: [
      { idea_id: 1, title: "Idea one", importance: "core", stage: 0, statement: "Never shown yet.", sources: 2 },
      { idea_id: 2, title: "Idea two", importance: "supporting", stage: 2, statement: "Shown once asked.", sources: 1 },
      { idea_id: 3, title: "Idea three", importance: "detail", stage: 9, statement: "", sources: -1 },
      { title: "no id" },
    ],
    flags: [
      { flag_key: FLAG_KEY, kind: "unclear", prompt: "Synthetic question?", created_at: "2026-03-09T16:00:00Z" },
      { flag_key: "nope", kind: "wrong", prompt: "x" },
      { flag_key: FLAG_KEY, kind: "other", prompt: "x" },
    ],
  });
  assert.equal(s.ideas.length, 3);
  assert.equal(s.ideas[0].statement, null, "a new idea shows no statement, even when one was sent");
  assert.equal(s.ideas[1].statement, "Shown once asked.");
  assert.deepEqual([s.ideas[2].stage, s.ideas[2].sources, s.ideas[2].statement], [4, 0, null]);
  assert.equal(s.flags.length, 1);
  assert.equal(s.flags[0].kind, "unclear");
  assert.deepEqual(M.sheetRecalled(s), { recalled: 1, ideas: 2 }, "detail ideas never count toward the chapter's percentage");
  assert.equal(M.parseSheet(null), null);
  assert.equal(M.parseSheet({ error: "locked" }), null);
  assert.equal(M.builtDate("2026-03-09T15:00:00Z"), "Mar 9");
  assert.equal(M.builtDate(null), null);
  assert.equal(M.dollars(40), "$0.40");
  assert.equal(M.stageWord(3), "Explained");
  assert.equal(M.sheetUrl(SLUG, 6), `/api/reading/bank/chapter/6?book=${SLUG}`);
  assert.equal(M.chapterRoundUrl(SLUG, 6), `/api/reading/practice/today?book=${SLUG}&kind=chapter&chapter=6`);
  assert.equal(M.checkpointUrl(SLUG, 13), `/api/reading/practice/checkpoint?book=${SLUG}&chapter=13`);
});

test("the quiz result: the request, and what each answer means", () => {
  const key = K.checkpointQuizKey(7, TODAY, 6);
  assert.deepEqual(M.quizRequest(SLUG, "ch6", key, 8, 10), { book: SLUG, checkpoint: "ch6", score: 8, total: 10, op_key: key });
  assert.equal(M.passed(8, 10), true);
  assert.equal(M.passed(7, 10), false);
  assert.equal(M.passed(0, 0), false);
  const saved = M.classifyQuizAnswer(200, { success: true, quiz: { quiz_id: 1 }, passed: true, xp_gained: 80, op_key: key, replayed: false });
  assert.deepEqual(saved, { kind: "saved", passed: true, xp: 80, replayed: false });
  assert.equal(M.classifyQuizAnswer(200, { success: true, quiz: { quiz_id: 1 }, passed: false, xp_gained: 50, replayed: true }).replayed, true);
  assert.equal(M.classifyQuizAnswer(null, null).kind, "unknown");
  assert.equal(M.classifyQuizAnswer(200, { success: false }).kind, "unknown", "no confirmation: it may be stored");
  assert.equal(M.classifyQuizAnswer(500, { error: "x" }).kind, "unknown");
  assert.equal(M.classifyQuizAnswer(409, { error: "key_reused" }).kind, "refused");
  assert.equal(M.classifyQuizAnswer(400, { error: "bad_score" }).kind, "refused");
  assert.equal(M.checkpointRefusal(409, { error: "locked" }).kind, "locked");
  assert.equal(M.checkpointRefusal(503, { error: "bank_unavailable" }).kind, "off");
  assert.equal(M.checkpointRefusal(null, null).kind, "failed");
  assert.equal(M.classifyRunAnswer(202).ok, true);
  assert.equal(M.classifyRunAnswer(409).ok, false);
});

/* ------------------------------------------------------------------ */
/* The checkpoint quiz's selection                                      */
/* ------------------------------------------------------------------ */

const pIdea = (idea_id, chapter, importance, o = {}) => ({ idea_id, chapter, importance, stage: 0, last_reviewed: null, has_explain: true, ...o });
const baseIdeas = () => {
  const ideas = [];
  for (let ch = 1; ch <= 13; ch++) ideas.push(pIdea(ch * 10 + 1, ch, "core"), pIdea(ch * 10 + 2, ch, "core"), pIdea(ch * 10 + 3, ch, "supporting"));
  ideas.push(pIdea(901, 4, "detail"));
  return ideas;
};
const poolRaw = (o = {}) => ({ book_id: 7, today: TODAY, quiz_through: 13, chapter: 13, enabled: true, ideas: baseIdeas(), answered_today: [], ...o });
const answerRow = (idea_id, o = {}) => ({
  attempt_key: `00000000-0000-4000-8000-${String(idea_id).padStart(12, "0")}`,
  question_id: idea_id * 10 + 1,
  idea_id,
  covers: null,
  round_key: K.checkpointRoundKey(7, TODAY, 13),
  round_kind: "checkpoint",
  verdict: "correct",
  grading_status: "graded",
  ...o,
});
const ids = (sel) => sel.picked.map((i) => i.idea_id).sort((a, b) => a - b);

test("the keys: one round and one quiz key per book, day and checkpoint; the round key is not the daily one", () => {
  const round = K.checkpointRoundKey(7, TODAY, 13);
  assert.equal(round, RC.roundKey(7, TODAY, "checkpoint", 13));
  assert.notEqual(round, RC.roundKey(7, TODAY, "daily", 0));
  assert.notEqual(round, K.checkpointRoundKey(7, TODAY, 6));
  const quiz = K.checkpointQuizKey(7, TODAY, 13);
  assert.match(quiz, UUID_RE);
  assert.equal(quiz, K.checkpointQuizKey(7, TODAY, 13), "deterministic: a retried Done sends the same op_key");
  assert.notEqual(quiz, K.checkpointQuizKey(7, addDays(TODAY, 1), 13), "the next day is a new quiz");
  assert.notEqual(quiz, K.checkpointQuizKey(7, TODAY, 6));
  assert.notEqual(quiz, round);
});

test("selection: 10 ideas, one each, core before supporting, never detail, at least half from the latest act, deterministic", () => {
  const pool = K.parsePool(poolRaw());
  const sel = K.selectCheckpointIdeas(pool, { actFrom: 7 });
  assert.equal(sel.picked.length, 10);
  assert.equal(new Set(sel.picked.map((i) => i.idea_id)).size, 10, "one question per idea");
  assert.ok(sel.picked.every((i) => i.importance === "core"), "26 core ideas are enough: no supporting or detail one is asked");
  assert.ok(sel.picked.filter((i) => i.chapter >= 7).length >= 5, "at least half from the latest act");
  assert.ok(sel.picked.every((i) => i.chapter >= 1 && i.chapter <= 13));
  assert.equal(sel.eligible, 39, "13 chapters of 3 ideas; the detail idea is not a candidate");
  assert.equal(sel.ready, true);
  assert.deepEqual(ids(K.selectCheckpointIdeas(pool, { actFrom: 7 })), ids(sel), "the same pool and day give the same quiz");
  // The chapters after the checkpoint are never asked, even when the pool carries them.
  const wide = K.parsePool(poolRaw({ ideas: [...baseIdeas(), pIdea(991, 14, "core"), pIdea(992, 15, "core")] }));
  assert.ok(!K.selectCheckpointIdeas(wide, { actFrom: 7 }).picked.some((i) => i.chapter > 13));
});

test("selection: half comes from the latest act even when earlier ideas rank better", () => {
  const ideas = [];
  for (let ch = 1; ch <= 13; ch++) {
    ideas.push(pIdea(ch * 10 + 1, ch, ch >= 7 ? "supporting" : "core"), pIdea(ch * 10 + 2, ch, ch >= 7 ? "supporting" : "core"));
  }
  const sel = K.selectCheckpointIdeas(K.parsePool(poolRaw({ ideas })), { actFrom: 7 });
  assert.equal(sel.picked.length, 10);
  assert.equal(sel.picked.filter((i) => i.chapter >= 7).length, 5, "exactly half from the latest act, the rest the best of the earlier ones");
  assert.equal(sel.picked.filter((i) => i.chapter < 7 && i.importance === "core").length, 5);
});

test("selection: an idea answered less than 7 days ago rests; one answered 7 days ago may be asked", () => {
  const first = K.selectCheckpointIdeas(K.parsePool(poolRaw()), { actFrom: 7 });
  const firstIds = new Set(first.picked.map((i) => i.idea_id));
  const rested = baseIdeas().map((i) => (firstIds.has(i.idea_id) ? { ...i, last_reviewed: addDays(TODAY, -6) } : i));
  const second = K.selectCheckpointIdeas(K.parsePool(poolRaw({ ideas: rested })), { actFrom: 7 });
  assert.equal(second.picked.length, 10);
  assert.equal(second.picked.filter((i) => firstIds.has(i.idea_id)).length, 0, "none of the ideas answered 6 days ago");
  assert.equal(second.eligible, 39 - 10);
  const ready = baseIdeas().map((i) => (firstIds.has(i.idea_id) ? { ...i, last_reviewed: addDays(TODAY, -7) } : i));
  assert.deepEqual(ids(K.selectCheckpointIdeas(K.parsePool(poolRaw({ ideas: ready })), { actFrom: 7 })), ids(first), "7 days ago is quiet enough");
});

test("selection: fewer than 10 ideas is not a quiz, unless one was already started", () => {
  const few = baseIdeas().slice(0, 6);
  const sel = K.selectCheckpointIdeas(K.parsePool(poolRaw({ ideas: few })), { actFrom: 7 });
  assert.deepEqual([sel.eligible, sel.ready], [6, false]);
  const started = K.selectCheckpointIdeas(K.parsePool(poolRaw({ ideas: few, answered_today: [answerRow(11)] })), { actFrom: 7 });
  assert.equal(started.ready, true, "a quiz that was started is resumed whatever the pool says");
  assert.equal(started.done.size, 1);
});

test("selection resumes: the ideas answered in this quiz stay, the others are the same, and an answer elsewhere is not this quiz", () => {
  const first = K.selectCheckpointIdeas(K.parsePool(poolRaw()), { actFrom: 7 });
  const answered = first.picked.slice(0, 4).map((i) => i.idea_id);
  const ideas = baseIdeas().map((i) => (answered.includes(i.idea_id) ? { ...i, last_reviewed: TODAY } : i));
  const resumed = K.selectCheckpointIdeas(K.parsePool(poolRaw({ ideas, answered_today: answered.map((id) => answerRow(id)) })), { actFrom: 7 });
  assert.deepEqual(ids(resumed), ids(first), "answering moved nothing else");
  assert.equal(resumed.done.size, 4);
  // An idea answered in this quiz that the choice would not have made takes the place of an unanswered one.
  const outside = baseIdeas().find((i) => !first.picked.some((p) => p.idea_id === i.idea_id) && i.importance === "core").idea_id;
  const moved = K.selectCheckpointIdeas(
    K.parsePool(poolRaw({ ideas: baseIdeas().map((i) => (i.idea_id === outside ? { ...i, last_reviewed: TODAY } : i)), answered_today: [answerRow(outside)] })),
    { actFrom: 7 },
  );
  assert.equal(moved.picked.length, 10);
  assert.ok(moved.picked.some((i) => i.idea_id === outside), "the answered idea is kept");
  // An idea answered in the daily round today (another round key) and rested since is not this quiz's.
  const elsewhere = K.selectCheckpointIdeas(
    K.parsePool(poolRaw({ ideas: baseIdeas().map((i) => (i.idea_id === 11 ? { ...i, last_reviewed: TODAY } : i)), answered_today: [answerRow(11, { round_key: RC.roundKey(7, TODAY, "daily", 0), round_kind: "daily" })] })),
    { actFrom: 7 },
  );
  assert.equal(elsewhere.done.size, 0);
  assert.ok(!elsewhere.picked.some((i) => i.idea_id === 11), "answered today elsewhere: it rests");
  // A voided answer is no answer.
  assert.equal(K.selectCheckpointIdeas(K.parsePool(poolRaw({ answered_today: [answerRow(11, { grading_status: "invalidated" })] })), { actFrom: 7 }).done.size, 0);
});

const rubric = (n) => ({ v: 1, format: "cued", answer: `alpha ${n}`, accept: [], options: [`alpha ${n}`, "beta", "gamma", "delta"], correct: 0, explanation: "Synthetic explanation." });
const explainRubric = { v: 1, format: "explain", points: [{ id: "p1", text: "Synthetic point", must: true }], explanation: "Synthetic explanation." };
const q = (id, format, r) => ({ question_id: id, version: 1, format, prompt: `Synthetic prompt ${id}?`, rubric: r });
const deckIdea = (p, withExplain = true) => ({
  idea_id: p.idea_id,
  chapter: p.chapter,
  importance: p.importance,
  kind: "concept",
  title: `Synthetic idea ${p.idea_id}`,
  statement: "Synthetic statement.",
  key_points: ["Synthetic key point"],
  stage: 0,
  next_review: null,
  state_version: 0,
  dirty: false,
  last_question_ids: [],
  last_verdict: null,
  ease: 2.5,
  interval_days: 0,
  review_count: 0,
  lapses: 0,
  stage_success_on: null,
  last_reviewed: null,
  why: ["checkpoint"],
  questions: [q(p.idea_id * 10 + 1, "cued", rubric(p.idea_id)), ...(withExplain ? [q(p.idea_id * 10 + 2, "explain", explainRubric)] : [])],
  sources: [],
});

test("cards: at least 3 explain questions, one card per idea, an answered idea keeps the question it was answered with", () => {
  const pool = K.parsePool(poolRaw());
  const sel = K.selectCheckpointIdeas(pool, { actFrom: 7 });
  const cards = K.buildCheckpointCards(sel, sel.picked.map((p) => deckIdea(p)), TODAY);
  assert.equal(cards.length, 10);
  assert.equal(new Set(cards.map((c) => c.key)).size, 10);
  assert.ok(cards.filter((c) => c.format === "explain").length >= K.CHECKPOINT_MIN_EXPLAIN, "at least 3 explain");
  assert.ok(cards.every((c) => c.kind === "idea" && c.slot === "checkpoint" && c.done === false));
  // Ideas without an explain variant are asked as they are (the quiz has fewer explain questions, nothing breaks).
  const noExplain = K.buildCheckpointCards(sel, sel.picked.map((p) => deckIdea(p, false)), TODAY);
  assert.equal(noExplain.length, 10);
  assert.equal(noExplain.filter((c) => c.format === "explain").length, 0);
  // Resume: a done card keeps its question, whatever the explain quota says.
  const first = sel.picked[0];
  const answered = answerRow(first.idea_id, { question_id: first.idea_id * 10 + 1 });
  const resumedSel = K.selectCheckpointIdeas(K.parsePool(poolRaw({ ideas: baseIdeas().map((i) => (i.idea_id === first.idea_id ? { ...i, last_reviewed: TODAY } : i)), answered_today: [answered] })), { actFrom: 7 });
  const resumed = K.buildCheckpointCards(resumedSel, resumedSel.picked.map((p) => deckIdea(p)), TODAY);
  const done = resumed.find((c) => c.done);
  assert.equal(resumed.filter((c) => c.done).length, 1);
  assert.equal(done.question.question_id, answered.question_id);
  assert.equal(done.format, "cued", "kept as answered, not turned into an explain question");
  assert.equal(done.attempt_key, answered.attempt_key);
  // The answered question is gone (a corrected question): that idea has no card, the rest stay.
  const gone = K.buildCheckpointCards(resumedSel, resumedSel.picked.map((p) => ({ ...deckIdea(p), questions: p.idea_id === first.idea_id ? [q(1, "explain", explainRubric)] : deckIdea(p).questions })), TODAY);
  assert.equal(gone.length, 9);
});

/* ------------------------------------------------------------------ */
/* The server: SQL contracts, query, route                              */
/* ------------------------------------------------------------------ */

test("SQL: the checkpoint file only adds two read-only functions behind the spoiler gate; the summary leaves checkpoint answers out of XP", () => {
  const sql = read("sql/reading_bank_checkpoint.sql");
  assert.doesNotMatch(sql, /\b(DROP|DELETE|TRUNCATE|INSERT|UPDATE|ALTER)\b/i, "additive and read-only, comments included");
  assert.doesNotMatch(sql, /CREATE TABLE/i);
  const fns = [...sql.matchAll(/CREATE OR REPLACE FUNCTION (pds\.\w+)\(/g)].map((m) => m[1]);
  assert.deepEqual(fns, ["pds.reading_bank_checkpoint_pool", "pds.reading_bank_idea_cards"]);
  for (const name of fns) {
    const body = sql.slice(sql.indexOf(`FUNCTION ${name}(`), sql.indexOf("$fn$;", sql.indexOf(`FUNCTION ${name}(`)));
    assert.match(body, /LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pds, pg_temp/, `${name} is read-only`);
    assert.match(body, /pds\.reading_bank_quiz_through/, `${name} applies the spoiler gate`);
    assert.match(body, /i\.unlock_chapter <= \(SELECT through FROM t\)/, `${name} serves only unlocked ideas`);
    assert.match(body, /pds\.reading_bank_chapter_hash/, `${name} serves only the current edition`);
    assert.match(body, /pds\.reading_bank_idea_supported/, `${name} serves only ideas with valid evidence`);
  }
  const pool = sql.slice(sql.indexOf("FUNCTION pds.reading_bank_checkpoint_pool("), sql.indexOf("FUNCTION pds.reading_bank_idea_cards("));
  assert.match(pool, /i\.importance <> 'detail'/);
  assert.match(pool, /i\.chapter >= 1 AND i\.chapter <= p_chapter/);
  assert.match(pool, /s\.last_reviewed <= \(SELECT d FROM today\) - 7/, "the 7-day rest");
  assert.match(pool, /a\.ext_hash IS NOT NULL AND a\.grading_status <> 'invalidated'/);
  for (const name of fns) {
    assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION ${name.replace(".", "\\.")}\\([^)]*\\) FROM PUBLIC, anon, authenticated`));
    assert.match(sql, new RegExp(`GRANT EXECUTE ON FUNCTION ${name.replace(".", "\\.")}\\([^)]*\\) TO service_role`));
  }
  const main = read("sql/reading_question_bank.sql");
  const summary = main.slice(main.indexOf("FUNCTION pds.reading_bank_summary("), main.indexOf("FUNCTION pds.reading_bank_overview("));
  assert.match(summary, /pds\.reading_bank_events\(/, "answers come from the events, which leave out invalidated ones");
  assert.match(summary, /'xp', \(SELECT jsonb_build_object\([^]*?FROM firsts WHERE round_kind IS DISTINCT FROM 'checkpoint'\)/, "checkpoint answers earn no practice XP");
  assert.match(summary, /'practice_days', \([^]*?FROM firsts WHERE round_kind IS DISTINCT FROM 'checkpoint'\)/, "nor make a practice day");
  const events = main.slice(main.indexOf("FUNCTION pds.reading_bank_events("), main.indexOf("FUNCTION pds.reading_bank_deck("));
  assert.match(events, /a\.grading_status <> 'invalidated'/);
});

const BOOK_ROW = { ...book, created_at: "2026-03-01T00:00:00Z" };
const cardsFor = (pool, withExplain = true) => (wanted) => baseIdeas().concat([]).filter((i) => wanted.includes(i.idea_id)).map((p) => deckIdea(p, withExplain)).map((c) => ({ ...c, sources: [{ kind: "web", url: "https://guides.example.org/x", domain: "guides.example.org", title: "Synthetic guide", cited_text: "Synthetic snippet.", highlight_id: null, passage: null, location: null, page: null }] }));

function serverWith({ pool = poolRaw(), cards = cardsFor(), book = BOOK_ROW, quiz = null, poolError = null, cardsError = null } = {}) {
  const calls = [];
  const rows = (data) => {
    const b = { select: () => b, eq: () => b, order: () => b, limit: async () => ({ data, error: null }) };
    return b;
  };
  const supabase = {
    rpc(name, args) {
      calls.push({ name, args });
      if (name === "reading_bank_checkpoint_pool") return Promise.resolve({ data: poolError ? null : pool, error: poolError });
      if (name === "reading_bank_idea_cards") return Promise.resolve({ data: cardsError ? null : cards(args.p_ids), error: cardsError });
      return Promise.resolve({ data: null, error: { code: "42883" } });
    },
    from(table) {
      calls.push({ from: table });
      if (table === "books") return rows([book]);
      if (table === "reading_quizzes") return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: quiz, error: null }) }) }) };
      throw new Error(`unexpected table ${table}`);
    },
  };
  const S = loadTs("lib/reading-checkpoint-server.ts", { "server-only": {}, "@anthropic-ai/sdk": class {} });
  return { S, supabase, calls };
}
const rpcCalls = (calls) => calls.filter((c) => c.name).map((c) => c.name);

test("the checkpoint round: ten cards, the quiz's own keys, the spoiler gate, two reads and no write", async () => {
  const { S, supabase, calls } = serverWith();
  const r = await S.getCheckpointRound(supabase, { slug: SLUG, chapter: 13 });
  assert.equal(r.status, 200);
  const b = r.body;
  assert.equal(b.kind, "checkpoint");
  assert.equal(b.chapter, 13);
  assert.equal(b.checkpoint, "ch13");
  assert.equal(b.round_key, K.checkpointRoundKey(7, TODAY, 13));
  assert.equal(b.quiz_key, K.checkpointQuizKey(7, TODAY, 13));
  assert.equal(b.cards.length, 10);
  assert.equal(b.size, 10);
  assert.equal(b.ready, true);
  assert.equal(b.quiz, null);
  assert.equal(b.done, 0);
  assert.equal(b.extra_available, 0);
  assert.ok(b.cards.every((c) => c.kind === "idea" && c.chapter >= 1 && c.chapter <= 13 && c.idea.chapter <= b.quiz_through), "nothing past the gate");
  assert.ok(b.cards.filter((c) => c.format === "explain").length >= 3);
  assert.deepEqual(rpcCalls(calls).sort(), ["reading_bank_checkpoint_pool", "reading_bank_idea_cards"], "two reads");
  assert.equal(calls.find((c) => c.name === "reading_bank_idea_cards").args.p_ids.length, 10, "only the ten picked ideas are read");
  assert.equal(calls.filter((c) => c.from === "reading_quizzes").length, 1);
  // The answer is the practice round's shape: the runner and parseRound read it as one.
  const parsed = M.parseCheckpoint(b);
  assert.equal(parsed.round.cards.length, 10);
  assert.equal(parsed.round.round_key, b.round_key);
  assert.equal(parsed.quizKey, b.quiz_key);
  assert.equal(parsed.checkpoint, "ch13");
  assert.equal(parsed.ready, true);
  assert.equal(M.parseCheckpoint({ ...b, quiz_key: "nope" }), null);
});

test("the checkpoint round: refusals and states leave as short codes, and read nothing they should not", async () => {
  const run = async (o, chapter = 13) => {
    const s = serverWith(o);
    return { ...s, r: await s.S.getCheckpointRound(s.supabase, { slug: SLUG, chapter }) };
  };
  const locked = await run({ pool: poolRaw({ quiz_through: 12 }) });
  assert.deepEqual([locked.r.status, locked.r.body.error], [409, "locked"]);
  assert.ok(!rpcCalls(locked.calls).includes("reading_bank_idea_cards"), "a locked checkpoint reads no cards");
  const off = await run({ pool: poolRaw({ enabled: false }) });
  assert.deepEqual([off.r.status, off.r.body.error], [409, "bank_off"]);
  const wrong = await run({}, 7);
  assert.deepEqual([wrong.r.status, wrong.r.body.error], [400, "bad_checkpoint"], "only the three checkpoint chapters");
  const missing = await run({ poolError: { code: "42883", message: "function does not exist" } });
  assert.deepEqual([missing.r.status, missing.r.body.error], [503, "bank_unavailable"], "the SQL is not applied");
  const nobook = await run({ pool: null });
  assert.equal(nobook.r.status, 404);
  const other = await run({ book: { ...BOOK_ROW, book_id: 8 } });
  assert.equal(other.r.status, 404, "the book the pool answered is the book asked for");
  const few = await run({ pool: poolRaw({ ideas: baseIdeas().slice(0, 5) }) });
  assert.equal(few.r.status, 200);
  assert.deepEqual([few.r.body.ready, few.r.body.eligible, few.r.body.cards.length], [false, 5, 0]);
  assert.ok(!rpcCalls(few.calls).includes("reading_bank_idea_cards"), "too few ideas: no cards are read");
  const recorded = await run({ quiz: { quiz_id: 5, score: 8, total: 10 } });
  assert.equal(recorded.r.status, 200);
  assert.deepEqual(recorded.r.body.quiz, { score: 8, total: 10 });
  assert.deepEqual([recorded.r.body.ready, recorded.r.body.cards.length], [false, 0], "a result recorded today closes today's quiz");
  const broken = await run({ cardsError: { code: "XX000", message: "boom SECRET" } });
  assert.deepEqual([broken.r.status, broken.r.body.error], [500, "failed"]);
  assert.doesNotMatch(JSON.stringify(broken.r.body), /boom|SECRET/, "no database text leaves");
});

test("the checkpoint round resumes: answered cards are marked done and come back with their attempt keys", async () => {
  const first = K.selectCheckpointIdeas(K.parsePool(poolRaw()), { actFrom: 7 });
  const answered = first.picked.slice(0, 3).map((i) => i.idea_id);
  const pool = poolRaw({ ideas: baseIdeas().map((i) => (answered.includes(i.idea_id) ? { ...i, last_reviewed: TODAY } : i)), answered_today: answered.map((id) => answerRow(id)) });
  const { S, supabase } = serverWith({ pool });
  const r = await S.getCheckpointRound(supabase, { slug: SLUG, chapter: 13 });
  assert.equal(r.body.cards.length, 10);
  assert.equal(r.body.done, 3);
  assert.deepEqual(r.body.cards.filter((c) => c.done).map((c) => c.idea.idea_id).sort((a, b) => a - b), [...answered].sort((a, b) => a - b));
  assert.ok(r.body.cards.filter((c) => c.done).every((c) => UUID_RE.test(c.attempt_key)));
});

test("the query and the route: chapter and book are checked; GET only; owner session only", () => {
  const { S } = serverWith();
  const parse = (s) => S.parseCheckpointQuery(new URLSearchParams(s));
  assert.deepEqual(parse(`book=${SLUG}&chapter=13`), { ok: true, query: { slug: SLUG, chapter: 13 } });
  assert.deepEqual(parse("chapter=6"), { ok: true, query: { slug: null, chapter: 6 } });
  for (const bad of ["", "chapter=0", "chapter=-1", "chapter=1.5", "chapter=abc", "chapter=1e3", "chapter=9999999", `book=Bad Slug&chapter=6`]) assert.equal(parse(bad).ok, false, bad);
  assert.equal(parse("book=Bad&chapter=6").error, "bad_book");
  const route = read("frontend/src/app/api/reading/practice/checkpoint/route.ts");
  assert.deepEqual([...route.matchAll(/export async function (\w+)/g)].map((m) => m[1]), ["GET"], "GET only: nothing can write through this route");
  assert.match(route, /no-store/);
  const middleware = read("frontend/src/middleware.ts");
  assert.doesNotMatch(middleware, /practice\/checkpoint/, "owner session only: never a CI route");
  assert.ok(!/\/api\/reading\/(bank|practice)/.test(middleware.slice(middleware.indexOf("function isCiRoute"), middleware.indexOf("function isCiRoute") + 1800)), "no new isCiRoute entry");
  const server = read("frontend/src/lib/reading-checkpoint-server.ts");
  assert.match(server, /^import "server-only";/);
  assert.doesNotMatch(server, /\.(insert|update|upsert|delete)\(/, "a read");
});

/* ------------------------------------------------------------------ */
/* Components under the hook harness                                    */
/* ------------------------------------------------------------------ */

const ICONS = new Proxy({}, { get: () => function Icon() { return null; } });

function fakeTimers() {
  let now = 1_000_000;
  let seq = 0;
  const pending = new Map();
  return {
    now: () => now,
    set: (fn, ms) => {
      const id = ++seq;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clear: (id) => pending.delete(id),
    async advance(ms, h) {
      now += ms;
      for (const [id, tm] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
        if (tm.at <= now && pending.has(id)) {
          pending.delete(id);
          tm.fn();
        }
      }
      if (h) await h.flush();
    },
  };
}
function fakeTarget() {
  const handlers = {};
  return {
    handlers,
    addEventListener(type, fn) {
      (handlers[type] ??= []).push(fn);
    },
    removeEventListener(type, fn) {
      handlers[type] = (handlers[type] ?? []).filter((f) => f !== fn);
    },
    fire(type, ev = {}) {
      for (const fn of [...(handlers[type] ?? [])]) fn(ev);
    },
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

/* ---------------------------- the chapter map ---------------------------- */

const MAP_ROWS = [
  chap(1, { ideas: 10, recalled: 4 }),
  chap(2, { ideas: 6, recalled: 6, covered: true }),
  chap(3, { status: "pending", ideas: 0, recalled: 0 }),
  chap(4, { status: "thin", ideas: 3, recalled: 0 }),
  chap(5, { ideas: 8, recalled: 8, covered: true, needs_review: true }),
  chap(6, { locked: true, title: "A secret harbour", ideas: null, recalled: null, covered: null, needs_review: null, sources: null }),
];

function mountMap(t, { rows = MAP_ROWS, narrative = false, bank, flag, practice } = {}) {
  const calls = [];
  const sheets = [];
  const changed = [];
  const o = overview(R.parsePracticeSummary(summaryRaw(practice)));
  withGlobals(t, {
    fetch: async (url, init = {}) => {
      calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
      if (url === `/api/reading/bank?book=${SLUG}`) return bank ? bank() : response(bankRaw(rows, { narrative, quiz_through: 5 }));
      if (url === "/api/reading/practice/flag") return flag ? flag(init) : response({ success: true, kind: "not_read_yet", invalidated: 0, restored: true });
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  const h = mountClient("app/reading/ChapterMap.tsx", {
    props: { o, onChanged: () => changed.push(1) },
    stubs: {
      "lucide-react": ICONS,
      "./ChapterSheet": function ChapterSheetStub(p) {
        sheets.push(p);
        return React.createElement("div", { "data-testid": "sheet-stub", "data-chapter": p.chapter });
      },
    },
  });
  return { h, calls, sheets, changed, o };
}
const tiles = (h) => h.find((n) => n.props && n.props["data-state"] !== undefined);

test("the chapter map: header, tiles with a word each, 5 per row on a phone and 10 on desktop, locked chapters are not buttons", async (t) => {
  const m = mountMap(t);
  await m.h.flush();
  assert.match(m.h.text(), /Recalled 18 of 27 ideas · Kept 2/, "chapters 1-5: 4+6+0+0+8 recalled of 10+6+0+3+8; the locked chapter 6 is not counted");
  assert.match(m.h.text(), /7-day recall 78% \(n 23\) · 21-day recall 70% \(n 10\)/);
  assert.match(m.h.text(), /Share of answers right when the idea was last answered right at least 7 \(21\) days earlier\./, "the statistics stay visible");
  const list = m.h.find((n) => n.type === "ul" && n.props["aria-label"] === "Chapters")[0];
  assert.match(list.props.className, /grid-cols-5/);
  assert.match(list.props.className, /md:grid-cols-10/);
  const all = tiles(m.h);
  assert.deepEqual(all.map((n) => n.props["data-state"]), ["progress", "covered", "building", "few", "review", "locked"]);
  assert.deepEqual(all.map((n) => n.type), ["button", "button", "button", "button", "button", "div"], "the locked chapter is not a button");
  for (const n of all) assert.match(m.h.text(n).trim(), /\S/, "every tile says something in words or numbers");
  assert.match(m.h.text(all[1]), /Covered/);
  assert.match(m.h.text(all[2]), /Building/);
  assert.match(m.h.text(all[3]), /Few sources/);
  assert.match(m.h.text(all[4]), /Review/);
  assert.match(m.h.text(all[5]), /Locked/);
  assert.equal(all[0].props["aria-label"], "Ch 1 · Harbour 1, in progress, 4 of 10 ideas recalled");
  assert.equal(all[5].props["aria-label"], "Ch 6 · A secret harbour, locked", "a nonfiction book's locked titles are its own table of contents");
  assert.equal(m.calls.filter((c) => c.method !== "GET").length, 0, "mounting writes nothing");
  assert.equal(m.calls.length, 1, "one read");
});

test("the chapter map of a narrative book shows no title for a locked chapter, anywhere in its tree", async (t) => {
  const m = mountMap(t, { narrative: true });
  await m.h.flush();
  const locked = tiles(m.h).find((n) => n.props["data-state"] === "locked");
  assert.equal(locked.props["aria-label"], "Ch 6, locked");
  assert.equal(locked.props.title, "Ch 6");
  assert.doesNotMatch(JSON.stringify(m.h.find(() => true).map((n) => [n.props["aria-label"], n.props.title])), /secret harbour/);
  assert.doesNotMatch(m.h.text(), /secret harbour/);
});

test("a tap on a tile opens that chapter's sheet; a locked chapter opens nothing", async (t) => {
  const m = mountMap(t);
  await m.h.flush();
  assert.equal(m.sheets.length, 0);
  const second = tiles(m.h)[1];
  second.props.onClick({ currentTarget: { focus() {} } });
  await m.h.flush();
  const stub = m.h.find((n) => n.props["data-testid"] === "sheet-stub");
  assert.equal(stub.length, 1);
  assert.equal(stub[0].props["data-chapter"], 2);
  const last = m.sheets[m.sheets.length - 1];
  assert.deepEqual([last.slug, last.chapter, last.title, last.perChapterCents], [SLUG, 2, "Harbour 2", 40]);
  last.onClose(false);
  await m.h.flush();
  assert.equal(m.h.find((n) => n.props["data-testid"] === "sheet-stub").length, 0, "closing takes it away");
});

test("the map shows nothing while the bank's routes are missing, an error with Try again when a read fails, and keeps what it showed", async (t) => {
  const off = mountMap(t, { bank: () => response({ error: "bank_unavailable" }, 503) });
  await off.h.flush();
  assert.equal(off.h.nodes().length, 0, "bank off or SQL missing: the page behaves as before");
  let fail = true;
  const failing = mountMap(t, { bank: () => (fail ? response({ error: "failed" }, 500) : response(bankRaw(MAP_ROWS, { quiz_through: 5 }))) });
  await failing.h.flush();
  assert.match(failing.h.text(), /Couldn't load: the chapter map could not be read\./);
  fail = false;
  failing.h.click("Try again");
  await failing.h.flush();
  assert.match(failing.h.text(), /Recalled/);
  assert.equal(tiles(failing.h).length, 6);
});

test("a held chapter is named with Restore, which sends the hold's own flag key and reads the map again", async (t) => {
  let held = true;
  const m = mountMap(t, {
    bank: () => response(bankRaw(MAP_ROWS, { quiz_through: 5, hold_chapter: held ? 6 : null, hold_flag_key: held ? FLAG_KEY : null })),
    flag: () => {
      held = false;
      return response({ success: true, kind: null, invalidated: 0, restored: true });
    },
  });
  await m.h.flush();
  assert.match(m.h.text(), /Held at ch 6 · not read yet/);
  m.h.click("Restore");
  await m.h.flush();
  const post = m.calls.find((c) => c.method === "POST");
  assert.equal(post.url, "/api/reading/practice/flag");
  assert.deepEqual(post.body, { flag_key: FLAG_KEY, restore: true });
  assert.equal(m.changed.length, 1, "the overview is read again");
  assert.doesNotMatch(m.h.text(), /Held at/, "the map was read again and the hold is gone");
});

/* ---------------------------- the chapter sheet ---------------------------- */

const SHEET_RAW = {
  chapter: 6,
  title: "Harbour 6",
  status: "ready",
  built_at: "2026-03-09T15:00:00Z",
  prompt_version: "bank-test.1",
  rebuilds: 0,
  ideas: [
    { idea_id: 1, title: "Idea one", importance: "core", stage: 0, statement: null, sources: 2 },
    { idea_id: 2, title: "Idea two", importance: "supporting", stage: 2, statement: "A statement shown once asked.", sources: 1 },
  ],
  flags: [{ flag_key: FLAG_KEY, kind: "unclear", prompt: "Which lamp burns longest?", created_at: "2026-03-09T16:00:00Z" }],
};

function mountSheet(t, { sheet = SHEET_RAW, status = 200, run, flag, round, win } = {}) {
  const calls = [];
  const closed = [];
  const changed = [];
  let sheetBody = sheet;
  withGlobals(t, {
    fetch: async (url, init = {}) => {
      calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
      if (url === M.sheetUrl(SLUG, 6)) return response(sheetBody, status);
      if (url === "/api/reading/practice/flag") return flag ? flag() : (sheetBody = { ...sheetBody, flags: [] }, response({ success: true, kind: null, invalidated: 0, restored: true }));
      if (url === "/api/reading/bank/run") return run ? run() : response({ queued: 1 }, 202);
      if (url === M.chapterRoundUrl(SLUG, 6)) return round ? round() : response({ error: "x" }, 500);
      throw new Error(`unexpected fetch ${url}`);
    },
    ...(win ? { window: win } : {}),
  });
  const runnerProps = [];
  const h = mountClient("app/reading/ChapterSheet.tsx", {
    props: { slug: SLUG, chapter: 6, title: "Harbour 6", perChapterCents: 40, onClose: (c) => closed.push(c), onChanged: () => changed.push(1) },
    stubs: {
      "lucide-react": ICONS,
      "next/dynamic": () =>
        function RunnerStub(p) {
          runnerProps.push(p);
          return React.createElement("div", { "data-testid": "runner-stub", "data-mode": p.mode });
        },
    },
  });
  return { h, calls, closed, changed, runnerProps };
}

test("the sheet: recalled count, ideas with stage words, no statement before an idea was asked, flagged question with Restore, built line", async (t) => {
  const s = mountSheet(t);
  await s.h.flush();
  assert.match(s.h.text(), /Ch 6 · Harbour 6/);
  assert.match(s.h.text(), /Recalled 1 of 2 ideas/);
  const rows = s.h.find((n) => n.props["data-testid"] === "sheet-idea");
  assert.equal(rows.length, 2);
  assert.match(s.h.text(rows[0]), /Idea one/);
  assert.match(s.h.text(rows[0]), /New · Sources 2/);
  assert.doesNotMatch(s.h.text(rows[0]), /statement/i);
  assert.match(s.h.text(rows[1]), /A statement shown once asked\./);
  assert.match(s.h.text(rows[1]), /Recalled · Sources 1/);
  assert.equal(s.h.find((n) => n.props["aria-label"] === "Stage: Recalled").length, 1);
  assert.match(s.h.text(), /Which lamp burns longest\?/);
  assert.match(s.h.text(s.h.find((n) => n.props["data-testid"] === "sheet-built")[0]), /Built Mar 9 · prompt bank-test\.1/);
  const dialog = s.h.find((n) => n.props.role === "dialog")[0];
  assert.equal(dialog.props["aria-modal"], true);
  assert.equal(s.calls.filter((c) => c.method !== "GET").length, 0, "opening writes nothing");
  assert.equal(s.calls.length, 1);
});

test("the sheet: Restore sends the flag's own key and reads the chapter again; Rebuild asks first and shows the cost", async (t) => {
  const s = mountSheet(t);
  await s.h.flush();
  s.h.click("Restore");
  await s.h.flush();
  const restore = s.calls.find((c) => c.url === "/api/reading/practice/flag");
  assert.deepEqual(restore.body, { flag_key: FLAG_KEY, restore: true });
  assert.equal(s.changed.length, 1);
  assert.doesNotMatch(s.h.text(), /Which lamp burns longest/, "the chapter was read again without the flag");

  s.h.click("Rebuild chapter");
  await s.h.flush();
  assert.match(s.h.text(), /Rebuild chapter 6\? About \$0\.40/);
  assert.equal(s.calls.filter((c) => c.url === "/api/reading/bank/run").length, 0, "nothing starts before the confirm");
  s.h.click("Rebuild");
  await s.h.flush();
  const run = s.calls.find((c) => c.url === "/api/reading/bank/run");
  assert.deepEqual(run.body, { book: SLUG, chapter: 6, rebuild: true });
  assert.match(s.h.text(), /Rebuilding\./);
});

test("the sheet: Practice 5 opens the runner in chapter mode; a locked chapter says so; Esc closes", async (t) => {
  const win = fakeTarget();
  const card = { key: "idea:1", kind: "idea", chapter: 6, format: "cued", slot: "practice", done: false, attempt_key: null, question: { question_id: 11, version: 1, format: "cued", prompt: "Synthetic prompt?", rubric: rubric(1) }, again_question: null, idea: null, recall: null, highlight: null, sources: [], source_count: 0, preview: null, review_preview: null };
  const s = mountSheet(t, { win, round: () => response({ today: TODAY, quiz_through: 6, enabled: true, round_key: "0f0e0d0c-0b0a-4908-8706-050403020100", kind: "chapter", n: 6, cards: [card], done: 0, minutes: 1, extra_available: 0, chapter_recall: null }) });
  await s.h.flush();
  s.h.click("Practice 5");
  await s.h.flush();
  const stub = s.h.find((n) => n.props["data-testid"] === "runner-stub");
  assert.equal(stub.length, 1);
  assert.equal(stub[0].props["data-mode"], "chapter");
  win.fire("keydown", { key: "Escape", preventDefault() {} });
  await s.h.flush();
  assert.equal(s.closed.length, 0, "while the runner is open Esc is the runner's");
  s.runnerProps[s.runnerProps.length - 1].onClose(true, true, undefined);
  await s.h.flush();
  await tick();
  await s.h.flush();
  assert.equal(s.h.find((n) => n.props["data-testid"] === "runner-stub").length, 0, "the runner closed back to the sheet");
  assert.ok(s.changed.length >= 1, "an answer re-reads the map and the overview");
  win.fire("keydown", { key: "Escape", preventDefault() {} });
  assert.deepEqual(s.closed, [true], "Esc closes the sheet, and says something changed");

  const locked = mountSheet(t, { sheet: { error: "locked" }, status: 404 });
  await locked.h.flush();
  assert.match(locked.h.text(), /This chapter is locked\. Keep reading to open it\./);
});

/* ---------------------------- the quiz host ---------------------------- */

function mountQuizHost(t, { get, onClose = () => {}, onRecorded = () => {} } = {}) {
  const calls = [];
  const runnerProps = [];
  withGlobals(t, {
    fetch: async (url, init = {}) => {
      calls.push({ url, method: init.method ?? "GET" });
      if (url === M.checkpointUrl(SLUG, 6)) return get(calls.filter((c) => c.url === url).length);
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  const h = mountClient("app/reading/CheckpointQuiz.tsx", {
    props: { slug: SLUG, checkpoint: "ch6", chapter: 6, onClose, onRecorded },
    stubs: {
      "lucide-react": ICONS,
      "next/dynamic": () =>
        function RunnerStub(p) {
          runnerProps.push(p);
          return React.createElement("div", { "data-testid": "runner-stub", "data-mode": p.mode });
        },
    },
  });
  return { h, calls, runnerProps };
}
const quizBody = (o = {}) => ({
  today: TODAY,
  quiz_through: 13,
  enabled: true,
  round_key: K.checkpointRoundKey(7, TODAY, 6),
  kind: "checkpoint",
  n: 6,
  cards: [{ key: "idea:1", kind: "idea", chapter: 1, format: "cued", slot: "checkpoint", done: false, attempt_key: null, question: { question_id: 11, version: 1, format: "cued", prompt: "Synthetic prompt?", rubric: rubric(1) }, again_question: null, idea: null, recall: null, highlight: null, sources: [], source_count: 0, preview: null, review_preview: null }],
  done: 0,
  minutes: 1,
  extra_available: 0,
  chapter_recall: null,
  checkpoint: "ch6",
  chapter: 6,
  quiz_key: K.checkpointQuizKey(7, TODAY, 6),
  quiz: null,
  eligible: 30,
  size: 10,
  ready: true,
  ...o,
});

test("the quiz host: a GET with no side effect, then the runner in checkpoint mode with the quiz key", async (t) => {
  const closes = [];
  const q = mountQuizHost(t, { get: () => response(quizBody()), onClose: (r) => closes.push(r) });
  await q.h.flush();
  assert.equal(q.calls.length, 1);
  assert.equal(q.calls[0].method, "GET");
  assert.match(q.h.text(), /Checkpoint · ch 6/);
  const last = q.runnerProps[q.runnerProps.length - 1];
  assert.equal(last.mode, "checkpoint");
  assert.deepEqual({ ...last.checkpoint }, { slug: SLUG, chapter: 6, key: "ch6", quizKey: K.checkpointQuizKey(7, TODAY, 6) });
  assert.equal(last.round.round_key, K.checkpointRoundKey(7, TODAY, 6));
  // A close with nothing stored is not "answered"; one with answers and no result reads the quiz again to say so.
  last.onClose(false, false, undefined);
  assert.deepEqual([closes[0].changed, closes[0].recorded, closes[0].unrecorded], [false, false, undefined]);
});

test("the quiz host: stored answers without a result are reported once the quiz is read again; a recorded result is not", async (t) => {
  const closes = [];
  const started = quizBody({ done: 2 });
  started.cards = started.cards.map((c) => ({ ...c, done: true, attempt_key: "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a" }));
  const q = mountQuizHost(t, { get: () => response(started), onClose: (r) => closes.push(r) });
  await q.h.flush();
  q.runnerProps[q.runnerProps.length - 1].onClose(true, false, Promise.resolve());
  assert.equal(closes[0].changed, true);
  assert.equal(await closes[0].unrecorded, true, "answers are stored and no result was recorded");
  assert.equal(q.calls.length, 2, "one more GET, after what was on its way settled");
  const closes2 = [];
  const q2 = mountQuizHost(t, { get: () => response(quizBody()), onClose: (r) => closes2.push(r), onRecorded: () => {} });
  await q2.h.flush();
  const props = q2.runnerProps[q2.runnerProps.length - 1];
  props.onRecorded({ score: 8, total: 10, passed: true, xp: 80 });
  props.onClose(true, true, undefined);
  assert.equal(closes2[0].recorded, true);
  assert.equal(closes2[0].unrecorded, undefined, "recorded: nothing left to record");
});

test("the quiz host: recorded today, too few fresh questions, not open yet, and a failed read each say so in words", async (t) => {
  const rec = mountQuizHost(t, { get: () => response(quizBody({ quiz: { score: 8, total: 10 }, cards: [], ready: false })) });
  await rec.h.flush();
  assert.match(rec.h.text(), /Recorded today · 8\/10/);
  assert.equal(rec.runnerProps.length, 0, "no runner: a quiz key is one per day");

  const few = mountQuizHost(t, { get: () => response(quizBody({ cards: [], ready: false, eligible: 5 })) });
  await few.h.flush();
  assert.match(few.h.text(), /Not enough fresh questions yet · 5 of 10/);
  assert.match(few.h.text(), /Ideas answered in the last 7 days wait\./);
  assert.equal(few.runnerProps.length, 0);

  const locked = mountQuizHost(t, { get: () => response({ error: "locked" }, 409) });
  await locked.h.flush();
  assert.match(locked.h.text(), /This checkpoint is not open yet: keep reading\./);
  assert.equal(locked.h.buttons("Try again").length, 0, "a locked checkpoint cannot be retried");

  const failing = mountQuizHost(t, { get: (n) => (n === 1 ? response({ error: "failed" }, 500) : response(quizBody())) });
  await failing.h.flush();
  assert.match(failing.h.text(), /Couldn't load: Onyx couldn't build the checkpoint quiz\. Try again\./);
  failing.h.click("Try again");
  await failing.h.flush();
  assert.equal(failing.runnerProps.length > 0, true, "the second read opens the quiz");
});

/* ---------------------------- the runner in checkpoint mode ---------------------------- */

const ROUND_KEY = K.checkpointRoundKey(7, TODAY, 6);
const QUIZ_KEY = K.checkpointQuizKey(7, TODAY, 6);
const webSource = { kind: "web", url: "https://example.org/guide", domain: "example.org", title: "Synthetic guide", cited_text: "Synthetic snippet.", highlight_id: null, passage: null, location: null, page: null };
const qPreview = { counts: true, next: { correct: { next_review: "2026-03-11", interval_days: 1, stage: 2 }, partial: { next_review: "2026-03-11", interval_days: 1, stage: 1 }, incorrect: { next_review: "2026-03-11", interval_days: 1, stage: 1 }, dont_know: { next_review: "2026-03-11", interval_days: 1, stage: 1 } } };
const cuedCard = (n) => ({
  key: `idea:${n}`,
  kind: "idea",
  chapter: n,
  format: "cued",
  slot: "checkpoint",
  done: false,
  attempt_key: null,
  question: { question_id: 100 + n, version: 1, format: "cued", prompt: `Synthetic prompt ${n}?`, rubric: rubric(n) },
  again_question: { question_id: 200 + n, version: 1, format: "cued", prompt: `Synthetic variant ${n}?`, rubric: rubric(n) },
  idea: { idea_id: n, chapter: n, importance: "core", kind: "concept", title: `Synthetic idea ${n}`, statement: `Synthetic statement ${n}.`, key_points: [], stage: 0 },
  recall: null,
  highlight: null,
  sources: [webSource],
  source_count: 1,
  preview: qPreview,
  review_preview: null,
});
const explainCard = (n) => ({
  ...cuedCard(n),
  format: "explain",
  again_question: null,
  question: { question_id: 100 + n, version: 2, format: "explain", prompt: `Explain synthetic idea ${n}.`, rubric: explainRubric },
});
const quizRound = (cards) => ({ today: TODAY, quiz_through: 13, enabled: true, round_key: ROUND_KEY, kind: "daily", n: 0, cards, done: 0, minutes: 2, extra_available: 0, chapter_recall: null });
const receiptFor = (cards, body, o = {}) => {
  const qn = cards.flatMap((c) => [c.question, c.again_question]).find((x) => x && x.question_id === body.question_id);
  const g = RC.gradeLocal(qn.format, qn.rubric, body.answer, body.hinted);
  return { success: true, attempt_key: body.attempt_key, grading_status: g.kind === "graded" ? "graded" : "pending", verdict: g.kind === "graded" ? g.verdict : null, score: g.kind === "graded" ? g.score : null, attempt_date: TODAY, next_review: g.kind === "graded" ? "2026-03-11" : null, hinted: body.hinted, overridden: false, replayed: false, ...o };
};

function mountQuiz(t, { cards, answer, poll, quiz } = {}) {
  const calls = [];
  const timers = fakeTimers();
  const recorded = [];
  const closed = [];
  withGlobals(t, {
    fetch: async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url, method: init.method ?? "GET", body });
      if (url === C.ATTEMPT_URL) return answer ? answer(body, calls.filter((c) => c.url === url).length) : response(receiptFor(cards, body));
      if (url.startsWith("/api/reading/practice/round/")) return poll ? poll(calls) : response({ round_key: ROUND_KEY, attempts: [] });
      if (url === M.QUIZ_URL) return quiz ? quiz(body, calls.filter((c) => c.url === url).length) : response({ success: true, quiz: { quiz_id: 9, score: body.score, total: body.total }, passed: body.score / body.total >= 0.8, xp_gained: body.score * 10, op_key: body.op_key, replayed: false });
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  const h = mountClient("app/reading/PracticeRunner.tsx", {
    props: {
      round: quizRound(cards),
      mode: "checkpoint",
      checkpoint: { slug: SLUG, chapter: 6, key: "ch6", quizKey: QUIZ_KEY },
      onClose: (changed, finished) => closed.push({ changed, finished }),
      onRecorded: (r) => recorded.push(r),
      timers,
    },
    stubs: { "lucide-react": ICONS },
  });
  const attempts = () => calls.filter((c) => c.url === C.ATTEMPT_URL);
  const quizzes = () => calls.filter((c) => c.url === M.QUIZ_URL);
  const alerts = () => h.find((n) => n.props.role === "alert").map((n) => h.text(n));
  return { h, calls, timers, recorded, closed, attempts, quizzes, alerts };
}
function typeAnswer(h, text) {
  const ta = h.find((n) => n.type === "textarea")[0];
  assert.ok(ta, "a text box for the answer");
  ta.props.onChange({ target: { value: text } });
}
async function answerCard(h, text) {
  typeAnswer(h, text);
  await h.flush();
  h.click("Check");
  await h.flush();
  h.click("Next");
  await h.flush();
}

test("checkpoint mode: every answer carries round_kind checkpoint and the quiz key, and nothing else changes in the request", async (t) => {
  const cards = [cuedCard(1), cuedCard(2)];
  const r = mountQuiz(t, { cards });
  await r.h.flush();
  typeAnswer(r.h, "alpha 1");
  await r.h.flush();
  r.h.click("Check");
  await r.h.flush();
  const [a] = r.attempts();
  assert.equal(a.body.round_kind, "checkpoint");
  assert.equal(a.body.quiz_key, QUIZ_KEY);
  assert.equal(a.body.round_key, ROUND_KEY);
  assert.equal(Object.keys(a.body).sort().join(","), "answer,attempt_key,hinted,question_id,quiz_key,response_ms,round_date,round_key,round_kind,version");
  assert.match(r.h.text(), /Right/, "a code grade shows at once");
});

test("checkpoint mode: no Skip, and a wrong answer brings no 'Again' repeat (one answer per idea)", async (t) => {
  const cards = [cuedCard(1), cuedCard(2)];
  const r = mountQuiz(t, { cards });
  await r.h.flush();
  r.h.click("More actions");
  await r.h.flush();
  assert.equal(r.h.buttons("Skip for now").length, 0, "a quiz has no Skip");
  assert.ok(r.h.buttons("Wrong").length === 1, "the flags stay");
  r.h.click("More actions");
  await r.h.flush();
  await answerCard(r.h, "nope");
  assert.match(r.h.text(), /Synthetic prompt 2\?/, "the next card is the next idea, not a repeat of the first");
  await answerCard(r.h, "alpha 2");
  assert.match(r.h.text(), /Checkpoint · ch 6/);
  assert.equal(r.h.buttons("Try again · 1").length, 0);
  assert.equal(r.attempts().length, 2, "two answers, no repeat");
  assert.deepEqual(r.attempts().map((c) => c.body.question_id), [101, 102]);
});

test("checkpoint mode: the summary is the quiz result; Done records it once with op_key = the quiz key, then Close", async (t) => {
  const cards = [cuedCard(1), cuedCard(2)];
  const r = mountQuiz(t, { cards });
  await r.h.flush();
  await answerCard(r.h, "alpha 1");
  await answerCard(r.h, "wrong");
  assert.match(r.h.text(r.h.find((n) => n.props["data-testid"] === "quiz-score")[0]), /1 of 2 · 50%/);
  assert.match(r.h.text(r.h.find((n) => n.props["data-testid"] === "quiz-pass")[0]), /Not yet/);
  assert.match(r.h.text(), /80% passes/);
  assert.doesNotMatch(r.h.text(), /\+\d+ XP/, "checkpoint answers earn quiz points, not practice XP");
  assert.equal(r.quizzes().length, 0, "nothing is recorded before Done");
  r.h.click("Done");
  await r.h.flush();
  assert.equal(r.quizzes().length, 1);
  assert.deepEqual(r.quizzes()[0].body, { book: SLUG, checkpoint: "ch6", score: 1, total: 2, op_key: QUIZ_KEY });
  assert.match(r.h.text(r.h.find((n) => n.props["data-testid"] === "quiz-recorded")[0]), /Recorded · \+10 XP/);
  assert.deepEqual(r.recorded, [{ score: 1, total: 2, passed: false, xp: 10 }]);
  assert.equal(r.h.buttons("Done").length, 0, "the result cannot be recorded twice");
  r.h.click("Close");
  assert.deepEqual(r.closed, [{ changed: true, finished: true }]);
});

test("checkpoint mode: Done waits until every answer is graded; a model grade that arrives late is counted", async (t) => {
  const cards = [cuedCard(1), explainCard(2)];
  const attemptOf = () => r.attempts()[1]?.body.attempt_key;
  const r = mountQuiz(t, {
    cards,
    poll: () =>
      response({
        round_key: ROUND_KEY,
        attempts: attemptOf()
          ? [{ attempt_key: attemptOf(), question_id: 102, grading_status: "graded", verdict: "correct", score: 1, hinted: false, feedback: "Synthetic feedback.", rubric_hits: [{ id: "p1", hit: "yes" }], grader: "model", overridden: false, grade_error: null, overridable: true, self_gradable: false, covered_ideas: null }]
          : [],
      }),
  });
  await r.h.flush();
  await answerCard(r.h, "alpha 1");
  await answerCard(r.h, "A synthetic explanation of several words.");
  assert.match(r.h.text(), /1 still grading/);
  const done = () => r.h.buttons("Done")[0];
  assert.equal(done().props["aria-disabled"], true, "Done waits for the grade");
  r.h.click("Done");
  await r.h.flush();
  assert.equal(r.quizzes().length, 0, "a tap on a waiting Done sends nothing");
  await r.timers.advance(C.POLL_EVERY_MS, r.h);
  assert.equal(r.h.buttons("Done")[0].props["aria-disabled"], undefined, "graded: Done is ready");
  assert.match(r.h.text(r.h.find((n) => n.props["data-testid"] === "quiz-score")[0]), /2 of 2 · 100%/);
  assert.match(r.h.text(r.h.find((n) => n.props["data-testid"] === "quiz-pass")[0]), /Passed/);
  r.h.click("Done");
  await r.h.flush();
  assert.deepEqual(r.quizzes()[0].body, { book: SLUG, checkpoint: "ch6", score: 2, total: 2, op_key: QUIZ_KEY });
});

test("checkpoint mode: a lost answer to Done is retried with the SAME request, so the result is stored once", async (t) => {
  const cards = [cuedCard(1)];
  const r = mountQuiz(t, {
    cards,
    quiz: (body, n) => {
      if (n === 1) throw new TypeError("offline");
      return response({ success: true, quiz: { quiz_id: 9 }, passed: true, xp_gained: 10, op_key: body.op_key, replayed: true });
    },
  });
  await r.h.flush();
  await answerCard(r.h, "alpha 1");
  r.h.click("Done");
  await r.h.flush();
  assert.match(r.alerts()[0], /Not sure it saved: No answer from Onyx, so the result may not be saved\./, "an unknown outcome is not called 'Not saved'");
  assert.equal(r.recorded.length, 0);
  r.h.click("Retry");
  await r.h.flush();
  assert.equal(r.quizzes().length, 2);
  assert.deepEqual(r.quizzes()[1].body, r.quizzes()[0].body, "identical request: the same op_key and the same score");
  assert.deepEqual(r.recorded, [{ score: 1, total: 1, passed: true, xp: 10 }]);
  assert.equal(r.alerts().length, 0);
});

test("the runner still offers Skip and Again outside a quiz (the daily round is unchanged)", async (t) => {
  const calls = [];
  withGlobals(t, { fetch: async (url, init = {}) => { calls.push({ url, body: init.body ? JSON.parse(init.body) : null }); return response({ round_key: ROUND_KEY, attempts: [] }); } });
  const h = mountClient("app/reading/PracticeRunner.tsx", {
    props: { round: quizRound([cuedCard(1), cuedCard(2)]), mode: "daily", onClose: () => {}, timers: fakeTimers() },
    stubs: { "lucide-react": ICONS },
  });
  await h.flush();
  h.click("More actions");
  await h.flush();
  assert.equal(h.buttons("Skip for now").length, 1);
});

/* ------------------------------------------------------------------ */
/* The page: where the map and the checkpoint tiles sit                 */
/* ------------------------------------------------------------------ */

test("ReadingClient: the Chapters group sits after the checkpoints, only while the bank is on; the tile offers the quiz in the app", () => {
  const src = read("frontend/src/app/reading/ReadingClient.tsx");
  const cp = src.indexOf('id="section-checkpoints"');
  const ch = src.indexOf('id="section-chapters"');
  const pr = src.indexOf('id="section-practice"');
  assert.ok(cp > 0 && ch > cp && pr > ch, "checkpoints, then chapters, then practice");
  assert.match(src, /\{o\.practice\?\.enabled && \(\s*<PartGroup id="section-chapters" title="Chapters">\s*<Part id="chapter-map" title="Chapter map">/, "no map (and no empty group) while the bank is off");
  assert.match(src, /checkpointOffer\(o, c\)/);
  assert.match(src, /Start checkpoint · \$\{CHECKPOINT_SIZE\} questions/);
  assert.match(src, /Answered · record result/);
  assert.match(src, /quiz me →/, "the chat link stays for a book whose questions are off");
  assert.match(src, /<Part id="review" title="Practice">/, "the practice part keeps its id");
  const feed = read("frontend/src/app/reading/FeedSection.tsx");
  assert.match(feed, /<ReadingClient feed \/>/);
  for (const f of ["ChapterMap", "ChapterSheet", "CheckpointQuiz"]) {
    const code = read(`frontend/src/app/reading/${f}.tsx`);
    assert.doesNotMatch(code, /method: "(POST|PUT|PATCH|DELETE)"/, `${f}: writes only through postJson on a tap`);
  }
  const map = read("frontend/src/app/reading/ChapterMap.tsx");
  assert.doesNotMatch(map, /useEffect\([^)]*postJson/, "mounting the map never writes");
});
