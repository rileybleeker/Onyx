// Synthetic data only: this repository is public. Fake accounts, merchants, amounts and ids.
import test from "node:test";
import assert from "node:assert/strict";
import { memoryStore, syntheticCsv } from "./memory-store.mjs";
import { importTransactions } from "../lib/importer.mjs";
import { rowsFromCsv } from "../lib/normalize.mjs";
import { pairGroup, planReconcile } from "../lib/reconcile.mjs";
import { runReconcileIds } from "../lib/reconcile-run.mjs";

const led = (txn_key, extra = {}) => ({ txn_key, category: "Coffee", account_key: "A", txn_date: "2026-01-05", amount_cents: 450, source_txn_id: null, ...extra });
const web = (id, extra = {}) => ({ id: String(id), category: "Coffee", date: "2026-01-05", account_key: "A", cents: 450, pending: false, ...extra });

test("pairGroup: one row on each side is unambiguous, whatever the category says", () => {
  const out = pairGroup([led("k1", { category: "Old" })], [web(7, { category: "New" })]);
  assert.equal(out.ambiguous, null);
  assert.deepEqual(out.pairs.map(([c, w]) => [c.txn_key, w.id]), [["k1", "7"]]);
});

test("pairGroup: different counts are never paired (no partial pairing)", () => {
  assert.equal(pairGroup([led("k1")], [web(1), web(2)]).ambiguous, "count_mismatch");
  assert.equal(pairGroup([led("k1"), led("k2")], [web(1)]).ambiguous, "count_mismatch");
  assert.deepEqual(pairGroup([led("k1")], [web(1), web(2)]).pairs, []);
});

test("pairGroup with file positions: the n-th row of the file takes the n-th smallest id", () => {
  // file order: k-b (pos 3) then k-a (pos 5); ids 9 and 10 compare as NUMBERS (a string sort would put "10" first)
  const out = pairGroup([led("k-a", { csv_pos: 5 }), led("k-b", { csv_pos: 3 })], [web(10), web(9)]);
  assert.equal(out.ambiguous, null);
  assert.deepEqual(Object.fromEntries(out.pairs.map(([c, w]) => [c.txn_key, w.id])), { "k-b": "9", "k-a": "10" });
});

test("pairGroup with file positions: a pair that disagrees on category makes the whole group ambiguous", () => {
  const cands = [led("k1", { csv_pos: 1, category: "Coffee" }), led("k2", { csv_pos: 2, category: "Shopping" })];
  assert.equal(pairGroup(cands, [web(1, { category: "Coffee" }), web(2, { category: "Shopping" })]).ambiguous, null);
  const swapped = pairGroup(cands, [web(1, { category: "Shopping" }), web(2, { category: "Coffee" })]);
  assert.equal(swapped.ambiguous, "order_conflicts_with_category");
  assert.deepEqual(swapped.pairs, []);
});

test("pairGroup with three identical rows keeps ordinals: positions 1,2,3 <-> ids ascending", () => {
  const cands = [led("c", { csv_pos: 30 }), led("a", { csv_pos: 10 }), led("b", { csv_pos: 20 })];
  const out = pairGroup(cands, [web(300), web(100), web(200)]);
  assert.deepEqual(Object.fromEntries(out.pairs.map(([c, w]) => [c.txn_key, w.id])), { a: "100", b: "200", c: "300" });
});

test("pairGroup without file positions: only a pairing the rows prove is accepted", () => {
  // categories prove the pairing
  const proven = pairGroup([led("k1", { category: "Coffee" }), led("k2", { category: "Shopping" })], [web(5, { category: "Shopping" }), web(6, { category: "Coffee" })]);
  assert.equal(proven.ambiguous, null);
  assert.deepEqual(Object.fromEntries(proven.pairs.map(([c, w]) => [c.txn_key, w.id])), { k1: "6", k2: "5" });
  // identical candidates are interchangeable: any pairing is the same pairing
  const same = pairGroup([led("k1"), led("k2")], [web(5), web(6)]);
  assert.equal(same.ambiguous, null);
  assert.equal(same.pairs.length, 2);
  // different candidates that fit either way: refuse to guess
  const cands = [led("k1", { name: "ONE" }), led("k2", { name: "TWO" })];
  assert.equal(pairGroup(cands, [web(5), web(6)]).ambiguous, "no_order_information");
  // nothing fits
  assert.equal(pairGroup([led("k1", { category: "A" }), led("k2", { category: "A" })], [web(5, { category: "B" }), web(6, { category: "B" })]).ambiguous, "no_compatible_pairing");
});

test("pairGroup: a group larger than the enumeration limit is ambiguous without positions", () => {
  const cands = Array.from({ length: 7 }, (_, i) => led(`k${i}`));
  const webs = Array.from({ length: 7 }, (_, i) => web(i + 1));
  assert.equal(pairGroup(cands, webs).ambiguous, "group_too_large");
});

test("planReconcile: counts matched, ambiguous, unmatched, pending, unknown account and already tied", () => {
  const ledgerRows = [
    led("single", { txn_date: "2026-02-01", amount_cents: 100 }),
    led("dup1", { txn_date: "2026-02-02", amount_cents: 200 }),
    led("dup2", { txn_date: "2026-02-02", amount_cents: 200 }),
    led("only-ledger", { txn_date: "2026-02-03", amount_cents: 300 }),
    led("mismatch1", { txn_date: "2026-02-04", amount_cents: 400 }),
    led("tied", { txn_date: "2026-02-05", amount_cents: 500, source_txn_id: "55" }),
  ];
  const webRows = [
    web(1, { date: "2026-02-01", cents: 100 }),
    web(3, { date: "2026-02-02", cents: 200 }),
    web(2, { date: "2026-02-02", cents: 200 }),
    web(4, { date: "2026-02-04", cents: 400 }),
    web(5, { date: "2026-02-04", cents: 400 }),
    web(6, { date: "2026-02-06", cents: 600 }), // not in the ledger
    web(7, { date: "2026-02-07", cents: 700, pending: true }),
    web(8, { date: "2026-02-08", cents: 800, account_key: null }),
    web(55, { date: "2026-02-05", cents: 500 }), // its ledger row is already tied
  ];
  const csvPosition = new Map([["dup1", 1], ["dup2", 2]]);
  const plan = planReconcile({ ledgerRows, webRows, csvPosition });
  assert.deepEqual(Object.fromEntries(plan.pairs.map((p) => [p.txn_key, p.source_txn_id])), { single: "1", dup1: "2", dup2: "3" });
  const c = plan.counts;
  assert.equal(c.ledger_rows, 6);
  assert.equal(c.already_tied, 1);
  assert.equal(c.candidates, 5);
  assert.equal(c.matched, 3);
  assert.equal(c.ambiguous_ledger_rows, 1); // 1 ledger row vs 2 web rows
  assert.equal(c.ambiguous_web_rows, 2);
  assert.equal(c.unmatched_in_ledger, 1);
  assert.equal(c.unmatched_in_web, 1);
  assert.equal(c.web_pending_skipped, 1);
  assert.equal(c.web_unknown_account, 1);
  assert.equal(c.web_already_tied, 1);
  assert.equal(c.multi_row_groups, 2);
  assert.equal(c.multi_row_groups_paired, 1);
  assert.deepEqual(plan.ambiguousReasons, { count_mismatch: 1 });
});

// --- end to end through runReconcileIds, against the in-memory ledger -------------------------------------------
const WEB_ACCOUNTS = [
  { id: 1, name: "Test Card", mask: "1111", customType: "credit", institution: "Test Bank" },
  { id: 2, name: "Test Checking", mask: "2222", customType: "checking", institution: "Test Credit Union" },
  { id: 3, name: "Test Wallet Card", mask: null, customType: "credit", institution: "Test Wallet" },
];
const WEB_ROWS = [
  { id: 1002, date: "2026-01-05", acct: 1, cents: 450, pending: false, category: "Coffee" }, // two identical coffees
  { id: 1001, date: "2026-01-05", acct: 1, cents: 450, pending: false, category: "Coffee" },
  { id: 1003, date: "2026-01-06", acct: 2, cents: 1234, pending: false, category: "Shopping" },
  { id: 1004, date: "2026-01-07", acct: 2, cents: -250000, pending: false, category: "Income" },
  { id: 1005, date: "2026-01-08", acct: 3, cents: 1599, pending: false, category: "Subscriptions" },
];

async function ledgerFromCsv() {
  const store = memoryStore();
  const csv = syntheticCsv();
  await importTransactions(rowsFromCsv(csv).rows, { store, now: new Date("2026-11-12T12:00:00Z") });
  return { store, csv };
}

test("runReconcileIds: a dry run reports the counts and writes nothing", async () => {
  const { store, csv } = await ledgerFromCsv();
  const before = JSON.stringify([...store.txns.values()]);
  const out = await runReconcileIds({ web: { accounts: WEB_ACCOUNTS, rows: WEB_ROWS }, csvText: csv, store });
  assert.equal(out.ok, true);
  assert.equal(out.dry_run, true);
  assert.equal(out.matched, 5);
  assert.equal(out.attached, 0);
  assert.equal(out.match_rate, 1);
  assert.equal(out.accounts_resolved_to_ledger, 3);
  assert.equal(JSON.stringify([...store.txns.values()]), before);
});

test("runReconcileIds --apply sets only source_txn_id; the two identical rows get the two ids in file order", async () => {
  const { store, csv } = await ledgerFromCsv();
  const before = new Map([...store.txns].map(([k, v]) => [k, { ...v }]));
  const out = await runReconcileIds({ web: { accounts: WEB_ACCOUNTS, rows: WEB_ROWS }, csvText: csv, store, apply: true });
  assert.equal(out.ok, true);
  assert.equal(out.attached, 5);
  for (const [k, v] of store.txns) {
    const { source_txn_id, ...rest } = v;
    const { source_txn_id: _was, ...prev } = before.get(k);
    assert.deepEqual(rest, prev, "no column other than source_txn_id may change");
    assert.ok(source_txn_id);
  }
  const coffee = [...store.txns.values()].filter((t) => t.name === "ACME COFFEE").map((t) => t.source_txn_id).sort();
  assert.deepEqual(coffee, ["1001", "1002"]);
  // running it again finds nothing left to tie and changes nothing
  const again = await runReconcileIds({ web: { accounts: WEB_ACCOUNTS, rows: WEB_ROWS }, csvText: csv, store, apply: true });
  assert.equal(again.attached, 0);
  assert.equal(again.candidates, 0);
});

test("runReconcileIds refuses to write when fewer than 98% of the rows match", async () => {
  const { store, csv } = await ledgerFromCsv();
  const rows = WEB_ROWS.filter((r) => r.id === 1004 || r.id === 1005); // 2 of 5 ledger rows have a web counterpart
  const out = await runReconcileIds({ web: { accounts: WEB_ACCOUNTS, rows }, csvText: csv, store, apply: true });
  assert.equal(out.ok, false);
  assert.match(out.error, /below 0\.98/);
  assert.equal([...store.txns.values()].some((t) => t.source_txn_id), false);
});

test("runReconcileIds skips pending web rows and counts rows of accounts the ledger does not hold", async () => {
  const { store, csv } = await ledgerFromCsv();
  const rows = [...WEB_ROWS, { id: 2000, date: "2026-01-09", acct: 1, cents: 99, pending: true, category: "Coffee" }, { id: 2001, date: "2026-01-09", acct: 9, cents: 5, pending: false, category: "Other" }];
  const out = await runReconcileIds({ web: { accounts: WEB_ACCOUNTS, rows }, csvText: csv, store });
  assert.equal(out.web_pending_skipped, 1);
  assert.equal(out.web_unknown_account, 1);
  assert.equal(out.matched, 5);
});
