// Run: node --test tests/log-draft-retention.test.cjs (offline, static source checks). PROD-T01, 2026-11-16: the
// continuous scroll never unmounts a page holding unsaved work; forms report it under the page they are drawn in;
// the /log Reading form keeps its entry and operation key past its component; Journal keeps its own behaviour.
// Behaviour itself: tests/autosave-retain.test.cjs, tests/log-reading-retain.test.cjs, tests/unsaved-work.test.cjs.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

test("the scroll keeps a page with unsaved work mounted and re-checks when that work settles", () => {
  const scroll = read("components/ContinuousScroll.tsx");
  const prune = scroll.slice(scroll.indexOf("const prune = useCallback"), scroll.indexOf("// ---- growing the scroll"));
  assert.match(prune, /if \(unsavedWork\.hasIn\(route\)\) return;/, "prune skips a page holding unsaved work");
  assert.ok(prune.indexOf("unsavedWork.hasIn(route)") > prune.indexOf("!routesRef.current.includes(route)"), "a page no longer in the list still goes");
  assert.match(scroll, /const offWork = unsavedWork\.subscribe\(\(\) => prune\(\)\);/);
  assert.match(scroll, /offWork\(\);/, "unsubscribed with the observers");
  assert.match(scroll, /<FeedScopeContext\.Provider value=\{route\}>\s*<Comp \/>/, "each page's forms report under its route");
  assert.match(scroll, /<InFeed>\s*<SectionBoundary/, "scrolling still never writes (tests/feed-no-writes.test.cjs)");
});

test("forms report unsaved work under the scroll page they are drawn in", () => {
  const hook = read("lib/use-unsaved-work.ts");
  assert.match(hook, /const scope = useFeedScope\(\);/);
  assert.match(hook, /unsavedWork\.setDirty\(key, dirty, scope\);/);
  assert.match(read("lib/feed-scope.ts"), /createContext<string \| null>\(null\)/, "null outside the scroll and on the routed page");
});

test("/log Reading keeps its entry, the session it made and its client_key with the retained saver", () => {
  const reading = read("app/log/sections/Reading.tsx");
  assert.match(reading, /useRetainedAutosave<SessionValue, ReadingFormData>\(\s*"log-reading"/);
  assert.match(reading, /client_key: kept\.clientKey/, "the create's operation key lives with the kept entry");
  assert.doesNotMatch(reading, /sessionRef|clientKey = useRef|const touched = useRef/, "no component-local copy of the entry's identity");
  assert.match(reading, /if \(!v\.body\) throw new AutosaveRefused/, "never \"Saved\" without a request");
  assert.match(reading, /<AutosaveStatus\s+id=\{statusId\}/);
  assert.match(reading, /unknownOutcome: mayHaveStored,/, "a failure that may have been stored leaves nothing counted as saved (T01-R3)");
  assert.match(reading, /const mayHaveStored = \(e: unknown\) => !\(e instanceof AutosaveRefused\);/);
  assert.match(reading, /: kept\.unconfirmed \? "Not confirmed:" : undefined;/, "and reads Not confirmed");
  assert.match(reading, /errorLabel=\{errorLabel\}/);
  // A create that went out with no confirmed answer is never dropped locally (PR 376 review): Discard and emptying
  // the form save DISCARD, which removes the session by the create's own key, and the entry goes only after that.
  assert.match(reading, /if \(v\.discard\) return discardStored\(/);
  assert.match(reading, /`\/api\/reading\/sessions\?client_key=\$\{encodeURIComponent\(kept\.clientKey\)\}`/);
  const discard = reading.slice(reading.indexOf("const discardEntry = () =>"), reading.indexOf("const applyDraft = async"));
  // createSent, not entrySent: a create with a chosen day goes out too (entrySent covers creates with no day only).
  assert.match(discard, /if \(kept\.sessionId === null && !kept\.createSent\) \{\s*startNew\(\);/, "dropped at once only when no create went out");
  assert.match(discard, /autosave\.change\(DISCARD\);/);
  const commitFn = reading.slice(reading.indexOf("const commit = (next: Form) =>"), reading.indexOf("// The behavioral day the server reports"));
  assert.ok(commitFn.indexOf("if (kept.createSent) {") > -1, "emptying checks whether a create went out");
  assert.ok(commitFn.indexOf("if (kept.createSent) {") < commitFn.indexOf("autosave.reset();"), "emptying after a sent create saves DISCARD, not a reset");
  assert.match(reading, /kept\.createSent = true;\s*json = await send\(target\.url, "POST", body\);/, "marked before the create goes out");
  const stored = reading.slice(reading.indexOf("const discardStored = async"), reading.indexOf("const autosave = useRetainedAutosave"));
  assert.ok(stored.indexOf("if (cancelled()) return;") < stored.indexOf("forgetEntry();"), "a session end stops it before the entry is touched");
  assert.doesNotMatch(stored, /method: "POST"|saveRequest\(/, "a discard never creates a session to find one");
  assert.match(stored, /kept\.clientKey = newClientKey\(\);/, "a confirmed discard retires the key: the server refuses it from then on");
  assert.match(reading, /aria-describedby=\{describedBy\}/, "fields point at the status line while it says why");
});

test("Journal keeps its own draft behaviour (plain saver, its device copy and held entry)", () => {
  const journal = read("app/log/sections/Journal.tsx");
  assert.match(journal, /useAutosave<Words>\("journal"/);
  assert.doesNotMatch(journal, /useRetainedAutosave/);
  assert.match(journal, /useUnsavedWork\(held !== null && body\.trim\(\) !== "", "journal-held"\)/);
});

test("the status line has one live region and no alert role", () => {
  const status = read("components/AutosaveStatus.tsx");
  assert.doesNotMatch(status, /role=\{status === "error" \? "alert"/);
  assert.equal((status.match(/role="status"/g) || []).length, 1);
  assert.match(status, /Not saved yet/);
});
