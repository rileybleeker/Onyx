// In-memory stand-in for lib/store.mjs, behaving like the real tables: upsert-on-conflict for accounts and
// transactions (first_seen_at kept, last_seen_at replaced), ignore-duplicates for snapshots. Synthetic data only.
export function memoryStore({ failOn = null } = {}) {
  const accounts = new Map();
  const txns = new Map();
  const snaps = new Map();
  const heartbeats = [];
  const writes = { accounts: 0, transactions: 0, snapshots: 0, heartbeats: 0 };
  const maybeFail = (op) => {
    if (failOn === op) {
      const e = new Error(`${op} failed: connection refused for "SENSITIVE-VALUE-12345678"`);
      e.code = "XX000";
      throw e;
    }
  };
  return {
    accounts,
    txns,
    snaps,
    heartbeats,
    writes,
    async getAccounts() {
      return [...accounts.values()].map((a) => ({ ...a }));
    },
    async upsertAccounts(rows) {
      maybeFail("upsertAccounts");
      for (const r of rows) {
        writes.accounts++;
        accounts.set(r.account_key, { ...(accounts.get(r.account_key) ?? {}), ...r });
      }
    },
    async getTransactions() {
      return [...txns.values()].map((t) => ({ ...t }));
    },
    async upsertTransactions(rows) {
      maybeFail("upsertTransactions");
      for (const r of rows) {
        writes.transactions++;
        // the real table has a partial unique index on source_txn_id
        if (r.source_txn_id != null && [...txns.values()].some((t) => t.txn_key !== r.txn_key && t.source_txn_id === r.source_txn_id)) {
          throw new Error("duplicate key value violates unique constraint finance_transactions_source_txn_id_uidx");
        }
        const prev = txns.get(r.txn_key);
        txns.set(r.txn_key, { first_seen_at: r.last_seen_at, source_txn_id: null, ...(prev ?? {}), ...r });
      }
    },
    async getTransactionsBySourceIds(ids) {
      const wanted = new Set(ids.map(String));
      return [...txns.values()].filter((t) => t.source_txn_id != null && wanted.has(String(t.source_txn_id))).map((t) => ({ ...t }));
    },
    async getUnreconciledSince(date) {
      return [...txns.values()].filter((t) => t.source_txn_id == null && t.txn_date >= date).map((t) => ({ ...t }));
    },
    async getTransactionsForReconcile() {
      return [...txns.values()].map((t) => ({ ...t, source_txn_id: t.source_txn_id ?? null }));
    },
    async attachSourceIds(pairs) {
      maybeFail("attachSourceIds");
      let n = 0;
      for (const p of pairs) {
        const t = txns.get(p.txn_key);
        if (t && t.source_txn_id == null) {
          t.source_txn_id = p.source_txn_id;
          writes.transactions++;
          n++;
        }
      }
      return n;
    },
    async insertSnapshots(rows) {
      maybeFail("insertSnapshots");
      let n = 0;
      for (const r of rows) {
        const k = `${r.account_key}|${r.captured_at}`;
        if (!snaps.has(k)) {
          snaps.set(k, { ...r });
          n++;
          writes.snapshots++;
        }
      }
      return n;
    },
    async logHeartbeat(row) {
      maybeFail("logHeartbeat");
      writes.heartbeats++;
      heartbeats.push({ ...row });
    },
  };
}

/** A small synthetic export. Fake merchants and accounts only. */
export const SYNTHETIC_HEADER = "Date,Original Date,Account Type,Account Name,Account Number,Institution Name,Name,Custom Name,Amount,Description,Category,Note,Ignored From,Tax Deductible,Transaction Tags";

export function syntheticCsv(extraLines = []) {
  return [
    SYNTHETIC_HEADER,
    // two identical purchases on one day (same account, dates, name, amount) -> ordinals 1 and 2
    "2026-01-05,2026-01-04,Credit Card,Test Card ...1111,1111,Test Bank,ACME COFFEE,,4.50,ACME COFFEE #12,Coffee,,,,",
    "2026-01-05,2026-01-04,Credit Card,Test Card ...1111,1111,Test Bank,ACME COFFEE,,4.50,ACME COFFEE #12,Coffee,,,,",
    // quoted comma + doubled quote + an embedded newline in the note
    '2026-01-06,2026-01-06,Cash,Test Checking ...2222,2222,Test Credit Union,"WIDGETS, INC",Widgets,12.34,"WIDGETS ""PRO""",Shopping,"line one\nline two",,true,"tag a"',
    // income is negative
    "2026-01-07,2026-01-07,Cash,Test Checking ...2222,2222,Test Credit Union,PAYROLL TEST CO,,-2500.00,PAYROLL,Income,,,,",
    // no account number (blank mask)
    "2026-01-08,2026-01-08,Credit Card,Test Wallet Card,,Test Wallet,STREAMING SVC,,15.99,STREAMING,Subscriptions,,,,",
    ...extraLines,
  ].join("\n");
}
