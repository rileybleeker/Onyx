// One-off: tie the ledger rows imported from the export to Rocket Money's own transaction ids, so the daily
// web ingest never has to guess. Counts only in the result; nothing identifying is returned or logged.
import { accountTypeLabel } from "./harvest-core.mjs";
import { resolveAccounts } from "./importer.mjs";
import { accountKey, lastFour, normalizeRows, rowsFromCsv, textOrNull } from "./normalize.mjs";
import { planReconcile } from "./reconcile.mjs";

export const MIN_MATCH_RATE = 0.98;

/**
 * web: { accounts: [{id, name, mask, customType, institution, enabled, applicable}],
 *        rows: [{id, date, acct, cents, pending, category}] }   (the one-off scratch file, see README)
 * csvText: the export the ledger was imported from (optional but strongly preferred: it supplies the file order
 *          that makes multi-row groups provable). Rows the file does not hold are paired by the weaker rule.
 * apply: false = dry run, nothing is written.
 */
export async function runReconcileIds({ web, csvText = null, store, apply = false, now = new Date(), minRate = MIN_MATCH_RATE }) {
  const existingAccounts = await store.getAccounts();
  const refs = (web.accounts ?? [])
    .filter((a) => a.enabled !== false && a.applicable !== false && textOrNull(a.name) && textOrNull(a.institution))
    .map((a) => {
      const base = { web_id: String(a.id), institution: textOrNull(a.institution), account_name: textOrNull(a.name), account_type: accountTypeLabel(a.customType), mask: lastFour(a.mask) };
      return { ...base, account_key: accountKey(base) };
    });
  const resolved = resolveAccounts(refs, existingAccounts, now.toISOString());
  const ledgerKeys = new Set(existingAccounts.map((a) => a.account_key));
  // An account the ledger does not hold has no rows to tie; its web rows count as unknown-account.
  const keyByWebId = new Map(refs.map((r, i) => [r.web_id, ledgerKeys.has(resolved.keys[i]) ? resolved.keys[i] : null]));

  const webRows = (web.rows ?? []).map((r) => ({ id: String(r.id), date: r.date, account_key: keyByWebId.get(String(r.acct)) ?? null, cents: r.cents, pending: !!r.pending, category: r.category ?? null }));
  const ledgerRows = await store.getTransactionsForReconcile();

  let csvPosition = null;
  let csv = { rows: 0, with_position: 0 };
  if (csvText) {
    const norm = normalizeRows(rowsFromCsv(csvText).rows);
    csvPosition = new Map(norm.transactions.map((t, i) => [t.txn_key, i]));
    csv = { rows: norm.transactions.length, with_position: ledgerRows.filter((r) => !r.source_txn_id && csvPosition.has(r.txn_key)).length };
  }

  const plan = planReconcile({ ledgerRows, webRows, csvPosition });
  const matchRate = plan.counts.candidates ? plan.counts.matched / plan.counts.candidates : 0;
  const result = {
    ok: true,
    dry_run: !apply,
    ...plan.counts,
    match_rate: Math.round(matchRate * 10000) / 10000,
    ambiguous_reasons: plan.ambiguousReasons,
    csv_rows: csv.rows,
    csv_positions_for_candidates: csv.with_position,
    accounts_in_web: refs.length,
    accounts_resolved_to_ledger: [...keyByWebId.values()].filter(Boolean).length,
    attached: 0,
  };
  if (!apply) return result;

  if (matchRate < minRate) {
    return { ...result, ok: false, error: `match rate ${result.match_rate} is below ${minRate}; nothing was written` };
  }
  result.attached = await store.attachSourceIds(plan.pairs);
  return result;
}
