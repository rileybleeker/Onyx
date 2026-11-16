// Run: node --test tests/reading-autosave.test.cjs (offline). The autosaving reading forms (2026-11-15): what a
// form's fields are worth as a request (lib/reading-autosave.ts), the idempotent create (client_key) and the
// session PATCH / DELETE rules incl. undoing a finish or habit Yes an earlier value caused (lib/reading.ts against
// an in-memory database), the discard record of a /log entry (sql/reading_session_discards.sql: a create of a
// discarded key, also one still under way when the discard lands, is refused; a discard that cannot be recorded is
// an error, never "nothing stored"), the Notion mirror's race check (lib/reading-notion.ts), and source pins for the
// /log session form, the /reading highlight form, the routes, sql/reading_sessions_client_key.sql and
// sql/reading_session_discards.sql.
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

test("newClientKey is a UUID v4; ownRetriedHighlight adopts only this form's own lost create", () => {
  const k = A.newClientKey((b) => b.fill(0xab));
  assert.match(k, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(A.newClientKey(), A.newClientKey());
  const sentAt = Date.parse("2026-11-15T20:00:00Z");
  const unconfirmed = { passage: "Inventory is money.", at: sentAt };
  assert.equal(A.ownRetriedHighlight({ passage: "Inventory is money.", created_at: "2026-11-15T20:00:01Z" }, unconfirmed), true);
  assert.equal(A.ownRetriedHighlight({ passage: "Inventory is money.", created_at: "2026-11-15T19:59:00Z" }, unconfirmed), true, "two minutes of clock slack");
  assert.equal(A.ownRetriedHighlight({ passage: "Inventory is money.", created_at: "2026-11-01T08:00:00Z" }, unconfirmed), false, "saved long before (the harvester)");
  assert.equal(A.ownRetriedHighlight({ passage: "Another passage.", created_at: "2026-11-15T20:00:01Z" }, unconfirmed), false);
  assert.equal(A.ownRetriedHighlight({ passage: "Inventory is money.", created_at: "2026-11-15T20:00:01Z" }, null), false, "nothing sent without an answer");
});

test("parseSessionUpdate: strict body", () => {
  const ok = R.parseSessionUpdate({ chapter_through: 5, chapter_from: 4, minutes: "30", medium: "paper", recall: " kept ", date: "2026-11-14", book: "example-book", habit_created_on: "2026-11-14" });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.input, { book: "example-book", date: "2026-11-14", chapter_through: 5, chapter_from: 4, minutes: 30, medium: "paper", recall: " kept ", question: null, habit_created_on: "2026-11-14" });
  const nulls = R.parseSessionUpdate({ chapter_through: 5, date: null, book: null, habit_created_on: null });
  assert.equal(nulls.input.date, null);
  assert.equal(nulls.input.habit_created_on, null);
  for (const [body, re] of [
    [{}, /chapter_through is required/],
    [{ chapter_through: -1 }, /whole number/],
    [{ chapter_through: 1.5 }, /whole number/],
    [{ chapter_through: 3, chapter_from: 4 }, /at most/],
    [{ chapter_through: 3, date: "2026-02-30" }, /YYYY-MM-DD/],
    [{ chapter_through: 3, habit_created_on: "yesterday" }, /habit_created_on/],
    [{ chapter_through: 3, medium: "vinyl" }, /medium/],
    [{ chapter_through: 3, recall: 5 }, /text/],
    [{ chapter_through: 3, source: "kindle" }, /unknown field source/],
    [{ chapter_through: 3, client_key: "x" }, /unknown field client_key/],
    [[1], /object/],
  ]) {
    const r = R.parseSessionUpdate(body);
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.match(r.error, re);
  }
});

/* ---------- in-memory pds tables behind a supabase-js-shaped builder ---------- */

/** `noClientKey`: the column is not there yet (sql/reading_sessions_client_key.sql not applied). */
/** `missFirstKeyLookup`: the first client_key read finds nothing (another create with the key is still in flight). */
/**
 * `noDiscards`: sql/reading_session_discards.sql is not applied (no function, no trigger). `discardError`: the discard
 * call fails with this code. Otherwise pds.discard_reading_session_key records the key and answers the session it made,
 * and the insert trigger refuses a discarded key (OXR01), as the SQL does. A keyed create is pds.create_reading_session:
 * the session, the finish and the habit Yes in one transaction holding the key's lock, which the discard takes too
 * (modelled as a per-key queue). `hooks.beforeInsert` runs right before an insert reaches the table (before the lock):
 * what the database does while a create is still under way on the server. `hooks.inCreate` runs inside the keyed
 * create's transaction, after its insert and before its finish and habit stamp; anything it starts that needs the
 * key's lock waits for that transaction to commit. `booksReadError`: every read of pds.books fails.
 */
function fakeDb(seed, { noClientKey = false, missFirstKeyLookup = false, noDiscards = false, discardError = null, booksReadError = false } = {}) {
  let keyLookups = 0;
  const tables = JSON.parse(JSON.stringify(seed));
  for (const t of ["books", "reading_sessions", "habit_journal", "reading_session_discards"]) tables[t] ??= [];
  const log = [];
  const hooks = { beforeInsert: null, inCreate: null };
  const locks = new Map();
  /** The key's transaction-scoped advisory lock: whoever comes second waits until the first commits. */
  const withLock = async (key, fn) => {
    const prev = locks.get(key) ?? Promise.resolve();
    let release;
    const mine = new Promise((r) => (release = r));
    locks.set(key, prev.then(() => mine));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  };
  let nextId = 1000;
  function builder(table) {
    const st = { table, filters: [], op: "select", payload: null, order: null, limit: null, single: null };
    const rows = () => tables[table];
    const match = (r) =>
      st.filters.every(([k, op, v]) =>
        op === "eq" ? r[k] === v : op === "neq" ? r[k] !== v : op === "gte" ? r[k] >= v : op === "in" ? v.includes(r[k]) : true,
      );
    const run = () => {
      log.push({ table, op: st.op, payload: st.payload, filters: st.filters });
      if (noClientKey && table === "reading_sessions" && (st.filters.some(([k]) => k === "client_key") || (st.op === "insert" && "client_key" in st.payload))) {
        return { data: null, error: { code: st.op === "insert" ? "PGRST204" : "42703", message: "column client_key does not exist" } };
      }
      if (booksReadError && table === "books" && st.op === "select") return { data: null, error: { code: "57014", message: "statement timeout" } };
      let out;
      if (st.op === "select" && table === "reading_sessions" && st.filters.some(([k]) => k === "client_key") && missFirstKeyLookup && keyLookups++ === 0) out = [];
      else if (st.op === "select") out = rows().filter(match);
      else if (st.op === "update") {
        out = rows().filter(match);
        for (const r of out) Object.assign(r, st.payload);
      } else if (st.op === "delete") {
        out = rows().filter(match);
        tables[table] = rows().filter((r) => !match(r));
      } else if (st.op === "upsert") {
        const p = st.payload;
        const hit = rows().find((r) => r.cycle_date === p.cycle_date && r.question === p.question);
        if (hit) Object.assign(hit, p);
        else rows().push({ ...p });
        out = [p];
      } else if (st.op === "insert") {
        // The BEFORE INSERT trigger of sql/reading_session_discards.sql runs before the unique index.
        if (!noDiscards && table === "reading_sessions" && st.payload.client_key && tables.reading_session_discards.some((d) => d.client_key === st.payload.client_key)) {
          return { data: null, error: { code: "OXR01", message: "this reading entry was discarded" } };
        }
        if (st.payload.client_key && rows().some((r) => r.client_key === st.payload.client_key)) {
          return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
        }
        const row = { session_id: nextId++, notion_block_id: null, in_chapter: null, highlight_count: null, created_at: "2026-11-15T20:00:00Z", ...st.payload };
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
    const go = async () => {
      const pre = st.op === "insert" ? hooks.beforeInsert : null;
      if (pre) {
        hooks.beforeInsert = null;
        await pre();
      }
      return run();
    };
    const b = {
      select() { return b; },
      eq(k, v) { st.filters.push([k, "eq", v]); return b; },
      neq(k, v) { st.filters.push([k, "neq", v]); return b; },
      gte(k, v) { st.filters.push([k, "gte", v]); return b; },
      in(k, v) { st.filters.push([k, "in", v]); return b; },
      order(k, o) { st.order = { k, asc: o?.ascending !== false }; return b; },
      limit(n) { st.limit = n; return b; },
      update(p) { st.op = "update"; st.payload = p; return b; },
      upsert(p) { st.op = "upsert"; st.payload = p; return b; },
      insert(p) { st.op = "insert"; st.payload = p; return b; },
      delete() { st.op = "delete"; return b; },
      single() { st.single = "single"; return go(); },
      maybeSingle() { st.single = "maybe"; return go(); },
      then(res, rej) { return go().then(res, rej); },
    };
    return b;
  }
  const discard = async (key) => {
    log.push({ table: "reading_session_discards", op: "rpc", payload: { client_key: key } });
    if (noDiscards) return { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    if (discardError) return { data: null, error: { code: discardError, message: "database failure" } };
    if (noClientKey) return { data: null, error: { code: "42703", message: "column client_key does not exist" } };
    return withLock(key, () => {
      if (!tables.reading_session_discards.some((d) => d.client_key === key)) tables.reading_session_discards.push({ client_key: key });
      const row = tables.reading_sessions.find((r) => r.client_key === key);
      return { data: row ? row.session_id : null, error: null };
    });
  };
  /** pds.create_reading_session: one transaction under the key's lock (sql/reading_session_discards.sql). */
  const createKeyed = async (a) => {
    log.push({ table: "reading_sessions", op: "rpc", payload: { client_key: a.p_client_key } });
    if (noDiscards) return { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    if (noClientKey) return { data: null, error: { code: "42703", message: "column client_key does not exist" } };
    const pre = hooks.beforeInsert;
    if (pre) {
      hooks.beforeInsert = null;
      await pre();
    }
    return withLock(a.p_client_key, () => {
      if (tables.reading_session_discards.some((d) => d.client_key === a.p_client_key)) {
        return { data: null, error: { code: "OXR01", message: "this reading entry was discarded" } };
      }
      if (tables.reading_sessions.some((r) => r.client_key === a.p_client_key)) {
        return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
      }
      const row = {
        session_id: nextId++,
        book_id: a.p_book_id,
        session_date: a.p_session_date,
        chapter_from: a.p_chapter_from,
        chapter_through: a.p_chapter_through,
        minutes: a.p_minutes,
        medium: a.p_medium,
        recall: a.p_recall,
        question: a.p_question,
        source: a.p_source,
        client_key: a.p_client_key,
        notion_block_id: null,
        in_chapter: null,
        highlight_count: null,
        created_at: "2026-11-15T20:00:00Z",
      };
      tables.reading_sessions.push(row);
      const during = hooks.inCreate;
      if (during) {
        hooks.inCreate = null;
        during(); // not awaited: what it starts waits for this transaction's lock
      }
      const b = tables.books.find((x) => x.book_id === a.p_book_id);
      let finished = false;
      if (b && b.total_chapters > 0 && a.p_chapter_through >= b.total_chapters && b.status !== "finished") {
        Object.assign(b, { status: "finished", finished_on: a.p_session_date });
        finished = true;
      }
      let marked = false;
      let created = false;
      if (b && b.habit_name) {
        const hit = tables.habit_journal.find((h) => h.cycle_date === a.p_session_date && h.question === b.habit_name);
        if (hit) Object.assign(hit, { category: "learning", answer: "Yes" });
        else tables.habit_journal.push({ cycle_date: a.p_session_date, question: b.habit_name, category: "learning", answer: "Yes" });
        marked = true;
        created = !hit;
      }
      return { data: JSON.parse(JSON.stringify({ session: row, finished, habit_marked: marked, habit_created: created })), error: null };
    });
  };
  return {
    tables,
    log,
    hooks,
    from: (t) => builder(t),
    rpc: async (name, args) =>
      name === "behavioral_today_now"
        ? { data: "2026-11-15", error: null }
        : name === "discard_reading_session_key"
          ? discard(args.p_key)
          : name === "create_reading_session"
            ? createKeyed(args)
            : { data: null, error: null },
  };
}

const HABIT = "Read the example?";
const BOOK = { book_id: 7, slug: "example-book", title: "Example", author: null, total_chapters: 12, start_date: "2026-11-01", target_date: "2026-12-01", status: "reading", finished_on: null, notion_page_id: null, habit_name: HABIT, asin: null, last_position: null, last_position_at: null, total_positions: null };
const session = (over) => ({ session_id: 41, book_id: 7, session_date: "2026-11-15", chapter_from: 4, chapter_through: 4, minutes: null, medium: "audio", recall: null, question: null, notion_block_id: null, created_at: "2026-11-15T20:00:00Z", source: "manual", in_chapter: null, highlight_count: null, ...over });
const upd = (over) => ({ book: null, date: null, chapter_through: 4, chapter_from: null, minutes: null, medium: "audio", recall: null, question: null, habit_created_on: null, ...over });
const yes = (date) => ({ cycle_date: date, question: HABIT, category: "learning", answer: "Yes" });
const KEY = "0f1e2d3c-4b5a-4968-8776-655443322110";
const create = (over = {}) => ({ book_id: 7, chapter_through: 5, medium: "audio", source: "manual", client_key: KEY, ...over });

test("logSession: a retried create (same client_key) returns the stored session with no second XP, habit stamp or row", async () => {
  const db = fakeDb({ books: [BOOK] });
  const first = await R.logSession(db, create());
  assert.equal(first.ok, true);
  assert.equal(first.replayed, false);
  assert.equal(first.habitCreated, true, "no habit row existed for the day: this create made it");
  assert.equal(db.tables.reading_sessions[0].client_key, KEY);
  const writesBefore = db.log.filter((l) => l.op !== "select").length;
  const again = await R.logSession(db, create({ chapter_through: 6, client_key: KEY.toUpperCase() }));
  assert.equal(again.ok, true);
  assert.equal(again.replayed, true);
  assert.equal(again.session.session_id, first.session.session_id);
  assert.equal(again.session.chapter_through, 5, "the stored row, not the retry's values (the form writes those with a PATCH)");
  assert.equal(again.habitMarked, false);
  assert.equal(again.habitCreated, null);
  assert.equal(db.tables.reading_sessions.length, 1);
  assert.equal(db.log.filter((l) => l.op !== "select").length, writesBefore, "a replay writes nothing");
});

test("logSession: two creates with one key at once (unique index) end as one session; no key = plain insert", async () => {
  // The pre-check found nothing (the other create had not committed yet); the insert then hits the unique index.
  const db = fakeDb({ books: [BOOK], reading_sessions: [session({ session_id: 41, client_key: KEY })] }, { missFirstKeyLookup: true });
  const raced = await R.logSession(db, create());
  assert.equal(raced.ok, true);
  assert.equal(raced.replayed, true);
  assert.equal(db.tables.reading_sessions.length, 1);
  const plain = fakeDb({ books: [BOOK] });
  await R.logSession(plain, create({ client_key: null }));
  await R.logSession(plain, create({ client_key: null }));
  assert.equal(plain.tables.reading_sessions.length, 2, "chat and other callers send no key: unchanged behaviour");
  assert.equal("client_key" in plain.tables.reading_sessions[0], false);
});

test("logSession: before sql/reading_sessions_client_key.sql is applied a keyed create is refused, never stored without its key", async () => {
  // Stored without its key, a retry could not find it (a second session) and a Discard could not remove it.
  const db = fakeDb({ books: [BOOK] }, { noClientKey: true });
  const r = await R.logSession(db, create());
  assert.equal(r.ok, false);
  assert.match(r.error, /reading_sessions_client_key\.sql/);
  assert.equal(db.tables.reading_sessions.length, 0);
  assert.equal(db.tables.habit_journal.length, 0, "no habit stamp either");
  const plain = await R.logSession(db, create({ client_key: null }));
  assert.equal(plain.ok, true, "callers without a key (chat) are unaffected");
  assert.equal(db.tables.reading_sessions.length, 1);
});

test("logSession with require_client_key (Onyx Chat) never writes a session without its key", async () => {
  // The key column is missing: refused, nothing written (a retried chat message could never find an unkeyed session).
  const db = fakeDb({ books: [BOOK] }, { noClientKey: true });
  const r = await R.logSession(db, create({ source: "chat", require_client_key: true }));
  assert.equal(r.ok, false);
  assert.equal(r.error, R.SESSION_KEY_REQUIRED);
  assert.equal(db.tables.reading_sessions.length, 0);
  assert.equal(db.log.filter((c) => c.table === "reading_sessions" && c.op === "insert").length, 1, "one keyed insert, no unkeyed second one");
  // A key that is not a UUID is refused too, before anything is read or written.
  const bad = fakeDb({ books: [BOOK] });
  const refused = await R.logSession(bad, create({ client_key: "not-a-uuid", require_client_key: true }));
  assert.equal(refused.ok, false);
  assert.equal(refused.error, R.SESSION_KEY_REQUIRED);
  assert.equal(bad.tables.reading_sessions.length, 0);
  // With the column there the session is written with its key.
  const ok = fakeDb({ books: [BOOK] });
  const written = await R.logSession(ok, create({ require_client_key: true }));
  assert.equal(written.ok, true);
  assert.equal(ok.tables.reading_sessions[0].client_key, KEY);
});

test("logSession reports a habit row it did not make as not created", async () => {
  const db = fakeDb({ books: [BOOK], habit_journal: [yes("2026-11-15")] });
  const r = await R.logSession(db, create({ date: "2026-11-15" }));
  assert.equal(r.habitMarked, true);
  assert.equal(r.habitCreated, false);
});

test("updateSession edits the session in place; chapter_from defaults from the book's OTHER sessions", async () => {
  const db = fakeDb({ books: [BOOK], reading_sessions: [session({ session_id: 30, session_date: "2026-11-10", chapter_from: 1, chapter_through: 3 }), session({})] });
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

test("updateSession: moving the day takes back the habit Yes this session made, never one it did not make", async () => {
  // Made by this session (habit_created_on = its day), nothing else on that day: taken back.
  const made = fakeDb({ books: [BOOK], reading_sessions: [session({})], habit_journal: [yes("2026-11-15")] });
  const r = await R.updateSession(made, 41, upd({ date: "2026-11-13", habit_created_on: "2026-11-15" }));
  assert.equal(r.ok, true);
  assert.equal(r.session.session_date, "2026-11-13");
  assert.deepEqual(made.tables.habit_journal.map((h) => h.cycle_date), ["2026-11-13"]);
  assert.equal(r.habitCreatedOn, "2026-11-13", "the new day's row is this session's now");
  // Riley's own answer (not made by the session): left alone.
  const own = fakeDb({ books: [BOOK], reading_sessions: [session({})], habit_journal: [yes("2026-11-15")] });
  const o = await R.updateSession(own, 41, upd({ date: "2026-11-13", habit_created_on: null }));
  assert.deepEqual(own.tables.habit_journal.map((h) => h.cycle_date).sort(), ["2026-11-13", "2026-11-15"]);
  assert.equal(o.habitCreatedOn, "2026-11-13");
  // Another session (even a Kindle one) is still on the old day: left alone.
  const busy = fakeDb({ books: [BOOK], reading_sessions: [session({}), session({ session_id: 50, source: "kindle", chapter_through: null })], habit_journal: [yes("2026-11-15")] });
  await R.updateSession(busy, 41, upd({ date: "2026-11-13", habit_created_on: "2026-11-15" }));
  assert.ok(busy.tables.habit_journal.some((h) => h.cycle_date === "2026-11-15"));
  // A future day is refused.
  assert.equal((await R.updateSession(made, 41, upd({ date: "2026-11-16" }))).status, 400);
});

test("updateSession: a finish caused by a mistaken last chapter is taken back; a moved finishing session moves the finish day", async () => {
  const db = fakeDb({ books: [BOOK], reading_sessions: [session({})] });
  const done = await R.updateSession(db, 41, upd({ chapter_through: 12 }));
  assert.equal(done.finished, true);
  assert.equal(db.tables.books[0].status, "finished");
  assert.equal(db.tables.books[0].finished_on, "2026-11-15");
  const moved = await R.updateSession(db, 41, upd({ chapter_through: 12, date: "2026-11-14" }));
  assert.equal(moved.finished, false);
  assert.equal(db.tables.books[0].finished_on, "2026-11-14", "the finish day follows the session that finished");
  const back = await R.updateSession(db, 41, upd({ chapter_through: 11 }));
  assert.equal(back.unfinished, true);
  assert.equal(db.tables.books[0].status, "reading");
  assert.equal(db.tables.books[0].finished_on, null);
  assert.equal(back.book.status, "reading");
});

test("updateSession: a finish another session also reaches, or one this session did not cause, stays", async () => {
  const finished = { ...BOOK, status: "finished", finished_on: "2026-11-15" };
  const other = fakeDb({ books: [finished], reading_sessions: [session({ chapter_through: 12 }), session({ session_id: 30, session_date: "2026-11-15", chapter_through: 12 })] });
  const r = await R.updateSession(other, 41, upd({ chapter_through: 11 }));
  assert.equal(r.unfinished, false);
  assert.equal(other.tables.books[0].status, "finished");
  const earlier = { ...BOOK, status: "finished", finished_on: "2026-11-02" };
  const notThis = fakeDb({ books: [earlier], reading_sessions: [session({ chapter_through: 12 })] });
  await R.updateSession(notThis, 41, upd({ chapter_through: 11 }));
  assert.equal(notThis.tables.books[0].status, "finished", "finished on another day: not this session's doing");
});

test("updateSession: refuses Kindle sessions, unknown sessions and chapters past the book", async () => {
  const db = fakeDb({ books: [BOOK], reading_sessions: [session({}), session({ session_id: 50, source: "kindle" })] });
  assert.equal((await R.updateSession(db, 50, upd({}))).status, 409);
  assert.equal((await R.updateSession(db, 99, upd({}))).status, 404);
  const tooFar = await R.updateSession(db, 41, upd({ chapter_through: 13 }));
  assert.equal(tooFar.status, 400);
  assert.match(tooFar.error, /cannot exceed 12/);
  assert.equal(db.tables.reading_sessions.find((s) => s.session_id === 50).chapter_through, 4, "the Kindle row is untouched");
});

test("deleteSession removes a manual session, undoes the finish it caused and the habit Yes it made", async () => {
  const finished = { ...BOOK, status: "finished", finished_on: "2026-11-15" };
  const db = fakeDb({ books: [finished], reading_sessions: [session({ chapter_from: 10, chapter_through: 12 })], habit_journal: [yes("2026-11-15")] });
  const r = await R.deleteSession(db, 41, "2026-11-15");
  assert.equal(r.ok, true);
  assert.equal(r.unfinished, true);
  assert.equal(r.habitRemoved, true);
  assert.equal(db.tables.reading_sessions.length, 0);
  assert.equal(db.tables.books[0].status, "reading");
  assert.equal(db.tables.habit_journal.length, 0);
  const kept = fakeDb({ books: [BOOK], reading_sessions: [session({})], habit_journal: [yes("2026-11-15")] });
  await R.deleteSession(kept, 41, null);
  assert.equal(kept.tables.habit_journal.length, 1, "not made by this session: kept");
  const k = fakeDb({ books: [BOOK], reading_sessions: [session({ source: "kindle" })] });
  assert.equal((await R.deleteSession(k, 41)).status, 409);
  assert.equal(k.tables.reading_sessions.length, 1);
});

test("deleteSessionByClientKey (Discard after a lost create answer): removes the session that key made and creates nothing", async () => {
  const finished = { ...BOOK, status: "finished", finished_on: "2026-11-15" };
  const db = fakeDb({
    books: [finished],
    reading_sessions: [session({ chapter_from: 10, chapter_through: 12, client_key: KEY }), session({ session_id: 42, client_key: null })],
    habit_journal: [yes("2026-11-15")],
  });
  const r = await R.deleteSessionByClientKey(db, KEY.toUpperCase());
  assert.equal(r.ok, true);
  assert.equal(r.removed.session_id, 41, "found by the create's own key");
  assert.equal(r.unfinished, true, "the finish it caused is undone");
  assert.deepEqual(db.tables.reading_sessions.map((s) => s.session_id), [42], "only that session goes");
  assert.equal(db.tables.habit_journal.length, 1, "whether that create made the habit row is unknown: the Yes stays");
  assert.equal(db.log.some((l) => l.op === "insert" || l.op === "upsert"), false, "nothing is created to find out");
  assert.deepEqual(db.tables.reading_session_discards.map((d) => d.client_key), [KEY], "the key is recorded as discarded (lower case)");

  const again = await R.deleteSessionByClientKey(db, KEY);
  assert.deepEqual(again, { ok: true, removed: null }, "repeating it is safe: nothing of the entry is stored");
  assert.equal(db.tables.reading_session_discards.length, 1);
  const empty = fakeDb({ books: [BOOK] });
  assert.deepEqual(await R.deleteSessionByClientKey(empty, KEY), { ok: true, removed: null }, "a create that never arrived");
  assert.deepEqual(
    empty.log.filter((l) => l.op !== "select").map((l) => `${l.table}:${l.op}`),
    ["reading_session_discards:rpc"],
    "only the discard is recorded: no session, habit or book write",
  );
  assert.equal((await R.deleteSessionByClientKey(db, "not-a-key")).status, 400);
});

test("deleteSessionByClientKey: a create of that key arriving after the discard is refused, so 'nothing stored' stays true (PR 376 review)", async () => {
  // The create's connection failed in the browser, but the request is still under way on the server. Discard lands
  // first and finds nothing; the create reaches the insert afterwards and is refused by the trigger.
  const db = fakeDb({ books: [BOOK] });
  const r = await R.deleteSessionByClientKey(db, KEY);
  assert.deepEqual(r, { ok: true, removed: null });
  const late = await R.logSession(db, create());
  assert.equal(late.ok, false);
  assert.equal(late.discarded, true, "the route answers 409 discarded");
  assert.equal(late.error, R.DISCARDED_ENTRY_ERROR);
  assert.equal(db.tables.reading_sessions.length, 0, "no session after Onyx said nothing was stored");
  assert.equal(db.tables.habit_journal.length, 0, "and no habit stamp");
  assert.equal(db.tables.books[0].status, "reading");

  // The same create already past its replay check when the discard lands (its insert is the next step).
  const racing = fakeDb({ books: [BOOK] });
  let during = null;
  racing.hooks.beforeInsert = async () => {
    during = await R.deleteSessionByClientKey(racing, KEY);
  };
  const raced = await R.logSession(racing, create());
  assert.deepEqual(during, { ok: true, removed: null });
  assert.equal(raced.ok, false);
  assert.equal(raced.discarded, true);
  assert.equal(racing.tables.reading_sessions.length, 0);
  assert.equal(racing.tables.habit_journal.length, 0);

  // A new key (the entry continued after its discard) creates normally.
  const fresh = await R.logSession(db, create({ client_key: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d" }));
  assert.equal(fresh.ok, true);
  assert.equal(db.tables.reading_sessions.length, 1);
});

test("deleteSessionByClientKey: when the discard cannot be recorded it is an error, never 'nothing stored' (PR 376 review)", async () => {
  for (const [opts, status] of [
    [{ noDiscards: true }, 503], // sql/reading_session_discards.sql not applied
    [{ noClientKey: true }, 503], // the client_key column not applied
    [{ discardError: "XX000" }, 500], // a database failure
  ]) {
    const db = fakeDb({ books: [BOOK], reading_sessions: [session({ client_key: KEY })] }, opts);
    const r = await R.deleteSessionByClientKey(db, KEY);
    assert.equal(r.ok, false, JSON.stringify(opts));
    assert.equal(r.status, status, JSON.stringify(opts));
    assert.equal(db.tables.reading_sessions.length, 1, "nothing removed: the form keeps the entry and retries");
  }
});

test("deleteSession by id records the session's key as discarded: a create of it still under way cannot bring it back", async () => {
  const db = fakeDb({ books: [BOOK], reading_sessions: [session({ client_key: KEY })] });
  const r = await R.deleteSession(db, 41, null);
  assert.equal(r.ok, true);
  assert.equal(db.tables.reading_sessions.length, 0);
  assert.deepEqual(db.tables.reading_session_discards.map((d) => d.client_key), [KEY]);
  const late = await R.logSession(db, create());
  assert.equal(late.discarded, true);
  assert.equal(db.tables.reading_sessions.length, 0);
  // Before sql/reading_session_discards.sql is applied a keyed session is NOT removed (no discard record: a delayed
  // create retry of its key could bring it back): 503, the form keeps the entry and retries (Codex T01-R6).
  const before = fakeDb({ books: [BOOK], reading_sessions: [session({ client_key: KEY })] }, { noDiscards: true });
  const refused = await R.deleteSession(before, 41, null);
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 503);
  assert.match(refused.error, /reading_session_discards\.sql/);
  assert.equal(before.tables.reading_sessions.length, 1, "nothing removed without the discard record");
  const keylessBefore = fakeDb({ books: [BOOK], reading_sessions: [session({})] }, { noDiscards: true });
  assert.equal((await R.deleteSession(keylessBefore, 41, null)).ok, true, "a session with no key needs no record");
  const failing = fakeDb({ books: [BOOK], reading_sessions: [session({ client_key: KEY })] }, { discardError: "XX000" });
  assert.equal((await R.deleteSession(failing, 41, null)).status, 500);
  assert.equal(failing.tables.reading_sessions.length, 1);
  // A session with no key (chat, an older create) is removed with no discard call.
  const keyless = fakeDb({ books: [BOOK], reading_sessions: [session({})] });
  assert.equal((await R.deleteSession(keyless, 41, null)).ok, true);
  assert.equal(keyless.log.some((l) => l.op === "rpc"), false);
});

test("a Discard landing while a keyed create is still committing removes the session AND the finish it caused (Codex T01-R4)", async () => {
  // The create reaches the last chapter. Its insert has run but its transaction has not committed when the Discard
  // arrives (the browser's connection already failed). The discard waits for the key's lock, then finds the session
  // with every effect of its create, and removes it; nothing of the create can follow afterwards.
  const db = fakeDb({ books: [BOOK] });
  let discarding = null;
  db.hooks.inCreate = () => {
    discarding = R.deleteSessionByClientKey(db, KEY);
  };
  const made = await R.logSession(db, create({ chapter_through: 12, date: "2026-11-15" }));
  assert.equal(made.ok, true, "the create committed first");
  assert.equal(made.finished, true);
  const d = await discarding;
  assert.equal(d.ok, true);
  assert.equal(d.removed.session_id, made.session.session_id, "the discard found the committed session");
  assert.equal(d.unfinished, true, "and took back the finish its create caused");
  assert.equal(db.tables.reading_sessions.length, 0);
  assert.equal(db.tables.books[0].status, "reading", "no finished book for a removed session");
  assert.equal(db.tables.books[0].finished_on, null);
  assert.equal(db.tables.habit_journal.length, 1, "the create made the habit Yes before the discard: kept by the documented rule (unknown to the form)");
  // Nothing of the create ran after the removal: a repeat finds nothing and a late retry is refused.
  assert.deepEqual(await R.deleteSessionByClientKey(db, KEY), { ok: true, removed: null });
  const late = await R.logSession(db, create({ chapter_through: 12 }));
  assert.equal(late.discarded, true);
  assert.equal(db.tables.books[0].status, "reading");
});

test("deleteSessionByClientKey: a failed read is never 'nothing stored' (Codex T01-R5)", async () => {
  // The book read fails while the session exists: the answer is an error and the session stays.
  const db = fakeDb({ books: [BOOK], reading_sessions: [session({ client_key: KEY })] }, { booksReadError: true });
  const r = await R.deleteSessionByClientKey(db, KEY);
  assert.equal(r.ok, false);
  assert.equal(r.status, 500);
  assert.equal(db.tables.reading_sessions.length, 1, "still stored: the form keeps the entry and retries");
  const byId = await R.deleteSession(db, 41, null);
  assert.equal(byId.status, 500, "the same read failure on a removal by id is not a 404 either");
  assert.equal(db.tables.reading_sessions.length, 1);
  // The session the discard found is gone by the time it is removed (another request removed it): confirmed absent.
  const gone = fakeDb({ books: [BOOK], reading_sessions: [session({ client_key: KEY })] });
  const baseRpc = gone.rpc;
  gone.rpc = async (name, args) => {
    const out = await baseRpc(name, args);
    if (name === "discard_reading_session_key") gone.tables.reading_sessions.length = 0;
    return out;
  };
  assert.deepEqual(await R.deleteSessionByClientKey(gone, KEY), { ok: true, removed: null });
});

test("logSession: before sql/reading_session_discards.sql is applied a keyed create still works as before", async () => {
  // No fence yet: a Discard by key answers 503 and a keyed session is not removed by id, so nothing can land
  // between the separate steps of the earlier create path.
  const db = fakeDb({ books: [BOOK] }, { noDiscards: true });
  const r = await R.logSession(db, create({ chapter_through: 12, date: "2026-11-15" }));
  assert.equal(r.ok, true);
  assert.equal(r.finished, true);
  assert.equal(r.habitCreated, true);
  assert.equal(db.tables.reading_sessions[0].client_key, KEY);
  assert.equal((await R.deleteSessionByClientKey(db, KEY)).status, 503);
  assert.equal((await R.deleteSession(db, r.session.session_id, null)).status, 503);
  assert.equal(db.tables.reading_sessions.length, 1);
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

test("source pins: no Save button on the reading forms; keys and habit days travel; the edit route is owner-session only", () => {
  const log = read("app/log/sections/Reading.tsx");
  assert.doesNotMatch(log, /LogSaveButton/);
  assert.match(log, /useRetainedAutosave/, "the entry outlives the section while unsaved (PROD-T01)");
  assert.match(log, /client_key: kept\.clientKey/, "every create carries the form's idempotency key");
  assert.match(log, /habit_created_on: kept\.habitCreatedOn/, "edits send back the day of the habit row the session made");
  assert.match(log, /const ok = await autosave\.flush\(\);[\s\S]{0,120}if \(!ok\)/, "a failed send keeps the form (Say it waits)");
  const page = read("app/reading/ReadingClient.tsx");
  assert.doesNotMatch(page, />\s*Add highlight\s*</);
  assert.match(page, /useAutosave<HighlightValue>/);
  assert.match(page, /ownRetriedHighlight\(/);
  const route = read("app/api/reading/sessions/[id]/route.ts");
  assert.match(route, /export async function PATCH/);
  assert.match(route, /checkVoiceRequest\(/);
  assert.match(route, /originRefused\(/);
  const post = read("app/api/reading/sessions/route.ts");
  assert.match(post, /client_key:/);
  assert.match(post, /if \(!result\.replayed\) after\(/, "a replayed create writes no second Notion entry");
  const del = post.slice(post.indexOf("export async function DELETE"));
  assert.ok(del.length > 30, "DELETE /api/reading/sessions?client_key= exists (Discard after a lost create answer)");
  assert.match(del, /originRefused\(req\)/, "same-origin only");
  assert.match(del, /deleteSessionByClientKey\(/);
  assert.doesNotMatch(del, /logSession\(/, "it never creates a session to find one");
  const postFn = post.slice(post.indexOf("export async function POST"), post.indexOf("export async function DELETE"));
  assert.match(postFn, /result\.discarded[\s\S]{0,160}status: 409/, "a discarded key's create answers 409");
  assert.match(log, /was discarded/, "the /log form continues an entry edited after its discard under a new key");
  const mw = read("middleware.ts");
  const ci = mw.slice(mw.indexOf("function isCiRoute"), mw.indexOf("}", mw.indexOf("function isCiRoute")));
  assert.doesNotMatch(ci, /\/api\/reading\/sessions/);
  assert.doesNotMatch(ci, /startsWith\("\/api\/reading/);
});

test("sql/reading_session_discards.sql: additive, service-role only, one lock per key for the create and the discard", () => {
  const sql = fs.readFileSync(path.join(SRC, "..", "..", "sql", "reading_session_discards.sql"), "utf8");
  assert.doesNotMatch(sql, /drop/i, "the Supabase connector refuses any DROP");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS pds\.reading_session_discards/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON pds\.reading_session_discards FROM anon, authenticated/);
  assert.doesNotMatch(sql, /TO (anon|authenticated)/);
  assert.match(sql, /BEFORE INSERT OR UPDATE OF client_key ON pds\.reading_sessions/);
  assert.match(sql, /ERRCODE = 'OXR01'/);
  const locks = sql.match(/pg_advisory_xact_lock\(\s*pg_catalog\.hashtextextended\('pds\.reading_sessions\.client_key:' \|\|/g) ?? [];
  assert.equal(locks.length, 3, "the trigger, the keyed create and the discard take the same lock");
  const fn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION pds.create_reading_session("));
  const body = fn.slice(0, fn.indexOf("$$;"));
  assert.match(body, /INSERT INTO pds\.reading_sessions[\s\S]*UPDATE pds\.books[\s\S]*INSERT INTO pds\.habit_journal/, "session, finish and habit in one function (T01-R4)");
  assert.match(sql, /GRANT EXECUTE ON FUNCTION pds\.create_reading_session\([^)]*\) TO service_role/);
  const lib = read("lib/reading.ts");
  assert.match(lib, /DISCARDED_KEY_CODE = "OXR01"/, "lib/reading.ts maps the trigger's code");
  assert.match(lib, /rpc\("discard_reading_session_key", \{ p_key: key \}\)/);
  assert.match(lib, /rpc\("create_reading_session", \{/, "a keyed create is one database call");
});

test("sql/reading_sessions_client_key.sql: additive only (the Supabase connector refuses any DROP)", () => {
  const sql = fs.readFileSync(path.join(SRC, "..", "..", "sql", "reading_sessions_client_key.sql"), "utf8");
  assert.doesNotMatch(sql, /drop/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS client_key uuid/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS \w+\s+ON pds\.reading_sessions \(client_key\)\s+WHERE client_key IS NOT NULL/);
});
