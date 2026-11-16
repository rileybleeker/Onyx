/**
 * Was a failed database write really not written? (SEC-04)
 *
 * supabase-js does not throw when a request fails on the way: it answers `{ error }` like any database refusal. An
 * error that carries a SQLSTATE (e.g. 23514) or a PostgREST code (PGRST...) came from the server, so the statement
 * was rejected and nothing was written. An error with no such code (a network failure, a gateway page, a timeout)
 * may have arrived after the insert committed: the write must then be reported as "may be saved", never as "not
 * saved", or a retry writes it a second time.
 *
 * Pure, no imports. No personal data.
 */
export function ambiguousDbError(error: { code?: unknown } | null | undefined): boolean {
  if (!error) return false;
  const code = typeof error.code === "string" ? error.code.trim() : "";
  return !(/^[0-9A-Z]{5}$/.test(code) || /^PGRST\d+$/.test(code));
}
