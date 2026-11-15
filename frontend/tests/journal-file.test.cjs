// Run: node --test tests/journal-file.test.cjs
// Filing a journal entry from the /log Journal section: the pure rules (lib/journal-file.ts) and the rules of
// POST /api/journal/file. SYNTHETIC text only; no network, no Notion, no model.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const F = loadTs("lib/journal-file.ts");
const J = loadTs("lib/journal-entry.ts");

const TODAY = "2031-03-05";
const BODY = "Synthetic first paragraph.\nSame paragraph, next line.\n\nSynthetic second paragraph.";
const plain = (v) => JSON.parse(JSON.stringify(v));
const ok = (raw) => {
  const v = F.validateJournalFile(raw, TODAY);
  assert.equal(v.ok, true, JSON.stringify(v));
  return v.input;
};

test("validation: body and source are enough; the date defaults to today in New York", () => {
  const input = ok({ body: "  " + BODY + "\n", source: "typed" });
  assert.deepEqual(plain(input), { date: TODAY, source: "typed", body: BODY, title: "", mood: null, confidence: null, topics: [] });
  assert.equal(F.needsLabels(input), true);
});

test("validation: refuses an empty body, an unknown source, a future or unreal day, bad labels", () => {
  for (const raw of [
    { body: "  ", source: "typed" },
    { body: 5, source: "typed" },
    { body: BODY, source: "remarkable" },
    { body: BODY },
    { body: BODY, source: "voice", date: "2031-03-06" },
    { body: BODY, source: "voice", date: "2031-02-30" },
    { body: BODY, source: "voice", mood: "sad" },
    { body: BODY, source: "voice", confidence: "sure" },
    { body: BODY, source: "voice", topics: "work" },
    { body: BODY, source: "voice", topics: ["work", "work"] },
    { body: BODY, source: "voice", topics: ["not a tag!"] },
    { body: BODY, source: "voice", topics: Array.from({ length: J.JOURNAL_MAX_TOPICS + 1 }, (_, i) => `t-${i}`) },
    { body: BODY, source: "voice", title: "x".repeat(J.JOURNAL_MAX_TITLE_CHARS + 1) },
    { body: "x".repeat(J.JOURNAL_MAX_BODY_CHARS + 1), source: "voice" },
    null,
    [],
  ]) {
    assert.equal(F.validateJournalFile(raw, TODAY).ok, false, JSON.stringify(raw)?.slice(0, 80));
  }
});

test("labels: Riley's labels win, the model fills only the blanks, the body is never touched", () => {
  const input = ok({ body: BODY, source: "voice", title: "Synthetic title Riley wrote", topics: ["Sleep"] });
  assert.equal(F.needsLabels(input), true, "mood and confidence are still blank");
  const entry = F.completeEntry(input, { title: "Model title ignored here", mood: "good", confidence: "low", topics: ["work"], body: "a rewrite the model must never supply" }, TODAY);
  assert.deepEqual(plain(entry), { date: TODAY, title: "Synthetic title Riley wrote", mood: "good", confidence: "low", source: "voice", topics: ["sleep"], body: BODY });
  const full = ok({ body: BODY, source: "typed", title: "Synthetic complete label set", mood: "neutral", confidence: "high", topics: ["reflection"] });
  assert.equal(F.needsLabels(full), false, "nothing to infer: no model call");
  assert.equal(F.completeEntry(full, null, TODAY).title, "Synthetic complete label set");
});

test("labels: an unusable model answer files nothing", () => {
  const input = ok({ body: BODY, source: "typed" });
  assert.equal(F.completeEntry(input, null, TODAY), null);
  assert.equal(F.completeEntry(input, { title: "Journal entry", mood: "good", confidence: "medium", topics: ["work"] }, TODAY), null, "generic title");
  assert.equal(F.completeEntry(input, { title: "Synthetic specific title here", mood: "sad", confidence: "medium", topics: ["work"] }, TODAY), null, "no mood");
  assert.equal(F.completeEntry(input, { title: "Synthetic specific title here", mood: "good", confidence: "medium", topics: [] }, TODAY), null, "no topic");
  const e = F.completeEntry(input, { title: "Synthetic specific title here", mood: "good", confidence: "maybe", topics: ["Mental Health"] }, TODAY);
  assert.equal(e.confidence, "medium", "confidence falls back to the rule's default");
  assert.deepEqual(plain(e.topics), ["mental-health"]);
});

test("label schema and rules: the four labels only, never a body", () => {
  assert.deepEqual(plain(F.JOURNAL_LABEL_SCHEMA.required), ["title", "mood", "confidence", "topics"]);
  assert.equal(F.JOURNAL_LABEL_SCHEMA.additionalProperties, false);
  assert.deepEqual(plain(F.JOURNAL_LABEL_SCHEMA.properties.mood.enum), plain(J.JOURNAL_MOODS));
  assert.match(F.JOURNAL_LABEL_RULES, /3 to 8 words/);
  assert.match(F.JOURNAL_LABEL_RULES, /Do not summarize or rewrite/);
});

test("journal: prefix: the words after it; Dear journal is the entry itself", () => {
  assert.equal(F.journalPrefixText("journal: synthetic day felt long"), "synthetic day felt long");
  assert.equal(F.journalPrefixText("  Journal entry - synthetic words\nsecond line"), "synthetic words\nsecond line");
  assert.equal(F.journalPrefixText("JOURNAL — synthetic"), "synthetic");
  assert.equal(F.journalPrefixText("journal:   "), null);
  assert.equal(F.journalPrefixText("Dear journal, synthetic"), null);
  assert.equal(F.journalPrefixText("two coffees and the morning stack"), null);
  assert.equal(F.journalPrefixText("my journal: synthetic"), null, "only at the start");
});

test("verbatim excerpt: only an exact quote of the text counts", () => {
  const text = "Two synthetic coffees. Today felt heavy, but the walk helped.";
  assert.equal(F.verbatimExcerpt(text, "  Today felt heavy, but the walk helped. "), "Today felt heavy, but the walk helped.");
  assert.equal(F.verbatimExcerpt(text, "Today felt heavy but the walk helped."), null, "a changed comma is not a quote");
  assert.equal(F.verbatimExcerpt(text, "I felt heavy today."), null);
  assert.equal(F.verbatimExcerpt(text, ""), null);
  assert.equal(F.verbatimExcerpt(text, 7), null);
});

test("Say it journal draft: a journal: prefix or a reflection, the body always the person's words", () => {
  const labels = { title: "Synthetic heavy day after the walk", mood: "low", confidence: "medium", topics: ["reflection"] };
  // Prefix: the rest is the entry, even without the model.
  assert.deepEqual(plain(F.sayItJournalDraft("journal: today felt synthetic and slow", null)), {
    body: "today felt synthetic and slow", source: "voice", title: null, mood: null, confidence: null, topics: [], asked: true,
  });
  // Plain logging: no journal draft.
  assert.equal(F.sayItJournalDraft("two coffees and the morning stack", { is_journal: false, excerpt: "", ...labels }), null);
  assert.equal(F.sayItJournalDraft("two coffees", null), null);
  // A reflective part quoted exactly: that part is the entry.
  const note = "Two synthetic coffees. Today felt heavy, but the walk helped.";
  const d = F.sayItJournalDraft(note, { is_journal: true, excerpt: "Today felt heavy, but the walk helped.", ...labels });
  assert.equal(d.body, "Today felt heavy, but the walk helped.");
  assert.equal(d.title, labels.title);
  assert.equal(d.mood, "low");
  assert.equal(d.asked, false, "the model picked it out: offered, not filed by itself");
  // A reworded "quote" is never used: the whole note instead.
  assert.equal(F.sayItJournalDraft(note, { is_journal: true, excerpt: "I felt heavy today.", ...labels }).body, note);
  assert.equal(F.sayItJournalDraft(note, { is_journal: true, excerpt: "", ...labels }).body, note);
  assert.match(F.SAY_IT_JOURNAL_RULES, /EXACTLY as written/);
  assert.deepEqual(plain(F.SAY_IT_JOURNAL_SCHEMA.required), ["is_journal", "excerpt", "title", "mood", "confidence", "topics"]);
});

test("retry check: page paragraphs compare equal to the body as written; query is this day's recent pages", () => {
  const blocks = J.notionJournalPage(J.validateJournalEntry({ date: TODAY, title: "Synthetic t", mood: "good", confidence: "medium", source: "typed", topics: ["work"], body: BODY }, TODAY).entry, "db").children
    .map((b) => ({ ...b, paragraph: { rich_text: b.paragraph.rich_text.map((r) => ({ ...r, plain_text: r.text.content })) } }));
  assert.equal(F.pageBodyText([...blocks, { type: "divider" }]), F.bodyAsWritten("\n" + BODY + "  "));
  assert.notEqual(F.pageBodyText(blocks), F.bodyAsWritten(BODY + " more"));
  assert.equal(F.pageBodyText(null), "");
  const q = plain(F.recentEntriesQuery(TODAY, new Date("2031-03-05T15:00:00Z")));
  assert.deepEqual(q.filter.and[0], { property: "Date", date: { equals: TODAY } });
  assert.deepEqual(q.filter.and[1], { timestamp: "created_time", created_time: { on_or_after: "2031-03-05T14:45:00.000Z" } });
});

test("saved page labels are read back from its properties", () => {
  const page = { properties: { Title: { title: [{ plain_text: "Synthetic " }, { plain_text: "title" }] }, Mood: { select: { name: "good" } }, Topics: { multi_select: [{ name: "work" }, { name: "sleep" }] } } };
  assert.deepEqual(plain(F.pageLabels(page)), { title: "Synthetic title", mood: "good", topics: ["work", "sleep"] });
  assert.deepEqual(plain(F.pageLabels(null)), { title: "", mood: null, topics: [] });
});

test("route rules: POST only, session only (not a CI route), same-origin, Notion only, text never logged", () => {
  const file = path.join(SRC, "app/api/journal/file/route.ts");
  assert.ok(fs.existsSync(file));
  const route = fs.readFileSync(file, "utf8");
  assert.deepEqual([...route.matchAll(/export (?:async )?(?:function|const) (\w+)/g)].map((m) => m[1]).filter((n) => n !== "maxDuration"), ["POST"]);
  assert.match(route, /checkVoiceRequest\(req\.headers, req\.nextUrl\.origin, JOURNAL_MAX_REQUEST_BYTES\)/);
  assert.match(route, /validateJournalFile\(/);
  assert.match(route, /completeEntry\(/, "the final entry goes through validateJournalEntry");
  assert.match(route, /findRetriedEntry\(/);
  assert.equal(/\.(upsert|insert|update|delete)\(|journal_entries"\)|createClient/.test(route), false, "Notion is the journal's only write surface");
  assert.equal(/console\.(log|info)/.test(route), false);
  for (const line of route.split("\n").filter((l) => /console\./.test(l))) assert.equal(/input|text|body|title|entry\b/i.test(line.replace(/\[journal-file\]/, "")), false, line);
  const mw = fs.readFileSync(path.join(SRC, "middleware.ts"), "utf8");
  const start = mw.indexOf("function isCiRoute");
  const ci = mw.slice(start, mw.indexOf("\n}\n", start));
  assert.equal(/journal/i.test(ci), false, "the CI token never reaches the journal write");
});

// ---- Autosave (2026-11-15): file once, then keep the same page up to date ---------------------------------------

const crypto = require("node:crypto");
const sha = (body) => crypto.createHash("sha256").update(F.bodyAsWritten(body), "utf8").digest("hex");
const LABELS = { title: "Synthetic labels from the first words", mood: "neutral", confidence: "medium", topics: ["reflection"] };
const PAGE = "0123456789abcdef0123456789abcdef";
const PAGE_DASHED = "01234567-89ab-cdef-0123-456789abcdef";

test("autosave: page ids, known hashes, relabel threshold", () => {
  assert.equal(F.normalizePageId(PAGE), PAGE_DASHED);
  assert.equal(F.normalizePageId(PAGE_DASHED.toUpperCase()), PAGE_DASHED);
  for (const bad of ["", "../pages", PAGE + "0", "zz" + PAGE.slice(2), null, 7]) assert.equal(F.normalizePageId(bad), null, String(bad));
  assert.deepEqual(plain(F.parseKnownSha(undefined)), []);
  assert.deepEqual(plain(F.parseKnownSha([sha("a"), sha("a")])), [sha("a")], "duplicates collapse");
  assert.equal(F.parseKnownSha(["not-a-hash"]), null);
  assert.equal(F.parseKnownSha(Array.from({ length: F.JOURNAL_MAX_KNOWN_SHA + 1 }, (_, i) => sha(String(i)))), null);
  assert.equal(F.parseKnownSha("abc"), null);
  // One model call per real change, not per pause.
  assert.equal(F.shouldRelabel(6, 9), false, "3 words more");
  assert.equal(F.shouldRelabel(6, 14), true, "8 more and over a quarter");
  assert.equal(F.shouldRelabel(100, 110), false, "10 more on 100 is under a quarter");
  assert.equal(F.shouldRelabel(100, 130), true);
  assert.equal(F.shouldRelabel(0, 8), true, "labels from an earlier version (stale page): relabel");
  assert.equal(F.journalWordCount("  one two\n\nthree "), 3);
});

test("autosave: the update request is strict (unknown fields refused, the date never changes)", () => {
  const good = { body: " " + BODY + " ", source: "typed", known_sha: [sha(BODY)] };
  const v = F.validateJournalUpdate(good);
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.input.body, BODY, "trimmed only");
  assert.deepEqual(plain(v.input.explicit), { title: "", mood: null, confidence: null, topics: [] });
  assert.equal(v.input.force, false);
  for (const raw of [
    { ...good, date: TODAY },
    { ...good, extra: 1 },
    { ...good, body: "   " },
    { ...good, body: "x".repeat(J.JOURNAL_MAX_BODY_CHARS + 1) },
    { ...good, source: "remarkable" },
    { ...good, known_sha: [] },
    { ...good, known_sha: ["nope"] },
    { ...good, force: "yes" },
    { ...good, relabel: true },
    { ...good, relabel: true, last_labels: { ...LABELS, extra: 1 } },
    { ...good, mood: "sad" },
    [],
    null,
  ]) {
    assert.equal(F.validateJournalUpdate(raw).ok, false, JSON.stringify(raw)?.slice(0, 80));
  }
  assert.equal(F.validateJournalUpdate({ ...good, known_sha: [], force: true }).ok, true, "force needs no hash");
  const r = F.validateJournalUpdate({ ...good, relabel: true, last_labels: LABELS, mood: "good" });
  assert.equal(r.ok, true);
  assert.deepEqual(plain(r.input.last), LABELS);
  assert.equal(r.input.explicit.mood, "good");
});

test("autosave: a re-inferred label is written only where the page still holds the label this box wrote", () => {
  const inferred = { title: "Synthetic labels from the whole entry", mood: "good", confidence: "high", topics: ["work", "sleep"] };
  // Nothing changed in Notion: every inferred label is written.
  assert.deepEqual(plain(F.labelsToWrite({ explicit: { title: "", mood: null, confidence: null, topics: [] }, inferred, last: LABELS, current: LABELS })), inferred);
  // Riley changed the mood and the topics in Notion: those stay.
  const current = { ...LABELS, mood: "low", topics: ["family"] };
  assert.deepEqual(plain(F.labelsToWrite({ explicit: { title: "", mood: null, confidence: null, topics: [] }, inferred, last: LABELS, current })), { title: inferred.title, confidence: "high" });
  // Riley's own labels always win; an unusable model answer writes nothing of its own.
  assert.deepEqual(plain(F.labelsToWrite({ explicit: { title: "", mood: "great", confidence: null, topics: [] }, inferred: { title: "Journal entry", mood: "sad", topics: [] }, last: LABELS, current: LABELS })), { mood: "great" });
  // No relabel asked: explicit only.
  assert.deepEqual(plain(F.labelsToWrite({ explicit: { title: "", mood: null, confidence: null, topics: [] }, inferred: null, last: LABELS, current: LABELS })), {});
  const props = plain(F.notionUpdateProperties("voice", { mood: "good", topics: ["work"] }));
  assert.deepEqual(Object.keys(props).sort(), ["Mood", "Source", "Topics"]);
  assert.deepEqual(props.Source, { select: { name: "voice" } });
});

test("autosave: the block edit keeps the shared start and rewrites only the tail", () => {
  const paras = [{ id: "b1", text: "First synthetic paragraph." }, { id: "b2", text: "Second, half written" }];
  assert.deepEqual(plain(F.bodyEdit(paras, "First synthetic paragraph.\n\nSecond, half written and finished.\n\nThird.")), {
    keep: 1, remove: ["b2"], append: ["Second, half written and finished.", "Third."],
  });
  assert.deepEqual(plain(F.bodyEdit(paras, "First synthetic paragraph.\n\nSecond, half written")), { keep: 2, remove: [], append: [] });
  assert.deepEqual(plain(F.bodyEdit(paras, "Rewritten from the start.")), { keep: 0, remove: ["b1", "b2"], append: ["Rewritten from the start."] });
  const blocks = [
    { id: "b1", type: "paragraph", paragraph: { rich_text: [{ plain_text: "First " }, { plain_text: "part." }] } },
    { id: "b2", type: "heading_2", heading_2: { rich_text: [] } },
  ];
  const read = plain(F.pageParagraphs(blocks));
  assert.equal(read.ok, false, "a heading added in Notion = edited there");
  assert.deepEqual(read.paras, [{ id: "b1", text: "First part." }]);
  assert.equal(F.pageParagraphs(blocks.slice(0, 1)).ok, true);
  assert.deepEqual(plain(F.paragraphBlocks(["x"]))[0].paragraph.rich_text, [{ type: "text", text: { content: "x" } }]);
});

test("autosave: the device copy of unsaved words is checked and expires", () => {
  const now = Date.UTC(2031, 2, 5, 12);
  const rec = { v: 1, at: now - 1000, body: "Synthetic unsaved words.", source: "voice", pinned: true, filed: { id: PAGE, url: "https://www.notion.so/x", date: TODAY, sha: sha("Synthetic"), labels: LABELS, labeledWords: 1 }, known: [sha("a")] };
  const back = plain(F.parseUnsavedJournal(JSON.stringify(rec), now));
  assert.equal(back.body, rec.body);
  assert.equal(back.filed.id, PAGE_DASHED);
  assert.deepEqual(back.known, [sha("a")]);
  assert.equal(F.JOURNAL_UNSAVED_KEY.startsWith("onyx"), true, "an onyx key: wiped on sign-out");
  assert.equal(F.parseUnsavedJournal(JSON.stringify({ ...rec, at: now - F.JOURNAL_UNSAVED_MAX_AGE_MS - 1 }), now), null, "expired");
  assert.equal(F.parseUnsavedJournal(JSON.stringify({ ...rec, body: "  " }), now), null);
  assert.equal(F.parseUnsavedJournal("{not json", now), null);
  assert.equal(F.parseUnsavedJournal(JSON.stringify({ ...rec, v: 2 }), now), null);
  assert.equal(plain(F.parseUnsavedJournal(JSON.stringify({ ...rec, filed: { id: "bad" } }), now)).filed, null, "a bad page reference is dropped, the words kept");
});

// A fake Notion for the server side (lib/journal-file-server.ts): pages in the Entries database, block edits.
function fakeNotion() {
  const DB = "96541038264d45aba2a9601d9b175a7e";
  const pages = new Map();
  const calls = [];
  let nextBlock = 1;
  const para = (text) => ({ id: `blk-${nextBlock++}`, type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: text }, plain_text: text }] } });
  const addPage = (id, body, over = {}) => {
    pages.set(id, { id, parent: { type: "database_id", database_id: DB }, archived: false, url: `https://www.notion.so/${id.replace(/-/g, "")}`, properties: {
      Title: { title: [{ plain_text: LABELS.title }] }, Mood: { select: { name: LABELS.mood } }, Confidence: { select: { name: LABELS.confidence } }, Topics: { multi_select: LABELS.topics.map((name) => ({ name })) },
    }, blocks: J.bodyParagraphs(body).map(para), ...over });
  };
  const text = (id) => F.pageBodyText(pages.get(id).blocks);
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
  const fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    const u = new URL(url);
    const p = decodeURIComponent(u.pathname.replace(/^\/v1\//, ""));
    calls.push(`${method} ${p}`);
    let m;
    if ((m = /^pages\/(.+)$/.exec(p))) {
      const page = pages.get(m[1]);
      if (!page) return json(404, {});
      if (method === "PATCH") {
        const props = JSON.parse(init.body).properties;
        if (props.Mood) page.properties.Mood = { select: { name: props.Mood.select.name } };
        if (props.Title) page.properties.Title = { title: props.Title.title.map((t) => ({ plain_text: t.text.content })) };
        page.sourceSet = props.Source.select.name;
      }
      return json(200, page);
    }
    if ((m = /^blocks\/(.+)\/children$/.exec(p))) {
      const page = pages.get(m[1]);
      if (!page) return json(404, {});
      if (method === "PATCH") {
        for (const c of JSON.parse(init.body).children) page.blocks.push(para(c.paragraph.rich_text.map((r) => r.text.content).join("")));
        return json(200, {});
      }
      return json(200, { results: page.blocks, has_more: false });
    }
    if ((m = /^blocks\/(.+)$/.exec(p)) && method === "DELETE") {
      for (const page of pages.values()) page.blocks = page.blocks.filter((b) => b.id !== m[1]);
      return json(200, {});
    }
    return json(400, {});
  };
  return { pages, calls, addPage, text, fetch };
}

function loadServer(notion) {
  global.fetch = notion.fetch;
  process.env.NOTION_API_KEY = "test-not-a-key";
  return loadTs("lib/journal-file-server.ts", { "server-only": {}, "@anthropic-ai/sdk": function Anthropic() {} });
}
const upd = (body, over = {}) => {
  const v = F.validateJournalUpdate({ body, source: "voice", known_sha: [sha(FIRST)], ...over });
  assert.equal(v.ok, true, JSON.stringify(v));
  return v.input;
};
const FIRST = "First synthetic paragraph.\n\nSecond, half written";

test("server update: rewrites only the changed tail, sets Source, and the page holds the words verbatim", async () => {
  const n = fakeNotion();
  n.addPage(PAGE_DASHED, FIRST);
  const S = loadServer(n);
  const next = "First synthetic paragraph.\n\nSecond, half written and finished.\n\nThird.";
  const out = await S.updateJournalPage(PAGE_DASHED, upd(next), async () => assert.fail("no relabel asked"));
  assert.equal(n.text(PAGE_DASHED), F.bodyAsWritten(next));
  assert.equal(n.calls.filter((c) => c.startsWith("DELETE")).length, 1, "only the tail paragraph is removed");
  assert.equal(n.pages.get(PAGE_DASHED).sourceSet, "voice");
  assert.equal(out.relabeled, false);
  assert.equal(S.bodySha(next), sha(next), "server and browser hash the same text");
});

test("server update: a page edited in Notion is not overwritten unless forced; one already holding the words gets properties only", async () => {
  const n = fakeNotion();
  n.addPage(PAGE_DASHED, "Riley rewrote this in Notion.");
  const S = loadServer(n);
  await assert.rejects(() => S.updateJournalPage(PAGE_DASHED, upd("New synthetic words."), async () => null), S.JournalEntryChanged);
  assert.equal(n.text(PAGE_DASHED), "Riley rewrote this in Notion.", "nothing written");
  await S.updateJournalPage(PAGE_DASHED, upd("New synthetic words.", { force: true }), async () => null);
  assert.equal(n.text(PAGE_DASHED), "New synthetic words.");
  // A retry after a lost answer: the page already has the words; no block is touched.
  n.calls.length = 0;
  await S.updateJournalPage(PAGE_DASHED, upd("New synthetic words."), async () => null);
  assert.equal(n.calls.some((c) => c.startsWith("DELETE") || c === `PATCH blocks/${PAGE_DASHED}/children`), false);
  assert.ok(n.calls.includes(`PATCH pages/${PAGE_DASHED}`));
});

test("server update: refuses pages outside the Entries database or in the trash", async () => {
  const n = fakeNotion();
  n.addPage(PAGE_DASHED, FIRST, { parent: { type: "database_id", database_id: "ffffffffffffffffffffffffffffffff" } });
  const S = loadServer(n);
  await assert.rejects(() => S.updateJournalPage(PAGE_DASHED, upd("x"), async () => null), S.JournalEntryGone);
  n.addPage(PAGE_DASHED, FIRST, { archived: true });
  await assert.rejects(() => S.updateJournalPage(PAGE_DASHED, upd("x"), async () => null), S.JournalEntryGone);
  await assert.rejects(() => S.updateJournalPage("ffffffff-ffff-ffff-ffff-ffffffffffff", upd("x"), async () => null), S.JournalEntryGone);
  assert.equal(n.text(PAGE_DASHED), F.bodyAsWritten(FIRST), "nothing written");
});

test("server update: relabel = one model call, written only over labels this box wrote; a failed call still saves the words", async () => {
  const n = fakeNotion();
  n.addPage(PAGE_DASHED, FIRST);
  n.pages.get(PAGE_DASHED).properties.Mood = { select: { name: "low" } }; // Riley changed the mood in Notion
  const S = loadServer(n);
  let calls = 0;
  const longer = FIRST + " with many more synthetic words added to it here at the end of the entry.";
  const out = await S.updateJournalPage(PAGE_DASHED, upd(longer, { relabel: true, last_labels: LABELS }), async () => {
    calls++;
    return { title: "Synthetic labels from the whole entry", mood: "great", confidence: "medium", topics: ["reflection"] };
  });
  assert.equal(calls, 1);
  assert.equal(out.relabeled, true);
  assert.equal(n.pages.get(PAGE_DASHED).properties.Mood.select.name, "low", "Riley's Notion change stays");
  assert.equal(F.pageLabels(n.pages.get(PAGE_DASHED)).title, "Synthetic labels from the whole entry");
  const again = longer + " More.";
  const out2 = await S.updateJournalPage(PAGE_DASHED, { ...upd(again, { relabel: true, last_labels: LABELS }), known: [sha(longer)] }, async () => { throw new Error("model down"); });
  assert.equal(out2.relabeled, false);
  assert.equal(n.text(PAGE_DASHED), F.bodyAsWritten(again));
});

test("update route rules: PATCH only, session only, same-origin, strict, page id checked, text never logged", () => {
  const file = path.join(SRC, "app/api/journal/file/[pageId]/route.ts");
  assert.ok(fs.existsSync(file));
  const route = fs.readFileSync(file, "utf8");
  assert.deepEqual([...route.matchAll(/export (?:async )?(?:function|const) (\w+)/g)].map((m) => m[1]).filter((n) => n !== "maxDuration"), ["PATCH"]);
  assert.match(route, /checkVoiceRequest\(req\.headers, req\.nextUrl\.origin, JOURNAL_MAX_REQUEST_BYTES\)/);
  assert.match(route, /normalizePageId\(/);
  assert.match(route, /validateJournalUpdate\(/);
  assert.match(route, /updateJournalPage\(/);
  assert.equal(/journal_entries"\)|createClient/.test(route), false, "Notion is the journal's only write surface");
  assert.equal(/console\.(log|info)/.test(route), false);
  for (const line of route.split("\n").filter((l) => /console\./.test(l))) assert.equal(/input|text|body|title|entry\b|pageId/i.test(line.replace(/\[journal-file\]/, "")), false, line);
  const post = fs.readFileSync(path.join(SRC, "app/api/journal/file/route.ts"), "utf8");
  assert.match(post, /findRetriedEntry\(input\.date, input\.body, now, known\)/, "a lost answer is recognised by its hash");
});
