/**
 * Was a failed database write really not written? (SEC-04)
 *
 * supabase-js does not throw when a request fails on the way: it answers `{ error }` like any database refusal, so
 * the error's code is all there is to go on. Having a code does not prove anything: PostgREST forwards PostgreSQL's
 * own SQLSTATE, and some of those say the outcome is unknown (08007 transaction_resolution_unknown, 40003
 * statement_completion_unknown) or that the connection went away (class 08), and PostgREST has its own connection
 * errors (PGRST000 to PGRST003). So the rule is an allowlist, by meaning: only the codes below count as a refusal,
 * because each one is raised while the statement is checked or run, before its transaction can commit, and PostgreSQL
 * then rolls it back (nothing written). Everything else, including a network failure or a gateway page (no code), a
 * shutdown or cancel (class 57), a server fault (53, 58, XX), a check PostgREST makes after the statement ran
 * (PGRST116, 124, 128), any other custom code and any code added later, may have arrived after the write committed: it is
 * reported as "may be saved, check first", never as "not saved", or a retry would write it a second time.
 *
 * Pure, no imports. No personal data.
 */

/**
 * A chat write keyed by its operation id was removed by Riley after it was saved (sql/chat_operations.sql leaves a
 * tombstone when such a supplement intake or reading session is deleted; a highlight is archived). A retry of the
 * same chat message never writes it again: the database refuses an insert under a tombstoned key with this SQLSTATE,
 * and the writers answer with REMOVED_SINCE_ERROR and `removed_since: true`.
 */
export const REMOVED_SINCE_CODE = "OXC01";
export const REMOVED_SINCE_ERROR =
  "An earlier try of this same message saved this, and some or all of it has been removed since, so nothing was written again. If it is still wanted, the user should send it as a new message.";

/** SQLSTATE classes (first two characters) that reject the statement itself. */
const REFUSED_SQLSTATE_CLASSES = new Set([
  "21", // cardinality violation
  "22", // data exception (a value of the wrong type, out of range, malformed)
  "23", // integrity constraint violation (not null, foreign key, unique, check, exclusion)
  "28", // invalid authorization specification
  "42", // syntax error or access rule violation (no privilege, unknown table / column, ON CONFLICT mismatch)
  "44", // WITH CHECK OPTION violation
  "P0", // PL/pgSQL: RAISE EXCEPTION from a trigger or function (e.g. a guard trigger), no_data_found, assert_failure
]);

/** Single SQLSTATEs that refuse or roll back the statement, from classes that also hold "outcome unknown" codes. */
const REFUSED_SQLSTATES = new Set([
  "25006", // read_only_sql_transaction
  "40001", // serialization_failure (rolled back; not 40003, statement_completion_unknown)
  "40002", // transaction_integrity_constraint_violation (rolled back)
  "40P01", // deadlock_detected (rolled back)
  "55P03", // lock_not_available
  REMOVED_SINCE_CODE, // this repo's own guard trigger (sql/chat_operations.sql): an insert under a tombstoned key
]);

/**
 * PostgREST's own codes for a request it turned down before running it: a malformed request (group 1, without the
 * checks made after the statement ran), the schema cache (group 2: unknown table, column, function or relationship)
 * and the JWT (group 3). Its connection errors (group 0) and internal errors (PGRSTX00) are not here.
 */
const REFUSED_PGRST = new Set(
  [100, 101, 102, 103, 105, 106, 107, 108, 114, 115, 117, 118, 120, 122, 123, 125, 126, 127, 200, 201, 202, 203, 204, 205, 300, 301, 302, 303]
    .map((n) => `PGRST${n}`),
);

/** The error proves the statement was refused and nothing was written. False for no error. */
export function definiteDbRefusal(error: { code?: unknown } | null | undefined): boolean {
  if (!error) return false;
  const code = typeof error.code === "string" ? error.code.trim().toUpperCase() : "";
  if (REFUSED_PGRST.has(code)) return true;
  if (!/^[0-9A-Z]{5}$/.test(code)) return false;
  return REFUSED_SQLSTATES.has(code) || REFUSED_SQLSTATE_CLASSES.has(code.slice(0, 2));
}

/** A failed write that may have been written anyway (anything that is not a definite refusal). False for no error. */
export function ambiguousDbError(error: { code?: unknown } | null | undefined): boolean {
  if (!error) return false;
  return !definiteDbRefusal(error);
}
