// READ-QUIZ-01: the practice engine (lib/reading-recall.ts): round composition, local grading, model score math,
// schedule replay. Synthetic book and ideas only; no real titles, passages or answers.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { loadTs } = require("./helpers/load-ts.cjs");

const R = loadTs("lib/reading-recall.ts");
const P = loadTs("lib/reading-practice.ts");
const TODAY = "2026-03-10";
const day = (n) => P.addDaysYmd(TODAY, n);

let qid = 1000;
const rubricFor = (format) =>
  format === "cued"
    ? { v: 1, format, answer: "tide tables", accept: ["tables"], options: ["Tide tables", "Gulls", "Waves", "Lamps"], correct: 0, explanation: "x" }
    : format === "explain"
      ? { v: 1, format, points: [{ id: "p1", text: "a", must: true }, { id: "p2", text: "b", must: false }], explanation: "x" }
      : { v: 1, format, steps: ["Light the lamp", "Watch the bay", "Write the entry"], explanation: "x" };
const question = (format) => {
  const id = ++qid;
  return { question_id: id, version: 1, format, prompt: `Synthetic prompt ${id}`, rubric: rubricFor(format) };
};
const idea = (id, chapter, o = {}) => ({
  idea_id: id, chapter, importance: "core", kind: "concept", title: `Synthetic idea ${id}`, statement: "Synthetic statement.",
  key_points: ["k"], stage: 0, next_review: null, state_version: 0, dirty: false, last_question_ids: [], last_verdict: null,
  ease: 2.5, interval_days: 0, review_count: 0, lapses: 0, stage_success_on: null, last_reviewed: null, why: ["new"],
  questions: [question("cued"), question("explain")], sources: [], ...o,
});
const due = (id, chapter, overdue = 1, o = {}) => idea(id, chapter, { next_review: day(-overdue), stage: 2, review_count: 3, interval_days: 3, last_reviewed: day(-overdue - 3), why: ["due"], ...o });
const highlight = (id, o = {}) => ({ highlight_id: id, chapter: 2, passage: "Synthetic passage", comment: null, location: null, review_count: 0, interval_days: 0, ease: 2.5, next_review: null, last_reviewed: null, ...o });
const recall = (chapter, o = {}) => ({ chapter, question_id: 9000 + chapter, version: 1, prompt: `Recall chapter ${chapter}`, rubric: { v: 1, format: "chapter_recall", ideas: [] }, done_n: 0, due_on: day(-1), ...o });
const deck = (o = {}) => ({ book_id: 7, today: TODAY, quiz_through: 6, ideas: [], chapter_recall: [], highlights: [], answered_today: [], ...o });
const slots = (round) => round.cards.map((c) => c.slot);
const count = (round, s) => slots(round).filter((x) => x === s).length;

/* ---------------- hashing ---------------- */

test("sha256Hex equals node:crypto; roundKey is a stable UUID per book, day, kind and number", () => {
  for (const t of ["", "abc", "chapter|3|fog season", "é ü 日本"]) assert.equal(R.sha256Hex(t), crypto.createHash("sha256").update(t, "utf8").digest("hex"));
  const k = R.roundKey(7, TODAY, "daily", 0);
  assert.match(k, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(k, R.roundKey(7, TODAY, "daily", 0));
  assert.notEqual(k, R.roundKey(7, TODAY, "extra", 1));
  assert.notEqual(k, R.roundKey(7, day(1), "daily", 0));
});

/* ---------------- the round ---------------- */

test("buildRound: due first (up to 5, most overdue first), then new (up to 3); a backlog never grows the round", () => {
  const ideas = [
    ...[1, 2, 3, 4, 5, 6, 7].map((i) => due(i, (i % 3) + 1, i)),
    ...[11, 12, 13, 14, 15, 16].map((i) => idea(i, (i % 3) + 1)),
  ];
  const r = R.buildRound(deck({ ideas, highlights: [highlight(1), highlight(2)] }));
  assert.equal(r.cards.length, R.ROUND_SIZE);
  assert.equal(count(r, "due"), 5);
  assert.equal(count(r, "new") + count(r, "newest"), 3);
  assert.equal(r.cards.filter((c) => c.kind === "highlight").length, 0, "no room left for highlights");
  const dueIds = r.cards.filter((c) => c.slot === "due").map((c) => c.idea.idea_id).sort((a, b) => a - b);
  assert.deepEqual(dueIds, [3, 4, 5, 6, 7], "the most overdue");
  assert.ok(r.extra_available >= 5);
});

test("buildRound: up to 5 new ideas when fewer than 3 are due; then at most 2 highlights", () => {
  const ideas = [due(1, 1), ...[11, 12, 13, 14, 15, 16].map((i) => idea(i, 1))];
  const r = R.buildRound(deck({ ideas, highlights: [1, 2, 3, 4].map((i) => highlight(i)) }));
  assert.equal(count(r, "due"), 1);
  assert.equal(count(r, "new") + count(r, "newest"), 5);
  assert.equal(r.cards.filter((c) => c.kind === "highlight").length, 2);
  assert.equal(r.cards.length, 8);
});

test("buildRound: core before supporting, earliest chapter first, but one slot for the newest chapter's core idea", () => {
  const ideas = [
    ...[11, 12, 13, 14, 15].map((i) => idea(i, 1)),
    idea(21, 1, { importance: "supporting" }),
    idea(31, 4), // newest unlocked chapter
    due(1, 2), due(2, 2), due(3, 3),
  ];
  const r = R.buildRound(deck({ ideas }));
  const fresh = r.cards.filter((c) => c.slot === "new" || c.slot === "newest").map((c) => c.idea.idea_id).sort((a, b) => a - b);
  assert.deepEqual(fresh, [11, 12, 31]);
  assert.equal(r.cards.find((c) => c.idea?.idea_id === 31).slot, "newest");
  assert.ok(!r.cards.some((c) => c.idea?.idea_id === 21), "supporting waits behind core");
});

test("buildRound: the newest chapter's slot is reserved inside the room left, so a full round never drops it", () => {
  // 1 chapter recall + 5 due leave 2 slots of 8: one goes to the earliest core idea, the other to the newest chapter.
  const ideas = [
    ...[1, 2, 3, 4, 5].map((i) => due(i, 1 + (i % 2), i)),
    idea(11, 1), idea(12, 1), idea(13, 2),
    idea(31, 4), // newest unlocked chapter
  ];
  const r = R.buildRound(deck({ ideas, chapter_recall: [recall(2, { due_on: day(-1) })] }));
  assert.equal(r.cards.length, R.ROUND_SIZE);
  assert.equal(count(r, "recall") + count(r, "due"), 6);
  const fresh = r.cards.filter((c) => c.slot === "new" || c.slot === "newest").map((c) => c.idea.idea_id).sort((a, b) => a - b);
  assert.deepEqual(fresh, [11, 31]);
  assert.equal(r.cards.find((c) => c.idea?.idea_id === 31).slot, "newest");
});

test("buildRound: detail ideas only fill leftover slots", () => {
  const ideas = [due(1, 1), idea(11, 1), idea(12, 2), idea(41, 1, { importance: "detail" }), due(42, 2, 2, { importance: "detail" })];
  const r = R.buildRound(deck({ ideas }));
  assert.deepEqual(slots(r).filter((s) => s === "detail").length, 2);
  const full = [...[1, 2, 3, 4, 5].map((i) => due(i, 1 + (i % 2), i)), ...[11, 12, 13].map((i) => idea(i, 3)), idea(41, 1, { importance: "detail" })];
  assert.equal(count(R.buildRound(deck({ ideas: full })), "detail"), 0);
});

test("buildRound: at most one chapter recall, the oldest due, placed first; Quick 3 is the same prefix", () => {
  const ideas = [due(1, 1), due(2, 2), idea(11, 3), idea(12, 1)];
  const d = deck({ ideas, chapter_recall: [recall(3, { due_on: day(-1) }), recall(2, { due_on: day(-4) })] });
  const r = R.buildRound(d);
  assert.equal(r.cards[0].kind, "chapter_recall");
  assert.equal(r.cards[0].chapter, 2);
  assert.equal(r.cards.filter((c) => c.kind === "chapter_recall").length, 1);
  assert.deepEqual(R.quickCards(r).map((c) => c.key), r.cards.slice(0, 3).map((c) => c.key));
  assert.ok(R.quickCards(r).some((c) => c.kind === "chapter_recall"), "Quick 3 still includes the chapter recall");
});

test("interleaving: never the same chapter twice in a row when avoidable, at most 2 of one format in a row", () => {
  const ideas = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => due(i, 1 + (i % 3), i, { stage: 0 }));
  const r = R.buildRound(deck({ ideas }), { size: 8 });
  for (let i = 1; i < r.cards.length; i++) {
    if (r.cards[i].chapter === r.cards[i - 1].chapter) {
      assert.ok(r.cards.slice(i).every((c) => c.chapter === r.cards[i].chapter), "a repeat only when every card left is that chapter");
    }
  }
  const mixed = [
    ...[1, 2, 3, 4].map((i) => due(i, i, i, { stage: 0 })),
    ...[5, 6].map((i) => due(i, i, i, { stage: 2 })),
  ];
  const m = R.buildRound(deck({ ideas: mixed, highlights: [highlight(1, { chapter: 1 }), highlight(2, { chapter: 3 })] }));
  for (let i = 2; i < m.cards.length; i++) {
    const f = m.cards[i].format;
    if (m.cards[i - 1].format === f && m.cards[i - 2].format === f) {
      assert.ok(m.cards.slice(i).every((c) => c.format === f), "a third in a row only when nothing else is left");
    }
  }
});

test("buildRound is deterministic for a deck and a day", () => {
  const ideas = [...[1, 2, 3].map((i) => due(i, i)), ...[11, 12, 13].map((i) => idea(i, i - 10))];
  const a = R.buildRound(deck({ ideas }));
  const b = R.buildRound(deck({ ideas: structuredClone(ideas) }));
  assert.deepEqual(a.cards.map((c) => [c.key, c.question?.question_id]), b.cards.map((c) => [c.key, c.question?.question_id]));
  assert.equal(a.round_key, R.roundKey(7, TODAY, "daily", 0));
});

test("resume: a card answered in this round stays, marked done, and the rest of the round is unchanged", () => {
  const ideas = [...[1, 2, 3].map((i) => due(i, i)), ...[11, 12, 13, 14].map((i) => idea(i, i - 10))];
  const r1 = R.buildRound(deck({ ideas }));
  const first = r1.cards[0];
  const answered = ideas.map((i) =>
    i.idea_id === first.idea.idea_id
      ? { ...i, review_count: i.review_count + 1, last_reviewed: TODAY, next_review: day(3), why: ["answered"], last_question_ids: [first.question.question_id] }
      : i,
  );
  const r2 = R.buildRound(deck({
    ideas: answered,
    answered_today: [{ attempt_key: "00000000-0000-4000-8000-000000000001", question_id: first.question.question_id, idea_id: first.idea.idea_id, round_key: r1.round_key, round_kind: "daily", verdict: "correct", grading_status: "graded" }],
  }));
  assert.deepEqual(new Set(r2.cards.map((c) => c.key)), new Set(r1.cards.map((c) => c.key)));
  const again = r2.cards.find((c) => c.key === first.key);
  assert.equal(again.done, true);
  assert.equal(again.question.question_id, first.question.question_id);
  assert.equal(r2.cards.filter((c) => c.done).length, 1);
});

test("an idea answered in another round today is not asked again; an extra round takes the next candidates", () => {
  const ideas = [...[1, 2, 3, 4, 5, 6, 7].map((i) => due(i, 1 + (i % 3), i)), ...[11, 12, 13, 14, 15].map((i) => idea(i, 1 + (i % 3)))];
  const daily = R.buildRound(deck({ ideas }));
  const extra = R.buildRound(deck({ ideas }), { kind: "extra", n: 1 });
  const dailyIds = new Set(daily.cards.map((c) => c.idea?.idea_id));
  assert.ok(extra.cards.length > 0);
  assert.ok(extra.cards.every((c) => !dailyIds.has(c.idea?.idea_id)), "an extra round never repeats the daily round");
  assert.equal(extra.round_key, R.roundKey(7, TODAY, "extra", 1));
});

test("chapter practice: up to 5 ideas of one chapter, due first", () => {
  const ideas = [due(1, 4), idea(11, 4), idea(12, 4), idea(13, 4, { importance: "supporting" }), idea(14, 4), idea(15, 4), idea(16, 4, { next_review: day(5), review_count: 1 })];
  const r = R.buildRound(deck({ ideas, chapter: 4 }), { kind: "chapter" });
  assert.equal(r.cards.length, R.CHAPTER_ROUND_SIZE);
  assert.ok(r.cards.some((c) => c.idea.idea_id === 1));
  assert.ok(!r.cards.some((c) => c.idea.idea_id === 16));
  assert.equal(r.round_key, R.roundKey(7, TODAY, "chapter", 4));
});

test("variants by stage; never one of the last 2 when another exists; Again uses another variant once", () => {
  const q = (format) => question(format);
  const [c1, c2, e1, o1] = [q("cued"), q("cued"), q("explain"), q("order")];
  const base = { importance: "core", questions: [c1, c2, e1, o1], last_question_ids: [] };
  assert.equal(R.pickQuestion({ ...base, stage: 0 }).format, "cued");
  assert.equal(R.pickQuestion({ ...base, stage: 1, last_question_ids: [c1.question_id] }).format, "order", "another format than the last one");
  assert.equal(R.pickQuestion({ ...base, stage: 2 }).format, "explain");
  assert.equal(R.pickQuestion({ ...base, stage: 3, last_question_ids: [e1.question_id] }).format, "cued");
  assert.equal(R.pickQuestion({ ...base, stage: 4, last_question_ids: [c1.question_id] }).format, "explain");
  assert.equal(R.pickQuestion({ ...base, stage: 0, last_question_ids: [o1.question_id, c1.question_id] }).question_id, c2.question_id);
  assert.notEqual(R.pickQuestion({ ...base, importance: "detail", stage: 2 }).format, "explain", "detail never explain");
  // The last-2 rule outranks the stage's preferred format: a stage-2 idea whose only explain was just asked gets
  // its cued variant, not the same explanation again.
  const [e2, c3] = [q("explain"), q("cued")];
  assert.equal(R.pickQuestion({ importance: "core", stage: 2, questions: [e2, c3], last_question_ids: [e2.question_id] }).question_id, c3.question_id);
  assert.equal(R.pickQuestion({ importance: "core", stage: 2, questions: [e2], last_question_ids: [e2.question_id] }).question_id, e2.question_id, "the only variant is still asked");
  const card = R.buildRound(deck({ ideas: [idea(11, 1, { questions: [c1, e1] })] })).cards[0];
  const again = R.againCard(card);
  assert.notEqual(again.question.question_id, card.question.question_id);
  assert.equal(again.again, true);
  assert.equal(R.againCard(again), null, "once");
  assert.equal(R.againCard({ ...card, idea: { ...card.idea, questions: [card.question] } }), null, "no other variant");
});

/* ---------------- local grading ---------------- */

const cuedRubric = { v: 1, format: "cued", answer: "lighthouse keeper", accept: ["keeper", "12"], explanation: "x" };

test("gradeLocal cued: normalization, accepted forms, token containment, typo tolerance", () => {
  const g = (a, h = false) => R.gradeLocal("cued", cuedRubric, a, h);
  assert.deepEqual(g("The Lighthouse-Keeper!"), { kind: "graded", verdict: "correct", score: 1 });
  assert.equal(g("KEEPER").verdict, "correct");
  assert.equal(g("twelve").verdict, "correct", "number words 0-20 are digits");
  assert.equal(g("Lighthousé keeper").verdict, "correct", "diacritics removed");
  assert.equal(g("the old lighthouse keeper did").verdict, "correct", "every token present, at most 4 longer");
  assert.equal(g("lighthouze keeper").verdict, "correct", "one typo per 6 characters");
  assert.equal(g("fog").verdict, "incorrect");
  assert.deepEqual(g("the man who minds the light at night"), { kind: "model" }, "a longer miss may be a paraphrase");
  assert.deepEqual(R.gradeLocal("cued", JSON.stringify(cuedRubric), "keeper"), { kind: "graded", verdict: "correct", score: 1 }, "rubric as jsonb text");
});

test("gradeLocal: a hinted choice is partial when right; order swaps; I don't know", () => {
  const hint = { v: 1, format: "cued", answer: "tide tables", accept: [], options: ["Tide tables", "Gulls", "Waves", "Lamps"], correct: 0, explanation: "x" };
  assert.deepEqual(R.gradeLocal("cued", hint, "Tide tables", true), { kind: "graded", verdict: "partial", score: 0.6 });
  assert.deepEqual(R.gradeLocal("cued", hint, "Gulls", true), { kind: "graded", verdict: "incorrect", score: 0 });
  const ord = rubricFor("order");
  const text = (idx) => R.orderAnswerText(idx.map((i) => ord.steps[i]));
  assert.equal(R.gradeLocal("order", ord, text([0, 1, 2])).verdict, "correct");
  assert.deepEqual(R.gradeLocal("order", ord, text([1, 0, 2])), { kind: "graded", verdict: "partial", score: 0.6 });
  assert.equal(R.gradeLocal("order", ord, text([2, 1, 0])).verdict, "incorrect");
  assert.equal(R.gradeLocal("order", ord, text([0, 1])).verdict, "incorrect");
  for (const f of ["cued", "explain", "order", "chapter_recall"]) {
    assert.deepEqual(R.gradeLocal(f, rubricFor(f === "chapter_recall" ? "explain" : f), R.DONT_KNOW_ANSWER), { kind: "graded", verdict: "dont_know", score: 0 });
  }
  assert.deepEqual(R.gradeLocal("explain", rubricFor("explain"), "Because the count showed the error."), { kind: "model" });
});

/* ---------------- model score math ---------------- */

test("explain score: yes 1, partial 0.5, over the count; capped at 0.39 when the must point is missed", () => {
  const pts = [{ id: "p1", text: "a", must: true }, { id: "p2", text: "b", must: false }, { id: "p3", text: "c", must: false }];
  const s = (h) => R.explainScore(pts, h.map(([id, hit]) => ({ id, hit })));
  assert.equal(s([["p1", "yes"], ["p2", "partial"], ["p3", "no"]]), 0.5);
  assert.equal(s([["p1", "no"], ["p2", "yes"], ["p3", "yes"]]), 0.39);
  assert.equal(s([["p2", "yes"], ["p3", "yes"]]), 0.39, "a must point the grader left out counts as missed");
  assert.equal(s([["p1", "partial"], ["p2", "yes"], ["p3", "yes"]]), 0.83);
  assert.equal(R.verdictFromScore(0.83), "correct");
  assert.equal(R.verdictFromScore(0.8), "correct");
  assert.equal(R.verdictFromScore(0.5), "partial");
  assert.equal(R.verdictFromScore(0.39), "incorrect");
});

test("chapter recall score: core counts twice, partial 0.5", () => {
  const ideas = [{ idea_id: 1, title: "a", importance: "core" }, { idea_id: 2, title: "b", importance: "core" }, { idea_id: 3, title: "c", importance: "supporting" }];
  const hits = [{ id: "i1", hit: "yes" }, { id: "i2", hit: "partial" }, { id: "i3", hit: "no" }];
  assert.equal(R.chapterRecallScore(ideas, hits), 0.6);
  assert.equal(R.modelScore("chapter_recall", { v: 1, format: "chapter_recall", ideas }, hits), 0.6);
  assert.equal(R.modelScore("cued", cuedRubric, [{ id: R.CUED_POINT_ID, hit: "partial" }]), 0.5);
});

/* ---------------- replay ---------------- */

let ek = 0;
const ev = (date, verdict, o = {}) => ({
  attempt_key: `00000000-0000-4000-8000-${String(++ek).padStart(12, "0")}`, question_id: 1001, attempt_date: date,
  answered_at: `${date}T12:${String(Math.floor(ek / 60)).padStart(2, "0")}:${String(ek % 60).padStart(2, "0")}Z`, grading_status: "graded", verdict, format: "cued", hinted: false, ...o,
});

test("replay: only the first event of a day counts; a pending first event holds its day; invalidated ones are ignored", () => {
  const two = R.replayIdeaState([ev(day(-5), "correct"), ev(day(-5), "incorrect")], TODAY);
  assert.equal(two.review_count, 1);
  assert.equal(two.last_verdict, "correct");
  const pending = R.replayIdeaState([ev(day(-5), null, { grading_status: "pending" }), ev(day(-5), "correct")], TODAY);
  assert.equal(pending.review_count, 0, "the pending answer holds the day");
  assert.equal(pending.next_review, null);
  const invalid = R.replayIdeaState([ev(day(-5), "incorrect", { grading_status: "invalidated" }), ev(day(-5), "correct")], TODAY);
  assert.equal(invalid.review_count, 1);
  assert.equal(invalid.last_verdict, "correct");
});

test("replay: the schedule is scheduleAfterGrade (correct = good, easy after a correct explain; partial = good; wrong = again)", () => {
  const events = [ev(day(-9), "correct"), ev(day(-8), "correct", { format: "explain" }), ev(day(-5), "partial"), ev(day(-2), "dont_know")];
  let s = { ease: 2.5, interval_days: 0, review_count: 0 };
  for (const [e, g] of events.map((x, i) => [x, ["good", "easy", "good", "again"][i]])) s = P.scheduleAfterGrade(s, g, e.attempt_date);
  const r = R.replayIdeaState(events, TODAY);
  assert.deepEqual([r.ease, r.interval_days, r.next_review, r.review_count], [s.ease, s.interval_days, s.next_review, s.review_count]);
});

test("replay: stages New -> Seen -> Recalled -> Explained -> Kept, and a lapse drops one stage", () => {
  assert.equal(R.replayIdeaState([], TODAY).stage, 0);
  assert.equal(R.replayIdeaState([ev(day(-20), "partial")], TODAY).stage, 1);
  assert.equal(R.replayIdeaState([ev(day(-20), "correct", { hinted: true })], TODAY).stage, 1, "a hinted answer is not recall");
  assert.equal(R.replayIdeaState([ev(day(-20), "correct")], TODAY).stage, 2);
  const explained = [ev(day(-20), "correct"), ev(day(-15), "correct", { format: "explain" })];
  assert.equal(R.replayIdeaState(explained, TODAY).stage, 3);
  assert.equal(R.replayIdeaState([...explained, ev(day(-12), "correct", { format: "explain" })], TODAY).stage, 3, "too soon for Kept");
  const kept = R.replayIdeaState([...explained, ev(day(-8), "correct", { format: "explain" })], TODAY);
  assert.equal(kept.stage, 4);
  const lapsed = R.replayIdeaState([...explained, ev(day(-8), "correct", { format: "explain" }), ev(day(-3), "incorrect")], TODAY);
  assert.deepEqual([lapsed.stage, lapsed.lapses, lapsed.stage_success_on], [3, 1, null]);
  const fromRecall = R.replayIdeaState([ev(day(-4), "correct", { format: "chapter_recall", question_id: 9001 })], TODAY);
  assert.equal(fromRecall.stage, 3, "a chapter recall hit counts as an explanation");
  assert.deepEqual(fromRecall.last_question_ids, [], "chapter recall answers are not variants");
  const missed = R.replayIdeaState([ev(day(-4), "incorrect", { format: "chapter_recall" })], TODAY);
  assert.equal(missed.next_review, day(-3), "a missed idea is due the next day");
});

test("replay: last_question_ids are the last 2 asked; preview equals commit", () => {
  const events = [ev(day(-6), "correct", { question_id: 1 }), ev(day(-4), "correct", { question_id: 2 }), ev(day(-2), "partial", { question_id: 3 })];
  assert.deepEqual(R.replayIdeaState(events, TODAY).last_question_ids, [2, 3]);
  const p = R.previewAnswer(events, TODAY, { question_id: 4, format: "explain" });
  assert.equal(p.counts, true);
  const commit = R.replayIdeaState([...events, ev(TODAY, "correct", { question_id: 4, format: "explain" })], TODAY);
  assert.deepEqual(p.next.correct, { next_review: commit.next_review, interval_days: commit.interval_days, stage: commit.stage });
  const later = R.previewAnswer([...events, ev(TODAY, "correct", { question_id: 4 })], TODAY, { question_id: 5, format: "cued" });
  assert.equal(later.counts, false, "a second answer today changes no schedule");
  assert.equal(later.next.incorrect.next_review, later.next.correct.next_review);
  const row = R.stateRow(77, 3, commit);
  assert.deepEqual([row.idea_id, row.basis_version, row.next.stage], [77, 3, commit.stage]);
});

test("chapter recall is due the day after, then at day 7 and day 21", () => {
  assert.equal(R.chapterRecallDueOn("2026-03-01", 0), "2026-03-02");
  assert.equal(R.chapterRecallDueOn("2026-03-01", 1), "2026-03-08");
  assert.equal(R.chapterRecallDueOn("2026-03-01", 2), "2026-03-22");
  assert.equal(R.chapterRecallDueOn("2026-03-01", 3), null);
});
