// findMirroredEntry (lib/reading-notion.ts): finds the Notion entry a stopped try already made for a session or
// highlight, so a retry adopts it instead of leaving "unconfirmed" (or making a second one). Read-only; exactly one
// unclaimed exact match is the entry. Synthetic rows and a stubbed fetch; no network.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");

process.env.NOTION_API_KEY = "synthetic-key";
const notion = loadTs("lib/reading-notion.ts");

const book = { book_id: 1, slug: "synthetic-book", title: "Synthetic Book", notion_page_id: "page-1" };
const session = {
  session_id: 7, book_id: 1, session_date: "2026-11-11", chapter_from: 3, chapter_through: 4, minutes: 12, medium: "audio",
  recall: "The constraint did not move.", question: null, in_chapter: null, source: "chat", notion_block_id: null,
};
const highlight = { highlight_id: 9, book_id: 1, passage: "The constraint sets the pace.", comment: "I like it", chapter: 4, location: null, concept: null, source: "manual", notion_block_id: null };

/** What Notion shows for a quote block with this text. */
const quote = (id, text) => ({ id, type: "quote", quote: { rich_text: [{ type: "text", plain_text: text }] } });
const sessionText = "2026-11-11 · ch 3–4 · 12 min · audio\nThe constraint did not move.";
const highlightText = "“The constraint sets the pace.”\n— I like it\nch 4";

function withBlocks(results, run) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push([String(url), init?.method ?? "GET"]);
    return { ok: true, status: 200, json: async () => ({ results, has_more: false, next_cursor: null }), text: async () => "" };
  };
  return Promise.resolve(run(calls)).finally(() => { globalThis.fetch = real; });
}

test("the one entry that reads exactly like the session is adopted", async () => {
  await withBlocks([quote("other", "something else"), quote("mine", sessionText)], async (calls) => {
    assert.equal(await notion.findMirroredEntry(book, "session", session, new Set()), "mine");
    assert.ok(calls.every(([, method]) => method === "GET"), "read-only");
  });
});

test("a highlight is found the same way", async () => {
  await withBlocks([quote("hl", highlightText)], async () => {
    assert.equal(await notion.findMirroredEntry(book, "highlight", highlight, new Set()), "hl");
  });
});

test("an entry another row already claims is never adopted", async () => {
  await withBlocks([quote("claimed", sessionText)], async () => {
    assert.equal(await notion.findMirroredEntry(book, "session", session, new Set(["claimed"])), null);
  });
});

test("no match, or two matches that cannot be told apart, is null: never a guess", async () => {
  await withBlocks([quote("a", "another session")], async () => {
    assert.equal(await notion.findMirroredEntry(book, "session", session, new Set()), null);
  });
  await withBlocks([quote("a", sessionText), quote("b", sessionText)], async () => {
    assert.equal(await notion.findMirroredEntry(book, "session", session, new Set()), null);
  });
  await withBlocks([quote("a", sessionText), quote("b", sessionText)], async () => {
    assert.equal(await notion.findMirroredEntry(book, "session", session, new Set(["a"])), "b", "one of two is claimed: the other is it");
  });
});

test("a Notion outage or a book with no page is null", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "synthetic" });
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.equal(await notion.findMirroredEntry(book, "session", session, new Set()), null);
  } finally {
    globalThis.fetch = real;
    console.error = quiet;
  }
  assert.equal(await notion.findMirroredEntry({ ...book, notion_page_id: null }, "session", session, new Set()), null);
});
