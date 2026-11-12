# Regression testing and staging

## Premerge synthetic browser lane

Run from the repository root:

```
cd frontend
npm ci --ignore-scripts
npx tsc --noEmit
npx next build --experimental-build-mode compile
npx playwright install chromium
cd ..
node tests/today-regression.cjs
```

Autonomous CI runs the same suite on pull requests and master, without secrets. It renders the actual Today React component and installed React runtime in Chromium, uses compiled application CSS, supplies invented inbox/book fixtures, and aborts browser network requests. No Supabase login, production fetch, personal health record, screenshot, trace, or credential is needed.

Coverage: request filtering and bounded count; exact navigation targets; mobile and desktop width; empty versus unavailable data; independent upstream failure; synchronous exceptions; stale data and keyboard focus retained on refresh failure; retry; duplicate-click suppression; timeout; superseded completions under React Strict Mode; only the expected inbox method and reading GET calls (the real agents transport is not exercised); browser exceptions.

This is component regression coverage, not a Next.js routing, middleware, hydration, live schema, RLS, or full browser integration test. Existing authenticated production smoke remains a separate read-oriented tripwire. Do not point write-path tests at production. The stats workflow's habit-rename integration test writes temporary fixtures to the configured live database. It now runs only on explicit workflow_dispatch with run_live_write_tests=true (default false), never automatically for pull requests. The test is retained; this deliberately removes automatic live-write coverage until isolated staging exists. Read-only live HRV alignment and the existing synthetic/statistical PR checks remain unchanged. An operator choosing the input must understand that the test mutates production fixtures.

## Staging decision

GitHub deployment records show Vercel Preview deployments already exist. A preview URL is not proof of database or worker isolation: the app's server client uses SUPABASE_SERVICE_ROLE_KEY, browser reads use Supabase owner identity, and several write paths mirror changes to Notion or the agents Worker. Do not treat a preview as a safe write-testing environment until each dependency is verified.

A separate full-stack staging environment is useful for check-in, supplements, and reading write flows, but is not safely provisioned by this change. No Vercel environment values, credentials, permissions, database contents, or production schedules were changed. No production health data was copied.

Provisioning checklist for a future explicitly scoped run:

1. Use a separate Supabase project/database with schema-only migrations reviewed in order, a synthetic owner account, and invented seed records. Never restore production data, users, tokens, or journals.
2. Scope Vercel Preview or a dedicated staging project exclusively to that database and owner. Verify variable *scope* without printing secret values. Separate CI/import tokens must never authorize production.
3. Disable external writes and scheduled ETL, or route them to isolated test workers/Notion destinations. Disable paid model calls unless separately authorized. Staging must not reuse production OAuth or ingestion credentials.
4. Retain authentication and deployment protections. Configure callback URLs and access permissions only with the required approvals. Confirm cost and account requirements before provisioning paid resources.
5. Seed and clean fixtures only after asserting the exact staging project identity. Test write/reload/idempotency, partial failures, cancellation, rapid repeated input, and back/forward navigation. Verify production row counts and production external destinations remain untouched.
6. Run real Next.js browser integration tests against the protected staging URL and report its exact commit. Keep synthetic PR regressions fast and credential-free.

Until those checks pass, use the offline component lane for reproducible failures and existing approved production smoke for live read regressions. Do not claim a full staging deployment is available.
