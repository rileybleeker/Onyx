// Synthetic rows only. The per-account activity cap in finance-holdings-server.ts: one busy account must not push
// another account's rows out of the read, and each account keeps its newest rows (the query orders newest first).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");

const mod = loadTs("lib/finance-holdings-server.ts", {
  "server-only": {},
  "@/lib/finance-service-client": { serviceClient: () => {
    throw new Error("not used here");
  } },
  "@/lib/finance-ledger": { accountLabel: (r) => r.account_name },
});

function row(account, n) {
  // Higher n = newer, and the input is already newest first, as the query returns it.
  return { txn_key: `${account}-${String(n).padStart(4, "0")}`, account_key: account, txn_date: "2026-11-01", amount_cents: n, name: null, currency: "USD" };
}

test("capActivityPerAccount keeps each account's newest rows and does not let one account crowd out another", () => {
  const input = [];
  for (let n = 150; n >= 1; n--) input.push(row("busy", n)); // 150 rows, newest first
  input.push(row("quiet", 9), row("quiet", 3));              // 2 rows for another account, interleaved after

  const out = mod.capActivityPerAccount(input, 100);

  assert.equal(out.get("busy").length, 100, "busy account is capped at the per-account bound");
  assert.equal(out.get("busy")[0].amount_cents, 150, "the kept rows are the newest ones");
  assert.equal(out.get("busy")[99].amount_cents, 51);
  assert.equal(out.get("quiet").length, 2, "the quiet account keeps all its rows");
});

test("capActivityPerAccount returns nothing for an account with no rows", () => {
  const out = mod.capActivityPerAccount([], 100);
  assert.equal(out.get("anyone"), undefined);
});
