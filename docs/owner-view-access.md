# Owner access through ordinary views

Apply `supabase/migrations/20261115215256_pds_owner_view_invoker.sql` as one
transactional statement after review. It converts the reviewed ordinary view
graph to `security_invoker`, preserving existing definitions, columns, grants,
helper functions and stored records. Existing invoker views remain unchanged.

The migration checks definition fingerprints, source privileges, row security,
and nested view coverage before changing any view. A drift or lock-timeout error
aborts the entire statement. Reconcile the actual dependency graph before retrying;
never add broad grants or disable RLS to make it pass.

Run `sql/checks/verify_owner_view_invoker.sql` only after merge and migration. It
uses a read-only transaction, the configured owner policy, a missing identity and
a synthetic different identity. It verifies owner/service query permissions,
an owner journal canary, denial of personal source rows to other identities and
anonymous schema denial. It returns only pass counts/booleans and rolls back all
session state. The canary requires an existing owner journal row; an empty new
installation needs a separately reviewed synthetic fixture.

Aggregate views can return constant, zero or null rows over empty authorized
inputs; that alone is not a privacy failure. Query definitions and the complete
source dependency graph determine whether personal information is exposed.

Directly granted materialized views are **not fixed by this migration**. Their
caller migration is the owner-only facade (SEC-01-B, 2026-11-16): the browser no
longer reads any `*_mat`; each read is a fixed server query in `lib/queries.ts` /
`lib/queries-hrv.ts` reached through `GET /api/derived/<name>` (owner session via
middleware, same-origin, no-store, not in `isCiRoute()`; names and date rule in
`lib/derived-reads.ts`). The `authenticated` SELECT grants on the six matviews
are then revoked by `sql/pds_matview_revoke_authenticated.sql` (one atomic DO
statement; apply only after the facade is deployed and the browser reads are
confirmed gone), checked afterwards with `sql/checks/verify_matview_revoke.sql`
(read-only: no browser-role privilege, role `authenticated` refused with the
owner's and a synthetic other account's claims, `service_role` still reads, the
matviews are populated, the unique indexes remain, and the dependency graph
below is still closed to browser roles). In the repo no view reads any of the
six (the one view over a matview, `pds.daily_micronutrient_totals`, reads
`supplement_intake_by_compound_mat`, already service-role only). The revoke
migration walks the whole dependency graph from all six on the live database on
every run, a re-run included: views and matviews over them and over those
(private definer views count as hops), functions whose body names or depends on
any node, and views, policies and functions over those functions. It aborts,
changing nothing, if anon or authenticated can read a relation in that graph
(table or column), call a function in it, or if a policy, trigger or any other
object uses one, or if any other pds matview is still readable. That graph only
sees what the catalog records and what function source text names (matched without
regard to case, since PostgreSQL folds an unquoted `PDS.HRV_RESIDUALS_MAT` to the
lower-case name), so SQL built at
run time is outside it (a function running `EXECUTE 'SELECT ... FROM pds.' ||
'hrv_' || 'residuals_mat'` names no object). The migration therefore also fails
closed on every SECURITY DEFINER function whose owner can read the graph (the whole
table or any one column of it) and that a
browser role can reach (anon / authenticated EXECUTE, a trigger or event trigger,
any object that uses it, or another function that names it) when it, or anything it
calls, is opaque: dynamic `EXECUTE`, a query-string builtin (`query_to_xml`,
`table_to_xml`, `ts_stat`, `dblink` and the like), a Unicode-escaped name (`U&"..."`)
or a language other than sql / plpgsql. Such a function passes only when it and its whole call closure are on the
migration's `reviewed_opaque` list with an unchanged hash (today one entry:
Supabase's `public.rls_auto_enable()` event-trigger function, which enables row
security on new tables in `public` and reads no table); a changed body, language,
definer flag or callee fails the check again. The check can stop on a harmless
function: then review that function and either make it unreachable or add its
entry (never a pds function; those are rewritten), never loosen the rule. A stop on
`public.rls_auto_enable()` after a Supabase platform upgrade means its body or a
callee changed: re-review it and refresh its hash in both the migration and
`sql/checks/verify_matview_revoke.sql`. The grants must
not come back: the recreate recipes in `sql/perf_matrix_matview.sql` and
`sql/perf_tier2_matviews.sql` grant only `service_role` and revoke `anon` /
`authenticated` (the pds default privileges in `sql/rls_policies.sql` grant
`authenticated` SELECT on every new relation, matviews included), and PART 1 of
`sql/pds_owner_only_read.sql` skips matviews. There is no rollback that grants a
browser role again. If a caller that cannot use the facade breaks (it gets
42501), keep the grants revoked: move it to a facade read in
`lib/derived-reads.ts` or a service-role server read, or turn that panel off
until it is moved. If `service_role` lost SELECT on one (a recreate that skipped
the recipe), `GRANT SELECT ON pds.<name>_mat TO service_role` restores the facade
without opening anything to browser roles. Isolated PostgreSQL fixtures for
these rules (two-hop definer chain, re-run after the revoke, column grants,
function paths, policies, triggers, run-time assembled matview names with a re-run,
dynamic SQL in a callee, a trigger or a SQL-standard body, Unicode-escaped names,
upper-case names on a first run and a re-run, owners holding SELECT on a single column
on a first run and a re-run) are in `tests/test_pds_matview_revoke_pg.py`;
they run only against a disposable `*_fixture` database and skip without one.
Future view migrations must preserve `security_invoker`
and review their entire source graph.

Recovery: if preconditions fail, nothing changes. After deployment, repair a
specific source/caller permission contract while keeping owner RLS intact. Do not
restore definer access, anonymous grants or broad authenticated policies as a
routine rollback. Existing server reads may continue through the service role.

References: [PostgreSQL view security](https://www.postgresql.org/docs/17/sql-createview.html)
and [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).
