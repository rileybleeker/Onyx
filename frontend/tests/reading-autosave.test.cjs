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
 * `noDiscards`: sql/reading_session_discards.sql is not applied (no function, no trigger). `discardError`: the removal
 * call fails with this code. Otherwise pds.remove_reading_session records the key, removes the session with the finish
 * and habit Yes it caused and writes the cleanup row, in one step, and the insert trigger refuses a discarded key
 * (OXR01), as the SQL does. A keyed create is pds.create_reading_session:
 * the session, the finish and the habit Yes in one transaction holding the key's lock, which the discard takes too
 * (modelled as a per-key queue). `hooks.beforeInsert` runs right before an insert reaches the table (before the lock):
 * what the database does while a create is still under way on the server. `hooks.inCreate` runs inside the keyed
 * create's transaction, after its insert and before its finish and habit stamp; anything it starts that needs the
 * key's lock waits for that transaction to commit. `booksReadError`: every read of pds.books fails (the removal too).
 * Every reading stamp (keyed create, move, keyless stamp) records the habit row in pds.reading_habit_provenance, one
 * row per (day, question), and the last session of a day going settles it (pds.settle_reading_habit).
 * `settleError`: that settle raises, which rolls back the whole removal or move it is part of.
 */
function fakeDb(seed, { noClientKey = false, missFirstKeyLookup = false, noDiscards = false, discardError = null, booksReadError = false, settleError = null } = {}) {
  let keyLookups = 0;
  const tables = JSON.parse(JSON.stringify(seed));
  for (const t of ["books", "reading_sessions", "habit_journal", "reading_session_discards", "reading_session_removals", "reading_habit_provenance", "reading_mirror_claims", "reading_progress_owed"]) tables[t] ??= [];
  // The habit rows' versions (xmin in the database): every write to a row gives it a new one.
  const versions = new Map();
  let nextVersion = 1;
  const habitKey = (date, question) => `${date}|${question}`;
  const bump = (date, question) => versions.set(habitKey(date, question), nextVersion++);
  /** A transaction: on a raised error every table and row version goes back to how it was (ROLLBACK). */
  const atomically = (fn) => {
    const snap = JSON.parse(JSON.stringify(tables));
    const snapVersions = new Map(versions);
    try {
      return fn();
    } catch (e) {
      for (const k of Object.keys(tables)) delete tables[k];
      Object.assign(tables, snap);
      versions.clear();
      for (const [k, v] of snapVersions) versions.set(k, v);
      return { data: null, error: { code: e.code ?? "P0001", message: e.message } };
    }
  };
  /** pds.stamp_reading_habit: the Yes and its record (kept while nothing else wrote the row since the last stamp). */
  const stampTx = (date, question) => {
    const hit = tables.habit_journal.find((h) => h.cycle_date === date && h.question === question);
    const prov = tables.reading_habit_provenance.find((x) => x.cycle_date === date && x.question === question);
    const keep = !!prov && !!hit && prov.row_version === versions.get(habitKey(date, question));
    const before = hit ? { answer: hit.answer, category: hit.category } : null;
    if (hit) Object.assign(hit, { category: "learning", answer: "Yes" });
    else tables.habit_journal.push({ cycle_date: date, question, category: "learning", answer: "Yes" });
    bump(date, question);
    const version = versions.get(habitKey(date, question));
    if (keep) prov.row_version = version;
    else {
      tables.reading_habit_provenance = tables.reading_habit_provenance.filter((x) => !(x.cycle_date === date && x.question === question));
      tables.reading_habit_provenance.push({ cycle_date: date, question, had_row: !!hit, prev_answer: before?.answer ?? null, prev_category: before?.category ?? null, row_version: version });
    }
    return { marked: true, created: !hit };
  };
  /** pds.settle_reading_habit: after a session left (date, question). Throws `settleError` (the caller rolls back). */
  const settleTx = (date, question, createdOn) => {
    if (settleError) throw Object.assign(new Error("habit write refused"), { code: settleError });
    const sameHabit = tables.books.filter((x) => x.habit_name === question).map((x) => x.book_id);
    if (tables.reading_sessions.some((x) => x.session_date === date && sameHabit.includes(x.book_id))) return { removed: false, restored: false };
    const prov = tables.reading_habit_provenance.find((x) => x.cycle_date === date && x.question === question);
    let removed = false;
    let restored = false;
    if (prov) {
      const h = tables.habit_journal.find((x) => x.cycle_date === date && x.question === question);
      if (h && versions.get(habitKey(date, question)) === prov.row_version) {
        if (!prov.had_row) {
          tables.habit_journal = tables.habit_journal.filter((x) => x !== h);
          versions.delete(habitKey(date, question));
          removed = true;
        } else if (h.answer !== prov.prev_answer || h.category !== prov.prev_category) {
          Object.assign(h, { answer: prov.prev_answer, category: prov.prev_category });
          bump(date, question);
          restored = true;
          removed = prov.prev_answer !== "Yes";
        }
      }
      tables.reading_habit_provenance = tables.reading_habit_provenance.filter((x) => x !== prov);
    } else if (createdOn && createdOn === date) {
      const before = tables.habit_journal.length;
      tables.habit_journal = tables.habit_journal.filter((h) => !(h.cycle_date === date && h.question === question && h.answer === "Yes"));
      removed = tables.habit_journal.length < before;
    }
    return { removed, restored };
  };
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
        op === "eq" ? r[k] === v : op === "neq" ? r[k] !== v : op === "gte" ? r[k] >= v : op === "lt" ? r[k] < v : op === "in" ? v.includes(r[k]) : op === "is" ? (r[k] ?? null) === v : true,
      );
    const run = () => {
      log.push({ table, op: st.op, payload: st.payload, filters: st.filters });
      if (table === "habit_journal" && st.op !== "select") {
        const touched = st.op === "upsert" || st.op === "insert" ? [st.payload] : rows().filter(match);
        for (const r of touched) bump(r.cycle_date, r.question);
      }
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
      is(k, v) { st.filters.push([k, "is", v]); return b; },
      gte(k, v) { st.filters.push([k, "gte", v]); return b; },
      lt(k, v) { st.filters.push([k, "lt", v]); return b; },
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
  /**
   * pds.remove_reading_session: one transaction (sql/reading_session_discards.sql). The key (given, or the session's
   * own) is recorded as discarded under its lock; the delete, the finish taken back, the habit Yes it made and the
   * cleanup row commit together. Nothing found: the cleanup row of an earlier removal of that id / key.
   */
  const remove = async (a) => {
    log.push({ table: "remove_reading_session", op: "rpc", payload: { session_id: a.p_session_id, client_key: a.p_client_key } });
    if (noDiscards) return { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    if (discardError) return { data: null, error: { code: discardError, message: "database failure" } };
    if (noClientKey) return { data: null, error: { code: "42703", message: "column client_key does not exist" } };
    if (booksReadError) return { data: null, error: { code: "57014", message: "statement timeout" } };
    const key = a.p_client_key ?? tables.reading_sessions.find((r) => r.session_id === a.p_session_id)?.client_key ?? null;
    const tx = () => {
      const row = a.p_client_key
        ? tables.reading_sessions.find((r) => r.client_key === a.p_client_key)
        : tables.reading_sessions.find((r) => r.session_id === a.p_session_id);
      // A Kindle session raises (the transaction rolls back, so no discard is recorded either).
      if (row && row.source !== "manual" && row.source !== "chat") return { data: null, error: { code: "OXR02", message: "kindle" } };
      if (key && !tables.reading_session_discards.some((d) => d.client_key === key)) tables.reading_session_discards.push({ client_key: key });
      if (!row) {
        const rem = a.p_client_key
          ? [...tables.reading_session_removals].reverse().find((r) => r.client_key === a.p_client_key)
          : tables.reading_session_removals.find((r) => r.session_id === a.p_session_id);
        return { data: JSON.parse(JSON.stringify({ removed: false, removal: rem ?? null })), error: null };
      }
      const b = tables.books.find((x) => x.book_id === row.book_id);
      if (!b) return { data: null, error: { code: "OXR03", message: "book missing" } };
      tables.reading_sessions = tables.reading_sessions.filter((r) => r.session_id !== row.session_id);
      let unfinished = false;
      const total = b.total_chapters;
      if (
        b.status === "finished" && total > 0 && (row.chapter_through ?? 0) >= total && b.finished_on === row.session_date &&
        !tables.reading_sessions.some((s) => s.book_id === b.book_id && s.chapter_through >= total)
      ) {
        Object.assign(b, { status: "reading", finished_on: null });
        unfinished = true;
      }
      // The habit part (pds.settle_reading_habit): no exception block, so a failure rolls the removal back.
      const settled = b.habit_name ? settleTx(row.session_date, b.habit_name, a.p_habit_created_on) : { removed: false, restored: false };
      const habitRemoved = settled.removed;
      const habitRestored = settled.restored;
      const removal = { session_id: row.session_id, client_key: row.client_key ?? null, book_id: row.book_id, session_date: row.session_date, notion_block_id: row.notion_block_id ?? null, unfinished, removed_at: "2026-11-15T21:00:00Z", mirror_done_at: null };
      tables.reading_session_removals = tables.reading_session_removals.filter((r) => r.session_id !== row.session_id).concat([removal]);
      return { data: JSON.parse(JSON.stringify({ removed: true, session: row, book: b, unfinished, habit_removed: habitRemoved, habit_restored: habitRestored, removal })), error: null };
    };
    return key ? withLock(key, () => atomically(tx)) : atomically(tx);
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
      if (b && b.habit_name) ({ marked, created } = stampTx(a.p_session_date, b.habit_name));
      return { data: JSON.parse(JSON.stringify({ session: row, finished, habit_marked: marked, habit_created: created })), error: null };
    });
  };
  /** pds.stamp_reading_habit called on its own (a keyless create). */
  const stampAlone = async (a) => {
    log.push({ table: "stamp_reading_habit", op: "rpc", payload: { cycle_date: a.p_cycle_date } });
    if (noDiscards) return { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    return atomically(() => ({ data: stampTx(a.p_cycle_date, a.p_question), error: null }));
  };
  /**
   * pds.move_reading_session: every edit in one transaction: the session's new values, the books' finish (from the row
   * as it was), and for a move the new day's stamp and the old day's settle.
   */
  const move = async (a) => {
    log.push({ table: "move_reading_session", op: "rpc", payload: { session_id: a.p_session_id } });
    if (noDiscards) return { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    return atomically(() => {
      const row = tables.reading_sessions.find((r) => r.session_id === a.p_session_id);
      if (!row) return { data: { moved: false }, error: null };
      if (row.source !== "manual" && row.source !== "chat") return { data: null, error: { code: "OXR02", message: "kindle" } };
      const oldBook = tables.books.find((x) => x.book_id === row.book_id);
      const newBook = tables.books.find((x) => x.book_id === a.p_book_id);
      if (!newBook) return { data: null, error: { code: "OXR03", message: "no such book" } };
      const prev = { ...row };
      const oldDate = row.session_date;
      const sameBook = row.book_id === a.p_book_id;
      const moved = oldDate !== a.p_session_date || !sameBook;
      Object.assign(row, {
        book_id: a.p_book_id,
        session_date: a.p_session_date,
        chapter_from: a.p_chapter_from,
        chapter_through: a.p_chapter_through,
        minutes: a.p_minutes,
        medium: a.p_medium,
        recall: a.p_recall,
        question: a.p_question,
      });
      const earliestFinishing = (b) =>
        tables.reading_sessions.filter((s) => s.book_id === b.book_id && s.chapter_through >= b.total_chapters).map((s) => s.session_date).sort()[0] ?? null;
      const reaches = newBook.total_chapters > 0 && a.p_chapter_through >= newBook.total_chapters;
      let finished = false;
      let unfinished = false;
      if (reaches && newBook.status !== "finished") {
        Object.assign(newBook, { status: "finished", finished_on: a.p_session_date });
        finished = true;
      } else if (reaches && sameBook && oldDate !== a.p_session_date && newBook.finished_on === oldDate && (prev.chapter_through ?? 0) >= newBook.total_chapters) {
        const next = earliestFinishing(newBook);
        if (next && next !== newBook.finished_on) newBook.finished_on = next;
      }
      if (
        !(sameBook && reaches) && oldBook && oldBook.status === "finished" && oldBook.total_chapters > 0 &&
        (prev.chapter_through ?? 0) >= oldBook.total_chapters && oldBook.finished_on === oldDate
      ) {
        const next = earliestFinishing(oldBook);
        if (next === null) {
          Object.assign(oldBook, { status: "reading", finished_on: null });
          unfinished = true;
        } else if (next !== oldBook.finished_on) oldBook.finished_on = next;
      }
      const stamp = moved && newBook.habit_name ? stampTx(a.p_session_date, newBook.habit_name) : { marked: false, created: false };
      const settled = moved && oldBook?.habit_name ? settleTx(oldDate, oldBook.habit_name, a.p_habit_created_on) : { removed: false, restored: false };
      return {
        data: JSON.parse(JSON.stringify({ moved: true, session: row, book: newBook, finished, unfinished, habit_marked: stamp.marked, habit_created: stamp.created, habit_removed: settled.removed, habit_restored: settled.restored })),
        error: null,
      };
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
        : name === "remove_reading_session"
          ? remove(args)
          : name === "create_reading_session"
            ? createKeyed(args)
            : name === "stamp_reading_habit"
              ? stampAlone(args)
              : name === "move_reading_session"
                ? move(args)
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
  assert.equal(db.tables.habit_journal.length, 1, "no create record for this session (stored before it existed) and no day from the form: the Yes stays");
  assert.equal(db.log.some((l) => l.op === "insert" || l.op === "upsert"), false, "nothing is created to find out");
  assert.deepEqual(db.tables.reading_session_discards.map((d) => d.client_key), [KEY], "the key is recorded as discarded (lower case)");

  const again = await R.deleteSessionByClientKey(db, KEY);
  assert.equal(again.ok, true);
  assert.equal(again.removed, null, "repeating it is safe: nothing of the entry is stored");
  assert.equal(again.cleanup.sessionId, 41, "the earlier removal's cleanup comes back, so a lost answer's Notion cleanup is replayed");
  assert.equal(again.cleanup.done, false);
  assert.equal(db.tables.reading_session_discards.length, 1);
  assert.equal(db.tables.books[0].status, "reading", "the database part is not repeated");
  const empty = fakeDb({ books: [BOOK] });
  assert.deepEqual(await R.deleteSessionByClientKey(empty, KEY), { ok: true, removed: null, unfinished: false, cleanup: null }, "a create that never arrived");
  assert.deepEqual(
    empty.log.filter((l) => l.op !== "select").map((l) => `${l.table}:${l.op}`),
    ["remove_reading_session:rpc"],
    "one database call: only the discard is recorded, no session, habit or book write",
  );
  assert.deepEqual(empty.tables.reading_session_discards.map((d) => d.client_key), [KEY]);
  assert.equal((await R.deleteSessionByClientKey(db, "not-a-key")).status, 400);
});

test("deleteSessionByClientKey: a create of that key arriving after the discard is refused, so 'nothing stored' stays true (PR 376 review)", async () => {
  // The create's connection failed in the browser, but the request is still under way on the server. Discard lands
  // first and finds nothing; the create reaches the insert afterwards and is refused by the trigger.
  const db = fakeDb({ books: [BOOK] });
  const r = await R.deleteSessionByClientKey(db, KEY);
  assert.deepEqual(r, { ok: true, removed: null, unfinished: false, cleanup: null });
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
  assert.deepEqual(during, { ok: true, removed: null, unfinished: false, cleanup: null });
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
  // No fallback to separate requests without the function, also for a session with no key (Codex review of PR 376).
  const keylessBefore = fakeDb({ books: [BOOK], reading_sessions: [session({})] }, { noDiscards: true });
  assert.equal((await R.deleteSession(keylessBefore, 41, null)).status, 503);
  assert.equal(keylessBefore.tables.reading_sessions.length, 1);
  const failing = fakeDb({ books: [BOOK], reading_sessions: [session({ client_key: KEY })] }, { discardError: "XX000" });
  assert.equal((await R.deleteSession(failing, 41, null)).status, 500);
  assert.equal(failing.tables.reading_sessions.length, 1);
  // A session with no key (chat, an older create) is removed in the same one call, with no discard recorded.
  const keyless = fakeDb({ books: [BOOK], reading_sessions: [session({})] });
  assert.equal((await R.deleteSession(keyless, 41, null)).ok, true);
  assert.equal(keyless.tables.reading_sessions.length, 0);
  assert.equal(keyless.tables.reading_session_discards.length, 0);
  assert.equal(keyless.log.filter((l) => l.op !== "select").length, 1, "one database call");
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
  assert.equal(db.tables.habit_journal.length, 0, "the create made the habit Yes, and its own record takes it back (Codex T01-R7)");
  // Nothing of the create ran after the removal: a repeat finds nothing to remove and a late retry is refused.
  const repeat = await R.deleteSessionByClientKey(db, KEY);
  assert.equal(repeat.removed, null);
  assert.equal(repeat.cleanup.sessionId, made.session.session_id);
  const late = await R.logSession(db, create({ chapter_through: 12 }));
  assert.equal(late.discarded, true);
  assert.equal(db.tables.books[0].status, "reading");
});

test("removal: a failed database call is never 'nothing stored' (Codex T01-R5)", async () => {
  // The removal's own reads fail while the session exists: the answer is an error and the session stays.
  const db = fakeDb({ books: [BOOK], reading_sessions: [session({ client_key: KEY })] }, { booksReadError: true });
  const r = await R.deleteSessionByClientKey(db, KEY);
  assert.equal(r.ok, false);
  assert.equal(r.status, 500);
  assert.equal(db.tables.reading_sessions.length, 1, "still stored: the form keeps the entry and retries");
  const byId = await R.deleteSession(db, 41, null);
  assert.equal(byId.status, 500, "the same failure on a removal by id is not a 404 either");
  assert.equal(db.tables.reading_sessions.length, 1);
  // A session that is gone with no removal of it on record is a 404, as before.
  assert.equal((await R.deleteSession(fakeDb({ books: [BOOK] }), 99, null)).status, 404);
});

test("lost create answer, then Discard: the Yes the create made goes, from its own record, not from the browser (Codex T01-R7)", async () => {
  const db = fakeDb({ books: [BOOK] });
  const made = await R.logSession(db, create({ date: "2026-11-15" }));
  assert.equal(made.habitCreated, true, "the create made the day's habit row");
  // Its answer is lost: the form never learns habit_created_on, and the Discard goes by key with no day.
  const r = await R.deleteSessionByClientKey(db, KEY);
  assert.equal(r.ok, true);
  assert.equal(r.removed.session_id, made.session.session_id);
  assert.equal(r.habitRemoved, true);
  assert.equal(db.tables.habit_journal.length, 0, "no habit Yes left for a removed session");
  assert.equal(db.tables.reading_habit_provenance.length, 0, "the record goes with the last session of the day");
});

test("two sessions on one day, removed in either order: the last one going takes the Yes back (Codex review of PR 376, round 2)", async () => {
  const K2 = "2b3c4d5e-6f70-4182-93a4-b5c6d7e8f901";
  for (const order of [[KEY, K2], [K2, KEY]]) {
    const db = fakeDb({ books: [BOOK] });
    const a = await R.logSession(db, create({ date: "2026-11-15", chapter_through: 5 }));
    const b = await R.logSession(db, create({ date: "2026-11-15", chapter_through: 6, client_key: K2 }));
    assert.equal(a.habitCreated, true);
    assert.equal(b.habitCreated, false, "the second stamp found the first one's Yes");
    const first = await R.deleteSessionByClientKey(db, order[0]);
    assert.equal(first.habitRemoved, false, "the other session still holds the Yes");
    assert.deepEqual(db.tables.habit_journal, [yes("2026-11-15")]);
    const last = await R.deleteSessionByClientKey(db, order[1]);
    assert.equal(last.habitRemoved, true, `the last one going takes it back (${order[0] === KEY ? "first" : "second"} removed first)`);
    assert.equal(db.tables.habit_journal.length, 0, "no Yes with no session behind it");
    assert.equal(db.tables.reading_habit_provenance.length, 0);
  }
  // Over an explicit No: both gone, the No (and its category) comes back.
  const no = { cycle_date: "2026-11-15", question: HABIT, category: "other", answer: "No" };
  const db = fakeDb({ books: [BOOK], habit_journal: [no] });
  await R.logSession(db, create({ date: "2026-11-15" }));
  await R.logSession(db, create({ date: "2026-11-15", chapter_through: 6, client_key: K2 }));
  await R.deleteSessionByClientKey(db, KEY);
  await R.deleteSessionByClientKey(db, K2);
  assert.deepEqual(db.tables.habit_journal, [no]);
  // A keyless (chat) session sharing the day counts the same way: its stamp is recorded too.
  const mixed = fakeDb({ books: [BOOK] });
  const chat = await R.logSession(mixed, create({ date: "2026-11-15", client_key: null, source: "chat" }));
  await R.logSession(mixed, create({ date: "2026-11-15", chapter_through: 6 }));
  await R.deleteSessionByClientKey(mixed, KEY);
  assert.deepEqual(mixed.tables.habit_journal, [yes("2026-11-15")], "the chat session still holds it");
  await R.deleteSession(mixed, chat.session.session_id, null);
  assert.equal(mixed.tables.habit_journal.length, 0, "the chat session's stamp made the row, and it was the last one");
});

test("a move after a replayed create (no habit day known to the browser) takes the old day's Yes back (Codex review of PR 376, round 2)", async () => {
  const db = fakeDb({ books: [BOOK] });
  const made = await R.logSession(db, create({ date: "2026-11-15" }));
  const replayed = await R.logSession(db, create({ date: "2026-11-15" }));
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.habitCreated, null, "the replay cannot say whether the create made the habit row");
  const moved = await R.updateSession(db, made.session.session_id, upd({ chapter_through: 5, date: "2026-11-13", habit_created_on: null }));
  assert.equal(moved.ok, true);
  assert.equal(moved.session.session_date, "2026-11-13");
  assert.deepEqual(db.tables.habit_journal.map((h) => h.cycle_date), ["2026-11-13"], "the old day's Yes went with the session");
  assert.equal(moved.habitCreatedOn, "2026-11-13");
  assert.deepEqual(db.log.filter((l) => l.op === "rpc" && l.table === "move_reading_session").length, 1, "the move is one database call");
  // Removing it afterwards takes the new day's Yes back too, still from the habit row's own record.
  const r = await R.deleteSessionByClientKey(db, KEY);
  assert.equal(r.habitRemoved, true);
  assert.equal(db.tables.habit_journal.length, 0);
  // An answer given on the old day after the move is not touched by anything later.
  const other = fakeDb({ books: [BOOK], reading_sessions: [session({})], habit_journal: [yes("2026-11-15")] });
  await R.updateSession(other, 41, upd({ date: "2026-11-14", habit_created_on: null }));
  assert.ok(other.tables.habit_journal.some((h) => h.cycle_date === "2026-11-15"), "a Yes reading did not make stays (no record, no day from the form)");
});

test("a move: the habit part failing rolls the whole move back; without the SQL it is refused (503), never done in steps", async () => {
  const failing = fakeDb({ books: [BOOK], reading_sessions: [session({})] }, { settleError: "P0001" });
  const r = await R.updateSession(failing, 41, upd({ date: "2026-11-13" }));
  assert.equal(r.ok, false);
  assert.equal(r.status, 500, "an error the form retries");
  assert.equal(failing.tables.reading_sessions[0].session_date, "2026-11-15", "the session did not move");
  assert.equal(failing.tables.habit_journal.length, 0, "and the new day got no Yes");
  const before = fakeDb({ books: [BOOK], reading_sessions: [session({})], habit_journal: [yes("2026-11-15")] }, { noDiscards: true });
  const refused = await R.updateSession(before, 41, upd({ date: "2026-11-13", habit_created_on: "2026-11-15" }));
  assert.equal(refused.status, 503);
  assert.match(refused.error, /reading_session_discards\.sql/);
  assert.equal(before.tables.reading_sessions[0].session_date, "2026-11-15");
  assert.deepEqual(before.tables.habit_journal, [yes("2026-11-15")]);
  // An edit that does not move the session needs no function.
  assert.equal((await R.updateSession(before, 41, upd({ chapter_through: 5 }))).ok, true);
  // A session gone by the time the move runs is a 404; a Kindle one a 409.
  const gone = fakeDb({ books: [BOOK], reading_sessions: [session({})] });
  const realRpc = gone.rpc;
  gone.rpc = async (name, args) => {
    if (name === "move_reading_session") gone.tables.reading_sessions = [];
    return realRpc(name, args);
  };
  assert.equal((await R.updateSession(gone, 41, upd({ date: "2026-11-13" }))).status, 404);
});

test("an edit whose answer was lost after it committed: the retry leaves no finish behind (Codex review of PR 376, round 4)", async () => {
  // The answer of the edit's transaction is lost on the way back (it committed); the route answers an error and the
  // form sends the same values again.
  const loseNextEditAnswer = (db) => {
    const realRpc = db.rpc;
    let lose = true;
    db.rpc = async (name, args) => {
      const out = await realRpc(name, args);
      if (name === "move_reading_session" && lose) {
        lose = false;
        return { data: null, error: { code: "08006", message: "connection lost" } };
      }
      return out;
    };
  };
  const OTHER = { ...BOOK, book_id: 8, slug: "other-book", habit_name: null };
  // A finishing session moved to another book: the first book goes back to reading in the same transaction.
  const finished = { ...BOOK, status: "finished", finished_on: "2026-11-15" };
  const toOther = fakeDb({ books: [finished, OTHER], reading_sessions: [session({ chapter_through: 12 })] });
  loseNextEditAnswer(toOther);
  const lost = await R.updateSession(toOther, 41, upd({ book: "other-book", chapter_through: 5 }));
  assert.equal(lost.ok, false, "the route answers an error");
  assert.equal(toOther.tables.books[0].status, "reading", "but the finish went back with the move itself");
  const retry = await R.updateSession(toOther, 41, upd({ book: "other-book", chapter_through: 5 }));
  assert.equal(retry.ok, true);
  assert.equal(toOther.tables.books[0].status, "reading");
  assert.equal(toOther.tables.books[0].finished_on, null);
  // A finishing session moved to another day of its book: the finish day follows in the same transaction.
  const day = fakeDb({ books: [finished], reading_sessions: [session({ chapter_through: 12 })] });
  loseNextEditAnswer(day);
  assert.equal((await R.updateSession(day, 41, upd({ chapter_through: 12, date: "2026-11-14" }))).ok, false);
  assert.equal(day.tables.books[0].finished_on, "2026-11-14");
  assert.equal((await R.updateSession(day, 41, upd({ chapter_through: 12, date: "2026-11-14" }))).ok, true);
  assert.equal(day.tables.books[0].finished_on, "2026-11-14");
  // An edit below the last chapter on the same day: the finish it caused went back with the edit.
  const below = fakeDb({ books: [finished], reading_sessions: [session({ chapter_through: 12 })] });
  loseNextEditAnswer(below);
  assert.equal((await R.updateSession(below, 41, upd({ chapter_through: 11 }))).ok, false);
  assert.equal(below.tables.books[0].status, "reading");
  const again = await R.updateSession(below, 41, upd({ chapter_through: 11 }));
  assert.equal(again.ok, true);
  assert.equal(again.book.status, "reading", "the answer reads the book as it is");
  assert.equal(below.log.filter((l) => l.table === "books" && l.op === "update").length, 0, "no finish request outside the transaction");
});

test("an edit that keeps the day and the book has no habit part, and is one database call", async () => {
  const db = fakeDb({ books: [BOOK], reading_sessions: [session({})], habit_journal: [yes("2026-11-15")] });
  const r = await R.updateSession(db, 41, upd({ chapter_through: 6, habit_created_on: "2026-11-15" }));
  assert.equal(r.ok, true);
  assert.equal(r.habitMarked, false);
  assert.equal(r.habitCreatedOn, "2026-11-15", "the habit day stays as it was");
  assert.deepEqual(db.tables.habit_journal, [yes("2026-11-15")]);
  assert.equal(db.log.filter((l) => l.table === "move_reading_session").length, 1);
});

test("a removal whose habit part fails rolls back whole and is reported, never 'removed' with a Yes left (Codex review of PR 376, round 2)", async () => {
  const db = fakeDb({ books: [BOOK] }, { settleError: "P0001" });
  await R.logSession(db, create({ date: "2026-11-15" }));
  for (const r of [await R.deleteSessionByClientKey(db, KEY), await R.deleteSession(db, db.tables.reading_sessions[0].session_id, null)]) {
    assert.equal(r.ok, false);
    assert.equal(r.status, 500, "the form keeps the entry and retries");
    assert.equal(r.gone, undefined, "never read as 'already removed'");
  }
  assert.equal(db.tables.reading_sessions.length, 1, "the session is still stored");
  assert.equal(db.tables.reading_session_discards.length, 0, "no discard recorded");
  assert.equal(db.tables.reading_session_removals.length, 0, "no removal on record");
  assert.deepEqual(db.tables.habit_journal, [yes("2026-11-15")]);
});

test("deleteSession: only the database's own 'no such session' is gone; a missing book (session still stored) is not", async () => {
  const gone = await R.deleteSession(fakeDb({ books: [BOOK] }), 99, null);
  assert.equal(gone.status, 404);
  assert.equal(gone.gone, true);
  const bookless = fakeDb({ books: [], reading_sessions: [session({})] });
  const r = await R.deleteSession(bookless, 41, null);
  assert.equal(r.status, 404);
  assert.equal(r.gone, undefined, "the route sends no session_gone code for it");
  const route = read("app/api/reading/sessions/[id]/route.ts");
  assert.match(route, /r\.gone \? \{ error: r\.error, code: SESSION_GONE_CODE \}/, "the code goes only with gone");
  assert.doesNotMatch(route, /r\.status === 404 \? \{ error: r\.error, code: SESSION_GONE_CODE/);
});

test("lost create answer, then an independent answer to the habit, then Discard: that answer is kept (Codex T01-R7)", async () => {
  const db = fakeDb({ books: [BOOK] });
  await R.logSession(db, create({ date: "2026-11-15" }));
  // Riley answers the habit elsewhere (/check-in): a new write to the row, even with the same value.
  await db.from("habit_journal").upsert({ cycle_date: "2026-11-15", question: HABIT, category: "learning", answer: "Yes" });
  const r = await R.deleteSessionByClientKey(db, KEY);
  assert.equal(r.ok, true);
  assert.equal(r.habitRemoved, false);
  assert.deepEqual(db.tables.habit_journal, [yes("2026-11-15")], "the independent answer stays");
});

test("lost create answer over an explicit No, then Discard: the No comes back (Codex T01-R7)", async () => {
  const no = { cycle_date: "2026-11-15", question: HABIT, category: "other", answer: "No" };
  const db = fakeDb({ books: [BOOK], habit_journal: [no] });
  const made = await R.logSession(db, create({ date: "2026-11-15" }));
  assert.equal(made.habitCreated, false, "the row existed");
  assert.equal(db.tables.habit_journal[0].answer, "Yes");
  const r = await R.deleteSessionByClientKey(db, KEY);
  assert.equal(r.habitRemoved, true, "the Yes the create wrote is taken back");
  assert.deepEqual(db.tables.habit_journal, [no], "the earlier answer and category again");
});

test("removal RPC adapter: only an explicit outcome counts; null, {} and malformed answers are 'not confirmed', never 'nothing stored' (Codex T01-R8)", async () => {
  const rowsOk = { session: session({ client_key: KEY }), book: BOOK };
  for (const data of [
    null,
    {},
    [],
    "removed",
    { removed: null, removal: null },
    { removed: "false", removal: null },
    { removed: false }, // no removal key at all
    { removed: false, removal: { session_id: "x" } }, // a malformed cleanup row
    { removed: true, removal: null }, // removed with no session or book
    { removed: true, session: { session_id: null }, book: BOOK, removal: null },
    { removed: true, session: rowsOk.session, book: {}, removal: null },
  ]) {
    assert.deepEqual(R.removalOutcomeOf(data), { kind: "failed", status: 500, error: "The removal was not confirmed. Try again." }, JSON.stringify(data));
    const db = { rpc: async () => ({ data, error: null }), from: () => { throw new Error("no table read"); } };
    const byKey = await R.deleteSessionByClientKey(db, KEY);
    assert.equal(byKey.ok, false, `by key: ${JSON.stringify(data)}`);
    assert.equal(byKey.status, 500);
    const byId = await R.deleteSession(db, 41, null);
    assert.equal(byId.ok, false, `by id: ${JSON.stringify(data)}`);
    assert.equal(byId.status, 500);
  }
  assert.deepEqual(R.removalOutcomeOf({ removed: false, removal: null }), { kind: "absent", cleanup: null }, "an explicit 'nothing here'");
  assert.equal(R.removalOutcomeOf({ removed: true, ...rowsOk, unfinished: false, habit_removed: false, removal: null }).kind, "removed");
});

test("removal whose answer was lost: the database part committed whole, the retry replays only the Notion cleanup (PR 376 review)", async () => {
  // The removal committed (session gone, finish and habit Yes taken back, cleanup row written), but its answer never
  // reached the route, so the Notion entry was not trashed. The retry finds the session gone and gets that row back.
  const finished = { ...BOOK, status: "finished", finished_on: "2026-11-15" };
  const db = fakeDb({ books: [finished], reading_sessions: [session({ chapter_from: 10, chapter_through: 12, notion_block_id: "blk-1" })], habit_journal: [yes("2026-11-15")] });
  const first = await R.deleteSession(db, 41, "2026-11-15");
  assert.equal(first.ok, true);
  assert.equal(db.tables.books[0].status, "reading", "the finish is taken back in the same transaction as the delete");
  assert.equal(db.tables.habit_journal.length, 0);
  assert.equal(first.cleanup.notionBlockId, "blk-1", "the Notion entry still to trash is written down with it");
  const retry = await R.deleteSession(db, 41, "2026-11-15");
  assert.equal(retry.ok, true, "not a 404: the route replays the cleanup");
  assert.equal(retry.removed, null);
  assert.equal(retry.unfinished, true);
  assert.deepEqual([retry.cleanup.sessionId, retry.cleanup.notionBlockId, retry.cleanup.done], [41, "blk-1", false]);
  assert.equal(db.log.filter((l) => l.op === "rpc").length, 2, "the retry is one read-and-answer call: no second delete, finish or habit write");
  // Once the route has trashed the entry it marks the row done; a later retry replays nothing.
  await R.markRemovalMirrored(db, 41, "blk-1");
  assert.equal((await R.deleteSession(db, 41, null)).cleanup.done, true);
});

/* ---------- Notion cleanup completion races (Codex T01-R9) ---------- */

/**
 * reading-removal.ts with a controllable Notion: `trash(id)` and `progress(chaptersDone)` answer what the test says;
 * `written` lists the progress lines written (chapters done). The book's overview is `notion.overview()` (read from
 * the database in the real module), so a test can change it between the cleanup's read and its write.
 */
function removalWithNotion() {
  const notion = {
    trashed: [],
    written: [],
    updated: [],
    trash: async () => true,
    progress: async () => true,
    overview: async () => ({ chaptersDone: 3, sessions: [] }),
    found: async () => [],
    mirrored: [],
    mirror: async () => "blk-new",
  };
  const RR = loadTs("lib/reading-removal.ts", {
    "./reading": { ...R, getOverview: async () => notion.overview() },
    "./reading-notion": {
      removeMirroredBlock: async (id) => {
        notion.trashed.push(id);
        return notion.trash(id);
      },
      mirrorProgress: async (_book, chaptersDone) => {
        notion.written.push(chaptersDone);
        return notion.progress(chaptersDone);
      },
      findSessionBlocksByMarker: async (pageId, marker) => notion.found(pageId, marker),
      mirrorSession: async (book, s, marker) => {
        notion.mirrored.push({ book: book.book_id, session: s.session_id, marker });
        return notion.mirror(book, s, marker);
      },
      notionMirrorEnabled: () => true,
      updateMirroredSession: async (s) => {
        notion.updated.push(s.notion_block_id);
        return true;
      },
    },
  });
  return { RR, notion };
}
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const removalRow = (over = {}) => ({ session_id: 41, client_key: KEY, book_id: 7, session_date: "2026-11-15", notion_block_id: null, unfinished: false, removed_at: "2026-11-15T21:00:00Z", mirror_done_at: null, ...over });
const cleanupOf = (row) => ({ sessionId: row.session_id, bookId: row.book_id, sessionDate: row.session_date, notionBlockId: row.notion_block_id, unfinished: false, done: false });
const PAGED_BOOK = { ...BOOK, notion_page_id: "page-1" };
const answerFor = () => ({ book: PAGED_BOOK, bookUnread: false, overview: { chaptersDone: 3, sessions: [] }, removedId: null, owed: true });

test("T01-R9: a removal cleanup that saw no entry does not close a late entry recorded while it ran, whose trash failed", async () => {
  const { RR, notion } = removalWithNotion();
  const db = fakeDb({ books: [PAGED_BOOK], reading_session_removals: [removalRow()] });
  // The removal's cleanup read its row with no Notion entry and is now waiting on the progress rewrite.
  const gate = deferred();
  notion.progress = () => gate.promise;
  const stale = RR.runRemovalCleanup(db, { ok: true, removed: null, unfinished: false, cleanup: cleanupOf(removalRow()) }, answerFor());
  await new Promise((r) => setImmediate(r));
  // Meanwhile the create's callback records its late entry (reopening the row), but Notion refuses the trash.
  notion.trash = async (id) => id !== "blk-late";
  const late = await RR.trashLateBlock(db, 41, "blk-late", async () => true);
  assert.deepEqual(late, { recorded: true, trashed: false, progressDone: true, complete: false });
  // The stale cleanup's progress rewrite now succeeds: it closes only the work it did (no entry), not the late one.
  gate.resolve(true);
  await stale;
  const row = db.tables.reading_session_removals[0];
  assert.equal(row.notion_block_id, "blk-late", "the late entry stays recorded");
  assert.equal(row.mirror_done_at, null, "still owed: the sweep finds it");
  // The sweep's run reads the row with the late entry, trashes it and closes it.
  notion.trash = async () => true;
  notion.progress = async () => true;
  await RR.runRemovalCleanup(db, { ok: true, removed: null, unfinished: false, cleanup: cleanupOf(row) }, answerFor());
  assert.ok(notion.trashed.filter((id) => id === "blk-late").length >= 2, "the sweep trashed the late entry again");
  assert.notEqual(db.tables.reading_session_removals[0].mirror_done_at, null, "closed once its own work is done");
});

test("T01-R9: a stale cleanup that finishes BEFORE the late entry is recorded is reopened by it", async () => {
  const { RR, notion } = removalWithNotion();
  const db = fakeDb({ books: [PAGED_BOOK], reading_session_removals: [removalRow()] });
  await RR.runRemovalCleanup(db, { ok: true, removed: null, unfinished: false, cleanup: cleanupOf(removalRow()) }, answerFor());
  assert.notEqual(db.tables.reading_session_removals[0].mirror_done_at, null, "no entry and the progress rewritten: done");
  notion.trash = async () => false;
  await RR.trashLateBlock(db, 41, "blk-late", async () => true);
  assert.equal(db.tables.reading_session_removals[0].mirror_done_at, null, "the late entry reopens the row");
  assert.equal(db.tables.reading_session_removals[0].notion_block_id, "blk-late");
});

test("T01-R9: a late entry trashed but whose progress rewrite failed stays owed; it closes once both succeed", async () => {
  const { RR, notion } = removalWithNotion();
  // The removal's own cleanup had already closed the row (it saw no entry).
  const db = fakeDb({ books: [PAGED_BOOK], reading_session_removals: [removalRow({ mirror_done_at: "2026-11-15T21:00:05Z" })] });
  const failedProgress = await RR.trashLateBlock(db, 41, "blk-late", async () => false);
  assert.deepEqual(failedProgress, { recorded: true, trashed: true, progressDone: false, complete: false });
  assert.equal(db.tables.reading_session_removals[0].mirror_done_at, null, "not closed after the trash alone");
  // A progress rewrite that throws counts as failed too.
  const thrown = await RR.trashLateBlock(db, 41, "blk-late", async () => { throw new Error("notion down"); });
  assert.equal(thrown.complete, false);
  assert.equal(db.tables.reading_session_removals[0].mirror_done_at, null);
  // The sweep later completes both steps and closes it.
  notion.progress = async () => true;
  await RR.runRemovalCleanup(db, { ok: true, removed: null, unfinished: false, cleanup: cleanupOf(db.tables.reading_session_removals[0]) }, answerFor());
  assert.notEqual(db.tables.reading_session_removals[0].mirror_done_at, null);
  // And a late entry whose trash and progress both succeed closes at once.
  const db2 = fakeDb({ books: [PAGED_BOOK], reading_session_removals: [removalRow()] });
  const ok = await RR.trashLateBlock(db2, 41, "blk-late", async () => true);
  assert.equal(ok.complete, true);
  assert.notEqual(db2.tables.reading_session_removals[0].mirror_done_at, null);
});

test("T01-R9: markRemovalMirrored closes only the entry the caller handled", async () => {
  const db = fakeDb({ reading_session_removals: [removalRow({ notion_block_id: "blk-new" })] });
  await R.markRemovalMirrored(db, 41, null);
  assert.equal(db.tables.reading_session_removals[0].mirror_done_at, null, "a run that saw no entry leaves a recorded one open");
  await R.markRemovalMirrored(db, 41, "blk-old");
  assert.equal(db.tables.reading_session_removals[0].mirror_done_at, null, "nor does a run that handled another entry");
  await R.markRemovalMirrored(db, 41, "blk-new");
  assert.notEqual(db.tables.reading_session_removals[0].mirror_done_at, null);
});

test("two removals of one book whose cleanups finish out of order: the older line written last is written again from the database, and both close (Codex review of PR 376, rounds 4 and 5)", async () => {
  const { RR, notion } = removalWithNotion();
  const db = fakeDb({
    books: [PAGED_BOOK],
    reading_session_removals: [removalRow({ session_id: 41 }), removalRow({ session_id: 42, client_key: null })],
  });
  // The database as it is: after the first removal 5 chapters are done; after the second, 3.
  let chapters = 5;
  notion.overview = async () => ({ chaptersDone: chapters, sessions: [] });
  // The first removal's cleanup read "5" and its Notion write is slow.
  const gate = deferred();
  notion.progress = (n) => (n === 5 ? gate.promise : Promise.resolve(true));
  const first = RR.runRemovalCleanup(db, { ok: true, removed: null, unfinished: false, cleanup: cleanupOf(removalRow({ session_id: 41 })) }, answerFor());
  await new Promise((r) => setImmediate(r));
  // The second removal commits and its cleanup writes "3", checks it and closes its row.
  chapters = 3;
  await RR.runRemovalCleanup(db, { ok: true, removed: null, unfinished: false, cleanup: cleanupOf(removalRow({ session_id: 42 })) }, answerFor());
  const byId = (id) => db.tables.reading_session_removals.find((x) => x.session_id === id);
  assert.notEqual(byId(42).mirror_done_at, null, "its line matched the database after its write: done");
  assert.equal(db.tables.reading_progress_owed.length, 1, "only the slow writer still owes the line");
  // The first one's older line now lands last. It reads the book again, sees it changed, and writes the current line.
  gate.resolve(true);
  await first;
  assert.deepEqual(notion.written, [5, 3, 3], "the current line is written over the older one");
  assert.notEqual(byId(41).mirror_done_at, null);
  assert.equal(db.tables.reading_progress_owed.length, 0, "every writer cleared its own obligation");
});

test("overlapping workers on one cleanup row: one closes it, the other's line may be stale and its process ends before checking; its obligation survives and the sweep writes the current line (Codex review of PR 376, round 5)", async () => {
  const { RR, notion } = removalWithNotion();
  const db = fakeDb({ books: [PAGED_BOOK], reading_session_removals: [removalRow()] });
  let chapters = 5;
  notion.overview = async () => ({ chaptersDone: chapters, sessions: [] });
  // Worker A (the removal's own cleanup) read "5"; its write is slow.
  const gate = deferred();
  notion.progress = (n) => (n === 5 ? gate.promise : Promise.resolve(true));
  const a = RR.runRemovalCleanup(db, { ok: true, removed: null, unfinished: false, cleanup: cleanupOf(removalRow()) }, answerFor());
  await new Promise((r) => setImmediate(r));
  // The book changes, and worker B (the sweep, on the same row) writes "3", checks it and closes the row.
  chapters = 3;
  await RR.runRemovalCleanup(db, { ok: true, removed: null, unfinished: false, cleanup: cleanupOf(removalRow()) }, answerFor());
  assert.notEqual(db.tables.reading_session_removals[0].mirror_done_at, null, "B closed the row");
  // A's stale "5" lands last, and A can no longer check it: every later read fails (its process is going away).
  notion.overview = async () => {
    throw new Error("process gone");
  };
  gate.resolve(true);
  await a;
  assert.deepEqual(notion.written, [5, 3]);
  assert.equal(db.tables.reading_progress_owed.length, 1, "A's own obligation is still stored: B could not clear it");
  // Later the sweep finds the obligation (older than two minutes), writes the line from the database and clears it.
  notion.overview = async () => ({ chaptersDone: chapters, sessions: [] });
  for (const r of db.tables.reading_progress_owed) r.next_try_at = new Date(Date.now() - 60_000).toISOString();
  await RR.sweepPendingRemovals(db);
  assert.deepEqual(notion.written, [5, 3, 3], "the current line is written last");
  assert.equal(db.tables.reading_progress_owed.length, 0);
});

/** The fake database with one table that fails every call with `code`. */
function failingTable(db, table, code) {
  return {
    ...db,
    from(t) {
      if (t !== table) return db.from(t);
      const err = { data: null, error: { code, message: "refused" } };
      const b = new Proxy({}, { get: (_o, k) => (k === "then" ? (res, rej) => Promise.resolve(err).then(res, rej) : () => b) });
      return b;
    },
  };
}

test("a progress write that cannot be checked is owed durably, with no cleanup row (an edit's or a create's own write; Codex review of PR 376, round 5)", async () => {
  const { RR, notion } = removalWithNotion();
  const db = fakeDb({ books: [PAGED_BOOK] });
  // The state changes during every write, so the line is never checked in this run.
  let flip = 5;
  notion.overview = async () => ({ chaptersDone: (flip = flip === 5 ? 4 : 5), sessions: [] });
  assert.equal(await RR.rewriteProgressNow(db, PAGED_BOOK.book_id), true, "owed durably counts as handled");
  assert.equal(db.tables.reading_progress_owed.length, 1, "the obligation stays for the sweep");
  // Without the table (the SQL file not applied yet) the same write reports that nothing holds it.
  assert.equal(await RR.rewriteProgressNow(failingTable(fakeDb({ books: [PAGED_BOOK] }), "reading_progress_owed", "PGRST205"), PAGED_BOOK.book_id), false);
});

/* ---------- Notion entries whose block id may not be stored (pds.reading_mirror_claims, round 5) ---------- */

const PAST = "2026-11-15T20:00:00.000Z";
const claimRow = (over = {}) => ({ claim_id: "c-1", session_id: 41, book_id: 7, block_id: null, replaces_block_id: null, claimed_at: PAST, attempts: 0, next_try_at: PAST, ...over });
const claimOf = (row) => ({ claimId: row.claim_id, sessionId: row.session_id, bookId: row.book_id, blockId: row.block_id, replaces: row.replaces_block_id, claimedAt: row.claimed_at, attempts: row.attempts });
const AFTER_CLAIM = Date.parse("2026-11-15T20:05:00.000Z");

test("a late entry that could be neither recorded nor trashed keeps its claim, and a later sweep (nothing in memory) trashes it (Codex review of PR 376, round 5)", async () => {
  const { RR, notion } = removalWithNotion();
  // The session is gone and its removal row closed; the create's callback holds a claim with the entry's block id.
  const db = fakeDb({
    books: [PAGED_BOOK],
    reading_session_removals: [removalRow({ mirror_done_at: "2026-11-15T21:00:05Z" })],
    reading_mirror_claims: [claimRow({ block_id: "blk-late" })],
  });
  // Recording the entry in the removal row fails, and so does every trash.
  notion.trash = async () => false;
  const late = await RR.trashLateBlock(failingTable(db, "reading_session_removals", "57014"), 41, "blk-late", async () => true);
  assert.deepEqual([late.recorded, late.trashed], [false, false]);
  assert.equal(db.tables.reading_mirror_claims.length, 1, "nothing confirmed: the claim (with the block id) stays");
  // A fresh module stands for a new process.
  const { RR: later, notion: n2 } = removalWithNotion();
  assert.equal(await later.settleMirrorClaim(db, claimOf(db.tables.reading_mirror_claims[0]), AFTER_CLAIM), true);
  assert.deepEqual(n2.trashed, ["blk-late"], "the session is gone, so its entry is trashed");
  assert.equal(db.tables.reading_mirror_claims.length, 0);
});

test("a claim whose block id was never stored is matched by its own marker: trashed for a removed session, adopted by a live one, dropped when no entry shows up (Codex review of PR 376, round 6)", async () => {
  const { RR, notion } = removalWithNotion();
  // Removed session: only the entry carrying this claim's marker is looked at; an entry of another session with the
  // same text has another marker and is never found.
  const gone = fakeDb({ books: [PAGED_BOOK], reading_sessions: [{ session_id: 50, book_id: 7, notion_block_id: "blk-other" }], reading_mirror_claims: [claimRow()] });
  notion.found = async (pageId, marker) => (pageId === "page-1" && marker === "c-1" ? ["blk-late"] : []);
  assert.equal(await RR.settleMirrorClaim(gone, claimOf(claimRow()), AFTER_CLAIM), true);
  assert.deepEqual(notion.trashed, ["blk-late"]);
  assert.equal(gone.tables.reading_mirror_claims.length, 0);
  // An older claim of a removed session with identical text cannot reach a newer session's entry: its marker differs.
  const newer = fakeDb({ books: [PAGED_BOOK], reading_sessions: [{ session_id: 42, book_id: 7, notion_block_id: null }], reading_mirror_claims: [claimRow()] });
  notion.found = async (_pageId, marker) => (marker === "c-2" ? ["blk-newer"] : []);
  notion.trashed.length = 0;
  assert.equal(await RR.settleMirrorClaim(newer, claimOf(claimRow()), AFTER_CLAIM), false, "nothing of its own found yet");
  assert.deepEqual(notion.trashed, [], "the newer session's entry is not touched");
  // Live session without an entry: the found entry becomes its entry and is brought up to date.
  const live = fakeDb({ books: [PAGED_BOOK], reading_sessions: [{ session_id: 41, book_id: 7, notion_block_id: null, session_date: "2026-11-15" }], reading_mirror_claims: [claimRow()] });
  notion.found = async () => ["blk-new"];
  assert.equal(await RR.settleMirrorClaim(live, claimOf(claimRow()), AFTER_CLAIM), true);
  assert.equal(live.tables.reading_sessions[0].notion_block_id, "blk-new");
  assert.deepEqual(notion.updated, ["blk-new"]);
  assert.deepEqual(notion.trashed, [], "a live session's entry is kept");
  // Nothing found: kept, and dropped an hour after the claim (no entry was created).
  const none = fakeDb({ books: [PAGED_BOOK], reading_mirror_claims: [claimRow()] });
  notion.found = async () => [];
  assert.equal(await RR.settleMirrorClaim(none, claimOf(claimRow()), AFTER_CLAIM + 30 * 60_000), false);
  assert.equal(none.tables.reading_mirror_claims.length, 1);
  assert.equal(await RR.settleMirrorClaim(none, claimOf(claimRow()), AFTER_CLAIM + 61 * 60_000), true);
  assert.equal(none.tables.reading_mirror_claims.length, 0);
  // The page could not be read: the claim stays, however old.
  const unread = fakeDb({ books: [PAGED_BOOK], reading_mirror_claims: [claimRow()] });
  notion.found = async () => null;
  assert.equal(await RR.settleMirrorClaim(unread, claimOf(claimRow()), AFTER_CLAIM + 24 * 60 * 60_000), false);
  assert.equal(unread.tables.reading_mirror_claims.length, 1);
});

test("a claim settles against its session: the session's own entry drops it, another entry makes this one a duplicate to trash", async () => {
  const { RR, notion } = removalWithNotion();
  const own = fakeDb({ books: [PAGED_BOOK], reading_sessions: [{ session_id: 41, book_id: 7, notion_block_id: "blk-1" }], reading_mirror_claims: [claimRow({ block_id: "blk-1" })] });
  assert.equal(await RR.settleMirrorClaim(own, claimOf(claimRow({ block_id: "blk-1" })), AFTER_CLAIM), true);
  assert.deepEqual(notion.trashed, []);
  const dup = fakeDb({ books: [PAGED_BOOK], reading_sessions: [{ session_id: 41, book_id: 7, notion_block_id: "blk-2" }], reading_mirror_claims: [claimRow({ block_id: "blk-1" })] });
  notion.trash = async () => false;
  assert.equal(await RR.settleMirrorClaim(dup, claimOf(claimRow({ block_id: "blk-1" })), AFTER_CLAIM), false, "a failed trash keeps the claim");
  assert.equal(dup.tables.reading_mirror_claims.length, 1);
  notion.trash = async () => true;
  assert.equal(await RR.settleMirrorClaim(dup, claimOf(claimRow({ block_id: "blk-1" })), AFTER_CLAIM), true);
  assert.equal(dup.tables.reading_sessions[0].notion_block_id, "blk-2", "the session's own entry stays");
});

test("an entry carries its claim's marker, read back from either rich-text form; the session routes write every new entry through placeEntry, claim first (Codex review of PR 376, round 6)", () => {
  const marked = (link) => ({ type: "quote", quote: { rich_text: [{ type: "text", text: { content: "2030-01-02 · ch 1–2" } }, link] } });
  assert.equal(N.entryMarker(marked({ type: "text", text: { content: "​", link: { url: "https://onyx.invalid/reading-entry/abc-1" } } })), "abc-1");
  assert.equal(N.entryMarker(marked({ type: "text", plain_text: "​", href: "https://onyx.invalid/reading-entry/abc-2" })), "abc-2");
  assert.equal(N.entryMarker(marked({ type: "text", text: { content: "x", link: { url: "https://example.com/other" } } })), null);
  assert.equal(N.entryMarker({ type: "quote", quote: { rich_text: [] } }), null);
  const readSrc = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
  const post = readSrc("app/api/reading/sessions/route.ts");
  const patch = readSrc("app/api/reading/sessions/[id]/route.ts");
  assert.match(post, /placeEntry\(supabase, result\.book, result\.session, null\)/);
  assert.match(post, /placeEntry\(supabase, other as Book, placed\.row, null\)/, "the create's catch-up after a move is claimed too");
  assert.match(patch, /placeEntry\(supabase, r\.book, r\.session, old\)/, "a move's new entry is claimed and replaces the old one");
  for (const src of [post, patch]) assert.doesNotMatch(src, /mirrorSession\(/, "no entry is written outside placeEntry");
  const lib = readSrc("lib/reading-removal.ts");
  const fn = lib.slice(lib.indexOf("export async function placeEntry"), lib.indexOf("export async function discardEntry"));
  assert.ok(fn.indexOf("claimMirror(") > 0 && fn.indexOf("mirrorSession(") > fn.indexOf("claimMirror("), "the claim is stored before the entry");
  assert.match(fn, /if \(claim === null\) return \{ kind: "none" \}/, "no claim stored, no entry");
  assert.match(fn, /mirrorSession\(book, session, own\?\.claimId \?\? null\)/, "the entry carries the claim's id");
  assert.doesNotMatch(lib, /GIVE_UP/, "nothing is given up for its age");
});

const PAGED_BOOK2 = { ...BOOK, book_id: 8, slug: "other-book", notion_page_id: "page-2" };
const movedSession = (over = {}) => ({ session_id: 41, book_id: 8, session_date: "2026-11-15", notion_block_id: "blk-old", chapter_through: 2, ...over });

test("a move writes its new entry under a claim and attaches it only over the old one; the old entry is trashed (Codex review of PR 376, round 6)", async () => {
  const { RR, notion } = removalWithNotion();
  const db = fakeDb({ books: [PAGED_BOOK, PAGED_BOOK2], reading_sessions: [movedSession()] });
  notion.mirror = async () => "blk-moved";
  const placed = await RR.placeEntry(db, PAGED_BOOK2, movedSession(), "blk-old");
  assert.equal(placed.kind, "attached");
  assert.equal(db.tables.reading_sessions[0].notion_block_id, "blk-moved");
  assert.deepEqual(notion.trashed, ["blk-old"]);
  assert.equal(notion.mirrored[0].book, 8);
  assert.match(String(notion.mirrored[0].marker), /^[0-9a-f-]{36}$/, "the entry carries its claim's random id");
  assert.equal(db.tables.reading_mirror_claims.length, 0, "settled: the claim goes");
});

test("a move's new entry for a session removed meanwhile is reported gone and trashed by its claim; a failed attach leaves the claim for the sweep (Codex review of PR 376, round 6)", async () => {
  const { RR, notion } = removalWithNotion();
  // Removed while the new entry was being written.
  const db = fakeDb({ books: [PAGED_BOOK, PAGED_BOOK2], reading_sessions: [] });
  notion.mirror = async () => "blk-moved";
  notion.trash = async () => false;
  const placed = await RR.placeEntry(db, PAGED_BOOK2, movedSession(), "blk-old");
  assert.equal(placed.kind, "gone");
  assert.equal(await RR.discardEntry(db, placed.blockId, placed.claimId), false, "Notion refuses the trash");
  assert.equal(db.tables.reading_mirror_claims.length, 1, "the claim (with the block id) stays");
  assert.equal(db.tables.reading_mirror_claims[0].block_id, "blk-moved");
  notion.trash = async () => true;
  const { RR: later, notion: n2 } = removalWithNotion();
  const row = db.tables.reading_mirror_claims[0];
  assert.equal(await later.settleMirrorClaim(db, claimOf(row), Date.now()), true);
  assert.deepEqual(n2.trashed, ["blk-moved"]);
  // A database failure on the attach: not known whether it attached, so the claim stays and the sweep adopts it.
  const db2 = fakeDb({ books: [PAGED_BOOK, PAGED_BOOK2], reading_sessions: [movedSession()] });
  const unknown = await RR.placeEntry(failingTable(db2, "reading_sessions", "57014"), PAGED_BOOK2, movedSession(), "blk-old");
  assert.equal(unknown.kind, "unknown");
  const claim = db2.tables.reading_mirror_claims[0];
  assert.deepEqual([claim.block_id, claim.replaces_block_id], ["blk-moved", "blk-old"]);
  n2.trashed.length = 0;
  assert.equal(await later.settleMirrorClaim(db2, claimOf(claim), Date.now()), true);
  assert.equal(db2.tables.reading_sessions[0].notion_block_id, "blk-moved", "adopted over the entry it replaces");
  assert.deepEqual(n2.trashed, ["blk-old"]);
});

test("two writers of one session's entry: only one attaches, the other trashes its own (Codex review of PR 376, round 6)", async () => {
  const { RR, notion } = removalWithNotion();
  const db = fakeDb({ books: [PAGED_BOOK2], reading_sessions: [movedSession({ notion_block_id: null })] });
  let n = 0;
  notion.mirror = async () => `blk-${++n}`;
  const a = await RR.placeEntry(db, PAGED_BOOK2, movedSession({ notion_block_id: null }), null);
  const b = await RR.placeEntry(db, PAGED_BOOK2, movedSession({ notion_block_id: null }), null);
  assert.deepEqual([a.kind, b.kind], ["attached", "surplus"]);
  assert.equal(db.tables.reading_sessions[0].notion_block_id, "blk-1");
  assert.deepEqual(notion.trashed, ["blk-2"]);
  assert.equal(db.tables.reading_mirror_claims.length, 0);
});

test("a move whose new page got no entry retires the old one under a claim, so a failed trash is finished by the sweep (Codex review of PR 376, round 6)", async () => {
  const { RR, notion } = removalWithNotion();
  const db = fakeDb({ books: [PAGED_BOOK, PAGED_BOOK2], reading_sessions: [movedSession()] });
  notion.trash = async () => false;
  await RR.retireEntry(db, 41, 7, "blk-old");
  assert.equal(db.tables.reading_sessions[0].notion_block_id, null, "taken off the session");
  assert.equal(db.tables.reading_mirror_claims.length, 1, "the trash failed: the claim holds the entry");
  notion.trash = async () => true;
  assert.equal(await RR.settleMirrorClaim(db, claimOf(db.tables.reading_mirror_claims[0]), Date.now()), true);
  assert.ok(notion.trashed.length >= 2 && notion.trashed.every((id) => id === "blk-old"), "only the old entry is trashed");
  assert.equal(db.tables.reading_mirror_claims.length, 0);
});

test("claims and progress obligations are never given up for their age: a failed try is deferred with a doubling delay, and rows not due yet are left alone (Codex review of PR 376, round 6)", async () => {
  const { RR, notion } = removalWithNotion();
  assert.deepEqual([0, 1, 2, 3, 6, 20].map((a) => RR.retryDelayMs(a) / 60_000), [15, 15, 30, 60, 360, 360]);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
  const soon = new Date(Date.now() + 10 * 60_000).toISOString();
  const db = fakeDb({
    books: [PAGED_BOOK],
    reading_mirror_claims: [claimRow({ claimed_at: weekAgo, next_try_at: weekAgo, block_id: "blk-x", attempts: 3 }), claimRow({ claim_id: "c-later", next_try_at: soon })],
    reading_progress_owed: [{ owed_id: "o-1", book_id: 7, owed_at: weekAgo, attempts: 2, next_try_at: weekAgo }],
  });
  // Notion refuses everything: nothing can be settled.
  notion.trash = async () => false;
  notion.progress = async () => false;
  await RR.sweepPendingRemovals(db);
  const old = db.tables.reading_mirror_claims.find((c) => c.claim_id === "c-1");
  assert.ok(old, "the week-old claim is kept");
  assert.equal(old.attempts, 4);
  assert.ok(Date.parse(old.next_try_at) > Date.now() + 100 * 60_000, "and tried again later");
  assert.equal(db.tables.reading_mirror_claims.find((c) => c.claim_id === "c-later").attempts, 0, "a claim not due is not tried");
  assert.equal(db.tables.reading_progress_owed.length, 1, "the obligation is kept (carried by the sweep's own row)");
  assert.equal(db.tables.reading_progress_owed[0].attempts, 3);
  assert.ok(Date.parse(db.tables.reading_progress_owed[0].next_try_at) > Date.now() + 50 * 60_000);
});

test("two sweeps on one book's obligation: the one that clears it cannot clear the other's line, which lands stale and then cannot be checked (Codex review of PR 376, round 6)", async () => {
  const { RR: A, notion: nA } = removalWithNotion();
  const { RR: B, notion: nB } = removalWithNotion();
  const due = new Date(Date.now() - 60_000).toISOString();
  const db = fakeDb({ books: [PAGED_BOOK], reading_progress_owed: [{ owed_id: "o-1", book_id: 7, owed_at: due, attempts: 0, next_try_at: due }] });
  let chapters = 5;
  nA.overview = nB.overview = async () => ({ chaptersDone: chapters, sessions: [] });
  // Sweep A read "5"; its Notion write is slow.
  const gate = deferred();
  nA.progress = () => gate.promise;
  const a = A.sweepPendingRemovals(db);
  while (!nA.written.length) await new Promise((r) => setImmediate(r));
  // The book changes; sweep B (another instance) finds the same row, writes "3", checks it and clears what it found.
  chapters = 3;
  await B.sweepPendingRemovals(db);
  assert.deepEqual(nB.written, [3]);
  assert.equal(db.tables.reading_progress_owed.some((r) => r.owed_id === "o-1"), false, "B cleared the row it found");
  assert.equal(db.tables.reading_progress_owed.length, 1, "A's own row, stored before its write, is still there");
  // A's stale "5" lands last and A can no longer check it.
  nA.overview = async () => {
    throw new Error("process gone");
  };
  gate.resolve(true);
  await a;
  assert.deepEqual(nA.written, [5]);
  assert.equal(db.tables.reading_progress_owed.length, 1, "the stale line is still owed durably");
});

test("a removal cleanup writes the progress line from the database at write time, not from the answer's overview (Codex review of PR 376, round 4)", async () => {
  const { RR, notion } = removalWithNotion();
  const db = fakeDb({ books: [PAGED_BOOK], reading_session_removals: [removalRow()] });
  notion.overview = async () => ({ chaptersDone: 2, sessions: [] });
  const stale = { ...answerFor(), overview: { chaptersDone: 9, sessions: [] } };
  await RR.runRemovalCleanup(db, { ok: true, removed: null, unfinished: false, cleanup: cleanupOf(removalRow()) }, stale);
  assert.deepEqual(notion.written, [2]);
  assert.notEqual(db.tables.reading_session_removals[0].mirror_done_at, null);
});

test("logSession: without pds.create_reading_session a keyed create is refused (503), never done in steps (PR 376 review)", async () => {
  // A missing create function does not prove the discard fence is missing too (a partly applied file, a stale schema
  // cache), so the create is not done in separate requests a Discard could land between: nothing is stored.
  const db = fakeDb({ books: [BOOK] }, { noDiscards: true });
  const r = await R.logSession(db, create({ chapter_through: 12, date: "2026-11-15" }));
  assert.equal(r.ok, false);
  assert.equal(r.unavailable, true, "the POST route answers 503 and the form retries");
  assert.match(r.error, /reading_session_discards\.sql/);
  assert.equal(db.tables.reading_sessions.length, 0);
  assert.equal(db.tables.habit_journal.length, 0);
  assert.equal(db.tables.books[0].status, "reading");
  assert.equal(db.log.some((l) => l.op === "insert" || l.op === "upsert" || l.op === "update"), false, "no separate write");
  const plain = await R.logSession(db, create({ client_key: null }));
  assert.equal(plain.ok, true, "callers without a key (chat) are unaffected");
  assert.equal((await R.deleteSessionByClientKey(db, KEY)).status, 503);
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
  assert.match(postFn, /result\.unavailable[\s\S]{0,120}status: 503/, "a keyed create without the create function answers 503");
  assert.match(del, /runRemovalCleanup\(/, "a removal's Notion cleanup (also a replayed one) runs after the response");
  const idDel = route.slice(route.indexOf("export async function DELETE"));
  assert.match(idDel, /runRemovalCleanup\(/);
  assert.doesNotMatch(idDel, /removeMirroredBlock\(/, "the cleanup goes through the helper that marks it done");
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
  assert.equal(locks.length, 3, "the trigger, the keyed create and the removal take the same lock");
  const fn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION pds.create_reading_session("));
  const body = fn.slice(0, fn.indexOf("$$;"));
  assert.match(body, /INSERT INTO pds\.reading_sessions[\s\S]*UPDATE pds\.books[\s\S]*pds\.stamp_reading_habit\(/, "session, finish and habit in one function (T01-R4)");
  assert.match(sql, /GRANT EXECUTE ON FUNCTION pds\.create_reading_session\([^)]*\) TO service_role/);
  const lib = read("lib/reading.ts");
  assert.match(lib, /DISCARDED_KEY_CODE = "OXR01"/, "lib/reading.ts maps the trigger's code");
  assert.match(lib, /rpc\("remove_reading_session", \{/, "a removal is one database call");
  assert.doesNotMatch(lib, /discard_reading_session_key/);
  assert.doesNotMatch(lib, /insert\(key \?/, "no keyed create in separate requests");
  const rm = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION pds.remove_reading_session("));
  const rmBody = rm.slice(0, rm.indexOf("$$;"));
  assert.match(rmBody, /INSERT INTO pds\.reading_session_discards[\s\S]*DELETE FROM pds\.reading_sessions[\s\S]*UPDATE pds\.books[\s\S]*pds\.settle_reading_habit\([\s\S]*INSERT INTO pds\.reading_session_removals/, "discard, delete, finish, habit and cleanup row in one function");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS pds\.reading_session_removals/);
  assert.match(sql, /REVOKE ALL ON pds\.reading_session_removals FROM anon, authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION pds\.remove_reading_session\(bigint, uuid, date\) TO service_role/);
  assert.match(lib, /rpc\("create_reading_session", \{/, "a keyed create is one database call");
  // Codex T01-R7 + round 2: what reading stamps did to the habit row is recorded per habit row (not per session), in
  // the stamp itself, and the last session of a day going settles it; neither swallows a failed settle.
  assert.match(sql, /CREATE TABLE IF NOT EXISTS pds\.reading_habit_provenance/);
  assert.match(sql, /PRIMARY KEY \(cycle_date, question\)/);
  assert.match(sql, /REVOKE ALL ON pds\.reading_habit_provenance FROM anon, authenticated/);
  assert.doesNotMatch(sql, /reading_session_habit_stamps/);
  const fnBody = (name) => {
    const at = sql.slice(sql.indexOf(`CREATE OR REPLACE FUNCTION pds.${name}(`));
    return at.slice(0, at.indexOf("$$;"));
  };
  const stampBody = fnBody("stamp_reading_habit");
  assert.match(stampBody, /INSERT INTO pds\.habit_journal[\s\S]*pds\.reading_habit_provenance/, "the record is written in the same step as the stamp");
  const settleBody = fnBody("settle_reading_habit");
  assert.match(settleBody, /FROM pds\.reading_sessions[\s\S]*FROM pds\.reading_habit_provenance[\s\S]*h\.xmin::text[\s\S]*v_cur = v_prov\.row_version/, "other sessions first, then the record and its row version");
  assert.doesNotMatch(settleBody, /EXCEPTION WHEN/, "a failed settle raises");
  assert.match(body, /pds\.stamp_reading_habit\(/, "the keyed create stamps through the recording stamp");
  assert.match(rmBody, /pds\.settle_reading_habit\(/);
  assert.doesNotMatch(rmBody, /EXCEPTION WHEN/, "no part of a removal is swallowed");
  const moveBody = fnBody("move_reading_session");
  assert.match(moveBody, /UPDATE pds\.reading_sessions[\s\S]*pds\.stamp_reading_habit\([\s\S]*pds\.settle_reading_habit\(v_old_date/, "the move, its stamp and its settle in one function");
  assert.match(sql, /GRANT EXECUTE ON FUNCTION pds\.move_reading_session\([^)]*\) TO service_role/);
  assert.match(lib, /rpc\("move_reading_session", \{/, "a move is one database call");
  assert.doesNotMatch(lib, /unstampHabitIfUnused/);
});

test("sql/reading_sessions_client_key.sql: additive only (the Supabase connector refuses any DROP)", () => {
  const sql = fs.readFileSync(path.join(SRC, "..", "..", "sql", "reading_sessions_client_key.sql"), "utf8");
  assert.doesNotMatch(sql, /drop/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS client_key uuid/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS \w+\s+ON pds\.reading_sessions \(client_key\)\s+WHERE client_key IS NOT NULL/);
});
