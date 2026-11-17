# Isolated multi-second slow views in the hourly speed runs (PERF-02, 2026-11-16)

Status: **diagnosis only.** The last section (2026-11-16) adds a lazy-loading change for the two Today finance
routes, proposed in PR #396: it is not deployed and its effect on speed has not been measured. The evidence rules out the suspected scheduled-job collisions and
locates the stall, but it does not prove its cause. Three candidates remain open (below): our own fan-out,
shared-CPU contention and memory pressure (swap). The dashboard metrics favour memory pressure, but they are
minute averages and cannot show a 2 s event. Read-only evidence: the
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
  single Supabase VM (Postgres, PostgREST, Auth, gateway) slowed at once. That points to a shared resource on the
VM (CPU, memory or disk IO), not to one service. The logs do not show which.
* **It may not be limited to the speed runs (provisional).** A one-second bucketing of the 2026-11-16 edge logs
  (median REST latency of 700 ms or more across at least 5 requests) found about a dozen such seconds, roughly a
  third inside a perf-timing window and the rest overnight and in the morning. This is a single day, a coarse
  query and not independently re-checked; repeat it over several days before leaning on it.
* The instance is the small shared-CPU size (`max_connections` 60, `shared_buffers` 256 MB) and is
  otherwise almost idle (4 REST requests in the 5 minutes after the run).

## The candidate causes still open

1. **Our own bursts overload the instance.** A /nutrition open (page + scroll neighbours + warm-up)
   sometimes lands as one ~1.5 s wave of 40-60 queries plus PostgREST JSON encoding, more than two shared
   cores finish quickly; whether it does depends on how the neighbour mounts and the warm-up step line up.
2. **Shared-CPU contention (a hypothesis, not proof of CPU-credit exhaustion).** The small compute
   sizes run on shared CPU; contention with other tenants on the host could stretch the same burst to
   seconds. Supabase's documented burst behaviour for shared compute is disk IO, not a spendable CPU
   allowance, so "burst balance spent" is not an available explanation for CPU. The minute-average CPU
   idleness weakens this cause but cannot exclude a 2 s spike. The out-of-run stalls (provisional, above)
   and the Auth slowdown fit it, but nothing here proves it.
3. **Memory pressure (swap).** The Micro instance (1 GB) has about 450-650 MB in swap all week and memory
   commitment at its limit (see the metrics section). A burst that touches cold pages pays disk reads, and
   that slows every service on the VM. This fits the instance-wide slowdown and the IOwait bump, and it fits
   the minute-average idle CPU better than causes 1 and 2 — which weakens, but does not exclude, the CPU
   causes, because a minute average cannot show a 2 s burst.

## What the next measurement needs

* **Instance CPU for the stall minutes** (21:31, 23:31 on 2026-11-16, and the next red run): CPU busy,
  CPU steal / burst balance and load, from the Supabase dashboard's database health charts or the project
  metrics endpoint. These are evidence, not a decision rule: high steal or an exhausted burst balance would
  support cause 2, a sustained spike to 100 % busy without steal would support cause 1, and a quiet CPU
  together with paging would support cause 3 — minute-level series may still miss a 2 s event, so absence
  in these charts weakens a CPU cause without excluding it. This needs Riley (dashboard) or a run holding
  the service key; neither was available when the diagnosis was written.
* **An A/B on the same hour**: `/nutrition` with the continuous scroll on vs off
  (`sessionStorage["onyx.feed"] = "off"`). The harness is owned by PR #373 and was not changed here.

## Instance metrics for the stall minutes (Supabase dashboard, read 2026-11-17)

Read in the dashboard's Observability > Database charts and Settings > Infrastructure (no row data):

* **Compute size Micro: 1 GB RAM, shared CPU.** The total-RAM line rose from ~0.4 GB to ~0.86 GB around
  2026-11-11 (the Nano to Micro move).
* **CPU was mostly idle in the stall minutes (minute averages).** 21:33 UTC: idle 78.7 %, user 9.3 %, system 3.0 %, IOwait 6.7 %.
  23:31 UTC showed the same small dip (idle about 75 %). There was no CPU saturation and no steal series near
  100 % busy. A minute average cannot rule out a 2 s CPU spike, so causes 1 and 2 are weakened, not excluded.
* **Memory is the constraint.** Swap in use is about 450-650 MB all week, more than the ~400 MB "used" RAM.
  Memory commitment is 1.83-2.0 GB against a ~1.9 GB limit and is flagged SEVERE by the dashboard. It has
  risen steadily since 2026-11-11 and is at or over the limit on 2026-11-16. Swap rose by about 100 MB at
  23:31.
* **Disk IO balance is 44 %.** On Micro, swap paging spends the burst IO budget.
* **Connections are 32 of 60.** PostgREST holds 21 idle connections; the rest is Realtime, exporter and
  management. Postgres settings are the Micro defaults (shared_buffers 256 MB, work_mem 3.5 MB).

**Current reading (a hypothesis, not proof):** the instance-wide ~2 s stall fits **memory pressure** best: a burst of 40-60 queries on a
1 GB box that is already about 450-650 MB into swap pages memory back in. That would explain why Auth's JWKS
call slowed too, and why IOwait rises while CPU stays minute-average idle. A per-minute chart cannot show a
2 s event directly, so this reading is a best fit, not an identification.

**Mitigation experiment (not a cause-isolating test):** compute size Small (2 GB RAM). About $15.04 a month
against Micro's $9.81 (the Pro plan's $10 compute credit covers Micro), so about +$5 a month. It needs
Riley's approval because it changes the monthly bill, and applying it restarts the database for about
2 minutes of downtime. Small does not isolate the cause: it also raises the baseline disk IO capacity (the
documented shared-compute burst is disk IO) and the restart itself perturbs the instance, so a stall-free
period after the resize would support the memory hypothesis without settling the cause, and a resize that
changes nothing would weaken it. To be meaningful the experiment needs matched windows (same revision, same
cache state, same workload), feed-on versus feed-off runs, a stall frequency with a sample count rather
than a single run, and correlated paging, IO and CPU measurements from the dashboard across the windows.
The cause-1 mitigation (staggered neighbour mounts) still lowers the burst size, but it does not remove the
swap.

## Current state

The diagnosis is merged and PERF-02 is open: no fix and no compute change has been applied. The next
measurement is still the one above — instance CPU for the stall minutes, and (with Riley's approval of the
monthly cost) the Small resize run as the mitigation experiment with matched windows. The cause-1 fix
lives in `components/ContinuousScroll.tsx`; the perf harness that would prove a gain is owned by PR #373.
Whatever change lands, it goes in with before/after timings from the hourly runs, and neither loosens the
budget nor moves the perf schedule.

## Fix options, by cause (not applied)

* Cause 1: in `components/ContinuousScroll.tsx` (owned by PR #376), start a neighbour's mount only after the
  routed page's reads have settled and mount one neighbour at a time; the heaviest single read in the burst,
  `daily_micronutrient_totals` (~160 ms on every call), is a candidate for the matview treatment.
* Cause 2 / memory: the Small resize as the mitigation experiment described above (2 GB, about +$5 a month
  net). It needs Riley's approval because it changes the monthly cost, and it cannot by itself identify the cause.

Neither loosens the budget or moves the perf schedule.

## Runs 43995593029 and 44003258302: what they show, and one hypothesis tested in code (2026-11-16)

These are observations from two runs. Neither proves a cause; each hypothesis below says what evidence it rests
on and what would confirm or refute it. One cold view and three warm views per page is a small sample, and the
cold view's function / CDN state was not controlled.

**Run 43995593029** (harness v2; result groups served c5c8f436 (6), ba4af90b (20) and a mix of revisions (2)).
Five enforced breaches, kept as recorded and not pooled across revisions:

| Breach | Served revision | Repeats | Coincides with |
|---|---|---|---|
| Today cold data-ready 1143 ms | c5c8f436 | cold, 1 view | first page of the run, 25 min after the previous run |
| Today cold `/api/finance/alerts` 1033 ms | c5c8f436 | cold, 1 view | same view |
| Today cold `/api/procurement/renewals/summary` 1021 ms | c5c8f436 | cold, 1 view | same view |
| `/supplements` warm data-ready, max 1759 ms (p95 1689 ms) | mixed | **2 of 3 warm views over budget** | ba4af90b promoted to Production at 01:34:20, inside the page's window |
| `/supplements` warm `/api/weight`, max 1084 ms | mixed | 1 of 3 warm views | same window |
| phone Today tap, max 4750 ms (observational) | mixed | 3 taps | 71c5cc79 promoted at 01:45:19, inside the tap series |

**Run 44003258302** (harness v2; all 28 result groups served 62243ab8, a single revision; before PR #396). Five
enforced breaches: Today cold data-ready 4886 ms, Today warm data-ready max 1006 ms (1 of 3), Today cold
`/api/urgent-email` 2480 ms, Today cold `/api/nyc/leads` 1016 ms, Log cold data-ready 1017 ms. Observational:
phone Today warm max 1027 ms (1 of 3), phone Log cold 1291 ms; phone Today taps max 766 ms (3 of 3 fine). In
this run the two finance routes were **not** among the breaches: cold `/api/finance/alerts` 361 ms,
`/api/procurement/renewals/summary` 349 ms, `/api/ui/preferences` 188 ms.

What was checked, and what it does and does not show:

* **Database time.** `pg_stat_statements`: the finance result-cache read averages 0.6 ms (max 7.8 ms),
  `ui_preferences` 0.1 ms, `weight_log` 0.1 ms, today's compound rollup uses its index (0.3 ms). During both
  promotion windows of run 43995593029 the Supabase edge origin times had a 20-60 ms median (max 433 ms). These
  are aggregates; they make a slow query an unlikely explanation for these breaches but do not exclude a single
  slow request.
* **First PostgREST requests and the signing-key fetch.** In the Today cold view of run 43995593029, the first
  wave of REST requests had origin times of 185-285 ms; the same tables a second later took 25-55 ms. The first
  middleware instances fetched `/.well-known/jwks.json` at 270-290 ms (the warm fetch is 6 ms). This shows a
  first-request cost in that view; how much of each breach it explains is not measured.

**Hypothesis A (the one PR #396 acts on): the two finance routes pay extra cold-start time for their module
graph.** Evidence: on the same cold view, the finance routes took about 180-190 ms longer than
`/api/ui/preferences` in run 43995593029 (1021-1033 ms vs 841 ms) and about 160-175 ms longer in run 44003258302
(349-361 ms vs 188 ms); both answer a stored one-row read, but at import time they loaded the forecast engine,
tax plan, budgets and subscription detection (26 modules, ~349 KB of source) that a stored answer does not use.
What it does not establish: the routes also differ in their handlers and queries, and two cold samples with
uncontrolled function state cannot attribute the difference to module loading. PR #396 makes
`lib/finance-result-cache-server.ts` load those modules with `import()` only when it computes (a stored answer now
loads 7 modules / ~53 KB for alerts and 10 / ~97 KB for renewals) and takes the service-role client from the new
small `lib/finance-service-client.ts`. **Would confirm it:** after PR #396 is deployed, single-revision runs
(every result group serving the same revision) in which the finance routes' cold call is consistently no slower
than `/api/ui/preferences` on the same view, where it was consistently slower before. **Would refute it:** the
gap stays the same after deployment. Either way the larger cold variation between runs (841 ms vs 188 ms for the
same one-row route) is not explained by this change.

**Hypothesis B: breaches that overlap a Production promotion measure the new deployment's first requests.**
Evidence: in run 43995593029 the `/supplements` warm breaches (2 of 3 views) and the 4.75 s phone tap fall inside
promotion windows, and those groups served mixed revisions; for the tap no long task or reload was recorded and
the database was fast. This overlap is a confound, not proof: it does not show that the delay is only a cold
start, and it does not rule out the page, the router or `ContinuousScroll`. **Would confirm or refute it:**
per-sample served revision and timing for these pages in runs with no promotion inside the window. Until then
these breaches are **unresolved**; none is handed to PR #376.

**Unresolved:** every breach of run 44003258302 (Today cold 4886 ms with `/api/urgent-email` 2480 ms and
`/api/nyc/leads` 1016 ms, Today warm 1 of 3, Log cold), the mixed-revision `/supplements` and phone-tap breaches
of run 43995593029, and the size of the cold cost that is common to all routes. PR #396 is not expected to change
any of these. PERF-02 stays open until deployed single-revision runs meet the budget.
