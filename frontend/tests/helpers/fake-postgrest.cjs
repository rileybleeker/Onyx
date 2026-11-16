// Test helper (not a test: CI only runs tests/*.test.cjs). A small in-memory stand-in for the supabase-js query
// builder: insert / update / select with eq / in / gte / order / limit / single / maybeSingle, unique keys per table
// (all-or-nothing inserts, a 23505 on a clash, keys with a NULL column never clash, like a partial unique index) and
// injectable failures. Enough to run code that writes through PostgREST offline. Synthetic data only.
"use strict";

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/**
 * options.unique   { table: [[col, ...], ...] }        unique keys
 * options.defaults { table: (now, seq) => ({ ... }) }  column defaults for inserted rows
 * options.tables   { table: [rows] }                   starting rows
 * options.rpc      { name: value }                     rpc() answers
 * options.fail     ({ table, op, payload }) => error | null   an error object fails that call (nothing is written)
 */
function createFakePostgrest(options = {}) {
  const unique = options.unique ?? {};
  const defaults = options.defaults ?? {};
  const data = new Map(Object.entries(options.tables ?? {}).map(([t, rows]) => [t, rows.map(clone)]));
  const log = [];
  let failure = options.fail ?? null;
  let clock = Date.parse(options.now ?? "2030-01-01T12:00:00.000Z");
  let seq = 0;
  const now = () => new Date((clock += 1000)).toISOString();
  const rowsOf = (t) => {
    if (!data.has(t)) data.set(t, []);
    return data.get(t);
  };

  function query(table) {
    const q = { op: "select", filters: [], orders: [], max: null, mode: "many", returning: false, payload: null };
    const shape = (list) => {
      if (q.mode === "single") return list.length === 1 ? { data: clone(list[0]), error: null } : { data: null, error: { code: "PGRST116" } };
      if (q.mode === "maybe") return list.length <= 1 ? { data: clone(list[0] ?? null), error: null } : { data: null, error: { code: "PGRST116" } };
      return { data: clone(list), error: null };
    };
    const run = () => {
      log.push({ table, op: q.op, payload: clone(q.payload) });
      const injected = failure ? failure({ table, op: q.op, payload: q.payload }) : null;
      if (injected) return { data: null, error: injected };
      const all = rowsOf(table);
      if (q.op === "insert") {
        const batch = (Array.isArray(q.payload) ? q.payload : [q.payload]).map((row) => ({
          ...(defaults[table] ? defaults[table](now, ++seq) : {}),
          ...clone(row),
        }));
        for (const keys of unique[table] ?? []) {
          const seen = new Set();
          for (const row of [...all, ...batch]) {
            if (keys.some((k) => row[k] === null || row[k] === undefined)) continue;
            const sig = JSON.stringify(keys.map((k) => row[k]));
            if (seen.has(sig)) return { data: null, error: { code: "23505" } };
            seen.add(sig);
          }
        }
        all.push(...batch);
        return q.returning ? shape(batch) : { data: null, error: null };
      }
      let list = all.filter((row) => q.filters.every((f) => f(row)));
      if (q.op === "update") {
        for (const row of list) Object.assign(row, clone(q.payload));
        return q.returning ? shape(list) : { data: null, error: null };
      }
      for (const [col, asc] of [...q.orders].reverse()) {
        list = [...list].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
      }
      if (q.max != null) list = list.slice(0, q.max);
      return shape(list);
    };
    const api = {
      select() {
        if (q.op !== "select") q.returning = true;
        return api;
      },
      insert(payload) {
        q.op = "insert";
        q.payload = payload;
        return api;
      },
      update(payload) {
        q.op = "update";
        q.payload = payload;
        return api;
      },
      eq(col, value) {
        q.filters.push((row) => row[col] === value);
        return api;
      },
      in(col, values) {
        q.filters.push((row) => values.includes(row[col]));
        return api;
      },
      gte(col, value) {
        q.filters.push((row) => row[col] !== null && row[col] !== undefined && row[col] >= value);
        return api;
      },
      order(col, opts = {}) {
        q.orders.push([col, opts.ascending !== false]);
        return api;
      },
      limit(n) {
        q.max = n;
        return api;
      },
      single() {
        q.mode = "single";
        return api;
      },
      maybeSingle() {
        q.mode = "maybe";
        return api;
      },
      then(resolve, reject) {
        return Promise.resolve().then(run).then(resolve, reject);
      },
    };
    return api;
  }

  return {
    from: (table) => query(table),
    rpc: async (name) => ({ data: (options.rpc ?? {})[name] ?? null, error: null }),
    /** A copy of the table's rows. */
    rows: (table) => clone(rowsOf(table)),
    /** Add rows directly (as another writer would). */
    seed: (table, rows) => rowsOf(table).push(...rows.map(clone)),
    /** Every call made: { table, op, payload }. */
    log,
    setFailure(fn) {
      failure = fn;
    },
    now,
  };
}

/** Unique keys and defaults of the chat replay ledger (sql/chat_operations.sql). */
function chatLedgerTables(randomUUID) {
  return {
    unique: {
      chat_requests: [["owner_id", "request_id"]],
      chat_operations: [["owner_id", "request_id", "tool", "ordinal"]],
    },
    defaults: {
      chat_requests: (now) => ({ created_at: now(), last_attempt_at: now() }),
      chat_operations: (now) => {
        const at = now();
        return { op_id: randomUUID(), status: "pending", result: null, receipt: null, context: null, created_at: at, updated_at: at };
      },
    },
  };
}

module.exports = { createFakePostgrest, chatLedgerTables };
