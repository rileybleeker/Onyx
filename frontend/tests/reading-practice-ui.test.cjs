// READ-QUIZ-01 S4: the /reading Practice UI. The real components (PracticeRunner, PracticeCards, PracticePart,
// BankApproval) and lib/reading-practice-client.ts under the hook harness: the answer stays hidden until Check or
// "I don't know"; Skip stores nothing; a failure keeps the card and Retry sends the SAME request; the verdict is
// announced once; focus moves predictably; Show choices sets hinted; Disagree once; a flag inside 8 s + Undo sends
// nothing; held flags and unconfirmed answers go out with keepalive when the page hides; the 390 px classes; the keys.
// Synthetic data only (invented prompts and answers); no network, no storage.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { loadTs } = require("./helpers/load-ts.cjs");
const { mountClient, response, deferred, withGlobals } = require("./helpers/hook-harness.cjs");

const C = loadTs("lib/reading-practice-client.ts");
const R = loadTs("lib/reading-recall.ts");

const TODAY = "2026-03-10"; // a Tuesday
const ROUND_KEY = "0f0e0d0c-0b0a-4908-8706-050403020100";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ------------------------------------------------------------------ */
/* Fixtures                                                             */
/* ------------------------------------------------------------------ */

const preview = (stage = 0) => ({
  counts: true,
  next: {
    correct: { next_review: "2026-03-11", interval_days: 1, stage: Math.max(2, stage) },
    partial: { next_review: "2026-03-11", interval_days: 1, stage: Math.max(1, stage) },
    incorrect: { next_review: "2026-03-11", interval_days: 1, stage: Math.max(1, stage - 1) },
    dont_know: { next_review: "2026-03-11", interval_days: 1, stage: Math.max(1, stage - 1) },
  },
});
const cuedRubric = (n) => ({ v: 1, format: "cued", answer: `alpha ${n}`, accept: [], options: [`alpha ${n}`, "beta", "gamma", "delta"], correct: 0, explanation: `Synthetic explanation ${n}.` });
const webSource = { kind: "web", url: "https://example.org/guide", domain: "example.org", title: "Synthetic guide", cited_text: "Synthetic snippet.", highlight_id: null, passage: null, location: null, page: null };

function cued(n, o = {}) {
  return {
    key: `idea:${n}`,
    kind: "idea",
    chapter: o.chapter ?? n,
    format: "cued",
    slot: "due",
    done: false,
    attempt_key: null,
    question: { question_id: 100 + n, version: 1, format: "cued", prompt: `Synthetic prompt ${n}?`, rubric: cuedRubric(n) },
    again_question: o.again === false ? null : { question_id: 200 + n, version: 1, format: "cued", prompt: `Synthetic variant ${n}?`, rubric: cuedRubric(n) },
    idea: { idea_id: n, chapter: o.chapter ?? n, importance: "core", kind: "concept", title: `Synthetic idea ${n}`, statement: `Synthetic statement ${n}.`, key_points: [], stage: 0 },
    recall: null,
    highlight: null,
    sources: [webSource],
    source_count: 1,
    preview: preview(0),
    review_preview: null,
    ...(o.card ?? {}),
  };
}
function explain(n) {
  return {
    ...cued(n, { again: false }),
    format: "explain",
    question: {
      question_id: 100 + n,
      version: 2,
      format: "explain",
      prompt: `Explain synthetic idea ${n} in your own words.`,
      rubric: { v: 1, format: "explain", points: [{ id: "p1", text: "Synthetic point one", must: true }, { id: "p2", text: "Synthetic point two", must: false }], explanation: "Synthetic explanation." },
    },
  };
}
function highlightCard(n) {
  return {
    key: `highlight:${n}`,
    kind: "highlight",
    chapter: 2,
    format: "highlight",
    slot: "highlight",
    done: false,
    attempt_key: null,
    question: null,
    again_question: null,
    idea: null,
    recall: null,
    highlight: { highlight_id: n, chapter: 2, passage: `Synthetic passage ${n}`, comment: `Synthetic note ${n}`, location: null, page: 52, review_count: 0, interval_days: 0, ease: 2.5, next_review: null },
    sources: [],
    source_count: 0,
    preview: null,
    review_preview: {
      again: { ease: 2.3, interval_days: 1, review_count: 1, next_review: "2026-03-11" },
      good: { ease: 2.5, interval_days: 1, review_count: 1, next_review: "2026-03-11" },
      easy: { ease: 2.65, interval_days: 3, review_count: 1, next_review: "2026-03-13" },
    },
  };
}
const round = (cards, o = {}) => ({
  today: TODAY,
  quiz_through: 9,
  enabled: true,
  round_key: ROUND_KEY,
  kind: "daily",
  n: 0,
  cards,
  done: cards.filter((c) => c.done).length,
  minutes: 4,
  extra_available: o.extra ?? 0,
  chapter_recall: null,
});

/** The server's receipt for an answer: the same code grade the browser ran, or pending for the model. */
function serverReceipt(cards, body, o = {}) {
  const q = cards.flatMap((c) => [c.question, c.again_question]).find((x) => x && x.question_id === body.question_id);
  const g = R.gradeLocal(q.format, q.rubric, body.answer, body.hinted);
  return {
    success: true,
    attempt_key: body.attempt_key,
    grading_status: g.kind === "graded" ? "graded" : "pending",
    verdict: g.kind === "graded" ? g.verdict : null,
    score: g.kind === "graded" ? g.score : null,
    attempt_date: TODAY,
    next_review: g.kind === "graded" ? "2026-03-11" : null,
    hinted: body.hinted,
    overridden: false,
    replayed: false,
    ...o,
  };
}

/* ------------------------------------------------------------------ */
/* Harness pieces                                                       */
/* ------------------------------------------------------------------ */

const ICONS = new Proxy({}, { get: () => function Icon() { return null; } });
const STUBS = {
  "lucide-react": ICONS,
  "@/components/InfoHint": function InfoHint() {
    return null;
  },
  "@/components/MetricRing": function MetricRing(p) {
    return React.createElement("span", { "data-testid": "ring" }, p.centerValue);
  },
  "next/link": function Link(p) {
    return React.createElement("a", { href: p.href, className: p.className }, p.children);
  },
  "next/dynamic": () =>
    function DynamicRunner(p) {
      return React.createElement("div", { "data-testid": "runner-stub", "data-mode": p.mode });
    },
};

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
    pendingCount: () => pending.size,
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
function fakeTarget(extra = {}) {
  const handlers = {};
  return Object.assign(
    {
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
    },
    extra,
  );
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const keyEvent = (key, o = {}) => ({ key, target: { tagName: "BODY" }, preventDefault() {}, ...o });

function mountRunner(t, { cards, answer, poll, override, review, flagAnswer, win, doc, extra = 0, onReread, mode = "daily" } = {}) {
  const calls = [];
  const timers = fakeTimers();
  const count = (url) => calls.filter((c) => c.url === url).length;
  withGlobals(t, {
    fetch: async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url, method: init.method ?? "GET", body, keepalive: init.keepalive === true });
      if (url === C.ATTEMPT_URL) return answer ? answer(body, count(url)) : response(serverReceipt(cards, body));
      if (url.startsWith("/api/reading/practice/round/")) return poll ? poll(calls) : response({ round_key: ROUND_KEY, attempts: [] });
      if (url === C.FLAG_URL) return flagAnswer ? flagAnswer(body) : response({ success: true, kind: body.kind, invalidated: 0, replayed: false });
      if (url.endsWith("/override")) return override ? override(body, url) : response({ success: true, attempt_key: url.split("/")[5], grading_status: "graded", verdict: body.verdict ?? body.self_grade, score: 1, attempt_date: TODAY, next_review: "2026-03-12" });
      if (url === C.REVIEW_URL) return review ? review(body, count(url)) : response({ success: true, xp_gained: 15, next_review: "2026-03-11", interval_days: 1, op_key: body.op_key, replayed: false });
      throw new Error(`unexpected fetch ${url}`);
    },
    ...(win ? { window: win } : {}),
    ...(doc ? { document: doc } : {}),
  });
  const closed = [];
  const h = mountClient("app/reading/PracticeRunner.tsx", {
    props: { round: round(cards, { extra }), mode, onClose: (changed, finished) => closed.push({ changed, finished }), onMore: () => undefined, onReread, timers },
    stubs: STUBS,
  });
  const attempts = () => calls.filter((c) => c.url === C.ATTEMPT_URL);
  const flagsSent = () => calls.filter((c) => c.url === C.FLAG_URL);
  const live = () => h.find((n) => n.props["aria-live"] === "polite");
  const alerts = () => h.find((n) => n.props.role === "alert").map((n) => h.text(n));
  const root = () => h.find((n) => n.props["data-testid"] === "practice-runner")[0];
  return { h, calls, timers, closed, attempts, flagsSent, live, alerts, root };
}

function typeAnswer(h, text) {
  const ta = h.find((n) => n.type === "textarea")[0];
  assert.ok(ta, "a text box for the answer");
  ta.props.onChange({ target: { value: text } });
}
function menu(h, item) {
  h.click("More actions");
  return h.flush().then(() => {
    h.click(item);
    return h.flush();
  });
}
// The ref objects stay the same across renders: install a stand-in element and record what the runner focuses.
function recordFocus(node, name, log) {
  assert.ok(node?.props?.ref, `${name} carries a ref`);
  node.props.ref.current = { focus: () => log.push(name) };
}
const prompt = (h) => h.find((n) => n.type === "h2" && n.props.tabIndex === -1)[0];

/* ------------------------------------------------------------------ */
/* Runner                                                               */
/* ------------------------------------------------------------------ */

test("the answer stays hidden until Check; the code verdict shows before the POST returns; the server's receipt then counts", async (t) => {
  const gate = deferred();
  const cards = [cued(1), cued(2)];
  const r = mountRunner(t, { cards, answer: (b) => gate.promise.then(() => response(serverReceipt(cards, b))) });
  await r.h.flush();
  assert.match(r.h.text(), /Synthetic prompt 1\?/);
  for (const hiddenText of [/Answer: alpha 1/, /Synthetic explanation 1/, /Synthetic snippet/, /Right/]) assert.doesNotMatch(r.h.text(), hiddenText);
  assert.equal(r.h.button("Check").props.disabled, true, "nothing to check yet");
  typeAnswer(r.h, "alpha 1");
  await r.h.flush();
  r.h.click("Check");
  await r.h.flush();
  assert.match(r.h.text(), /Right/, "the code verdict is on screen before the POST answered");
  assert.match(r.h.text(), /Answer: alpha 1/);
  assert.match(r.h.text(), /Synthetic explanation 1\./);
  assert.equal(r.h.button("Next").props["aria-disabled"], true, "Next waits for the save (one request at a time)");
  gate.resolve();
  await r.h.flush();
  assert.equal(r.h.button("Next").props["aria-disabled"], undefined);
  assert.match(r.h.text(), /Next: tomorrow/);
  const [a] = r.attempts();
  assert.equal(r.attempts().length, 1);
  assert.ok(UUID_RE.test(a.body.attempt_key));
  assert.deepEqual(
    { question_id: a.body.question_id, version: a.body.version, round_key: a.body.round_key, round_date: a.body.round_date, round_kind: a.body.round_kind, answer: a.body.answer, hinted: a.body.hinted },
    { question_id: 101, version: 1, round_key: ROUND_KEY, round_date: TODAY, round_kind: "daily", answer: "alpha 1", hinted: false },
  );
  assert.equal(typeof a.body.response_ms, "number");
  assert.equal(Object.keys(a.body).sort().join(","), "answer,attempt_key,hinted,question_id,response_ms,round_date,round_key,round_kind,version", "only the route's fields");
});

test('"I don\'t know" stores an answer graded incorrect and reveals the reference', async (t) => {
  const cards = [cued(1), cued(2)];
  const r = mountRunner(t, { cards });
  await r.h.flush();
  assert.doesNotMatch(r.h.text(), /Answer: alpha 1/);
  r.h.click("I don't know");
  await r.h.flush();
  assert.equal(r.attempts()[0].body.answer, R.DONT_KNOW_ANSWER);
  assert.match(r.h.text(), /Not quite/);
  assert.match(r.h.text(), /Answer: alpha 1/);
});

test("Skip for now stores nothing: the card moves to the end, a second Skip takes it out of today's round", async (t) => {
  const r = mountRunner(t, { cards: [cued(1), cued(2)] });
  await r.h.flush();
  assert.match(r.h.text(), /Synthetic prompt 1\?/);
  await menu(r.h, "Skip for now");
  assert.match(r.h.text(), /Synthetic prompt 2\?/);
  await menu(r.h, "Skip for now");
  assert.match(r.h.text(), /Synthetic prompt 1\?/, "the skipped card comes back at the end");
  assert.doesNotMatch(r.h.text(), /Answer: alpha 1/, "its answer is still hidden");
  await menu(r.h, "Skip for now");
  assert.match(r.h.text(), /Synthetic prompt 2\?/);
  await menu(r.h, "Skip for now");
  assert.match(r.h.text(), /Round done/);
  assert.match(r.h.text(), /0 of 2/);
  assert.equal(r.calls.length, 0, "no request at all");
});

test("a lost answer keeps the card; Retry sends the SAME request; a later success counts once", async (t) => {
  const cards = [cued(1), cued(2)];
  const r = mountRunner(t, {
    cards,
    answer: (b, n) => {
      if (n === 1) throw new TypeError("offline");
      return response(serverReceipt(cards, b));
    },
  });
  await r.h.flush();
  typeAnswer(r.h, "alpha 1");
  await r.h.flush();
  r.h.click("Check");
  await r.h.flush();
  assert.match(r.h.text(), /Synthetic prompt 1\?/, "the card stays");
  assert.equal(r.alerts().length, 1);
  assert.match(r.alerts()[0], /Not sure it saved: No answer from Onyx/, "an uncertain outcome is not called 'Not saved'");
  assert.equal(r.h.button("Next").props["aria-disabled"], true);
  r.h.click("Retry");
  await r.h.flush();
  assert.equal(r.attempts().length, 2);
  assert.deepEqual(r.attempts()[1].body, r.attempts()[0].body, "identical request: same attempt_key, same answer, same response time");
  assert.equal(r.alerts().length, 0);
  assert.equal(r.h.button("Next").props["aria-disabled"], undefined);
  assert.match(r.h.text(), /Right/);
});

test("a refusal stored nothing: no Retry, the answer can be changed and checked again under a new key", async (t) => {
  const cards = [cued(1), cued(2)];
  const r = mountRunner(t, { cards, answer: (b, n) => (n === 1 ? response({ error: "bad_answer" }, 400) : response(serverReceipt(cards, b))) });
  await r.h.flush();
  typeAnswer(r.h, "alpha 1");
  await r.h.flush();
  r.h.click("Check");
  await r.h.flush();
  assert.match(r.alerts()[0], /Not saved: Onyx refused this answer\. Nothing was saved\./);
  assert.equal(r.h.buttons("Retry").length, 0);
  const ta = r.h.find((n) => n.type === "textarea")[0];
  assert.equal(ta.props.readOnly, false, "the answer can be edited again");
  typeAnswer(r.h, "alpha 1 ");
  await r.h.flush();
  r.h.click("Check");
  await r.h.flush();
  assert.equal(r.attempts().length, 2);
  assert.notEqual(r.attempts()[1].body.attempt_key, r.attempts()[0].body.attempt_key, "nothing was stored under the first key");
});

test("the verdict is announced once (one polite live region), for a code grade and for a model grade", async (t) => {
  const cards = [cued(1), explain(2)];
  const r = mountRunner(t, {
    cards,
    poll: () => {
      const key = r.attempts()[1]?.body.attempt_key;
      return response({
        round_key: ROUND_KEY,
        attempts: key
          ? [{ attempt_key: key, question_id: 102, grading_status: "graded", verdict: "partial", score: 0.5, hinted: false, feedback: "Synthetic feedback.", rubric_hits: [{ id: "p1", hit: "yes" }, { id: "p2", hit: "no" }], grader: "model", overridden: false, grade_error: null, overridable: true, self_gradable: false, covered_ideas: null }]
          : [],
      });
    },
  });
  await r.h.flush();
  assert.equal(r.live().length, 1, "one live region");
  typeAnswer(r.h, "alpha 1");
  await r.h.flush();
  r.h.click("Check");
  await r.h.flush();
  assert.equal(r.h.text(r.live()[0]), "Right.");
  await r.h.flush();
  assert.equal(r.h.text(r.live()[0]), "Right.", "the receipt does not announce it again");
  r.h.click("Next");
  await r.h.flush();
  typeAnswer(r.h, "A synthetic explanation of several words.");
  await r.h.flush();
  r.h.click("Check");
  await r.h.flush();
  assert.match(r.h.text(), /Saved · grading/, "a model grade is not awaited");
  assert.match(r.h.text(), /Synthetic point one/, "the key points show straight away");
  assert.equal(r.h.text(r.live()[0]), "", "nothing is announced before the grade");
  await r.timers.advance(C.POLL_EVERY_MS, r.h);
  assert.equal(r.h.text(r.live()[0]), "Partly.");
  assert.match(r.h.text(), /Synthetic feedback\./);
  assert.match(r.h.text(), /Covered/);
  assert.match(r.h.text(), /Missed/);
  const polls = r.calls.filter((c) => c.url.startsWith("/api/reading/practice/round/")).length;
  await r.timers.advance(C.POLL_EVERY_MS * 3, r.h);
  assert.equal(r.calls.filter((c) => c.url.startsWith("/api/reading/practice/round/")).length, polls, "polling stops once nothing is pending");
  assert.equal(r.h.text(r.live()[0]), "Partly.");
  assert.equal(r.live().length, 1);
});

test("focus: Check moves it to Next, a failed Retry to the new Retry, Next to the next prompt", async (t) => {
  const cards = [cued(1), cued(2)];
  const focused = [];
  const r = mountRunner(t, {
    cards,
    answer: (b, n) => {
      if (n <= 2) throw new TypeError("offline");
      return response(serverReceipt(cards, b));
    },
  });
  await r.h.flush();
  typeAnswer(r.h, "alpha 1");
  await r.h.flush();
  r.h.click("Check");
  await r.h.flush();
  recordFocus(r.h.button("Next"), "next", focused);
  recordFocus(r.h.button("Retry"), "retry", focused);
  recordFocus(prompt(r.h), "prompt", focused);
  r.h.click("Retry");
  await r.h.flush();
  assert.deepEqual(focused, ["next", "retry"], "Next while it saves, then the Retry button again");
  focused.length = 0;
  r.h.click("Retry");
  await r.h.flush();
  assert.deepEqual(focused, ["next"]);
  focused.length = 0;
  r.h.click("Next");
  await r.h.flush();
  assert.deepEqual(focused, ["prompt"], "the next card's prompt");
  assert.match(r.h.text(), /Synthetic prompt 2\?/);
});

test("Show choices turns a recall card into 4 options (keys 1-4, Enter checks); the answer is sent hinted", async (t) => {
  const win = fakeTarget();
  const cards = [cued(1), cued(2)];
  const r = mountRunner(t, { cards, win });
  await r.h.flush();
  await menu(r.h, "Show choices");
  const radios = () => r.h.find((n) => n.type === "button" && n.props.role === "radio");
  assert.equal(radios().length, 4);
  assert.equal(r.h.find((n) => n.type === "textarea").length, 0);
  win.fire("keydown", keyEvent("1"));
  await r.h.flush();
  assert.equal(radios()[0].props["aria-checked"], true);
  win.fire("keydown", keyEvent("Enter"));
  await r.h.flush();
  const [a] = r.attempts();
  assert.equal(a.body.hinted, true);
  assert.equal(a.body.answer, "alpha 1");
  assert.match(r.h.text(), /Partly/, "a right choice after a hint is partial");
  assert.match(r.h.text(), /Answer/, "the right option is marked");
});

test("Disagree: once, on a model grade; the new verdict replaces the shown one", async (t) => {
  const cards = [explain(1), cued(2)];
  let gradedKey = null;
  const r = mountRunner(t, {
    cards,
    poll: () =>
      response({
        round_key: ROUND_KEY,
        attempts: gradedKey
          ? [{ attempt_key: gradedKey, question_id: 101, grading_status: "graded", verdict: "incorrect", score: 0.2, hinted: false, feedback: null, rubric_hits: [{ id: "p1", hit: "no" }, { id: "p2", hit: "yes" }], grader: "model", overridden: false, grade_error: null, overridable: true, self_gradable: false, covered_ideas: null }]
          : [],
      }),
  });
  await r.h.flush();
  typeAnswer(r.h, "A synthetic explanation of several words.");
  await r.h.flush();
  r.h.click("Check");
  await r.h.flush();
  gradedKey = r.attempts()[0].body.attempt_key;
  await r.timers.advance(C.POLL_EVERY_MS, r.h);
  assert.match(r.h.text(), /Not quite/);
  assert.match(r.h.text(), /Disagree\?/);
  assert.equal(r.h.buttons("Missed").length, 0, "the verdict already given is not offered");
  r.h.click("Correct");
  await r.h.flush();
  const o = r.calls.find((c) => c.url.endsWith("/override"));
  assert.equal(o.url, `/api/reading/practice/attempt/${gradedKey}/override`);
  assert.deepEqual(o.body, { verdict: "correct" });
  assert.match(r.h.text(), /Right/);
  assert.match(r.h.text(), /Changed by you/);
  assert.doesNotMatch(r.h.text(), /Disagree\?/, "once");
});

test("a flag is held 8 s: Undo inside it sends nothing and brings the card back; otherwise it is sent once", async (t) => {
  const r = mountRunner(t, { cards: [cued(1), cued(2)] });
  await r.h.flush();
  await menu(r.h, "Wrong");
  assert.match(r.h.text(), /Synthetic prompt 2\?/, "the flagged card leaves at once");
  assert.match(r.h.text(), /Flagged · Wrong/);
  r.h.click("Undo");
  await r.h.flush();
  assert.match(r.h.text(), /Synthetic prompt 1\?/, "Undo brings it back");
  await r.timers.advance(C.FLAG_HOLD_MS + 1000, r.h);
  assert.equal(r.flagsSent().length, 0, "an undone flag never leaves the page");
  await menu(r.h, "Unclear");
  await r.timers.advance(C.FLAG_HOLD_MS - 1, r.h);
  assert.equal(r.flagsSent().length, 0, "still held");
  await r.timers.advance(1, r.h);
  assert.equal(r.flagsSent().length, 1);
  const f = r.flagsSent()[0];
  assert.deepEqual({ question_id: f.body.question_id, kind: f.body.kind, keepalive: f.keepalive }, { question_id: 101, kind: "unclear", keepalive: false });
  assert.ok(UUID_RE.test(f.body.flag_key));
  assert.deepEqual(Object.keys(f.body).sort(), ["flag_key", "kind", "question_id"]);
  assert.doesNotMatch(r.h.text(), /Flagged · Unclear/, "sent: the Undo bar is gone");
  assert.doesNotMatch(r.h.text(), /Synthetic prompt 1\?/, "a sent flag keeps the card out");
});

test("the page hiding re-sends an unconfirmed answer with keepalive (the same request)", async (t) => {
  const win = fakeTarget();
  const doc = fakeTarget({ visibilityState: "visible", documentElement: { style: {} }, body: { style: {} } });
  const cards = [cued(1), cued(2), cued(3)];
  const r = mountRunner(t, {
    cards,
    win,
    doc,
    answer: (b, n) => {
      if (n === 1) throw new TypeError("offline");
      return response(serverReceipt(cards, b));
    },
  });
  await r.h.flush();
  typeAnswer(r.h, "alpha 1");
  await r.h.flush();
  r.h.click("Check");
  await r.h.flush();
  assert.match(r.alerts()[0], /Not sure it saved/);
  // One request at a time: while the answer is unconfirmed the card cannot be flagged or skipped.
  r.h.click("More actions");
  await r.h.flush();
  assert.equal(r.h.buttons("Wrong").length, 0);
  assert.equal(r.h.buttons("Skip for now").length, 0);
  r.h.click("More actions");
  await r.h.flush();
  doc.visibilityState = "hidden";
  doc.fire("visibilitychange");
  await r.h.flush();
  const resent = r.attempts().filter((c) => c.keepalive);
  assert.equal(resent.length, 1);
  assert.deepEqual(resent[0].body, r.attempts()[0].body, "the same request, with keepalive");
});

test("a held flag goes out with keepalive when the page hides, and when the runner closes", async (t) => {
  const win = fakeTarget();
  const doc = fakeTarget({ visibilityState: "visible", documentElement: { style: {} }, body: { style: {} } });
  const r = mountRunner(t, { cards: [cued(1), cued(2), cued(3)], win, doc });
  await r.h.flush();
  await menu(r.h, "Unclear");
  doc.visibilityState = "hidden";
  doc.fire("visibilitychange");
  await r.h.flush();
  assert.equal(r.flagsSent().length, 1);
  assert.equal(r.flagsSent()[0].keepalive, true);
  doc.visibilityState = "visible";
  await menu(r.h, "Wrong");
  assert.equal(r.flagsSent().length, 1);
  r.h.unmount();
  await r.h.flush();
  assert.equal(r.flagsSent().length, 2, "closing sends the flag still held");
  assert.equal(r.flagsSent()[1].body.kind, "wrong");
});

test("Not read yet holds the card's chapter and every later one; after it is sent the round is re-read", async (t) => {
  let reread = 0;
  const cards = [cued(1, { chapter: 3 }), cued(2, { chapter: 1 }), cued(3, { chapter: 5 }), highlightCard(9)];
  const r = mountRunner(t, {
    cards,
    onReread: async () => {
      reread += 1;
      return round([cards[1], cards[3]]);
    },
  });
  await r.h.flush();
  assert.match(r.h.text(), /Synthetic prompt 1\?/);
  await menu(r.h, "Not read yet");
  assert.match(r.h.text(), /Synthetic prompt 2\?/, "chapter 1 is still asked");
  assert.match(r.h.text(), /1 \/ 2/, "chapters 3 and 5 left; the highlight review stays");
  await r.timers.advance(C.FLAG_HOLD_MS, r.h);
  assert.equal(r.flagsSent()[0].body.kind, "not_read_yet");
  assert.equal(r.flagsSent()[0].body.question_id, 101);
  assert.equal(reread, 1);
});

test("an incorrect answer brings the idea back once at the end with its other variant; that repeat moves no schedule", async (t) => {
  const r = mountRunner(t, { cards: [cued(1), cued(2, { again: false })] });
  await r.h.flush();
  typeAnswer(r.h, "zzz");
  await r.h.flush();
  r.h.click("Check");
  await r.h.flush();
  assert.match(r.h.text(), /Not quite/);
  assert.match(r.h.text(), /1 \/ 3/, "the repeat joins the round at the end");
  r.h.click("Next");
  await r.h.flush();
  typeAnswer(r.h, "alpha 2");
  await r.h.flush();
  r.h.click("Check");
  await r.h.flush();
  r.h.click("Next");
  await r.h.flush();
  assert.match(r.h.text(), /Synthetic variant 1\?/);
  typeAnswer(r.h, "zzz");
  await r.h.flush();
  r.h.click("Check");
  await r.h.flush();
  assert.match(r.h.text(), /Schedule unchanged today/);
  assert.match(r.h.text(), /3 \/ 3/, "only once");
  assert.equal(r.attempts()[2].body.question_id, 201);
  r.h.click("Next");
  await r.h.flush();
  assert.match(r.h.text(), /Round done/);
});

test("the summary: answered of total, practice XP, ideas moved up, next due; Done closes with changed + finished", async (t) => {
  const r = mountRunner(t, { cards: [cued(1), cued(2)], extra: 3 });
  await r.h.flush();
  for (const n of [1, 2]) {
    typeAnswer(r.h, `alpha ${n}`);
    await r.h.flush();
    r.h.click("Check");
    await r.h.flush();
    r.h.click("Next");
    await r.h.flush();
  }
  const text = r.h.text();
  assert.match(text, /Round done/);
  assert.match(text, /2 of 2 · \+4 XP/);
  assert.match(text, /2 ideas moved up/);
  assert.match(text, /Next due Wed/);
  assert.equal(r.h.buttons("One more round").length, 1);
  r.h.click("Done");
  assert.deepEqual(r.closed, [{ changed: true, finished: true }]);
});

test("a resumed round skips the cards answered earlier today and counts them as done", async (t) => {
  const done = cued(1, { card: { done: true, attempt_key: "1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a" } });
  const r = mountRunner(t, { cards: [done, cued(2)] });
  await r.h.flush();
  assert.match(r.h.text(), /Synthetic prompt 2\?/);
  assert.match(r.h.text(), /2 \/ 2/);
});

test("a highlight review in the round: reveal, then Again / Good / Easy; a lost grade retries with the same op_key", async (t) => {
  const r = mountRunner(t, {
    cards: [highlightCard(7), cued(2)],
    review: (b, n) => {
      if (n === 1) throw new TypeError("offline");
      return response({ success: true, xp_gained: 15, next_review: "2026-03-11", interval_days: 1, op_key: b.op_key, replayed: false });
    },
  });
  await r.h.flush();
  assert.match(r.h.text(), /Your highlight · Ch 2 · p\. 52/);
  assert.doesNotMatch(r.h.text(), /Synthetic note 7/);
  r.h.click("Say what this means, then reveal your note");
  await r.h.flush();
  assert.match(r.h.text(), /Synthetic note 7/);
  r.h.click("Good, next review in 1 day");
  await r.h.flush();
  assert.match(r.alerts()[0], /Not sure it saved/);
  r.h.click("Retry");
  await r.h.flush();
  const sent = r.calls.filter((c) => c.url === C.REVIEW_URL);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].body, sent[0].body, "the same op_key and grade");
  assert.match(r.h.text(), /Saved · next in 1 day/);
});

test("keys on a desktop: Ctrl/Cmd+Enter checks a typed answer, N goes on (not while typing), Esc closes", async (t) => {
  const win = fakeTarget();
  const r = mountRunner(t, { cards: [cued(1), cued(2)], win });
  await r.h.flush();
  typeAnswer(r.h, "alpha 1");
  await r.h.flush();
  win.fire("keydown", keyEvent("Enter", { ctrlKey: true, target: { tagName: "TEXTAREA" } }));
  await r.h.flush();
  assert.equal(r.attempts().length, 1);
  win.fire("keydown", keyEvent("n", { target: { tagName: "TEXTAREA" } }));
  await r.h.flush();
  assert.match(r.h.text(), /Synthetic prompt 1\?/, "N while typing is a letter");
  win.fire("keydown", keyEvent("n"));
  await r.h.flush();
  assert.match(r.h.text(), /Synthetic prompt 2\?/);
  win.fire("keydown", keyEvent("Escape"));
  assert.deepEqual(r.closed, [{ changed: true, finished: false }]);
});

test("390 px: a full-screen sheet below md with safe-area padding, in place from md; 16 px input, 44 / 48 px targets", async (t) => {
  const r = mountRunner(t, { cards: [cued(1), cued(2)] });
  await r.h.flush();
  const cls = r.root().props.className;
  for (const c of ["fixed", "inset-0", "z-50", "pt-[env(safe-area-inset-top)]", "pb-[env(safe-area-inset-bottom)]", "md:relative", "md:inset-auto", "md:max-w-[640px]"]) {
    assert.ok(cls.split(/\s+/).includes(c), `runner class ${c}`);
  }
  assert.match(r.h.find((n) => n.type === "textarea")[0].props.className, /text-\[16px\]/);
  assert.match(prompt(r.h).props.className, /text-\[17px\]/);
  for (const label of ["Check", "I don't know", "More actions", "Close practice"]) assert.match(r.h.button(label).props.className, /min-h-11/, label);
  await menu(r.h, "Show choices");
  for (const b of r.h.find((n) => n.type === "button" && n.props.role === "radio")) assert.match(b.props.className, /min-h-12/);
});

/* ------------------------------------------------------------------ */
/* Practice part + approval                                             */
/* ------------------------------------------------------------------ */

const overview = { book: { book_id: 7, slug: "synthetic-book", title: "Synthetic", total_chapters: 12 }, today: TODAY };

function mountPart(t, { roundAnswer, bankAnswer, approval, cache = {} }) {
  const calls = [];
  withGlobals(t, {
    fetch: async (url, init = {}) => {
      calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
      if (url === C.APPROVAL_URL) return approval(JSON.parse(init.body));
      if (url.startsWith(C.PRACTICE_TODAY_URL)) return roundAnswer(url);
      if (url.startsWith(`${C.BANK_URL}?`) || url === C.BANK_URL) return bankAnswer(url, calls);
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  const store = { ...cache };
  const changed = [];
  const h = mountClient("app/reading/PracticePart.tsx", {
    props: { o: overview, review: React.createElement("p", null, "REVIEW CARD"), onChanged: () => changed.push(1) },
    stubs: {
      ...STUBS,
      "@/lib/client-cache": { clientCache: { peek: (k) => store[k], put: (k, v) => (store[k] = v), remove: (k) => delete store[k] } },
    },
  });
  return { h, calls, store, changed };
}
const bankBody = (o = {}) => ({ book_id: 7, enabled: false, paused_reason: null, approved_cents: null, spent_cents: 0, quiz_through: 4, chapters: [], estimate_cents: 1500, cap_cents: 1900, ...o });

test("practice part: with the SQL not applied the Review card stays exactly as before (no approval card)", async (t) => {
  const p = mountPart(t, { roundAnswer: () => response({ error: "bank_unavailable" }, 503), bankAnswer: () => response({ error: "bank_unavailable" }, 503) });
  await p.h.flush();
  assert.match(p.h.text(), /REVIEW CARD/);
  assert.doesNotMatch(p.h.text(), /Questions on every chapter|Turn on/);
  assert.deepEqual(p.calls.map((c) => c.method), ["GET", "GET"], "reads only");
  assert.deepEqual(p.calls.map((c) => c.url).sort(), [C.bankUrl("synthetic-book"), C.practiceUrl("synthetic-book")].sort());
});

test("practice part: bank off shows the approval card above the Review card; Turn on sends the shown cap; a moved estimate is re-read", async (t) => {
  let bankReads = 0;
  const p = mountPart(t, {
    roundAnswer: () => response({ ...round([]), enabled: false }),
    bankAnswer: () => response(bankBody(bankReads++ ? { estimate_cents: 1700, cap_cents: 2200 } : {})),
    approval: () => response({ error: "estimate_changed" }, 409),
  });
  await p.h.flush();
  assert.match(p.h.text(), /Questions on every chapter/);
  assert.match(p.h.text(), /About \$15 · cap \$19/);
  assert.match(p.h.text(), /REVIEW CARD/);
  p.h.click("Turn on");
  await p.h.flush();
  const put = p.calls.find((c) => c.url === C.APPROVAL_URL);
  assert.equal(put.method, "PUT");
  assert.deepEqual(put.body, { book: "synthetic-book", on: true, cap_cents: 1900 });
  assert.match(p.h.text(), /The estimate changed/);
  assert.match(p.h.text(), /About \$17 · cap \$22/, "the new numbers before asking again");
});

test("practice part: bank on shows today's round (ready, minutes, Start, Quick 3, the recall line) and opens the runner", async (t) => {
  const cards = [cued(1), cued(2), cued(3), cued(4), { ...cued(5), key: "recall:5", kind: "chapter_recall", format: "chapter_recall", recall: { chapter: 5, done_n: 0, due_on: TODAY, next_due_on: "2026-03-16" } }];
  const p = mountPart(t, { roundAnswer: () => response(round(cards)), bankAnswer: () => response(bankBody({ enabled: true, approved_cents: 1900 })) });
  await p.h.flush();
  assert.match(p.h.text(), /5 ready · about 4 min/);
  assert.match(p.h.text(), /Ch 5 recall · say what you remember/);
  assert.doesNotMatch(p.h.text(), /REVIEW CARD/, "highlight reviews are in the round");
  assert.equal(p.h.buttons("Quick 3").length, 1);
  p.h.click("Start");
  await p.h.flush();
  const stub = p.h.find((n) => n.props["data-testid"] === "runner-stub")[0];
  assert.ok(stub, "the runner opens in place");
  assert.equal(stub.props["data-mode"], "daily");
});

test("practice part: a cached round from another day is never shown; a budget pause offers Allow $N more", async (t) => {
  const stale = round([cued(1)]);
  stale.today = "2026-03-09";
  const gate = deferred();
  const p = mountPart(t, {
    cache: { [C.practiceUrl("synthetic-book")]: stale, [C.bankUrl("synthetic-book")]: bankBody({ enabled: true, paused_reason: "budget", spent_cents: 1900, cap_cents: 2500 }) },
    roundAnswer: () => gate.promise,
    bankAnswer: () => response(bankBody({ enabled: true, paused_reason: "budget", spent_cents: 1900, cap_cents: 2500 })),
  });
  await p.h.flush();
  assert.doesNotMatch(p.h.text(), /Synthetic prompt|1 ready/);
  assert.match(p.h.text(), /Loading today's round/);
  assert.match(p.h.text(), /Paused · budget reached/);
  assert.equal(p.h.buttons("Allow $6 more").length, 1);
  gate.resolve(response(round([])));
  await p.h.flush();
  assert.match(p.h.text(), /Nothing due/);
});

/* ------------------------------------------------------------------ */
/* lib/reading-practice-client.ts                                       */
/* ------------------------------------------------------------------ */

test("attempt answers: saved, not sure (Retry the same request), refused (nothing stored), left out", () => {
  const ok = { success: true, attempt_key: "1A1A1A1A-1A1A-4A1A-8A1A-1A1A1A1A1A1A", grading_status: "graded", verdict: "correct", score: 1, attempt_date: TODAY, next_review: "2026-03-11" };
  assert.equal(C.classifyAttemptAnswer(200, ok).kind, "saved");
  assert.equal(C.classifyAttemptAnswer(200, ok).receipt.attempt_key, ok.attempt_key.toLowerCase());
  assert.deepEqual(C.classifyAttemptAnswer(409, { error: "key_reused" }), { kind: "saved", receipt: null });
  for (const [status, body] of [[null, null], [503, { error: "bank_unavailable" }], [500, {}], [409, { error: "raced" }], [200, { nope: true }]]) {
    assert.equal(C.classifyAttemptAnswer(status, body).kind, "unknown", `${status} ${JSON.stringify(body)}`);
  }
  for (const [status, code] of [[400, "bad_answer"], [409, "bank_off"], [409, "quiz_closed"], [413, "too_large"], [403, "forbidden"]]) {
    assert.equal(C.classifyAttemptAnswer(status, { error: code }).kind, "refused", code);
  }
  for (const [status, code] of [[409, "question_changed"], [409, "retired"], [409, "locked"], [409, "chapter_changed"], [404, "not_found"]]) {
    assert.equal(C.classifyAttemptAnswer(status, { error: code }).kind, "stale", code);
  }
  assert.equal(C.classifyOverrideAnswer(409, { error: "already_overridden" }).kind, "refused");
  assert.equal(C.classifyOverrideAnswer(null, null).kind, "unknown");
  assert.equal(C.classifyFlagAnswer(200, { success: true, kind: "wrong", invalidated: 2 }).value.invalidated, 2);
  assert.equal(C.classifyApprovalAnswer(409, { error: "estimate_changed" }).kind, "changed");
  assert.equal(C.classifyApprovalAnswer(200, { on: true, cap_cents: 1900 }).kind, "saved");
});

test("order cards are offered shuffled (never in the answer's order), the same way for the same question and day", () => {
  for (let n = 3; n <= 7; n++) {
    const steps = Array.from({ length: n }, (_, i) => `step ${i}`);
    for (const seed of ["101|2026-03-10", "102|2026-03-10", "101|2026-03-11", "x"]) {
      const o = C.offeredOrder(steps, seed);
      assert.deepEqual([...o].sort((a, b) => a - b), steps.map((_, i) => i), "a permutation");
      assert.ok(o.some((v, i) => v !== i), `not the answer (${n}, ${seed})`);
      assert.deepEqual(C.offeredOrder(steps, seed), o, "deterministic");
    }
  }
});

test("the round GET is parsed defensively; progress and the day check", () => {
  const raw = round([cued(1), { key: "bad" }, { ...cued(2), done: true }]);
  const r = C.parseRound(raw);
  assert.equal(r.cards.length, 2, "a malformed card is left out");
  assert.deepEqual(C.roundProgress(r), { total: 2, done: 1, ready: 1, minutes: 4, recallChapter: null });
  assert.equal(C.roundForToday(r, TODAY), r);
  assert.equal(C.roundForToday(r, "2026-03-11"), null);
  assert.equal(C.parseRound({ error: "bank_unavailable" }), null);
  assert.equal(C.practiceUrl("synthetic-book"), "/api/reading/practice/today?book=synthetic-book");
  assert.equal(C.practiceUrl("synthetic-book", "extra", 2), "/api/reading/practice/today?book=synthetic-book&kind=extra&n=2");
  assert.equal(C.bankUrl("synthetic-book"), "/api/reading/bank?book=synthetic-book");
  assert.equal(C.readingSlugOf({ overview: { book: { slug: "synthetic-book" } } }), "synthetic-book");
  assert.equal(C.readingSlugOf({ overview: null }), null);
});

test("bank notices, most urgent first; money in whole dollars", () => {
  const b = (o) => C.parseBank(bankBody({ enabled: true, ...o }));
  assert.equal(C.bankNotice(b({ enabled: false })), null);
  assert.deepEqual(C.bankNotice(b({ paused_reason: "budget", spent_cents: 1900, cap_cents: 2500 })), { kind: "paused", moreCents: 600 });
  const chapters = [
    { chapter: 1, locked: false, status: "ready" },
    { chapter: 2, locked: false, status: "thin" },
    { chapter: 3, locked: false, status: "pending" },
    { chapter: 4, locked: true, status: "failed" },
  ];
  assert.deepEqual(C.bankNotice(b({ chapters })), { kind: "building", chapter: 3 }, "a locked chapter's failure is not shown");
  assert.deepEqual(C.bankNotice(b({ chapters: chapters.slice(0, 2) })), { kind: "thin", chapter: 2 });
  assert.equal(C.estimateDollars(1450), "$15");
  assert.equal(C.capDollars(1810), "$19");
});

test("the next line: the stored next review, the preview, or no change for a repeat", () => {
  const pv = preview(0);
  assert.equal(C.nextLine({ today: TODAY, verdict: "correct", preview: pv, receiptNext: "2026-03-13" }), "Next: in 3 days");
  assert.equal(C.nextLine({ today: TODAY, verdict: "correct", preview: pv, receiptNext: null }), "Next: tomorrow");
  assert.equal(C.nextLine({ today: TODAY, verdict: "correct", preview: { ...pv, counts: false }, receiptNext: null }), "Schedule unchanged today");
  assert.equal(C.nextLine({ today: TODAY, verdict: "correct", preview: pv, receiptNext: null, again: true }), "Schedule unchanged today");
});

test("the summary counts the day's first answers only and leaves grading answers out of XP", () => {
  const item = (o) => ({ roundCard: true, answered: true, counts: true, verdict: "correct", grading: false, stageBefore: 0, stageAfter: 2, nextReview: "2026-03-12", reviewXp: 0, ...o });
  const s = C.summarize(
    [item({}), item({ verdict: "partial", stageAfter: 1, nextReview: "2026-03-11" }), item({ counts: false }), item({ grading: true, verdict: null }), item({ answered: false, counts: false, verdict: null }), item({ roundCard: false, counts: false })],
    TODAY,
  );
  assert.deepEqual(s, { answered: 4, total: 5, xp: 3, movedUp: 2, stillGrading: 1, nextDue: "2026-03-11" });
});

test("the flag queue: Undo inside the hold sends nothing; flush sends held flags with keepalive; a lost send can be retried", async () => {
  const timers = fakeTimers();
  const sent = [];
  let fail = false;
  const q = C.createFlagQueue({
    timers,
    send: async (f, keepalive) => {
      sent.push({ key: f.flag_key, keepalive });
      return fail ? { kind: "unknown", message: "x" } : { kind: "saved", value: { invalidated: 1, kind: f.kind } };
    },
  });
  q.add({ flag_key: "a", question_id: 1, kind: "wrong", cardKeys: ["idea:1"] });
  assert.equal(q.undo("a"), true);
  await timers.advance(C.FLAG_HOLD_MS * 2);
  assert.deepEqual(sent, []);
  q.add({ flag_key: "b", question_id: 2, kind: "unclear", cardKeys: ["idea:2"] });
  await q.flush(true);
  assert.deepEqual(sent, [{ key: "b", keepalive: true }]);
  assert.equal(q.undo("b"), false, "sent: no Undo");
  assert.equal(timers.pendingCount(), 0, "its timer is cleared");
  fail = true;
  q.add({ flag_key: "c", question_id: 3, kind: "wrong", cardKeys: [] });
  await timers.advance(C.FLAG_HOLD_MS);
  await tick();
  await tick();
  assert.equal(q.list().find((f) => f.flag_key === "c").status, "unknown");
  fail = false;
  await q.retry("c");
  assert.equal(q.list().find((f) => f.flag_key === "c").status, "sent");
  assert.deepEqual(sent.map((s) => s.key), ["b", "c", "c"], "the same key again");
});

test("links leave only as http(s); highlight sources are labelled by page", () => {
  assert.equal(C.safeHref("https://example.org/a"), "https://example.org/a");
  assert.equal(C.safeHref("javascript:alert(1)"), null);
  assert.equal(C.safeHref("data:text/html,x"), null);
  assert.equal(C.highlightLabel({ page: 52, location: null }), "Your highlight · p. 52");
  assert.equal(C.highlightLabel({ page: null, location: "1234" }), "Your highlight · loc. 1234");
});
