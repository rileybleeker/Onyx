// Run: node --test tests/reading-highlight-errors.test.cjs (offline). addHighlight's database failures (lib/reading.ts)
// answer a fixed copy with kind "server" and log the raw database text on the server only; validation and the
// HIGHLIGHT_EXISTS conflict stay plain (no kind). The route answers kind "server" with 500, everything else 400.
// SYNTHETIC DATA ONLY: an invented book and passage; an in-memory fake of the Supabase calls; no network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs } = require("./helpers/load-ts.cjs");

const R = loadTs("lib/reading.ts");

const COPY = "Couldn't save the highlight. Try again.";
const UUID = "3f2a9c1e-5b7d-4e8a-9c0f-1a2b3c4d5e6f";
const BOOK = { book_id: 7, slug: "example-book", title: "Example", total_chapters: 12, status: "reading" };
const EXISTING = { highlight_id: 1, book_id: 7, passage: "An invented passage.", comment: null, chapter: null, location: null, concept: null, position: null, position_end: null, page: null, highlighted_at: null, note_at: null, archived: false };
const RAW = "relation pds.secret_table: permission denied (synthetic)";

/** A fake of the few Supabase calls addHighlight makes. `failing` names the call that returns an error. */
function fakeDb({ failing = null, read = null } = {}) {
  return {
    from(table) {
      const st = { table, insert: false, update: false };
      const result = () => {
        if (st.table === "books") return { data: BOOK, error: null };
        if (st.insert) return failing === "insert" ? { data: null, error: { code: "XX000", message: RAW } } : { data: { ...EXISTING, highlight_id: 2 }, error: null };
        if (st.update) return failing === "update" ? { data: null, error: { code: "XX000", message: RAW } } : { data: { ...EXISTING, comment: "new" }, error: null };
        if (failing === "read") return { data: null, error: { code: "XX000", message: RAW } };
        return { data: read, error: null };
      };
      const chain = {
        select: () => chain,
        eq: () => chain,
        insert: () => ((st.insert = true), chain),
        update: () => ((st.update = true), chain),
        single: async () => result(),
        maybeSingle: async () => result(),
      };
      return chain;
    },
  };
}

/** Runs addHighlight with console.error captured: returns the result and the logged lines. */
async function run(db, input) {
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    return { result: await R.addHighlight(db, input), logged };
  } finally {
    console.error = original;
  }
}

const base = { book_id: 7, passage: "An invented passage.", date: "2026-11-15" };

test("insert_only: an insert failure answers the fixed copy as a server failure and logs the raw text", async () => {
  const { result, logged } = await run(fakeDb({ failing: "insert" }), { ...base, client_key: UUID, insert_only: true });
  assert.deepEqual(result, { ok: false, error: COPY, kind: "server" });
  assert.equal(logged.length, 1);
  assert.match(logged[0], /reading\/highlights addHighlight/);
  assert.match(logged[0], /secret_table/);
});

test("insert_only: a failed read-back after a unique violation answers the fixed copy, not the database text", async () => {
  const db = fakeDb({ failing: "read" });
  // Force the 23505 branch: the insert reports a unique violation, then the read-back fails.
  const conflicting = {
    from(table) {
      const inner = db.from(table);
      return {
        ...inner,
        insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { code: "23505", message: RAW } }) }) }),
      };
    },
  };
  const { result, logged } = await run(conflicting, { ...base, client_key: UUID, insert_only: true });
  assert.deepEqual(result, { ok: false, error: COPY, kind: "server" });
  assert.match(logged[0], /secret_table/);
});

test("update of an existing highlight: a failure answers the fixed copy as a server failure", async () => {
  const { result, logged } = await run(fakeDb({ failing: "update", read: { ...EXISTING } }), { ...base, comment: "new" });
  assert.deepEqual(result, { ok: false, error: COPY, kind: "server" });
  assert.match(logged[0], /secret_table/);
});

test("plain insert: a failure answers the fixed copy as a server failure", async () => {
  const { result, logged } = await run(fakeDb({ failing: "insert" }), { ...base });
  assert.deepEqual(result, { ok: false, error: COPY, kind: "server" });
  assert.match(logged[0], /secret_table/);
});

test("validation and the existing-highlight conflict stay plain (no kind)", async () => {
  const bad = await run(fakeDb(), { ...base, client_key: "not-a-uuid" });
  assert.deepEqual(bad.result, { ok: false, error: "client_key must be a UUID" });
  assert.equal(bad.logged.length, 0);

  // Unique violation, and the read-back under this key finds nothing: another write holds the passage.
  const conflictDb = {
    from(table) {
      const inner = fakeDb({ read: null }).from(table);
      return { ...inner, insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { code: "23505", message: RAW } }) }) }) };
    },
  };
  const conflict = await run(conflictDb, { ...base, client_key: UUID, insert_only: true });
  assert.deepEqual(conflict.result, { ok: false, error: R.HIGHLIGHT_EXISTS });
  assert.equal(conflict.logged.length, 0);
});

test("route: a server failure answers 500, every other failure 400", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "app", "api", "reading", "highlights", "route.ts"), "utf8");
  assert.match(src, /status: result\.kind === "server" \? 500 : 400/);
});
