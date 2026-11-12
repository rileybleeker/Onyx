// Import logic shared by import-csv / import-rows / import-balances. Talks only to a `store`
// (lib/store.mjs), so tests run it against an in-memory fake. Summaries are COUNTS ONLY.
import { TXN_COMPARE_COLUMNS } from "./store.mjs";
import { accountKey, normalizeBalances, normalizeRows } from "./normalize.mjs";

const same = (a, b) => (a ?? null) === (b ?? null) || (a != null && b != null && String(a) === String(b));
const minDate = (a, b) => (a == null ? b : b == null ? a : a < b ? a : b);
const maxDate = (a, b) => (a == null ? b : b == null ? a : a > b ? a : b);

/**
 * rawRows: array of objects keyed by the Rocket Money export column names. Must be the COMPLETE export
 * (ordinals for identical rows depend on seeing every row of the group).
 * Re-running is idempotent: same keys, nothing duplicated. Rows missing from a later export are never deleted.
 *
 * Web-fed rows (tools/rocketmoney_harvest/harvest.mjs) carry another kind of key (derived from Rocket Money's own
 * transaction id), so a CSV row can describe a transaction the ledger already holds under that other key. To keep
 * a CSV re-import from duplicating those, rows whose key is not in the ledger are inserted COUNT-BASED: per
 * (account, date, amount) group only the surplus of CSV rows over the rows the ledger already holds is inserted
 * (the last ones in file order, the newest). The others are counted as `matched_existing` and left alone.
 */
export async function importTransactions(rawRows, { store, dryRun = false, now = new Date() }) {
  const norm = normalizeRows(rawRows);
  const nowIso = now.toISOString();

  const existingAccounts = new Map((await store.getAccounts()).map((a) => [a.account_key, a]));
  const accountRows = norm.accounts.map((a) => {
    const e = existingAccounts.get(a.account_key);
    return { ...a, first_seen: minDate(e?.first_seen, a.first_seen), last_seen: maxDate(e?.last_seen, a.last_seen), updated_at: nowIso };
  });

  const existingList = await store.getTransactions();
  const existing = new Map(existingList.map((r) => [r.txn_key, r]));
  const groupOf = (r) => `${r.account_key}|${r.txn_date}|${r.amount_cents}`;
  const presentInGroup = new Map(); // rows the ledger holds per (account, date, amount), whatever their key
  for (const r of existingList) presentInGroup.set(groupOf(r), (presentInGroup.get(groupOf(r)) ?? 0) + 1);
  const csvInGroup = new Map();
  const newInGroup = new Map(); // CSV rows whose key the ledger does not have, in file order
  for (const row of norm.transactions) {
    const g = groupOf(row);
    csvInGroup.set(g, (csvInGroup.get(g) ?? 0) + 1);
    if (!existing.has(row.txn_key)) newInGroup.set(g, [...(newInGroup.get(g) ?? []), row.txn_key]);
  }
  const insertKeys = new Set();
  let matchedExisting = 0;
  for (const [g, keys] of newInGroup) {
    const surplus = Math.max(0, (csvInGroup.get(g) ?? 0) - (presentInGroup.get(g) ?? 0));
    for (const k of keys.slice(keys.length - Math.min(surplus, keys.length))) insertKeys.add(k);
    matchedExisting += keys.length - Math.min(surplus, keys.length);
  }

  const toWrite = [];
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  for (const row of norm.transactions) {
    const e = existing.get(row.txn_key);
    if (!e) {
      if (insertKeys.has(row.txn_key)) {
        inserted++;
        toWrite.push(row);
      }
    } else if (TXN_COMPARE_COLUMNS.every((c) => same(e[c], row[c]))) {
      skipped++;
      toWrite.push(row); // only last_seen_at moves
    } else {
      updated++;
      toWrite.push(row);
    }
  }

  if (!dryRun && toWrite.length) {
    await store.upsertAccounts(accountRows); // before transactions: finance_transactions.account_key is a foreign key
    // last_seen_at is bumped on every present row; first_seen_at is left out so it keeps its insert-time default.
    await store.upsertTransactions(toWrite.map((r) => ({ ...r, last_seen_at: nowIso })));
  }

  const dates = norm.transactions.map((r) => r.txn_date).sort();
  return {
    rows: norm.inputRows,
    accounts: norm.accounts.length,
    inserted,
    updated,
    skipped,
    matched_existing: matchedExisting,
    errors: norm.rejectedTotal,
    rejected_by_reason: norm.rejected,
    date_min: dates[0] ?? null,
    date_max: dates[dates.length - 1] ?? null,
  };
}

/**
 * Decides which ledger account each of `accounts` ([{account_key, institution, account_name, account_type, mask}],
 * keys derived from the entry itself) belongs to. Returns `keys`, aligned with the input: an existing account's
 * key, or the entry's own key for an account the ledger has not seen (listed in `toCreate`). Matching is
 * one-to-one: an account already claimed by an earlier entry is not claimed again.
 *   1. the derived key itself, or the key with the export's "NAME ...1234" suffix (the export names an account that
 *      way for some institutions and plain "NAME" for others, so a plain name may need the suffix to hit its key);
 *   2. otherwise the single unclaimed account with the same institution (case-insensitive) and last four digits.
 */
export function resolveAccounts(accounts, existing, nowIso) {
  const byKey = new Map(existing.map((a) => [a.account_key, a]));
  const claimed = new Set();
  const keys = [];
  const toCreate = [];
  let matchedExisting = 0;
  for (const a of accounts) {
    const suffixed = a.mask ? accountKey({ ...a, account_name: `${a.account_name} ...${a.mask}` }) : null;
    const exact = [a.account_key, suffixed].find((k) => k && byKey.has(k) && !claimed.has(k));
    if (exact) {
      claimed.add(exact);
      keys.push(exact);
      matchedExisting++;
      continue;
    }
    const candidates = a.mask
      ? existing.filter((x) => x.mask === a.mask && !claimed.has(x.account_key) && String(x.institution).trim().toLowerCase() === a.institution.toLowerCase())
      : [];
    if (candidates.length === 1) {
      claimed.add(candidates[0].account_key);
      keys.push(candidates[0].account_key);
      matchedExisting++;
    } else {
      keys.push(a.account_key);
      toCreate.push({ ...a, first_seen: null, last_seen: null, updated_at: nowIso });
    }
  }
  return { keys, toCreate, matchedExisting };
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

  const resolved = resolveAccounts(norm.accounts, existing, nowIso);
  const remap = new Map(); // key derived from the balance entry -> key of the account it belongs to
  norm.accounts.forEach((a, i) => {
    if (resolved.keys[i] !== a.account_key) remap.set(a.account_key, resolved.keys[i]);
  });
  const { toCreate, matchedExisting } = resolved;

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
