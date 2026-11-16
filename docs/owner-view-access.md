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
`lib/derived-reads.ts`). The `authenticated` SELECT grants on the matviews are
revoked in a separate reviewed migration, only after that facade is deployed and
the browser reads are confirmed gone. Future view migrations must preserve
`security_invoker` and review their entire source graph.

Recovery: if preconditions fail, nothing changes. After deployment, repair a
specific source/caller permission contract while keeping owner RLS intact. Do not
restore definer access, anonymous grants or broad authenticated policies as a
routine rollback. Existing server reads may continue through the service role.

References: [PostgreSQL view security](https://www.postgresql.org/docs/17/sql-createview.html)
and [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).
