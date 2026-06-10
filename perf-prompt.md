The Onyx frontend is slow — pages take a long time to load. There's a roadmap item in
Notion ("Improve frontend performance — slow page loads across the app"). Work through
it end-to-end: measure first, fix the worst offenders, then verify.

THIS IS AN UNATTENDED OVERNIGHT RUN. Nobody is watching:
- Never ask me questions or wait for input. Make every judgment call yourself,
  preferring the conservative option when torn.
- Do NOT start a dev server (nothing to look at it). Verify with builds and tests only.
- If any single fix fights you for more than ~3 attempts, revert that change, note it
  in the report, and move to the next item. A partial win that ships beats a perfect
  fix that hangs the run.
- Commit after EACH completed fix (small, labeled commits), so partial progress
  survives even if a later step fails. Push only at the very end, after verification.

1. MEASURE FIRST (don't guess):
   - Run `cd frontend && npm run build` and capture the route-by-route size table.
   - Identify which pages are client components doing all their Supabase fetching in
     useEffect after hydration vs. server components.
   - For /status, /analytics/hrv, /spotify, /nutrition: trace every Supabase query
     fired on load (frontend/src/lib/queries.ts + the /api routes) and note: how many
     queries, sequential or parallel, rows fetched, and columns fetched vs. rendered.
   - Record all baseline numbers — they go in the morning report.

2. FIX, in priority order (highest measured impact first):
   - Over-fetching: narrow SELECTs to only the columns the page renders; add .limit()
     and date-range filters where pages pull whole tables (hrv_analysis_results JSON
     blobs, spotify_plays, daily_health_matrix_behavioral are likely offenders).
   - Waterfalls: batch independent queries with Promise.all anywhere they run
     sequentially (pages and /api routes like /api/status).
   - Caching: the ETLs run hourly, so cache aggressively — route segment revalidate /
     unstable_cache on server fetches, Cache-Control on /api routes. Keep /status
     data no more than ~60s stale (it auto-refreshes every 60s).
   - Bundle: dynamic-import Recharts-heavy chart components; re-run the build and
     confirm route sizes dropped.
   - DB indexes: check the hot queries are index-backed via the Supabase MCP.
     OVERNIGHT RESTRICTION: you may CREATE INDEX (additive, safe) via a migration
     .sql file, but make NO other schema changes — no view changes, no column
     changes, nothing destructive. If a fix would need one, write it up in the
     report as a proposal instead.

3. CONSTRAINTS:
   - Don't change any data semantics (TZ/behavioral-day conventions, WHOOP-as-TDEE,
     view choices). Performance-only pass.
   - All reads keep going through the existing views (e.g. hrv_predictions_latest),
     per CLAUDE.md.
   - Don't touch the ETL Python or the GitHub Actions workflows.

4. VERIFY (all must pass before pushing; if verification fails, fix or revert until
   it passes — do not push red):
   - cd frontend && npm run build && npm run lint
   - Run the production build locally (npm run start) and run the Playwright smoke
     suite against it: SMOKE_BASE_URL=http://localhost:3000 npx playwright test.
     Every page must render real data with no empty-state fallbacks, same as prod.
   - Then push to master (Vercel auto-deploys).

5. MORNING REPORT — write docs/perf_report_2026-06-10.md containing:
   - Baseline vs. after: bundle sizes per route, query counts per page, rows/columns
     fetched, what was cached and for how long.
   - Every fix shipped (with commit hash), every fix skipped/reverted and why,
     and any proposals that need my sign-off (e.g. schema changes).
   - Commit the report with the final push.
   - Update the Notion roadmap item: Status=Done if the core work shipped (or
     In Progress if material items remain), and refresh Notes with a 3-line summary.
