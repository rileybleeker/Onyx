// Run: node --test tests/log-drafts.test.cjs
// The Log screen (/log, AGENTS.md "Log screen"): the draft store the Say it box writes and each section reads
// (src/lib/log-drafts.ts), and the frame's wiring (nav, Quick access, scroll, bottom bar). Offline, synthetic.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const D = loadTs("lib/log-drafts.ts");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

test("a draft per section; the newest wins; ids increase", () => {
  D.clearAllLogDrafts();
  const a = D.setLogDraft("weight", { lb: 180.4, date: null }, "I weighed 180.4");
  const b = D.setLogDraft("weight", { lb: 181, date: "2026-11-14" });
  assert.ok(b.id > a.id);
  assert.deepEqual(D.getLogDraft("weight").value, { lb: 181, date: "2026-11-14" });
  assert.equal(D.getLogDraft("reading"), null);
  assert.equal(b.section, "weight");
  assert.equal(a.said, "I weighed 180.4");
});

test("clear(id) never removes a newer draft; clear() removes whatever is there", () => {
  D.clearAllLogDrafts();
  const old = D.setLogDraft("checkin", { text: "gym, no alcohol" });
  const now = D.setLogDraft("checkin", { text: "gym, two drinks" });
  D.clearLogDraft("checkin", old.id);
  assert.equal(D.getLogDraft("checkin").id, now.id, "the newer draft stays");
  D.clearLogDraft("checkin", now.id);
  assert.equal(D.getLogDraft("checkin"), null);
  D.setLogDraft("checkin", { text: "x" });
  D.clearLogDraft("checkin");
  assert.equal(D.getLogDraft("checkin"), null);
});

test("setLogDrafts writes several sections in one notification and keeps the others", () => {
  D.clearAllLogDrafts();
  const keep = D.setLogDraft("reading", { book: null, minutes: 20, chapter_from: null, chapter_through: 4, medium: "kindle", recall: null, date: null });
  let calls = 0;
  const off = D.subscribeLogDrafts(() => { calls += 1; });
  D.setLogDrafts({
    checkin: { text: "lifted, no screens in bed" },
    supplements: [{ kind: "stack", stack_id: null, name: "morning stack", time: "08:30", date: null }],
    ubereats: [{ kind: "portion", item_id: 42, fraction: 0.5 }],
  }, "said");
  off();
  assert.equal(calls, 1);
  assert.equal(D.getLogDraft("reading").id, keep.id);
  assert.equal(D.getLogDraft("supplements").value[0].name, "morning stack");
  assert.equal(D.getLogDraft("ubereats").value[0].fraction, 0.5);
  D.setLogDrafts({});
  assert.equal(D.getLogDraft("checkin").value.text, "lifted, no screens in bed");
});

test("memory only: the store never touches storage or the network", () => {
  const src = read("lib/log-drafts.ts");
  assert.ok(!/localStorage|sessionStorage|indexedDB|fetch\(/.test(src.replace(/^\s*(\*|\/\/).*$/gm, "")));
  assert.equal(D.FROM_WHAT_YOU_SAID, "from what you said");
  assert.deepEqual([...D.LOG_SECTIONS], ["checkin", "journal", "supplements", "ubereats", "weight", "reading", "drinks"]);
});

test("drinks: several drafts at once, each with its stable key; memory only like every section", () => {
  D.clearAllLogDrafts();
  const key = "0b8f2a6e-5d1c-4f3e-9a7b-2c4d6e8f0a1b";
  D.setLogDrafts({
    drinks: [
      { key, product_id: "gorilla-mind-energy-wild-grape-16oz", said: "one wild grape Gorilla Mind", issue: null, servings: 1, time: null, date: null, when_issue: null, captured_at: 1 },
      { key: "1b8f2a6e-5d1c-4f3e-9a7b-2c4d6e8f0a1b", product_id: null, said: "Gorilla Mind", issue: "flavor", servings: null, time: null, date: null, when_issue: "bad_date", captured_at: 1 },
    ],
  }, "one wild grape Gorilla Mind and a Gorilla Mind");
  const d = D.getLogDraft("drinks");
  assert.equal(d.value.length, 2);
  assert.equal(d.value[0].key, key);
  assert.equal(d.value[1].issue, "flavor", "an unresolved drink is kept, not dropped");
  assert.equal(D.getLogDraft("supplements"), null, "a drink is not a supplement draft");
});

test("useLogDrafts renders the section's current draft", () => {
  D.clearAllLogDrafts();
  D.setLogDraft("weight", { lb: 179, date: null });
  function Probe() {
    const { draft } = D.useLogDrafts("weight");
    return React.createElement("span", null, draft ? String(draft.value.lb) : "none");
  }
  // Server render: the server snapshot is "no draft" (drafts exist only in the browser).
  assert.equal(renderToStaticMarkup(React.createElement(Probe)), "<span>none</span>");
});

test("the frame: nav item, Quick access, scroll entry, bottom bar, warm-up", () => {
  assert.match(read("lib/nav.ts"), /\{ href: "\/log", label: "Log", shortcut: "1"/);
  assert.match(read("lib/nav-areas.ts"), /QUICK_ACCESS: readonly string\[\] = \["\/today", "\/log"\]/);
  assert.match(read("lib/feed-order.ts"), /DEFAULT_PINNED: readonly string\[\] = \["\/today", "\/log"\]/);
  const registry = read("lib/feed-registry.ts");
  assert.match(registry, /"\/log": \(\) => import\("@\/app\/log\/FeedSection"\)/);
  assert.ok(!registry.includes('"/check-in":'), "the check-in is shown once in the scroll: inside Log");
  assert.match(read("components/MobileNav.tsx"), /const LOG_HREF = "\/log";/);
  assert.match(read("components/AppData.tsx"), /"\/log": \(\) => import\("@\/app\/log\/LogClient"\)/);
});

test("the sections are Personalize parts in the default order, each its own file", () => {
  const client = read("app/log/LogClient.tsx");
  const ids = [...client.matchAll(/<Part id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["say-it", "check-in", "journal", "supplements", "uber-eats", "weight", "reading"]);
  assert.match(client, /<PartGrid page="\/log" title="Log">/);
  for (const f of ["SayIt", "CheckIn", "Journal", "Supplements", "UberEats", "Weight", "Reading"]) {
    assert.match(client, new RegExp(`import\\("\\./sections/${f}"\\)`), f);
    assert.ok(fs.existsSync(path.join(SRC, "app/log/sections", `${f}.tsx`)), f);
  }
});

test("the Check-in section is the real check-in, not a copy, and never owns Personalize", () => {
  const section = read("app/log/sections/CheckIn.tsx");
  assert.match(section, /import CheckInClient from "@\/app\/check-in\/CheckInClient";/);
  assert.match(section, /<InFeed>/);
  assert.match(section, /<CheckInClient feed embedded omitParts=\{OMIT\} earlyRead=\{routed\} \/>/);
  const checkin = read("app/check-in/CheckInClient.tsx");
  assert.match(checkin, /useLogDrafts\("checkin"\)/);
  assert.match(checkin, /if \(!embedded \|\| !logDraft\) return;/, "only the embedded check-in takes Log drafts");
});

test("the skeletons stay server-safe (loading.tsx renders them on the server)", () => {
  for (const f of ["app/log/sections/ui.tsx", "app/log/LogSkeleton.tsx", "app/log/loading.tsx"]) {
    const text = read(f);
    assert.ok(!/^"use client"/.test(text), `${f} is not a client module`);
    assert.ok(!/^import (?!type )[^;]*from "react"/m.test(text), `${f} imports no React runtime`);
    assert.ok(!/from "@\/lib\/log-drafts"/.test(text), `${f} must not import lib/log-drafts.ts (hooks)`);
  }
  assert.match(read("app/log/sections/ui.tsx"), /const FROM_WHAT_YOU_SAID = "from what you said";/);
});

test("journal drafts: the Journal section reads them; the embedded check-in sends its own there, not to a card", () => {
  D.clearAllLogDrafts();
  const d = D.setLogDraft("journal", { body: "Synthetic words.", source: "voice", title: null, mood: null, confidence: null, topics: [] }, "Synthetic words.");
  assert.equal(D.getLogDraft("journal").id, d.id);
  const section = read("app/log/sections/Journal.tsx");
  assert.match(section, /useLogDrafts\("journal"\)/);
  assert.match(section, /export const REPLACES_CHECKIN_JOURNAL_DRAFT = true;/);
  assert.match(read("app/log/sections/CheckIn.tsx"), /REPLACES_CHECKIN_JOURNAL_DRAFT \? \["journal-draft"\]/);
  const checkin = read("app/check-in/CheckInClient.tsx");
  assert.match(checkin, /if \(omit\.has\("journal-draft"\)\) \{[\s\S]{0,400}setLogDraft\("journal"/);
  assert.match(checkin, /\{journal && !omit\.has\("journal-draft"\) && \(/);
  // The only writes (autosave): file once (POST /api/journal/file), then update that page (PATCH .../[pageId]).
  assert.deepEqual([...section.matchAll(/send\(\s*("[^"]+"|`[^`]+`)/g)].map((m) => m[1]), ['`/api/journal/file/${encodeURIComponent(f.id)}`', '"/api/journal/file"']);
  assert.equal((section.match(/fetch\(/g) || []).length, 1, "one fetch, inside send()");
  assert.match(section, /"POST" \| "PATCH"/);
  // A draft is filed by itself only when Riley asked for it ("journal:"); otherwise it waits for Keep.
  assert.match(section, /if \(value\.asked\) \{[\s\S]{0,200}push\(/);
  assert.match(section, /setHeld\("draft"\)/);
  assert.match(read("components/AppData.tsx"), /"\/log": \(\) => \[[^\]]*journalTodayUrl\(new Date\(\)\)/);
});

test("nothing on /log writes on open: no write in the frame or the placeholders", () => {
  for (const f of ["app/log/LogClient.tsx", "app/log/FeedSection.tsx", "app/log/LogLoader.tsx", "app/log/sections/CheckIn.tsx", "app/log/sections/ui.tsx"]) {
    assert.ok(!/method:\s*["'](POST|PATCH|PUT|DELETE)["']/.test(read(f)), f);
  }
});
