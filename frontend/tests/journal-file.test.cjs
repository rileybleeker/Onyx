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
    body: "today felt synthetic and slow", source: "voice", title: null, mood: null, confidence: null, topics: [],
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
