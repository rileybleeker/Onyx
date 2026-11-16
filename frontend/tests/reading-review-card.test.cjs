// PROD-T03: the /reading Review card keeps the card on failure, retries with the same operation key, shows the
// interval the server will store, and advances exactly once on success. Synthetic data only; no network.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");
const { mountClient, response, deferred, withGlobals } = require("./helpers/hook-harness.cjs");

const P = loadTs("lib/reading-practice.ts");
const TODAY = "2026-03-10";

const card = (id, o = {}) => ({
  highlight_id: id, book_id: 7, chapter: 1, location: null, passage: `Synthetic passage ${id}`, comment: `Synthetic note ${id}`,
  concept: null, source: "manual", review_count: 0, ease: 2.5, interval_days: 0, next_review: null, last_reviewed: null,
  archived: false, notion_block_id: null, created_at: "2026-03-01T12:00:00Z", position: null, position_end: null, page: null,
  highlighted_at: null, note_at: null, behavioral_date: null, ...o,
});
const overview = (due) => ({ book: { book_id: 7, slug: "synthetic-book" }, today: TODAY, dueReviews: due, highlights: due, reviewsToday: 0 });
const REVEAL = "Say what this means, then reveal your note";

function mount(t, { due = [card(1), card(2)], answer }) {
  const sent = [];
  const events = { graded: [], refreshed: 0 };
  withGlobals(t, {
    fetch: async (url, init = {}) => {
      assert.equal(url, "/api/reading/review");
      assert.equal(init.method, "POST");
      const body = JSON.parse(init.body);
      sent.push(body);
      return answer(body, sent.length);
    },
  });
  const h = mountClient("app/reading/ReviewCard.tsx", {
    props: { o: overview(due), onGraded: (xp) => events.graded.push(xp), onRefresh: () => events.refreshed++ },
    stubs: { "lucide-react": { AlertTriangle: () => null } },
  });
  const alerts = () => h.find((n) => n.props.role === "alert").map((n) => h.text(n));
  const header = () => h.text(h.find((n) => n.type === "span" && n.props.className?.includes("font-mono") && /due|done today|next|nothing/.test(h.text(n)))[0]);
  return { h, sent, events, alerts, header };
}

const ok = (body, o = {}) => response({ success: true, xp_gained: 15, next_review: "2026-03-11", interval_days: 1, op_key: body.op_key, replayed: false, ...o });

test("grade buttons show the interval the scheduler stores: the first Good is 1 day", () => {
  const p0 = P.reviewPreview({ ease: 2.5, interval_days: 0, review_count: 0 }, TODAY);
  assert.deepEqual([p0.again.interval_days, p0.good.interval_days, p0.easy.interval_days], [1, 1, 3]);
  assert.equal(P.scheduleAfterGrade({ ease: 2.5, interval_days: 0, review_count: 0 }, "good", TODAY).next_review, "2026-03-11");
  const p1 = P.reviewPreview({ ease: 2.5, interval_days: 1, review_count: 1 }, TODAY);
  assert.equal(p1.good.interval_days, 3, "second Good: 3 days");
  const p3 = P.reviewPreview({ ease: "2.5", interval_days: 3, review_count: 2 }, TODAY);
  assert.equal(p3.good.interval_days, 8);
  assert.equal(p3.easy.interval_days, 10);
  assert.equal(P.intervalLabel(1), "1 day");
  assert.equal(P.intervalLabel(8), "8 days");
});

test("the card renders labels and intervals together, from the same helper", async (t) => {
  const { h } = mount(t, { due: [card(1, { interval_days: 3, review_count: 2 })], answer: ok });
  await h.flush();
  h.click(REVEAL);
  await h.flush();
  for (const [g, label] of [["again", "Again"], ["good", "Good"], ["easy", "Easy"]]) {
    const days = P.scheduleAfterGrade({ ease: 2.5, interval_days: 3, review_count: 2 }, g, TODAY).interval_days;
    const b = h.button(`${label}, next review in ${P.intervalLabel(days)}`);
    assert.match(h.text(b), new RegExp(`${label}${P.intervalLabel(days)}`));
  }
});

test("network failure keeps the card and the note; Retry sends the SAME key; success advances exactly once", async (t) => {
  const { h, sent, events, alerts, header } = mount(t, {
    answer: (body, n) => {
      if (n === 1) throw new TypeError("offline");
      return ok(body);
    },
  });
  await h.flush();
  assert.equal(header(), "2 due");
  h.click(REVEAL);
  await h.flush();
  h.click("Good, next review in 1 day");
  await h.flush();
  assert.equal(sent.length, 1);
  assert.equal(header(), "2 due", "the queue did not advance");
  assert.match(h.text(), /Synthetic passage 1/);
  assert.match(h.text(), /Synthetic note 1/, "the revealed note stays on screen");
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0], /Not saved: No answer from Onyx/);
  assert.equal(events.graded.length, 0);
  h.click("Retry Good");
  await h.flush();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], sent[0], "the retry is the identical request (same op_key)");
  assert.ok(P.isOpKey(sent[0].op_key));
  assert.equal(sent[0].expected_review_count, 0);
  assert.deepEqual(events.graded, [15], "advanced once, with the server's XP");
  assert.equal(header(), "1 due");
  assert.match(h.text(), /Synthetic passage 2/);
  assert.equal(alerts().length, 0);
  assert.ok(h.buttons(REVEAL).length === 1, "the next card starts hidden (focus target: its reveal button)");
});

test("a pending grade blocks every grade button and says why; a second tap sends nothing", async (t) => {
  const gate = deferred();
  const { h, sent, events } = mount(t, { answer: () => gate.promise });
  await h.flush();
  h.click(REVEAL);
  await h.flush();
  h.click("Good, next review in 1 day");
  await h.flush();
  assert.match(h.text(), /Saving your Good grade\. The grade buttons wait until Onyx answers\./);
  for (const label of ["Again, next review in 1 day", "Good, next review in 1 day", "Easy, next review in 3 days"]) {
    const b = h.button(label);
    assert.equal(b.props["aria-disabled"], true, `${label} is aria-disabled (it keeps focus)`);
    b.props.onClick();
  }
  await h.flush();
  assert.equal(sent.length, 1, "no concurrent grade");
  gate.resolve(response({ success: true, xp_gained: 0, op_key: sent[0].op_key }));
  await h.flush();
  assert.deepEqual(events.graded, [0]);
});

test("a different grade after an unconfirmed try reuses the key; key_reused means the first one was stored", async (t) => {
  const { h, sent, events, alerts } = mount(t, {
    answer: (body, n) => (n === 1 ? response({ error: "failed" }, 500) : response({ error: "key_reused" }, 409)),
  });
  await h.flush();
  h.click(REVEAL);
  await h.flush();
  h.click("Good, next review in 1 day");
  await h.flush();
  assert.match(alerts()[0], /couldn't confirm/);
  h.click("Easy, next review in 3 days");
  await h.flush();
  assert.equal(sent[1].op_key, sent[0].op_key);
  assert.equal(sent[1].grade, "easy");
  assert.deepEqual(events.graded, [0], "the card is graded (by the earlier try): advance, no XP claimed");
  assert.match(h.text(), /Synthetic passage 2/);
});

test("a refusal writes nothing: no Retry, any grade can be picked, and the next try has a new key", async (t) => {
  const { h, sent, alerts } = mount(t, { answer: (body, n) => (n === 1 ? response({ error: "bad_request" }, 400) : ok(body)) });
  await h.flush();
  h.click(REVEAL);
  await h.flush();
  h.click("Again, next review in 1 day");
  await h.flush();
  assert.match(alerts()[0], /Not saved: Onyx refused this grade\. Nothing was saved\. Pick a grade again\./);
  assert.equal(h.buttons("Retry Again").length, 0);
  h.click("Good, next review in 1 day");
  await h.flush();
  assert.notEqual(sent[1].op_key, sent[0].op_key);
});

test("graded on another screen: the card stays, grades are blocked, Refresh re-reads", async (t) => {
  const { h, sent, events, alerts } = mount(t, { answer: () => response({ error: "changed" }, 409) });
  await h.flush();
  h.click(REVEAL);
  await h.flush();
  h.click("Good, next review in 1 day");
  await h.flush();
  assert.match(alerts()[0], /graded on another screen/);
  assert.equal(h.button("Good, next review in 1 day").props["aria-disabled"], true);
  h.button("Good, next review in 1 day").props.onClick();
  await h.flush();
  assert.equal(sent.length, 1);
  h.click("Refresh");
  await h.flush();
  assert.equal(events.refreshed, 1);
});

test("the last card: success shows the Nothing due line (the focus target)", async (t) => {
  const { h, events } = mount(t, { due: [card(1)], answer: ok });
  await h.flush();
  h.click(REVEAL);
  await h.flush();
  h.click("Good, next review in 1 day");
  await h.flush();
  assert.deepEqual(events.graded, [15]);
  const done = h.find((n) => n.type === "p" && /Nothing due/.test(h.text(n)));
  assert.equal(done.length, 1);
  assert.equal(done[0].props.tabIndex, -1);
});

// The harness renders no DOM and never assigns refs, so a test puts a recording stand-in in each ref object (the
// same object is reused on every render) and reads which element the card asked to focus.
const recordFocus = (node, name, log) => {
  assert.ok(node.props.ref && typeof node.props.ref === "object", `${name} carries a ref`);
  node.props.ref.current = { focus: () => log.push(name) };
};

test("a Retry that fails again puts focus on the new Retry button, and the failure is one alert", async (t) => {
  const focused = [];
  const { h, sent, alerts } = mount(t, {
    answer: () => {
      throw new TypeError("offline");
    },
  });
  await h.flush();
  h.click(REVEAL);
  await h.flush();
  h.click("Good, next review in 1 day");
  await h.flush();
  recordFocus(h.button("Retry Good"), "retry", focused);
  h.click("Retry Good");
  await h.flush();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].op_key, sent[0].op_key, "the retry reuses the key");
  assert.deepEqual(focused, ["retry"], "focus returns to Retry instead of dropping to the page");
  assert.equal(alerts().length, 1, "one alert for the failure on screen");
});

test("Refresh puts focus on the note, then on the next card once the re-read overview replaces this one", async (t) => {
  const focused = [];
  withGlobals(t, { fetch: async () => response({ error: "changed" }, 409) });
  const props = { o: overview([card(1), card(2)]), onGraded: () => {}, onRefresh: () => (props.o = overview([card(2)])) };
  const h = mountClient("app/reading/ReviewCard.tsx", { props, stubs: { "lucide-react": { AlertTriangle: () => null } } });
  await h.flush();
  recordFocus(h.button(REVEAL), "reveal", focused);
  h.click(REVEAL);
  await h.flush();
  recordFocus(h.find((n) => n.type === "p" && n.props.tabIndex === -1 && /Synthetic note 1/.test(h.text(n)))[0], "note", focused);
  focused.length = 0;
  h.click("Good, next review in 1 day");
  await h.flush();
  assert.match(h.text(), /graded on another screen/);
  h.click("Refresh");
  await h.flush();
  assert.deepEqual(focused, ["note", "reveal"], "note while the overview is re-read, then the next card's reveal button");
  assert.match(h.text(), /Synthetic passage 2/);
  assert.equal(h.find((n) => n.props.role === "alert").length, 0, "the next card starts without the old message");
});

test("pure helpers: answer classification, key reuse, and a graded card never returns from a stale reload", () => {
  assert.equal(P.classifyReviewAnswer(null, null).kind, "unknown");
  assert.equal(P.classifyReviewAnswer(500, { error: "failed" }).kind, "unknown");
  assert.equal(P.classifyReviewAnswer(503, { error: "practice_unavailable" }).kind, "unknown");
  assert.equal(P.classifyReviewAnswer(400, { error: "bad_grade" }).kind, "refused");
  assert.equal(P.classifyReviewAnswer(404, { error: "not_found" }).kind, "stale");
  assert.equal(P.classifyReviewAnswer(409, { error: "archived" }).message, "This highlight was removed.");
  assert.deepEqual(P.classifyReviewAnswer(409, { error: "key_reused" }), { kind: "saved", xp: 0, replayed: true, earlier: true });
  assert.deepEqual(P.classifyReviewAnswer(200, { success: true, xp_gained: 15, replayed: true }), { kind: "saved", xp: 15, replayed: true, earlier: false });
  let n = 0;
  const mk = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const a = P.attemptFor(null, { highlight_id: 1, review_count: 0 }, "good", mk);
  assert.equal(P.attemptFor(a, { highlight_id: 1, review_count: 0 }, "easy", mk).op_key, a.op_key);
  assert.notEqual(P.attemptFor(a, { highlight_id: 2, review_count: 0 }, "good", mk).op_key, a.op_key);
  assert.notEqual(P.attemptFor(a, { highlight_id: 1, review_count: 1 }, "good", mk).op_key, a.op_key, "a newer state of the card is a new operation");
  assert.deepEqual(P.remainingQueue([card(1), card(2)], new Set([1])).map((c) => c.highlight_id), [2]);
});

test("source pins: the page uses the card file; no empty catch that swallows a failed grade", () => {
  const page = fs.readFileSync(path.join(SRC, "app/reading/ReadingClient.tsx"), "utf8");
  assert.match(page, /import ReviewCard from "\.\/ReviewCard";/);
  assert.match(page, /<ReviewCard o=\{o\} onGraded=\{[^]*?\} onRefresh=\{\(\) => load\(slug, true\)\} \/>/);
  assert.doesNotMatch(page, /toast handled by parent reload/);
  const src = fs.readFileSync(path.join(SRC, "app/reading/ReviewCard.tsx"), "utf8");
  assert.doesNotMatch(src, /catch\s*\{\s*\/\*/, "no silent catch");
  assert.doesNotMatch(src, /\sdisabled=\{/,"grade buttons use aria-disabled so a pressed button keeps focus");
  assert.match(src, /role="alert"/);
});
