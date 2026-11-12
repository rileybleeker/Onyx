// Thin data layer over supabase-js so the importers can be tested against an in-memory fake.
// Reads the service-role key from ~/.onyx_supabase_secret (never from .env, never printed or logged).
// The tables are service-role only (RLS on, no policies, no grants to anon/authenticated).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_URL = "https://fewweioupmsnbccqtxdl.supabase.co";
export const DEFAULT_KEY_FILE = join(homedir(), ".onyx_supabase_secret");
export const CHUNK = 500; // rows per write request
const PAGE = 1000; // PostgREST's default max rows per read

export const TXN_COMPARE_COLUMNS = [
  "account_key",
  "txn_date",
  "original_date",
  "name",
  "custom_name",
  "amount_cents",
  "currency",
  "category",
  "description",
  "note",
  "ignored_from",
  "tax_deductible",
  "tags",
];

function dbError(op, error) {
  const e = new Error(`${op} failed: ${error?.message ?? "unknown"}`);
  if (error?.code) e.code = error.code;
  return e; // never carry error.details/hint: they can quote row values
}

export function chunked(rows, size = CHUNK) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/** Builds the store on top of any supabase-js-shaped client (a real one, or a fake in tests). */
export function buildStore(client) {
  const t = (name) => client.schema("pds").from(name);

  async function fetchAll(table, columns, orderBy) {
    const out = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await t(table)
        .select(columns)
        .order(orderBy, { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw dbError(`read ${table}`, error);
      out.push(...(data ?? []));
      if (!data || data.length < PAGE) break;
    }
    return out;
  }

  async function upsertChunks(table, rows, onConflict) {
    for (const part of chunked(rows)) {
      const { error } = await t(table).upsert(part, { onConflict });
      if (error) throw dbError(`write ${table}`, error);
    }
  }

  return {
    getAccounts: () => fetchAll("finance_accounts", "account_key,institution,account_name,account_type,mask,first_seen,last_seen", "account_key"),
    upsertAccounts: (rows) => upsertChunks("finance_accounts", rows, "account_key"),
    getTransactions: () => fetchAll("finance_transactions", ["txn_key", ...TXN_COMPARE_COLUMNS].join(","), "txn_key"),
    upsertTransactions: (rows) => upsertChunks("finance_transactions", rows, "txn_key"),
    /** Inserts snapshots, ignoring (account_key, captured_at) pairs that already exist. Returns how many were new. */
    async insertSnapshots(rows) {
      let inserted = 0;
      for (const part of chunked(rows)) {
        const { data, error } = await t("finance_balance_snapshots")
          .upsert(part, { onConflict: "account_key,captured_at", ignoreDuplicates: true })
          .select("account_key");
        if (error) throw dbError("write finance_balance_snapshots", error);
        inserted += data?.length ?? 0;
      }
      return inserted;
    },
    async logHeartbeat(row) {
      const { error } = await t("sync_log").insert(row);
      if (error) throw dbError("write sync_log", error);
    },
  };
}

/** The real store. supabase-js is imported lazily so tests that never touch it need no `npm install`. */
export async function createSupabaseStore({ url = process.env.ONYX_SUPABASE_URL || DEFAULT_URL, keyFile = process.env.ONYX_SUPABASE_SECRET_FILE || DEFAULT_KEY_FILE } = {}) {
  let key;
  try {
    key = readFileSync(keyFile, "utf8").trim();
  } catch {
    throw new Error("cannot read the Supabase secret file (~/.onyx_supabase_secret)");
  }
  if (!key) throw new Error("the Supabase secret file is empty");
  const { createClient } = await import("@supabase/supabase-js");
  const client = createClient(url, key, {
    db: { schema: "pds" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return buildStore(client);
}
