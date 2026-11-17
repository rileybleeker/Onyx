// READ-QUIZ-01 S4: the /reading Practice UI. The real components (PracticeRunner, PracticeCards, PracticePart,
// BankApproval) and lib/reading-practice-client.ts under the hook harness: the answer stays hidden until Check or
// "I don't know"; Skip stores nothing; a failure keeps the card and Retry sends the SAME request; the verdict is
// announced once; focus moves predictably; Show choices sets hinted; Disagree once; a flag inside 8 s + Undo sends
// nothing; held flags and unconfirmed answers go out with keepalive when the page hides; the 390 px classes (and a
// phone turned to landscape); the keys (only from inside the runner); Quick 3 goes on from the first open card; a
// resumed round reads its earlier grades; a sent Wrong voids the answer in the summary; closing with an answer on its
// way says when it settled; a late "Again" is offered on the summary; the bank GET in S2's real shape. Review round 2:
// an approval or Turn off whose outcome is unknown says "Not sure" and re-reads; × and Esc ask before a typed answer
// is dropped; an over-long answer waits; a flag on its way is re-sent with keepalive; "Not read yet" takes the held
// chapter's answered cards off the summary; a chapter recall graded on the spot still reads its Covered / Missed; Start
// waits until the round was read again. Review round 3: a retry refused before the receipt lookup (a session, origin or
// rate-limit refusal) stays "not sure" under the same key, for an answer, a highlight grade and Disagree; "Not in this
// chapter" locks its idea like "Not read yet" locks a chapter (summary, opened results, chapter recall lists).
// Review round 4: Start waits for the first read of the mount (and of every return after a minute away) and a round that
// could not be checked is not offered; a chapter recall the server re-versioned takes the new question after "Not in
// this chapter" (or leaves when the round cannot be read); a flag retried after a lost answer stays "not sure" under
// the same flag_key unless the refusal names a reason; an answer sent and never confirmed stays held past a closed
// runner (also when the 10 s wait ran out), and the reopened round retries the SAME request instead of a new key.
// Synthetic data only (invented prompts and answers); no network, no storage.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
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
// The props the Practice part last gave its runner (the dynamic chunk is a stub here).
const runnerProps = [];
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
      runnerProps.push(p);
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

function mountRunner(t, { cards, answer, poll, override, review, flagAnswer, win, doc, extra = 0, onReread, mode = "daily", outbox } = {}) {
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
  const settles = [];
  const h = mountClient("app/reading/PracticeRunner.tsx", {
    props: {
      round: round(cards, { extra }),
      mode,
      onClose: (changed, finished, settled) => {
        closed.push({ changed, finished });
        settles.push(settled);
      },
      onMore: () => undefined,
      onReread,
      outbox,
      timers,
    },
    stubs: STUBS,
  });
  const attempts = () => calls.filter((c) => c.url === C.ATTEMPT_URL);
  const flagsSent = () => calls.filter((c) => c.url === C.FLAG_URL);
  const live = () => h.find((n) => n.props["aria-live"] === "polite");
  const alerts = () => h.find((n) => n.props.role === "alert").map((n) => h.text(n));
  const root = () => h.find((n) => n.props["data-testid"] === "practice-runner")[0];
  const polls = () => calls.filter((c) => c.url.startsWith("/api/reading/practice/round/"));
  return { h, calls, timers, closed, settles, attempts, flagsSent, polls, live, alerts, root };
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
  assert.match(r.h.button("Sources 1").props.className, /min-h-11/, "the Sources chip, now a button, is a 44 px target");
  assert.doesNotMatch(r.h.button("Sources 1").props.className, /min-h-7/);
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
  const r = mountRunner(t, { cards, answer: (b, n) => (n === 1 ? response({ error: "refused" }, 409) : response(serverReceipt(cards, b))) });
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
  // The options are offered in a fixed shuffle (lib choiceOrder); the key is the place on screen.
  const place = radios().findIndex((b) => /alpha 1/.test(r.h.text(b)));
  assert.ok(place >= 0);
  assert.deepEqual(
    radios().map((b) => r.h.text(b).replace(/^\d/, "")),
    C.choiceOrder(4, `101|${TODAY}`).map((i) => cuedRubric(1).options[i]),
    "shown in the shuffled order",
  );
  win.fire("keydown", keyEvent(String(place + 1)));
  await r.h.flush();
  assert.equal(radios()[place].props["aria-checked"], true);
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
  // One request at a time: while the answer is unconfirmed the card cannot be flagged or skipped (no ⋯ menu at all).
  assert.equal(r.h.buttons("More actions").length, 0);
  assert.equal(r.h.buttons("Wrong").length, 0);
  assert.equal(r.h.buttons("Skip for now").length, 0);
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
  // The runner's own elements (the answer box, its buttons) are inside its root, as in the page.
  const box = { tagName: "TEXTAREA" };
  const inner = { tagName: "BUTTON" };
  r.root().props.ref.current = { contains: (t) => t === box || t === inner };
  typeAnswer(r.h, "alpha 1");
  await r.h.flush();
  win.fire("keydown", keyEvent("Enter", { ctrlKey: true, target: box }));
  await r.h.flush();
  assert.equal(r.attempts().length, 1);
  win.fire("keydown", keyEvent("n", { target: box }));
  await r.h.flush();
  assert.match(r.h.text(), /Synthetic prompt 1\?/, "N while typing is a letter");
  win.fire("keydown", keyEvent("n"));
  await r.h.flush();
  assert.match(r.h.text(), /Synthetic prompt 2\?/);
  // Esc closes only with focus inside the runner: not from another widget, not on an event already handled.
  win.fire("keydown", keyEvent("Escape"));
  win.fire("keydown", keyEvent("Escape", { target: { tagName: "INPUT" } }));
  win.fire("keydown", keyEvent("Escape", { target: inner, defaultPrevented: true }));
  await r.h.flush();
  assert.deepEqual(r.closed, [], "Esc with nothing focused, from outside, or already handled closes nothing");
  win.fire("keydown", keyEvent("Escape", { target: inner }));
  assert.deepEqual(r.closed, [{ changed: true, finished: false }]);
});

test("keys from another widget are not the runner's: an N the go-shortcut already handled, an N on a link outside", async (t) => {
  const win = fakeTarget();
  const r = mountRunner(t, { cards: [cued(1), cued(2)], win });
  await r.h.flush();
  r.root().props.ref.current = { contains: () => false };
  typeAnswer(r.h, "alpha 1");
  await r.h.flush();
  r.h.click("Check");
  await r.h.flush();
  win.fire("keydown", keyEvent("n", { defaultPrevented: true }));
  win.fire("keydown", keyEvent("n", { target: { tagName: "A" } }));
  await r.h.flush();
  assert.match(r.h.text(), /Synthetic prompt 1\?/, "still on the answered card");
  win.fire("keydown", keyEvent("n"));
  await r.h.flush();
  assert.match(r.h.text(), /Synthetic prompt 2\?/, "with nothing focused N goes on");
});

test("390 px: a full-screen sheet with safe-area padding and no breakpoint classes; turned to landscape it moves in place, the answer kept", async (t) => {
  const mq = fakeTarget({ matches: true, media: "(max-width: 767px)" });
  const win = fakeTarget({ matchMedia: () => mq });
  const doc = fakeTarget({ visibilityState: "visible", documentElement: { style: { overflow: "" } }, body: { style: { overflow: "" } } });
  const r = mountRunner(t, { cards: [cued(1), cued(2)], win, doc });
  await r.h.flush();
  const classes = () => r.root().props.className.split(/\s+/);
  for (const c of ["fixed", "inset-0", "z-50", "flex-col", "pt-[env(safe-area-inset-top)]", "pb-[env(safe-area-inset-bottom)]"]) assert.ok(classes().includes(c), `phone class ${c}`);
  assert.equal(classes().filter((c) => c.startsWith("md:")).length, 0, "no breakpoint class can turn the sheet into an in-place card");
  assert.equal(r.root().props["data-layout"], "sheet");
  assert.equal(doc.documentElement.style.overflow, "hidden", "the page behind the sheet does not scroll");
  typeAnswer(r.h, "alpha 1");
  await r.h.flush();
  // Landscape (wider than 767 px): the in-place card, the page scrolls again, the typed answer is still there.
  mq.matches = false;
  mq.fire("change");
  await r.h.flush();
  for (const c of ["relative", "max-w-[640px]"]) assert.ok(classes().includes(c), `in-place class ${c}`);
  assert.ok(!classes().includes("fixed"));
  assert.equal(r.root().props["data-layout"], "inline");
  assert.equal(doc.documentElement.style.overflow, "");
  assert.equal(doc.body.style.overflow, "");
  assert.equal(r.h.find((n) => n.type === "textarea")[0].props.value, "alpha 1");
  mq.matches = true;
  mq.fire("change");
  await r.h.flush();
  assert.equal(r.root().props["data-layout"], "sheet", "and back");
  assert.equal(doc.documentElement.style.overflow, "hidden");
  r.h.unmount();
  assert.equal(doc.documentElement.style.overflow, "", "closing gives the page its scroll back");
});

test("desktop (no phone media query): the in-place card at most 640 px wide; 16 px input, 44 / 48 px targets", async (t) => {
  const r = mountRunner(t, { cards: [cued(1), cued(2)] });
  await r.h.flush();
  const cls = r.root().props.className.split(/\s+/);
  for (const c of ["relative", "mx-auto", "w-full", "max-w-[640px]"]) assert.ok(cls.includes(c), `runner class ${c}`);
  assert.ok(!cls.includes("fixed"));
  assert.match(r.h.find((n) => n.type === "textarea")[0].props.className, /text-\[16px\]/);
  assert.match(prompt(r.h).props.className, /text-\[17px\]/);
  for (const label of ["Check", "I don't know", "More actions", "Close practice"]) assert.match(r.h.button(label).props.className, /min-h-11/, label);
  await menu(r.h, "Show choices");
  for (const b of r.h.find((n) => n.type === "button" && n.props.role === "radio")) assert.match(b.props.className, /min-h-12/);
});

test("Quick 3 is the first 3 cards still open: a second Quick 3 the same day goes on from the 4th card", async (t) => {
  const done = (n) => cued(n, { card: { done: true, attempt_key: `${n}a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a` } });
  const r = mountRunner(t, { cards: [done(1), done(2), done(3), cued(4), cued(5), cued(6), cued(7)], mode: "quick" });
  await r.h.flush();
  assert.match(r.h.text(), /Synthetic prompt 4\?/, "not the summary of the first 3");
  assert.match(r.h.text(), /1 \/ 3/, "three cards");
  for (const n of [4, 5, 6]) {
    assert.match(r.h.text(), new RegExp(`Synthetic prompt ${n}\\?`));
    typeAnswer(r.h, `alpha ${n}`);
    await r.h.flush();
    r.h.click("Check");
    await r.h.flush();
    r.h.click("Next");
    await r.h.flush();
  }
  assert.match(r.h.text(), /Round done/);
  assert.match(r.h.text(), /3 of 3 · \+6 XP/);
  assert.doesNotMatch(r.h.text(), /Synthetic prompt 7\?/);
});

const EARLIER_KEY = "1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a";
const earlierAttempt = (o = {}) => ({
  attempt_key: EARLIER_KEY,
  question_id: 101,
  grading_status: "graded",
  verdict: "partial",
  score: 0.5,
  hinted: false,
  feedback: "Synthetic earlier feedback.",
  rubric_hits: [{ id: "p1", hit: "yes" }, { id: "p2", hit: "no" }],
  grader: "model",
  overridden: false,
  grade_error: null,
  overridable: true,
  self_gradable: false,
  covered_ideas: null,
  ...o,
});

test("a resumed round reads its earlier answers once; the summary opens one again with its feedback and Disagree", async (t) => {
  const earlier = { ...explain(1), done: true, attempt_key: EARLIER_KEY.toUpperCase() };
  const r = mountRunner(t, { cards: [earlier, cued(2)], poll: () => response({ round_key: ROUND_KEY, attempts: [earlierAttempt()] }) });
  await r.h.flush();
  assert.equal(r.polls().length, 1, "one read of the round's attempts on open");
  assert.match(r.h.text(), /Synthetic prompt 2\?/);
  typeAnswer(r.h, "alpha 2");
  await r.h.flush();
  r.h.click("Check");
  await r.h.flush();
  r.h.click("Next");
  await r.h.flush();
  assert.match(r.h.text(), /Round done/);
  assert.match(r.h.text(), /2 of 2 · \+2 XP/, "the earlier answer counted in its own sitting, not again");
  const row = r.h.find((n) => n.type === "button" && /Explain synthetic idea 1/.test(r.h.text(n)))[0];
  assert.ok(row, "the earlier answer is listed");
  assert.match(r.h.text(row), /Partly/);
  assert.match(row.props.className, /min-h-11/);
  row.props.onClick();
  await r.h.flush();
  assert.match(r.h.text(), /Answered earlier today/, "the earlier answer's text is not sent back, so it is not shown");
  assert.match(r.h.text(), /Synthetic earlier feedback\./);
  assert.match(r.h.text(), /Disagree\?/);
  r.h.click("Correct");
  await r.h.flush();
  const o = r.calls.find((c) => c.url.endsWith("/override"));
  assert.equal(o.url, `/api/reading/practice/attempt/${EARLIER_KEY}/override`);
  assert.match(r.h.text(), /Changed by you/);
  assert.match(r.h.text(), /Next: in 2 days/, "the committed schedule from the override's receipt");
  r.h.click("Back to summary");
  await r.h.flush();
  assert.match(r.h.text(), /Round done/);
});

test("a resumed answer still waiting for its model grade is polled for, and can be graded by hand once offered", async (t) => {
  const earlier = { ...explain(1), done: true, attempt_key: EARLIER_KEY };
  let graded = false;
  const r = mountRunner(t, {
    cards: [earlier],
    poll: () =>
      response({
        round_key: ROUND_KEY,
        attempts: [graded ? earlierAttempt() : earlierAttempt({ grading_status: "pending", verdict: null, score: null, feedback: null, rubric_hits: null, grader: null, overridable: false, self_gradable: true })],
      }),
  });
  await r.h.flush();
  assert.match(r.h.text(), /Round done/);
  assert.match(r.h.text(), /1 still grading/);
  assert.match(r.h.text(), /Grade it yourself/, "a failed or late grade can be graded by hand");
  const before = r.polls().length;
  graded = true;
  await r.timers.advance(C.POLL_EVERY_MS, r.h);
  assert.equal(r.polls().length, before + 1, "the poll runs for an earlier answer too");
  assert.doesNotMatch(r.h.text(), /still grading/);
});

test("a sent Wrong flag on an answered card voids it: no verdict, no XP, no 'moved up', and the summary says so", async (t) => {
  const cards = [cued(1, { again: false }), cued(2, { again: false })];
  const r = mountRunner(t, { cards, flagAnswer: (b) => response({ success: true, kind: b.kind, invalidated: 1, replayed: true }) });
  await r.h.flush();
  typeAnswer(r.h, "alpha 1");
  await r.h.flush();
  r.h.click("Check");
  await r.h.flush();
  assert.match(r.h.text(), /Right/);
  await menu(r.h, "Wrong");
  assert.match(r.h.text(), /Synthetic prompt 2\?/, "flagging from the result screen moves on");
  await r.timers.advance(C.FLAG_HOLD_MS, r.h);
  assert.equal(r.flagsSent().length, 1);
  assert.ok(r.polls().length >= 1, "the round's attempts are read back after the flag");
  typeAnswer(r.h, "alpha 2");
  await r.h.flush();
  r.h.click("Check");
  await r.h.flush();
  r.h.click("Next");
  await r.h.flush();
  const text = r.h.text();
  assert.match(text, /2 of 2 · \+2 XP/, "only the answer that still counts earns XP");
  assert.match(text, /1 idea moved up/);
  assert.match(text, /1 answer voided after your correction/);
  const row = r.h.find((n) => n.type === "button" && /Synthetic prompt 1\?/.test(r.h.text(n)))[0];
  assert.match(r.h.text(row), /Voided/);
  row.props.onClick();
  await r.h.flush();
  assert.match(r.h.text(), /Voided after your flag/);
  assert.doesNotMatch(r.h.text(), /Disagree\?/);
  assert.equal(r.h.buttons("More actions").length, 0, "a flagged card is not flagged again");
});

test("closing with an answer on its way: the part is told when it settled (one request, never re-sent)", async (t) => {
  const gate = deferred();
  const cards = [cued(1), cued(2)];
  const r = mountRunner(t, { cards, answer: (b) => gate.promise.then(() => response(serverReceipt(cards, b))) });
  await r.h.flush();
  typeAnswer(r.h, "alpha 1");
  await r.h.flush();
  r.h.click("Check");
  await r.h.flush();
  r.h.click("Close practice");
  assert.deepEqual(r.closed, [{ changed: false, finished: false }]);
  const settled = r.settles[0];
  assert.ok(settled && typeof settled.then === "function", "a settled promise while the answer is on its way");
  let landed = false;
  void settled.then(() => (landed = true));
  await tick();
  assert.equal(landed, false);
  gate.resolve();
  await r.h.flush();
  assert.equal(landed, true, "settled once the answer landed");
  assert.equal(r.attempts().length, 1, "the answer on its way is not sent twice");
});

test("closing with a held flag sends it at once and settles after; closing with nothing pending passes no promise", async (t) => {
  const r = mountRunner(t, { cards: [cued(1), cued(2)] });
  await r.h.flush();
  await menu(r.h, "Unclear");
  r.h.click("Close practice");
  assert.equal(r.flagsSent().length, 1, "sent at close, not after 8 s");
  await r.h.flush();
  let landed = false;
  void r.settles[0].then(() => (landed = true));
  await tick();
  assert.equal(landed, true);
  const r2 = mountRunner(t, { cards: [cued(3)] });
  await r2.h.flush();
  r2.h.click("Close practice");
  assert.equal(r2.settles[0], undefined);
});

test("a model grade that comes after the round ended offers Again on the summary instead of pushing a card", async (t) => {
  const withVariant = {
    ...explain(2),
    again_question: { question_id: 202, version: 1, format: "cued", prompt: "Synthetic variant 2?", rubric: cuedRubric(2) },
  };
  let key = null;
  const r = mountRunner(t, {
    cards: [cued(1, { again: false }), withVariant],
    poll: () =>
      response({
        round_key: ROUND_KEY,
        attempts: key
          ? [{ attempt_key: key, question_id: 102, grading_status: "graded", verdict: "incorrect", score: 0.1, hinted: false, feedback: null, rubric_hits: null, grader: "model", overridden: false, grade_error: null, overridable: true, self_gradable: false, covered_ideas: null }]
          : [],
      }),
  });
  await r.h.flush();
  typeAnswer(r.h, "alpha 1");
  await r.h.flush();
  r.h.click("Check");
  await r.h.flush();
  r.h.click("Next");
  await r.h.flush();
  typeAnswer(r.h, "A synthetic explanation of several words.");
  await r.h.flush();
  r.h.click("Check");
  await r.h.flush();
  key = r.attempts()[1].body.attempt_key;
  r.h.click("Next");
  await r.h.flush();
  assert.match(r.h.text(), /Round done/);
  await r.timers.advance(C.POLL_EVERY_MS, r.h);
  assert.match(r.h.text(), /Round done/, "the summary stays");
  assert.doesNotMatch(r.h.text(), /Synthetic variant 2\?/);
  r.h.click("Try again · 1");
  await r.h.flush();
  assert.match(r.h.text(), /Synthetic variant 2\?/, "the repeat on a tap");
});

/* ------------------------------------------------------------------ */
/* Review round 2: closing, limits, flags on their way, the gate        */
/* ------------------------------------------------------------------ */

test("× and Esc with a typed answer not checked yet ask first; nothing is lost until Leave; an input method's Esc is left alone", async (t) => {
  const win = fakeTarget();
  const r = mountRunner(t, { cards: [cued(1), cued(2)], win });
  await r.h.flush();
  const box = { tagName: "TEXTAREA" };
  r.root().props.ref.current = { contains: (x) => x === box };
  typeAnswer(r.h, "a half typed answer");
  await r.h.flush();
  r.h.click("Close practice");
  await r.h.flush();
  assert.deepEqual(r.closed, [], "× asks before it drops what was typed");
  assert.match(r.h.text(), /Leave without checking\? What you typed is not saved\./);
  r.h.click("Keep writing");
  await r.h.flush();
  assert.doesNotMatch(r.h.text(), /Leave without checking/);
  // Esc from the text box asks too (it never closes the round with an answer in it) ...
  win.fire("keydown", keyEvent("Escape", { target: box }));
  await r.h.flush();
  assert.deepEqual(r.closed, []);
  assert.match(r.h.text(), /Leave without checking/);
  // ... and a second Esc takes the question back: the typed answer is still there.
  win.fire("keydown", keyEvent("Escape", { target: box }));
  await r.h.flush();
  assert.doesNotMatch(r.h.text(), /Leave without checking/);
  assert.equal(r.h.find((n) => n.type === "textarea")[0].props.value, "a half typed answer");
  // An Esc that cancels an input method's composition (a dictation, an IME) is the keyboard's.
  win.fire("keydown", keyEvent("Escape", { target: box, isComposing: true }));
  win.fire("keydown", keyEvent("Escape", { target: box, keyCode: 229 }));
  await r.h.flush();
  assert.deepEqual(r.closed, []);
  assert.doesNotMatch(r.h.text(), /Leave without checking/);
  r.h.click("Close practice");
  await r.h.flush();
  r.h.click("Leave");
  assert.deepEqual(r.closed, [{ changed: false, finished: false }], "Leave closes");
});

test("an answer over the route's limit cannot be checked: a count shows near it, Check waits, nothing is sent", async (t) => {
  const r = mountRunner(t, { cards: [cued(1), cued(2)] });
  await r.h.flush();
  typeAnswer(r.h, "x".repeat(C.ANSWER_MAX_CHARS - 100));
  await r.h.flush();
  assert.match(r.h.text(), /3,900 \/ 4,000/);
  assert.equal(r.h.button("Check").props.disabled, false);
  typeAnswer(r.h, "x".repeat(C.ANSWER_MAX_CHARS + 1));
  await r.h.flush();
  assert.match(r.alerts()[0], /Too long: 4,001 characters; 4,000 is the most Onyx takes\. Shorten it to check\./);
  assert.equal(r.h.button("Check").props.disabled, true);
  r.h.button("Check").props.onClick();
  await r.h.flush();
  assert.equal(r.attempts().length, 0, "even a forced check sends nothing");
  typeAnswer(r.h, "x".repeat(C.ANSWER_MAX_CHARS));
  await r.h.flush();
  assert.equal(r.h.button("Check").props.disabled, false, "exactly the limit is fine");
});

test("a flag still on its way when the page hides is sent again with keepalive (the same flag_key)", async (t) => {
  const gate = deferred();
  const win = fakeTarget();
  const doc = fakeTarget({ visibilityState: "visible", documentElement: { style: {} }, body: { style: {} } });
  const r = mountRunner(t, { cards: [cued(1), cued(2), cued(3)], win, doc, flagAnswer: () => gate.promise });
  await r.h.flush();
  await menu(r.h, "Unclear");
  await r.timers.advance(C.FLAG_HOLD_MS, r.h);
  assert.equal(r.flagsSent().length, 1);
  assert.equal(r.flagsSent()[0].keepalive, false);
  doc.visibilityState = "hidden";
  doc.fire("visibilitychange");
  await r.h.flush();
  assert.equal(r.flagsSent().length, 2, "the flag on its way may die with the page: sent again");
  assert.equal(r.flagsSent()[1].keepalive, true);
  assert.equal(r.flagsSent()[1].body.flag_key, r.flagsSent()[0].body.flag_key, "replay safe by its key");
  gate.resolve(response({ success: true, kind: "unclear", invalidated: 0, replayed: false }));
  await r.h.flush();
  assert.equal(r.flagsSent().length, 2, "nothing more once it is confirmed");
});

test("Not read yet takes the held chapter's and every later chapter's answered cards off the summary; the counts stay", async (t) => {
  const cards = [
    cued(1, { chapter: 5, again: false }),
    cued(2, { chapter: 2, again: false }),
    cued(3, { chapter: 3, again: false }),
    cued(4, { chapter: 0, again: false }),
  ];
  const r = mountRunner(t, { cards, onReread: async () => round([cards[1]]) });
  await r.h.flush();
  for (const n of [1, 2]) {
    typeAnswer(r.h, `alpha ${n}`);
    await r.h.flush();
    r.h.click("Check");
    await r.h.flush();
    r.h.click("Next");
    await r.h.flush();
  }
  assert.match(r.h.text(), /Synthetic prompt 3\?/, "chapter 3 is the card on screen");
  await menu(r.h, "Not read yet");
  assert.match(r.h.text(), /Synthetic prompt 4\?/, "the whole-book card is not held until the server says so");
  await r.timers.advance(C.FLAG_HOLD_MS, r.h);
  assert.equal(r.flagsSent()[0].body.kind, "not_read_yet");
  const text = r.h.text();
  assert.match(text, /Round done/, "the whole-book card left the round with the hold");
  assert.match(text, /Synthetic prompt 2\?/, "chapter 2 is below the hold: still listed");
  for (const locked of [/Synthetic prompt 1\?/, /Synthetic prompt 3\?/, /Synthetic prompt 4\?/]) assert.doesNotMatch(text, locked);
  assert.equal(r.h.find((n) => n.type === "button" && /Synthetic prompt 1\?/.test(r.h.text(n))).length, 0, "no row to open the chapter 5 answer again");
  assert.match(text, /2 of 2 · \+4 XP/, "both answers are still valid, so their counts stay");
});

test("a Not read yet that lands while an answer of the held range is on its way never shows that answer's result", async (t) => {
  const gate = deferred();
  const cards = [cued(1, { chapter: 4, again: false }), cued(2, { chapter: 0, again: false })];
  const r = mountRunner(t, { cards, answer: (b) => gate.promise.then(() => response(serverReceipt(cards, b))), onReread: async () => round([cards[1]]) });
  await r.h.flush();
  // The first card is held (chapter 4); the whole-book card is not held until the server says so, so it is answered.
  await menu(r.h, "Not read yet");
  assert.match(r.h.text(), /Synthetic prompt 2\?/);
  typeAnswer(r.h, "alpha 2");
  await r.h.flush();
  r.h.click("Check");
  await r.h.flush();
  assert.match(r.h.text(), /Answer: alpha 2/, "its result shows while it is being stored");
  // The hold goes out while that answer is still on its way, then the answer lands.
  await r.timers.advance(C.FLAG_HOLD_MS, r.h);
  assert.equal(r.flagsSent()[0].body.kind, "not_read_yet");
  gate.resolve();
  await r.h.flush();
  const text = r.h.text();
  assert.match(text, /Round done/);
  assert.match(text, /1 of 1/, "the answer is stored and counted");
  assert.doesNotMatch(text, /Answer: alpha 2|Synthetic prompt 2\?|Synthetic snippet/);
  assert.equal(r.h.find((n) => n.type === "button" && /Synthetic prompt/.test(r.h.text(n))).length, 0, "nothing of the held range can be opened");
});

/** A chapter recall card (its rubric lists the chapter's ideas), as GET /api/reading/practice/today sends it. */
function recallCard(chapter) {
  return {
    ...cued(chapter, { again: false }),
    key: `recall:${chapter}`,
    kind: "chapter_recall",
    chapter,
    format: "chapter_recall",
    slot: "recall",
    idea: null,
    recall: { chapter, done_n: 0, due_on: TODAY, next_due_on: "2026-03-17" },
    question: {
      question_id: 900 + chapter,
      version: 1,
      format: "chapter_recall",
      prompt: `What do you remember of chapter ${chapter}?`,
      rubric: { v: 1, format: "chapter_recall", ideas: [{ idea_id: 51, title: "Synthetic core idea", importance: "core" }, { idea_id: 52, title: "Synthetic supporting idea", importance: "supporting" }] },
    },
    preview: null,
  };
}
const recallIdeas = (verdict) =>
  [51, 52].map((id) => ({
    idea_id: id,
    title: id === 51 ? "Synthetic core idea" : "Synthetic supporting idea",
    importance: id === 51 ? "core" : "supporting",
    statement: `Synthetic statement ${id}.`,
    key_points: [],
    stage: 1,
    source_count: 1,
    sources: [webSource],
    verdict,
    hit: null,
  }));

test("a chapter recall answered \"I don't know\" is graded on the spot, yet its Covered / Missed lists are read from the round's attempts once", async (t) => {
  const card = recallCard(5);
  const r = mountRunner(t, {
    cards: [card],
    poll: () =>
      response({
        round_key: ROUND_KEY,
        attempts: r.attempts()[0]
          ? [{ attempt_key: r.attempts()[0].body.attempt_key, question_id: 905, grading_status: "graded", verdict: "dont_know", score: 0, hinted: false, feedback: null, rubric_hits: null, grader: "local", overridden: false, grade_error: null, overridable: false, self_gradable: false, covered_ideas: recallIdeas("dont_know") }]
          : [],
      }),
  });
  await r.h.flush();
  assert.equal(r.polls().length, 0, "nothing to read before an answer");
  r.h.click("I don't know");
  await r.h.flush();
  assert.equal(r.attempts()[0].body.answer, R.DONT_KNOW_ANSWER);
  assert.equal(r.polls().length, 1, "read once after the save: a graded answer has no pending grade to poll for");
  const text = r.h.text();
  assert.match(text, /Missed\s*2/);
  assert.match(text, /Synthetic statement 51\./, "each missed idea says what it is");
  assert.match(text, /Synthetic statement 52\./);
  await r.timers.advance(C.POLL_EVERY_MS * 3, r.h);
  assert.equal(r.polls().length, 1, "and no polling after");
});

test("grading a chapter recall answer yourself reads its Covered / Missed lists once the grade is saved", async (t) => {
  const card = recallCard(5);
  const r = mountRunner(t, {
    cards: [card],
    poll: () => {
      const key = r.attempts()[0]?.body.attempt_key;
      const selfGraded = r.calls.some((c) => c.url.endsWith("/override"));
      return response({
        round_key: ROUND_KEY,
        attempts: key
          ? [
              selfGraded
                ? { attempt_key: key, question_id: 905, grading_status: "graded", verdict: "correct", score: 1, hinted: false, feedback: null, rubric_hits: null, grader: "self", overridden: false, grade_error: null, overridable: false, self_gradable: false, covered_ideas: recallIdeas("correct") }
                : { attempt_key: key, question_id: 905, grading_status: "pending", verdict: null, score: null, hinted: false, feedback: null, rubric_hits: null, grader: null, overridden: false, grade_error: "failed", overridable: false, self_gradable: true, covered_ideas: recallIdeas(null) },
            ]
          : [],
      });
    },
  });
  await r.h.flush();
  typeAnswer(r.h, "Several synthetic words about what happened in the chapter.");
  await r.h.flush();
  r.h.click("Check");
  await r.h.flush();
  await r.timers.advance(C.POLL_EVERY_MS, r.h);
  assert.match(r.h.text(), /Grade it yourself/);
  assert.doesNotMatch(r.h.text(), /Covered/, "no verdict on any idea yet");
  r.h.click("Correct");
  await r.h.flush();
  assert.match(r.h.text(), /Covered\s*2/, "the lists are read once the grade is saved (the poll had stopped)");
  assert.doesNotMatch(r.h.text(), /Missed/);
});

test("a retry refused before the receipt lookup stays 'not sure' under the same key: the answer is never re-sent under a new key", async (t) => {
  const cards = [cued(1), cued(2)];
  // The first try may have been stored (its answer was lost); the retry is then refused by the session check (401)
  // before the receipt is looked up, which proves nothing about the first try.
  const r = mountRunner(t, {
    cards,
    answer: (b, n) => {
      if (n === 1) throw new TypeError("offline");
      if (n === 2) return response({ error: "unauthorized" }, 401);
      return response(serverReceipt(cards, b, { replayed: true }));
    },
  });
  await r.h.flush();
  typeAnswer(r.h, "alpha 1");
  await r.h.flush();
  r.h.click("Check");
  await r.h.flush();
  assert.match(r.alerts()[0], /Not sure it saved: No answer from Onyx/);
  r.h.click("Retry");
  await r.h.flush();
  assert.equal(r.attempts().length, 2);
  assert.match(r.alerts()[0], /Not sure it saved: Onyx refused this retry/, "not 'Not saved', not 'Nothing was saved'");
  assert.doesNotMatch(r.alerts()[0], /Nothing was saved/);
  assert.equal(r.h.buttons("Retry").length, 1, "Retry stays");
  assert.equal(r.h.button("Next").props["aria-disabled"], true);
  r.h.click("Retry");
  await r.h.flush();
  assert.equal(r.attempts().length, 3);
  assert.deepEqual(r.attempts()[2].body, r.attempts()[0].body, "every try is the same request: the same attempt_key");
  assert.equal(new Set(r.attempts().map((a) => a.body.attempt_key)).size, 1);
  assert.equal(r.alerts().length, 0);
  assert.equal(r.h.button("Next").props["aria-disabled"], undefined, "the receipt settled it");
});

test("a first try refused by the session check stored nothing: the answer is checked again under a new key", async (t) => {
  const cards = [cued(1), cued(2)];
  const r = mountRunner(t, { cards, answer: (b, n) => (n === 1 ? response({ error: "unauthorized" }, 401) : response(serverReceipt(cards, b))) });
  await r.h.flush();
  typeAnswer(r.h, "alpha 1");
  await r.h.flush();
  r.h.click("Check");
  await r.h.flush();
  assert.match(r.alerts()[0], /Not saved: Onyx refused this answer\. Nothing was saved\./, "no earlier try exists, so this one is proof");
  assert.equal(r.h.buttons("Retry").length, 0);
  typeAnswer(r.h, "alpha 1 ");
  await r.h.flush();
  r.h.click("Check");
  await r.h.flush();
  assert.notEqual(r.attempts()[1].body.attempt_key, r.attempts()[0].body.attempt_key);
});

test("a lost first try, then bank_off on its retry: the route looks the key up first, so nothing was stored (proof, \"Not saved\")", async (t) => {
  const cards = [cued(1), cued(2)];
  const r2 = mountRunner(t, {
    cards,
    answer: (b, n) => {
      if (n === 1) throw new TypeError("offline");
      return response({ error: "bank_off" }, 409);
    },
  });
  await r2.h.flush();
  typeAnswer(r2.h, "alpha 1");
  await r2.h.flush();
  r2.h.click("Check");
  await r2.h.flush();
  r2.h.click("Retry");
  await r2.h.flush();
  assert.match(r2.alerts()[0], /Not saved: Questions are off for this book\. Nothing was saved\./);
  assert.equal(r2.h.buttons("Retry").length, 0);
});

test("a highlight grade retried after a lost answer and refused before the receipt keeps its op_key and 'not sure'", async (t) => {
  const r = mountRunner(t, {
    cards: [highlightCard(7), cued(2)],
    review: (b, n) => {
      if (n === 1) throw new TypeError("offline");
      if (n === 2) return response({ error: "unauthorized" }, 401);
      return response({ success: true, xp_gained: 15, next_review: "2026-03-11", interval_days: 1, op_key: b.op_key, replayed: true });
    },
  });
  await r.h.flush();
  r.h.click("Say what this means, then reveal your note");
  await r.h.flush();
  r.h.click("Good, next review in 1 day");
  await r.h.flush();
  assert.match(r.alerts()[0], /Not sure it saved/);
  r.h.click("Retry");
  await r.h.flush();
  assert.match(r.alerts()[0], /Not sure it saved/, "a refused retry is not 'Not saved'");
  assert.equal(r.h.buttons("Retry").length, 1);
  r.h.click("Retry");
  await r.h.flush();
  const sent = r.calls.filter((c) => c.url === C.REVIEW_URL);
  assert.equal(sent.length, 3);
  assert.equal(new Set(sent.map((c) => c.body.op_key)).size, 1, "one op_key throughout");
  assert.match(r.h.text(), /Saved · next in 1 day/);
});

test("a first highlight grade the session check refused stored nothing: 'Not saved', and another tap takes a new op_key", async (t) => {
  const r = mountRunner(t, {
    cards: [highlightCard(7), cued(2)],
    review: (b, n) => (n === 1 ? response({ error: "unauthorized" }, 401) : response({ success: true, xp_gained: 15, next_review: "2026-03-11", interval_days: 1, op_key: b.op_key, replayed: false })),
  });
  await r.h.flush();
  r.h.click("Say what this means, then reveal your note");
  await r.h.flush();
  r.h.click("Good, next review in 1 day");
  await r.h.flush();
  assert.match(r.alerts()[0], /Not saved/);
  r.h.click("Good, next review in 1 day");
  await r.h.flush();
  const sent = r.calls.filter((c) => c.url === C.REVIEW_URL);
  assert.equal(sent.length, 2);
  assert.notEqual(sent[1].body.op_key, sent[0].body.op_key);
});

test("Not in this chapter locks its idea once sent: the answered card leaves the summary, and a chapter recall that listed the idea leaves with its Covered / Missed lists; other ideas stay", async (t) => {
  let reread = 0;
  // Idea 51 sits in the chapter recall's rubric (see recallCard); idea 60 does not.
  const cards = [cued(51, { chapter: 2, again: false }), cued(60, { chapter: 2, again: false }), recallCard(2)];
  const r = mountRunner(t, {
    cards,
    onReread: async () => {
      reread += 1;
      return round([cards[1]]);
    },
    poll: () => {
      const recall = r.attempts().find((a) => a.body.question_id === 902);
      return response({
        round_key: ROUND_KEY,
        attempts: recall
          ? [{ attempt_key: recall.body.attempt_key, question_id: 902, grading_status: "graded", verdict: "dont_know", score: 0, hinted: false, feedback: null, rubric_hits: null, grader: "local", overridden: false, grade_error: null, overridable: false, self_gradable: false, covered_ideas: recallIdeas("dont_know") }]
          : [],
      });
    },
  });
  await r.h.flush();
  typeAnswer(r.h, "alpha 51");
  await r.h.flush();
  r.h.click("Check");
  await r.h.flush();
  assert.match(r.h.text(), /Right/);
  await menu(r.h, "Not in this chapter");
  assert.match(r.h.text(), /Synthetic prompt 60\?/, "flagging from the result screen moves on");
  typeAnswer(r.h, "alpha 60");
  await r.h.flush();
  r.h.click("Check");
  await r.h.flush();
  r.h.click("Next");
  await r.h.flush();
  assert.match(r.h.text(), /What do you remember of chapter 2\?/);
  r.h.click("I don't know");
  await r.h.flush();
  assert.match(r.h.text(), /Missed\s*2/, "the recall answer lists the idea that is about to move");
  r.h.click("Next");
  await r.h.flush();
  const before = r.h.text();
  assert.match(before, /Round done/);
  assert.match(before, /3 of 3/);
  assert.match(before, /Synthetic prompt 51\?/, "still listed while the flag is held");
  assert.equal(r.flagsSent().length, 0);
  await r.timers.advance(C.FLAG_HOLD_MS, r.h);
  assert.equal(r.flagsSent()[0].body.kind, "not_in_chapter");
  assert.equal(r.flagsSent()[0].body.question_id, 151);
  assert.equal(reread, 1, "the round is read again once it is sent");
  const text = r.h.text();
  assert.match(text, /Round done/);
  assert.match(text, /Synthetic prompt 60\?/, "an idea that did not move stays listed");
  for (const locked of [/Synthetic prompt 51\?/, /What do you remember of chapter 2\?/, /Synthetic statement 5[12]\./, /Missed/, /Covered/]) assert.doesNotMatch(text, locked);
  assert.equal(r.h.find((n) => n.type === "button" && /Synthetic prompt 51\?|What do you remember/.test(r.h.text(n))).length, 0, "neither locked answer can be opened again");
  assert.match(text, /3 of 3/, "the answers are still valid, so their counts stay");
});

test("Not in this chapter on an idea no chapter recall lists takes only that idea's answered cards off the summary", async (t) => {
  const cards = [cued(61, { chapter: 2, again: false }), cued(62, { chapter: 2, again: false }), cued(63, { chapter: 3, again: false })];
  const r = mountRunner(t, { cards, onReread: async () => round([cards[2]]) });
  await r.h.flush();
  for (const n of [61, 62]) {
    typeAnswer(r.h, "alpha " + n);
    await r.h.flush();
    r.h.click("Check");
    await r.h.flush();
    if (n === 61) await menu(r.h, "Not in this chapter");
    else {
      r.h.click("Next");
      await r.h.flush();
    }
  }
  assert.match(r.h.text(), /Synthetic prompt 63\?/);
  await r.timers.advance(C.FLAG_HOLD_MS, r.h);
  assert.equal(r.flagsSent()[0].body.kind, "not_in_chapter");
  typeAnswer(r.h, "alpha 63");
  await r.h.flush();
  r.h.click("Check");
  await r.h.flush();
  r.h.click("Next");
  await r.h.flush();
  const text = r.h.text();
  assert.match(text, /3 of 3/);
  assert.doesNotMatch(text, /Synthetic prompt 61\?/);
  assert.match(text, /Synthetic prompt 62\?/);
  assert.match(text, /Synthetic prompt 63\?/);
});

test("a retry's refusal that names no reason is 'not sure'; a named reason is proof; a first try is proof either way; Disagree behaves the same", () => {
  // classifyAttemptAnswer(status, body, retry)
  for (const [status, body] of [[401, { error: "unauthorized" }], [403, { error: "forbidden" }], [413, { error: "bad_request" }], [400, { error: "bad_request" }], [429, {}], [400, null]]) {
    assert.equal(C.classifyAttemptAnswer(status, body).kind, "refused", "a first try: refused " + status);
    assert.equal(C.classifyAttemptAnswer(status, body, true).kind, "unknown", "a retry: not sure " + status);
  }
  for (const [status, code] of [[409, "key_reused"], [400, "bad_answer"], [400, "states_missing"], [409, "bank_off"], [409, "quiz_closed"], [409, "already_answered"], [409, "quiz_other_book"]]) {
    assert.equal(C.classifyAttemptAnswer(status, { error: code }, true).kind, "refused", "a retry: proof " + code);
  }
  for (const [status, code] of [[409, "question_changed"], [409, "retired"], [409, "locked"], [404, "not_found"]]) {
    assert.equal(C.classifyAttemptAnswer(status, { error: code }, true).kind, "stale", "a retry: left out " + code);
  }
  const ok = { success: true, attempt_key: "1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a", grading_status: "graded", verdict: "correct", score: 1, attempt_date: TODAY, next_review: "2026-03-11" };
  assert.equal(C.classifyAttemptAnswer(200, ok, true).kind, "saved");
  assert.equal(C.classifyAttemptAnswer(null, null, true).kind, "unknown");
  assert.match(C.classifyAttemptAnswer(401, {}, true).message, /refused this retry/);
  // classifyOverrideAnswer(status, body, retry)
  assert.equal(C.classifyOverrideAnswer(401, { error: "unauthorized" }).kind, "refused");
  assert.equal(C.classifyOverrideAnswer(401, { error: "unauthorized" }, true).kind, "unknown");
  assert.equal(C.classifyOverrideAnswer(409, { error: "already_overridden" }, true).kind, "refused", "a named reason stays");
});

/* ------------------------------------------------------------------ */
/* Practice part + approval                                             */
/* ------------------------------------------------------------------ */

const overview = { book: { book_id: 7, slug: "synthetic-book", title: "Synthetic", total_chapters: 12 }, today: TODAY };

function mountPart(t, { roundAnswer, bankAnswer, approval, cache = {}, win, doc, now }) {
  const calls = [];
  withGlobals(t, {
    fetch: async (url, init = {}) => {
      calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
      if (url === C.APPROVAL_URL) return approval(JSON.parse(init.body));
      if (url.startsWith(C.PRACTICE_TODAY_URL)) return roundAnswer(url);
      if (url.startsWith(`${C.BANK_URL}?`) || url === C.BANK_URL) return bankAnswer(url, calls);
      throw new Error(`unexpected fetch ${url}`);
    },
    ...(win ? { window: win } : {}),
    ...(doc ? { document: doc } : {}),
  });
  const store = { ...cache };
  const changed = [];
  const h = mountClient("app/reading/PracticePart.tsx", {
    props: { o: overview, review: React.createElement("p", null, "REVIEW CARD"), onChanged: () => changed.push(1), ...(now ? { now } : {}) },
    stubs: {
      ...STUBS,
      "@/lib/client-cache": { clientCache: { peek: (k) => store[k], put: (k, v) => (store[k] = v), remove: (k) => delete store[k] } },
    },
  });
  return { h, calls, store, changed };
}
// GET /api/reading/bank exactly as lib/reading-bank-server.ts getBankOverview answers it (S2): the
// pds.reading_bank_overview row, then `estimate` (remaining_cents = what is left to build, cap_cents = what a Turn on /
// Allow more tap approves) and `monthly_cap_cents`. There is no top-level estimate, cap or next due date.
const bankBody = (o = {}, est = {}) => ({
  book_id: 7,
  quiz_through: 4,
  total_chapters: 12,
  enabled: false,
  approved_cents: null,
  spent_cents: 0,
  paused_reason: null,
  mapping: "ok",
  narrative: false,
  hold_chapter: null,
  hold_flag_key: null,
  chapters: [],
  ...o,
  estimate: { book_cents: 1500, remaining_cents: 1500, cap_cents: 1900, per_chapter_cents: 125, ...est },
  monthly_cap_cents: 3000,
});

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
    bankAnswer: () => response(bankReads++ ? bankBody({}, { remaining_cents: 1700, cap_cents: 2200 }) : bankBody()),
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
    cache: { [C.practiceUrl("synthetic-book")]: stale, [C.bankUrl("synthetic-book")]: bankBody({ enabled: true, paused_reason: "budget", spent_cents: 1900 }, { remaining_cents: 400, cap_cents: 2500 }) },
    roundAnswer: () => gate.promise,
    bankAnswer: () => response(bankBody({ enabled: true, paused_reason: "budget", spent_cents: 1900 }, { remaining_cents: 400, cap_cents: 2500 })),
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

test("practice part: the bank GET exactly as S2 answers it turns the approval card on; a made-up top-level estimate is not read", async (t) => {
  const p = mountPart(t, { roundAnswer: () => response({ ...round([]), enabled: false }), bankAnswer: () => response(bankBody()) });
  await p.h.flush();
  assert.match(p.h.text(), /Questions on every chapter/);
  assert.match(p.h.text(), /About \$15 · cap \$19/);
  const p2 = mountPart(t, {
    roundAnswer: () => response({ ...round([]), enabled: false }),
    bankAnswer: () => response({ ...bankBody(), estimate: undefined, estimate_cents: 1500, cap_cents: 1900 }),
  });
  await p2.h.flush();
  assert.doesNotMatch(p2.h.text(), /Questions on every chapter/, "no approval without S2's estimate block");
  assert.match(p2.h.text(), /REVIEW CARD/);
});

test("practice part: a runner closed with answers on their way keeps Start waiting and re-reads the round once they land", async (t) => {
  runnerProps.length = 0;
  let roundReads = 0;
  const p = mountPart(t, {
    roundAnswer: () => {
      roundReads += 1;
      return response(round([cued(1), cued(2)]));
    },
    bankAnswer: () => response(bankBody({ enabled: true, approved_cents: 1900 })),
  });
  await p.h.flush();
  p.h.click("Start");
  await p.h.flush();
  const props = runnerProps[runnerProps.length - 1];
  assert.equal(props.mode, "daily");
  const gate = deferred();
  const readsBefore = roundReads;
  props.onClose(false, false, gate.promise);
  await p.h.flush();
  assert.equal(p.h.button("Start").props["aria-disabled"], true, "Start waits while the answers land");
  assert.match(p.h.text(), /Saving/);
  assert.equal(roundReads, readsBefore, "no re-read before they landed");
  assert.deepEqual(p.changed, []);
  gate.resolve();
  await p.h.flush();
  assert.equal(roundReads, readsBefore + 1, "re-read once after");
  assert.deepEqual(p.changed, [1], "the overview too");
  assert.equal(p.h.button("Start").props["aria-disabled"], undefined);
});

test("practice part: Start stays disabled until the round was read again; reopening never offers the answered cards again", async (t) => {
  runnerProps.length = 0;
  const gate = deferred();
  let reads = 0;
  const p = mountPart(t, {
    roundAnswer: () => {
      reads += 1;
      return reads === 1 ? response(round([cued(1), cued(2)])) : gate.promise;
    },
    bankAnswer: () => response(bankBody({ enabled: true, approved_cents: 1900 })),
  });
  await p.h.flush();
  p.h.click("Start");
  await p.h.flush();
  const props = runnerProps[runnerProps.length - 1];
  runnerProps.length = 0;
  // Answers were stored and nothing is left on its way (no settled promise): the part still waits for the new round.
  props.onClose(true, false);
  await p.h.flush();
  assert.equal(reads, 2, "the round is read again");
  assert.equal(p.h.button("Start").props["aria-disabled"], true, "Start waits for the round that includes those answers");
  assert.match(p.h.text(), /Saving/);
  p.h.button("Start").props.onClick();
  await p.h.flush();
  assert.equal(p.h.find((n) => n.props["data-testid"] === "runner-stub").length, 0, "a tap on a waiting Start opens nothing");
  gate.resolve(response(round([{ ...cued(1), done: true, attempt_key: "1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a" }, cued(2)])));
  await p.h.flush();
  assert.equal(p.h.button("Start").props["aria-disabled"], undefined, "Start is back with the new round");
  p.h.click("Start");
  await p.h.flush();
  const reopened = runnerProps[runnerProps.length - 1];
  assert.equal(reopened.round.cards[0].done, true, "the answered card comes from the new round, as answered");
});

test("practice part: a round that cannot be read again after a change is dropped, never offered again", async (t) => {
  runnerProps.length = 0;
  let reads = 0;
  const p = mountPart(t, {
    roundAnswer: () => {
      reads += 1;
      return reads === 1 ? response(round([cued(1), cued(2)])) : response({ error: "failed" }, 500);
    },
    bankAnswer: () => response(bankBody({ enabled: true, approved_cents: 1900 })),
  });
  await p.h.flush();
  assert.ok(p.store[C.practiceUrl("synthetic-book")], "the round was cached");
  p.h.click("Start");
  await p.h.flush();
  runnerProps[runnerProps.length - 1].onClose(true, false);
  await p.h.flush();
  assert.equal(p.h.buttons("Start").length, 0, "the old round is not offered");
  assert.match(p.h.text(), /Couldn't load/);
  assert.equal(p.store[C.practiceUrl("synthetic-book")], undefined, "its cached copy is dropped too");
  assert.equal(p.h.buttons("Try again").length, 1);
});

test("practice part: Turn on whose outcome is not known says 'Not sure it turned on' and reads the bank and the round again", async (t) => {
  let stored = false;
  let bankReads = 0;
  let roundReads = 0;
  const p = mountPart(t, {
    roundAnswer: () => {
      roundReads += 1;
      return response({ ...round([]), enabled: stored });
    },
    bankAnswer: () => {
      bankReads += 1;
      return response(bankBody({ enabled: stored, approved_cents: stored ? 1900 : null }));
    },
    approval: () => {
      throw new TypeError("offline");
    },
  });
  await p.h.flush();
  p.h.click("Turn on");
  await p.h.flush();
  assert.match(p.h.text(), /Not sure it turned on: No answer from Onyx/);
  assert.doesNotMatch(p.h.text(), /Not turned on/);
  assert.equal(bankReads, 2, "the bank is read again");
  assert.equal(roundReads, 2, "and the round");

  // The tap did go through: the re-read shows it, and the part follows it (no stale approval card, no message).
  stored = false;
  const p2 = mountPart(t, {
    roundAnswer: () => response({ ...round([]), enabled: stored }),
    bankAnswer: () => response(bankBody({ enabled: stored, approved_cents: stored ? 1900 : null })),
    approval: () => {
      stored = true;
      throw new TypeError("offline");
    },
  });
  await p2.h.flush();
  p2.h.click("Turn on");
  await p2.h.flush();
  assert.doesNotMatch(p2.h.text(), /Not sure it turned on|Questions on every chapter/);
  assert.match(p2.h.text(), /Nothing due/, "the part shows the book as on");
});

test("practice part: a refused Turn on says 'Not turned on' and reads nothing again", async (t) => {
  let bankReads = 0;
  const p = mountPart(t, {
    roundAnswer: () => response({ ...round([]), enabled: false }),
    bankAnswer: () => {
      bankReads += 1;
      return response(bankBody());
    },
    approval: () => response({ error: "forbidden" }, 403),
  });
  await p.h.flush();
  p.h.click("Turn on");
  await p.h.flush();
  assert.match(p.h.text(), /Not turned on: Onyx refused this\. Nothing changed\./);
  assert.doesNotMatch(p.h.text(), /Not sure/);
  assert.equal(bankReads, 1, "a refusal stored nothing: no re-read");
});

test("practice part: Turn off whose outcome is not known says 'Not sure it turned off' and re-reads; a refusal says 'Not turned off'", async (t) => {
  let reads = 0;
  const p = mountPart(t, {
    roundAnswer: () => response(round([cued(1)])),
    bankAnswer: () => {
      reads += 1;
      return response(bankBody({ enabled: true, approved_cents: 1900 }));
    },
    approval: () => {
      throw new TypeError("offline");
    },
  });
  await p.h.flush();
  p.h.click("Practice options");
  await p.h.flush();
  p.h.click("Turn off questions for this book");
  await p.h.flush();
  const before = reads;
  p.h.click("Turn off");
  await p.h.flush();
  assert.match(p.h.text(), /Not sure it turned off: No answer from Onyx/);
  assert.doesNotMatch(p.h.text(), /Not turned off/);
  assert.equal(reads, before + 1, "the bank is read again to follow the real state");

  let reads2 = 0;
  const p2 = mountPart(t, {
    roundAnswer: () => response(round([cued(1)])),
    bankAnswer: () => {
      reads2 += 1;
      return response(bankBody({ enabled: true, approved_cents: 1900 }));
    },
    approval: () => response({ error: "forbidden" }, 403),
  });
  await p2.h.flush();
  p2.h.click("Practice options");
  await p2.h.flush();
  p2.h.click("Turn off questions for this book");
  await p2.h.flush();
  const before2 = reads2;
  p2.h.click("Turn off");
  await p2.h.flush();
  assert.match(p2.h.text(), /Not turned off: Onyx refused this\. Nothing changed\./);
  assert.doesNotMatch(p2.h.text(), /Not sure/);
  assert.equal(reads2, before2, "a refusal stored nothing: no re-read");
});

/* ------------------------------------------------------------------ */
/* lib/reading-practice-client.ts                                       */
/* ------------------------------------------------------------------ */

test("attempt answers: saved, not sure (Retry the same request), refused (nothing stored), left out", () => {
  const ok = { success: true, attempt_key: "1A1A1A1A-1A1A-4A1A-8A1A-1A1A1A1A1A1A", grading_status: "graded", verdict: "correct", score: 1, attempt_date: TODAY, next_review: "2026-03-11" };
  assert.equal(C.classifyAttemptAnswer(200, ok).kind, "saved");
  assert.equal(C.classifyAttemptAnswer(200, ok).receipt.attempt_key, ok.attempt_key.toLowerCase());
  // The same request under its key answers the first receipt (a 2xx); key_reused is ANOTHER request under it, so what
  // is stored is not what is on screen: nothing new was stored and checking again takes a new key.
  assert.equal(C.classifyAttemptAnswer(409, { error: "key_reused" }).kind, "refused");
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
  const b = (o, est) => C.parseBank(bankBody({ enabled: true, ...o }, est));
  assert.equal(C.bankNotice(b({ enabled: false })), null);
  assert.deepEqual(C.bankNotice(b({ paused_reason: "budget", spent_cents: 1900 }, { cap_cents: 2500 })), { kind: "paused", moreCents: 600 });
  assert.deepEqual(C.bankNotice(b({ paused_reason: "budget", spent_cents: 2500 }, { cap_cents: 2500 })), { kind: "paused", moreCents: null }, "the $25 cap is reached");
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

test("Show choices: the options are offered shuffled by question and day, so the stored place of the answer is no hint", () => {
  let first = 0;
  const seen = new Set();
  for (let q = 100; q < 140; q++) {
    for (const day of ["2026-03-10", "2026-03-11"]) {
      const o = C.choiceOrder(4, `${q}|${day}`);
      assert.deepEqual([...o].sort((a, b) => a - b), [0, 1, 2, 3], "a permutation");
      assert.deepEqual(C.choiceOrder(4, `${q}|${day}`), o, "the same on a reopened card");
      if (o[0] === 0) first += 1;
      seen.add(o.join(""));
    }
  }
  assert.ok(first < 80, "the stored first option does not always lead");
  assert.ok(seen.size > 1, "questions get different orders");
});

test("the bank GET in S2's shape: the estimate and the cap come from `estimate`; no next due date is sent", () => {
  const b = C.parseBank(bankBody({ enabled: false, spent_cents: 300 }, { remaining_cents: 1240, cap_cents: 1900 }));
  assert.equal(b.estimate_cents, 1240, "the estimate for what is left");
  assert.equal(b.cap_cents, 1900);
  assert.equal(b.spent_cents, 300);
  assert.equal(b.next_due, null);
  const old = C.parseBank({ book_id: 7, enabled: false, chapters: [], estimate_cents: 1500, cap_cents: 1900 });
  assert.equal(old.estimate_cents, null, "top-level fields are not S2's contract");
  assert.equal(old.cap_cents, null);
  assert.equal(C.parseBank({ error: "bank_unavailable" }), null);
});

test("a refused answer says why where Riley can act: too long, another request under the key, a flagged idea that moved; the limit equals the route's", () => {
  const long = C.classifyAttemptAnswer(400, { error: "bad_answer" });
  assert.equal(long.kind, "refused");
  assert.match(long.message, /up to 4,000 characters/);
  assert.doesNotMatch(long.message, /refused this answer/);
  const reused = C.classifyAttemptAnswer(409, { error: "key_reused" });
  assert.equal(reused.kind, "refused", "the same request answers its first receipt, so this is another one: not 'saved'");
  assert.match(reused.message, /different answer/);
  const missing = C.classifyAttemptAnswer(400, { error: "states_missing" });
  assert.equal(missing.kind, "refused", "nothing was stored: the answer can be checked again");
  assert.match(missing.message, /flagged idea/);
  assert.doesNotMatch(missing.message, /question changed|left out of today/i);
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "reading-recall-server.ts"), "utf8");
  assert.equal(C.ANSWER_MAX_CHARS, Number(/export const ANSWER_MAX = (\d+);/.exec(src)[1]), "the client's limit is the route's");
});

test("the flag queue: a flag on its way is sent again with keepalive when the page hides, and is reported once", async () => {
  const timers = fakeTimers();
  const gates = [deferred(), deferred()];
  const sent = [];
  const reported = [];
  const q = C.createFlagQueue({
    timers,
    send: (f, keepalive) => {
      sent.push({ key: f.flag_key, keepalive });
      return gates[sent.length - 1].promise;
    },
    onSent: (f) => reported.push(f.flag_key),
  });
  q.add({ flag_key: "a", question_id: 1, kind: "wrong", cardKeys: [] });
  await timers.advance(C.FLAG_HOLD_MS);
  assert.deepEqual(sent, [{ key: "a", keepalive: false }]);
  assert.equal(q.list()[0].status, "sending");
  void q.flush(false);
  await tick();
  assert.equal(sent.length, 1, "a plain flush leaves a flag on its way alone");
  const again = q.flush(true);
  await tick();
  assert.deepEqual(sent, [{ key: "a", keepalive: false }, { key: "a", keepalive: true }], "keepalive: sent again, the same key");
  gates[1].resolve({ kind: "saved", value: { invalidated: 1, kind: "wrong" } });
  await again;
  assert.equal(q.list()[0].status, "sent");
  gates[0].resolve({ kind: "unknown", message: "x" });
  await tick();
  await tick();
  assert.equal(q.list()[0].status, "sent", "the first request's late answer does not turn a sent flag back");
  assert.deepEqual(reported, ["a"], "reported once");
});

/* ------------------------------------------------------------------ */
/* Review round 4: the day of the round Start opens, a re-versioned     */
/* recall, a retried flag, requests held past a closed runner           */
/* ------------------------------------------------------------------ */

const partCache = () => ({
  [C.practiceUrl("synthetic-book")]: round([cued(1), cued(2)]),
  [C.bankUrl("synthetic-book")]: bankBody({ enabled: true, approved_cents: 1900 }),
});
const onBank = () => response(bankBody({ enabled: true, approved_cents: 1900 }));

test("practice part: Start waits for this mount's first read, so a cached round (and overview) of another day never opens", async (t) => {
  runnerProps.length = 0;
  const gate = deferred();
  const p = mountPart(t, { cache: partCache(), roundAnswer: () => gate.promise, bankAnswer: onBank });
  await p.h.flush();
  assert.match(p.h.text(), /2 ready/, "the cached round is on screen at once");
  assert.equal(p.h.button("Start").props["aria-disabled"], true, "but Start waits for the server's answer");
  p.h.button("Start").props.onClick();
  await p.h.flush();
  assert.equal(p.h.find((n) => n.props["data-testid"] === "runner-stub").length, 0, "a tap opens nothing");
  // The server's round is for another day than the overview's: nothing opens (the part waits for the overview).
  gate.resolve(response({ ...round([cued(1), cued(2)]), today: "2026-03-11" }));
  await p.h.flush();
  assert.equal(p.h.buttons("Start").length, 0, "a round for another day than the overview's is not offered");
  assert.match(p.h.text(), /Loading today's round/);
});

test("practice part: once the read answers, Start opens the server's round, not the cached one", async (t) => {
  runnerProps.length = 0;
  const gate = deferred();
  const p = mountPart(t, { cache: partCache(), roundAnswer: () => gate.promise, bankAnswer: onBank });
  await p.h.flush();
  gate.resolve(response(round([cued(1), cued(2), cued(3)])));
  await p.h.flush();
  assert.match(p.h.text(), /3 ready/);
  assert.equal(p.h.button("Start").props["aria-disabled"], undefined);
  p.h.click("Start");
  await p.h.flush();
  assert.equal(runnerProps[runnerProps.length - 1].round.cards.length, 3);
});

test("practice part: a read that fails keeps the cached round off until Try again confirms it", async (t) => {
  runnerProps.length = 0;
  let reads = 0;
  const p = mountPart(t, { cache: partCache(), roundAnswer: () => (++reads === 1 ? response({ error: "failed" }, 500) : response(round([cued(1), cued(2)]))), bankAnswer: onBank });
  await p.h.flush();
  assert.match(p.h.text(), /2 ready/);
  assert.equal(p.h.button("Start").props["aria-disabled"], true, "a round that could not be checked is not offered");
  assert.match(p.h.text(), /Couldn't load: today's round could not be checked/);
  p.h.click("Try again");
  await p.h.flush();
  assert.equal(reads, 2);
  assert.equal(p.h.button("Start").props["aria-disabled"], undefined);
  assert.doesNotMatch(p.h.text(), /Couldn't load/);
});

test("practice part: back in the app after a minute the overview and the round are read again; Start waits meanwhile; never while the runner is open", async (t) => {
  runnerProps.length = 0;
  const win = fakeTarget();
  const doc = fakeTarget({ visibilityState: "visible" });
  let clock = 5_000_000;
  let reads = 0;
  let gate = null;
  const p = mountPart(t, {
    win,
    doc,
    now: () => clock,
    roundAnswer: () => {
      reads += 1;
      return gate ? gate.promise : response(round([cued(1), cued(2)]));
    },
    bankAnswer: onBank,
  });
  await p.h.flush();
  assert.equal(reads, 1);
  // 59 s away: nothing is read again.
  doc.visibilityState = "hidden";
  doc.fire("visibilitychange");
  clock += 59_000;
  doc.visibilityState = "visible";
  doc.fire("visibilitychange");
  await p.h.flush();
  assert.equal(reads, 1);
  assert.deepEqual(p.changed, []);
  // 61 s away: the overview and the round are read again, and Start waits for the answer.
  doc.visibilityState = "hidden";
  doc.fire("visibilitychange");
  clock += 61_000;
  gate = deferred();
  doc.visibilityState = "visible";
  doc.fire("visibilitychange");
  await p.h.flush();
  assert.equal(reads, 2);
  assert.deepEqual(p.changed, [1], "the overview too");
  assert.equal(p.h.button("Start").props["aria-disabled"], true);
  gate.resolve(response(round([cued(1), cued(2)])));
  await p.h.flush();
  assert.equal(p.h.button("Start").props["aria-disabled"], undefined);
  // The window losing and regaining focus counts the same way.
  gate = null;
  win.fire("blur");
  clock += 120_000;
  win.fire("focus");
  await p.h.flush();
  assert.equal(reads, 3);
  // Not while the runner is open; it reads once the runner closes, though nothing was answered.
  p.h.click("Start");
  await p.h.flush();
  const props = runnerProps[runnerProps.length - 1];
  win.fire("blur");
  clock += 120_000;
  win.fire("focus");
  await p.h.flush();
  assert.equal(reads, 3, "the open round keeps its day");
  props.onClose(false, false);
  await p.h.flush();
  assert.equal(reads, 4, "read once it closes");
  assert.equal(p.changed.length, 3);
});

test("Not in this chapter re-versions the chapter recall: the unanswered recall card takes the new question, so Check never shows the moved idea", async (t) => {
  const recall = recallCard(2);
  const revised = {
    ...recall,
    question: { ...recall.question, version: 2, rubric: { v: 1, format: "chapter_recall", ideas: [{ idea_id: 52, title: "Synthetic supporting idea", importance: "supporting" }] } },
  };
  const cards = [cued(51, { chapter: 2, again: false }), recall];
  const r = mountRunner(t, { cards, onReread: async () => round([revised]) });
  await r.h.flush();
  await menu(r.h, "Not in this chapter");
  assert.match(r.h.text(), /What do you remember of chapter 2\?/, "the recall card is next");
  await r.timers.advance(C.FLAG_HOLD_MS, r.h);
  assert.equal(r.flagsSent()[0].body.kind, "not_in_chapter");
  r.h.click("I don't know");
  await r.h.flush();
  const a = r.attempts()[0].body;
  assert.deepEqual({ question_id: a.question_id, version: a.version }, { question_id: 902, version: 2 }, "the re-versioned question is answered, not the old one");
  assert.match(r.h.text(), /Synthetic supporting idea/);
  assert.doesNotMatch(r.h.text(), /Synthetic core idea/, "the moved idea is not revealed");
});

test("Not in this chapter, and the round cannot be read again: an unanswered recall that listed the idea leaves instead of staying as it was", async (t) => {
  const cards = [cued(51, { chapter: 2, again: false }), recallCard(2)];
  const r = mountRunner(t, { cards, onReread: async () => null });
  await r.h.flush();
  await menu(r.h, "Not in this chapter");
  assert.match(r.h.text(), /What do you remember of chapter 2\?/);
  await r.timers.advance(C.FLAG_HOLD_MS, r.h);
  assert.match(r.h.text(), /Round done/);
  assert.doesNotMatch(r.h.text(), /What do you remember of chapter 2\?/);
  assert.equal(r.attempts().length, 0);
});

test("flag answers: a retry's refusal that names no reason is 'not sure'; a named reason is proof; a first try is proof either way", () => {
  for (const [status, body] of [[403, { error: "bad_request" }], [415, { error: "bad_request" }], [413, { error: "bad_request" }], [401, { error: "unauthorized" }], [429, { error: "rate_limited" }], [409, { error: "refused" }], [400, null], [404, null]]) {
    assert.equal(C.classifyFlagAnswer(status, body).kind, "refused", `first try ${status}`);
    assert.equal(C.classifyFlagAnswer(status, body, true).kind, "unknown", `retry ${status} ${JSON.stringify(body)}`);
  }
  for (const [status, body] of [[404, { error: "not_found" }], [409, { error: "key_reused" }], [409, { error: "locked" }], [409, { error: "question_changed" }], [409, { error: "superseded" }], [400, { error: "bad_request" }]]) {
    assert.equal(C.classifyFlagAnswer(status, body, true).kind, "refused", `retry ${status} ${body.error}`);
  }
  assert.equal(C.classifyFlagAnswer(null, null, true).kind, "unknown");
  assert.equal(C.classifyFlagAnswer(409, { error: "raced" }, true).kind, "unknown");
  assert.equal(C.classifyFlagAnswer(200, { success: true, kind: "wrong", invalidated: 1 }, true).kind, "saved");
});

test("the flag queue tells a send whether it is a retry of the same flag_key", async () => {
  const timers = fakeTimers();
  const seen = [];
  const q = C.createFlagQueue({
    timers,
    send: async (f, keepalive, retried) => {
      seen.push({ key: f.flag_key, retried });
      return seen.length === 1 ? { kind: "unknown", message: "x" } : { kind: "saved", value: { invalidated: 0, kind: f.kind } };
    },
  });
  q.add({ flag_key: "a", question_id: 1, kind: "wrong", cardKeys: [] });
  await timers.advance(C.FLAG_HOLD_MS);
  await tick();
  await tick();
  await q.retry("a");
  assert.deepEqual(seen, [{ key: "a", retried: false }, { key: "a", retried: true }]);
});

test("a flag whose answer was lost and whose retry is refused without a reason stays 'not sure' with Retry; its cards do not come back", async (t) => {
  let n = 0;
  const r = mountRunner(t, {
    cards: [cued(1), cued(2)],
    flagAnswer: (b) => {
      n += 1;
      if (n === 1) throw new TypeError("offline");
      if (n === 2) return response({ error: "rate_limited" }, 429);
      return response({ success: true, kind: b.kind, invalidated: 0, replayed: true });
    },
  });
  await r.h.flush();
  await menu(r.h, "Unclear");
  await r.timers.advance(C.FLAG_HOLD_MS, r.h);
  assert.match(r.h.text(), /Flag not sure:/);
  r.h.click("Retry flag");
  await r.h.flush();
  assert.match(r.h.text(), /Flag not sure: Onyx refused this retry/);
  assert.doesNotMatch(r.h.text(), /Flag not saved/);
  assert.equal(r.h.buttons("Retry flag").length, 1, "Retry stays");
  assert.doesNotMatch(r.h.text(), /Synthetic prompt 1\?/, "the flagged card stays off screen while the flag may be stored");
  r.h.click("Retry flag");
  await r.h.flush();
  assert.equal(r.flagsSent().length, 3);
  assert.equal(new Set(r.flagsSent().map((f) => f.body.flag_key)).size, 1, "every try carries the same flag_key");
  assert.doesNotMatch(r.h.text(), /Flag not/);
});

test("held requests: matched by round, question and version only; a conclusive answer releases one, an unknown one keeps it", async (t) => {
  const outbox = new Map();
  const req = { attempt_key: "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a", question_id: 101, version: 1, round_key: ROUND_KEY, round_date: TODAY, round_kind: "daily", answer: "alpha 1", hinted: false, response_ms: 5 };
  outbox.set(req.attempt_key, req);
  assert.equal(C.heldAttemptFor(outbox, ROUND_KEY, { question_id: 101, version: 1 }), req);
  assert.equal(C.heldAttemptFor(outbox, ROUND_KEY, { question_id: 101, version: 2 }), null, "another version of the question");
  assert.equal(C.heldAttemptFor(outbox, ROUND_KEY, { question_id: 102, version: 1 }), null);
  assert.equal(C.heldAttemptFor(outbox, "1f1f1f1f-1f1f-4f1f-8f1f-1f1f1f1f1f1f", { question_id: 101, version: 1 }), null, "another round");
  assert.equal(C.heldAttemptFor(outbox, ROUND_KEY, null), null);
  let reply = "offline";
  withGlobals(t, {
    fetch: async () => {
      if (reply === "offline") throw new TypeError("offline");
      return reply;
    },
  });
  assert.equal((await C.resendAttempt(outbox, req, true)).kind, "unknown");
  assert.equal(outbox.size, 1, "no answer: still held");
  reply = response({ error: "unauthorized" }, 401);
  assert.equal((await C.resendAttempt(outbox, req)).kind, "unknown", "a refusal that names no reason proves nothing about the earlier try");
  assert.equal(outbox.size, 1);
  reply = response(serverReceipt([cued(1)], req, { replayed: true }));
  assert.equal((await C.resendAttempt(outbox, req)).kind, "saved");
  assert.equal(outbox.size, 0, "the receipt released it");
});

test("closing with an unconfirmed answer keeps its request: the reopened round shows that card as 'not sure' first, and Retry sends the SAME request (never a new key)", async (t) => {
  const outbox = new Map();
  const cards = [cued(1), cued(2)];
  const r1 = mountRunner(t, {
    cards,
    outbox,
    answer: () => {
      throw new TypeError("offline");
    },
  });
  await r1.h.flush();
  await menu(r1.h, "Skip for now");
  assert.match(r1.h.text(), /Synthetic prompt 2\?/);
  typeAnswer(r1.h, "alpha 2");
  await r1.h.flush();
  r1.h.click("Check");
  await r1.h.flush();
  assert.match(r1.alerts()[0], /Not sure it saved/);
  r1.h.click("Close practice");
  await r1.h.flush();
  assert.equal(r1.closed.length, 1);
  r1.h.unmount();
  assert.equal(outbox.size, 1, "the request outlives the runner");

  const r2 = mountRunner(t, { cards, outbox });
  await r2.h.flush();
  assert.match(r2.h.text(), /Synthetic prompt 2\?/, "the card with the unconfirmed answer comes first, though card 1 is still open");
  assert.match(r2.alerts()[0], /Not sure it saved: This answer was sent before you closed the round/);
  assert.equal(r2.h.buttons("Check").length, 0, "the question cannot be answered again under a new key");
  assert.equal(r2.h.find((n) => n.type === "textarea")[0].props.value, "alpha 2", "the answer is shown as it was given");
  r2.h.click("Retry");
  await r2.h.flush();
  assert.equal(r2.attempts().length, 1);
  assert.deepEqual(r2.attempts()[0].body, r1.attempts()[0].body, "the same request: the same attempt_key");
  assert.equal(new Set([...r1.attempts(), ...r2.attempts()].map((a) => a.body.attempt_key)).size, 1);
  assert.equal(r2.alerts().length, 0);
  assert.equal(outbox.size, 0, "the receipt released it");
  r2.h.click("Next");
  await r2.h.flush();
  assert.match(r2.h.text(), /Synthetic prompt 1\?/, "then the cards still open");
});

test("closing while an answer is still on its way: the wait runs out, the request stays held, a reopened round retries the SAME key, and the late answer releases it", async (t) => {
  const outbox = new Map();
  const gate = deferred();
  const cards = [cued(1), cued(2)];
  const r1 = mountRunner(t, { cards, outbox, answer: (b) => gate.promise.then(() => response(serverReceipt(cards, b))) });
  await r1.h.flush();
  typeAnswer(r1.h, "alpha 1");
  await r1.h.flush();
  r1.h.click("Check");
  await r1.h.flush();
  r1.h.click("Close practice");
  let settled = false;
  void r1.settles[0].then(() => (settled = true));
  await r1.timers.advance(10_000, r1.h);
  assert.equal(settled, true, "the wait ran out although the request is still on its way");
  r1.h.unmount();
  assert.equal(outbox.size, 1);

  const r2 = mountRunner(t, { cards, outbox });
  await r2.h.flush();
  assert.equal(r2.h.buttons("Check").length, 0, "no new key while the first request may still commit");
  assert.match(r2.alerts()[0], /Not sure it saved/);
  gate.resolve();
  await r2.h.flush();
  assert.equal(outbox.size, 0, "the late answer released the request");
  r2.h.click("Retry");
  await r2.h.flush();
  assert.equal(r2.attempts().length, 1);
  assert.equal(r2.attempts()[0].body.attempt_key, r1.attempts()[0].body.attempt_key);
  assert.equal(r2.alerts().length, 0);
});
