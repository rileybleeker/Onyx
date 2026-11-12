// Run: node --test tests/finance-ledger-server.test.cjs
// The server fetcher (lib/finance-ledger-server.ts) run against an in-memory stand-in for
// supabase-js: filters, ordering, 1000-row paging, PostgREST row caps, the out-of-range 416, and
// error handling. SYNTHETIC DATA ONLY (invented accounts and merchants); no network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");

const L = loadTs("lib/finance-ledger.ts");

const SERVICE_KEY = "test-service-role-key";
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;

/** Minimal PostgREST stand-in: eq / gte / lt / or(ilike, eq) / order / limit / range / count. */
function makeDb({ accounts = [], txns = [], snaps = [], beats = [], maxRows = 1000, failTable = null, failCode = "57014" }) {
  const calls = [];
  const tables = { finance_accounts: accounts, finance_transactions: txns, finance_balance_snapshots: snaps, sync_log: beats };
  const created = [];
  const client = {
    from(table) {
      const st = { table, cols: null, count: false, filters: [], orders: [], limit: null, range: null };
      const b = {
        select(cols, opts) { st.cols = cols; st.count = opts && opts.count === "exact"; return b; },
        eq(c, v) { st.filters.push((r) => r[c] === v); return b; },
        gte(c, v) { st.filters.push((r) => r[c] >= v); return b; },
        lt(c, v) { st.filters.push((r) => r[c] < v); return b; },
        not() { return b; },
        or(expr) {
          const tests = expr.split(",").map((part) => {
            const m = /^(\w+)\.(ilike|eq)\.(.*)$/.exec(part);
            assert.ok(m, `unparseable or-part ${part}`);
            const [, col, op, val] = m;
            if (op === "eq") return (r) => String(r[col]) === val;
            const needle = val.replace(/^\*|\*$/g, "").toLowerCase();
            return (r) => String(r[col] ?? "").toLowerCase().includes(needle);
          });
          st.filters.push((r) => tests.some((t) => t(r)));
          return b;
        },
        order(c, o) { st.orders.push([c, !(o && o.ascending === false)]); return b; },
        limit(n) { st.limit = n; return b; },
        range(from, to) { st.range = [from, to]; return b; },
        then(resolve, reject) {
          calls.push({ table, cols: st.cols, count: st.count });
          if (failTable === table) return Promise.resolve({ data: null, error: { code: failCode, message: "boom with a secret merchant name" }, count: null }).then(resolve, reject);
          let rows = tables[table].filter((r) => st.filters.every((f) => f(r)));
          for (const [c, asc] of [...st.orders].reverse()) {
            rows = [...rows].sort((x, y) => (x[c] < y[c] ? -1 : x[c] > y[c] ? 1 : 0) * (asc ? 1 : -1));
          }
          const total = rows.length;
          if (st.range) {
            const [from, to] = st.range;
            if (total > 0 && from >= total) return Promise.resolve({ data: null, error: { code: "PGRST103", message: "Requested range not satisfiable" }, count: null }).then(resolve, reject);
            rows = rows.slice(from, Math.min(to + 1, from + maxRows));
          }
          if (st.limit != null) rows = rows.slice(0, st.limit);
          if (st.cols) rows = rows.map((r) => Object.fromEntries(st.cols.split(",").map((c) => [c, r[c]])));
          return Promise.resolve({ data: rows, error: null, count: st.count ? total : null }).then(resolve, reject);
        },
      };
      return b;
    },
  };
  const stubs = {
    "server-only": {},
    "@supabase/supabase-js": { createClient: (url, key, opts) => { created.push({ url, key, opts }); return client; } },
  };
  return { stubs, calls, created };
}
const load = (db) => loadTs("lib/finance-ledger-server.ts", db.stubs);

const NOW = new Date("2030-03-15T12:00:00Z");
const hoursAgo = (n) => new Date(NOW.getTime() - n * 3_600_000).toISOString();
const acct = (key, over = {}) => ({ account_key: key, institution: "Demo Bank", account_name: `Account ${key}`, account_type: "Checking", mask: null, source: "rocketmoney", ...over });

/** Deterministic synthetic ledger: 14 months x ~170 rows across two accounts. */
function synthTxns() {
  const out = [];
  let n = 0;
  for (let mi = 0; mi < 14; mi++) {
    const month = L.shiftMonth("2030-03", mi - 13);
    for (let d = 1; d <= 28; d++) {
      for (let k = 0; k < 6; k++) {
        n++;
        const kind = n % 11;
        out.push({
          txn_key: `t${String(n).padStart(6, "0")}`,
          account_key: n % 3 === 0 ? "a2" : "a1",
          txn_date: `${month}-${String(d).padStart(2, "0")}`,
          original_date: null,
          name: kind === 0 ? "Demo Market" : `Merchant ${n % 7}`,
          custom_name: null,
          amount_cents: kind === 1 ? -50000 : kind === 2 ? 20000 : 100 + (n % 13) * 10,
          currency: "USD",
          category: kind === 2 ? "Credit Card Payment" : kind === 1 ? "Income" : kind === 3 ? "Internal Transfers" : kind === 0 ? "Groceries" : "Fun",
          description: null,
          ignored_from: kind === 4 ? "budget" : null,
        });
      }
    }
  }
  return out;
}
const TXNS = synthTxns();
const base = { accounts: [acct("a1"), acct("a2", { account_type: "Credit Card", account_name: "Card" })], txns: TXNS };
const q = (over = {}) => ({ month: null, account: null, q: "", page: 1, allMonths: false, ...over });

/** Independent re-computation of one month's flows from the raw rows (no shared code). */
function expectedFlows(month, account) {
  let inn = 0, out = 0;
  for (const r of TXNS) {
    if (!r.txn_date.startsWith(month) || (account && r.account_key !== account)) continue;
    if (r.ignored_from && r.ignored_from.trim()) continue;
    if (["Internal Transfers", "Credit Card Payment", "Savings Transfer"].includes(r.category)) continue;
    if (r.amount_cents > 0) out += r.amount_cents; else inn += -r.amount_cents;
  }
  return { inn, out };
}

test("an empty ledger is its own state, with the heartbeat if one exists", async () => {
  const none = await load(makeDb({})).loadLedger(q(), NOW);
  assert.deepEqual(none, { kind: "empty", freshness: null });
  const ran = await load(makeDb({ beats: [{ source: "rocketmoney", data_type: "transactions", status: "failed", sync_start: hoursAgo(1), records_synced: 0, duration_seconds: 1, error_message: "Login required" }] })).loadLedger(q(), NOW);
  assert.equal(ran.kind, "empty");
  assert.equal(ran.freshness.status, "failed");
  assert.equal(ran.freshness.errorMessage, "Login required");
});

test("default month is the newest with data; flows, trend and month list match an independent sum", async () => {
  const db = makeDb({ ...base, maxRows: 700 }); // PostgREST row cap below 1000: paging must still read everything
  const res = await load(db).loadLedger(q(), NOW);
  assert.equal(res.kind, "ok");
  const d = res.data;
  assert.equal(d.query.month, "2030-03");
  const exp = expectedFlows("2030-03");
  assert.equal(d.flows.moneyInCents, exp.inn);
  assert.equal(d.flows.moneyOutCents, exp.out);
  assert.equal(d.trend.length, 12);
  assert.equal(d.trend[11].month, "2030-03");
  assert.equal(d.trend[0].month, "2029-04");
  for (const p of d.trend) assert.equal(p.outCents, expectedFlows(p.month).out, p.month);
  assert.equal(d.months[0], "2030-03");
  assert.equal(d.months[d.months.length - 1], "2029-02", "oldest month with data");
  assert.equal(d.windowTruncated, false);
  assert.equal(d.skippedRows, 0);
  const windowReads = db.calls.filter((c) => c.table === "finance_transactions" && c.cols === "account_key,txn_date,amount_cents,currency,category,ignored_from");
  assert.ok(windowReads.length >= 3, "the window was read in several capped pages");
});

test("account filter narrows every figure; an unknown account is ignored", async () => {
  const d = (await load(makeDb(base)).loadLedger(q({ account: "a2" }), NOW)).data;
  const exp = expectedFlows("2030-03", "a2");
  assert.equal(d.flows.moneyOutCents, exp.out);
  assert.equal(d.query.account, "a2");
  assert.ok(d.list.rows.every((r) => r.account_key === "a2"));
  const unknown = (await load(makeDb(base)).loadLedger(q({ account: "ffff" }), NOW)).data;
  assert.equal(unknown.query.account, null);
});

test("another month, and a month with no transactions still renders", async () => {
  const d = (await load(makeDb(base)).loadLedger(q({ month: "2029-06" }), NOW)).data;
  assert.equal(d.flows.moneyOutCents, expectedFlows("2029-06").out);
  const quiet = (await load(makeDb(base)).loadLedger(q({ month: "2031-01" }), NOW)).data;
  assert.equal(quiet.flows.counted, 0);
  assert.equal(quiet.list.total, 0);
  assert.ok(quiet.months.includes("2031-01"), "the selected month is always pickable");
});

test("list paging: 50 per page, newest first, stable order, correct totals, page clamp", async () => {
  const mk = () => load(makeDb(base));
  const total = TXNS.filter((r) => r.txn_date.startsWith("2030-03")).length;
  const p1 = (await mk().loadLedger(q(), NOW)).data.list;
  assert.equal(p1.total, total);
  assert.equal(p1.rows.length, 50);
  assert.equal(p1.pageCount, Math.ceil(total / 50));
  const keys = p1.rows.map((r) => [r.txn_date, r.txn_key]);
  assert.deepEqual(keys, [...keys].sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? 1 : -1)));
  const p2 = (await mk().loadLedger(q({ page: 2 }), NOW)).data.list;
  assert.equal(p2.page, 2);
  assert.equal(new Set([...p1.rows, ...p2.rows].map((r) => r.txn_key)).size, 100, "no row on two pages");
  const last = (await mk().loadLedger(q({ page: p1.pageCount }), NOW)).data.list;
  assert.equal(last.rows.length, total - 50 * (p1.pageCount - 1));
  const past = (await mk().loadLedger(q({ page: 99 }), NOW)).data;
  assert.equal(past.pageClamped, true);
  assert.equal(past.list.page, 1);
  assert.equal(past.list.rows.length, 50);
});

test("list rows are labelled spending / transfer / ignored and use the custom name when present", async () => {
  const txns = [
    { txn_key: "k1", account_key: "a1", txn_date: "2030-03-03", name: "RAW NAME", custom_name: "Nice Name", amount_cents: 500, currency: "USD", category: "Fun", ignored_from: null },
    { txn_key: "k2", account_key: "a1", txn_date: "2030-03-02", name: "Card pay", custom_name: null, amount_cents: 900, currency: "USD", category: "Credit Card Payment", ignored_from: null },
    { txn_key: "k3", account_key: "a1", txn_date: "2030-03-01", name: "Hidden", custom_name: "", amount_cents: 100, currency: "USD", category: "Fun", ignored_from: "budget" },
  ];
  const rows = (await load(makeDb({ accounts: [acct("a1")], txns })).loadLedger(q(), NOW)).data.list.rows;
  assert.deepEqual(rows.map((r) => [r.title, r.excluded]), [["Nice Name", null], ["Card pay", "transfer"], ["Hidden", "ignored"]]);
});

test("search matches names, categories and amounts of either sign; 'all months' ignores the picker", async () => {
  const db = () => load(makeDb(base));
  const byName = (await db().loadLedger(q({ q: "demo market" }), NOW)).data.list;
  assert.ok(byName.total > 0 && byName.rows.every((r) => r.title.toLowerCase().includes("demo market")));
  assert.ok(byName.rows.every((r) => r.txn_date.startsWith("2030-03")));
  const everywhere = (await db().loadLedger(q({ q: "demo market", allMonths: true }), NOW)).data.list;
  assert.ok(everywhere.total > byName.total);
  const byAmount = (await db().loadLedger(q({ q: "$500.00", allMonths: true }), NOW)).data.list;
  assert.ok(byAmount.total > 0 && byAmount.rows.every((r) => Math.abs(r.amount_cents) === 50000));
  const none = (await db().loadLedger(q({ q: "zzzz nothing" }), NOW)).data.list;
  assert.equal(none.total, 0);
  assert.deepEqual(none.rows, []);
});

test("balances: newest snapshot per account, net worth from them", async () => {
  const snaps = [
    { account_key: "a1", captured_at: hoursAgo(30), balance_cents: 111, currency: "USD", kind: "asset" },
    { account_key: "a1", captured_at: hoursAgo(3), balance_cents: 300000, currency: "USD", kind: "asset" },
    { account_key: "a2", captured_at: hoursAgo(3), balance_cents: 50000, currency: "USD", kind: "liability" },
  ];
  const d = (await load(makeDb({ ...base, snaps })).loadLedger(q(), NOW)).data;
  assert.equal(d.netWorth.netWorthCents, 250000);
  assert.equal(d.netWorth.staleCount, 0);
  const none = (await load(makeDb(base)).loadLedger(q(), NOW)).data;
  assert.equal(none.netWorth.noBalance.length, 2, "no snapshots yet: accounts listed, nothing invented");
  assert.equal(none.netWorth.includedCount, 0);
});

test("rows that cannot be read are skipped and counted, never silently counted as zero", async () => {
  const txns = [
    { txn_key: "k1", account_key: "a1", txn_date: "2030-03-03", name: "ok", custom_name: null, amount_cents: 700, currency: "USD", category: "Fun", ignored_from: null },
    { txn_key: "k2", account_key: "a1", txn_date: "2030-03-02", name: "bad amount", custom_name: null, amount_cents: null, currency: "USD", category: "Fun", ignored_from: null },
    { txn_key: "k3", account_key: "ghost", txn_date: "2030-03-01", name: "orphan", custom_name: null, amount_cents: 100, currency: "USD", category: "Fun", ignored_from: null },
  ];
  const d = (await load(makeDb({ accounts: [acct("a1")], txns })).loadLedger(q(), NOW)).data;
  assert.equal(d.flows.moneyOutCents, 800, "the unreadable amount is not added; the orphan's valid amount is");
  assert.ok(d.skippedRows >= 2);
  assert.equal(d.list.rows.length, 1);
});

test("a failed query is an error state that logs only a code - never a row, name or search term", async () => {
  const seen = [];
  const orig = console.error;
  console.error = (...a) => seen.push(a.map(String).join(" "));
  try {
    for (const [code, expect] of [["57014", /code 57014/], ["42P01", /missing or not readable/], ["PGRST205", /missing or not readable/]]) {
      const res = await load(makeDb({ ...base, failTable: "finance_accounts", failCode: code })).loadLedger(q({ q: "private search" }), NOW);
      assert.equal(res.kind, "error");
      assert.equal(res.message, "Couldn't load the ledger.");
      assert.match(res.hint, expect);
      assert.doesNotMatch(JSON.stringify(res), /secret merchant|private search/);
    }
    const mid = await load(makeDb({ ...base, failTable: "finance_balance_snapshots" })).loadLedger(q(), NOW);
    assert.equal(mid.kind, "error", "any failed read fails the page rather than showing partial money");
  } finally {
    console.error = orig;
  }
  assert.ok(seen.length >= 4);
  for (const line of seen) assert.doesNotMatch(line, /secret merchant|private search|Demo Market|Account a/, line);
});

test("credentials: service role only, pds schema, not configured is reported without throwing", async () => {
  const db = makeDb(base);
  await load(db).loadLedger(q(), NOW);
  assert.equal(db.created.length, 1);
  assert.equal(db.created[0].key, SERVICE_KEY);
  assert.equal(db.created[0].opts.db.schema, "pds");
  assert.equal(db.created[0].opts.auth.persistSession, false);
  const saved = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const origErr = console.error;
  console.error = () => {};
  try {
    const res = await load(makeDb(base)).loadLedger(q(), NOW);
    assert.equal(res.kind, "error");
    assert.match(res.hint, /no Supabase service credentials/);
  } finally {
    console.error = origErr;
    process.env.SUPABASE_SERVICE_ROLE_KEY = saved;
  }
});

test("every read lists its columns - none selects everything", async () => {
  const db = makeDb({ ...base, snaps: [{ account_key: "a1", captured_at: hoursAgo(1), balance_cents: 1, currency: "USD", kind: "asset" }] });
  await load(db).loadLedger(q({ q: "x" }), NOW);
  assert.ok(db.calls.length > 5);
  for (const c of db.calls) {
    assert.ok(c.cols && c.cols !== "*" && !c.cols.includes("*"), `${c.table}: ${c.cols}`);
  }
});
