// Synthetic data only: this repository is public.
import test from "node:test";
import assert from "node:assert/strict";
import { SYNTHETIC_HEADER, syntheticCsv } from "./memory-store.mjs";
import {
  accountKey,
  canonicalColumn,
  lastFour,
  normalizeBalances,
  normalizeRows,
  parseCsv,
  rowsFromCsv,
  safeError,
  toBool,
  toCents,
  toIsoDate,
  txnKey,
} from "../lib/normalize.mjs";

test("parseCsv handles quoted commas, doubled quotes, embedded newlines, CRLF and a BOM", () => {
  const t = parseCsv('﻿a,b,c\r\n1,"x, y","say ""hi"""\r\n2,"line1\nline2",\r\n\r\n');
  assert.deepEqual(t, [
    ["a", "b", "c"],
    ["1", "x, y", 'say "hi"'],
    ["2", "line1\nline2", ""],
  ]);
});

test("parseCsv rejects a file that ends inside a quote", () => {
  assert.throws(() => parseCsv('a,b\n1,"oops'), /quoted field/);
});

test("rowsFromCsv maps columns by header name, in any order and case", () => {
  const csv = "amount,NAME,institution name,account name,account type,date\n9.99,Thing,Bank X,Acct,Credit Card,2026-02-01\n";
  const { rows, malformed } = rowsFromCsv(csv);
  assert.equal(malformed, 0);
  assert.deepEqual(rows[0], { Amount: "9.99", Name: "Thing", "Institution Name": "Bank X", "Account Name": "Acct", "Account Type": "Credit Card", Date: "2026-02-01" });
});

test("rowsFromCsv refuses a file without the required columns and drops misaligned rows", () => {
  assert.throws(() => rowsFromCsv("Date,Name\n2026-01-01,x\n"), /missing required column/);
  const { rows, malformed } = rowsFromCsv(`${SYNTHETIC_HEADER}\n2026-01-05,too,few\n`);
  assert.equal(rows.length, 0);
  assert.equal(malformed, 1);
});

test("canonicalColumn tolerates spelling variants", () => {
  assert.equal(canonicalColumn("transaction_tags"), "Transaction Tags");
  assert.equal(canonicalColumn("Tags"), "Transaction Tags");
  assert.equal(canonicalColumn("whatever"), null);
});

test("toCents is exactly round(amount*100), sign preserved, no float drift", () => {
  const cases = [
    ["4.50", 450],
    ["-2500.00", -250000],
    ["0.29", 29], // 0.29 * 100 === 28.999999999999996 in floating point
    ["19.99", 1999],
    ["1.005", 101], // third decimal rounds half away from zero
    ["-1.005", -101],
    ["1,234.50", 123450],
    ["$5", 500],
    ["(7.25)", -725],
    ["-0.00", 0],
    ["12", 1200],
    [".5", 50],
  ];
  for (const [input, want] of cases) assert.equal(toCents(input), want, `toCents(${input})`);
  assert.equal(Object.is(toCents("-0.00"), -0), false);
  assert.equal(toCents(19.99), 1999);
  assert.equal(toCents(-0.1), -10);
  for (const bad of ["", "abc", "1.2.3", null, undefined, "--1"]) assert.equal(toCents(bad), null, `toCents(${bad})`);
});

test("toIsoDate accepts ISO and US dates and rejects impossible ones", () => {
  assert.equal(toIsoDate("2026-11-11"), "2026-11-11");
  assert.equal(toIsoDate("2026-11-11T05:00:00.000Z"), "2026-11-11");
  assert.equal(toIsoDate("2/9/2026"), "2026-02-09");
  assert.equal(toIsoDate("2024-02-29"), "2024-02-29");
  for (const bad of ["2026-02-30", "2026-13-01", "11-11-2026", "", null, "yesterday"]) assert.equal(toIsoDate(bad), null, String(bad));
});

test("lastFour keeps at most four digits, never more", () => {
  assert.equal(lastFour("7759"), "7759");
  assert.equal(lastFour("****1234"), "1234");
  assert.equal(lastFour("1234567890123456"), "3456");
  assert.equal(lastFour("x-0042"), "0042");
  assert.equal(lastFour(42), "0042");
  assert.equal(lastFour(""), null);
  assert.equal(lastFour("****"), null);
  assert.equal(lastFour(null), null);
});

test("normalizeRows never emits more than four characters of an account number", () => {
  const { accounts } = normalizeRows([
    { Date: "2026-01-01", "Account Type": "Cash", "Account Name": "A", "Account Number": "9876543210987654", "Institution Name": "B", Name: "n", Amount: "1" },
  ]);
  assert.equal(accounts[0].mask, "7654");
  assert.equal(JSON.stringify(accounts).includes("98765432"), false);
});

test("toBool", () => {
  assert.equal(toBool("true"), true);
  assert.equal(toBool("No"), false);
  assert.equal(toBool(""), null);
  assert.equal(toBool("maybe"), null);
});

test("accountKey is stable, 24 hex, case/space-insensitive and sensitive to the mask", () => {
  const base = { institution: "Test Bank", account_type: "Credit Card", account_name: "Test Card ...1111", mask: "1111" };
  const k = accountKey(base);
  assert.match(k, /^[0-9a-f]{24}$/);
  assert.equal(accountKey({ ...base, institution: "  test bank " }), k);
  assert.notEqual(accountKey({ ...base, mask: "2222" }), k);
  assert.notEqual(accountKey({ ...base, mask: null }), k);
});

test("normalizeRows: identical rows get ordinals 1..n and distinct keys; key ignores category and note", () => {
  const { rows } = rowsFromCsv(syntheticCsv());
  const first = normalizeRows(rows);
  assert.equal(first.inputRows, 5);
  assert.equal(first.rejectedTotal, 0);
  assert.equal(first.accounts.length, 3);
  const coffee = first.transactions.filter((t) => t.name === "ACME COFFEE");
  assert.equal(coffee.length, 2);
  assert.notEqual(coffee[0].txn_key, coffee[1].txn_key);
  assert.equal(new Set(first.transactions.map((t) => t.txn_key)).size, 5);
  for (const t of first.transactions) assert.match(t.txn_key, /^[0-9a-f]{32}$/);

  // the same file with a different category, note and tags produces the same keys
  const edited = rows.map((r) => ({ ...r, Category: "Recategorized", Note: "edited", "Transaction Tags": "x", "Custom Name": "y" }));
  const second = normalizeRows(edited);
  assert.deepEqual(second.transactions.map((t) => t.txn_key), first.transactions.map((t) => t.txn_key));
  assert.equal(second.transactions[0].category, "Recategorized");
});

test("normalizeRows: the ordinal matches the documented formula", () => {
  const { rows } = rowsFromCsv(syntheticCsv());
  const [a, b] = normalizeRows(rows).transactions;
  const account_key = accountKey({ institution: "Test Bank", account_type: "Credit Card", account_name: "Test Card ...1111", mask: "1111" });
  const expect = (ordinal) => txnKey({ account_key, txn_date: "2026-01-05", original_date: "2026-01-04", name: "ACME COFFEE", amount_cents: 450, ordinal });
  assert.equal(a.txn_key, expect(1));
  assert.equal(b.txn_key, expect(2));
});

test("normalizeRows: quoting, cents, signs and blanks", () => {
  const { rows } = rowsFromCsv(syntheticCsv());
  const { transactions, accounts } = normalizeRows(rows);
  const widgets = transactions.find((t) => t.name === "WIDGETS, INC");
  assert.equal(widgets.amount_cents, 1234);
  assert.equal(widgets.description, 'WIDGETS "PRO"');
  assert.equal(widgets.note, "line one\nline two");
  assert.equal(widgets.tax_deductible, true);
  assert.equal(widgets.tags, "tag a");
  assert.equal(widgets.custom_name, "Widgets");
  assert.equal(transactions.find((t) => t.name === "PAYROLL TEST CO").amount_cents, -250000);
  const coffee = transactions[0];
  assert.equal(coffee.custom_name, null);
  assert.equal(coffee.note, null);
  assert.equal(coffee.tax_deductible, null);
  assert.equal(coffee.currency, "USD");
  const wallet = accounts.find((a) => a.institution === "Test Wallet");
  assert.equal(wallet.mask, null);
  assert.equal(wallet.first_seen, "2026-01-08");
  const card = accounts.find((a) => a.mask === "1111");
  assert.equal(card.first_seen, "2026-01-05");
});

test("normalizeRows counts rejected rows by reason without echoing any of their content", () => {
  const good = { Date: "2026-01-01", "Account Type": "Cash", "Account Name": "A", "Institution Name": "B", Name: "n", Amount: "1" };
  const out = normalizeRows([
    good,
    { ...good, Date: "2026-02-31" },
    { ...good, Amount: "not money SECRET" },
    { ...good, "Account Name": "" },
    { ...good, "Original Date": "garbage" },
  ]);
  assert.equal(out.transactions.length, 1);
  assert.equal(out.rejectedTotal, 4);
  assert.deepEqual(out.rejected, { bad_date: 1, bad_amount: 1, missing_account: 1, bad_original_date: 1 });
  assert.equal(JSON.stringify(out.rejected).includes("SECRET"), false);
});

test("normalizeBalances validates entries and de-duplicates (account, captured_at)", () => {
  const e = { institution: "Test Brokerage", account_name: "Test IRA", account_type: "Investment", mask: "000012345678", balance_cents: 1234567, currency: "usd", kind: "asset", captured_at: "2026-11-12T10:00:00-05:00" };
  const out = normalizeBalances([
    e,
    { ...e, balance_cents: 7 }, // same account + instant: last one wins
    { ...e, account_name: "" },
    { ...e, balance_cents: 1.5 },
    { ...e, kind: "weird" },
    { ...e, captured_at: "nope" },
    { ...e, currency: "dollars" },
  ]);
  assert.equal(out.snapshots.length, 1);
  assert.equal(out.snapshots[0].balance_cents, 7);
  assert.equal(out.snapshots[0].captured_at, "2026-11-12T15:00:00.000Z");
  assert.equal(out.snapshots[0].currency, "USD");
  assert.equal(out.accounts[0].mask, "5678");
  assert.deepEqual(out.rejected, { missing_account: 1, bad_balance: 1, bad_kind: 1, bad_captured_at: 1, bad_currency: 1 });
});

test("safeError masks quoted fragments, long digit runs and key-shaped tokens", () => {
  const e = new Error('invalid input syntax for type date: "SECRET MERCHANT 99999999" key sb_secret_abcDEF123 acct 1234567890');
  e.code = "22007";
  const s = safeError(e);
  assert.match(s, /^\[22007\]/);
  assert.equal(/SECRET|sb_secret|1234567890/.test(s), false);
  assert.ok(s.length <= 200);
});
