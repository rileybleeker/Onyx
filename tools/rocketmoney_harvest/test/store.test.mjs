// The supabase-js adapter, exercised against a fake client. Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import { buildStore, CHUNK, chunked } from "../lib/store.mjs";

function fakeClient({ readPages = [], upsertError = null, snapshotRows = null } = {}) {
  const calls = [];
  let page = 0;
  const client = {
    schema(s) {
      calls.push({ op: "schema", s });
      return {
        from(table) {
          const q = {
            select(cols) {
              calls.push({ op: "select", table, cols });
              this._sel = true;
              return this;
            },
            order(col, opt) {
              calls.push({ op: "order", col, opt });
              return this;
            },
            async range(a, b) {
              calls.push({ op: "range", a, b });
              return { data: readPages[page++] ?? [], error: null };
            },
            upsert(rows, opt) {
              calls.push({ op: "upsert", table, n: rows.length, opt });
              const res = { data: snapshotRows ?? null, error: upsertError };
              const p = Promise.resolve(res);
              p.select = (cols) => {
                calls.push({ op: "select-after-upsert", cols });
                return Promise.resolve({ data: snapshotRows ?? rows.map((r) => ({ account_key: r.account_key })), error: upsertError });
              };
              return p;
            },
            async insert(row) {
              calls.push({ op: "insert", table, row });
              return { error: upsertError };
            },
          };
          return q;
        },
      };
    },
  };
  return { client, calls };
}

test("chunked never exceeds 500 rows", () => {
  const parts = chunked(Array.from({ length: 1201 }, (_, i) => i));
  assert.deepEqual(parts.map((p) => p.length), [500, 500, 201]);
  assert.equal(CHUNK, 500);
});

test("writes go to the pds schema in chunks of <=500 with the right conflict targets", async () => {
  const { client, calls } = fakeClient();
  const store = buildStore(client);
  await store.upsertTransactions(Array.from({ length: 1100 }, (_, i) => ({ txn_key: String(i) })));
  await store.upsertAccounts([{ account_key: "a" }]);
  const ups = calls.filter((c) => c.op === "upsert");
  assert.deepEqual(ups.map((c) => c.n), [500, 500, 100, 1]);
  assert.deepEqual(ups.map((c) => c.table), ["finance_transactions", "finance_transactions", "finance_transactions", "finance_accounts"]);
  assert.equal(ups[0].opt.onConflict, "txn_key");
  assert.equal(ups[3].opt.onConflict, "account_key");
  assert.ok(calls.filter((c) => c.op === "schema").every((c) => c.s === "pds"));
});

test("reads page through 1000-row windows until a short page", async () => {
  const full = Array.from({ length: 1000 }, (_, i) => ({ txn_key: `k${i}` }));
  const { client, calls } = fakeClient({ readPages: [full, full, [{ txn_key: "last" }]] });
  const rows = await buildStore(client).getTransactions();
  assert.equal(rows.length, 2001);
  assert.deepEqual(calls.filter((c) => c.op === "range").map((c) => [c.a, c.b]), [[0, 999], [1000, 1999], [2000, 2999]]);
});

test("snapshots use ignore-duplicates and count only the rows actually returned as inserted", async () => {
  const { client, calls } = fakeClient({ snapshotRows: [{ account_key: "x" }] });
  const n = await buildStore(client).insertSnapshots([{ account_key: "x", captured_at: "t1" }, { account_key: "x", captured_at: "t2" }]);
  assert.equal(n, 1);
  const up = calls.find((c) => c.op === "upsert");
  assert.equal(up.table, "finance_balance_snapshots");
  assert.deepEqual(up.opt, { onConflict: "account_key,captured_at", ignoreDuplicates: true });
});

test("database errors keep code + message but drop details that can quote row values", async () => {
  const { client } = fakeClient({ upsertError: { message: "duplicate key value", code: "23505", details: 'Key (txn_key)=(abc) ... name="PRIVATE MERCHANT"' } });
  await assert.rejects(buildStore(client).upsertTransactions([{ txn_key: "1" }]), (e) => {
    assert.equal(e.code, "23505");
    assert.equal(String(e.message).includes("PRIVATE"), false);
    return true;
  });
});

test("heartbeat inserts into sync_log", async () => {
  const { client, calls } = fakeClient();
  await buildStore(client).logHeartbeat({ source: "rocketmoney", data_type: "transactions", status: "success" });
  const ins = calls.find((c) => c.op === "insert");
  assert.equal(ins.table, "sync_log");
  assert.equal(ins.row.source, "rocketmoney");
});
