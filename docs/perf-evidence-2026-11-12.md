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

`gh workflow run perf-timing.yml` (after this PR is merged) uses the repo secrets `SMOKE_BASE_URL`, `SMOKE_TEST_EMAIL`, `SMOKE_TEST_PASSWORD`; the optional input `navigations` defaults to 15. Under harness version 1 a run took about 9 minutes and loaded each page 15 times when this document was written; with today's pages the last version 1 scheduled run before version 2 (4 navigations per page) measured about 11 minutes from its first page to its last, plus 3-4 minutes of setup. Version 2 estimates, projected from that run and not yet measured: the hourly 4-navigation run about 16-18 minutes of measurement; a manual 15-navigation run (the dispatch default) about 36 minutes of measurement plus setup, close to the job's 45-minute limit (a run that reaches it is cancelled and the speed budget step never runs). For a deep run use `gh workflow run perf-timing.yml -f navigations=10` (about 30 minutes in all). A run of more than 4 navigations per page skips the observe-only phone scenario to stay inside the limit; the hourly run measures it. The real run lengths and the per-run request count are checked on the first version 2 scheduled run. Avoid starting it at the top of an hour or during a burst of merges, and check `vercel ls --environment production` for deploys inside its window. The three runs behind this document were started from the evidence branch through a temporary push trigger, which is not in the merged workflow (GitHub only dispatches a workflow file that already exists on the default branch).

## Later: harness version 2 (2026-11-16)

Every number above is harness version 1. Version 2 (`frontend/e2e/perf-timing.spec.ts`, `perf-stats.cjs`) keeps the version 1 fields with their definitions (TTFB, data ready, the network-quiet request totals and the speed budget's rules) and adds, per result file:

- the production build measured: the SHA from `/api/version` read at the start and at the end of each page. A result is bound to a build only when both reads succeeded and agree; `mixed` = a deploy landed in between, `partial` = only one read succeeded (shown as unbound), `unknown` = neither. Only bound results pool across runs;
- the cache state of each navigation: browser cache `empty` (first navigation, new context), `warm`, or `prewarmed` (an in-app click after Today loaded; never called cold), with the document's CDN state and whether a function ran as observed, or `unknown`; a function's cold start is never visible and is always `unknown`. Each in-app click records how long Today had been open (`sinceTodayMs`);
- a fixed window from the navigation itself (6 s from navigation start for a full load, 4 s from the click for an in-app navigation, starting at the first pointer event on the link so Playwright's checks before the click never use the window up; data ready is still timed from just before the click, as in version 1), split into routed requests (started before data-ready), background requests (after it: continuous-scroll neighbours, warm-up data, revalidation) and router prefetches, each by origin (network, browser cache, service worker, or `unknown` when the browser did not report it), plus long-task blocking time and when the first neighbour page and the first prefetch appeared inside the window. Requests that started before an in-app click are counted apart and excluded. The window's cost is decided at one moment, 2 s after its end: a request that started in it and finished by then is measured, one still open then is reported as unfinished (cost unknown), never as a zero-cost request, even if it finished later while the network-quiet wait went on. Windows are taken on navigations 1-4 of each full-load page (all of them in the hourly run) and on in-app rounds 2 and later; in-app round 1, the enforced first in-app visit, keeps version 1 spacing so the Today warm-up before each first click is as long as under version 1;
- n, p50 / p90 / p95, IQR and MAD for warm data ready, with a low-n warning below 10 samples; several result directories pool per page and method (harness version, scenario, viewport, the CPU slowdown actually in force, the fixed window and its rule) and exact production SHA;
- a 390 px phone scenario (iPhone 13 metrics on Chromium, CPU 4x slower): loads of Today and Log, and taps on the bottom bar (input to next paint, tap to ready, blocking time). It is observed only (`enforced: false`): reported on every run that has it, never part of the budget's exit code, until repeated scheduled runs justify enforcing it. Each phone test has a time budget (no navigation or tap starts after it, the rest are reported as not tried) and a timeout that covers the budget plus one worst-case step, so it cannot time out and fail the run. A phone result file that a 4-navigation version 2 run did not write is reported as not measured; a deeper run skips the scenario and says so.

Comparing across versions: version 2 observes the windowed navigations for at least the fixed window, so the next navigation starts later than under version 1 (warm full loads and in-app rounds 2 and later), and it adds a browser network listener and in-page observers. A difference between a version 1 run (for example the artifacts behind this document, or any older scheduled run) and a version 2 run is therefore not evidence of a speed-up; compare version 2 runs with version 2 runs of the same production SHA and method.

Baseline: the version 1 fields are compared against the last version 1 scheduled run before version 2 merges. Its artifact is kept privately, outside this repository, with a checksum; the result files hold timings and request paths only, but they are not published here.
