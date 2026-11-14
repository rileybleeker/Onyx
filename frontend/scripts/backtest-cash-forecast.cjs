// Backtest of the cash flow forecast engine (lib/cash-forecast.ts) on the real ledger.
// Design: docs/cash-flow-forecast.md, Section 9. Run by .github/workflows/cash-forecast-backtest.yml (manual).
//
// The Actions log is PUBLIC: this script prints only counts and percentages (errors as a share of a month of
// the cash pool's outflows), never an amount, a balance, a name, a date of a transaction or an account. A
// failure prints an error code only.
//
// Method: for each Monday between 18 months and 13 weeks ago, rebuild the cash pool's balance on that day
// (latest snapshot minus every pool transaction after it), run the forecast with only the history known on that
// day, and compare its 1-, 4- and 13-week balances with the rebuilt actual balances.
// Env: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
const { createClient } = require("@supabase/supabase-js");
const { loadTs } = require("../tests/helpers/load-ts.cjs");

const F = loadTs("lib/cash-forecast.ts");
const R = loadTs("lib/procurement-recurring.ts");
const HORIZONS = [7, 28, 91];
const PAGE = 1000;

function fail(code) {
  console.log(`FAILED: ${code}`);
  process.exit(1);
}

async function paged(db, table, cols, order) {
  const out = [];
  for (let i = 0; i < 200; i++) {
    const { data, error } = await db.from(table).select(cols).order(order, { ascending: true }).range(out.length, out.length + PAGE - 1);
    if (error) fail(`read ${table}: ${error.code || "unknown"}`);
    out.push(...(data || []));
    if (!data || data.length < PAGE) return out;
  }
  fail(`read ${table}: too many pages`);
}

async function main() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) fail("missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  const db = createClient(url, key, { db: { schema: "pds" }, auth: { persistSession: false, autoRefreshToken: false } });

  const accountsRaw = await paged(db, "finance_accounts", "account_key,institution,account_name,account_type", "account_key");
  const accounts = accountsRaw.map((a) => ({ account_key: a.account_key, account_type: a.account_type || "", label: "account" }));
  const balances = (await paged(db, "finance_balance_snapshots", "account_key,captured_at,balance_cents,currency,kind", "captured_at")).map((b) => ({
    ...b,
    balance_cents: Number(b.balance_cents),
  }));
  const txns = (await paged(db, "finance_transactions", "account_key,txn_date,name,custom_name,amount_cents,currency,category,ignored_from", "txn_date")).map((t) => ({
    ...t,
    name: t.name || "",
    amount_cents: Number(t.amount_cents),
  }));

  const poolKeys = F.poolAccountKeys(accounts);
  if (!poolKeys.length) fail("no cash accounts");
  const poolSet = new Set(poolKeys);
  const latest = new Map();
  for (const b of balances) if (poolSet.has(b.account_key) && (!latest.has(b.account_key) || b.captured_at > latest.get(b.account_key).captured_at)) latest.set(b.account_key, b);
  if (latest.size !== poolKeys.length) console.log(`note: ${poolKeys.length - latest.size} cash account(s) have no balance snapshot; treated as 0`);
  const anchor = [...latest.values()].reduce((s, b) => s + (b.kind === "liability" ? -Math.abs(b.balance_cents) : b.balance_cents), 0);
  const anchorDate = [...latest.values()].reduce((m, b) => (b.captured_at.slice(0, 10) > m ? b.captured_at.slice(0, 10) : m), "0000-00-00");
  const poolTxns = txns.filter((t) => poolSet.has(t.account_key));
  const firstPool = poolTxns.length ? poolTxns[0].txn_date : anchorDate;

  // Mondays from 18 months ago to 13 weeks ago, with at least 30 weeks of history before each.
  const asOfs = [];
  let d = R.addDays(anchorDate, -540);
  while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = R.addDays(d, 1);
  for (; d <= R.addDays(anchorDate, -92); d = R.addDays(d, 7)) if (R.daysBetween(firstPool, d) >= 210) asOfs.push(d);
  if (!asOfs.length) fail("not enough history");

  const points = [];
  const parts = { inF: [], inA: [], cardF: [], cardA: [], restF: [], restA: [], xferA: [] };
  const CARD_CAT = /credit card payment/i;
  let streamsSeen = 0;
  let cardsSeen = 0;
  for (const asOf of asOfs) {
    const known = txns.filter((t) => t.txn_date <= asOf && t.txn_date > R.addDays(asOf, -450));
    const opening = F.poolBalanceAt(poolTxns, anchor, anchorDate, asOf);
    const out = F.forecastCash({ today: asOf, accounts, txns: known, balances: [], settings: { paths: 200, openingOverride: { cents: opening, asOf } } });
    if (out.state !== "ok") continue;
    streamsSeen += out.streams.filter((s) => s.kind !== "card").length;
    cardsSeen += out.streams.filter((s) => s.kind === "card").length;
    // Scale: a month of gross pool outflows (transfers between the owner's own accounts left out).
    const since = R.addDays(asOf, -182);
    const gross = poolTxns
      .filter((t) => t.txn_date > since && t.txn_date <= asOf && t.amount_cents > 0 && !/internal transfers|savings transfer/i.test(t.category || ""))
      .reduce((s, t) => s + t.amount_cents, 0);
    const scale = gross / 6;
    // 13-week breakdown (shares of the scale): money in, card payments, everything else.
    if (scale > 0) {
      const end = R.addDays(asOf, 91);
      const fl = out.lines.filter((l) => l.date <= end);
      const sum = (xs) => xs.reduce((a, b) => a + b, 0);
      const isCardLine = (l) => out.streams.some((s) => s.kind === "card" && s.id === l.sourceId);
      parts.inF.push(sum(fl.filter((l) => l.amountCents > 0 && l.layer !== "baseline").map((l) => l.amountCents)) / scale);
      parts.cardF.push(sum(fl.filter(isCardLine).map((l) => l.amountCents)) / scale);
      parts.restF.push(sum(fl.filter((l) => !isCardLine(l) && !(l.amountCents > 0 && l.layer !== "baseline")).map((l) => l.amountCents)) / scale);
      const fut = poolTxns.filter((t) => t.txn_date > asOf && t.txn_date <= end);
      const delta = (t) => -t.amount_cents;
      const isIn = (t) => delta(t) > 0 && !/transfer|credit card payment/i.test(t.category || "");
      parts.inA.push(sum(fut.filter(isIn).map(delta)) / scale);
      parts.cardA.push(sum(fut.filter((t) => delta(t) < 0 && CARD_CAT.test(t.category || "")).map(delta)) / scale);
      parts.restA.push(sum(fut.filter((t) => !isIn(t) && !(delta(t) < 0 && CARD_CAT.test(t.category || ""))).map(delta)) / scale);
      parts.xferA.push(sum(fut.filter((t) => /transfer/i.test(t.category || "")).map(delta)) / scale);
    }
    for (const h of HORIZONS) {
      const day = out.days[h - 1];
      if (!day) continue;
      const actual = F.poolBalanceAt(poolTxns, anchor, anchorDate, R.addDays(asOf, h));
      points.push({ horizonDays: h, likely: day.likely, low: day.low, high: day.high, actual, scale });
    }
  }

  console.log(`as-of dates: ${asOfs.length} (weekly, from about 18 months to 13 weeks before the latest balance)`);
  console.log(`cash accounts in the pool: ${poolKeys.length}`);
  console.log(`detected streams per run (avg): ${(streamsSeen / asOfs.length).toFixed(1)}; card payment streams per run (avg): ${(cardsSeen / asOfs.length).toFixed(1)}`);
  console.log("errors are a share of one month of the pool's outflows; positive = forecast too high");
  console.log("horizon | runs | median |error| | mean error | actual below low band | actual above high band");
  for (const s of F.summarizeBacktest(points)) {
    console.log(
      `${String(s.horizonDays).padStart(3)} days | ${String(s.n).padStart(4)} | ${String(s.medianAbsErrorPct).padStart(6)}% | ${String(s.meanErrorPct).padStart(6)}% | ${String(s.belowLowPct).padStart(5)}% | ${String(s.aboveHighPct).padStart(5)}%`,
    );
  }
  console.log("target for the bands: about 10% below the low band and 10% above the high band");
  const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 10 : 0);
  console.log("13-week breakdown, mean over runs, % of one month of outflows (forecast | actual):");
  console.log(`  money in (deposits, not transfers): ${avg(parts.inF)}% | ${avg(parts.inA)}%`);
  console.log(`  card payments:                      ${avg(parts.cardF)}% | ${avg(parts.cardA)}%`);
  console.log(`  everything else (net):              ${avg(parts.restF)}% | ${avg(parts.restA)}%`);
  console.log(`    of which transfers (net, actual):            ${avg(parts.xferA)}%`);
}

main().catch((e) => fail(e && e.code ? String(e.code) : e && e.name ? e.name : "error"));
