# Isolated multi-second slow views in the hourly speed runs (PERF-02, 2026-11-16)

Status: **diagnosis only, no fix shipped.** The evidence rules out the suspected scheduled-job collisions and
locates the stall, but it does not yet separate the two remaining causes (below). Read-only evidence: the
three `perf-timing.yml` artifacts, Supabase edge / PostgREST / Postgres / Auth logs, `pg_stat_statements`,
`pg_stat_activity`, `cron.job_run_details` and the GitHub Actions run list. Counts and timings only.

## What the runs show

| Run | Revision | Slow view | Window (UTC) | Shape |
|---|---|---|---|---|
| 43960072854 | 16206d2 | `/nutrition` cold | 21:31:31-33 | 21 calls of 1.0-2.1 s in one view |
| 43969989234 | afecf1b | none over ~1.2 s | - | two calls just over budget |
| 43979183622 | c00caaf | `/nutrition` warm view 4 of 4 | 23:31:56-58 | 22 calls of 1.1-2.6 s in one view |

The Today cold 3.1 s in run 43979183622 is a separate, single slow call (`/api/calendar/events`), already
the subject of PERF-01.

## The stall itself (edge logs, run 43979183622)

* REST requests that **started** between 23:31:56.26 and 23:31:57.94 all **finished** between 23:31:58.65
  and 23:31:58.81: 37 requests from three clients (the browser, Vercel Node functions, one Vercel edge
  function), many tables, both `authenticated` and `service_role`. They were held and released together.
* Requests that started at 23:31:56.44-56.88 and reached the database first finished in 30-60 ms, so the
  database was not stopped outright; requests behind them queued.
* The same thing in run 43960072854: 35 requests finished together at 21:31:33.26-33.43 after 1.0-1.8 s.
* A burst of the same size is normally harmless: in run 43969989234 about 60 requests started within
  0.15 s at 22:32:39 and all finished in 100-170 ms.

## Not the cause (checked)

* **pg_cron**: the only jobs are the matrix refresh (:10/:40, 0.3-1.0 s), the perf matviews (:12/:42,
  1.0-2.0 s, CONCURRENTLY) and a daily purge. Nothing ran at :31 in either window.
* **GitHub Actions**: no workflow that touches the database started or ran during 21:31:20-40 or
  23:31:45-32:05 (the merge train at 23:32:00 does not read the database).
* **PostgREST schema reloads** (DDL notifications): none in either window (the day's reloads were all
  migrations at other times).
* **Checkpoints**: 23:27:44 and 23:32:44 (2.5-7 s spread writes), not at the stall.
* **Autovacuum**: nothing of size near either window.
* **Connection churn alone**: the 20 PostgREST connections are reopened often (about 38,000 sessions in
  5.7 days), but a rebuild observed at 23:49:52 served its requests in 15-190 ms.

## What the stall correlates with

* **The view's own fan-out.** `/nutrition` is the page whose open fires the most parallel reads: its own
  ~22 browser REST reads plus, from the continuous scroll, its neighbours' reads (the Log screen's
  check-in / supplements / reading / journal / weight / drinks routes and Activities' Garmin and WHOOP
  reads), plus the warm-up's next step. The held requests in both windows are mostly those neighbour reads.
  Concurrency at the edge peaked at 41 in the bad 5-second window, but bursts of 50 elsewhere in the same run
  were served in under 0.5 s, so the burst size alone does not explain it.
* **The whole instance was slow, not only Postgres.** During the 21:31:33 stall the Auth service served
  `/.well-known/jwks.json` (no database read) in 85 ms against its usual 0.2 ms, and the gateway added another
  ~780 ms (edge origin time 865 ms). The same Auth slowdown shows at 22:33:06 (71 ms). Everything on the
  single Supabase VM (Postgres, PostgREST, Auth, gateway) was CPU-starved at once.
* **It may not be limited to the speed runs (provisional).** A one-second bucketing of the 2026-11-16 edge logs
  (median REST latency of 700 ms or more across at least 5 requests) found about a dozen such seconds, roughly a
  third inside a perf-timing window and the rest overnight and in the morning. This is a single day, a coarse
  query and not independently re-checked; repeat it over several days before leaning on it.
* The instance is the small shared-CPU size (`max_connections` 60, `shared_buffers` 256 MB) and is
  otherwise almost idle (4 REST requests in the 5 minutes after the run).

## The two causes still open

1. **Our own bursts saturate the instance's CPU.** A /nutrition open (page + scroll neighbours + warm-up)
   sometimes lands as one ~1.5 s wave of 40-60 queries plus PostgREST JSON encoding, more than two shared
   cores finish quickly; whether it does depends on how the neighbour mounts and the warm-up step line up.
2. **Shared-CPU throttling.** The small compute sizes run on burstable CPU; when the instance's CPU
   allowance is spent (or a neighbour on the host takes it), the same burst takes seconds. The out-of-run
   stalls (provisional, above) and the Auth slowdown fit this better than cause 1, but neither proves it.

## What the next measurement needs

* **Instance CPU for the stall minutes** (21:31, 23:31 on 2026-11-16, and the next red run): CPU busy,
  CPU steal / burst balance and load, from the Supabase dashboard's database health charts or the project
  metrics endpoint. High steal or an exhausted burst balance means cause 2; a spike to 100 % busy without
  steal means cause 1. This needs Riley (dashboard) or a run holding the service key; neither was used here.
* **An A/B on the same hour**: `/nutrition` with the continuous scroll on vs off
  (`sessionStorage["onyx.feed"] = "off"`). The harness is owned by PR #373 and was not changed here.

## Instance metrics for the stall minutes (Supabase dashboard, read 2026-11-17)

Read in the dashboard's Observability > Database charts and Settings > Infrastructure (no row data):

* **Compute size Micro: 1 GB RAM, shared CPU.** The total-RAM line rose from ~0.4 GB to ~0.86 GB around
  2026-11-11 (the Nano to Micro move).
* **CPU was mostly idle at both stalls.** 21:33 UTC: idle 78.7 %, user 9.3 %, system 3.0 %, IOwait 6.7 %.
  23:31 UTC showed the same small dip (idle about 75 %). There was no CPU saturation and no steal series near
  100 % busy, so neither cause 1 nor cause 2 as stated above matches.
* **Memory is the constraint.** Swap in use is about 450-650 MB all week, more than the ~400 MB "used" RAM.
  Memory commitment is 1.83-2.0 GB against a ~1.9 GB limit and is flagged SEVERE by the dashboard. It has
  risen steadily since 2026-11-11 and is at or over the limit on 2026-11-16. Swap rose by about 100 MB at
  23:31.
* **Disk IO balance is 44 %.** On Micro, swap paging spends the burst IO budget.
* **Connections are 32 of 60.** PostgREST holds 21 idle connections; the rest is Realtime, exporter and
  management. Postgres settings are the Micro defaults (shared_buffers 256 MB, work_mem 3.5 MB).

**Revised reading:** the instance-wide ~2 s stall fits **memory pressure**: a burst of 40-60 queries on a
1 GB box that is already about 500 MB into swap pages memory back in. That would explain why Auth's JWKS
call slowed too, and why IOwait rises while CPU stays idle. A per-minute chart cannot show a 2 s event
directly, so this is the strongest fit, not proof.

**Fix:** compute size Small (2 GB RAM). About $15.04 a month against Micro's $9.81 (the Pro plan's $10
compute credit covers Micro), so about +$5 a month. Applying it restarts the database for about 2 minutes.
It needs Riley's yes because it changes the monthly bill. The cause-1 mitigation (staggered neighbour
mounts) still lowers the burst size, but it does not remove the swap.

## Why this PR ships no fix

* The two causes need different fixes, and the evidence above cannot tell them apart without the instance
  CPU / steal figures, which need the Supabase dashboard or the service key (not used in this audit lane).
* The cause-1 fix lives in `components/ContinuousScroll.tsx`, which PR #376 is editing; changing it here
  would collide with that PR, and the perf harness that would prove a gain is owned by PR #373.
* The cause-2 fix is a compute-size change with a monthly cost, which is Riley's decision.
* Shipping a guess would also blur the before/after evidence the speed budget asks for. This PR is held
  until the measurement above is in; then the matching fix goes in its own PR with before/after timings
  from the hourly runs.

## Fix options, by cause (not applied)

* Cause 1: in `components/ContinuousScroll.tsx` (owned by PR #376), start a neighbour's mount only after the
  routed page's reads have settled and mount one neighbour at a time; the heaviest single read in the burst,
  `daily_micronutrient_totals` (~160 ms on every call), is a candidate for the matview treatment.
* Cause 2 / memory: compute size Small (2 GB, about +$5 a month net; see the metrics section). Riley's decision: it changes the monthly cost.

Neither loosens the budget or moves the perf schedule.
