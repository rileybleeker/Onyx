# Onyx production performance evidence, 2026-11-12

Measured, authenticated, against production, after PR #20 ("HRV dashboard analysis requests 17 to 3") shipped. Three runs of the same suite on 2026-11-12 (about 02:58 to 03:24 UTC), 15 navigations per page per run.

## Headline

- **Where the time goes.** Every one of the 405 page documents was answered by the CDN (cache `HIT` 382, `PRERENDER` 23, none by a function), with a first byte in 4 to 30 ms from the runner. The user-visible time is the browser's work and the data calls, not the server.
- **Slowest of the eight requested pages, time until the page shows its data (warm, p50 / p95):** `/supplements` 538 / 604 ms, `/today` 432 / 562 ms, `/nutrition` 411 / 421 ms (run 3, the only run with no production deploy during it; ranges over all three runs are in the table below). `/agents` has the longest tail (p95 492 to 826 ms).
- **PR #20 is confirmed live as designed:** `/analytics/hrv` makes 16 `/rest/v1` requests per view, 3 of them to `hrv_analysis_results` (was 17 of 30). That is a request-count confirmation, **not a speedup**. See "What this does not show".
- **BEFORE could not be measured live** (reason below). There is no before/after timing in this document and none is claimed.

## Method

- Workflow `.github/workflows/perf-timing.yml` (manual only, no schedule, no pull_request trigger) runs `frontend/e2e/perf-timing.spec.ts` on a GitHub-hosted `ubuntu-24.04` runner (4 vCPU, 16 GB, Chromium 148). It signs in once with the smoke-test account (`frontend/e2e/auth.setup.ts`, the same repo secrets as the production smoke test) and reuses that session.
- Per page, a fresh browser context makes 15 full-document navigations, 1 s apart. Navigation 1 starts with an empty browser cache (**cold**, one sample per run). Navigations 2 to 15 reuse the cache (**warm**, 14 samples); percentiles are computed from the warm ones only. p95 of 14 samples is an interpolation close to the worst sample, so read it as a tail indicator.
- Per navigation: TTFB, FCP and LCP from the browser's performance entries; **data ready** = the first moment the page shows its real content, on the page's own clock (list below); **first chart** = first drawn chart mark inside `<main>` (sidebar sparkline and legend icons excluded); and every network request until the page has been quiet for 1.5 s: class (`/rest/v1` Supabase, `/api`, agents Worker, RSC prefetch, static chunk), path only, duration (browser `responseEnd`), transferred bytes. Query strings, headers, cookies and bodies are never recorded.
- Data-ready definitions: `/today` all three loading lines gone; `/analytics/hrv` hero tile plus a chart mark; `/sleep`, `/nutrition`, `/caffeine` a chart mark (or the page's empty state); `/supplements` "Today's compound totals" heading with no "Loading..." left; `/agents` the "Loading..." line replaced by the list; `/status` more than four "Last Sync" rows. `/caffeine?days=720` is an extra row: a non-default window, so no ISR seed and a client fetch with real rows.
- Run 1 reached the runner's closest Vercel edge `iad1`; runs 2 and 3 reached `cle1`. That is why TTFB reads 4 ms in run 1 and 27 to 30 ms in runs 2 and 3 on every page (cold TTFB 15 to 27 ms versus 85 to 131 ms). It is network geography, not the application. Compare data-ready across runs, not TTFB. The same distance shows in the Supabase calls: `hrv_analysis_results` took 47 ms per call in run 1 and 113 to 115 ms in runs 2 and 3, so the per-call millisecond ranges quoted below span both placements.
- Offline checks: the aggregation and request classification have a unit test (`frontend/tests/perf-stats.test.cjs`, run by the `frontend-types` job). The spec's mechanics were also dry-run against a throwaway local fake before the first production run.
- Raw JSON for the three runs is in the workflow artifact `perf-timing-results` of GitHub runs 43144834859, 43145939652 and 43147022506 (kept 30 days). Regenerate any table with `node frontend/e2e/perf-report.cjs <dir> [<dir> ...]`.

## Results (run 3, warm navigations, milliseconds)

| Page | TTFB p50 / p95 | FCP p50 / p95 | LCP p50 / p95 | **Data ready p50 / p95** | Cold data ready (3 runs) | Requests | `/rest/v1` | `/api` | Worker | KB over wire |
|---|---|---|---|---|---|---|---|---|---|---|
| /today | 28 / 29 | 112 / 155 | 416 / 523 | **432 / 562** | 648 to 1010 | 49 | 0 | 2 | 1 | 12 |
| /analytics/hrv | 30 / 30 | 118 / 135 | 396 / 404 | **378 / 385** | 593 to 746 | 59 | 16 | 0 | 0 | 119 |
| /sleep | 27 / 33 | 104 / 140 | 378 / 393 | **365 / 369** | 574 to 735 | 50 | 6 | 0 | 0 | 22 |
| /nutrition | 30 / 30 | 110 / 147 | 426 / 441 | **411 / 421** | 583 to 763 | 53 | 7 | 2 | 0 | 11 |
| /supplements | 27 / 29 | 106 / 161 | 544 / 590 | **538 / 604** | 661 to 1342 | 47 | 0 | 5 | 0 | 5 |
| /agents | 30 / 30 | 100 / 112 | 426 / 724 | **409 / 706** | 572 to 1091 | 42 | 0 | 0 | 1 | 8 |
| /status | 27 / 29 | 106 / 131 | 188 / 222 | **170 / 202** | 848 to 1513 | 43 | 0 | 1 | 0 | 3 |
| /caffeine | 30 / 31 | 104 / 123 | 408 / 465 | **395 / 434** | 615 to 714 | 47 | 3 | 0 | 0 | 5 |
| /caffeine?days=720 (extra) | 28 / 29 | 106 / 119 | 320 / 325 | **625 / 662** | 781 to 910 | 47 | 3 | 0 | 0 | 9 |

"Requests" counts everything the page view made, including 28 to 32 static chunks served from the browser cache and 11 to 14 tiny RSC prefetch requests from the sidebar links (about 1 KB in total). All 15 of 15 navigations reached data-ready on every page in every run; no navigation hit an error state or failed to go network-quiet.

## Stability: three runs of the same suite (data ready p50 / p95, ms)

| Page | Run 1 | Run 2 | Run 3 | p50 spread, runs 2 vs 3 | p50 spread, all three |
|---|---|---|---|---|---|
| /today | 386 / 1123 | 431 / 746 | 432 / 562 | 0.2% | 12% |
| /analytics/hrv | 420 / 430 | 380 / 403 | 378 / 385 | 0.5% | 11% |
| /sleep | 396 / 611 | 365 / 384 | 365 / 369 | 0.0% | 9% |
| /nutrition | 463 / 490 | 410 / 563 | 411 / 421 | 0.2% | 13% |
| /supplements | 515 / 608 | 530 / 624 | 538 / 604 | 1.5% | 5% |
| /agents | 257 / 492 | 355 / 826 | 409 / 706 | 15% | 59% |
| /status | 147 / 181 | 179 / 263 | 170 / 202 | 5% | 22% |
| /caffeine | 432 / 445 | 386 / 399 | 395 / 434 | 2% | 12% |
| /caffeine?days=720 | 653 / 695 | 615 / 655 | 625 / 662 | 1.6% | 6% |

- Seven of nine pages hold their p50 within 13% over all three runs, and within 2.5% between runs 2 and 3. That is the level of change this method can and cannot see: **anything smaller than about 15% on these pages is noise.**
- `/agents` and `/status` are not stable: `/agents` waits on a cross-origin Cloudflare Worker call (p50 158 to 310 ms between runs), and `/status` is small enough (about 150 to 180 ms) that a 30 ms shift is 20%. The `/today` p95 moved from 1123 to 562 ms between runs because two of its calls had slow tails in run 1.
- Production deploys landing mid-run (the merge train deploys every few minutes): run 1, one at 02:58:13Z during the first seconds of `/today`; run 2, five (03:09:07, 03:10:08, 03:10:18, 03:10:29, 03:13:12Z); run 3, none. Runs 2 and 3 still agree within 2.5% on seven pages, so a handful of post-deploy `PRERENDER` loads (23 across all runs) did not move the medians, but they do fatten tails.

## BEFORE: not measured live

The production deployment from just before PR #20 exists and is READY (`frontend-hp1bh1nj6`, commit a506d26, created 01:08:16Z), and so does the first one containing it (`frontend-qi3nmva2m`, commit 28877f4, 01:12:55Z). `git diff a506d26 28877f4` is PR #20, a new `/procurement` route and one nav entry, so it would be a close A/B for `/analytics/hrv`. Both URLs, and every other per-deployment URL, answer with a redirect to Vercel's SSO login (HTTP 302 to `vercel.com/sso-api`), so the workflow cannot load them without a Vercel deployment-protection bypass secret. Creating or handling one is a project-settings change and a new credential nobody authorized here, and the smoke login must not be pointed at an arbitrary URL, so it was not attempted. Nothing was redeployed. If Riley wants the live A/B: add the bypass secret as a repo secret, pass it as `x-vercel-protection-bypass` with `x-vercel-set-bypass-cookie=true` on the first navigation only (a header on every request would break the cross-origin Supabase calls), and point `SMOKE_BASE_URL` at the two deployment URLs one run at a time.

**Offline evidence only (PR #20, not measured here):** HRV analysis requests per dashboard load 17 to 3 (82.4% fewer), whole-dashboard nominal database requests 30 to 16, identical output on a synthetic fixture. The live count above (16 total, 3 to `hrv_analysis_results`) matches the "after" side of that claim.

## What this does not show

- **No speedup is demonstrated, and none is claimed.** Without a before measurement there is nothing to subtract.
- **PR #20 cannot have shortened `/analytics/hrv`'s time to data, and the data says why.** That page is an ISR page: it paints from data already inside the HTML and re-reads in the background. In 42 of 42 warm navigations (14 per run) the page was showing its first chart before its last `/rest/v1` request finished (page ready at about 380 ms, last of the 16 requests done at about 750 to 860 ms). The same is true of `/sleep`, `/nutrition` and `/caffeine` (42 of 42 each). So cutting requests there lowers database and bandwidth load per view; it does not move time-to-data. This agrees with the PR's own statement that it claims no latency gain.
- It is not Riley's device. A runner next to the edge flatters network time (Riley's earlier hand measurements in Chrome, noted on the Notion row, read the HRV page at about 1.7 s to data from home), while its CPU may differ from a phone's. Every extra sequential round trip costs more from home than the figures above suggest; treat the absolute milliseconds as a floor and the request counts and chain shapes as the transferable part.
- Not measured: phones or throttled CPU, in-app (client-side) navigation, interaction latency, long main-thread tasks, the `/agents` background polling cost (every 5 s while the tab is visible), anything behind the other pages.
- Cold = one sample per page per run (three per page), a range rather than a percentile. It means an empty browser cache with a warm CDN, which is also what the first load after every deploy looks like (chunk hashes change). Production saw 25 deployments (17 completed) in the 90 minutes before the first run, so cold loads are not rare.

## Hotspots, ranked by measured cost

1. **Client-only waterfall on `/supplements` (slowest page: 538 / 604 ms warm, 661 to 1342 ms cold).** Five `/api` calls fire in parallel after the page chunk loads and hydrates; the slowest call is `/api/supplements/stacks` (195 to 257 ms p50), yet data-ready is about 540 ms. So roughly 280 to 320 ms is spent before the first request even starts (inference: ready minus the slowest call). The page is deliberately not ISR (write-coupled), so the lever is starting the reads earlier or seeding them, not a faster query.
2. **Hydration plus chart commit on the four ISR dashboards (`/analytics/hrv`, `/sleep`, `/nutrition`, `/caffeine`): about 260 to 300 ms between first paint (FCP about 105 to 118 ms) and the first chart (365 to 411 ms), on a 4-vCPU runner.** This is all of their user-visible wait, it is CPU work (it would be larger on a phone), and it comes before any data request completes. Candidate: chart bundle and mount work, which the data requests cannot help.
3. **`/today` tail (p50 432, p95 562 to 1123 ms).** Three parallel calls gate the page; the long pole is `/api/reading` (p50 268 to 317 ms, per-call p95 up to 1005 ms in run 1), then `/api/urgent-email` (p50 128 to 163 ms, p95 up to 697 ms) and the Worker inbox (129 to 296 ms).
4. **Database work behind the silent revalidations (load, not latency).** `/analytics/hrv` costs 16 requests and 118 KB per view (1.4 to 1.5 s of summed request time in runs 2 and 3): `hrv_analysis_results` 3 calls and 68 KB (the largest payload anywhere), `hrv_predictions_latest` 4 calls, `daily_health_matrix_behavioral_mat` 2 calls. `/sleep` makes 6 and `/nutrition` 7 (its `daily_micronutrient_totals` is the slowest single REST call measured, 193 to 247 ms p50). Same-table repeats on HRV (6 of 16 calls) are the cheapest candidates to merge. Worth doing for the database, but per the finding above it will not change time-to-data.
5. **Cold first load: 0.6 to 1.5 s** (`/status` 848 to 1513 ms versus 147 to 179 ms warm, `/supplements` up to 1342 ms). The cost is fetching and running the JS chunks; shared first-load JS is 103 kB per the PR #20 report. Worth a look because deploys make most first loads of the day cold.
6. **`/agents` Worker call (p50 158 to 310 ms, p95 up to 583 ms)** and its 59% run-to-run swing; a cross-origin call with no seed, so network distance shows through.
7. Not a hotspot: sidebar RSC prefetch (11 to 14 requests, about 1 KB, parallel) and server first-byte time (all CDN). Sixty-odd requests per page view reads alarming but 30 of them are cache hits on static chunks.

Next measurement to run: the same suite after the next change aimed at items 1 or 2, compared against run 3 here, with the 15% noise floor above in mind; and the live A/B for PR #20 if the bypass is provided.

## Reproduce

`gh workflow run perf-timing.yml` (after this PR is merged) uses the repo secrets `SMOKE_BASE_URL`, `SMOKE_TEST_EMAIL`, `SMOKE_TEST_PASSWORD`; the optional input `navigations` defaults to 15. A run takes about 9 minutes and loads each page 15 times. Avoid starting it at the top of an hour or during a burst of merges, and check `vercel ls --environment production` for deploys inside its window. The three runs behind this document were started from the evidence branch through a temporary push trigger, which is not in the merged workflow (GitHub only dispatches a workflow file that already exists on the default branch).
