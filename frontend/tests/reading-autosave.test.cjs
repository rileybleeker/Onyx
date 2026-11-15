// Run: node --test tests/reading-autosave.test.cjs (offline). The autosaving reading forms (2026-11-15): what a
// form's fields are worth as a request (lib/reading-autosave.ts), the session PATCH rules (lib/reading.ts
// parseSessionUpdate / updateSession / deleteSession against an in-memory database), the Notion mirror's race
// check (lib/reading-notion.ts), and source pins for the two forms and the route.
// SYNTHETIC DATA ONLY: invented books, chapters and dates; no network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const A = loadTs("lib/reading-autosave.ts");
const R = loadTs("lib/reading.ts");
const N = loadTs("lib/reading-notion.ts");

const ctx = (over = {}) => ({ book: "example-book", chosenDay: null, today: "2026-11-15", total: 12, ...over });
const fields = (over = {}) => ({ from: "", through: "4", minutes: "", recall: "", medium: "audio", ...over });

test("sessionValue: a valid entry is a body; the day is sent only when chosen; the recall stays as typed", () => {
  const v = A.sessionValue(fields({ minutes: "25", recall: "  The bottleneck sets the pace.  " }), ctx());
  assert.equal(v.reason, null);
  assert.deepEqual(v.body, { book: "example-book", date: null, chapter_from: null, chapter_through: 4, minutes: 25, medium: "audio", recall: "  The bottleneck sets the pace.  " });
  assert.equal(A.sessionValue(fields(), ctx({ chosenDay: "2026-11-14" })).body.date, "2026-11-14");
  assert.equal(A.sessionValue({ ...fields(), question: "Why?" }, ctx()).body.question, "Why?");
  assert.equal("question" in A.sessionValue(fields(), ctx()).body, false, "the /log form has no question field: never sent there");
});

test("sessionValue: not ready until it is a valid session, with the reason the form shows", () => {
  assert.match(A.sessionValue(fields({ through: "" }), ctx()).reason, /chapter you read through/);
  assert.match(A.sessionValue(fields({ through: "2.5" }), ctx()).reason, /chapter you read through/);
  assert.match(A.sessionValue(fields({ through: "13" }), ctx()).reason, /12 chapters/);
  assert.equal(A.sessionValue(fields({ through: "13" }), ctx({ total: null })).reason, null, "another book: the server checks its chapter count");
  assert.match(A.sessionValue(fields({ from: "5" }), ctx()).reason, /first chapter/);
  assert.match(A.sessionValue(fields({ minutes: "-1" }), ctx()).reason, /Minutes/);
  assert.match(A.sessionValue(fields(), ctx({ chosenDay: "2026-11-16" })).reason, /today or an earlier day/);
  assert.equal(A.sessionValue(fields(), ctx({ chosenDay: "2026-11-16" })).body, null);
});

test("sameReadingValue compares the request only; isBlankSession; first save creates, later saves edit", () => {
  assert.equal(A.sameReadingValue({ body: null, reason: "a" }, { body: null, reason: "b" }), true);
  const one = A.sessionValue(fields(), ctx());
  assert.equal(A.sameReadingValue(one, A.sessionValue(fields(), ctx())), true);
  assert.equal(A.sameReadingValue(one, A.sessionValue(fields({ minutes: "5" }), ctx())), false);
  assert.equal(A.isBlankSession({ from: "", through: "", minutes: "", recall: " ", medium: "audio" }, { medium: "audio" }), true);
  assert.equal(A.isBlankSession({ from: "", through: "", minutes: "", recall: "", medium: "paper" }, { medium: "audio" }), false);
  assert.deepEqual(A.readingSaveTarget("sessions", null), { url: "/api/reading/sessions", method: "POST" });
  assert.deepEqual(A.readingSaveTarget("sessions", 41), { url: "/api/reading/sessions/41", method: "PATCH" });
  assert.deepEqual(A.readingSaveTarget("highlights", 7), { url: "/api/reading/highlights/7", method: "PATCH" });
});

test("highlightValue: sent once the passage is not empty", () => {
  assert.equal(A.highlightValue({ passage: "  ", comment: "x", chapter: "", concept: "", source: "kindle" }).body, null);
  assert.deepEqual(A.highlightValue({ passage: " Inventory is money. ", comment: "", chapter: "3", concept: " ", source: "paper" }).body, {
    passage: "Inventory is money.", comment: "", chapter: 3, concept: null, source: "paper",
  });
  assert.match(A.highlightValue({ passage: "p", comment: "", chapter: "3a", concept: "", source: "kindle" }).reason, /whole number/);
});

test("parseSessionUpdate: strict body", () => {
  const ok = R.parseSessionUpdate({ chapter_through: 5, chapter_from: 4, minutes: "30", medium: "paper", recall: " kept ", date: "2026-11-14", book: "example-book" });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.input, { book: "example-book", date: "2026-11-14", chapter_through: 5, chapter_from: 4, minutes: 30, medium: "paper", recall: " kept ", question: null });
  assert.equal(R.parseSessionUpdate({ chapter_through: 5, date: null, book: null }).input.date, null);
  for (const [body, re] of [
    [{}, /chapter_through is required/],
    [{ chapter_through: -1 }, /whole number/],
    [{ chapter_through: 1.5 }, /whole number/],
    [{ chapter_through: 3, chapter_from: 4 }, /at most/],
    [{ chapter_through: 3, date: "2026-02-30" }, /YYYY-MM-DD/],
    [{ chapter_through: 3, medium: "vinyl" }, /medium/],
    [{ chapter_through: 3, recall: 5 }, /text/],
    [{ chapter_through: 3, source: "kindle" }, /unknown field source/],
    [[1], /object/],
  ]) {
    const r = R.parseSessionUpdate(body);
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.match(r.error, re);
  }
});

/* ---------- in-memory pds tables behind a supabase-js-shaped builder ---------- */

function fakeDb(seed) {
  const tables = JSON.parse(JSON.stringify(seed));
  const log = [];
  let nextId = 1000;
  function builder(table) {
    const st = { table, filters: [], op: "select", payload: null, order: null, limit: null, single: null, rpc: null };
    const rows = () => (tables[table] ??= []);
    const match = (r) => st.filters.every(([k, op, v]) => (op === "eq" ? r[k] === v : op === "neq" ? r[k] !== v : op === "gte" ? r[k] >= v : true));
    const run = () => {
      log.push({ table, op: st.op, payload: st.payload, filters: st.filters });
      let out;
      if (st.op === "select") out = rows().filter(match);
      else if (st.op === "update") {
        out = rows().filter(match);
        for (const r of out) Object.assign(r, st.payload);
      } else if (st.op === "delete") {
        const keep = rows().filter((r) => !match(r));
        out = rows().filter(match);
        tables[table] = keep;
      } else if (st.op === "upsert") {
        const p = st.payload;
        const hit = rows().find((r) => r.cycle_date === p.cycle_date && r.question === p.question);
        if (hit) Object.assign(hit, p);
        else rows().push({ ...p });
        out = [p];
      } else if (st.op === "insert") {
        const row = { session_id: nextId++, ...st.payload };
        rows().push(row);
        out = [row];
      }
      if (st.order) out = [...out].sort((a, b) => (st.order.asc ? a[st.order.k] - b[st.order.k] : b[st.order.k] - a[st.order.k]));
      if (st.limit != null) out = out.slice(0, st.limit);
      out = JSON.parse(JSON.stringify(out));
      if (st.single === "single") return out.length === 1 ? { data: out[0], error: null } : { data: null, error: { message: "not one row", code: "PGRST116" } };
      if (st.single === "maybe") return { data: out[0] ?? null, error: null };
      return { data: out, error: null };
    };
    const b = {
      select() { return b; },
      eq(k, v) { st.filters.push([k, "eq", v]); return b; },
      neq(k, v) { st.filters.push([k, "neq", v]); return b; },
      gte(k, v) { st.filters.push([k, "gte", v]); return b; },
      order(k, o) { st.order = { k, asc: o?.ascending !== false }; return b; },
      limit(n) { st.limit = n; return b; },
      update(p) { st.op = "update"; st.payload = p; return b; },
      upsert(p) { st.op = "upsert"; st.payload = p; return b; },
      insert(p) { st.op = "insert"; st.payload = p; return b; },
      delete() { st.op = "delete"; return b; },
      single() { st.single = "single"; return Promise.resolve(run()); },
      maybeSingle() { st.single = "maybe"; return Promise.resolve(run()); },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return b;
  }
  return {
    tables,
    log,
    from: (t) => builder(t),
    rpc: async (name) => (name === "behavioral_today_now" ? { data: "2026-11-15", error: null } : { data: null, error: null }),
  };
}

const BOOK = { book_id: 7, slug: "example-book", title: "Example", author: null, total_chapters: 12, start_date: "2026-11-01", target_date: "2026-12-01", status: "reading", finished_on: null, notion_page_id: null, habit_name: "Read the example?", asin: null, last_position: null, last_position_at: null, total_positions: null };
const session = (over) => ({ session_id: 41, book_id: 7, session_date: "2026-11-15", chapter_from: 4, chapter_through: 4, minutes: null, medium: "audio", recall: null, question: null, notion_block_id: null, created_at: "2026-11-15T20:00:00Z", source: "manual", in_chapter: null, highlight_count: null, ...over });
const upd = (over) => ({ book: null, date: null, chapter_through: 4, chapter_from: null, minutes: null, medium: "audio", recall: null, question: null, ...over });

test("updateSession edits the session in place; chapter_from defaults from the book's OTHER sessions", async () => {
  const db = fakeDb({ books: [BOOK], reading_sessions: [session({ session_id: 30, session_date: "2026-11-10", chapter_from: 1, chapter_through: 3 }), session({})], habit_journal: [] });
  const r = await R.updateSession(db, 41, upd({ chapter_through: 6, minutes: 40, recall: "  The constraint decides.  " }));
  assert.equal(r.ok, true);
  assert.equal(r.session.chapter_from, 4, "this session's own chapter_through (4, the old value) must not count as 'read before'");
  assert.equal(r.session.chapter_through, 6);
  assert.equal(r.session.minutes, 40);
  assert.equal(r.session.recall, "The constraint decides.");
  assert.equal(r.session.session_date, "2026-11-15", "no date sent = the session keeps its own day");
  assert.equal(r.xpGained, 3 * R.XP.perChapter);
  assert.equal(db.tables.habit_journal.length, 0, "same day: no new habit stamp");
  assert.equal(db.tables.reading_sessions.length, 2);
});

test("updateSession: a new day stamps the habit there and leaves the old day's row alone", async () => {
  const db = fakeDb({ books: [BOOK], reading_sessions: [session({})], habit_journal: [{ cycle_date: "2026-11-15", question: BOOK.habit_name, category: "learning", answer: "Yes" }] });
  const r = await R.updateSession(db, 41, upd({ date: "2026-11-13" }));
  assert.equal(r.ok, true);
  assert.equal(r.session.session_date, "2026-11-13");
  assert.deepEqual(db.tables.habit_journal.map((h) => h.cycle_date).sort(), ["2026-11-13", "2026-11-15"]);
  const future = await R.updateSession(db, 41, upd({ date: "2026-11-16" }));
  assert.equal(future.ok, false);
  assert.equal(future.status, 400);
});

test("updateSession: refuses Kindle sessions, unknown sessions and chapters past the book; reaching the end finishes it", async () => {
  const db = fakeDb({ books: [BOOK], reading_sessions: [session({}), session({ session_id: 50, source: "kindle" })], habit_journal: [] });
  assert.equal((await R.updateSession(db, 50, upd({}))).status, 409);
  assert.equal((await R.updateSession(db, 99, upd({}))).status, 404);
  const tooFar = await R.updateSession(db, 41, upd({ chapter_through: 13 }));
  assert.equal(tooFar.status, 400);
  assert.match(tooFar.error, /cannot exceed 12/);
  const done = await R.updateSession(db, 41, upd({ chapter_through: 12 }));
  assert.equal(done.finished, true);
  assert.equal(db.tables.books[0].status, "finished");
  assert.equal(db.tables.books[0].finished_on, "2026-11-15");
  assert.equal(db.tables.reading_sessions.find((s) => s.session_id === 50).chapter_through, 4, "the Kindle row is untouched");
});

test("deleteSession removes a manual session; a book it finished goes back to reading", async () => {
  const finished = { ...BOOK, status: "finished", finished_on: "2026-11-15" };
  const db = fakeDb({ books: [finished], reading_sessions: [session({ chapter_from: 10, chapter_through: 12 })], habit_journal: [] });
  const r = await R.deleteSession(db, 41);
  assert.equal(r.ok, true);
  assert.equal(r.unfinished, true);
  assert.equal(db.tables.reading_sessions.length, 0);
  assert.equal(db.tables.books[0].status, "reading");
  const k = fakeDb({ books: [BOOK], reading_sessions: [session({ source: "kindle" })] });
  assert.equal((await R.deleteSession(k, 41)).status, 409);
  assert.equal(k.tables.reading_sessions.length, 1);
});

test("Notion mirror race check: only a change that alters the entry counts", () => {
  const a = session({});
  assert.equal(N.sessionMirrorDiffers(a, { ...a, notion_block_id: "b1", created_at: "later" }), false);
  assert.equal(N.sessionMirrorDiffers(a, { ...a, minutes: 30 }), true);
  assert.equal(N.sessionMirrorDiffers(a, { ...a, book_id: 8 }), true);
  const h = { highlight_id: 1, passage: "p", comment: null, chapter: 2, location: null, concept: null, source: "manual" };
  assert.equal(N.highlightMirrorDiffers(h, { ...h, notion_block_id: "x" }), false);
  assert.equal(N.highlightMirrorDiffers(h, { ...h, comment: "why" }), true);
});

const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

test("source pins: no Save button on the reading forms; the edit route is owner-session only and same-origin", () => {
  const log = read("app/log/sections/Reading.tsx");
  assert.doesNotMatch(log, /LogSaveButton/);
  assert.match(log, /useAutosave/);
  const page = read("app/reading/ReadingClient.tsx");
  assert.doesNotMatch(page, /"Log session"|>\s*Add highlight\s*</);
  // Sessions are entered on /log only (#331); /reading keeps the self-saving highlight form.
  assert.doesNotMatch(page, /function SessionForm/);
  assert.match(page, /useAutosave<HighlightValue>/);
  const route = read("app/api/reading/sessions/[id]/route.ts");
  assert.match(route, /export async function PATCH/);
  assert.match(route, /checkVoiceRequest\(/);
  assert.match(route, /originRefused\(/);
  const mw = read("middleware.ts");
  const ci = mw.slice(mw.indexOf("function isCiRoute"), mw.indexOf("}", mw.indexOf("function isCiRoute")));
  assert.doesNotMatch(ci, /\/api\/reading\/sessions/);
  assert.doesNotMatch(ci, /startsWith\("\/api\/reading/);
});
