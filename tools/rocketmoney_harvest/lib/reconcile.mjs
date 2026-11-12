// Pure matching of CSV-origin ledger rows to Rocket Money's own transaction ids. No I/O, no network.
//
// A ledger row from the export has no id, so a row and its web counterpart are tied on what both sources print
// exactly: (account, date, amount). A group of exactly one row on each side is unambiguous. Larger groups need an
// order that both sources share. Measured on the full history (2026-11-12, 7,009 rows, 527 multi-row groups):
//   - the web lists transactions of one date newest id first (id descending) in EVERY multi-row group, and
//   - the export lists the same group oldest first, i.e. the n-th row of the file is the n-th SMALLEST id;
//   - all 1,086 rows of those groups agreed on category under that pairing (884 under the opposite direction).
// So when the export's file positions are known (`csv_pos`), a group is paired by position <-> ascending id, and the
// pairing is still refused (ambiguous) if any pair disagrees on category.
// Without file positions only a pairing that the rows themselves prove is accepted (see pairGroup).

export const MAX_GROUP = 6; // enumerating pairings is factorial; real groups are 2 to 5 rows

const catOf = (r) => String(r?.category ?? "").trim().toLowerCase();
const byIdNum = (a, b) => Number(a.id) - Number(b.id); // ids are numeric strings (about 12 digits, safe as numbers)
const INTERCHANGEABLE_FIELDS = ["name", "category", "original_date", "custom_name", "note", "tags", "ignored_from", "description", "tax_deductible"];

export const groupKey = (accountKey, date, cents) => `${accountKey}|${date}|${cents}`;

const signature = (c) => JSON.stringify(INTERCHANGEABLE_FIELDS.map((f) => c[f] ?? null));

function* permutations(n) {
  const used = Array(n).fill(false);
  const cur = [];
  function* rec() {
    if (cur.length === n) {
      yield [...cur];
      return;
    }
    for (let j = 0; j < n; j++) {
      if (used[j]) continue;
      used[j] = true;
      cur.push(j);
      yield* rec();
      cur.pop();
      used[j] = false;
    }
  }
  yield* rec();
}

/**
 * cands: ledger rows of ONE (account, date, amount) group that have no id yet ({txn_key, category, csv_pos?, ...}).
 * webs:  web rows of the same group ({id, category}), pending rows already removed.
 * Returns { pairs: [[cand, web], ...], ambiguous: null | reason }. Never returns a partial pairing: either every
 * row is paired or none is.
 */
export function pairGroup(cands, webs) {
  if (cands.length !== webs.length) return { pairs: [], ambiguous: "count_mismatch" };
  if (cands.length === 0) return { pairs: [], ambiguous: null };
  const w = [...webs].sort(byIdNum);
  if (cands.length === 1) return { pairs: [[cands[0], w[0]]], ambiguous: null };
  if (cands.length > MAX_GROUP) return { pairs: [], ambiguous: "group_too_large" };

  if (cands.every((c) => Number.isFinite(c.csv_pos))) {
    const c = [...cands].sort((a, b) => a.csv_pos - b.csv_pos);
    if (c.every((x, i) => catOf(x) === catOf(w[i]))) return { pairs: c.map((x, i) => [x, w[i]]), ambiguous: null };
    return { pairs: [], ambiguous: "order_conflicts_with_category" };
  }

  // No file positions: accept only a pairing the rows themselves prove.
  const c = [...cands].sort((a, b) => (a.txn_key < b.txn_key ? -1 : 1));
  const valid = [];
  for (const perm of permutations(c.length)) if (perm.every((j, i) => catOf(c[i]) === catOf(w[j]))) valid.push(perm);
  if (valid.length === 0) return { pairs: [], ambiguous: "no_compatible_pairing" };
  const interchangeable = c.every((x) => signature(x) === signature(c[0]));
  if (valid.length === 1 || interchangeable) return { pairs: c.map((x, i) => [x, w[valid[0][i]]]), ambiguous: null };
  return { pairs: [], ambiguous: "no_order_information" };
}

/**
 * One-off reconciliation of the whole ledger with the web history.
 *   ledgerRows: [{txn_key, account_key, txn_date, amount_cents, category, source_txn_id, ...}]
 *   webRows:    [{id, date, account_key, cents, pending, category}]   (account_key already resolved; null = unknown)
 *   csvPosition: Map(txn_key -> position in the export file) or null
 * Returns { pairs: [{txn_key, source_txn_id}], counts, ambiguousReasons }. Counts only; nothing identifying.
 */
export function planReconcile({ ledgerRows, webRows, csvPosition = null }) {
  const counts = {
    ledger_rows: ledgerRows.length,
    already_tied: 0,
    candidates: 0,
    web_rows: webRows.length,
    web_pending_skipped: 0,
    web_unknown_account: 0,
    web_already_tied: 0,
    matched: 0,
    ambiguous_ledger_rows: 0,
    ambiguous_web_rows: 0,
    unmatched_in_ledger: 0,
    unmatched_in_web: 0,
    multi_row_groups: 0,
    multi_row_groups_paired: 0,
    rows_in_multi_row_groups: 0,
  };
  const reasons = {};
  const tiedIds = new Set(ledgerRows.filter((r) => r.source_txn_id).map((r) => String(r.source_txn_id)));

  const L = new Map();
  for (const r of ledgerRows) {
    if (r.source_txn_id) {
      counts.already_tied++;
      continue;
    }
    counts.candidates++;
    const k = groupKey(r.account_key, r.txn_date, r.amount_cents);
    const row = csvPosition ? { ...r, csv_pos: csvPosition.get(r.txn_key) } : r;
    L.set(k, [...(L.get(k) ?? []), row]);
  }
  const W = new Map();
  for (const w of webRows) {
    if (w.pending) {
      counts.web_pending_skipped++;
      continue;
    }
    if (!w.account_key) {
      counts.web_unknown_account++;
      continue;
    }
    if (tiedIds.has(String(w.id))) {
      counts.web_already_tied++;
      continue;
    }
    const k = groupKey(w.account_key, w.date, w.cents);
    W.set(k, [...(W.get(k) ?? []), { ...w, id: String(w.id) }]);
  }

  const pairs = [];
  for (const k of new Set([...L.keys(), ...W.keys()])) {
    const cands = L.get(k) ?? [];
    const webs = W.get(k) ?? [];
    if (!webs.length) {
      counts.unmatched_in_ledger += cands.length;
      continue;
    }
    if (!cands.length) {
      counts.unmatched_in_web += webs.length;
      continue;
    }
    if (cands.length > 1 || webs.length > 1) {
      counts.multi_row_groups++;
      counts.rows_in_multi_row_groups += cands.length;
    }
    const res = pairGroup(cands, webs);
    if (res.ambiguous) {
      reasons[res.ambiguous] = (reasons[res.ambiguous] ?? 0) + 1;
      counts.ambiguous_ledger_rows += cands.length;
      counts.ambiguous_web_rows += webs.length;
      continue;
    }
    if (cands.length > 1) counts.multi_row_groups_paired++;
    for (const [c, w] of res.pairs) pairs.push({ txn_key: c.txn_key, source_txn_id: w.id });
    counts.matched += res.pairs.length;
  }
  return { pairs, counts, ambiguousReasons: reasons };
}
