# Experiment framework (N-of-1 trials): design

Status: design only (2026-11-11), with Riley's decisions recorded in Section 13. No code and no schema exist yet; the empty "Onyx Experiments" Notion database was created on 2026-11-11 (Section 10.1). Nothing else here has been applied. Every number below comes from read-only queries on the live Supabase project on 2026-11-11 (the SQL is in Appendix A) or from simulations run locally on those aggregate numbers (Appendix B). No per-day personal rows are stored in this repo.

Roadmap row: "Build experiment framework" (Tasks DB, `Source = "Onyx Roadmap"`).

## 1. Result first

- An Onyx experiment is a randomized self-trial: each behavioral day gets arm A or arm B by a random schedule made before the trial starts, and the outcome is the HRV of the sleep that closes that day (the `hrv_alignment.py` same-night rule).
- At today's HRV noise, the recommended design (daily randomization in 4-day blocks) needs about **232 days for an 8 ms effect, 596 days for 5 ms and about 1,650 days for 3 ms** (80% power, two-sided alpha 0.05, 18.9% missing nights). Designs that hold one arm for weeks at a time cost about four times more.
- So the framework should only test treatments with a plausible effect of 8 ms or more, run one trial at a time, and Riley should wear the WHOOP every night: at 5% missing nights the 8 ms trial drops to about 184 days.
- It sits next to the observational AIPW layer in `causal_inference.py`, it does not copy it. AIPW screens about 150 variables on history and suggests candidates; a trial answers one pre-registered question with randomization, so it does not depend on the confounder model being right.

## 2. Why this is not the causal layer again

| | `causal_inference.py` (Phase 2.5) | Experiment framework |
|---|---|---|
| Data | All history, whatever Riley happened to do | Days assigned by a random schedule |
| Question | ~150 treatments at once, which ones look causal | One treatment, one pre-registered hypothesis |
| Why it can be wrong | Unmeasured confounding, wrong propensity/outcome models, implausible estimates when models extrapolate | Carryover, non-adherence, missing nights that depend on the arm |
| Inference | AIPW influence function + block bootstrap, BH-FDR | Randomization test (exact under "no effect on any night") |
| Output | `causal/*` rows in `pds.hrv_analysis_results`, `/analytics/hrv` | One report per trial in Notion + `pds.experiment_reports` (proposed) |

How they connect (Phase 4, Section 12): AIPW rows that pass FDR, agree in sign across naive / PSM / AIPW and have a plausible size become trial candidates; after a trial, the trial estimate is compared with the AIPW estimate for the same variable on non-trial days, which tells us how biased the observational layer is for that kind of treatment. Until the open AIPW plausibility work on `/analytics/hrv` is closed, AIPW magnitudes should not be used to pick a trial on their own.

## 3. Unit: the behavioral day

The randomization unit is the behavioral day D defined by ADR-0001 and `hrv_alignment.py`:

- Day D runs from about 06:00 local time on clock day D to the sleep that closes it (`onyx_behavioral_date = (local instant - 6 h)::date`, TZ from `pds.tz_for_instant` / `pds.user_tz_log`). Post-midnight behaviour before sleep (the awake tail) belongs to day D.
- The outcome for day D is `whoop_hrv_rmssd` on row D of `pds.daily_health_matrix_behavioral`: the HRV Riley wakes up to on clock day D+1. In code that is `hrv_alignment.outcome_series(df, 1)`; never a `.shift(-1)`.
- The arm therefore applies from the start of day D until Riley goes to sleep, not until midnight. A pre-bed dose at 00:30 is still day D.
- Every protocol records `alignment_version = hrv_alignment.ALIGNMENT_VERSION` (today `same_night_v1`). If the rule changes during a trial, the report stops with a `GUARD experiment_alignment:` heartbeat instead of mixing two rules.

## 4. Design

### 4.1 Default: daily randomization in 4-day permuted blocks

- Each block of 4 consecutive behavioral days gets one of the 6 orderings of two A days and two B days (AABB, ABAB, ABBA, BAAB, BABA, BBAA), chosen at random.
- Why 4 days: every block is balanced, the block effect absorbs slow drift (HRV autocorrelation falls to about 0.1 by lag 4 in the current regime, Section 5), and yesterday's arm varies independently enough of today's arm that a carryover term can be estimated. In 2-day pairs the second night always follows the other arm, so a lingering effect cannot be separated and the estimate is biased (Section 7.4).
- Use for treatments that act within a day: evening caffeine cutoff, phone off in the last hour before bed, alcohol yes/no, a pre-bed supplement with a short half-life, evening workout or sauna.

### 4.2 Period design for slow treatments

- For treatments that build up over days or weeks (creatine loading, an adaptogen, a training-block change): periods of P days per arm, two periods per block in random order (AB or BA), the first w days of every period discarded as washout.
- Default P = 14 (two whole weeks, so each period has the same weekday mix), w from Section 5.
- This design is about four times as expensive as 4.1 at equal effect size (Section 7.3). Only use it when the treatment cannot switch daily.

### 4.3 Allocation concealment

The whole schedule is generated before the start (the randomization test needs it), but Riley only sees today's arm.

- Generation: a 32-byte random seed and a pinned generator (numpy `PCG64`, numpy version recorded) produce the block orderings. The protocol file records `sha256(seed)`; the seed and the schedule sit in a service-role-only table (same access level as the Screen Time `phone_usage_*` tables: no `owner_read` policy, so the browser cannot read future days).
- Reveal: only the arm for behavioral today (`pds.behavioral_today_now()`, which is travel- and awake-tail-aware). Each reveal is logged with its timestamp.
- Audit: the seed is published in the final report. Anyone can regenerate the schedule and check that every revealed arm matches (commit, then reveal).
- Why it matters: if Riley can see that Saturday is a no-alcohol day, plans and co-interventions shift around it and the arms stop being comparable.
- Blinding is not possible for behaviours. For a supplement trial an optional placebo pill box prepared by someone else would blind it; the default is open-label, which is acceptable because the outcome is a sensor reading, but expectancy effects on behaviour (going to bed earlier on the "good" arm) are a threat (Section 11).

### 4.4 How Riley learns today's arm

- A session-only endpoint (proposed `GET /api/experiments/today`) returns today's arm and the plain-language instruction ("Arm B: no caffeine after 12:00").
- A card on `/today` only (Riley's decision, Section 13). `/today` is the page Riley opens daily and one surface is less to maintain, so there is no `/agents` morning card from the sms-reminders Worker. The endpoint stays the single source for the card.
- Reveal time: 06:00 local, the start of the behavioral day. If Riley sees it after already doing something that breaks the arm, that day is recorded as non-adherent, never re-assigned.

### 4.5 Adherence capture

- The 21:30 check-in (`/check-in`, `frontend/src/app/check-in/CheckInClient.tsx`, `/api/habits/checkin`) gets one extra question for an active trial: "Followed today's arm?" Yes / Partly / No, plus a note.
- Stored in a dedicated table (proposed `pds.experiment_days`), **not** in `pds.habit_journal`. `habit_*` columns are auto-enumerated as treatments by `causal_inference.py` and ranked by Spearman, so an adherence habit would leak into the observational layer; a backdated answer would also fire the `habit_journal_backfill_trigger` retrain.
- Objective adherence where Onyx can see it (Section 9): `pds.phone_usage_daily.minutes_last_hour_before_sleep_est` for a phone-before-bed trial, `pds.caffeine_timing_daily.last_caffeine_hour` for a caffeine cutoff, `pds.supplement_intake.intake_time` for a supplement, WHOOP / Garmin workouts (`is_sauna`, `had_evening_workout`) for exercise. Caffeine and supplements only qualify if logged in real time (today almost nothing is timed, Section 9).

## 5. Washout from measured carryover

### 5.1 How long HRV itself remembers a night

Autocorrelation of nightly WHOOP RMSSD at lag k (pairs of behavioral days k apart, Appendix A, query Q9):

| Lag (days) | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 14 |
|---|---|---|---|---|---|---|---|---|
| 2025, stable year (≈355 pairs each) | 0.286 | 0.235 | 0.095 | 0.061 | 0.067 | 0.084 | 0.124 | 0.008 |
| Last 90 days, current regime (49 to 63 pairs) | 0.476 | 0.344 | 0.206 | 0.114 | 0.089 | 0.129 | 0.039 | 0.277 |

- The correlation falls below about 0.1 by lag 3 (2025) or lag 4 (current regime). The lag-14 value of 0.28 in the last 90 days is the downward drift inside that window (Section 11), not a two-week cycle.
- Lag 7 is small (0.04 now, 0.12 in 2025), so there is no strong weekly cycle. The day-of-week means (deviation from a centred 15-day mean, last 365 days) range from -4.3 ms (Friday) to +6.3 ms (Sunday), within noise for about 50 nights each but cheap to adjust for, so day of week is a covariate rather than a design constraint.
- If a treatment's effect travels through HRV's own persistence (an AR(1) state), a shock of b ms on night D would leave roughly rho^k x b on night D+k: with rho = 0.476 that is 48% the next night, 23% two nights later, 11% three nights later. This is an assumption, not a measurement; HRV persistence may come from slow states (fitness, stress, illness) that a single evening does not move.

### 5.2 Measuring a treatment's own carryover

- In the 4-day block design the model includes yesterday's arm: `Y_D = block_D + b0*T_D + b1*T_(D-1) + dow_D + e_D`. Because the arms are randomized, `b1` is identified: it is the treatment's effect on the following night. Simulation (Section 7.4): with a +4 ms carryover this model returns 8.1 for a true 8 ms same-night effect, while 2-day pairs return 6.0.
- From history (hypothesis only): the lag-1 version of a treatment column (`*_lag1`) in the observational layer gives a rough, confounded prior for b1.
- For slow treatments, use pharmacology first (half-life, loading time) and the period design's discarded days.

### 5.3 Washout rule

- Daily designs: no washout days; carryover is modelled (b1) and reported. If the pre-registered analysis finds |b1| larger than half the MID, the next trial of that treatment must use the period design.
- Period designs: w = max(pharmacological washout, smallest lag where the outcome autocorrelation is below 0.1 in the current regime) = at least 3 to 4 days with today's numbers. Recompute at registration with query Q9.

## 6. Pre-registered hypotheses

### 6.1 Template

Each trial gets `docs/experiments/EXP-NNN.md` with this front matter (illustrative values):

```yaml
id: EXP-001
title: Phone off in the last hour before bed
status: registered            # draft -> registered -> running -> paused | stopped_early | complete
registered: 2026-12-01
start: 2026-12-03             # first behavioral day
planned_end: 2027-07-22       # start + n_days - 1
question: Does no phone use in the 60 min before sleep raise same-night HRV?
arms:
  A: no phone in the 60 min before sleep onset
  B: usual behaviour (control)
adherence:
  self_report: check-in "Followed today's arm?"
  objective: pds.phone_usage_daily.minutes_last_hour_before_sleep_est <= 5 on A days
outcome:
  primary: whoop_hrv_rmssd of the sleep that closes the behavioral day (hrv_alignment.outcome_series h=1)
  alignment_version: same_night_v1
  secondary: [eight_sleep_hrv of the same sleep, whoop_rhr, b0 + b1 (two-night total)]
direction: A > B (tested two-sided)
mid_ms: 8                     # minimal important difference
design:
  type: daily_4day_permuted_blocks
  n_blocks: 58
  n_days: 232
  washout_days: 0
power_inputs:                 # from Appendix A queries on the registration date
  sigma_ms: 21.4
  rho_lag1: 0.476
  missing_rate: 0.189
allocation:
  generator: numpy PCG64 (numpy 2.x pinned)
  seed_sha256: <hex>
analysis:
  model: Y ~ block FE + arm + arm_yesterday + day_of_week, OLS on observed nights
  test: randomization test, 10000 re-draws of the block orderings, two-sided, alpha 0.05
  ci: inversion of the randomization test (HAC Newey-West maxlags=7 as a quick check)
  sensitivity: [ln HRV, per-protocol, plus hrv_lag1 covariate, excluding travel blocks]
exclusions:                   # decided without looking at HRV, applied to whole blocks
  - block contains a flight day (pds.flight_day_unified.flew = 1) or onyx_is_transition_day
  - illness or travel pause declared before the block starts
stopping:
  interim: at 50% of blocks, O'Brien-Fleming |z| >= 2.797 (final 1.977)
  safety: Riley may stop any time; recorded as stopped_early
  futility: none by default
decision:
  adopt_A: p < 0.05 and estimate favours A
  no_meaningful_effect: 95% CI inside (-mid, +mid)
  otherwise: inconclusive
co_interventions_held_steady: [bedtime target, supplement stack, training plan]
```

### 6.2 Where it is stored and how it is locked

1. **Repo**: the file is merged to `master` through a PR before `start`. The merge commit is the registration record; git history is the tamper evidence.
2. **Supabase** (proposed `pds.experiments`): one row with `protocol_sha256` (SHA-256 of the merged file), `git_commit`, `alignment_version`, `seed_sha256`, `locked_at`. A guard trigger in the style of `zzz_block_frozen_whoop_era` refuses any change to protocol columns once `locked_at` is set; only the status may move forward (registered -> running -> paused / stopped_early / complete).
3. **Notion**: the experiment page carries the same hash (Section 10).
4. **Amendments**: a new file `EXP-NNN-amend-1.md`, merged before any interim result is seen, listed in the final report. The original never changes.

## 7. Power with live numbers

### 7.1 Inputs (live, read-only, 2026-11-11)

From `pds.daily_health_matrix_behavioral.whoop_hrv_rmssd` (row D = sleep closing day D). Missing = spine days in the window with no WHOOP HRV.

| Window | HRV nights | Mean (ms) | SD (ms) | Lag-1 r | Lag-7 r | Missing |
|---|---|---|---|---|---|---|
| Last 90 days (2026-08-13 to 11-10), **current regime** | 73 | 70.8 | 21.4 | 0.476 | 0.039 | 18.9% |
| Since 2026-09-01 | 58 | 66.4 | 20.2 | 0.377 | n/a | 18.3% |
| Last 180 days | 161 | 88.5 | 32.0 | 0.623 | 0.326 | 10.6% |
| Last 365 days | 340 | 114.4 | 41.1 | 0.585 | 0.494 | 6.8% |
| 2025 (stable year) | 363 | 123.7 | 32.8 | 0.286 | 0.124 | 0.5% |
| All (2024-10-27 to 2026-11-10) | 719 | n/a | 36.9 | 0.458 | 0.327 | 3.5% |

Supporting numbers (Appendix A):

- SD of the difference between adjacent nights: 20.9 ms (last 90 days), 21.5 (since Sep 1), 27.8 (last 180), 37.2 (last 365). This is the noise a paired comparison actually faces; it matches the AR(1) prediction `sigma*sqrt(2(1-rho))` = 21.9 ms for the last 90 days.
- After removing a centred 15-day mean: SD 18.0 ms and lag-1 r 0.20 (last 90 days); 22.4 / 0.22 (last 180). That is roughly what a short block absorbs.
- Log scale, last 90 days: SD of ln(HRV) 0.329, lag-1 r 0.381.
- Missing nights in the last 365 days: 25 in 16 gaps, 11 of them single nights, longest 4 nights. Missingness by month: Aug 16.1%, Sep 23.3%, Oct 19.4%, Nov (10 days) 0%.

The power table uses the current regime because that is what a trial starting now will face. Sets B (last 180 days) and C (2025) show how much the answer moves.

### 7.2 Formulas

```
z = z(0.975) + z(0.80) = 2.8016        z^2 = 7.849

i.i.d. days per arm            n_iid   = 2 * z^2 * sigma^2 / delta^2

AR(1) effective n              n_eff   = n * (1 - rho1) / (1 + rho1)
  -> observed days per arm     n_arm   = n_iid * (1 + rho1) / (1 - rho1)
  -> calendar days (periods)   days    = 2 * n_arm / (1 - m) * P / (P - w)

2-day pairs (daily random)     n_pairs = z^2 * 2 * sigma^2 * (1 - rho1) / delta^2
  -> calendar days             days    = 2 * n_pairs / (1 - m)^2     (a pair counts only if both nights have HRV)

sigma = daily SD, rho1 = lag-1 autocorrelation, m = missing-night rate,
delta = effect in ms, P = period length, w = washout days per period
```

The effective-n formula describes contiguous same-arm days: with rho1 = 0.476 each observed night is worth 0.355 independent nights (0.555 in 2025). Daily randomization turns the same autocorrelation into an advantage, because adjacent nights in different arms share the slow part of the noise.

### 7.3 Days needed at 80% power (alpha 0.05, two-sided)

Set A, current regime (sigma 21.4 ms, rho1 0.476, m 18.9%; AR(1) inflation (1+rho)/(1-rho) = 2.82):

| Effect | i.i.d. days per arm (no autocorrelation, no missing) | 14-day periods, 2-day washout (AR(1) effective n) | 2-day pairs (formula, assumes no carryover) | **4-day permuted blocks + carryover term (simulated, recommended)** |
|---|---|---|---|---|
| 3 ms (~4% of current mean) | 799 | 6,474 | 1,273 | **~1,650** |
| 5 ms (~7%) | 288 | 2,331 | 459 | **~596** |
| 8 ms (~11%) | 112 | 911 | 179 | **~232** |

Total calendar days, both arms, including missing nights and washout. Percentages are of the last-90-day mean (70.8 ms). The 4-day column is the n at which simulated power reached 0.80 (found at 8 ms, scaled by 1/delta^2 for 5 and 3 ms, then re-checked: Section 7.4); it costs about 30% more than pairs because it estimates carryover instead of assuming it away.

Sets B and C, formula columns only:

| Effect | B (last 180 d: sigma 32.0, rho1 0.623, m 10.6%) periods / pairs | C (2025: sigma 32.8, rho1 0.286, m 0.5%) periods / pairs |
|---|---|---|
| 3 ms | 20,068 / 1,685 | 7,926 / 2,707 |
| 5 ms | 7,225 / 607 | 2,853 / 974 |
| 8 ms | 2,822 / 237 | 1,115 / 381 |

Plain reading: a 3 ms effect cannot be shown in a single N-of-1 trial in any reasonable time. 8 ms is about eight months with the recommended design. In ms terms the 2025 regime was harder (higher SD at a higher HRV level); if effects scale with the HRV level, the log-scale sensitivity analysis is the fairer comparison across regimes.

For context on plausible sizes: the largest same-night difference visible in the data is alcohol, -35 ms (mean 93.7 vs 128.9 ms), from only 6 WHOOP-era "Yes" nights against 300 "No" nights, unadjusted.

### 7.4 Simulation check (Appendix B)

AR(1) noise with the set-A numbers, missing nights at random, analysed exactly as planned:

| Check | Result |
|---|---|
| 2-day pairs at the formula's n (3 / 5 / 8 ms) | power 0.783 / 0.793 / 0.785, estimates 2.97 / 5.01 / 8.02 |
| 14-day periods at the formula's n (5 / 8 ms) | power 0.876 / 0.857: the effective-n formula is conservative by 10 to 15% here |
| 4-day blocks + carryover term at 232 / 596 / 1,652 days (8 / 5 / 3 ms) | power 0.800 / 0.801 / 0.815, estimates 7.99 / 4.96 / 3.01 |
| Effect lingers +4 ms into the next night (8 ms design) | pairs: estimate 6.0, power 0.54 (biased); 4-day blocks + carryover term: estimate 8.1, power 0.80 |
| Effect reverses -4 ms the next night | pairs: estimate 10.0 (biased the other way) |
| No effect (type I error), 2-day pairs | t-test 0.049, sign-flip randomization test 0.053 |
| No effect, 4-day blocks | plain OLS t-test 0.061 (slightly liberal: residuals stay autocorrelated inside a block); randomization test 0.043 with power 0.78 at 232 days |
| Random-walk drift 1.5 ms/day added (pairs, 8 ms) | power 0.781, estimate 8.01: blocks absorb drift |
| Missing nights 5% / 0% (4-day blocks, 8 ms) | about 184 / 172 days instead of 232 |

Monte-Carlo error: about ±0.006 to ±0.014 on power for 4,000 to 800 replications; on the 300-replication randomization-test runs about ±0.013 on the type I error and ±0.024 on power.

### 7.5 What shortens a trial

1. **Wear the WHOOP every night.** 18.9% missing nights cost about 50 extra days on an 8 ms trial. This is the cheapest lever.
2. Larger effects: pick treatments with a plausible 8 ms or more.
3. Covariates measured before the treatment (last night's HRV, 7-day mean) may shrink the residual. Not quantified yet; Phase 1 measures it on real data.
4. One trial at a time. Two concurrent trials need a factorial design registered up front.

## 8. Analysis plan

- **Estimand**: intention-to-treat difference between arms in the HRV of the sleep that closes the day (b0). Secondary: b1 (next night) and b0 + b1.
- **Model**: `Y_D = block_D + b0*T_D + b1*T_(D-1) + day_of_week_D + e_D`, OLS with block fixed effects on nights that have HRV. No imputation of missing nights.
- **p-value**: randomization test. Re-draw the block orderings 10,000 times with the registered procedure, refit, count re-draws with |b0| at least as large. Valid whatever the autocorrelation, because it only uses the random assignment that actually happened. The re-draw seed is derived from the experiment id and the as-of date, so a re-run returns the same p.
- **Interval**: invert the randomization test (shift Y on A nights by c, keep the c values not rejected). Newey-West HAC (maxlags 7) as a quick cross-check. A mixed model with random block intercepts (statsmodels `MixedLM`) is an acceptable sensitivity estimate, but it does not model the within-block AR(1) residual.
- **Period designs**: per-period mean of the non-washout nights, paired difference per block, randomization test over the AB / BA orders.
- **Sensitivity** (pre-registered): ln(HRV); per-protocol (adherent days only, labelled as no longer randomized); plus `hrv_lag1` and `hrv_7d_mean` as covariates; Eight Sleep HRV of the same sleep (matrix row D+1's `eight_sleep_hrv`, re-keyed by `al.realign_matrix`) as a second sensor, never averaged with or substituted for WHOOP.
- **Missingness check**: compare the share of missing nights between arms (Fisher exact). A difference above 10 points is reported as a threat to the result.
- **Interim**: only at the registered look, only the stop / continue decision is shown unless the boundary is crossed. Daily progress reports never show the effect estimate.

Relation to the observational pipeline: trial days stay in the matrix and keep feeding `hrv_analysis.py` and `causal_inference.py` as ordinary history (randomized variation helps them). The arm indicator is not added to the matrix as a feature, so it never becomes another auto-enumerated treatment. Phase 4 adds one comparison row per finished trial (trial estimate vs the AIPW estimate for the same variable on non-trial days).

## 9. Treatment and adherence data Onyx already has

Coverage over the last 90 behavioral days (2026-08-13 to 2026-11-10) unless noted (Appendix A, Q10 to Q14):

| Stream | Tables / views | Coverage | As a treatment | As an adherence check |
|---|---|---|---|---|
| Outcome: WHOOP HRV | `pds.daily_health_matrix_behavioral.whoop_hrv_rmssd` | 73 / 90 nights | primary outcome | n/a |
| Second sensor: Eight Sleep HRV | `eight_sleep_hrv` (matrix, re-keyed one day earlier) | covered all 17 nights WHOOP missed; r = 0.81 with WHOOP on the same sleep | secondary outcome only | n/a |
| Habits / check-in | `pds.habit_journal` via `pds.journal` | 3 days (check-in launched 2026-11-07; nothing logged 2026-07-20 to 11-06) | yes (explicit Yes / No) | self-report only; do not store trial adherence here (Section 4.5) |
| Supplements | `pds.supplement_intake`, `supplement_intake_by_compound`, `daily_supplement_matrix` | 90 / 90 days, 1,745 intakes, 15 products; 84.8% from stacks, 0.3% with a clock time | yes | only once doses are tapped in real time |
| Caffeine | `pds.caffeine_events`, `pds.caffeine_timing_daily` | 88 / 90 days with mg > 0 (mean 51 mg/day, all from supplements, no dietary); 1 / 90 days with a timing value | dose yes; a cutoff only once timed | same |
| Nutrition and meal timing | `pds.cronometer_nutrition_behavioral_daily`, `pds.meal_timing_from_cronometer` | 0 / 90 (last Cronometer day 2026-06-29) | not until logging resumes | no |
| Screen time | `pds.phone_usage_daily` (Screen Time app, since 2026-10-11) | 31 / 90 days (32 total), 27 with pre-bed minutes | yes | yes, objective |
| Workouts, sauna | `pds.whoop_workouts`, `pds.garmin_activities` (`is_sauna`), matrix `had_evening_workout` | not counted for this doc | yes | yes, objective |
| Travel | `pds.flight_day_unified.flew`, matrix `onyx_is_transition_day` | last 365 days: 35 flight days, 14 transition days | exclusion rule | n/a |

Best first candidates with objective adherence today: phone use in the last hour before bed (Screen Time), evening workout or sauna (device-logged). Caffeine and supplement trials need real-time logging first.

## 10. Auto-report to Notion, heartbeat and /status

### 10.1 Target

A new Notion database **"Onyx Experiments"** under the Project Onyx page (the parent of the Habits DB `29cc936fd5e14ae8b10a4fe5c5f7a6cd`), one page per experiment. Created empty on 2026-11-11 with Riley's approval (database `2d460253-f94b-437d-ab74-0920c213d3b7`, data source `d99f3df8-6759-4de0-b9be-3761759ecd26`, parent Project Onyx `32bbf5b4-4bf2-805f-8d33-e6c72915a970`) with exactly the properties above, Status as a Notion status property and Decision as a select. It inherits the parent page's sharing, so the Onyx integration can write to it as long as Project Onyx stays shared with it; confirm that with the first report write in Phase 2.

Properties: Experiment (title, "EXP-001 Phone off before bed"), Status (Draft / Registered / Running / Paused / Stopped early / Complete), Hypothesis, Arms, Primary outcome, MID (ms), Design, Start, Planned end, Days elapsed, Nights with outcome, Adherence %, Missing %, Estimate (ms), CI low, CI high, p (randomization), Carryover b1, Decision (Adopt A / No meaningful effect / Inconclusive), Protocol SHA-256, Alignment version, Last report (date).

### 10.2 When it is written

| Moment | What is written | Effect estimate shown? |
|---|---|---|
| Registration | page created, protocol link + hash, Status Registered | no |
| Daily, ~15:00 UTC (after last night's WHOOP recovery has arrived through the hourly ETL) | progress properties: days, nights with outcome, adherence, missing | no |
| Registered interim look | continue / stop decision | only if the stopping boundary is crossed |
| Completion or early stop | full report: estimate, CI, p, b1, sensitivity table, missingness check, seed reveal, decision | yes |

### 10.3 Idempotency

- Supabase first: proposed `pds.experiment_reports`, primary key `(experiment_id, report_kind, as_of_date)`, upserted. It is the source of truth; Notion is a mirror.
- The Notion page id is stored on `pds.experiments` after the first create; if it is missing, the writer looks the page up by the Experiment property before creating one.
- Properties are overwritten, never appended. The report body lives under one "Report (auto)" heading whose children are replaced on each final-report write. Daily runs touch properties only, so a re-run adds nothing.
- The randomization-test seed is derived from `(experiment_id, as_of_date)`, so re-running the same day gives byte-identical numbers.
- Notion writes are best-effort (the `lib/reading-notion.ts` pattern): a Notion failure never loses the Supabase row and turns the heartbeat `partial`.

### 10.4 Heartbeat

`pds.sync_log` row `source='experiments', data_type='report'` on every run through `sync_log_helper.log_sync`, success and failure, including uncaught exceptions; `records_synced = 0` on days with no active trial.

- `partial`: Notion write failed, 3 or more nights in a row without outcome, or adherence below the registered threshold.
- `failed`: any exception.
- `GUARD experiment_alignment:` when `hrv_alignment.ALIGNMENT_VERSION` differs from the registered version; `GUARD experiment_schedule:` when the regenerated schedule does not match the stored one or a revealed arm. The devops agent already reports `GUARD` heartbeats to Riley instead of re-running.

### 10.5 /status card

Per the AGENTS.md three-place rule, in the same commit as the report job:

1. `frontend/src/app/api/status/route.ts`: read the latest `experiments|report` heartbeat, add an `experiments` entry with `CADENCE` "Daily ~15:00 UTC" and `METHOD` `{ method: "automated", label: "Trial report" }`. Status from heartbeat age like the `hrv_retrain` card (more than 30 h = failed, more than 26 h or a `partial` heartbeat = partial), because this is a job, not a data table.
2. `frontend/src/app/status/page.tsx`: `SOURCE_ORDER`, `SOURCE_BADGE`, `SOURCE_BADGE_COLOR`, `HISTORY_SOURCE_LABELS` (`experiments`) and `HISTORY_TYPE_LABELS` (`report`).
3. The heartbeat in Section 10.4.

## 11. Threats to validity

- **The HRV level shift.** WHOOP HRV by quarter: 2025 Q1 129.6, Q2 126.7, Q3 115.3, Q4 123.6; 2026 Q1 140.1, Q2 124.0, Q3 86.2, Q4 (to Nov 10) 68.1 ms. The independent Eight Sleep sensor moved the same way (2026 Q1 144.2 to Q4 70.9) and WHOOP resting HR rose from 46.9 to 57.3 bpm, so the decline looks physiological rather than a WHOOP-only artefact, as far as these aggregates show. Effects: use current-regime numbers for power; blocks absorb slow drift; a further shift mid-trial keeps the randomization test valid but costs power; if effects scale with the level, the log-scale analysis is the fairer one.
- **Seasonality.** 2025 quarterly means varied by about 14 ms. Short blocks absorb it; 14-day periods are paired inside 28-day blocks for the same reason.
- **Travel and time zones.** The behavioral day follows the local TZ (`pds.tz_for_instant`, `pds.user_tz_log`), so the arm and the outcome stay on the same night when travelling. Flight and transition days (35 and 14 in the last year) disturb sleep; blocks containing them are excluded as a whole, decided before looking at HRV. Riley can also declare a travel pause in advance.
- **Device changes.** Onyx stores no WHOOP hardware or firmware version (the only device-state field found is `whoop_recovery.user_calibrating`). The protocol records the device in use; a strap or firmware change during a trial is logged in the report and the trial is split at that date in a sensitivity analysis.
- **Garmin wear gaps.** Garmin HRV nights in the matrix: 64 in 2025 Q1, 8 in 2026 Q2, 1 in Q3, 0 in Q4. Garmin cannot be a backup outcome, and its HRV is a different measurement anyway. Eight Sleep is the only practical second sensor.
- **Missing nights that depend on the arm** (for example not wearing the strap after drinking). Checked by the missingness comparison in Section 8.
- **Carryover.** Modelled in daily designs (b1); washout in period designs (Section 5).
- **Expectancy and co-interventions.** Open-label arms can change other behaviour (earlier bedtime on the "good" arm). Co-interventions to hold steady are listed in the protocol, and bedtime is a reported secondary variable. Note that changes in sleep caused by the treatment are part of the effect (total effect, as in the causal layer), not bias.
- **Adherence evidence.** Supplement logs in the last 90 days are 84.8% stack-generated and 0.3% timed, so they show what was planned, not when it was taken. Supplement and caffeine trials need real-time taps.
- **Analysis drift.** A change to `hrv_alignment.py` or the matrix during a trial is caught by the alignment-version guard.

## 12. Phased rollout

| Phase | What | Writes production? | Done when |
|---|---|---|---|
| 0 | This design doc | no | merged |
| 1 | Offline dry runs on real history, read-only: placebo allocations (fake 4-day blocks) on 2025 and the current regime to measure the real type I error and power of the planned analysis on real HRV instead of AR(1); measure the gain from covariates; pick the first treatment with Riley | no | numbers in Section 7 confirmed or corrected on real data |
| 2 | Plumbing: `pds.experiments`, `pds.experiment_schedule` (service-role only), `pds.experiment_days`, `pds.experiment_reports`, protocol lock trigger, `GET /api/experiments/today`, check-in adherence question, report job in dry-run mode, heartbeat, /status card, Notion database. Then a 4-week A/A sham trial (both arms identical) | yes, new tables only | every day revealed, adherence captured on 90% or more of days, report re-runs are idempotent, A/A result not significant |
| 3 | First real trial, pre-registered and locked | yes | final report written; Status stays open on the roadmap until it is verified in production |
| 4 | Calibration with `causal_inference.py`: trial vs AIPW estimate per finished trial, AIPW-based candidate list | yes (`hrv_analysis_results` rows) | first comparison published |

## 13. Decisions (Riley, 2026-11-11)

1. **Effect size and length.** Only trial treatments with a plausible effect of 8 ms or more, and accept that one trial takes about 8 months (232 days at today's noise and missing-night rate, Section 7). Analyze only at the pre-registered end; interim looks follow the stopping boundary in the protocol, never an ad hoc peek.
2. **Wear the WHOOP every night during a trial.** Missed nights add about 50 days (about 184 days at 5% missing instead of 232 at 18.9%, Section 1).
3. **First treatment: phone off in the last hour before bed.** Adherence is verified from Screen Time (`pds.phone_usage_daily.minutes_last_hour_before_sleep_est`, Section 9). Planning input from the observational layer, retrain run 43142943594 (2026-11-12 02:51 UTC), AIPW treatment `journal_viewed_a_screen_device_in_bed` (screen in bed, yes vs no): **AIPW +13.2 ms** (influence-function 95% CI -14.7 to +41.1, block-bootstrap CI -27.0 to +56.5, raw p 0.50, not FDR-significant, 185 treated vs 69 control days), against naive +3.0 ms and PSM +5.9 ms. Positive means higher HRV on nights with a screen in bed, so the sign is the opposite of the trial hypothesis and the interval is wider than the effect. It is a reason to test the treatment, not an estimate of it. The same run flagged 23 of 121 causal rows implausible; this one was not flagged.
4. **Notion database: created now.** "Onyx Experiments" exists under Project Onyx with the fields in Section 10.1 and no rows (URL and ids in Section 10.1). Rows appear when the first protocol is registered.
5. **Daily arm card: `/today` only.** No `/agents` morning card (Section 4.4).

Still open: the Phase 2 schema, the check-in adherence question and the protocol file for EXP-001 (Section 12). None of these decisions changes the design in Sections 4 to 11.

## 14. What this doc does not prove

- The power numbers assume AR(1) noise with the measured SD and lag-1 correlation and missing nights at random. Real HRV has a slow drift component (lag-14 r 0.28 in the last 90 days) and clustered gaps; Phase 1 checks the plan on real history.
- The 3 / 5 / 8 ms effect sizes are planning values, not estimates of any real treatment. The alcohol difference quoted is unadjusted and rests on 6 nights.
- The "physiological, not device" reading of the 2026 HRV decline rests on two other aggregates (Eight Sleep HRV, WHOOP RHR), not on device logs.
- Nothing about Notion, the Worker card, the check-in question or the proposed tables has been built or tested.

## Appendix A: SQL for the live numbers

All read-only `SELECT`s against project Onyx, run 2026-11-11 through the Supabase MCP. Only aggregate results are reported above.

Q1, HRV by year and missingness inside the observed span:

```sql
WITH m AS (
  SELECT calendar_date::date AS d, whoop_hrv_rmssd::float8 AS hrv
  FROM pds.daily_health_matrix_behavioral
), span AS (
  SELECT min(d) FILTER (WHERE hrv IS NOT NULL) AS first_d,
         max(d) FILTER (WHERE hrv IS NOT NULL) AS last_d FROM m
), spine AS (
  SELECT g::date AS d FROM span, generate_series(span.first_d, span.last_d, interval '1 day') g
), j AS (
  SELECT s.d, m.hrv FROM spine s LEFT JOIN m ON m.d = s.d
)
SELECT extract(year FROM d)::int AS yr, count(*) AS spine_days, count(hrv) AS hrv_days,
       round((1 - count(hrv)::numeric / count(*)) * 100, 1) AS pct_missing,
       round(avg(hrv)::numeric, 1) AS mean_hrv, round(stddev_samp(hrv)::numeric, 1) AS sd_hrv,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY hrv)::numeric, 1) AS median_hrv,
       min(d) AS first_day, max(d) AS last_day
FROM j GROUP BY 1 ORDER BY 1;
```

Q2, HRV by quarter:

```sql
SELECT to_char(date_trunc('quarter', calendar_date::date), 'YYYY-"Q"Q') AS qtr,
       count(whoop_hrv_rmssd) AS hrv_days,
       round(avg(whoop_hrv_rmssd)::numeric, 1) AS mean_hrv,
       round(stddev_samp(whoop_hrv_rmssd)::numeric, 1) AS sd_hrv
FROM pds.daily_health_matrix_behavioral
WHERE whoop_hrv_rmssd IS NOT NULL
GROUP BY 1 ORDER BY 1;
```

Q3, SD and lag-1 / lag-7 autocorrelation, raw and after removing centred 15- and 29-day means:

```sql
WITH m AS (
  SELECT calendar_date::date AS d, whoop_hrv_rmssd::float8 AS hrv
  FROM pds.daily_health_matrix_behavioral WHERE whoop_hrv_rmssd IS NOT NULL
), w AS (
  SELECT d, hrv,
         hrv - avg(hrv) OVER (ORDER BY d RANGE BETWEEN interval '7 days' PRECEDING AND interval '7 days' FOLLOWING) AS dev15,
         hrv - avg(hrv) OVER (ORDER BY d RANGE BETWEEN interval '14 days' PRECEDING AND interval '14 days' FOLLOWING) AS dev29
  FROM m
), per AS (
  SELECT 'all (2024-10-27..)' AS period, * FROM w
  UNION ALL SELECT 'last 365 d', * FROM w WHERE d > date '2026-11-10' - 365
  UNION ALL SELECT 'last 180 d', * FROM w WHERE d > date '2026-11-10' - 180
  UNION ALL SELECT 'last 90 d', * FROM w WHERE d > date '2026-11-10' - 90
)
SELECT p.period, count(*) AS n_hrv_days,
       round(stddev_samp(p.hrv)::numeric, 1) AS sd_raw,
       round(stddev_samp(p.dev15)::numeric, 1) AS sd_dev15,
       round(stddev_samp(p.dev29)::numeric, 1) AS sd_dev29,
       round(corr(p.hrv, q1.hrv)::numeric, 3) AS r1_raw,
       round(corr(p.hrv, q7.hrv)::numeric, 3) AS r7_raw,
       round(corr(p.dev15, q1.dev15)::numeric, 3) AS r1_dev15,
       round(corr(p.dev15, q7.dev15)::numeric, 3) AS r7_dev15,
       round(corr(p.dev29, q1.dev29)::numeric, 3) AS r1_dev29,
       round(corr(p.dev29, q7.dev29)::numeric, 3) AS r7_dev29,
       count(q1.hrv) AS n_pairs_lag1, count(q7.hrv) AS n_pairs_lag7
FROM per p
LEFT JOIN w q1 ON q1.d = p.d + 1
LEFT JOIN w q7 ON q7.d = p.d + 7
GROUP BY p.period ORDER BY p.period;
```

Q4, day-of-week deviation from the centred 15-day mean:

```sql
WITH m AS (
  SELECT calendar_date::date AS d, whoop_hrv_rmssd::float8 AS hrv
  FROM pds.daily_health_matrix_behavioral WHERE whoop_hrv_rmssd IS NOT NULL
), w AS (
  SELECT d, hrv - avg(hrv) OVER (ORDER BY d RANGE BETWEEN interval '7 days' PRECEDING AND interval '7 days' FOLLOWING) AS dev15
  FROM m
)
SELECT extract(isodow FROM d)::int AS isodow, count(*) AS n,
       round(avg(dev15) FILTER (WHERE d > date '2026-11-10' - 365)::numeric, 1) AS mean_dev_last365,
       round(avg(dev15)::numeric, 1) AS mean_dev_all
FROM w GROUP BY 1 ORDER BY 1;
```

Q5, missing-night gaps in the last 365 days:

```sql
WITH spine AS (
  SELECT g::date AS d FROM generate_series(date '2025-11-11', date '2026-11-10', interval '1 day') g
), j AS (
  SELECT s.d, m.whoop_hrv_rmssd AS hrv
  FROM spine s LEFT JOIN pds.daily_health_matrix_behavioral m ON m.calendar_date::date = s.d
), runs AS (
  SELECT d, hrv IS NULL AS miss,
         d - (row_number() OVER (PARTITION BY hrv IS NULL ORDER BY d))::int AS grp
  FROM j
), gaps AS (
  SELECT min(d) AS gap_start, max(d) AS gap_end, count(*) AS len
  FROM runs WHERE miss GROUP BY grp
)
SELECT (SELECT count(*) FROM j) AS spine_days,
       (SELECT count(*) FROM j WHERE hrv IS NULL) AS whoop_hrv_missing,
       (SELECT count(*) FROM gaps) AS n_gaps,
       (SELECT count(*) FROM gaps WHERE len = 1) AS n_single_day_gaps,
       (SELECT max(len) FROM gaps) AS longest_gap_days,
       (SELECT count(*) FROM gaps WHERE len >= 3) AS n_gaps_3plus,
       (SELECT sum(len) FROM gaps WHERE len >= 3) AS days_in_gaps_3plus;
```

Q6, missingness and HRV by month since May 2026:

```sql
WITH spine AS (
  SELECT g::date AS d FROM generate_series(date '2026-05-01', date '2026-11-10', interval '1 day') g
)
SELECT to_char(date_trunc('month', s.d), 'YYYY-MM') AS month, count(*) AS spine_days,
       count(m.whoop_hrv_rmssd) AS hrv_days,
       round((1 - count(m.whoop_hrv_rmssd)::numeric / count(*)) * 100, 1) AS pct_missing,
       round(avg(m.whoop_hrv_rmssd)::numeric, 1) AS mean_hrv,
       round(stddev_samp(m.whoop_hrv_rmssd)::numeric, 1) AS sd_hrv
FROM spine s LEFT JOIN pds.daily_health_matrix_behavioral m ON m.calendar_date::date = s.d
GROUP BY 1 ORDER BY 1;
```

Q7, the level shift across sensors (quarterly means are not affected by the one-day re-keying of Eight Sleep / Garmin columns):

```sql
SELECT to_char(date_trunc('quarter', calendar_date::date), 'YYYY-"Q"Q') AS qtr,
       count(whoop_hrv_rmssd) AS n_whoop_hrv,
       round(avg(whoop_hrv_rmssd)::numeric, 1) AS whoop_hrv_mean,
       round(avg(whoop_rhr)::numeric, 1) AS whoop_rhr_mean,
       count(garmin_hrv_last_night) AS n_garmin_hrv,
       round(avg(garmin_hrv_last_night)::numeric, 1) AS garmin_hrv_mean,
       count(eight_sleep_hrv) AS n_8s_hrv,
       round(avg(eight_sleep_hrv)::numeric, 1) AS eight_sleep_hrv_mean
FROM pds.daily_health_matrix_behavioral
WHERE calendar_date::date >= date '2024-10-01'
GROUP BY 1 ORDER BY 1;
```

Q8, adjacent-night differences and log scale:

```sql
WITH m AS (
  SELECT calendar_date::date AS d, whoop_hrv_rmssd::float8 AS hrv
  FROM pds.daily_health_matrix_behavioral WHERE whoop_hrv_rmssd IS NOT NULL
), per AS (
  SELECT 'since 2026-09-01' AS period, * FROM m WHERE d >= date '2026-09-01'
  UNION ALL SELECT 'last 90 d', * FROM m WHERE d > date '2026-11-10' - 90
  UNION ALL SELECT 'last 180 d', * FROM m WHERE d > date '2026-11-10' - 180
  UNION ALL SELECT 'last 365 d', * FROM m WHERE d > date '2026-11-10' - 365
)
SELECT p.period, count(*) AS n_days,
       round(avg(p.hrv)::numeric, 1) AS mean_hrv,
       round(stddev_samp(p.hrv)::numeric, 1) AS sd_raw,
       round(stddev_samp(ln(p.hrv))::numeric, 3) AS sd_ln,
       round(corr(p.hrv, q.hrv)::numeric, 3) AS r1_raw,
       round(corr(ln(p.hrv), ln(q.hrv))::numeric, 3) AS r1_ln,
       count(q.hrv) AS n_adjacent_pairs,
       round(stddev_samp(q.hrv - p.hrv)::numeric, 1) AS sd_adjacent_diff,
       round(stddev_samp(ln(q.hrv) - ln(p.hrv))::numeric, 3) AS sd_adjacent_diff_ln
FROM per p LEFT JOIN m q ON q.d = p.d + 1 AND q.d <= date '2026-11-10'
GROUP BY p.period ORDER BY p.period;
```

Q9, autocorrelation at lags 1 to 7 and 14 inside each window:

```sql
WITH m AS (
  SELECT calendar_date::date AS d, whoop_hrv_rmssd::float8 AS hrv
  FROM pds.daily_health_matrix_behavioral WHERE whoop_hrv_rmssd IS NOT NULL
), per AS (
  SELECT '2025 (stable regime)' AS period, d, hrv FROM m WHERE d BETWEEN date '2025-01-01' AND date '2025-12-31'
  UNION ALL SELECT 'last 90 d (current regime)', d, hrv FROM m WHERE d > date '2026-11-10' - 90
), lags AS (SELECT unnest(ARRAY[1,2,3,4,5,6,7,14]) AS k)
SELECT p.period, l.k AS lag_days, count(q.hrv) AS n_pairs,
       round(corr(p.hrv, q.hrv)::numeric, 3) AS acf_raw
FROM per p CROSS JOIN lags l
JOIN per q ON q.period = p.period AND q.d = p.d + l.k
GROUP BY p.period, l.k ORDER BY p.period, l.k;
```

Q10, treatment-stream coverage in the last 90 days:

```sql
WITH w AS (SELECT date '2026-11-10' - 89 AS lo, date '2026-11-10' AS hi)
SELECT 'habit_journal (source=habit)' AS stream, count(DISTINCT behaviors_date) AS days, min(behaviors_date), max(behaviors_date)
FROM pds.habit_journal, w WHERE source = 'habit' AND behaviors_date BETWEEN w.lo AND w.hi
UNION ALL
SELECT 'habit_journal (source=whoop)', count(DISTINCT behaviors_date), min(behaviors_date), max(behaviors_date)
FROM pds.habit_journal, w WHERE source = 'whoop' AND behaviors_date BETWEEN w.lo AND w.hi
UNION ALL
SELECT 'supplement_intake', count(DISTINCT intake_date), min(intake_date), max(intake_date)
FROM pds.supplement_intake, w WHERE intake_date BETWEEN w.lo AND w.hi
UNION ALL
SELECT 'caffeine_timing_daily (mg>0)', count(*), min(calendar_date), max(calendar_date)
FROM pds.caffeine_timing_daily, w WHERE calendar_date BETWEEN w.lo AND w.hi AND total_caffeine_mg > 0
UNION ALL
SELECT 'cronometer_nutrition_behavioral_daily', count(DISTINCT calendar_date), min(calendar_date), max(calendar_date)
FROM pds.cronometer_nutrition_behavioral_daily, w WHERE calendar_date BETWEEN w.lo AND w.hi
UNION ALL
SELECT 'meal_timing_from_cronometer', count(*), min(calendar_date), max(calendar_date)
FROM pds.meal_timing_from_cronometer, w WHERE calendar_date BETWEEN w.lo AND w.hi
UNION ALL
SELECT 'phone_usage_daily', count(*), min(behavioral_date), max(behavioral_date)
FROM pds.phone_usage_daily, w WHERE behavioral_date BETWEEN w.lo AND w.hi;
```

Q11, adherence-quality details:

```sql
SELECT
 (SELECT max(calendar_date) FROM pds.cronometer_nutrition_daily) AS cronometer_last_day,
 (SELECT max(behaviors_date) FROM pds.habit_journal WHERE behaviors_date < date '2026-11-07') AS habit_last_day_before_checkin,
 (SELECT count(DISTINCT behaviors_date) FROM pds.habit_journal WHERE behaviors_date >= date '2026-11-07') AS habit_days_since_checkin_launch,
 (SELECT count(*) FROM pds.supplement_intake WHERE intake_date > date '2026-11-10' - 90) AS supp_rows_last90,
 (SELECT round(100.0 * avg((intake_time IS NOT NULL)::int), 1) FROM pds.supplement_intake WHERE intake_date > date '2026-11-10' - 90) AS supp_pct_timed_last90,
 (SELECT round(100.0 * avg((stack_id IS NOT NULL)::int), 1) FROM pds.supplement_intake WHERE intake_date > date '2026-11-10' - 90) AS supp_pct_from_stack_last90,
 (SELECT count(DISTINCT product_id) FROM pds.supplement_intake WHERE intake_date > date '2026-11-10' - 90) AS supp_distinct_products_last90,
 (SELECT round(avg(dietary_caffeine_mg)::numeric, 1) FROM pds.caffeine_timing_daily WHERE calendar_date > date '2026-11-10' - 90) AS caff_dietary_mg_avg_last90,
 (SELECT round(avg(supplement_caffeine_mg)::numeric, 1) FROM pds.caffeine_timing_daily WHERE calendar_date > date '2026-11-10' - 90) AS caff_supp_mg_avg_last90,
 (SELECT min(behavioral_date) FROM pds.phone_usage_daily) AS screen_v2_first_day,
 (SELECT count(*) FROM pds.phone_usage_daily) AS screen_v2_days_total;
```

Q12, unadjusted same-night HRV by the alcohol question:

```sql
SELECT h.question, h.answer, count(*) AS n_days,
       round(avg(m.whoop_hrv_rmssd)::numeric, 1) AS mean_same_night_hrv,
       round(avg(ln(m.whoop_hrv_rmssd))::numeric, 3) AS mean_ln_hrv
FROM pds.habit_journal h
JOIN pds.daily_health_matrix_behavioral m ON m.calendar_date::date = h.behaviors_date
WHERE h.question ILIKE '%alcoholic drinks%' AND m.whoop_hrv_rmssd IS NOT NULL
GROUP BY 1, 2 ORDER BY 1, 2;
```

Q13, Eight Sleep as a second sensor for the same sleep, and objective adherence fields (last 90 days):

```sql
WITH spine AS (
  SELECT g::date AS d FROM generate_series(date '2026-08-13', date '2026-11-10', interval '1 day') g
), j AS (
  SELECT s.d, m.whoop_hrv_rmssd AS whoop_hrv, nxt.eight_sleep_hrv AS es_hrv_same_sleep
  FROM spine s
  LEFT JOIN pds.daily_health_matrix_behavioral m ON m.calendar_date::date = s.d
  LEFT JOIN pds.daily_health_matrix_behavioral nxt ON nxt.calendar_date::date = s.d + 1
)
SELECT count(*) AS days,
       count(*) FILTER (WHERE whoop_hrv IS NULL) AS whoop_missing,
       count(*) FILTER (WHERE whoop_hrv IS NULL AND es_hrv_same_sleep IS NOT NULL) AS whoop_missing_eight_sleep_present,
       count(*) FILTER (WHERE whoop_hrv IS NULL AND es_hrv_same_sleep IS NULL) AS both_missing,
       round(corr(whoop_hrv, es_hrv_same_sleep)::numeric, 3) AS r_whoop_vs_eight_sleep_same_sleep,
       (SELECT count(*) FROM pds.caffeine_timing_daily c
         WHERE c.calendar_date BETWEEN date '2026-08-13' AND date '2026-11-10' AND c.last_caffeine_hour IS NOT NULL) AS caffeine_days_with_timing,
       (SELECT count(*) FROM pds.phone_usage_daily p
         WHERE p.behavioral_date BETWEEN date '2026-08-13' AND date '2026-11-10' AND p.minutes_last_hour_before_sleep_est IS NOT NULL) AS screen_days_with_prebed_minutes
FROM j;
```

Q14, travel days in the last 365 days and helper functions:

```sql
SELECT count(*) FILTER (WHERE flew = 1) AS flight_days_last365, count(*) AS rows_last365
FROM pds.flight_day_unified
WHERE calendar_date > date '2026-11-10' - 365 AND calendar_date <= date '2026-11-10';

SELECT
 (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'pds' AND p.proname = 'behavioral_today_now') AS has_behavioral_today_now,
 (SELECT count(*) FROM information_schema.columns
   WHERE table_schema = 'pds' AND table_name = 'daily_health_matrix_behavioral'
     AND column_name = 'onyx_is_transition_day') AS has_transition_col,
 (SELECT count(*) FROM pds.sync_log WHERE source ILIKE 'experiment%') AS existing_experiment_heartbeats,
 (SELECT count(*) FILTER (WHERE onyx_is_transition_day) FROM pds.daily_health_matrix_behavioral
   WHERE calendar_date::date > date '2026-11-10' - 365) AS transition_days_last365;
```

(Q3, Q5, Q10 and the second Q14 query differ cosmetically from the first as-run text: a redundant `count(*) FILTER (WHERE true) / 1` became `count(*)`, unused columns and one empty placeholder branch were removed, labels were shortened. Each was re-run exactly as shown on 2026-11-11 and returned the same values.)

## Appendix B: simulation method

Run locally on 2026-11-11 with the repo's analysis environment (numpy 2.4, scipy 1.18, statsmodels 0.14) from the aggregate inputs in Section 7.1 only; no rows were downloaded and the scripts are not in the repo.

- Noise: AR(1), `e_D = rho*e_(D-1) + sqrt(1 - rho^2)*sigma*u_D`, with sigma 21.4 ms and rho 0.476 (set A). Optional random-walk drift of 1.5 ms per day.
- Treatment: `Y_D = e_D + delta*T_D + c*T_(D-1)`, c = carryover (0, +4 or -4 ms).
- Missing nights: independent, rate 18.9% (also 5% and 0%).
- Designs: 2-day pairs (random order); 4-day blocks drawn uniformly from the 6 orderings of AABB; 14-day periods in random AB / BA order with the first 2 days of each period discarded.
- Analysis: pairs, one-sample t-test or sign-flip randomization test (999 flips) on complete pairs; 4-day blocks, OLS with block fixed effects (within-block demeaning) on `T_D` and `T_(D-1)` with a t-test, or a randomization test re-drawing the block orderings (199 draws); periods, mean of kept nights per period, paired by block, one-sample t-test.
- Replications: 4,000 (formula checks), 2,000 to 800 (4-day calibration at 232 / 596 / 1,652 days), 600 (sign-flip), 300 (block re-draw randomization test).
