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
  assert.match(html, /<span role="status" aria-live="polite" aria-atomic="true" class="sr-only">[^<]*<\/span>/, "the region holds text only");
  assert.doesNotMatch(html, /role="alert"/);
  assert.match(html, /^<span id="synthetic-status" tabindex="-1"/, "fields can point at the line; Retry's focus can land on it");
});

test("announcement: each result once; a retry failing the same way is not read again; a reset starts over", () => {
  const a = S.announcement;
  let text = "";
  text = a(text, state({ status: "waiting" }), "Saved");
  assert.equal(text, "", "waiting is not announced");
  text = a(text, state({ status: "saving" }), "Saved");
  assert.equal(text, "", "saving is not announced");
  text = a(text, state({ status: "error", error: "Synthetic outage", retrying: true }), "Saved");
  assert.equal(text, "Not saved: Synthetic outage");
  const failed = text;
  text = a(text, state({ status: "saving" }), "Saved");
  text = a(text, state({ status: "error", error: "Synthetic outage", retrying: true }), "Saved");
  assert.equal(text, failed, "the same failure again: same text, nothing new to read");
  text = a(text, state({ status: "saved", savedAt: 5 }), "Saved");
  assert.equal(text, "Saved", "recovered: announced");
  text = a(text, state({ status: "waiting", savedAt: 5 }), "Saved");
  assert.equal(text, "Saved", "a new edit keeps the last result until the next one");
  text = a(text, state({ status: "idle", savedAt: null }), "Saved");
  assert.equal(text, "", "reset (a new entry): the next result is read again");
  assert.equal(S.failureText({ error: null }), "Not saved: save failed.");
});
