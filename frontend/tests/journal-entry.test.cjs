// Run: node --test tests/journal-entry.test.cjs
// The journal entry Onyx writes to the Notion journal from the /check-in draft: the pure rules
// (lib/journal-entry.ts) and the rules of POST /api/journal/entry. SYNTHETIC text only; no network, no Notion.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const J = loadTs("lib/journal-entry.ts");

const TODAY = "2031-03-05";
const entry = (over = {}) => ({
  date: "2031-03-04",
  title: "Synthetic title for a test",
  mood: "neutral",
  confidence: "medium",
  source: "voice",
  topics: ["reflection"],
  body: "Synthetic first paragraph.\nSame paragraph, next line.\n\nSynthetic second paragraph.",
  ...over,
});
const plain = (v) => JSON.parse(JSON.stringify(v));

test("draft labels: valid model labels are kept, topics normalized", () => {
  const d = J.journalDraftFrom({ title: "  Synthetic   quiet evening walk ", mood: "great", confidence: "low", topics: ["Mental Health", "sleep", "sleep", "!!"] });
  assert.deepEqual(plain(d), { title: "Synthetic quiet evening walk", mood: "great", confidence: "low", topics: ["mental-health", "sleep"] });
});

test("draft labels: missing, generic or invalid labels become blank or the defaults", () => {
  assert.deepEqual(plain(J.journalDraftFrom(null)), { title: "", mood: null, confidence: "medium", topics: [] });
  assert.deepEqual(plain(J.journalDraftFrom({ title: "Journal entry", mood: "sad", confidence: "sure", topics: "work" })), { title: "", mood: null, confidence: "medium", topics: [] });
  assert.equal(J.journalDraftFrom({ title: "x".repeat(J.JOURNAL_MAX_TITLE_CHARS + 1) }).title, "");
  assert.equal(J.journalDraftFrom({ topics: Array.from({ length: 10 }, (_, i) => `tag-${i}`) }).topics.length, J.JOURNAL_MAX_TOPICS);
});

test("validation: a complete entry passes and the body is kept as written", () => {
  const v = J.validateJournalEntry(entry({ body: "  " + entry().body + "\n " }), TODAY);
  assert.equal(v.ok, true);
  assert.equal(v.entry.body, entry().body, "only the whitespace around the body is dropped");
  assert.deepEqual(plain(v.entry.topics), ["reflection"]);
});

test("validation: every property is required", () => {
  for (const [field, value] of [["title", " "], ["mood", null], ["mood", "sad"], ["confidence", undefined], ["source", "remarkable"], ["topics", []], ["topics", "work"], ["body", "  "], ["body", 5]]) {
    assert.equal(J.validateJournalEntry(entry({ [field]: value }), TODAY).ok, false, `${field}=${JSON.stringify(value)}`);
  }
  assert.equal(J.validateJournalEntry(null, TODAY).ok, false);
  assert.equal(J.validateJournalEntry([], TODAY).ok, false);
});

test("validation: the date is a real day, not after today in New York", () => {
  assert.equal(J.validateJournalEntry(entry({ date: TODAY }), TODAY).ok, true);
  assert.equal(J.validateJournalEntry(entry({ date: "2031-03-06" }), TODAY).ok, false);
  assert.equal(J.validateJournalEntry(entry({ date: "2031-02-30" }), TODAY).ok, false);
  assert.equal(J.validateJournalEntry(entry({ date: "03/04/2031" }), TODAY).ok, false);
});

test("validation: topics must be distinct tags, at most the cap; caps on title and body", () => {
  assert.equal(J.validateJournalEntry(entry({ topics: ["work", "work"] }), TODAY).ok, false);
  assert.equal(J.validateJournalEntry(entry({ topics: ["not a tag!"] }), TODAY).ok, false);
  assert.equal(J.validateJournalEntry(entry({ topics: Array.from({ length: J.JOURNAL_MAX_TOPICS + 1 }, (_, i) => `t-${i}`) }), TODAY).ok, false);
  assert.equal(J.validateJournalEntry(entry({ topics: ["Synthetic-New"] }), TODAY).entry.topics[0], "synthetic-new");
  assert.equal(J.validateJournalEntry(entry({ title: "x".repeat(J.JOURNAL_MAX_TITLE_CHARS + 1) }), TODAY).ok, false);
  assert.equal(J.validateJournalEntry(entry({ body: "x".repeat(J.JOURNAL_MAX_BODY_CHARS + 1) }), TODAY).ok, false);
});

test("easternDate is the New York calendar date", () => {
  assert.equal(J.easternDate(new Date("2031-03-05T03:30:00Z")), "2031-03-04"); // 22:30 EST the day before
  assert.equal(J.easternDate(new Date("2031-07-01T12:00:00Z")), "2031-07-01");
});

test("body paragraphs: split at blank lines, line breaks inside kept, capped at Notion's block limit", () => {
  assert.deepEqual(plain(J.bodyParagraphs("One.\nStill one.\r\n\r\n  Two.  \n\n\n\nThree.")), ["One.\nStill one.", "Two.", "Three."]);
  const many = Array.from({ length: J.NOTION_MAX_BLOCKS + 5 }, (_, i) => `P${i}`).join("\n\n");
  const paras = J.bodyParagraphs(many);
  assert.equal(paras.length, J.NOTION_MAX_BLOCKS);
  assert.equal(paras.at(-1), Array.from({ length: 6 }, (_, i) => `P${J.NOTION_MAX_BLOCKS - 1 + i}`).join("\n\n"));
  assert.equal(paras.join("\n\n"), many, "nothing is lost");
});

test("rich text: chunks of at most 2000 characters that join back to the text, surrogate pairs kept whole", () => {
  const long = "a".repeat(1999) + "😀" + "b".repeat(2500);
  const chunks = J.richText(long);
  assert.ok(chunks.every((c) => c.text.content.length <= J.NOTION_TEXT_CHUNK));
  assert.equal(chunks.map((c) => c.text.content).join(""), long);
  assert.equal(chunks[0].text.content.length, 1999, "the emoji moved whole to the next chunk");
});

test("the Notion page sets all six properties and writes the words verbatim", () => {
  const v = J.validateJournalEntry(entry({ topics: ["reflection", "sleep"] }), TODAY);
  const page = plain(J.notionJournalPage(v.entry, "synthetic-db"));
  assert.deepEqual(page.parent, { database_id: "synthetic-db" });
  assert.deepEqual(Object.keys(page.properties).sort(), ["Confidence", "Date", "Mood", "Source", "Title", "Topics"]);
  assert.equal(page.properties.Title.title[0].text.content, "Synthetic title for a test");
  assert.deepEqual(page.properties.Date, { date: { start: "2031-03-04" } });
  assert.deepEqual(page.properties.Source, { select: { name: "voice" } });
  assert.deepEqual(page.properties.Confidence, { select: { name: "medium" } });
  assert.deepEqual(page.properties.Mood, { select: { name: "neutral" } });
  assert.deepEqual(page.properties.Topics, { multi_select: [{ name: "reflection" }, { name: "sleep" }] });
  const words = page.children.map((b) => b.paragraph.rich_text.map((r) => r.text.content).join(""));
  assert.deepEqual(words, ["Synthetic first paragraph.\nSame paragraph, next line.", "Synthetic second paragraph."]);
  assert.ok(page.children.every((b) => b.type === "paragraph" && b.object === "block"));
});

test("the duplicate check looks for the same date and title", () => {
  assert.deepEqual(plain(J.sameEntryQuery({ date: "2031-03-04", title: "Synthetic title" })), {
    filter: { and: [{ property: "Date", date: { equals: "2031-03-04" } }, { property: "Title", title: { equals: "Synthetic title" } }] },
    page_size: 1,
  });
});

test("route rules: POST only, session only (not a CI route), same-origin, Notion only, text never logged", () => {
  const file = path.join(SRC, "app/api/journal/entry/route.ts");
  assert.ok(fs.existsSync(file));
  const route = fs.readFileSync(file, "utf8");
  assert.deepEqual([...route.matchAll(/export (?:async )?(?:function|const) (\w+)/g)].map((m) => m[1]).filter((n) => n !== "maxDuration"), ["POST"]);
  assert.match(route, /checkVoiceRequest\(req\.headers, req\.nextUrl\.origin, JOURNAL_MAX_REQUEST_BYTES\)/);
  assert.match(route, /validateJournalEntry\(/);
  assert.match(route, /easternDate\(new Date\(\)\)/);
  assert.match(route, /sameEntryQuery\(/);
  assert.match(route, /NOTION_JOURNAL_DB \|\| "96541038264d45aba2a9601d9b175a7e"/, "the database journal_etl.py syncs");
  assert.equal(/\.(upsert|insert|update|delete)\(|journal_entries"\)|createClient/.test(route), false, "Notion is the journal's only write surface");
  assert.equal(/console\.(log|info)/.test(route), false);
  for (const line of route.split("\n").filter((l) => /console\./.test(l))) assert.equal(/text|body|title|entry\b(?!\])/i.test(line.replace(/\[journal-entry\]/, "")), false, line);
  const mw = fs.readFileSync(path.join(SRC, "middleware.ts"), "utf8");
  const start = mw.indexOf("function isCiRoute");
  const ci = mw.slice(start, mw.indexOf("\n}\n", start));
  assert.equal(/journal/i.test(ci), false, "the CI token never reaches the journal write");
  assert.equal(path.relative(SRC, file).split(path.sep).join("/").startsWith("app/api/habits/"), false, "not under the CI-reachable /api/habits prefix");
});
