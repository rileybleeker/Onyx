// Run: node --test tests/finance-budgets-page-data.test.cjs
// The budgets loader reads its transactions with speculative pages (fetchPaged `speculate`), so a long history
// takes one round trip for the first pages instead of two in a row. Source-text check; SYNTHETIC DATA ONLY.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");
const read = (...parts) => fs.readFileSync(path.join(SRC, ...parts), "utf8");

test("budgets transaction read passes a speculate count to fetchPaged", () => {
  const src = read("lib", "finance-budgets-server.ts");
  assert.match(src, /const TXN_SPECULATE_PAGES = 3;/);
  assert.match(src, /\.range\(f, t\), 40, TXN_SPECULATE_PAGES\)/);
});

test("budgets loader keeps its independent reads in one Promise.all and its column list", () => {
  const src = read("lib", "finance-budgets-server.ts");
  assert.match(src, /const \[rows, fixes, budgetsRes\] = await Promise\.all\(\[/);
  assert.match(src, /const COLS = "txn_key,account_key,txn_date,name,custom_name,amount_cents,currency,category,ignored_from";/);
});

test("the speculative read stays in the shared fetchPaged helper (same error and ordering rules)", () => {
  const ledger = read("lib", "finance-ledger-server.ts");
  assert.match(ledger, /export async function fetchPaged\(/);
  assert.match(ledger, /speculate = 0,/);
  assert.match(ledger, /if \(!got\.ok\) throw got\.err;/);
});
