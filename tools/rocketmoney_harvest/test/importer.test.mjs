// Synthetic data only: this repository is public.
import test from "node:test";
import assert from "node:assert/strict";
import { memoryStore, syntheticCsv } from "./memory-store.mjs";
import { rowsFromCsv } from "../lib/normalize.mjs";
import { importBalances, importTransactions } from "../lib/importer.mjs";

const rows = () => rowsFromCsv(syntheticCsv()).rows;
const T0 = new Date("2026-11-12T12:00:00Z");
const T1 = new Date("2026-11-13T12:00:00Z");

test("first import inserts everything; accounts are written before transactions", async () => {
  const store = memoryStore();
  const out = await importTransactions(rows(), { store, now: T0 });
  assert.deepEqual({ rows: out.rows, accounts: out.accounts, inserted: out.inserted, updated: out.updated, skipped: out.skipped, errors: out.errors }, { rows: 5, accounts: 3, inserted: 5, updated: 0, skipped: 0, errors: 0 });
  assert.equal(store.accounts.size, 3);
  assert.equal(store.txns.size, 5);
  assert.equal(out.date_min, "2026-01-05");
  assert.equal(out.date_max, "2026-01-08");
  const sum = [...store.txns.values()].reduce((a, t) => a + t.amount_cents, 0);
  assert.equal(sum, 450 + 450 + 1234 - 250000 + 1599);
});

test("re-running the same export is idempotent: 0 inserted, 0 duplicates, last_seen_at advances", async () => {
  const store = memoryStore();
  await importTransactions(rows(), { store, now: T0 });
  const out = await importTransactions(rows(), { store, now: T1 });
  assert.equal(out.inserted, 0);
  assert.equal(out.updated, 0);
  assert.equal(out.skipped, 5);
  assert.equal(store.txns.size, 5);
  assert.equal(store.accounts.size, 3);
  for (const t of store.txns.values()) {
    assert.equal(t.first_seen_at, T0.toISOString());
    assert.equal(t.last_seen_at, T1.toISOString());
  }
});

test("re-categorizing in the source updates the same row instead of adding one", async () => {
  const store = memoryStore();
  await importTransactions(rows(), { store, now: T0 });
  const edited = rows().map((r) => (r.Name === "STREAMING SVC" ? { ...r, Category: "Entertainment", Note: "moved" } : r));
  const out = await importTransactions(edited, { store, now: T1 });
  assert.equal(out.inserted, 0);
  assert.equal(out.updated, 1);
  assert.equal(out.skipped, 4);
  assert.equal(store.txns.size, 5);
  const t = [...store.txns.values()].find((x) => x.name === "STREAMING SVC");
  assert.equal(t.category, "Entertainment");
  assert.equal(t.note, "moved");
});

test("rows absent from a later export are never deleted", async () => {
  const store = memoryStore();
  await importTransactions(rows(), { store, now: T0 });
  const out = await importTransactions(rows().slice(0, 2), { store, now: T1 });
  assert.equal(out.inserted, 0);
  assert.equal(store.txns.size, 5);
  assert.equal(store.accounts.size, 3);
});

test("a new transaction in a later export is the only insert", async () => {
  const store = memoryStore();
  await importTransactions(rows(), { store, now: T0 });
  const more = rowsFromCsv(syntheticCsv(["2026-02-01,2026-02-01,Credit Card,Test Card ...1111,1111,Test Bank,NEW PLACE,,3.00,x,Misc,,,,"])).rows;
  const out = await importTransactions(more, { store, now: T1 });
  assert.equal(out.inserted, 1);
  assert.equal(out.skipped, 5);
  assert.equal(store.accounts.get([...store.accounts.keys()][0]).last_seen >= "2026-01-05", true);
  const card = [...store.accounts.values()].find((a) => a.mask === "1111");
  assert.equal(card.first_seen, "2026-01-05");
  assert.equal(card.last_seen, "2026-02-01");
});

test("dry run reads but writes nothing, and reports what it would do", async () => {
  const store = memoryStore();
  const out = await importTransactions(rows(), { store, dryRun: true, now: T0 });
  assert.equal(out.inserted, 5);
  assert.deepEqual(store.writes, { accounts: 0, transactions: 0, snapshots: 0, heartbeats: 0 });
  assert.equal(store.txns.size, 0);
  assert.equal(store.accounts.size, 0);
});

test("a write failure surfaces as an error (nothing swallowed)", async () => {
  const store = memoryStore({ failOn: "upsertTransactions" });
  await assert.rejects(importTransactions(rows(), { store, now: T0 }), /upsertTransactions failed/);
});

test("balances: creates unseen accounts, inserts snapshots, and re-running the same file inserts nothing", async () => {
  const store = memoryStore();
  const entries = [
    { institution: "Test Brokerage", account_name: "Test IRA", account_type: "Investment", mask: "4321", balance_cents: 5000000, currency: "USD", kind: "asset", captured_at: "2026-11-12T15:00:00Z" },
    { institution: "Test Lender", account_name: "Test Loan", account_type: "Loan", mask: null, balance_cents: 1500000, currency: "USD", kind: "liability", captured_at: "2026-11-12T15:00:00Z" },
  ];
  const first = await importBalances(entries, { store, now: T0 });
  assert.deepEqual({ rows: first.rows, accounts: first.accounts, created: first.accounts_created, inserted: first.inserted, skipped: first.skipped, errors: first.errors }, { rows: 2, accounts: 2, created: 2, inserted: 2, skipped: 0, errors: 0 });
  assert.equal(store.accounts.size, 2);
  const again = await importBalances(entries, { store, now: T1 });
  assert.equal(again.inserted, 0);
  assert.equal(again.skipped, 2);
  assert.equal(again.accounts_created, 0);
  assert.equal(store.snaps.size, 2);
  const next = await importBalances([{ ...entries[0], captured_at: "2026-11-13T15:00:00Z", balance_cents: 5100000 }], { store, now: T1 });
  assert.equal(next.inserted, 1);
  assert.equal(store.snaps.size, 3);
});

test("balances: an account named differently than in the export reuses it when institution and mask match exactly one", async () => {
  const store = memoryStore();
  await importTransactions(rows(), { store, now: T0 });
  const before = store.accounts.size;
  const out = await importBalances(
    [{ institution: "test bank", account_name: "Card Ending 1111", account_type: "Credit", mask: "1111", balance_cents: -12345, currency: "USD", kind: "liability", captured_at: "2026-11-12T15:00:00Z" }],
    { store, now: T1 },
  );
  assert.equal(store.accounts.size, before);
  assert.equal(out.accounts_created, 0);
  assert.equal(out.accounts_matched, 1);
  const [snap] = [...store.snaps.values()];
  assert.equal(store.accounts.get(snap.account_key).mask, "1111");
});

test("balances: dry run writes nothing", async () => {
  const store = memoryStore();
  const out = await importBalances([{ institution: "B", account_name: "A", account_type: "Cash", mask: "1", balance_cents: 1, captured_at: "2026-11-12T00:00:00Z" }], { store, dryRun: true, now: T0 });
  assert.equal(out.inserted, 1);
  assert.equal(store.snaps.size + store.accounts.size, 0);
});
