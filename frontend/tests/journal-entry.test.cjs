// Run with the rest of the suite (after deployment): node --test tests/journal-entry.test.cjs
// The journal entry Onyx writes to the Notion journal from the /check-in draft: the pure rules
// (lib/journal-entry.ts) and POST /api/journal/entry, run with a fake Notion layer (what is written, what is
// refused, what is logged). SYNTHETIC text only; no network, no Notion.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");
const SF = require("./helpers/source-facts.cjs");

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
    page_size: 5,
  });
});

// ─── POST /api/journal/entry (executed with a fake Notion layer) ─────────────

const nextServer = { NextResponse: { json: (body, init = {}) => ({ status: init.status ?? 200, body }) } };
const ORIGIN = "https://onyx.example";
const WORDS = "Synthetic private words that must never reach a log.";

/** The route with lib/journal-file-server replaced: records what reaches Notion, answers `same` for the duplicate check. */
function journalRoute({ same = null, create } = {}) {
  const asked = [];
  const created = [];
  class NotionRefused extends Error {
    constructor(status) {
      super("Synthetic Notion refusal");
      this.status = status;
    }
  }
  const notion = {
    __esModule: true,
    notionConfigured: () => true,
    findSameTitleEntry: async (e) => {
      asked.push(e);
      return same;
    },
    createJournalPage: async (e) => {
      created.push(e);
      return create ? create(NotionRefused) : "https://notion.example/synthetic-page";
    },
    notionRefusalMessage: (status) => `Synthetic refusal message ${status}`,
    NotionRefused,
  };
  return { route: loadTs("app/api/journal/entry/route.ts", { "@/lib/journal-file-server": notion, "next/server": nextServer }), asked, created };
}
function post(body, over = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const h = { origin: ORIGIN, host: "onyx.example", "content-type": "application/json", ...over };
  return { headers: { get: (k) => (k in h && h[k] !== undefined ? h[k] : null) }, nextUrl: { origin: ORIGIN }, text: async () => text };
}
const todays = (over = {}) => entry({ date: J.easternDate(new Date()), body: WORDS, ...over });
/** Every console line written during the test (and nothing printed). */
function consoleLines(t) {
  const lines = [];
  for (const level of ["log", "info", "warn", "error", "debug"]) t.mock.method(console, level, (...args) => lines.push({ level, text: args.map(String).join(" ") }));
  return lines;
}

test("route: only POST is answered, and a new entry is written to Notion once with the words exactly as sent", async (t) => {
  const lines = consoleLines(t);
  const { route, created } = journalRoute();
  assert.deepEqual(Object.keys(route).filter((k) => typeof route[k] === "function"), ["POST"]);
  const res = await route.POST(post(todays()));
  assert.deepEqual([res.status, res.body], [200, { url: "https://notion.example/synthetic-page" }]);
  assert.equal(created.length, 1);
  assert.equal(created[0].body, WORDS);
  assert.deepEqual(lines, [], "a save logs nothing");
});

test("route: a repeat with the same date, title and words answers the entry already there and writes nothing", async () => {
  const { route, created } = journalRoute({ same: { url: "https://notion.example/synthetic-existing", sameWords: true } });
  const res = await route.POST(post(todays()));
  assert.deepEqual([res.status, res.body], [200, { url: "https://notion.example/synthetic-existing", existing: true }]);
  assert.equal(created.length, 0);
});

test("route: a different entry under the same date and title is a 409, never reported as saved", async () => {
  const { route, created } = journalRoute({ same: { url: "https://notion.example/synthetic-existing", sameWords: false } });
  const res = await route.POST(post(todays()));
  assert.equal(res.status, 409);
  assert.match(res.body.error, /different entry with this title/);
  assert.equal(res.body.existing, undefined);
  assert.equal(created.length, 0, "nothing written: the draft stays editable");
});

test("route: a cross-site, non-JSON, oversized or invalid request is refused before Notion is asked", async () => {
  const cases = [
    [todays(), { origin: "https://evil.example" }, 403],
    [todays(), { origin: undefined }, 403],
    [todays(), { "content-type": "text/plain" }, 415],
    [todays(), { "content-length": String(J.JOURNAL_MAX_REQUEST_BYTES + 1) }, 413],
    [todays({ body: "x".repeat(J.JOURNAL_MAX_REQUEST_BYTES) }), {}, 413], // no Content-Length: the body itself is measured
    ["{not json", {}, 400],
    [todays({ mood: "sad" }), {}, 400],
    [todays({ date: "2999-01-01" }), {}, 400],
  ];
  for (const [body, over, status] of cases) {
    const { route, asked, created } = journalRoute();
    const res = await route.POST(post(body, over));
    assert.equal(res.status, status, JSON.stringify(over));
    assert.deepEqual([asked.length, created.length], [0, 0], `Notion is not asked (${status})`);
  }
});

test("route: Notion refusing or unreachable answers 502, and the log holds a short code, never the entry", async (t) => {
  const lines = consoleLines(t);
  const refused = journalRoute({ create: (NotionRefused) => { throw new NotionRefused(403); } });
  const a = await refused.route.POST(post(todays()));
  assert.deepEqual([a.status, a.body.error], [502, "Synthetic refusal message 403"]);
  const down = journalRoute({ create: () => { throw new Error(`Synthetic failure quoting ${WORDS}`); } });
  const b = await down.route.POST(post(todays()));
  assert.equal(b.status, 502);
  assert.match(b.body.error, /Couldn't reach Notion/);
  assert.ok(lines.length >= 2, "both failures are logged");
  for (const l of lines) {
    assert.equal(l.level, "error");
    assert.equal(l.text.includes("Synthetic private words"), false, l.text);
    assert.equal(l.text.includes(entry().title), false, l.text);
  }
});

// ─── boundaries that cannot be settled by one run (syntax tree) ──────────────

test("the journal write is session only: no CI token path reaches it", () => {
  const isCiRoute = SF.loadFunction("middleware.ts", "isCiRoute");
  assert.equal(isCiRoute("/api/habits/checkin"), true, "the CI prefix itself is recognised (the check works)");
  for (const p of ["/api/journal/entry", "/api/journal/file", "/api/journal/file/synthetic-page", "/api/journal"]) assert.equal(isCiRoute(p), false, p);
  const file = path.join(SRC, "app/api/journal/entry/route.ts");
  assert.equal(path.relative(SRC, file).split(path.sep).join("/").startsWith("app/api/habits/"), false, "not under the CI-reachable /api/habits prefix");
});

test("Notion is the journal's only write surface, and no path logs entry text", () => {
  const route = SF.parseFile("app/api/journal/entry/route.ts");
  assert.ok(SF.imports(route).includes("@/lib/journal-file-server"), "the Notion calls are shared with POST /api/journal/file");
  const server = SF.parseFile("lib/journal-file-server.ts");
  for (const [name, sf] of [["route", route], ["server", server]]) {
    assert.equal(SF.imports(sf).some((s) => /supabase/i.test(s)), false, `${name}: no database client`);
    const writes = SF.calls(sf).filter((c) => c.name === "createClient" || /\.from\(\)\.(insert|upsert|update|delete)$/.test(c.name ?? ""));
    assert.deepEqual(writes.map((c) => c.name), [], `${name}: no database write`);
  }
  assert.deepEqual(SF.calls(server).filter((c) => /^console\./.test(c.name ?? "")).map((c) => c.name), [], "the Notion layer logs nothing");
  for (const c of SF.calls(route).filter((c) => /^console\./.test(c.name ?? ""))) {
    assert.equal(c.name, "console.error", "errors only");
    for (const a of c.node.arguments) assert.ok(SF.ts.isStringLiteral(a) || (SF.ts.isIdentifier(a) && a.text === "status"), `logs a code, never entry text: ${a.getText()}`);
  }
  const db = SF.topLevelConst(server, "NOTION_JOURNAL_DB");
  assert.ok(db && SF.ts.isBinaryExpression(db) && SF.ts.isStringLiteral(db.right) && db.right.text === "96541038264d45aba2a9601d9b175a7e", "the database journal_etl.py syncs");
});
