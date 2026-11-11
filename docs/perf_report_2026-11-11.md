# Onyx performance pass, November 11, 2026

## Shippable improvement

The HRV dashboard previously issued 17 simultaneous requests to the same analysis-results table. It now makes three: one bounded query for the 15 exact `(result_type, result_key)` panels, plus the existing latest-row queries for journal and habit impact. The complete dashboard's nominal database-request count falls from 30 to 16 (excluding existing forecast fallback and historical pagination). Its 26 top-level logical fetches included a workout/sleep helper that itself issues five requests; this distinction matters when comparing browser traces. This applies to both server prefetch and browser silent revalidation because they share the same loader.

Measured with the real TypeScript query functions and a synthetic PostgREST-compatible test double: 17 to 3 requests, 82.4% fewer analysis requests. Returned panel results are identical on the fixture. With 1001 additional type-only keys, the new path still returns exactly 17 rows in three requests. No health data, credentials, or external network is used by these tests.

This is a request-count improvement, NOT a measured percentage improvement in real page-load latency. Authenticated production page timing is still outstanding. The current local checkout has no configured test environment or saved smoke session; no credentials were sought or copied.

## Review and verification

- Five offline regression tests cover panel equivalence, newest type-only selection, missing panels, legacy string-encoded JSON, bounded payload with growing key counts, and rejection of errors from all three requests.
- Frontend TypeScript check passed.
- Next.js production compile mode passed. Compile-only mode does not prerender, test authenticated behavior, or report useful per-route transfer sizes. Shared first-load JS is 103 kB, middleware 82.5 kB; no bundle-size improvement claimed.
- Targeted ESLint check passed without warnings or errors.
- Independent Claude review identified an overfetch/pagination risk in the first implementation. That design was replaced with the bounded three-query design before publication.
- Full authenticated production smoke and measured cold/warm page loads remain required follow-up work. Existing smoke runs had failures before this patch; this change must not be represented as fixing all slow pages.

## Preserved behavior

No auth, RLS, caching, database schema, health calculations, ETL, or workflow changes. Existing hourly ISR and mandatory silent revalidation stay intact. Failures still reject the load so the ISR/client fallback does not replace valid data with empty panels.

## Further investigation

1. Measure cold and warm content-ready times for Today, Status, HRV, Nutrition and Spotify using authorized authenticated instrumentation. Record request metadata only, not health payloads.
2. Verify whether default sidebar dashboard prefetching competes with foreground requests before changing navigation behavior.
3. Profile large chart commits and slow API/view queries using those traces, then target the measured bottleneck.
4. A language rewrite is not justified by the evidence collected here. The application already has ISR, local JWT verification, materialized views, narrow scalar reads, and deferred chart rendering. Preserve those improvements while measuring current regressions.

Run offline coverage: `cd frontend && node --test scripts/test-hrv-analysis-batch.cjs`.
