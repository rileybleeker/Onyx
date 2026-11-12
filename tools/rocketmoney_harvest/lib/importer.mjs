// Import logic shared by import-csv / import-rows / import-balances. Talks only to a `store`
// (lib/store.mjs), so tests run it against an in-memory fake. Summaries are COUNTS ONLY.
import { TXN_COMPARE_COLUMNS } from "./store.mjs";
import { normalizeBalances, normalizeRows } from "./normalize.mjs";

const same = (a, b) => (a ?? null) === (b ?? null) || (a != null && b != null && String(a) === String(b));
const minDate = (a, b) => (a == null ? b : b == null ? a : a < b ? a : b);
const maxDate = (a, b) => (a == null ? b : b == null ? a : a > b ? a : b);

/**
 * rawRows: array of objects keyed by the Rocket Money export column names. Must be the COMPLETE export
 * (ordinals for identical rows depend on seeing every row of the group).
 * Re-running is idempotent: same keys, nothing duplicated. Rows missing from a later export are never deleted.
 */
export async function importTransactions(rawRows, { store, dryRun = false, now = new Date() }) {
  const norm = normalizeRows(rawRows);
  const nowIso = now.toISOString();

  const existingAccounts = new Map((await store.getAccounts()).map((a) => [a.account_key, a]));
  const accountRows = norm.accounts.map((a) => {
    const e = existingAccounts.get(a.account_key);
    return { ...a, first_seen: minDate(e?.first_seen, a.first_seen), last_seen: maxDate(e?.last_seen, a.last_seen), updated_at: nowIso };
  });

  const existing = new Map((await store.getTransactions()).map((r) => [r.txn_key, r]));
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  for (const row of norm.transactions) {
    const e = existing.get(row.txn_key);
    if (!e) inserted++;
    else if (TXN_COMPARE_COLUMNS.every((c) => same(e[c], row[c]))) skipped++;
    else updated++;
  }

  if (!dryRun && norm.transactions.length) {
    await store.upsertAccounts(accountRows); // before transactions: finance_transactions.account_key is a foreign key
    // last_seen_at is bumped on every present row; first_seen_at is left out so it keeps its insert-time default.
    await store.upsertTransactions(norm.transactions.map((r) => ({ ...r, last_seen_at: nowIso })));
  }

  const dates = norm.transactions.map((r) => r.txn_date).sort();
  return {
    rows: norm.inputRows,
    accounts: norm.accounts.length,
    inserted,
    updated,
    skipped,
    errors: norm.rejectedTotal,
    rejected_by_reason: norm.rejected,
    date_min: dates[0] ?? null,
    date_max: dates[dates.length - 1] ?? null,
  };
}

/**
 * entries: [{institution, account_name, account_type, mask, balance_cents, currency, kind, captured_at}].
 * An unseen account is created. An account whose exact key is unknown but whose institution + mask match exactly
 * one existing account (the balances page may name it differently than the export does) reuses that account.
 */
export async function importBalances(entries, { store, dryRun = false, now = new Date() }) {
  const norm = normalizeBalances(entries);
  const nowIso = now.toISOString();
  const existing = await store.getAccounts();
  const byKey = new Map(existing.map((a) => [a.account_key, a]));

  const remap = new Map(); // key derived from the balance entry -> key of the account it belongs to
  const toCreate = [];
  let matchedExisting = 0;
  for (const a of norm.accounts) {
    if (byKey.has(a.account_key)) {
      matchedExisting++;
      continue;
    }
    const candidates = a.mask
      ? existing.filter((x) => x.mask === a.mask && String(x.institution).trim().toLowerCase() === a.institution.toLowerCase())
      : [];
    if (candidates.length === 1) {
      remap.set(a.account_key, candidates[0].account_key);
      matchedExisting++;
    } else {
      toCreate.push({ ...a, first_seen: null, last_seen: null, updated_at: nowIso });
    }
  }

  const snapshotMap = new Map();
  for (const s of norm.snapshots) {
    const account_key = remap.get(s.account_key) ?? s.account_key;
    snapshotMap.set(`${account_key}|${s.captured_at}`, { ...s, account_key });
  }
  const snapshots = [...snapshotMap.values()];

  let inserted = snapshots.length; // dry run: upper bound (duplicates of existing snapshots are not looked up)
  if (!dryRun && snapshots.length) {
    if (toCreate.length) await store.upsertAccounts(toCreate);
    inserted = await store.insertSnapshots(snapshots);
  }
  return {
    rows: norm.inputRows,
    accounts: new Set(snapshots.map((s) => s.account_key)).size,
    accounts_created: toCreate.length,
    accounts_matched: matchedExisting,
    inserted,
    updated: 0,
    skipped: snapshots.length - inserted,
    errors: norm.rejectedTotal,
    rejected_by_reason: norm.rejected,
  };
}
