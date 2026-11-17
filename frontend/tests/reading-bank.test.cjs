// READ-QUIZ-01: the pure generation core (lib/reading-bank.ts). Synthetic book only ("The Lighthouse Ledger",
// invented chapters and text); no real titles, passages, answers or production data.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { loadTs } = require("./helpers/load-ts.cjs");

const B = loadTs("lib/reading-bank.ts");
const TITLE = "The Lighthouse Ledger";
const V = "bank-test.1";
const sha = (t) => crypto.createHash("sha256").update(t, "utf8").digest("hex");

/* ---------------- fixtures ---------------- */

const E1 = {
  id: "E1",
  url: "https://guides.example.org/ledger/ch3",
  domain: "example.org",
  title: "Chapter guide",
  cited_text: "In chapter three the keeper records twelve ships during the storm and learns that the tide tables were wrong.",
};
const E2 = { id: "E2", url: "https://reviews.example.net/ledger", domain: "example.net", title: "Review", cited_text: "The lamp is three km from the harbour wall." };
const H5 = { id: "H5", highlight_id: 5, passage: "A ledger is only as honest as the hand that keeps it." };

const cued = (o = {}) => ({
  format: "cued", prompt: "What did the keeper count during the storm?", answer: "ships", accept: ["vessels"],
  options: [], correct_index: 0, steps: [], points: [], explanation: "The count is the chapter's turning point.", ...o,
});
const explain = (o = {}) => ({
  format: "explain", prompt: "Explain why the count mattered.", answer: "", accept: [], options: [], correct_index: 0, steps: [],
  points: [{ text: "The count exposed the false tables", must: true }, { text: "Nobody had checked before", must: false }],
  explanation: "Recording revealed the error.", ...o,
});
const order = (o = {}) => ({
  format: "order", prompt: "Put the keeper's night in order.", answer: "", accept: [], options: [], correct_index: 0,
  steps: ["Light the lamp", "Watch the bay", "Write the entry"], points: [], explanation: "A fixed routine.", ...o,
});
const idea = (o = {}) => ({
  kind: "event", importance: "core", title: "The storm count", statement: "During a storm the keeper counts passing ships and the count shows the tables are off.",
  key_points: ["Counting ships", "Tables were off"], facts: [], support: ["E1"], placement: "this_chapter",
  questions: [cued(), explain()], ...o,
});
const okVerify = (structure) => ({
  ideas: structure.ideas.map((i, index) => ({
    index, supported: "yes", placement: "this", later_content: false,
    questions: i.questions.map((_, qi) => ({ index: qi, ok: true, problem: "none" })),
  })),
});
const CH3 = B.chapterHash(3, "Synthetic chapter 3");
const build = (ideas, o = {}) => {
  const structure = { ideas, highlight_links: [], rejected: 0 };
  return B.validateBuild({
    bookId: 7, chapter: 3, chapterHash: CH3, totalChapters: 12, target: 4, jobId: 91, attempts: 2, claimSeq: 7, promptVersion: V, rebuilds: 0, replace: true,
    structure, verify: o.verify ?? okVerify(structure), evidence: [E1, E2], highlights: [H5], existingTitles: [], ...o,
  });
};

/* ---------------- verify + gates ---------------- */

test("applyVerify: unsupported, partly supported, later content and later placement are not stored; unsure unlocks at the end", () => {
  const ideas = ["A storm count", "A harbour wall", "A lamp distance", "A tide table", "A keeper oath", "A fog season"].map((t) => idea({ title: t }));
  const structure = { ideas, highlight_links: [], rejected: 0 };
  const v = okVerify(structure);
  v.ideas[0].supported = "no";
  v.ideas[1].supported = "partly";
  v.ideas[2].later_content = true;
  v.ideas[3].placement = "later";
  v.ideas[4].placement = "unsure";
  v.ideas[5].placement = "earlier";
  const r = B.applyVerify(structure, v, { chapter: 3, totalChapters: 12 });
  assert.deepEqual(r.ideas.map((i) => [i.index, i.unlock_chapter]), [[4, 12], [5, 3]]);
  assert.equal(r.reasons.unsupported, 1);
  assert.equal(r.reasons.partly_supported, 1);
  assert.equal(r.reasons.later_content, 1);
  assert.equal(r.reasons.later_placement, 1);
});

test("applyVerify: the structure pass's own 'unsure' also unlocks at the end; a missing verdict drops the idea", () => {
  const structure = { ideas: [idea({ placement: "unsure" }), idea({ title: "Second" })], highlight_links: [], rejected: 0 };
  const v = okVerify(structure);
  v.ideas.pop();
  const r = B.applyVerify(structure, v, { chapter: 3, totalChapters: 12 });
  assert.equal(r.ideas.length, 1);
  assert.equal(r.ideas[0].unlock_chapter, 12);
  assert.equal(r.reasons.verify_missing, 1);
});

test("questions verify did not mark ok are left out, and an idea left with none is not stored", () => {
  const structure = { ideas: [idea(), idea({ title: "Other idea", questions: [cued()] })], highlight_links: [], rejected: 0 };
  const v = okVerify(structure);
  v.ideas[0].questions[0] = { index: 0, ok: false, problem: "ambiguous" };
  v.ideas[1].questions[0] = { index: 0, ok: false, problem: "wrong_answer" };
  const r = build(structure.ideas, { verify: v });
  assert.equal(r.kept, 1);
  assert.deepEqual(r.payload.ideas[0].questions.map((q) => q.format), ["explain"]);
  assert.equal(r.reasons.q_not_ok, 2);
  assert.equal(r.reasons.no_questions, 1);
});

test("an idea needs evidence that exists in this build; only cited evidence goes into the payload", () => {
  const r = build([idea({ support: ["E9", "H77"] }), idea({ title: "Backed by a highlight", support: ["H5"] })]);
  assert.equal(r.kept, 1);
  assert.equal(r.reasons.no_evidence, 1);
  assert.deepEqual(r.payload.sources, [{ ref: "H5", kind: "highlight", highlight_id: 5, passage_sha: sha(H5.passage) }]);
  assert.equal(r.payload.ideas[0].origin, "highlight");
  assert.deepEqual(r.payload.ideas[0].evidence, ["H5"]);
});

test("the store payload carries the planned edition, the job, and every highlight the job looked at (by content)", () => {
  const r = build([idea()]);
  assert.equal(r.payload.chapter_hash, CH3, "the store refuses it when the table of contents changed since");
  assert.equal(r.payload.job_id, 91, "the store's receipt makes a repeated store a replay");
  assert.equal(r.payload.attempts, 2, "the claim's attempt number: the store refuses a run that no longer holds the lease");
  assert.equal(r.payload.claim_seq, 7, "the claim's claim_seq, which a re-queue never resets: the second number of the fence");
  assert.deepEqual(r.payload.seen, [{ highlight_id: 5, passage_sha: sha(H5.passage) }], "seen even when no idea cites it");
  assert.doesNotMatch(JSON.stringify(r.payload.seen), /ledger is only/i, "a hash, never the passage");
});

test("exact-fact gate: digits and number words unified, units kept, the value must be in the idea's own snippet or highlight", () => {
  const r = build([
    idea({
      facts: [
        { claim: "Ships counted", value: "12", exact: true }, // "twelve ships" in E1
        { claim: "Lamp distance", value: "3 km", exact: true }, // "three km" in E2, not this idea's evidence
        { claim: "Ships seen", value: "14", exact: true }, // nowhere
      ],
      questions: [cued(), cued({ prompt: "How many ships were logged on the second night?", answer: "14", accept: ["fourteen"] }), explain()],
    }),
    idea({ title: "The lamp", support: ["E2"], facts: [{ claim: "Distance", value: "3 kilometres", exact: true }, { claim: "Distance", value: "three km", exact: true }] }),
  ]);
  const [a, b] = r.payload.ideas;
  assert.deepEqual(a.facts.map((f) => [f.value, f.exact]), [["12", true], ["3 km", false], ["14", false]]);
  assert.deepEqual(a.questions.map((q) => q.rubric.answer ?? q.format), ["ships", "explain"], "a question answered by a non-exact value is left out");
  assert.equal(r.reasons.q_exact_fact, 1);
  assert.deepEqual(b.facts.map((f) => [f.value, f.exact]), [["3 kilometres", false], ["three km", true]], "units are kept: km is not kilometres");
  assert.equal(B.normalizeFactText("1,200 ships, 12% of them"), "1200 ships 12 percent of them");
  assert.equal(B.normalizeFactText("twenty-five keepers, three thousand five hundred nights"), "25 keepers 3500 nights");
  assert.ok(B.factAppearsIn("3.5", ["about 3.5 hours"]));
  assert.ok(!B.factAppearsIn("3", ["about 3.5 hours"]));
});

test("copy guard: 12 consecutive words from a snippet or a highlight is a copy, 11 is not", () => {
  const eleven = "Onyx says: keeper records twelve ships during the storm and learns that the logs lie.";
  const twelve = "Onyx says: the keeper records twelve ships during the storm and learns that the tide.";
  const r1 = build([idea({ statement: eleven })]);
  assert.equal(r1.kept, 1);
  const r2 = build([idea({ statement: twelve })]);
  assert.equal(r2.kept, 0);
  assert.equal(r2.reasons.copy, 1);
  const fromHighlight = "A ledger is only as honest as the hand that keeps it, says the keeper.";
  assert.equal(build([idea({ key_points: [fromHighlight] })]).reasons.copy, 1);
  const q = build([idea({ questions: [cued(), explain({ explanation: "In chapter three the keeper records twelve ships during the storm and learns a lot." })] })]);
  assert.equal(q.reasons.q_copy, 1);
  assert.equal(q.payload.ideas[0].questions.length, 1);
});

test("answer in prompt: a run of 3 answer words, or the whole short answer, leaks", () => {
  assert.ok(B.answerInPrompt("What did the keeper find wrong about the tide tables?", ["tide tables"]));
  assert.ok(!B.answerInPrompt("What did the keeper find wrong?", ["tide tables"]));
  assert.ok(B.answerInPrompt("Why were the false tide tables kept?", ["the false tide tables"]));
  assert.ok(!B.answerInPrompt("Why were the false tide marks kept?", ["the false tide tables"]));
  const r = build([idea({ questions: [cued({ prompt: "Which ships did the keeper count?", answer: "ships" }), explain()] })]);
  assert.equal(r.reasons.q_answer_in_prompt, 1);
  const synonym = build([idea({ questions: [cued({ prompt: "Which vessels did he count?" }), explain()] })]);
  assert.equal(synonym.reasons.q_answer_in_prompt, 1, "an accepted form counts too");
});

test("multiple choice hint: 4 distinct options with the answer as the marked one; none at all is fine", () => {
  const opts = (options, correct_index = 0) => build([idea({ questions: [cued({ options, correct_index }), explain()] })]);
  const good = opts(["Ships", "Gulls", "Waves", "Lamps"], 0);
  assert.deepEqual(good.payload.ideas[0].questions[0].rubric.options, ["Ships", "Gulls", "Waves", "Lamps"]);
  assert.equal(good.payload.ideas[0].questions[0].rubric.correct, 0);
  assert.equal(opts(["Ships", "Gulls", "Waves"]).reasons.q_options, 1, "three options");
  assert.equal(opts(["Ships", "Gulls", "gulls", "Lamps"]).reasons.q_options, 1, "two the same");
  assert.equal(opts(["Ships", "Gulls", "Waves", "Lamps"], 2).reasons.q_options, 1, "the marked option is not the answer");
  assert.equal(opts(["Vessels", "Gulls", "Waves", "Lamps"], 0).reasons.q_options, undefined, "an accepted form may be the marked option");
  const none = opts([]);
  assert.equal(none.payload.ideas[0].questions[0].rubric.options, undefined);
});

test("order needs 3 to 7 distinct steps; explain needs 2 to 4 points with exactly one must", () => {
  const steps = (n) => Array.from({ length: n }, (_, i) => `Step number ${i + 1}`);
  assert.equal(build([idea({ questions: [order({ steps: steps(2) })] })]).reasons.q_order, 1);
  assert.equal(build([idea({ questions: [order({ steps: steps(8) })] })]).reasons.q_order, 1);
  assert.equal(build([idea({ questions: [order({ steps: ["One", "Two", "one"] })] })]).reasons.q_order, 1);
  assert.equal(build([idea({ questions: [order({ steps: steps(7) })] })]).kept, 1);
  const pts = (musts, n = 3) => Array.from({ length: n }, (_, i) => ({ text: `Point ${i + 1}`, must: i < musts }));
  assert.equal(build([idea({ questions: [explain({ points: pts(0) })] })]).reasons.q_explain, 1);
  assert.equal(build([idea({ questions: [explain({ points: pts(2) })] })]).reasons.q_explain, 1);
  assert.equal(build([idea({ questions: [explain({ points: pts(1, 5) })] })]).reasons.q_explain, 1);
  const ok = build([idea({ questions: [explain({ points: pts(1, 4) })] })]);
  assert.deepEqual(ok.payload.ideas[0].questions[0].rubric.points.map((p) => [p.id, p.must]), [["p1", true], ["p2", false], ["p3", false], ["p4", false]]);
});

test("detail ideas never get an explain question; length limits leave things out", () => {
  const r = build([idea({ importance: "detail", questions: [cued(), explain()] })]);
  assert.deepEqual(r.payload.ideas[0].questions.map((q) => q.format), ["cued"]);
  assert.equal(build([idea({ title: "x".repeat(91) })]).reasons.limits, 1);
  assert.equal(build([idea({ key_points: [] })]).reasons.limits, 1);
  assert.equal(build([idea({ questions: [cued({ answer: "one two three four five six seven" }), explain()] })]).reasons.q_limits, 1);
});

test("the canonical rubric is at most 1,800 characters as JSON", () => {
  const accept = Array.from({ length: 8 }, (_, i) => `form ${i} ${"y".repeat(72)}`);
  const options = [accept[0], ...[1, 2, 3].map((i) => `opt${i} ${"z".repeat(114)}`)];
  const small = build([idea({ questions: [cued({ accept, options, correct_index: 0, explanation: "Short." }), explain()] })]);
  assert.equal(small.reasons.q_rubric, undefined);
  assert.ok(JSON.stringify(small.payload.ideas[0].questions[0].rubric).length <= B.LIMITS.rubric);
  const big = build([idea({ questions: [cued({ accept, options, correct_index: 0, explanation: '"'.repeat(400) }), explain()] })]);
  assert.equal(big.reasons.q_rubric, 1);
});

test("dedupe: a title with token Jaccard >= 0.8 against an existing or an earlier idea is not stored", () => {
  assert.equal(B.titleJaccard("Keeper's oath of honesty", "The keeper's oath of honesty"), 0.8);
  const r = build([idea({ title: "The keeper's oath of honesty" }), idea({ title: "Fog season routines" }), idea({ title: "Fog season routines!" })], {
    existingTitles: ["Keeper's oath of honesty"],
  });
  assert.deepEqual(r.payload.ideas.map((i) => i.title), ["Fog season routines"]);
  assert.equal(r.reasons.duplicate, 2);
});

test("chapter status: ready at 60% of target, thin below, anchors_only when every idea rests on highlights, no_sources when none", () => {
  const many = ["One idea", "Two idea", "Three idea"].map((t) => idea({ title: t }));
  assert.equal(build(many, { target: 5 }).status, "ready");
  assert.equal(build(many.slice(0, 2), { target: 5 }).status, "thin");
  assert.equal(build([idea({ support: ["H5"] })], { target: 5 }).status, "anchors_only");
  assert.equal(build([], { target: 5 }).status, "no_sources");
  const p = build(many, { target: 5 }).payload;
  assert.equal(p.status, "ready");
  assert.deepEqual(p.counts, { sources: 1, ideas: 3, questions: 6, rejected: 0 });
  assert.equal(build(many, { replace: false }).payload.status, undefined, "the highlights step keeps the chapter status");
});

test("the highlights step: a link to an existing idea of the chapter adds that highlight as evidence", () => {
  const r = build([], { replace: false, links: [{ highlight: "H5", idea_id: 301 }, { highlight: "H5", idea_id: 999 }, { highlight: "H9", idea_id: 301 }], existingIdeaIds: [301] });
  assert.deepEqual(r.payload.links, [{ idea_id: 301, source_ref: "H5" }]);
  assert.deepEqual(r.payload.sources, [{ ref: "H5", kind: "highlight", highlight_id: 5, passage_sha: sha(H5.passage) }]);
});

test("chapter quota from the print page span", () => {
  assert.equal(B.chapterTarget({ start_page: 1, end_page: 20 }), 7);
  assert.equal(B.chapterTarget({ start_page: 10, end_page: 11 }), 4);
  assert.equal(B.chapterTarget({ start_page: 1, end_page: 300 }), 16);
  assert.equal(B.chapterTarget(null), 8);
  assert.equal(B.chapterTarget({ start_page: 30, end_page: 10 }), 8, "a span that runs backwards is unknown");
  assert.equal(B.chapterTarget({ start_page: 1, end_page: 20 }, true), 4, "max_tokens retry halves the target");
});

/* ---------------- money ---------------- */

test("estimate and caps: 20c + 37c per chapter; cap = estimate x 1.25 rounded up to dollars, at most $25", () => {
  assert.equal(B.estimateBookCents(40), 1500);
  assert.equal(B.capCents(1500), 1900);
  assert.equal(B.capCents(B.estimateBookCents(80)), 2500);
  assert.equal(B.capCents(0), 100);
  assert.equal(B.estimateBookCents(10, false), 370);
  assert.equal(B.approvalCapCents(1200, 400), 1700);
  assert.equal(B.approvalCapCents(2400, 1000), 2500);
  assert.equal(B.monthlyCapCents("4500"), 4500);
  assert.equal(B.monthlyCapCents("lots"), 3000);
  assert.equal(B.monthlyCapCents(undefined), 3000);
  assert.equal(B.dollars(1900), "$19");
  assert.equal(B.dollars(150), "$1.50");
});

/* ---------------- edition binding ---------------- */

test("chapterHash / tocHash mirror the SQL formulas", () => {
  assert.equal(B.chapterHash(3, "  Fog\tSeason  "), sha("chapter|3|fog season"));
  assert.equal(B.chapterHash(0, null), sha("chapter|0|"));
  assert.equal(
    B.tocHash(2, [{ chapter: 2, title: "Fog Season", start_position: 900 }, { chapter: 1, title: "Keeper's Oath", start_position: 10 }]),
    sha("2|1:keeper's oath|2:fog season"),
  );
});

/* ---------------- sources ---------------- */

test("isBlockedUrl: e-reader and shadow-library hosts, book files off publishers, piracy phrases, non-http", () => {
  for (const u of [
    "https://libgen.rs/book/index.php",
    "https://mirror.libgen.rs/x",
    "https://read.amazon.com/?asin=B000000000",
    "https://www.audible.com/webplayer",
    "https://guides.example.org/ledger.pdf",
    "https://guides.example.org/ledger.EPUB",
    "https://example.org/lighthouse-ledger-free-download",
    "https://example.org/read_online/ledger",
    "ftp://example.org/ledger",
    "not a url",
  ]) assert.equal(B.isBlockedUrl(u), true, u);
  assert.equal(B.isBlockedUrl("https://guides.example.org/ledger"), false);
  assert.equal(B.isBlockedUrl("https://www.penguinrandomhouse.com/sample-chapter.pdf"), false, "a publisher's own file");
  assert.equal(B.isBlockedUrl("https://guides.example.org/ledger", "Full text of the book"), true, "the title counts");
  assert.ok(B.BLOCKED_DOMAINS.length <= 64);
});

test("citedNotes: every API citation becomes a source (snippet cut at a word boundary); uncited text is thrown away", () => {
  const long = "word ".repeat(100).trim();
  const content = [
    { type: "server_tool_use", id: "s1", name: "web_fetch", input: {} },
    { type: "web_fetch_tool_result", content: { type: "web_fetch_result", url: "https://guides.example.org/ledger/ch3", content: { type: "document", title: "Ledger guide" } } },
    { type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
    { type: "text", text: "Chapter three shows the keeper counting ships.", citations: [{ type: "char_location", document_index: 0, document_title: "Ledger guide", cited_text: long }] },
    { type: "text", text: " An uncited sentence the model added. ", citations: null },
    { type: "text", text: "A review notes the tide tables.", citations: [{ type: "web_search_result_location", url: "https://reviews.example.net/ledger", title: "Review", cited_text: "Short snippet." }] },
    { type: "text", text: "Also seen on a copy site.", citations: [{ type: "web_search_result_location", url: "https://libgen.rs/x", title: "x", cited_text: "copied" }] },
    { type: "text", text: "UNSURE: the order of chapters four and five.", citations: null },
  ];
  const r = B.citedNotes(content);
  assert.equal(r.notes.length, 2);
  assert.equal(r.sources.length, 2);
  const [a, b] = r.sources;
  assert.equal(a.url, "https://guides.example.org/ledger/ch3");
  assert.equal(a.domain, "example.org");
  assert.equal(a.title, "Ledger guide");
  assert.ok(a.cited_text.length <= 300 && a.cited_text.endsWith("word") && long.startsWith(a.cited_text));
  assert.equal(b.domain, "example.net");
  assert.equal(r.dropped, 2, "the uncited sentence and the blocked page");
  assert.match(r.unsure, /^UNSURE:/);
  assert.deepEqual(r.tool_errors, ["max_uses_exceeded"]);
  assert.equal(B.cutAtWord("abcdefghij", 4), "abcd", "one long word is cut hard");
  assert.equal(B.registrableDomain("https://news.example.co.uk/a"), "example.co.uk");
  assert.equal(B.registrableDomain("www.example.org"), "example.org");
});

/* ---------------- planning ---------------- */

const chapters = [1, 2, 3, 4, 5, 6].map((n) => ({ chapter: n, title: `Synthetic chapter ${n}`, start_page: n * 10, end_page: n * 10 + 9, chapter_hash: B.chapterHash(n, `Synthetic chapter ${n}`) }));
const TOC = "a".repeat(64);
const planInput = (o = {}) => ({
  book_id: 7, title: TITLE, author: "A. Writer", total_chapters: 6, status: "reading", approved: true, paused_reason: null,
  mapping: "ok", narrative: false, map_urls: ["https://guides.example.org/ledger"], toc_hash_stored: TOC, toc_hash: TOC,
  quiz_through: 3, chapter0_hash: B.chapterHash(0, ""), chapters, bank: [], jobs: [], highlights: [], ...o,
});
const hashOf = (n) => chapters[n - 1].chapter_hash;

test("planBankJobs: nothing while the book is off", () => {
  assert.deepEqual(B.planBankJobs(planInput({ approved: false }), V).jobs, []);
  assert.deepEqual(B.planBankJobs(planInput({ paused_reason: "owner" }), V).quizzable, []);
});

test("planBankJobs: the source map first (unknown mapping or a changed table of contents)", () => {
  for (const o of [{ mapping: "unknown" }, { toc_hash_stored: "b".repeat(64) }]) {
    const p = B.planBankJobs(planInput(o), V);
    assert.deepEqual(p.jobs, [{ step: "map", chapter: 0, input_hash: sha(`${V}|${TOC}|${TITLE}|A. Writer|6|0`), prompt_version: V, priority: 10 }]);
    assert.deepEqual(p.quizzable, [1, 2, 3]);
  }
});

test("planBankJobs: research per unbuilt chapter up to quiz_through + 2, with the priority ladder", () => {
  const p = B.planBankJobs(planInput(), V);
  assert.deepEqual(p.jobs.map((j) => [j.step, j.chapter, j.priority]), [
    ["research", 3, 20], ["research", 4, 30], ["research", 1, 41], ["research", 2, 42], ["research", 5, 80],
  ]);
  assert.equal(p.jobs[0].input_hash, sha(`${V}|${hashOf(3)}|${JSON.stringify(["https://guides.example.org/ledger"])}|0`));
});

test("planBankJobs: build after its research is done; a built chapter is left alone; Rebuild makes new hashes", () => {
  const rHash = B.researchInputHash(V, hashOf(3), ["https://guides.example.org/ledger"], 0);
  const done = planInput({ jobs: [{ job_id: 50, step: "research", chapter: 3, input_hash: rHash, status: "done", result: null }] });
  const b = B.planBankJobs(done, V).jobs.find((j) => j.chapter === 3);
  assert.deepEqual([b.step, b.input_hash, b.priority], ["build", sha(`${V}|${hashOf(3)}|50|0`), 20]);

  const built = { chapter: 3, status: "ready", chapter_hash: hashOf(3), rebuilds: 0, built_rebuilds: 0, built_at: "2026-03-01T00:00:00Z", quizzable_since: "2026-03-01" };
  const p = B.planBankJobs(planInput({ bank: [built] }), V);
  assert.ok(!p.jobs.some((j) => j.chapter === 3));
  assert.equal(p.jobs.find((j) => j.chapter === 2).priority, 20, "the newest quizzable chapter without a bank goes first");
  assert.deepEqual(p.quizzable, [1, 2]);

  const rebuilt = B.planBankJobs(planInput({ bank: [{ ...built, rebuilds: 1 }] }), V).jobs.find((j) => j.chapter === 3);
  assert.equal(rebuilt.input_hash, B.researchInputHash(V, hashOf(3), ["https://guides.example.org/ledger"], 1));
  const changedToc = B.planBankJobs(planInput({ bank: [{ ...built, chapter_hash: "c".repeat(64) }] }), V).jobs.find((j) => j.chapter === 3);
  assert.equal(changedToc.step, "research", "a bank built for another edition is rebuilt");
});

test("planBankJobs: a highlights job for highlights whose content no job has seen; its hash follows the highlight content", () => {
  // pds.reading_bank_plan_input lists only highlights whose (id, sha256 of the passage) no build or highlights job
  // has looked at, so a review or a Kindle re-import (updated_at only) never shows up here and costs nothing.
  const built = { chapter: 3, status: "ready", chapter_hash: hashOf(3), rebuilds: 0, built_rebuilds: 0, built_at: "2026-03-01T00:00:00Z", quizzable_since: "2026-03-01" };
  const hl = (passage_sha, chapter = 3) => ({ highlight_id: 5, chapter, passage_sha });
  assert.ok(!B.planBankJobs(planInput({ bank: [built], highlights: [] }), V).jobs.some((j) => j.step === "highlights"));
  const a = B.planBankJobs(planInput({ bank: [built], highlights: [hl("1".repeat(64))] }), V).jobs.find((j) => j.step === "highlights");
  const b = B.planBankJobs(planInput({ bank: [built], highlights: [hl("2".repeat(64))] }), V).jobs.find((j) => j.step === "highlights");
  assert.equal(a.priority, 60);
  assert.equal(a.input_hash, sha(`${V}|3|5:${"1".repeat(64)}`));
  assert.notEqual(a.input_hash, b.input_hash, "an edited passage is new content, so it is offered again");
  const unbuilt = B.planBankJobs(planInput({ highlights: [hl("1".repeat(64))] }), V);
  assert.ok(!unbuilt.jobs.some((j) => j.step === "highlights"), "a chapter without a current bank gets its highlights in the build");
  assert.ok(!("changed_at" in hl("1".repeat(64))), "freshness is the database's content check, not a timestamp");
});

test("planBankJobs: obsolete queued jobs are skipped; a planned one is not", () => {
  const planned = B.researchInputHash(V, hashOf(1), ["https://guides.example.org/ledger"], 0);
  const p = B.planBankJobs(planInput({
    jobs: [
      { job_id: 1, step: "research", chapter: 1, input_hash: planned, status: "queued", result: null },
      { job_id: 2, step: "research", chapter: 2, input_hash: "d".repeat(64), status: "queued", result: null },
      { job_id: 3, step: "build", chapter: 6, input_hash: "e".repeat(64), status: "queued", result: null },
      { job_id: 4, step: "research", chapter: 2, input_hash: "f".repeat(64), status: "failed", result: null },
    ],
  }), V);
  assert.deepEqual(p.skip_jobs, [2, 3]);
});

test("planBankJobs: uncertain mapping builds chapters from highlights only, and a whole-book chapter 0 once finished", () => {
  const p = B.planBankJobs(planInput({ mapping: "uncertain" }), V);
  assert.ok(p.jobs.every((j) => j.step === "build"));
  assert.equal(p.jobs.find((j) => j.chapter === 3).input_hash, sha(`${V}|${hashOf(3)}|anchors|0`));
  assert.ok(!p.jobs.some((j) => j.chapter === 0));
  const done = B.planBankJobs(planInput({ mapping: "uncertain", status: "finished", quiz_through: 6 }), V);
  const whole = done.jobs.find((j) => j.chapter === 0);
  assert.deepEqual([whole.step, whole.priority, whole.input_hash], ["build", 90, sha(`${V}|${B.chapterHash(0, "")}|whole|0`)]);
});

test("estimateRemainingCents counts the chapters without a current bank", () => {
  const built = { chapter: 1, status: "ready", chapter_hash: hashOf(1), rebuilds: 0, built_rebuilds: 0, built_at: null, quizzable_since: null };
  assert.equal(B.estimateRemainingCents(planInput({ bank: [built] })), 5 * 37);
  assert.equal(B.estimateRemainingCents(planInput({ mapping: "unknown" })), 20 + 6 * 37);
});

/* ---------------- review round 2 ---------------- */

test("the end of the book while the chapter count is unknown is never reached (unsure and whole-book ideas)", () => {
  const structure = { ideas: [idea({ placement: "unsure" }), idea({ title: "Second" })], highlight_links: [], rejected: 0 };
  const r = B.applyVerify(structure, okVerify(structure), { chapter: 3, totalChapters: 0 });
  assert.deepEqual(r.ideas.map((i) => i.unlock_chapter), [B.UNKNOWN_END_CHAPTER, 3]);
  const whole = B.applyVerify(structure, okVerify(structure), { chapter: 0, totalChapters: 0 });
  assert.ok(whole.ideas.every((i) => i.unlock_chapter === B.UNKNOWN_END_CHAPTER), "chapter 0 never unlocks at 0");
  assert.equal(B.endChapter(3, 12), 12);
  assert.equal(B.endChapter(14, 12), 14);
  assert.equal(B.UNKNOWN_END_CHAPTER, 2147483647, "equals pds.reading_bank_end_chapter's value");
});

test("citedNotes: the copy guard drops a note (and an UNSURE note) that repeats 12 words of a snippet", () => {
  const snippet = "the keeper wrote every ship into the ledger before dawn because the tide tables could not be trusted any longer";
  const content = [
    { type: "text", text: "Chapter three: the keeper wrote every ship into the ledger before dawn because the tide tables could not be trusted.", citations: [{ type: "web_search_result_location", url: "https://guides.example.org/ledger/ch3", title: "Guide", cited_text: snippet }] },
    { type: "text", text: "The chapter turns on a count of ships.", citations: [{ type: "web_search_result_location", url: "https://guides.example.org/ledger/ch3", title: "Guide", cited_text: snippet }] },
    { type: "text", text: "UNSURE: whether the keeper wrote every ship into the ledger before dawn because the tide tables failed.", citations: null },
  ];
  const r = B.citedNotes(content);
  assert.deepEqual(r.notes.map((n) => n.text), ["The chapter turns on a count of ships."]);
  assert.equal(r.unsure, "");
  assert.equal(r.dropped, 2);
  assert.equal(r.sources.length, 1, "the citation itself is still evidence");
});

// The two answer shapes the API gives for a map / research call (block order and field names as observed from
// web_search_20260209 on 2026-11-17; every string here is synthetic).
const SEARCH_RESULT = (url, title) => ({ type: "web_search_result", url, title, encrypted_content: "x", page_age: "May 1, 2024" });
const SEARCH_CITE = (url, title, cited_text) => ({ type: "web_search_result_location", url, title, encrypted_index: "x", cited_text });

test("citedNotes, a direct web search answer: cited fragments become notes and sources, uncited connectors and a blocked host are dropped", () => {
  const content = [
    { type: "server_tool_use", id: "srvtoolu_s1", name: "web_search", input: { query: "lighthouse ledger chapter summaries" } },
    { type: "web_search_tool_result", tool_use_id: "srvtoolu_s1", caller: { type: "direct" }, content: [SEARCH_RESULT("https://guides.example.org/ledger", "Ledger guide"), SEARCH_RESULT("https://reviews.example.net/ledger", "Review")] },
    { type: "text", text: "Here is what the sources say:" },
    { type: "text", text: "the keeper logs every passing ship", citations: [SEARCH_CITE("https://guides.example.org/ledger", "Ledger guide", "Chapter one: the keeper logs each ship that passes the lamp.")] },
    { type: "text", text: ", and " },
    { type: "text", text: "the book has twelve chapters", citations: [SEARCH_CITE("https://guides.example.org/ledger", "Ledger guide", "Twelve short chapters."), SEARCH_CITE("https://reviews.example.net/ledger", "Review", "It runs to twelve chapters in all.")] },
    { type: "text", text: "." },
    { type: "text", text: "a copy site lists them too", citations: [SEARCH_CITE("https://libgen.rs/ledger", "Ledger", "copied")] },
    { type: "text", text: "UNSURE: whether the epilogue is numbered." },
  ];
  const r = B.citedNotes(content);
  assert.deepEqual(r.notes.map((n) => [n.text, n.sources]), [["the keeper logs every passing ship", [0]], ["the book has twelve chapters", [1, 2]]]);
  assert.deepEqual(r.sources.map((s) => s.domain), ["example.org", "example.org", "example.net"]);
  assert.equal(r.dropped, 4, "the opener, the two connectors and the blocked-host note");
  assert.match(r.unsure, /^UNSURE:/);
  assert.deepEqual(r.tool_errors, []);
});

test("citedNotes, a web search run from code execution (dynamic filtering) carries no citations: that is why both tools pin allowed_callers direct", () => {
  const caller = { type: "code_execution_20260120", tool_id: "srvtoolu_c1" };
  const content = [
    { type: "server_tool_use", id: "srvtoolu_c1", name: "code_execution", input: { code: "print(web_search(query='x'))" } },
    { type: "server_tool_use", id: "srvtoolu_s1", name: "web_search", input: { query: "lighthouse ledger chapter summaries" }, caller },
    { type: "web_search_tool_result", tool_use_id: "srvtoolu_s1", caller, content: [SEARCH_RESULT("https://guides.example.org/ledger", "Ledger guide")] },
    { type: "code_execution_tool_result", tool_use_id: "srvtoolu_c1", content: { type: "code_execution_result", stdout: "Ledger guide: twelve chapters", stderr: "", return_code: 0, content: [] } },
    { type: "thinking", thinking: "", signature: "x" },
    { type: "text", text: "The sources describe twelve short chapters about a keeper who logs ships." },
    { type: "text", text: "The guide and the review agree on the order." },
  ];
  const r = B.citedNotes(content);
  assert.equal(r.sources.length, 0, "the answer read the results through code, so the API attached nothing to its text");
  assert.equal(r.notes.length, 0);
  assert.equal(r.dropped, 2);
});

test("mergeHighlightLinks folds valid links into support before verify; validateBuild never reads highlight_links", () => {
  const structure = {
    ideas: [idea({ support: ["E1"] }), idea({ title: "Other idea", support: ["E2"] })],
    highlight_links: [{ highlight: "H5", idea_index: 0 }, { highlight: "H5", idea_index: 0 }, { highlight: "H99", idea_index: 1 }, { highlight: "H5", idea_index: 7 }, { highlight: "H5", idea_index: -1 }],
    rejected: 0,
  };
  const merged = B.mergeHighlightLinks(structure, ["H5"]);
  assert.deepEqual(merged.ideas.map((i) => i.support), [["E1", "H5"], ["E2"]]);
  assert.deepEqual(merged.highlight_links, []);
  assert.deepEqual(structure.ideas[0].support, ["E1"], "the input is not changed");
  // Unmerged: the link verify never saw is not evidence.
  const r = B.validateBuild({
    bookId: 7, chapter: 3, chapterHash: CH3, totalChapters: 12, target: 4, jobId: 91, attempts: 2, claimSeq: 7, promptVersion: V, rebuilds: 0, replace: true,
    structure, verify: okVerify(structure), evidence: [E1, E2], highlights: [H5], existingTitles: [],
  });
  assert.deepEqual(r.payload.ideas.map((i) => i.evidence), [["E1"], ["E2"]]);
  assert.ok(!r.payload.sources.some((s) => s.kind === "highlight"));
});

test("a build with nothing to cite needs no model call and stores no_sources", () => {
  assert.equal(B.buildNeedsModel([], []), false);
  assert.equal(B.buildNeedsModel([E1], []), true);
  assert.equal(B.buildNeedsModel([], [H5]), true);
  const r = B.validateBuild({
    bookId: 7, chapter: 3, chapterHash: CH3, totalChapters: 12, target: 4, jobId: 91, attempts: 2, claimSeq: 7, promptVersion: V, rebuilds: 0, replace: true,
    structure: B.EMPTY_STRUCTURE, verify: null, evidence: [], highlights: [], existingTitles: [],
  });
  assert.deepEqual([r.status, r.kept, r.payload.status, r.payload.ideas.length], ["no_sources", 0, "no_sources", 0]);
});

test("planBankJobs: a failed map is planned again only after a book-level Rebuild (map_rebuilds in its hash)", () => {
  const first = B.planBankJobs(planInput({ mapping: "unknown" }), V).jobs[0];
  const failed = { job_id: 60, step: "map", chapter: 0, input_hash: first.input_hash, status: "failed", result: null };
  const again = B.planBankJobs(planInput({ mapping: "unknown", jobs: [failed] }), V);
  assert.deepEqual(again.jobs.map((j) => j.input_hash), [first.input_hash], "same hash: enqueue leaves the failed job (web_search_disabled aside)");
  assert.deepEqual(again.skip_jobs, []);
  const rebuilt = B.planBankJobs(planInput({ mapping: "unknown", jobs: [failed], map_rebuilds: 1 }), V).jobs[0];
  assert.notEqual(rebuilt.input_hash, first.input_hash);
  assert.equal(rebuilt.input_hash, sha(`${V}|${TOC}|${TITLE}|A. Writer|6|1`));
  assert.equal(B.mapInputHash(V, { toc_hash: TOC, title: TITLE, author: "A. Writer", total_chapters: 6 }), first.input_hash, "no count = 0");
});

test("the codes a skipped or refused job may carry are known codes", () => {
  for (const c of ["not_pending", "question_changed", "superseded", "cost_limit", "stale_generation", "paused", "toc_changed"]) assert.equal(B.bankCode(c), c);
});

/* ---------------- heartbeat ---------------- */

test("heartbeat: counts, chapter numbers and known codes only; never a title", () => {
  const s = {
    chapters: [{ chapter: 14, result: "ready", kept: 12, target: 14, questions: 31, sources: 5 }],
    graded: 4, failed: 0, codes: ["budget", TITLE, "Refusal"],
  };
  const msg = B.bankHeartbeatMessage(s);
  assert.equal(msg, "ch 14 ready 12/14 ideas 31 q 5 src; graded 4; codes budget other refusal");
  assert.doesNotMatch(msg, /lighthouse|ledger/i);
  assert.equal(B.bankHeartbeatStatus(s), "partial");
  assert.equal(B.bankHeartbeatStatus({ ...s, codes: [] }), "success");
  assert.equal(B.bankHeartbeatStatus({ ...s, codes: [], chapters: [{ ...s.chapters[0], result: "thin" }] }), "partial");
  assert.equal(B.bankHeartbeatStatus({ ...s, failed: 1 }), "failed");
  assert.equal(B.bankHeartbeatRecords(s), 16);
  assert.equal(B.bankHeartbeatMessage({ chapters: [], graded: 0, failed: 0, codes: [] }), "nothing to do");
  assert.equal(B.bankCode("Monthly_Cap"), "monthly_cap");
  assert.equal(B.bankCode("an api message with words"), "other");
});
