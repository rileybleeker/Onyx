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

test("balances: the export's 'NAME ...1234' naming is matched exactly, and matching is one-to-one", async () => {
  const store = memoryStore();
  await importTransactions(rows(), { store, now: T0 }); // contains "Test Card ...1111" (Credit Card) and "Test Checking ...2222" (Cash)
  const before = store.accounts.size;
  const out = await importBalances(
    [
      { institution: "Test Bank", account_name: "Test Card", account_type: "Credit Card", mask: "1111", balance_cents: 100, captured_at: "2026-11-12T15:00:00Z" },
      // same institution and mask again: the first entry already claimed that account, so this one is a new account
      { institution: "Test Bank", account_name: "Other Card", account_type: "Credit Card", mask: "1111", balance_cents: 200, captured_at: "2026-11-12T15:00:00Z" },
    ],
    { store, now: T1 },
  );
  assert.equal(out.accounts_matched, 1);
  assert.equal(out.accounts_created, 1);
  assert.equal(store.accounts.size, before + 1);
  assert.equal(store.snaps.size, 2);
});

// --- re-importing an export after the web ingest has written rows under Rocket Money's own ids -----------------
import { ingestWebTransactions, webAccountRefs } from "../lib/web-transactions.mjs";

const gid = (type, n) => Buffer.from(`${type}:${n}`).toString("base64");
const webNode = (id, over = {}) => ({
  id: gid("Transaction", id),
  shortName: "Web Name",
  longName: "WEB NAME LONG",
  amount: 300,
  date: "2026-02-01",
  note: null,
  taxDeductible: false,
  pending: false,
  ignoredFrom: null,
  category: { label: "Misc" },
  account: { id: gid("Account", 1) },
  ...over,
});
const webAccounts = {
  data: { viewer: { masterAccounts: { edges: [{ node: { institution: { name: "Test Bank" }, accounts: { edges: [{ node: { id: gid("Account", 1), name: "Test Card", number: "1111", customType: "credit" } }] } } }] } } },
};
const ingest = (store, nodes) => ingestWebTransactions({ nodes, accountRefs: webAccountRefs(webAccounts), store, now: T0, gteDate: "2026-01-01" });
const NEW_LINE = "2026-02-01,2026-02-01,Credit Card,Test Card ...1111,1111,Test Bank,NEW PLACE,,3.00,x,Misc,,,,";
const csvWith = (...lines) => rowsFromCsv(syntheticCsv(lines)).rows;
async function seeded() {
  const store = memoryStore();
  await importTransactions(rows(), { store, now: T0 }); // the history, from the export
  return store;
}

test("CSV re-import after web ingestion: a row the ledger already holds under a web key is matched by count, not inserted again", async () => {
  const store = await seeded();
  await ingest(store, [webNode(1)]); // the web wrote the new purchase under its own key
  const size = store.txns.size;
  const out = await importTransactions(csvWith(NEW_LINE), { store, now: T1 });
  assert.equal(out.inserted, 0);
  assert.equal(out.matched_existing, 1);
  assert.equal(out.skipped, 5);
  assert.equal(store.txns.size, size, "no duplicate row");
});

test("CSV re-import inserts only the surplus of CSV rows over what the ledger holds for the same account, date and amount", async () => {
  const store = await seeded();
  await ingest(store, [webNode(1)]); // the ledger holds ONE of the two identical purchases
  const size = store.txns.size;
  const out = await importTransactions(csvWith(NEW_LINE, NEW_LINE), { store, now: T1 });
  assert.equal(out.inserted, 1);
  assert.equal(out.matched_existing, 1);
  assert.equal(store.txns.size, size + 1);
  // the surplus insert is stable: importing the same file again adds nothing
  const again = await importTransactions(csvWith(NEW_LINE, NEW_LINE), { store, now: T1 });
  assert.equal(again.inserted, 0);
  assert.equal(again.matched_existing, 1); // the other row is the one the web already holds
  assert.equal(store.txns.size, size + 1);
});

test("CSV re-import: with the web covering both rows of a group, even a third export row is the only insert", async () => {
  const store = await seeded();
  await ingest(store, [webNode(1), webNode(2)]);
  const out = await importTransactions(csvWith(NEW_LINE, NEW_LINE, NEW_LINE), { store, now: T1 });
  assert.equal(out.inserted, 1, "3 export rows vs 2 held: one surplus");
  assert.equal(out.matched_existing, 2);
});

test("CSV re-import after the web tied ids onto export rows: same keys, nothing inserted, source_txn_id survives", async () => {
  const store = await seeded();
  await ingest(store, [
    webNode(11, { amount: 450, date: "2026-01-05", shortName: "ACME COFFEE", category: { label: "Coffee" } }),
    webNode(12, { amount: 450, date: "2026-01-05", shortName: "ACME COFFEE", category: { label: "Coffee" } }),
  ]); // (b): both identical coffee rows of the export get an id
  assert.deepEqual([...store.txns.values()].filter((t) => t.source_txn_id).map((t) => t.source_txn_id).sort(), ["11", "12"]);
  const size = store.txns.size;
  const out = await importTransactions(rows(), { store, now: T1 });
  assert.equal(out.inserted, 0);
  assert.equal(out.matched_existing, 0);
  assert.equal(store.txns.size, size);
  assert.deepEqual([...store.txns.values()].filter((t) => t.source_txn_id).map((t) => t.source_txn_id).sort(), ["11", "12"]);
});

test("CSV dry run reports the surplus count and writes nothing", async () => {
  const store = await seeded();
  await ingest(store, [webNode(1)]);
  const writes = { ...store.writes };
  const out = await importTransactions(csvWith(NEW_LINE, NEW_LINE), { store, dryRun: true, now: T1 });
  assert.equal(out.inserted, 1);
  assert.equal(out.matched_existing, 1);
  assert.deepEqual(store.writes, writes);
});
