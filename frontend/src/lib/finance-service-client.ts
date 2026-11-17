import "server-only";
import { createClient } from "@supabase/supabase-js";

/**
 * The service-role client for the finance tables, and the error its readers throw. SERVICE ROLE ONLY:
 * pds.finance_* has RLS on, no policies and no grants to anon/authenticated; this module must never reach a
 * client component ("server-only") and its callers sit behind the owner-only middleware.
 *
 * Its own small module (PERF-02, 2026-11-16) so a route that only reads one stored row (/api/finance/alerts,
 * /api/procurement/renewals/summary via lib/finance-result-cache-server.ts) does not load the ledger arithmetic,
 * the status cards and the category rules on its first (cold) request. lib/finance-ledger-server.ts re-exports
 * both names, so every existing import keeps working and `instanceof LedgerQueryError` is one class.
 */

export class LedgerQueryError extends Error {
  constructor(readonly code: string | null) {
    super(code ?? "query failed");
  }
}

/** A new client per call, as before PERF-02 (it holds no session: persistSession and autoRefreshToken are off). */
export function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new LedgerQueryError("not-configured");
  return createClient(url, key, { db: { schema: "pds" }, auth: { persistSession: false, autoRefreshToken: false } });
}
