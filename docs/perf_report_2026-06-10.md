# Frontend Performance Pass — Overnight Run, 2026-06-10

Unattended overnight pass on the Notion roadmap item **"Improve frontend
performance — slow page loads across the app."** Measure → fix → verify.
All verification green before push: `npm run build`, `npm run lint`, and the
full Playwright smoke suite (17/17 passed) against a local production build
(`npm run start` + `SMOKE_BASE_URL=http://localhost:3000`).

## TL;DR

- **Every chart page's First Load JS dropped from ~280–320 kB to ~104 kB**
  (Recharts deferred to an async chunk; @zxing barcode lib lazy-loaded).
- **/spotify went from ~17+ network requests per load to ~6** (shared plays
  fetch; also fixes silent 1000-row truncation of every Spotify aggregate).
- **/api/status is now edge-cached 30s (+30s SWR)** — within the page's 60s
  poll budget — instead of re-running ~16 Supabase queries per poll.
- One additive DB index (`sync_log(sync_start DESC)`); everything else was
  already index-backed.
- Three structural proposals need sign-off (middleware auth round-trip,
  materialized matrix view, RSC migration) — see "Proposals" below.

## Baseline (measured before any change)

### Bundle sizes (route JS / First Load JS), `next build`

| Route | Before | After |
|---|---|---|
| /supplements | 131 kB / **396 kB** | 1.4 kB / **104 kB** |
| /analytics/hrv | 36.8 kB / **318 kB** | 1.41 kB / **104 kB** |
| /spotify | 18.7 kB / **304 kB** | 1.41 kB / **104 kB** |
| /nutrition | 10.9 kB / **296 kB** | 1.41 kB / **104 kB** |
| /sleep | 10.8 kB / 296 kB | 1.42 kB / 104 kB |
| /activities | 9.34 kB / 294 kB | 1.41 kB / 104 kB |
| /caffeine | 7.09 kB / 293 kB | 1.41 kB / 104 kB |
| /whoop | 6.58 kB / 291 kB | 1.41 kB / 104 kB |
| /habits | 7.23 kB / 286 kB | 1.4 kB / 104 kB |
| /heart | 4.78 kB / 283 kB | 1.41 kB / 104 kB |
| /bland-altman | 6.93 kB / 278 kB | 1.4 kB / 104 kB |
| /status | 4.8 kB / 213 kB | 8.22 kB / 213 kB (unchanged net; chunk reattribution) |
| /journal | 2.44 kB / 161 kB | 8.19 kB / 162 kB (unchanged net; chunk reattribution) |

(The full bodies still download — as an *async* chunk after the shell paints,
behind the loading state each page already showed while fetching data. The
win is parse-before-first-paint and shell/nav responsiveness, plus pages like
/supplements that shipped 120 kB of barcode-scanner code nobody used on load.)

### Architecture findings

- **All 16 dashboard pages are `"use client"` components** fetching from the
  browser via supabase-js in `useEffect` after hydration. No server-side data
  fetching, no segment caching anywhere.
- **Middleware runs a network `supabase.auth.getUser()` on every matched
  request** (every navigation + every /api call) — a Supabase Auth round trip
  before any page work starts. Left in place (see Proposals).

### Per-page query traces (before)

- **/spotify** — ~17+ requests: 8 independent `spotify_plays` scans (KPIs,
  genre rotation, discovery, top artists, top tracks, hour-of-day, sonic
  profile, top genres), each **silently capped at PostgREST's 1000-row
  default**; 2 *sequential* chunk-loops over `spotify_artists` (~3 chunks
  each); 1 sequential chunk-loop over `spotify_tracks` features; a
  *sequential* page-loop over all prior plays for discovery; + 2 signature-
  view reads + ledger. (1,333 plays / 898 tracks / 534 artists at measure
  time, so the 1000-row cap was already truncating all-time ranges.)
- **/analytics/hrv** — 26 queries, already parallel (`Promise.all`). 9 are
  single-row `hrv_analysis_results` JSON blobs — all small (≤22 kB, measured).
  2 hit `daily_health_matrix_behavioral`, which costs **~190 ms execution +
  ~77 ms planning per query** (measured via EXPLAIN ANALYZE) because the view
  re-runs its full join tree per query.
- **/api/status** — ~17 queries (1 sync_log top-100 + 16 parallel `limit(1)`
  freshness probes). Already parallel; the problem was re-running all of it
  on every 60s poll with zero caching.
- **/nutrition** — 6 fetches, already parallel-ish (Promise.all of 3 +
  servings + weight + behavioral-today). No waterfall worth fixing; the
  selects are already column-narrowed or read intentionally-wide views.

### Database

Row counts are small (spotify_plays 1.3k, hrv_predictions 12k, sync_log 5.4k).
Index audit: every hot predicate already index-backed (behavioral-date
indexes on all source tables, `spotify_plays(played_date_et)`,
`hrv_predictions` tiebreak index, `hrv_analysis_results(result_type,
result_key)` unique). One gap found and fixed (below).

## Fixes shipped

| Commit | Fix |
|---|---|
| `6041d5d` | **/supplements:** lazy-load `BarcodeScannerModal` (`@zxing/browser`, ~120 kB) via `next/dynamic` + conditional render — chunk now fetched only when the scanner opens. Route JS 131 → 13.1 kB. |
| `7029401` | **/spotify:** new `getSpotifyDashboard()` fetches the range's plays ONCE (count + parallel `.range()` pages — no more silent 1000-row truncation), the artist-genre map once, and track features once (chunks in parallel), computing all 8 aggregates from shared rows. Per-aggregate exports kept as thin wrappers, return shapes unchanged. ~17+ requests → ~6 in 3 parallel waves. |
| `4cb80a6` | **/api/status:** `Cache-Control: public, s-maxage=30, stale-while-revalidate=30` (worst-case ~60s stale = the page's own poll interval). **/api/behavioral-today:** 60s+60s. Write-coupled routes (weight, supplements, habits, meals) deliberately NOT cached — a just-logged entry must appear immediately. |
| `32502b8` | **DB:** `CREATE INDEX idx_sync_log_sync_start ON pds.sync_log (sync_start DESC)` (applied as Supabase migration `perf_idx_sync_log_sync_start`; sql/perf_idx_sync_log_sync_start.sql). Serves /api/status's global top-100 recency scan; the only existing index was the composite `(source, data_type, sync_start)` which can't serve a global sort. Table grows ~70k rows/yr. |
| `a031078` | **Bundle:** 11 Recharts-heavy page bodies moved to `<Name>Client.tsx`, with `page.tsx` a thin `next/dynamic(ssr:false)` wrapper. First Load JS ~280–320 kB → ~104 kB per chart page. |

## Verification

- `npm run build` — green (route table above).
- `npm run lint` — only pre-existing warnings (unused vars in
  analytics/travel, heart, nutrition, hrv pages — untouched).
- Playwright smoke suite vs local `npm run start` production build:
  **17/17 passed** (incl. the precise /analytics/hrv and /supplements
  assertions and all "no empty-state fallback" tripwires).

## Skipped / nothing-to-do

- **Waterfalls on /nutrition, /analytics/hrv, /api/status** — already
  parallel (`Promise.all`); no change needed.
- **hrv_analysis_results blobs** — measured small (≤22 kB); the 9 limit-1
  queries run in parallel, consolidation would buy little. Skipped.
- **Over-fetch narrowing on `getDailyVitamins` / `getDailyNutrientsFull`
  (`select *`)** — the panels genuinely render the full nutrient set;
  30-day windows keep payloads modest. Skipped.
- **Caching write-coupled API routes** — intentionally not cached.
- Nothing was attempted and reverted; no fix hit the 3-attempt limit.

## Proposals (need your sign-off — not done)

1. **Middleware auth round trip.** `middleware.ts` calls
   `supabase.auth.getUser()` (network, ~50–150 ms to us-east-1) on **every**
   page navigation and API hit. It IS the security boundary for the
   service-role /api routes, so I didn't touch it. Proposal: migrate the
   Supabase project to asymmetric JWT signing keys and use local JWT
   verification (`getClaims()`) in middleware — same guarantee, zero network.
2. **Materialize `daily_health_matrix_behavioral`.** ~270 ms (plan+exec) per
   query, paid 2× on /analytics/hrv, 1× on /caffeine //nutrition. Since ETLs
   are hourly, a materialized view refreshed post-ETL (or a `pg_cron`
   refresh) would make these near-instant. Blocked by the overnight
   "no view/schema changes" restriction.
3. **Server-component data fetching.** Every dashboard fetches from the
   browser after hydration: shell → hydrate → (chunk) → N queries from the
   client. Moving reads into RSC/route-segment caching (`unstable_cache`,
   hourly revalidate to match the ETL cadence) would deliver data-complete
   HTML in one round trip. Large refactor; propose doing it page-by-page
   starting with /status and /analytics/hrv.

## Notes

- `/analytics/travel` route JS grew 5.34 → 20.6 kB from chunk redistribution
  (Recharts no longer shared with other synchronous routes); its First Load
  JS is unchanged (233 kB → 233 kB). Same effect, smaller, on /status and
  /journal route-size numbers.
- The Spotify >1000-row paging is also a **correctness** fix: all-time
  ranges previously computed KPIs/top-lists over a truncated sample.
