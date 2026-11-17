// Run: node --test tests/patch-zero-match-404.test.cjs
// PATCH /api/meals and PATCH /api/weight use maybeSingle(), so a row that no longer exists (deleted in
// another tab) answers 404 with a plain message, while a matching row returns the same body as before and
// the error branch still answers 500.
// SYNTHETIC DATA ONLY: invented ids, dates and numbers; no network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

class FakeResponse {
  static json(body, init = {}) {
    return { body, status: init.status ?? 200 };
  }
}

// In-memory stand-in for `from(table).update(patch).eq(col, val).select(cols).maybeSingle()`.
// `failWith` makes the update return an error instead of rows.
function makeSupabase({ table, rows, failWith = null }) {
  const calls = [];
  const client = {
    from(name) {
      return {
        update(patch) {
          const q = { patch, filters: [] };
          calls.push({ table: name, ...q });
          return {
            eq(col, val) {
              q.filters.push([col, val]);
              return {
                select(cols) {
                  const picked = (r) => Object.fromEntries(cols.split(",").map((c) => c.trim()).map((c) => [c, r[c]]));
                  return {
                    async maybeSingle() {
                      if (failWith) return { data: null, error: { message: failWith } };
                      const hit = rows.filter((r) => r[col] === val);
                      if (hit.length > 1) return { data: null, error: { message: "more than one row" } };
                      if (hit.length === 0) return { data: null, error: null };
                      Object.assign(hit[0], patch);
                      return { data: picked(hit[0]), error: null };
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
  return { client, calls, rows, table };
}

function loadRoute(file, db) {
  return loadTs(file, {
    "next/server": { NextResponse: FakeResponse },
    "@supabase/supabase-js": { createClient: () => db.client },
  });
}

const req = (body) => ({ json: async () => body });

// ─── meals ───────────────────────────────────────────────────────────────────

test("meals PATCH: a missing meal answers 404 with the plain message", async () => {
  const db = makeSupabase({ rows: [{ event_id: 1, kind: "snack", notes: null }] });
  const res = await loadRoute("app/api/meals/route.ts", db).PATCH(req({ event_id: 999, kind: "snack" }));
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: "That meal no longer exists." });
});

test("meals PATCH: a matching meal returns the same row body as before", async () => {
  const db = makeSupabase({ rows: [{ event_id: 2, event_date: "2026-11-01", event_time: "2026-11-01T12:00:00Z", kind: "other", notes: null }] });
  const res = await loadRoute("app/api/meals/route.ts", db).PATCH(req({ event_id: 2, kind: "snack", notes: "  synthetic  " }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    event_id: 2,
    event_date: "2026-11-01",
    event_time: "2026-11-01T12:00:00Z",
    kind: "snack",
    notes: "synthetic",
  });
});

test("meals PATCH: a database error still answers 500 with the save message", async () => {
  const db = makeSupabase({ rows: [], failWith: "synthetic failure" });
  const res = await loadRoute("app/api/meals/route.ts", db).PATCH(req({ event_id: 3, kind: "snack" }));
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: "Couldn't save that meal. Try again." });
});

// ─── weight ──────────────────────────────────────────────────────────────────

test("weight PATCH: a date with no row answers 404 with the plain message", async () => {
  const db = makeSupabase({ rows: [{ log_date: "2026-11-02", weight_kg: 80, notes: null, logged_at: "x", source: "manual" }] });
  const res = await loadRoute("app/api/weight/route.ts", db).PATCH(req({ log_date: "2026-10-01", weight_kg: 81 }));
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: "No weight is logged for that date." });
});

test("weight PATCH: a matching date returns the same row body as before", async () => {
  const db = makeSupabase({ rows: [{ log_date: "2026-11-02", weight_kg: 80, notes: null, logged_at: "2026-11-02T07:00:00Z", source: "manual" }] });
  const res = await loadRoute("app/api/weight/route.ts", db).PATCH(req({ log_date: "2026-11-02", weight_kg: 81.5 }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    log_date: "2026-11-02",
    weight_kg: 81.5,
    notes: null,
    logged_at: "2026-11-02T07:00:00Z",
    source: "manual",
  });
});

test("weight PATCH: a database error still answers 500 with the save message", async () => {
  const db = makeSupabase({ rows: [], failWith: "synthetic failure" });
  const res = await loadRoute("app/api/weight/route.ts", db).PATCH(req({ log_date: "2026-11-02", weight_kg: 81 }));
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: "Couldn't save your weight. Try again." });
});
