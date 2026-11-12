// Synthetic data only: this repository is public. Fake accounts, merchants, amounts and ids.
import test from "node:test";
import assert from "node:assert/strict";
import { memoryStore, syntheticCsv } from "./memory-store.mjs";
import { isMutationRequest } from "../lib/harvest-core.mjs";
import { importTransactions } from "../lib/importer.mjs";
import { rowsFromCsv } from "../lib/normalize.mjs";
import {
  decodeId,
  ingestWebTransactions,
  normalizeWebNodes,
  pageFetchTransactions,
  rmidKey,
  TRANSACTIONS_OPERATION,
  TRANSACTIONS_QUERY,
  webAccountRefs,
  windowStart,
} from "../lib/web-transactions.mjs";

const gid = (type, n) => Buffer.from(`${type}:${n}`).toString("base64");
const NOW = new Date("2026-11-12T12:00:00.000Z");
const LATER = new Date("2026-11-13T12:00:00.000Z");

const node = (id, over = {}) => ({
  id: gid("Transaction", id),
  shortName: "TEST SHOP",
  longName: "TEST SHOP #123 CITY",
  amount: 1250,
  date: "2026-11-10",
  note: null,
  taxDeductible: false,
  pending: false,
  ignoredFrom: null,
  category: { id: "c1", label: "Shopping" },
  account: { id: gid("Account", 1) },
  ...over,
});

const accountsJson = {
  data: { viewer: { masterAccounts: { edges: [
    { node: { institution: { name: "Test Bank" }, accounts: { edges: [
      { node: { id: gid("Account", 1), name: "Test Card", number: "1111", customType: "credit", enabled: true, applicable: true } },
      { node: { id: gid("Account", 3), name: "Closed Thing", number: "3333", customType: "checking", enabled: false, applicable: true } },
    ] } } },
    { node: { institution: { name: "Test Credit Union" }, accounts: { edges: [
      { node: { id: gid("Account", 2), name: "Test Checking", number: "2222", customType: "checking", enabled: true, applicable: true } },
    ] } } },
  ] } } },
};
const refs = () => webAccountRefs(accountsJson);

const run = (store, nodes, over = {}) => ingestWebTransactions({ nodes, accountRefs: refs(), store, now: NOW, gteDate: "2026-09-13", ...over });
const counts = (r) => ({ fetched: r.fetched, rows: r.rows, inserted: r.inserted, updated: r.updated, unchanged: r.unchanged, attached: r.attached, ambiguous: r.ambiguous, errors: r.errors });

test("ids: decodeId reads the app's base64 global ids, rmidKey is a stable 32-hex key", () => {
  assert.equal(decodeId(gid("Transaction", 123456789012), "Transaction"), "123456789012");
  assert.equal(decodeId(gid("Account", 7), "Account"), "7");
  assert.equal(decodeId(gid("Account", 7), "Transaction"), null);
  assert.equal(decodeId("not base64 at all!", "Transaction"), null);
  assert.equal(decodeId(null, "Transaction"), null);
  assert.match(rmidKey("42"), /^[0-9a-f]{32}$/);
  assert.equal(rmidKey("42"), rmidKey("42"));
  assert.notEqual(rmidKey("42"), rmidKey("43"));
});

test("windowStart counts back from today in New York, not UTC", () => {
  assert.equal(windowStart(new Date("2026-11-12T12:00:00Z"), 60), "2026-09-13");
  // 02:00 UTC on 13 Nov is still 12 Nov (21:00) in New York
  assert.equal(windowStart(new Date("2026-11-13T02:00:00Z"), 60), "2026-09-13");
  assert.equal(windowStart(new Date("2026-11-12T12:00:00Z"), 1), "2026-11-11");
});

test("webAccountRefs: one reference per enabled account, with the ledger's type label and last four digits", () => {
  const list = refs();
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], { web_id: "1", institution: "Test Bank", account_name: "Test Card", account_type: "Credit Card", mask: "1111" });
  assert.equal(list[1].account_type, "Cash");
});

test("the transactions request is a read: a query with the app's operation name, never a mutation", () => {
  assert.equal(isMutationRequest(JSON.stringify({ operationName: TRANSACTIONS_OPERATION, query: TRANSACTIONS_QUERY })), false);
  assert.match(TRANSACTIONS_QUERY, /^query TransactionsPageTransactionTable/);
  assert.equal(/mutation/i.test(TRANSACTIONS_QUERY), false);
});

test("normalizeWebNodes: pending rows are skipped, unreadable rows are counted by reason, repeated ids collapse", () => {
  const keys = new Map([["1", "key-card"]]);
  const out = normalizeWebNodes(
    [
      node(1),
      node(2, { pending: true }),
      node(3, { id: "garbage" }),
      node(4, { date: "someday" }),
      node(5, { amount: "12.50" }),
      node(6, { account: { id: gid("Account", 99) } }),
      node(1, { amount: 999 }), // the same id twice: the last one wins
    ],
    keys,
  );
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].amount_cents, 999);
  assert.equal(out.rows[0].account_key, "key-card");
  assert.equal(out.pending, 1);
  assert.deepEqual(out.rejected, { bad_id: 1, bad_date: 1, bad_amount: 1, unknown_account: 1 });
});

test("(c) a transaction the ledger has never seen is inserted under txn_key = sha256('rmid|' + id)", async () => {
  const store = memoryStore();
  const out = await run(store, [node(500, { shortName: "NEW PLACE", amount: 1999, category: { label: "Dining" }, note: "lunch" })]);
  assert.deepEqual(counts(out), { fetched: 1, rows: 1, inserted: 1, updated: 0, unchanged: 0, attached: 0, ambiguous: 0, errors: 0 });
  assert.equal(out.accounts_created, 1);
  const row = store.txns.get(rmidKey("500"));
  assert.ok(row);
  assert.equal(row.source_txn_id, "500");
  assert.equal(row.name, "NEW PLACE");
  assert.equal(row.amount_cents, 1999);
  assert.equal(row.category, "Dining");
  assert.equal(row.note, "lunch");
  assert.equal(row.txn_date, "2026-11-10");
  const acct = store.accounts.get(row.account_key);
  assert.equal(acct.mask, "1111");
  assert.equal(acct.first_seen, "2026-11-10");
  assert.equal(acct.last_seen, "2026-11-10");
});

test("running the same fetch again is idempotent: nothing inserted, nothing duplicated, only last_seen_at moves", async () => {
  const store = memoryStore();
  const nodes = [node(500), node(501, { amount: 700, shortName: "OTHER" }), node(502, { amount: 700, shortName: "OTHER" })];
  await run(store, nodes);
  const first = [...store.txns.keys()].sort();
  const again = await run(store, nodes, { now: LATER });
  assert.deepEqual(counts(again), { fetched: 3, rows: 3, inserted: 0, updated: 0, unchanged: 3, attached: 0, ambiguous: 0, errors: 0 });
  assert.deepEqual([...store.txns.keys()].sort(), first);
  for (const t of store.txns.values()) assert.equal(t.last_seen_at, LATER.toISOString());
});

test("(a) a transaction the ledger already knows by id is updated in place: name, category, note, ignored, amount, date", async () => {
  const store = memoryStore();
  await run(store, [node(500)]);
  const edited = node(500, { shortName: "RENAMED", category: { label: "Gifts" }, note: "for a friend", ignoredFrom: "everything", amount: 1300, date: "2026-11-11", taxDeductible: true });
  const out = await run(store, [edited], { now: LATER });
  assert.deepEqual(counts(out), { fetched: 1, rows: 1, inserted: 0, updated: 1, unchanged: 0, attached: 0, ambiguous: 0, errors: 0 });
  assert.equal(store.txns.size, 1);
  const row = store.txns.get(rmidKey("500"));
  assert.deepEqual(
    { name: row.name, category: row.category, note: row.note, ignored_from: row.ignored_from, amount_cents: row.amount_cents, txn_date: row.txn_date, tax_deductible: row.tax_deductible },
    { name: "RENAMED", category: "Gifts", note: "for a friend", ignored_from: "everything", amount_cents: 1300, txn_date: "2026-11-11", tax_deductible: true },
  );
  assert.equal(row.first_seen_at, NOW.toISOString());
});

test("(a) fields the web list does not carry (custom name, tags, description, original date) are never touched", async () => {
  const store = memoryStore();
  await run(store, [node(500)]);
  Object.assign(store.txns.get(rmidKey("500")), { custom_name: "My name", tags: "a,b", description: "BANK TEXT", original_date: "2026-11-09" });
  await run(store, [node(500, { note: "x" })], { now: LATER });
  const row = store.txns.get(rmidKey("500"));
  assert.deepEqual([row.custom_name, row.tags, row.description, row.original_date], ["My name", "a,b", "BANK TEXT", "2026-11-09"]);
});

// --- (b): rows imported from the export, tied to their web id instead of being inserted again -----------------
async function ledgerWithExport(extraLines = []) {
  const store = memoryStore();
  await importTransactions(rowsFromCsv(syntheticCsv(extraLines)).rows, { store, now: NOW });
  return store;
}
const CARD = "Credit Card,Test Card ...1111,1111,Test Bank";

test("(b) an export row with no id is tied to the web transaction on (account, date, amount): attached, not inserted", async () => {
  const store = await ledgerWithExport();
  const sizeBefore = store.txns.size;
  const coffee = [...store.txns.values()].find((t) => t.name === "ACME COFFEE");
  const out = await run(store, [node(900, { shortName: "Acme Coffee", longName: "ACME COFFEE #12", amount: 450, date: "2026-01-05", category: { label: "Coffee" } })], { gteDate: "2026-01-01" });
  assert.equal(out.attached, 0, "two identical coffees need two web rows; one web row is a count mismatch");
  assert.equal(out.ambiguous, 1);
  assert.equal(store.txns.size, sizeBefore);
  assert.equal(coffee.source_txn_id ?? null, null);

  const widgets = [...store.txns.values()].find((t) => t.name === "WIDGETS, INC");
  const out2 = await run(store, [node(901, { amount: 1234, date: "2026-01-06", account: { id: gid("Account", 2) }, category: { label: "Shopping" } })], { gteDate: "2026-01-01" });
  assert.deepEqual(counts(out2), { fetched: 1, rows: 1, inserted: 0, updated: 0, unchanged: 0, attached: 1, ambiguous: 0, errors: 0 });
  assert.equal(store.txns.size, sizeBefore, "no duplicate was created");
  assert.equal(widgets.txn_key, [...store.txns.values()].find((t) => t.source_txn_id === "901").txn_key, "the existing row got the id");
  assert.equal(store.txns.get(widgets.txn_key).description, "WIDGETS \"PRO\"", "export-only columns stay");
});

test("(b) ordinal-aware: two identical export rows take two new web ids, each row exactly once, and a re-run changes nothing", async () => {
  const store = await ledgerWithExport();
  const sizeBefore = store.txns.size;
  const nodes = [
    node(902, { shortName: "ACME COFFEE", amount: 450, date: "2026-01-05", category: { label: "Coffee" } }),
    node(903, { shortName: "ACME COFFEE", amount: 450, date: "2026-01-05", category: { label: "Coffee" } }),
  ];
  const out = await run(store, nodes, { gteDate: "2026-01-01" });
  assert.deepEqual(counts(out), { fetched: 2, rows: 2, inserted: 0, updated: 0, unchanged: 0, attached: 2, ambiguous: 0, errors: 0 });
  assert.equal(store.txns.size, sizeBefore);
  const ids = [...store.txns.values()].filter((t) => t.source_txn_id).map((t) => t.source_txn_id).sort();
  assert.deepEqual(ids, ["902", "903"]);
  const again = await run(store, nodes, { gteDate: "2026-01-01", now: LATER });
  assert.deepEqual(counts(again), { fetched: 2, rows: 2, inserted: 0, updated: 0, unchanged: 2, attached: 0, ambiguous: 0, errors: 0 });
  assert.equal(store.txns.size, sizeBefore);
});

test("(b) an unprovable pairing is left alone and nothing is inserted (never a duplicate)", async () => {
  // one export row, but TWO web transactions with the same account, date and amount
  const store = await ledgerWithExport();
  const sizeBefore = store.txns.size;
  const out = await run(
    store,
    [node(904, { amount: 1234, date: "2026-01-06", account: { id: gid("Account", 2) } }), node(905, { amount: 1234, date: "2026-01-06", account: { id: gid("Account", 2) } })],
    { gteDate: "2026-01-01" },
  );
  assert.equal(out.ambiguous, 2);
  assert.equal(out.inserted + out.attached + out.updated, 0);
  assert.equal(store.txns.size, sizeBefore);
  assert.equal([...store.txns.values()].some((t) => t.source_txn_id), false);
  assert.deepEqual(out.rejected_by_reason, { ambiguous_count_mismatch: 1 });
});

test("(b) then (a): once tied, the next fetch updates that row by id", async () => {
  const store = await ledgerWithExport();
  const nodes = [node(901, { amount: 1234, date: "2026-01-06", account: { id: gid("Account", 2) }, category: { label: "Shopping" } })];
  await run(store, nodes, { gteDate: "2026-01-01" });
  const again = await run(store, [{ ...nodes[0], note: "kept the receipt" }], { gteDate: "2026-01-01", now: LATER });
  assert.deepEqual(counts(again), { fetched: 1, rows: 1, inserted: 0, updated: 1, unchanged: 0, attached: 0, ambiguous: 0, errors: 0 });
  assert.equal([...store.txns.values()].find((t) => t.source_txn_id === "901").note, "kept the receipt");
});

test("pending rows are skipped and never stored", async () => {
  const store = memoryStore();
  const out = await run(store, [node(500), node(501, { pending: true })]);
  assert.equal(out.pending_skipped, 1);
  assert.equal(out.inserted, 1);
  assert.equal(store.txns.size, 1);
  assert.equal([...store.txns.values()].some((t) => t.source_txn_id === "501"), false);
});

test("rows missing from a later window are never deleted", async () => {
  const store = memoryStore();
  await run(store, [node(500), node(501, { amount: 3 })]);
  const out = await run(store, [node(500)], { now: LATER });
  assert.equal(out.unchanged, 1);
  assert.equal(store.txns.size, 2);
});

test("dry run reads the database but writes nothing, and reports what it would do", async () => {
  const store = memoryStore();
  const out = await run(store, [node(500), node(501, { amount: 3 })], { dryRun: true });
  assert.equal(out.inserted, 2);
  assert.deepEqual(store.writes, { accounts: 0, transactions: 0, snapshots: 0, heartbeats: 0 });
  assert.equal(store.txns.size, 0);
  assert.equal(store.accounts.size, 0);
});

test("a web account the ledger knows only by the export's 'NAME ...1234' naming reuses that account", async () => {
  const store = await ledgerWithExport();
  const accountsBefore = store.accounts.size;
  const out = await run(store, [node(910, { amount: 77, date: "2026-11-01" })]);
  assert.equal(out.accounts_created, 0);
  assert.equal(store.accounts.size, accountsBefore);
  const row = store.txns.get(rmidKey("910"));
  assert.equal(store.accounts.get(row.account_key).account_name, "Test Card ...1111");
  assert.equal(store.accounts.get(row.account_key).last_seen, "2026-11-01"); // widened by the new row
});

test("unreadable rows make the summary report errors instead of being inserted", async () => {
  const store = memoryStore();
  const out = await run(store, [node(500), node(501, { date: null }), node(502, { account: { id: gid("Account", 99) } })]);
  assert.equal(out.inserted, 1);
  assert.equal(out.errors, 2);
  assert.deepEqual(out.rejected_by_reason, { bad_date: 1, unknown_account: 1 });
});

test("a write failure surfaces as an error (nothing swallowed)", async () => {
  const store = memoryStore({ failOn: "upsertTransactions" });
  await assert.rejects(run(store, [node(500)]), /upsertTransactions failed/);
});

test("summary holds counts only: no ids, names, amounts or dates of rows", async () => {
  const store = memoryStore();
  const out = await run(store, [node(123456789, { shortName: "SECRET MERCHANT", amount: 424242 })]);
  const text = JSON.stringify(out);
  for (const leak of ["SECRET", "424242", "123456789"]) assert.equal(text.includes(leak), false);
});

// --- the function that runs inside the page --------------------------------------------------------------------
function fakeFetch(pages, { status = 200, onRequest = () => {} } = {}) {
  let call = 0;
  return async (url, init) => {
    onRequest(url, init);
    const body = JSON.parse(init.body);
    const page = pages[call++];
    return { status, ok: status >= 200 && status < 300, json: async () => (typeof page === "function" ? page(body) : page) };
  };
}
const pageOf = (nodes, next) => ({ data: { viewer: { transactions: { edges: nodes.map((n) => ({ node: n })), pageInfo: { hasNextPage: !!next, endCursor: next ?? null } } } } });
const args = (over = {}) => ({ endpoint: "https://example.invalid/graphql", query: TRANSACTIONS_QUERY, operationName: TRANSACTIONS_OPERATION, gteDate: "2026-09-13", pageSize: 200, maxPages: 5, version: "v-test", ...over });

test("pageFetchTransactions pages by cursor, sends the session cookie and the version header, and sends no mutation", async (t) => {
  const seen = [];
  t.mock.method(globalThis, "fetch", fakeFetch([pageOf([node(1), node(2)], "c1"), pageOf([node(3)], null)], { onRequest: (url, init) => seen.push({ url, init }) }));
  const out = await pageFetchTransactions(args());
  assert.equal(out.ok, true);
  assert.equal(out.rows.length, 3);
  assert.equal(seen.length, 2);
  assert.deepEqual(JSON.parse(seen[0].init.body).variables, { cursor: null, pageSize: 200, gteDate: "2026-09-13" });
  assert.equal(JSON.parse(seen[1].init.body).variables.cursor, "c1");
  assert.equal(seen[0].init.credentials, "include");
  assert.equal(seen[0].init.headers["x-truebill-web-client-version"], "v-test");
  for (const s of seen) assert.equal(isMutationRequest(s.init.body), false);
});

test("pageFetchTransactions reports failures with fixed wording and never response content", async (t) => {
  t.mock.method(globalThis, "fetch", fakeFetch([{}], { status: 401 }));
  assert.deepEqual(await pageFetchTransactions(args()), { ok: false, error: "the transactions request was refused", login: true });
  t.mock.method(globalThis, "fetch", fakeFetch([{ errors: [{ message: "private details 424242", extensions: { code: "UNAUTHENTICATED" } }] }]));
  const gql = await pageFetchTransactions(args());
  assert.equal(gql.ok, false);
  assert.equal(gql.login, true);
  assert.equal(JSON.stringify(gql).includes("424242"), false);
  t.mock.method(globalThis, "fetch", fakeFetch([{ data: { viewer: null } }]));
  assert.match((await pageFetchTransactions(args())).error, /unexpected shape/);
  t.mock.method(globalThis, "fetch", fakeFetch([{}], { status: 500 }));
  assert.match((await pageFetchTransactions(args())).error, /HTTP 500/);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("socket closed near 424242"); });
  const thrown = await pageFetchTransactions(args());
  assert.equal(thrown.ok, false);
  assert.equal(JSON.stringify(thrown).includes("424242"), false);
});

test("pageFetchTransactions stops at the page limit instead of looping forever", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({ status: 200, ok: true, json: async () => pageOf([node(1)], "again") }));
  const out = await pageFetchTransactions(args({ maxPages: 3 }));
  assert.equal(out.ok, false);
  assert.match(out.error, /page limit/);
});
