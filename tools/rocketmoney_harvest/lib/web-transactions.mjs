// Transactions straight from the Rocket Money web app's own data, keyed on Rocket Money's transaction id.
// Pure functions plus ingestWebTransactions(), which talks only to a `store` (lib/store.mjs) so tests run it
// against an in-memory fake. Summaries are COUNTS ONLY: never names, amounts, notes or ids.
//
// Why not the export: the export button only emails a link (the file name is the server's request time), and the
// harvester never reads email. The Transactions page's own data matches the export on account, date and amount, but
// its names differ for about a third of the rows, so web rows are keyed on the id the app gives each transaction,
// never on the name.
import { createHash } from "node:crypto";
import { accountTypeLabel } from "./harvest-core.mjs";
import { resolveAccounts } from "./importer.mjs";
import { accountKey, lastFour, textOrNull, toIsoDate } from "./normalize.mjs";
import { groupKey, pairGroup } from "./reconcile.mjs";

export const GRAPHQL_ENDPOINT = "https://client-api.rocketmoney.com/graphql";
export const TRANSACTIONS_OPERATION = "TransactionsPageTransactionTable";
export const DEFAULT_DAYS = 60;
export const PAGE_SIZE = 200;
export const MAX_PAGES = 80;

// The Transactions page's own operation (same name, same field and argument names), trimmed to the columns the
// ledger keeps. A query, never a mutation (the read-only guard in harvest.mjs would abort a mutation anyway).
export const TRANSACTIONS_QUERY = `query TransactionsPageTransactionTable($cursor: String, $pageSize: Int!, $gteDate: Date) {
  viewer {
    id
    transactions(first: $pageSize, after: $cursor, gteDate: $gteDate, excludeIgnoredFrom: null) {
      edges {
        cursor
        node {
          id
          shortName
          longName(prependCustomName: false)
          amount
          date
          note
          taxDeductible
          pending
          ignoredFrom
          category { id label }
          account { id }
        }
      }
      pageInfo { endCursor hasNextPage }
    }
  }
}`;

/**
 * Runs INSIDE the signed-in page (Playwright serializes the function, so it must not touch anything outside its
 * own body). Reads the transaction pages with the page's own session cookie, exactly as the app's list does.
 * Returns { ok, rows } or { ok:false, error, login? }. The error text is fixed wording, never response content.
 */
export async function pageFetchTransactions({ endpoint, query, operationName, gteDate, pageSize, maxPages, version }) {
  const rows = [];
  let cursor = null;
  for (let page = 0; ; page++) {
    if (page >= maxPages) return { ok: false, error: "the transaction list was longer than the page limit", rows };
    const headers = { "content-type": "application/json", accept: "application/json" };
    if (version) headers["x-truebill-web-client-version"] = version;
    let res;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify({ operationName, query, variables: { cursor, pageSize, gteDate } }),
      });
    } catch {
      return { ok: false, error: "the transactions request could not be sent" };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, error: "the transactions request was refused", login: true };
    if (!res.ok) return { ok: false, error: `the transactions request returned HTTP ${res.status}` };
    let json;
    try {
      json = await res.json();
    } catch {
      return { ok: false, error: "the transactions response was not JSON" };
    }
    if (Array.isArray(json?.errors) && json.errors.length) {
      const code = String(json.errors[0]?.extensions?.code ?? "");
      return { ok: false, error: "the transactions query was rejected (the app's data format may have changed)", login: /UNAUTHENTICATED|FORBIDDEN/i.test(code) };
    }
    const conn = json?.data?.viewer?.transactions;
    if (!conn || !Array.isArray(conn.edges)) return { ok: false, error: "the transactions response had an unexpected shape" };
    for (const edge of conn.edges) if (edge && edge.node) rows.push(edge.node);
    if (!conn.pageInfo || !conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) break;
    cursor = conn.pageInfo.endCursor;
  }
  return { ok: true, rows };
}

/** The app's global ids are base64("<Type>:<number>"). Returns the number as a string, or null. */
export function decodeId(id, type) {
  if (typeof id !== "string" || !id) return null;
  let text;
  try {
    text = Buffer.from(id, "base64").toString("utf8");
  } catch {
    return null;
  }
  const m = new RegExp(`^${type}:(\\d+)$`).exec(text);
  return m ? m[1] : null;
}

/** txn_key of a row created from the web: first 32 hex of sha256('rmid|' + Rocket Money transaction id). */
export const rmidKey = (id) => createHash("sha256").update(`rmid|${id}`, "utf8").digest("hex").slice(0, 32);

/** First day of the window: today in New York minus `days`, as YYYY-MM-DD. */
export function windowStart(now, days = DEFAULT_DAYS) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const [y, m, d] = today.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
}

/**
 * The account list response (SettingsAccountsPage) -> one reference per account: the app's account id and what the
 * ledger needs to find or create the account (same naming rules as the balances).
 */
export function webAccountRefs(accountsJson) {
  const refs = [];
  for (const master of accountsJson?.data?.viewer?.masterAccounts?.edges ?? []) {
    const institution = textOrNull(master?.node?.institution?.name);
    for (const edge of master?.node?.accounts?.edges ?? []) {
      const a = edge?.node;
      if (!a || a.enabled === false || a.applicable === false) continue;
      const web_id = decodeId(a.id, "Account");
      const account_name = textOrNull(a.name);
      if (!web_id || !account_name || !institution) continue;
      refs.push({ web_id, institution, account_name, account_type: accountTypeLabel(a.customType), mask: lastFour(a.number) });
    }
  }
  return refs;
}

const bump = (counts, reason) => {
  counts[reason] = (counts[reason] ?? 0) + 1;
};
const same = (a, b) => (a ?? null) === (b ?? null);
const minDate = (a, b) => (a == null ? b : b == null ? a : a < b ? a : b);
const maxDate = (a, b) => (a == null ? b : b == null ? a : a > b ? a : b);

/** Fields the web keeps current for a transaction it has an id for. custom_name, tags, description and original_date are not on the web list and are never touched. */
const WEB_FIELDS = ["txn_date", "amount_cents", "name", "category", "note", "ignored_from", "tax_deductible"];

/**
 * Raw nodes from the Transactions page -> ledger-shaped rows. Pending rows are skipped (a pending row can change
 * id, date or amount when it posts); rows that cannot be read are counted by reason and skipped.
 */
export function normalizeWebNodes(nodes, keyByWebAccountId) {
  const rows = new Map();
  const rejected = {};
  let pending = 0;
  for (const n of nodes) {
    if (n?.pending) {
      pending++;
      continue;
    }
    const id = decodeId(n?.id, "Transaction");
    if (!id) {
      bump(rejected, "bad_id");
      continue;
    }
    const txn_date = toIsoDate(n?.date);
    if (!txn_date) {
      bump(rejected, "bad_date");
      continue;
    }
    if (!Number.isSafeInteger(n?.amount)) {
      bump(rejected, "bad_amount");
      continue;
    }
    const account_key = keyByWebAccountId.get(decodeId(n?.account?.id, "Account"));
    if (!account_key) {
      bump(rejected, "unknown_account");
      continue;
    }
    rows.set(id, {
      id,
      account_key,
      txn_date,
      amount_cents: n.amount,
      name: String(n.shortName ?? n.longName ?? "").trim(),
      category: textOrNull(n.category?.label),
      note: textOrNull(n.note),
      ignored_from: textOrNull(n.ignoredFrom),
      tax_deductible: typeof n.taxDeductible === "boolean" ? n.taxDeductible : null,
    });
  }
  const rejectedTotal = Object.values(rejected).reduce((a, b) => a + b, 0);
  return { rows: [...rows.values()], rejected, rejectedTotal, pending };
}

/**
 * Upserts web transactions by Rocket Money id.
 *   (a) the id is already in the ledger          -> refresh the web fields (counted `updated`, or `unchanged`)
 *   (b) the id is new but exactly the right number of export-origin rows without an id share its
 *       (account, date, amount)                  -> attach the id to that row (`attached`), same pairing rule as the
 *                                                   one-off reconciliation; an unprovable pairing is left alone
 *                                                   (`ambiguous`), never inserted twice
 *   (c) otherwise                                -> insert (`inserted`), txn_key = sha256('rmid|' + id)
 * Idempotent; never deletes a row that is missing from the window.
 * @returns counts (and date range) only
 */
export async function ingestWebTransactions({ nodes, accountRefs, store, dryRun = false, now = new Date(), gteDate = null }) {
  const nowIso = now.toISOString();
  const existingAccounts = await store.getAccounts();
  const refs = accountRefs.map((r) => ({ ...r, account_key: accountKey(r) }));
  const resolved = resolveAccounts(refs, existingAccounts, nowIso);
  const keyByWebId = new Map(refs.map((r, i) => [r.web_id, resolved.keys[i]]));
  const newAccountByKey = new Map(resolved.toCreate.map((a) => [a.account_key, a]));

  const norm = normalizeWebNodes(nodes, keyByWebId);
  const counts = { fetched: nodes.length, pending_skipped: norm.pending, rows: norm.rows.length, inserted: 0, updated: 0, unchanged: 0, attached: 0, ambiguous: 0, errors: norm.rejectedTotal };
  const reasons = { ...norm.rejected };
  const dates = norm.rows.map((r) => r.txn_date).sort();

  const byId = new Map((await store.getTransactionsBySourceIds(norm.rows.map((r) => r.id))).map((r) => [String(r.source_txn_id), r]));
  const unreconciled = norm.rows.length ? await store.getUnreconciledSince(dates[0]) : [];
  const candidatesByGroup = new Map();
  for (const r of unreconciled) {
    const k = groupKey(r.account_key, r.txn_date, r.amount_cents);
    candidatesByGroup.set(k, [...(candidatesByGroup.get(k) ?? []), r]);
  }

  const webValues = (row) => Object.fromEntries(WEB_FIELDS.map((f) => [f, row[f]]));
  const payload = [];
  const needId = [];
  for (const row of norm.rows) {
    const e = byId.get(row.id);
    if (!e) {
      needId.push(row);
      continue;
    }
    if (WEB_FIELDS.every((f) => same(e[f], row[f]))) counts.unchanged++;
    else counts.updated++;
    payload.push({ txn_key: e.txn_key, account_key: e.account_key, source_txn_id: row.id, ...webValues(row), last_seen_at: nowIso });
  }

  const groups = new Map();
  for (const row of needId) {
    const k = groupKey(row.account_key, row.txn_date, row.amount_cents);
    groups.set(k, [...(groups.get(k) ?? []), row]);
  }
  for (const [k, webs] of groups) {
    const cands = candidatesByGroup.get(k) ?? [];
    if (!cands.length) {
      for (const row of webs) {
        counts.inserted++;
        payload.push({ txn_key: rmidKey(row.id), account_key: row.account_key, source_txn_id: row.id, ...webValues(row), currency: "USD", last_seen_at: nowIso });
      }
      continue;
    }
    const res = pairGroup(cands, webs);
    if (res.ambiguous) {
      counts.ambiguous += webs.length;
      bump(reasons, `ambiguous_${res.ambiguous}`);
      continue;
    }
    for (const [cand, web] of res.pairs) {
      counts.attached++;
      payload.push({ txn_key: cand.txn_key, account_key: cand.account_key, source_txn_id: web.id, ...webValues(web), last_seen_at: nowIso });
    }
  }

  if (!dryRun && payload.length) {
    // Accounts first (transactions.account_key is a foreign key): create the ones the ledger has not seen and
    // widen first_seen / last_seen of the others.
    const span = new Map();
    for (const p of payload) {
      const s = span.get(p.account_key) ?? { first: null, last: null };
      span.set(p.account_key, { first: minDate(s.first, p.txn_date), last: maxDate(s.last, p.txn_date) });
    }
    const existingByKey = new Map(existingAccounts.map((a) => [a.account_key, a]));
    const accountRows = [];
    for (const [key, s] of span) {
      const e = existingByKey.get(key);
      const created = newAccountByKey.get(key);
      if (e) {
        const first_seen = minDate(e.first_seen, s.first);
        const last_seen = maxDate(e.last_seen, s.last);
        if (first_seen !== e.first_seen || last_seen !== e.last_seen) accountRows.push({ ...e, first_seen, last_seen, updated_at: nowIso });
      } else if (created) {
        accountRows.push({ ...created, first_seen: s.first, last_seen: s.last });
      }
    }
    if (accountRows.length) await store.upsertAccounts(accountRows);
    await store.upsertTransactions(payload);
  }

  return {
    ...counts,
    accounts_created: [...newAccountByKey.keys()].filter((k) => payload.some((p) => p.account_key === k)).length,
    window_start: gteDate,
    rejected_by_reason: reasons,
    date_min: dates[0] ?? null,
    date_max: dates[dates.length - 1] ?? null,
  };
}
