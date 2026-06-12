# Frontend Performance Pass — Round 2, 2026-06-11

Follow-up to the 2026-06-10 overnight pass, executing its three deferred
structural proposals (now signed off) plus new findings from a fresh
measurement + deep-dive cycle. Every change adversarially reviewed before
and after implementation; all verification green before push: `tsc`,
`next build`, `next lint` (pre-existing warnings only), Playwright smoke
17/17 against a local production build.

## TL;DR

- **Median time-to-content (cold, authed, local prod build):**

  | Route | Before | After | Δ |
  |---|---|---|---|
  | /habits | 3672 ms | 468 ms | **−87%** |
  | /status | 1157 ms | 211 ms | **−82%** |
  | /supplements | 1132 ms | 220 ms | −81% |
  | /journal | 553 ms | 255 ms | −54% |
  | /spotify | 1263 ms | 691 ms | −45% |
  | /activities | 1163 ms | 683 ms | −41% |
  | /caffeine | 1129 ms | 745 ms | −34% |
  | /whoop | 1200 ms | 841 ms | −30% |
  | /heart | 767 ms | 596 ms | −22% |
  | /analytics/hrv | 1837 ms | 1576 ms | −14% |
  | /sleep | 1599 ms | 1384 ms | −13% |

- **Tail latency is structurally gone.** The baseline showed worst-case
  loads of 7.0s (/sleep), 7.0s (/status) and 15.1s (/analytics/hrv) —
  single stalled browser→Supabase queries with no cache. Post-migration
  run variance is ±50 ms because no blocking Supabase query remains on
  the load path. This matters more than the medians: the *experienced*
  "pages take too long" was dominated by those stalls.

- **Middleware auth round trip eliminated.** Each page view triggered
  ~13-14 network `getUser()` calls (page + RSC prefetches) at 46-58 ms
  warm / 185-535 ms cold each. The project already signs tokens with
  ES256, so `getClaims()` verifies locally: 0.4-0.8 ms (measured with
  the installed library + a live token).

## What shipped (9 commits)

1. **`getClaims()` middleware** (a091f4a) — local ES256 JWT verification
   against the cached JWKS; expired tokens still refresh over the network
   and propagate cookies. Matcher additionally excludes `manifest.json`
   (was being 307'd to /login — fetched credential-less), `api/habits`
   (already exempt from redirect logic; the hourly CI curl no longer runs
   auth code), and ico/woff2. Trade-off accepted: revoked-but-unexpired
   tokens stay valid ≤1h (single-operator app).
2. **/habits render unblock** (06868a1) — the page no longer gates its
   skeleton on the 1.5-4s Notion sync POST; sync runs behind the existing
   "syncing from Notion..." chip, once per mount.
3. **Shell** (dfb0abf) — Sparkline rewritten as a plain `<svg><polyline>`
   (recharts was in StatCard's synchronous chain → /status First Load
   213→111 kB); dead GeistMono font removed; `preconnect` to the Supabase
   origin.
4. **DB matview + payload narrowing** (5e88f0f) —
   - `pds.daily_health_matrix_behavioral_mat`: physical copy of the
     208-col canonical view, refreshed every 15 min by pg_cron via a
     SECURITY DEFINER function that writes a `pds.sync_log` heartbeat on
     success AND failure, with a pg_attribute **schema-drift tripwire**
     (see sql/perf_matrix_matview.sql for the mandatory
     drop+recreate-in-same-migration rule). New "Matrix Matview" card on
     /status. Production matrix reads were mean 150-650 ms with 1.5-2.7 s
     tails; matview reads converge to plain-table profile (~19 ms mean).
     The LIVE view stays canonical for Python + chat.
   - Every heavy `select("*")` narrowed to explicit all-scalar column
     lists: whoop_cycles is 42 MB for ~600 rows (~99% unread raw_json);
     garmin_sleep ~19 kB/row; garmin_stress ships minute-level samples.
     `getActivities` keeps only `raw_json->workoutId`.
   - **Latent bug found & fixed:** /bland-altman referenced
     `eight_sleep_{duration,deep,rem}_main_sec` which never existed on
     the view — three Eight Sleep comparisons silently rendered empty
     under `select("*")`. Appended as main-session values (nap-inclusion
     convention requires main-only for cross-device comparison).
   - `getHealthMatrix` paged via `.range()` (ALL-range would hit the
     1000-row PostgREST cap in ~5 months).
5. **ISR + silent revalidation, 10 pages** (3bcc34b /sleep template,
   4548fc1 the rest) — server `page.tsx` (`revalidate = 3600`, matching
   ETL cadence) runs the same lib/queries fns server-side and serializes
   the default range into the RSC payload; a `<Name>Loader.tsx` client
   wrapper keeps the `dynamic(ssr:false)` bundle split; clients seed
   state from props and convert the mount fetch to a **silent SWR
   revalidation** (adversarial review rejected skip-first-fetch: with
   single-user traffic the morning's first visit lands on a stale
   overnight snapshot, so the page must always revalidate — just without
   a skeleton). Fail-open: any prefetch error ships `initial=null` → the
   client fetches exactly as pre-ISR. Cancelled-flag guards added to
   every range effect (pre-existing out-of-order-resolve race).
   /analytics/hrv additionally: file-local query fns extracted to
   `lib/queries-hrv.ts`; range changes refetch only the 3 range-dependent
   series (was: all 26 queries + full-page skeleton).
   /analytics/travel: force-dynamic → hourly ISR, service-role → anon
   client, silent error-swallowing fixed, unbounded matrix scan bounded
   + paged. NOT migrated by design: /supplements, /habits (immediate
   write-read-back contracts; /habits fires a Notion-sync POST on load),
   /chat, /account, /login.
6. **/api/journal/list** edge-cached 5m+5m SWR (f1dc9e9).

## Verification

- `npx tsc --noEmit` clean; `next build` green — all 10 ISR routes show
  `1h` revalidate in the route table; `next lint` pre-existing warnings only.
- Playwright smoke **17/17** against `next start` (run twice: after the
  migration and again after the review fixes).
- Two adversarial review cycles: (a) pre-implementation, 3 skeptics on
  the riskiest designs (caught the manifest.json filename, the matview
  observability gap, and the skip-vs-silent staleness trap); (b)
  post-implementation diff review, 2 reviewers (caught swallowed
  PostgREST errors in queries-hrv.ts that would have defeated the
  fail-open prefetch and let a transient failure wipe seeded charts —
  fixed by throwing on error like the rest of queries.ts).
- Matview verified live: 853 rows, 0.14 s refresh, success heartbeat,
  anon-role read through PostgREST, cron jobs scheduled
  (`10,25,40,55 * * * *` + daily history purge).

## Caveats on the numbers

- Localhost serving: TTFB/HTML numbers are floors (no CDN/cold starts);
  the browser→Supabase and middleware→Auth phases traversed the real WAN
  in BOTH baseline and after runs, so the deltas are representative. On
  Vercel, ISR cache hits should make the "after" numbers better than
  local (no function invocation for cached HTML).
- "Content visible" = first chart svg (or key element) visible from
  navigation start, median of 3 cold authed loads — same gate class as
  the baseline's data-complete.

---

# Round 3 addendum (same day, 2026-06-11 evening)

CDP-profiled the remaining costs, then shipped (commit 9938e81 + review
fixes):

- **The render burst, attributed and fixed.** ONE React commit built all
  chart SVG before anything became visible — /sleep: 1.9 s for 5,260 SVG
  nodes (~0.36 ms/node), /analytics/hrv: 0.85 s + 460 ms layout. New
  `<DeferredMount>` (one-section-per-frame module scheduler, NOT
  viewport-based — everything still mounts unconditionally, so the smoke
  suite's below-fold assertions hold) wraps below-fold sections on both
  pages. Within-session controls: /sleep was 2.4x slower than /whoop
  pre-fix and measures ~33% FASTER than it post-fix; /analytics/hrv went
  from 1.9x slower than control to par. (Absolute medians across sessions
  aren't comparable — machine-load skew; the profiler's phase shares and
  same-session relatives are the transferable result.)
- **Mount animations off app-wide** (~116 series). Measured: they never
  delayed first paint (post-paint rAF work), but cost ~820 ms of 70-220 ms
  jank tasks on /sleep, delayed main-thread settle by ~1.2 s, and FULLY
  REPLAYED on every revalidation commit. Convention: every recharts series
  sets `isAnimationActive={false}`.
- **Deep-equal revalidation bailout.** The silent refetch returned
  byte-identical data in 18/18 measurements yet re-rendered (and
  re-animated) every chart ~1 s after paint (~620-870 ms commit on
  /sleep). All ISR clients now use
  `setX(prev => sameJson(prev, next) ? prev : next)` (lib/format.ts);
  required deterministic secondary ORDER BYs on getWhoopJournal
  (question) and getHrvModelMetrics (model, horizon_days).
- **Tier-2 matviews** (sql/perf_tier2_matviews.sql): tz_log_gaps_mat,
  hrv_prediction_gaps_mat (the two slowest /api/status members: 503/363 ms
  means → ~5-20 ms), spotify_daily_signature_mat, recovery_vs_pace_mat,
  and hrv_residuals_mat (narrow slice — the old all-time read was ALSO
  silently truncated at PostgREST's 1000-row cap, 1,153 rows existed;
  partial-index and date-window alternatives rejected with EXPLAIN
  evidence). One shared refresh fn (per-matview failure isolation + drift
  tripwires), pg_cron :12/:27/:42/:57, ONE 'perf_mats' heartbeat + /status
  card. sql/hrv_prediction_gaps.sql refreshed — the repo copy had DRIFTED
  from production (live 36 h timeliness gate); re-applying the stale file
  would have reverted semantics.
- **Payload trims**: getHrvResiduals 168 kB → ~12 kB; causal dropped_low_n
  projected to its 5 read keys (~48 → 9 kB); /sleep single whoop_sleep
  fetch (main-only derived client-side, −1 query/−33 kB); getWhoopJournal
  explicit 5-column list (−38%); getWorkoutSleepGap recovery sub-query
  date-bounded (was all-time, ~5 months from its own 1000-row truncation).
  These also shrink what the sidebar/tab-bar Link prefetch sweeps.
- **/sleep range changes** keep stale charts visible under a narrow
  "updating…" flag (was: full-page skeleton remounting all charts);
  **useIsMobile** lazy-initializes (was: desktop-width first render then a
  full re-render on phones); **/status poll** is visibility-gated, skips
  the commit on unchanged payloads, and the freshness label self-ticks.
- **Verified non-wins documented** (don't re-investigate): JetBrains Mono
  weight array (variable font — all weights alias the same woff2),
  recharts tree-shaking (sideEffects:false works; unused chart types
  absent from the chunk), the aura-drift background animation
  (compositor-only).
- Verification: tsc/build/lint clean, smoke 17/17 (twice), adversarial
  diff review (caught a dev-only StrictMode stuck-skeleton on /sleep cold
  loads + DeferredMount exception-safety — both fixed pre-push).

## Known remaining work (created as roadmap items)

1. ~~**Chart-render burst**~~ — SHIPPED in round 3 (see addendum).
2. **Security: /api/habits/\* is fully unauthenticated** on the public
   internet (pre-existing; middleware exempts it for the hourly GitHub
   Actions curl and the routes run service-role with no caller auth).
   POST /api/habits/complete can write habit_journal rows for anyone who
   finds the URL. Recommended: shared-secret header (`x-onyx-ci-token`)
   checked in the routes, secret in GH Actions + Vercel env.
3. **Supabase legacy JWT-format API keys EOL end of 2026** — queue the
   sb_publishable_/sb_secret_ migration (Python .env + GitHub secrets +
   Vercel env + frontend anon key). Zero-downtime; orthogonal to this
   work.
4. Second-tier matview candidates if their pages ever feel slow again:
   `hrv_predictions_eval` (638 ms prod mean), `hrv_prediction_gaps`
   (472 ms), `tz_log_gaps` (272 ms), `spotify_daily_signature` (141 ms),
   `recovery_vs_pace` (196 ms) — same pg_cron pattern.
