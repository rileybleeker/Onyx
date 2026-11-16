// Run: node --test tests/autosave-status.test.cjs (offline). The status line every autosaving form shows
// (components/AutosaveStatus.tsx), PROD-T01 2026-11-16: an entry waiting, a save under way, a confirmed save and a
// failure read differently; "Saved" appears only for a save the server answered; the result is announced once from
// its own live region, and Retry is outside it. SYNTHETIC DATA ONLY.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { loadTs } = require("./helpers/load-ts.cjs");

const S = loadTs("components/AutosaveStatus.tsx", { "lucide-react": { Check: () => null } });
const state = (over = {}) => ({ status: "idle", error: null, retrying: false, savedAt: null, ...over });
const render = (props) => renderToStaticMarkup(React.createElement(S.AutosaveStatus, { onRetry: () => {}, ...props }));

test("four states never look alike: waiting, saving, saved, failed", () => {
  const waiting = render({ state: state({ status: "waiting" }) });
  assert.match(waiting, /Not saved yet/);
  assert.doesNotMatch(waiting, /Saving…|>Saved</, "an entry still waiting is neither in flight nor saved");

  const saving = render({ state: state({ status: "saving" }) });
  assert.match(saving, /Saving…/);
  assert.doesNotMatch(saving, /Not saved yet|>Saved</);

  const saved = render({ state: state({ status: "saved", savedAt: 1 }), savedText: "Saved · +10 XP" });
  assert.match(saved, /Saved · \+10 XP/);

  const failed = render({ state: state({ status: "error", error: "Couldn't reach Onyx.", retrying: true }) });
  assert.match(failed, /Not saved: Couldn(&#x27;|')t reach Onyx\. Trying again…/);
  assert.match(failed, /<button type="button"[^>]*>Retry<\/button>/);
  assert.doesNotMatch(failed, /Saving…|Not saved yet/);
});

test("idle shows nothing; an incomplete entry shows its reason only when asked to", () => {
  assert.doesNotMatch(render({ state: state() }), /Saved|Saving|Not saved/);
  const incomplete = state({ status: "incomplete", error: "Enter the chapter you read through to save." });
  assert.doesNotMatch(render({ state: incomplete }), /Enter the chapter/);
  assert.match(render({ state: incomplete, showIncomplete: true }), /Enter the chapter you read through to save\./);
});

test("one polite live region, without the Retry button; no alert role that would read it twice", () => {
  const html = render({ state: state({ status: "error", error: "Synthetic outage" }), id: "synthetic-status" });
  assert.equal((html.match(/role="status"/g) || []).length, 1);
  assert.match(html, /<span role="status" aria-live="polite" aria-atomic="true" class="sr-only"><span>[^<]*<\/span><\/span>/, "the region holds text only");
  assert.doesNotMatch(html, /role="alert"/);
  assert.match(html, /^<span tabindex="-1"/, "Retry's focus can land on the line");
  // aria-describedby names the visible text only: never the live region, which can hold an earlier result.
  assert.match(html, /<span id="synthetic-status"><span[^>]*><span>Not saved: Synthetic outage<\/span>/);
  const idPart = html.slice(html.indexOf('<span id="synthetic-status">'), html.indexOf('<span role="status"'));
  assert.doesNotMatch(idPart, /role="status"/);
});

test("nextAnnouncement: each result once; a retry failing the same way is not read again; anything else empties it", () => {
  const next = (prev, over, savedText = "Saved") => S.nextAnnouncement(prev, state(over), savedText);
  let a = S.NO_ANNOUNCEMENT;
  a = next(a, { status: "waiting" });
  assert.equal(a.text, "", "waiting is not announced");
  a = next(a, { status: "saving" });
  assert.equal(a.text, "", "saving is not announced");
  a = next(a, { status: "error", error: "Synthetic outage", retrying: true });
  assert.equal(a.text, "Not saved: Synthetic outage");
  const failed = a;
  a = next(a, { status: "saving" });
  assert.equal(a, failed, "a retry under way keeps its failure");
  a = next(a, { status: "error", error: "Synthetic outage", retrying: true });
  assert.equal(a, failed, "the same failure again: nothing new to read");
  a = next(a, { status: "saved", savedAt: 5 });
  assert.equal(a.text, "Saved", "recovered: announced");
  assert.notEqual(a.seq, failed.seq);
  const first = a;
  a = next(a, { status: "saved", savedAt: 5 });
  assert.equal(a, first, "the same state rendered again: not read again");
  a = next(a, { status: "saved", savedAt: 9 });
  assert.equal(a.text, "Saved");
  assert.notEqual(a.seq, first.seq, "a second confirmed save with the same words is a new result (new text node)");
  const second = a;
  a = next(a, { status: "incomplete", error: "Enter the chapter you read through to save.", savedAt: 9 });
  assert.equal(a.text, "", "an incomplete entry: no stale Saved left in the region");
  a = next(a, { status: "saved", savedAt: 9 }, "Saved");
  a = next(a, { status: "idle", savedAt: 9 });
  assert.equal(a.text, "", "a reset that kept savedAt still empties the region");
  a = next(a, { status: "saved", savedAt: 12 });
  assert.equal(a.text, "Saved", "the new entry's first save is announced");
  assert.ok(a.seq > second.seq);
  assert.equal(S.failureText({ error: null }), "Not saved: save failed.");
});

test("a real Autosaver: a reset clears the announcement and successive saves are each a new result", async () => {
  const autosave = loadTs("lib/autosave.ts");
  let now = 100;
  const pending = [];
  const timers = { set: (fn) => { pending.push(fn); return pending.length; }, clear: () => {} };
  const saver = new autosave.Autosaver({ save: async () => {}, delayMs: 10, timers, now: () => (now += 1) });
  let a = S.NO_ANNOUNCEMENT;
  const seen = () => { a = S.nextAnnouncement(a, saver.state, "Saved"); return a; };

  saver.change({ v: 1 });
  seen();
  await saver.flush();
  const one = seen();
  assert.equal(one.text, "Saved");

  saver.change({ v: 2 });
  await saver.flush(); // waiting and saved may land in one render: only the final state is seen
  const two = seen();
  assert.equal(two.text, "Saved");
  assert.notEqual(two.seq, one.seq, "the second save is read too");

  saver.reset();
  assert.notEqual(saver.state.savedAt, null, "Autosaver.reset keeps savedAt");
  assert.equal(seen().text, "", "yet the region is emptied for the new entry");
  saver.change({ v: 3 });
  assert.equal(seen().text, "");
  await saver.flush();
  const three = seen();
  assert.equal(three.text, "Saved");
  assert.ok(three.seq > two.seq);
  saver.dispose();
});
