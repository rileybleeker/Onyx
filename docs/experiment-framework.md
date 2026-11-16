# Experiment framework (N-of-1 trials): design

Status: design and implementation reference. Personal calibration and empirical results are retained privately.

Roadmap row: "Build experiment framework" (Tasks DB, `Source = "Onyx Roadmap"`).

## 1. Result first

- An Onyx experiment is a randomized self-trial: each behavioral day gets arm A or arm B by a random schedule made before the trial starts, and the outcome is the HRV of the sleep that closes that day (the `hrv_alignment.py` same-night rule).
Choose a voluntary, reversible intervention with a prespecified meaningful effect and feasible burden. Estimate the required duration from private data before registration; do not claim a fixed duration is sufficiently powered for every person or treatment.

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
- Four-day blocks balance assignment locally and help separate direct treatment effects from previous-day carryover. Two-day pairs can confound those effects; assess the registered estimator with synthetic allocation simulations.
- Use for treatments that act within a day: evening caffeine cutoff, phone off in the last hour before bed, alcohol yes/no, a pre-bed supplement with a short half-life, evening workout or sauna.

### 4.2 Period design for slow treatments

- For treatments that build up over days or weeks (creatine loading, an adaptogen, a training-block change): periods of P days per arm, two periods per block in random order (AB or BA), the first w days of every period discarded as washout.
- Default P = 14 (two whole weeks, so each period has the same weekday mix), w from Section 5.
- Use period assignment when daily switching is unsuitable. Estimate its duration and burden from private calibration before registration.

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
- Objective adherence can reuse screen-time, caffeine timing, supplement timing and workout sources where their semantics support the protocol. Untimed or retrospective logs do not establish intervention timing.

## 5. Washout from measured carryover

### 5.1 How long HRV itself remembers a night

Estimate autocorrelation and seasonality from a pinned private baseline. Keep measured values private and report their uncertainty in the protocol. Do not choose washout solely from outcome autocorrelation.

### 5.2 Measuring a treatment's own carryover

Estimate treatment carryover separately from residual outcome autocorrelation, using a prespecified method and an appropriate observation window.
- From history (hypothesis only): the lag-1 version of a treatment column (`*_lag1`) in the observational layer gives a rough, confounded prior for b1.
- For slow treatments, use pharmacology first (half-life, loading time) and the period design's discarded days.

### 5.3 Washout rule

- Daily designs: no washout days; carryover is modelled (b1) and reported. If the pre-registered analysis finds |b1| larger than half the MID, the next trial of that treatment must use the period design.
Choose the washout from treatment carryover uncertainty, biological plausibility and burden; register the rule before revealing outcomes.

## 6. Pre-registered hypotheses

### 6.1 Template

Each trial gets `docs/experiments/EXP-NNN.md` with this front matter (illustrative values):

```yaml
id: EXP-001
title: Phone off in the last hour before bed
status: registered            # draft -> registered -> running -> paused | stopped_early | complete
registered: 2026-12-01
start: "<first-behavioral-day>"
planned_end: "<start-plus-n_days-minus-one>"
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
  n_blocks: "<chosen-before-registration>"
  n_days: "<four-times-n_blocks>"
  washout_days: 0
power_inputs:                 # placeholders; populate privately before registration
  sigma_ms: "<private-baseline-estimate>"
  rho_lag1: "<private-baseline-estimate>"
  missing_rate: "<private-baseline-estimate>"
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

The file the code reads is `docs/experiments/TEMPLATE.md` (built 2026-11-13). It differs from the sketch above in four places: `adherence.objective` is structured (`source`, `max`, `arm`) so the database view can check it; `analysis` carries `alpha` and `n_redraws` as numbers; `stopping.interim` must be `none` until interim looks are built (Section 12.1); and (2026-11-16, Section 8.1) `analysis` also names the inference method it registers (`inference_method`, which must equal `experiment_analysis.INFERENCE_METHOD` when the register step runs), declares one night of carryover (`carryover_nights: 1`; anything longer is the period design) and, for a treatment trial, says why the untestable parts of the model hold (`model_justification`). The register step refuses a protocol without them, and an `alpha` that leaves fewer than 10 re-draws of room above the nuisance level (or is under twice it).

### 6.2 Where it is stored and how it is locked

1. **Repo**: the file is merged to `master` through a PR before `start`. The merge commit is the registration record; git history is the tamper evidence.
2. **Supabase** (proposed `pds.experiments`): one row with `protocol_sha256` (SHA-256 of the merged file), `git_commit`, `alignment_version`, `seed_sha256`, `locked_at`. A guard trigger in the style of `zzz_block_frozen_whoop_era` refuses any change to protocol columns once `locked_at` is set; only the status may move forward (registered -> running -> paused / stopped_early / complete).
3. **Notion**: the experiment page carries the same hash (Section 10).
4. **Amendments**: a new file `EXP-NNN-amend-1.md`, merged before any interim result is seen, listed in the final report. The original never changes.

## 7. Power and private calibration

Estimate outcome variance, autocorrelation, day-of-week structure, missingness and adherence from an appropriate private baseline. Record the data window and assumptions privately. Public examples must use declared synthetic inputs.
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

The effective-n formula describes contiguous same-arm observations. Randomized neighboring assignments can share slow noise while differing in treatment. Estimate the actual precision with the registered allocation and analysis; do not transfer an empirical result from another baseline.

### 7.3 Planning and simulation

Use the formulas above for an initial duration estimate, then simulate the actual blocked allocation, missingness, carryover and registered analysis. Examine false-positive rate, interval coverage, power and sensitivity to misspecified carryover. Keep personal calibration inputs and result tables private. Trial duration is chosen before the experiment, not extended until significance appears.

The planning check (`experiment_admin.py power`, the placebo SD of the estimate) assumes a test as strong as the old no-carryover one. The registered same-night test allows for any carryover (Section 8.1), which costs power, so the check's day count is a lower bound; the calibration report (Section 8.2) carries the power at the planted effect of each effect scenario, and the planned length is checked against it.
## 8. Analysis plan

- **Estimand**: intention-to-treat difference between arms in the HRV of the sleep that closes the day (b0). Secondary: b1 (next night) and b0 + b1.
- **Model**: `Y_D = block_D + b0*T_D + b1*T_(D-1) + day_of_week_D + e_D`, OLS with block fixed effects on nights that have HRV. No imputation of missing nights.
- **p-value**: randomization test of "no same-night effect, any carryover" (Section 8.1). Re-draw the block orderings 10,000 times with the registered procedure and refit; the carryover is a nuisance handled by Berger-Boos. Valid whatever the autocorrelation, because it only uses the random assignment that actually happened. The re-draw seed is derived from the experiment id and the as-of date, so a re-run returns the same p.
- **Interval**: invert that test: a certified enclosure of every same-night value it does not reject (Section 8.1). Newey-West HAC (maxlags 7) as a quick cross-check. A mixed model with random block intercepts (statsmodels `MixedLM`) is an acceptable sensitivity estimate, but it does not model the within-block AR(1) residual.
- **Period designs**: per-period mean of the non-washout nights, paired difference per block, randomization test over the AB / BA orders.
- **Sensitivity** (pre-registered): ln(HRV); per-protocol (adherent days only, labelled as no longer randomized); plus `hrv_lag1` and `hrv_7d_mean` as covariates (built from earlier trial nights, so they depend on earlier arms: those fits' p-value and interval are approximate, their no-effect p exact, Section 8.1); Eight Sleep HRV of the same sleep (matrix row D+1's `eight_sleep_hrv`, re-keyed by `al.realign_matrix`) as a second sensor, never averaged with or substituted for WHOOP. Each secondary series gets its own missingness check.
- **Missingness check**: compare the share of missing nights between arms (Fisher exact). A difference above 10 points is reported as a threat to the result and withholds a firm decision (Section 8.1); an A/A check uses Fisher's exact test at alpha instead.
- **Interim**: only at the registered look, only the stop / continue decision is shown unless the boundary is crossed. Daily progress reports never show the effect estimate.

Relation to the observational pipeline: trial days stay in the matrix and keep feeding `hrv_analysis.py` and `causal_inference.py` as ordinary history (randomized variation helps them). The arm indicator is not added to the matrix as a feature, so it never becomes another auto-enumerated treatment. Phase 4 adds one comparison row per finished trial (trial estimate vs the AIPW estimate for the same variable on non-trial days).

### 8.1 Inference under carryover (2026-11-16, `experiment_analysis.py`, method `joint_sharp_null_berger_boos_v1`)

Why: re-drawing the schedule while holding the observed outcomes fixed is exact only for Fisher's null that the arm changes no night at all. With a non-zero carryover b1 the outcomes do depend on yesterday's arm, so a "same-night effect is zero" test built that way, and an interval that shifted only the same-night effect, had no guarantee (audit PIPE-06). The fix states the model and tests what it says.

**Working model M** (assumption ids as in the report's `inference.assumptions`):

- `one_night_carryover`: night D's outcome depends on the schedule only through t_D and t_(D-1). Declared per trial (`analysis.carryover_nights: 1`) and justified (`analysis.model_justification`).
- `constant_additive_effects`: Y_D(t) = Y_D(0) + tau * t_D + gamma * t_(D-1), the same tau and gamma every night. Covered by the same justification.
- `missing_not_caused_by_arm`: which nights have an outcome, and which blocks are left out, does not depend on the schedule. Checked only for a large imbalance (more than 10 points between the arms fails it; an A/A check uses Fisher's exact test at alpha); passing does not prove it.
- `randomized_schedule`: the arms followed the committed seed (the report job's `GUARD experiment_schedule`).
- `pre_trial_day_is_control`: the day before the trial counts as the control arm. Covered by the justification.
- `stopping_not_outcome_dependent` (added 2026-11-16, review PIPE06-FOLLOWUP-R1): the nights analysed were fixed before the trial, i.e. it ran to its pre-registered end, so when it ended did not depend on the arms or the outcomes seen so far. The re-draws hold the analysed period fixed and the calibration (8.2) runs fixed-length trials only, while a stop can follow what was seen (each day's arm is shown on Today, the HRV in its app). Checked: a stop before the planned end fails it whatever its `stop_reason`, because no registered stopping rule exists that the calibration covers (`stopping.interim` must be `none`); a stop on or after the planned end cuts no night and changes nothing.
- `constant_multiplicative_effects` (the ln(HRV) sensitivity fit only): the model holds for ln(HRV) instead, each arm multiplying HRV by a constant factor. It cannot hold together with `constant_additive_effects` unless nothing acts; neither tested nor declared.
- `missing_not_caused_by_arm:<series>`: the same as `missing_not_caused_by_arm` for each secondary outcome's own missing nights, checked per series; a failure marks only that series and never withholds the decision.

**Exact joint test.** Under the joint sharp null H(tau, gamma) every potential outcome is known. OLS is linear in the outcome and both regressors are in the model, so re-draw r's statistic is exactly `a_r - tau * g_r - gamma * h_r` (the coefficients re-draw r gives the outcome, the observed assignment and the observed yesterday's assignment), against the observed `(b0 - tau, b1 - gamma)`. One pass of re-draws serves every (tau, gamma); `tests/test_experiment_calibration.py` checks the identity against a refit on imputed outcomes.

**Monte Carlo re-draws.** Every p-value is (1 + extreme re-draws) / (R + 1) over R re-drawn schedules: the standard Monte Carlo randomization test (Dwass 1957, Phipson and Smyth 2010), whose size is at most alpha when the re-draws are drawn at random, independently of the observed schedule. The deployed re-draws are not random: their seed (`experiment_design.redraw_seed`) is a deterministic SHA-256 hash of the experiment id and the report date, public values that never touch the secret allocation seed (os.urandom, committed before the trial), and the final report is computed once, so the re-draws cannot be re-chosen after a p-value is seen. Every "at most alpha" and "at least 1 - alpha" in this section therefore rests on a pseudo-randomness assumption, the one every seeded Monte Carlo test makes (the hash treated as a random draw independent of the allocation), and holds for the one fixed re-draw set of a report only up to Monte Carlo error, about sqrt(alpha (1 - alpha) / R) (0.002 at R = 10,000 and alpha 0.05). The calibration (8.2) seeds its re-draws with the same rule and is the empirical evidence for it. The `randomized_schedule` assumption and every output's `validity` text in the report say so.

**Per output** (`inference.outputs` in the report carries the same text):

| Output | Null / estimand | Needs | Validity |
|---|---|---|---|
| `estimate`, `carryover`, `two_night_total` | tau, gamma, tau + gamma | M | OLS; approximately unbiased over the randomization (exact only with complete nights and a symmetric design: missing nights, the lag term and the fixed pre-trial day break it slightly) |
| `p_value` (read by the decision rule) | tau = 0, any gamma | M | Berger-Boos: beta + the largest joint p over a 1 - beta randomization set for gamma. Type I error at most alpha whatever gamma is (as a Monte Carlo test, see "Monte Carlo re-draws" above) |
| `ci_low` / `ci_high` | the tau0 not rejected by that test | M | certified enclosure of every tau0 with p >= alpha (below), so coverage at least 1 - alpha (as a Monte Carlo test) |
| `p_carryover`, `carryover_ci_low` / `_high` | gamma = 0 (any tau) / the gamma0 not rejected | M | the same construction with the roles swapped |
| `p_value_no_effect`, `p_carryover_no_effect` | Fisher: the schedule changes no night | randomized schedule, missing not caused by the arm, an end fixed in advance | exact (as a Monte Carlo test) without the effect model (one-night carryover, constant effects), but not without those three (a stop chosen after looking at the arms and the HRV makes the analysed period depend on the assignment, which the re-draws hold fixed); says the arm acts on some night, not which. Not read by the decision; read by the A/A check (Section 12.2) |
| `hac_se`, `hac_se_carryover` | | | approximate cross-check, not read by the decision |
| `sensitivity.ln_outcome` (p, interval) | tau = 0 on ln(HRV), any carryover | M on the log scale (`constant_multiplicative_effects` in place of the additive one) | the same test and interval on ln(HRV); a sensitivity check, not read by the decision |
| `sensitivity.per_protocol` | tau on adherent days | M | estimate only: no longer a randomized comparison, so no p-value or interval |
| `sensitivity.covariate_<name>` (p, interval) | tau = 0 with the covariate added | M | **approximate, not certified**: `hrv_lag1` and `hrv_7d_mean` are built from earlier trial nights, whose outcomes depend on earlier arms under M, yet the re-draws hold them fixed, so the identity above holds only at tau = gamma = 0 |
| `sensitivity.covariate_<name>.p_value_no_effect` | Fisher's sharp null with the covariate added | randomized schedule, missing not caused by the arm, an end fixed in advance | exact (as a Monte Carlo test): under that null the covariate is the same under every schedule |
| `secondary_outcomes.<series>` (p, interval) | tau = 0 for that series, any carryover | M for that series, plus `missing_not_caused_by_arm:<series>` (and the primary missingness check, the excluded blocks being shared) | the same test and interval; reported next to the primary result, never read by the decision |

Every entry carries `supported` (false when a failed check covers one of its assumptions); the covariate entries also carry `approximate: true`, and the Notion page prints the label or "not supported" next to each sensitivity and secondary number. The intervals enclose every accepted value, and the accepted values need not form one piece, so an interval can contain 0 while its p-value rejects 0 (never the reverse); the page says so when it happens, and the decision rule reads the p-value.

beta is 0.001, raised to 5 / (R + 1) below 4,999 re-draws so the nuisance set always rests on at least 5 re-draws (0.005 at the protocol minimum of 999); the protocol rules require alpha to be at least twice beta and at least 10 re-draws above it, or the test could almost never reject. The nuisance set is computed exactly from the re-draws (each re-draw's extreme values of gamma form an interval, its complement or a half-line), and every floating-point tie counts as extreme. When the nights cannot bound the carryover (short trials, few blocks) the set is the whole line, `carryover_set_bounded` is false and the same-night test is close to 1: valid, but it cannot find anything; a longer trial or the period design is the remedy. One boundary everywhere: a value is rejected when p < alpha (the decision rule's adopt condition) and accepted when p >= alpha.

**The interval is certified (`certified_enclosure_v1`).** The values the Berger-Boos test does not reject need not form an interval, so stepping out from the estimate until the first rejection can miss an accepted region further out (a review found the earlier look-ahead could). `interval()` therefore proves that nothing beyond each end is accepted. For a strip of values, re-draw r is extreme at (value, nuisance) when |P_r| >= |Q_r| with P_r and Q_r affine, i.e. when P_r - Q_r and P_r + Q_r have the same sign: two convex pieces, each projecting onto the nuisance axis as one interval over the strip. Counting those intervals gives a superset of every nuisance set in the strip and at least the count the p-value maximises, so the bound is never below the p-value anywhere in the strip. Strips double outward from the end; past 10,000 scales the rest of the half-line is one strip in 1 / value (the same algebra after multiplying by its absolute value). A strip that cannot be certified is split; one still uncertain at the smallest width is either accepted (the search steps out past it) or kept inside the interval; a budget that runs out leaves that end infinite. Every way out errs wide. The returned end is the first rejected value past the accepted ones (at most 1e-7 scales beyond). `tests/test_experiment_calibration.py` checks the bound against the p-value on random strips and on hand-built re-draws whose acceptance set has a rejected gap.

**What withholds a firm decision.** The decision rule (Section 6.1) still runs, and its verdict is stored as `decision_if_supported`; `decision` is that verdict only when nothing in `inference.checks` with `blocks_decision` fails: (1) missing shares more than 10 points apart between the arms (`missing_not_caused_by_arm`; in an A/A check, where only a pipeline fault can tie missing nights to identical arms, Fisher's exact test of the arm x missing table at the trial's alpha instead, because with a fifth of nights missing the 10-point rule fires by chance on about half of 4-week checks; either way a check without a readable result, a missing or non-numeric Fisher p or 10-point flag, counts as failed); (2) the registered protocol does not declare one night of carryover with a `model_justification` (`model_justified`; an A/A check passes it, both arms being the same); (3) the trial was stopped before its pre-registered end (`stopping_not_outcome_dependent`, above: whatever the stop's reason, since no registered stopping rule exists that the calibration covers; a stopped trial still gets its final report, over the nights before the stop, with the rule's verdict visible); (4) the protocol's `inference_method` is not the method that ran (`registered_method`); (5) `experiment_analysis.METHOD_REVIEW` does not record a calibration report and an independent statistical review of this method that cover the trial's alpha, re-draw count and block design (block length, arm-A days per block, a number of scheduled blocks inside the calibrated range, and at least the calibration's fewest blocks left after excluded blocks and an early stop), both for the inference code that is running (its fingerprint, Section 8.3) (`method_reviewed`, pending until the PR that records them). Otherwise `decision` is `inconclusive`, `decision_firm` is false and `decision_withheld` lists the reasons. A failed check also marks the outputs whose assumptions it leaves unsupported (`inference.outputs[...].supported`, `inference.unsupported_outputs`): arm-dependent missing nights and an early stop mark Fisher's test too. The Notion report shows the reasons, the rule's verdict, the assumptions, unsupported numbers and any non-blocking limit (an unbounded carryover set). `one_night_carryover` and `constant_additive_effects` are not testable at useful power in this design, so the protocol carries them; a treatment that can last longer uses the period design. The register step refuses a treatment trial while `METHOD_REVIEW` does not cover its configuration, because a final report is written once and could otherwise never be firm (the A/A check may run first). Nothing here changes allocation, the no-peeking rule or the pre-registered end: `analyze_trial` still refuses before it.

### 8.2 Calibration (`experiment_calibration.py`)

A seeded synthetic calibration report, run in the scheduled validation phase (never before a merge), at the registered configuration (the template's 10,000 re-draws and alpha 0.05): `python experiment_calibration.py --sims 1000 --redraws 10000 --alpha 0.05 --seed 20261116 --revision <commit> --out calibration.json` (in Actions `--revision` defaults to `$GITHUB_SHA`). In one process that is many hours, more than one Actions job allows, so it runs on the PC, or as one job per scenario (`--scenario <name> --out <shard>.json`, same seed and configuration) merged with `--merge <shard>.json ... --out calibration.json`: scenario j's trial i always draws from `default_rng([seed, j, i])`, so a shard holds exactly the rows of a full run, and the merge refuses shards of different configurations or a scenario twice. The scheduled test (`tests/test_experiment_calibration.py`) runs only a bounded smoke subset (the audit's carryover, serial-dependence and missing / excluded scenarios plus one without carryover, 40 trials at 499 re-draws, at the tolerance for 40 trials), so it stays inside the suite's per-file limit; it is not a review-ready report. Scenarios (declared synthetic inputs: SD 20 ms, lag-1 correlation 0.5, 20% missing nights, 58 blocks unless stated): no effect; no same-night effect with a +8 ms carryover; a -12 ms carryover with lag-1 correlation 0.8 and random-walk drift; 35% missing nights and 6 excluded blocks; same-night effect with and without carryover; a 7-block trial. Tolerances fixed before any run, with se = sqrt(alpha (1 - alpha) / n) and Z_MC = 3: type I error of `p_value` (tau = 0), `p_carryover` (gamma = 0) and the joint test at the true (tau, gamma) at most alpha + 3 se; coverage of both intervals at least 1 - alpha - 3 se. The joint test is exact up to the discreteness of the re-draws, so its rate is also reported against alpha +/- 3 se as information (a discrete or degenerate design may reject less often, which is not invalid). Power at the planted effect of each effect scenario is information too (Section 7.3). The certified interval's defining property is checked directly as well (`enclosure`, added 2026-11-16 from the method review, 8.3): in every trial `bb_p_value` is probed at 18 fixed distances beyond each finite end of both intervals (1e-6 to 1e6 scales, dense from 0.25 to 20), and at the true value and 0; a single accepted value (p >= alpha) outside its interval fails the scenario (tolerance 0, no Monte Carlo slack). A finite set of probes is a regression check, not the proof (the strip bound is, checked in the tests). The share of trials with an infinite interval end (nights that cannot bound it, or a spent certification budget) is reported as information. Each synthetic trial's re-draws are seeded by the deployed rule itself, `experiment_design.redraw_seed` on a synthetic experiment id (`calibration_redraw_seed`), so the report measures the seeding rule a real report uses. A stress scenario, `near_singular` (added 2026-11-16 from the method review, 8.3): no same-night effect, a +6 ms carryover, 10 blocks with half the nights missing, so few nights per block are left to separate the arm from the carryover; it must meet every tolerance like the other supported scenarios. Every scenario reports `singular_redraw_share` (the mean share of re-draws that cannot separate the two, counted as extreme) and `n_skipped` (trials the model cannot fit at all). Two unsupported scenarios (carryover two nights later; missing nights caused by arm A) are reported without a tolerance, with how often the missingness check withholds the decision. Each scenario also reports the previous method (Fisher's test and the interval that assumed no carryover) as information. The report holds rates and counts only, and records what it covers (`covers`: method, alpha, re-draw count, the block shape every scenario uses (4 days with 2 on arm A, the shape the protocol rules register), `n_blocks` = the fewest blocks a supported scenario analysed (scheduled minus excluded) and the most one scheduled (7 to 58 in a full run), inference fingerprint) and the code it ran: `inference_fingerprint`, `harness_fingerprint` (of `experiment_calibration.py`) and `revision`; shards must agree on all three. These are the fingerprints of the code the process loaded, taken when the harness is imported, before any simulation; the files are read again, with no cache, before and after the run and before a merge, and a source that changed (or can no longer be read) refuses the report rather than label the results of the code that ran with the edited code's fingerprint (added 2026-11-16, review of round 6). So a run is a fresh process on an unchanged checkout of its revision (in Actions the job's checkout of `$GITHUB_SHA`; on the PC a worktree at that commit that nothing edits during the run). The merge also refuses shards whose harness fingerprint is missing or is not the running harness's (or when the running harness cannot be read), and any scenario whose stored `inputs` differ from its entry in `SCENARIOS`, and shards whose inference fingerprint is not the running code's (which `METHOD_REVIEW` would refuse anyway) (added 2026-11-16, review PIPE06-FOLLOWUP-R2 and method review round 6): the merged report's `covers` and `review_ready` are built from the running harness's scenarios, block shape and limits, so archived shards merged after a harness change would otherwise claim designs and limits they never ran. Merge at the revision that ran the shards, or run them again. `passed` needs every supported scenario; `review_ready` also needs at least 1,000 trials analysed in each (500 in the stress scenario; trials the model cannot fit do not count), at most 1% of a scenario's trials skipped (50% in the stress scenario: the rates hold only for trials the model can fit, and a real trial that cannot be fitted gets a final report with no decision, `not_analysable`), a revision, an inference fingerprint and a harness fingerprint. Only a review-ready report, with an independent statistical review, may be recorded in `METHOD_REVIEW`, with exactly the alpha, re-draw counts and designs it covers; a trial is firm only at a covered configuration. The method itself is exact for any block design under its assumptions; the design range is checked because the calibration is the evidence that the code delivers that, and it ran on these designs only. The register step checks the scheduled design; the final report also checks the blocks the analysis keeps, so a trial scheduled inside the range that analyses fewer blocks than the calibration's fewest is withheld too. Analysed blocks = scheduled blocks minus the excluded ones (declared exclusions and every block that starts after an early stop); a stop is by calendar day, so the partly observed last block counts as analysed, its later nights missing like any other missing night. `carryover_set_bounded` still flags a covered trial too short to bound the carryover.

### 8.3 Method review record (`experiment_analysis.METHOD_REVIEW`)

A firm decision needs both halves of `METHOD_REVIEW`: an independent statistical review of the method and a review-ready calibration report (8.2) covering the trial's alpha, re-draw count and block design. The review is recorded; the calibration report is not (it runs in the scheduled validation phase), so every final report still withholds its decision ("inconclusive", with the rule's verdict in `decision_if_supported`) and the register step still refuses a treatment trial. The review covers the method. It is not an approval of any trial's outcome, and no trial is registered.

**Both halves are bound to the code (2026-11-16, `experiment_fingerprint.py`).** Each half is a structured record, never free text, and names the code it covered by its inference fingerprint: a SHA-256 of the syntax tree, in source order, of every top-level statement of `experiment_analysis.py` and of the allocation and re-draw code of `experiment_design.py` (`generate_schedule`, `redraw_blocks`, `redraw_seed`, the nuisance level, every name those use and the imports they rely on). Docstrings, comments, layout, protocol validation, `METHOD_REVIEW` itself and the explanation of the outputs (`ASSUMPTIONS`, `output_semantics`: text and the per-output "supported" labels, which change no number and no decision) do not count. `method_review_problem` compares both recorded fingerprints with the fingerprint of the code that is running, so any later change to the inference code withholds every decision until both halves are recorded again for it; an unreadable source withholds too. The fingerprint binds every number a report holds and every step of the firm / withheld decision except the method-review check itself: a fingerprint cannot protect the code that compares it, so the check is held by its tests (`tests/test_experiment_calibration.py`) and by review of each change to it. The value is the same on Python 3.12 (Actions) and 3.14 (the PC); print it with `python experiment_fingerprint.py`. What the gate requires:

- `independent_review`: `reference`, `reviewed_revision`, at least two distinct `reviewers`, a `sound` verdict from each, and `inference_fingerprint`.
- `calibration_report` (recorded later): `reference`, `revision` (the report's), `inference_fingerprint` and `harness_fingerprint` copied from the report, `review_ready: true`, and `suite_run`: the scheduled-suite run, at that fingerprint, in which `tests/test_experiment_calibration.py` passed. That file holds the strip-bound proofs of the certified interval (disconnected regions, tails, ties), which the calibration's finite enclosure probes do not replace, so they must be seen passing before the report is recorded. Then `n_redraws`, `alpha`, `block_designs` ((block length, arm-A days) pairs) and `n_blocks` ((fewest blocks analysed, most blocks scheduled)) as the report's `covers` gives them. A trial whose design is not given, whose scheduled blocks are outside that range, or which analyses fewer blocks than its low end, is not covered.

The recorded review has fingerprint `25ea4dad9d45b77197af2e8bb909d70fb7a3d7f2ab2489f7cd1c4a31b0be2a7c`, the fingerprint of the reviewed revision `0a3d3712` (the record's `reviewed_revision`), of `7ac3cf32` (which adopted a recommendation of that review and changed the harness only, so it was not itself reviewed), of `dd308e0f` (the harness records the fingerprints its process loaded, from a later code review; harness and fingerprint-reader code only, not itself reviewed by the models) and of the current code (later changes are `METHOD_REVIEW`, this text, docstrings and that code outside the fingerprint). Computed on both Python versions (3.12.13 and 3.14.6). History: the method was reviewed at `ce76f720`, the head of #375, squash-merged into master as `ef17db5e` with the same fingerprint (`7a79a1a4cc2f89a1d5f9a8a5547e1e4ca63ad3b38de01cb9cc25783761969da0`; the changes after it up to review round 4 were docstrings, the Monte Carlo wording of `ASSUMPTIONS` / `output_semantics`, `METHOD_REVIEW` and `method_review_problem`, all outside the fingerprint). Review round 5 changed `assumption_checks` and `analyze_trial` (the trial's block design and analysed blocks passed to the review check, missing-night checks failing closed), so the fingerprint changed (to `02808939ca0a678be6c597d9929274810a585a85034d8b9679e251b9f74ef671`) and the same two models reviewed that change before the record was moved to it. Review round 6 changed `assumption_checks` again (the early-stop check), so the fingerprint changed to the current one and the same two models reviewed that change too (the last follow-up below). The record keeps the method review's revision and fingerprint as `method_reviewed_revision` / `method_reviewed_fingerprint`.

**Independent statistical challenge, 2026-11-16.** Two non-Anthropic models (`openai/gpt-5.2` and `google/gemini-2.5-pro`, through the PAL MCP) were given the method description, the analysis at `ce76f720` and the calibration harness, all synthetic (no personal data), and asked to find a way the same-night p-value exceeds alpha under M, the interval misses an accepted value, or the calibration passes while the method is wrong. Claims were checked against the code before acting.

| Point | Raised by | Disposition |
|---|---|---|
| Joint sharp-null identity (fixed nuisance basis from the kept nights, lag with the pre-trial control, singular re-draws extreme) | both | confirmed correct |
| Berger-Boos validity (same re-draws for the nuisance set and the test, hull superset, beta, (1 + B) / (R + 1)) | both | confirmed correct |
| Certified enclosure argument (two convex pieces, projection, tail in 1 / v, every exit errs wide) | both | confirmed sound; gpt-5.2: calibration tested coverage only, not the enclosure property |
| Add a direct check that no accepted value lies outside an interval | gpt-5.2 (required) | **adopted**: the `enclosure` metric (8.2), tolerance 0 |
| The deployed re-draw seed is a deterministic hash, while the calibration drew a random one | gpt-5.2 (required) | **adopted**: the calibration seeds with the deployed rule (`calibration_redraw_seed`). A fresh random seed at analysis time was **rejected**: once drawn it is just as fixed, it breaks the reproducible re-run, and the size guarantee is the same either way |
| State that the guarantee is a Monte Carlo test's, under a pseudo-randomness assumption, up to Monte Carlo error for a fixed re-draw set | gpt-5.2 (required) | **adopted**: module docstring, the `randomized_schedule` assumption, every output's `validity`, this section (8.1) |
| Replace `f == 1.0` / `f == -1.0` in `_sets_moving` and `b == 0.0` in `_piece` with tolerances | gemini-2.5-pro (required), gpt-5.2 (recommended) | **rejected**, gemini-2.5-pro agreed on re-check: near-1 f takes the exact two-root branch (a non-zero f - 1 is at least 2^-53 for f in [0.5, 2], so the far root cannot overflow), and a tiny b is kept as an exact bound; snapping either to the special case would drop part of an extreme set (narrower, the unsafe direction) |
| A stress scenario for near-singular designs and many singular re-draws | gpt-5.2 (recommended) | **adopted** in the follow-up below: `near_singular` and `singular_redraw_share` (8.2) |
| Report how often an interval end is infinite (budget spent) | gpt-5.2 (recommended) | **adopted**: `interval_unbounded` (information) |

Verdicts after the changes: `google/gemini-2.5-pro` SOUND; `openai/gpt-5.2` SOUND, once its three required points were in (the last was the Monte Carlo qualification of every stated guarantee, docstrings included), and it confirmed this table represents its review fairly. Not reviewed here: whether the calibration report passes. That is the other half of `METHOD_REVIEW`, recorded by the PR that adds the review-ready report (`calibration_report`, `n_redraws`, `alpha`, `block_designs`, `n_blocks`).

**Follow-up: binding the review to the code, 2026-11-16.** A later review pointed out that the record was free text naming `ce76f720` while the code had changed since, and that any non-empty text satisfied the gate. The fingerprint record above replaced it. The same two models were given everything that changed after `ce76f720` (the diff of `experiment_analysis.py` and `experiment_calibration.py`, and the new `experiment_fingerprint.py`) and asked whether the review may be bound to the current code through the fingerprint.

| Point | Raised by | Disposition |
|---|---|---|
| Sorting the statements before hashing lets a reordering that changes which definition wins keep the fingerprint | gpt-5.2 (required) | **adopted**: source order; a test swaps two statements |
| The method-review check is outside the fingerprint, so the claim "every step of the decision" was too wide | gpt-5.2 (required: cover it or narrow the claim) | **claim narrowed** (above and in `experiment_fingerprint.py`): a fingerprint cannot protect the code that compares it, so the check is held by its tests and by review |
| The calibration measures rates on trials the model can fit; review readiness must bound how many it skips | gpt-5.2 (required) | **adopted**: at most 1% skipped per supported scenario, 50% in the stress scenario (8.2) |
| Fingerprint the per-output assumption lists (`output_semantics`) too | gpt-5.2 (recommended) | **declined**: they are labels that change no number and no decision (checked by `test_sensitivity_and_secondary_outputs_state_their_assumptions`), and binding them would make every wording edit force a multi-hour recalibration |
| Turn an unfittable primary fit into a report with no decision instead of a crash | gpt-5.2 (recommended) | **already in place**: `experiment_report.py` catches it and writes a final report with no decision (`not_analysable`) |
| A second near-singular variant (stronger autocorrelation, fewer blocks) | gpt-5.2 (recommended) | **deferred** to the validation phase, once `singular_redraw_share` of `near_singular` has been seen |
| Unit tests of the fingerprint itself (order, docstrings, kept and excluded code, the design closure) | gpt-5.2 (recommended) | **adopted**: `test_inference_fingerprint_covers_the_code_not_the_text` |
| The design closure ignored imports, so an import a kept function relies on was not covered | gpt-5.2 (noted) | **adopted**: imports a kept statement uses join the closure |
| Conditioning on fittable trials, the `near_singular` parameters and the 500-trial minimum | gemini-2.5-pro | confirmed valid; gpt-5.2: valid with the skip bound |

Final verdicts on binding the review to the current code through the fingerprint: `google/gemini-2.5-pro` SOUND; `openai/gpt-5.2` SOUND once the changes above were in, with no required change left. As before, this reviews the method and the record, not any trial's outcome, and the tests it relies on were written, not run (they run in the scheduled suite after deploy).

**Follow-up: design scope and fail-closed missing-night checks (review round 5), 2026-11-16.** A code review of the follow-up found two minor gaps: the review gate checked only alpha and the re-draw count, so once a calibration report is recorded a trial with a block shape or block count the calibration never ran would be covered; and the A/A missingness check treated a missing or non-numeric Fisher p as "not tied to the arm" (the treatment check a missing 10-point flag likewise). The fixes touch `assumption_checks` and `analyze_trial`, which are inside the fingerprint, so the same two models were given the delta (the new gate, the call sites, the fail-closed checks, the harness `covers`; synthetic, no personal data) and asked whether any number changes, whether the gate is correct and fail closed, and whether the review may be bound to the new fingerprint. Claims were checked against the code and the interpreter before acting.

| Point | Raised by | Disposition |
|---|---|---|
| The gate checked only alpha and re-draws, not the design the calibration ran | code review | **adopted**: `block_designs` and `n_blocks` in the record (copied from the report's `covers`), checked at registration and in the final report; a design not given fails closed |
| A/A missingness failed open on a missing or non-numeric Fisher p; treatment on a missing flag | code review | **adopted**: a check without a readable result fails |
| The new check wrongly fails a numpy p-value | gpt-5.2 (required) | **adopted** for `np.float32` and numpy integers (`np.float64` already passed, being a float subclass); gemini-2.5-pro had said numpy integers subclass `int`, which is wrong, and agreed when shown |
| A Fisher p above 1 is read as "not tied to the arm" | gpt-5.2 (required, second pass) | **adopted**: anything outside [0, 1], NaN and infinities included, fails closed |
| Scheduled blocks alone leave "58 scheduled, few analysed" uncovered | gpt-5.2 (recommended) | **adopted**: the final report also requires at least the calibration's fewest analysed blocks (8.2); gemini-2.5-pro had found the scheduled gate alone acceptable and agreed with the addition |
| The design message mixed blocks and days | gpt-5.2 (recommended) | **adopted** |
| After a mid-block early stop, count only completed blocks | gpt-5.2 (recommended) | **declined**, gpt-5.2 agreed: the partly observed last block is a kept block with nights missing for a reason the arm does not cause, as with the calibration's nights missing at random, and counting only complete blocks would be stricter than the calibration's own notion of an analysed block |
| Define "analysed blocks" in the docs | gpt-5.2 (recommended) | **adopted**: scheduled blocks minus the excluded ones (declared exclusions and blocks starting after an early stop), the partly observed last block counted (8.2) |
| Record whether an early stop was planned or event-driven | gpt-5.2 (recommended) | **already in place**: the stop step requires a reason (`stop_reason`) |

Both models confirmed that no estimate, p-value, interval or re-draw changes: the analysed-block count is taken from the set of excluded blocks the fits already use, after the fits. Final verdicts on the code at `b15a2fff` (`29161919` before the branch was rebased onto master; the rebase changed no experiment file and the fingerprint is the same): `google/gemini-2.5-pro` SOUND; `openai/gpt-5.2` SOUND once its two required changes were in. The calibration report is still not recorded, so every decision stays withheld.

**Follow-up: early stop and calibration shard provenance (review round 6), 2026-11-16.** An independent code review of the follow-up PR confirmed two gaps that the PR had disclosed. (1) A trial stopped before its planned end was analysed over the nights before the stop as if it were a fixed-length trial, and only the analysed-block floor of the review check looked at it, so once `calibration_report` is recorded a stopped trial could get a firm decision although the stop may have followed the arms and the HRV seen so far (each day's arm is shown on Today). (2) `merge_reports` compared the shards only with each other, while `_assemble` builds `covers` and `review_ready` from the running harness, so archived shards merged after a harness change could claim designs and limits they never ran. The fix for (1) changes `assumption_checks`, inside the fingerprint, so the same two models were given the delta (the new check and its call path, the assumption lists, the merge checks, the tests; synthetic, no personal data) and asked whether a stopped trial can still be firm, whether a complete trial can be wrongly withheld, whether Fisher's test belongs among the outputs marked unsupported, whether the merge closes the provenance gap, and whether the review may be bound to the new fingerprint. Claims were checked against the code before acting.

| Point | Raised by | Disposition |
|---|---|---|
| An early stop is not part of the firm-decision checks | code review | **adopted**: the blocking check `stopping_not_outcome_dependent` (8.1) fails on any stop before the planned end, whatever `stop_reason` (no registered stopping rule exists that the calibration covers), without a spec, and on a stop date that cannot be compared; its assumption joins the needs of every model and Fisher output; a stop on or after the planned end cuts no night and passes |
| Archived shards take coverage and review readiness from another harness | code review | **adopted**: the merge refuses a missing, unreadable or different harness fingerprint and scenarios whose stored inputs differ from `SCENARIOS`; `review_ready` also needs a harness fingerprint (8.2) |
| Fisher's no-effect test (and so the A/A check) unsupported on an early stop | both | **confirmed**: with past arms and the HRV visible, a stop can make the analysed period depend on the assignment, which the re-draws hold fixed; only a stop that depended on the outcomes alone would leave it valid, and that cannot be verified |
| Refuse at merge time shards whose inference fingerprint is not the running code's | gpt-5.2 (recommended) | **adopted** (`7ac3cf32`, harness only): `METHOD_REVIEW` refuses such a report anyway, so the merge fails earlier and says why |
| Check that a recorded stop reason always comes with a stop date | gpt-5.2 (recommended) | **already in place**: the only stop path (`experiment_admin` `Store.stop`) writes the status, `stopped_on` and `stop_reason` in one update, the protocol lock lets only those change, and a stop date that cannot be compared fails the check closed |
| Confirm what `stopped_on` means against the last night analysed | gpt-5.2 (recommended) | **already settled** (round 5): the stop day's night is the last one analysed; `analyze_trial` refuses until the day after the stop |
| The harness first read the fingerprints after the simulations, so a source edited during a run labelled its results with the edited code's fingerprint | code review of round 6 | **adopted** (`dd308e0f`, harness and fingerprint readers only, outside the inference fingerprint, not itself reviewed by the models): the report records the fingerprints taken when the harness is imported, before any simulation; the files are read again with no cache before and after the run and before a merge, and a change refuses the report (8.2) |

Both models confirmed that no estimate, p-value, interval or re-draw changes: the stop check reads only the spec and runs after the fits, and the merge checks are in the harness. Final verdicts on binding the review to fingerprint `25ea4dad...`, reviewed at `0a3d3712`: `google/gemini-2.5-pro` SOUND; `openai/gpt-5.2` SOUND, with no required change. `7ac3cf32` then adopted gpt-5.2's merge-time recommendation; it changed the harness only (outside the inference fingerprint) and was not itself reviewed, so the record's `reviewed_revision` is `0a3d3712` and its fingerprint is unchanged. `dd308e0f` followed from a later code review in the same way (the harness and the uncached fingerprint readers; the fingerprint is still `25ea4dad...`). The calibration report is still not recorded, so every decision stays withheld.

## 9. Treatment and adherence sources

Reuse the existing check-in, habits, supplement and screen-time sources where their timestamp and completion semantics support the registered protocol. Missing observations are unknown, not automatic nonadherence. Confirm source coverage privately before enrolling a trial; do not publish personal historical coverage counts.
## 10. Auto-report to Notion, heartbeat and /status

### 10.1 Target

A new Notion database **"Onyx Experiments"** under the Project Onyx page (the parent of the Habits DB `29cc936fd5e14ae8b10a4fe5c5f7a6cd`), one page per experiment. Created empty on 2026-11-11 with Riley's approval (database `2d460253-f94b-437d-ab74-0920c213d3b7`, data source `d99f3df8-6759-4de0-b9be-3761759ecd26`, parent Project Onyx `32bbf5b4-4bf2-805f-8d33-e6c72915a970`) with exactly the properties above, Status as a Notion status property and Decision as a select. It inherits the parent page's sharing, so the Onyx integration can write to it as long as Project Onyx stays shared with it; confirm that with the first report write in Phase 2.

Writer (built 2026-11-14): `experiment_notion.py`, called by `experiment_report.py` through its `Mirror` (best-effort, Section 10.3). Same conventions as the other Onyx Notion code: the secret `NOTION_API_KEY` (as in `journal-sync.yml` and `habits-sync.yml`), httpx with `retry_helper.retry_http` (429 Retry-After, 5xx back-off), the data-source API version of `tools/notion_tasks.py` (`2025-09-03`), pages created under data source `d99f3df8-...`. A new page gets one paragraph linking the protocol file at its registration commit. Errors carry the HTTP status and Notion's error code only; a 403 / 404 adds "is the database shared with the integration?". Nothing is printed beyond "page created".

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

- **Outcome drift.** Re-estimate power from an appropriate private baseline. Blocks can absorb slow drift, while changes in scale or variability may reduce power; prespecify a log-scale sensitivity analysis when appropriate.
- **Seasonality.** 2025 quarterly means varied by about 14 ms. Short blocks absorb it; 14-day periods are paired inside 28-day blocks for the same reason.
- **Travel and time zones.** Use the local behavioral-day mapping. Prespecify exclusion of whole travel/transition blocks before seeing outcomes, and allow an advance travel pause.
- **Device changes.** Onyx stores no WHOOP hardware or firmware version (the only device-state field found is `whoop_recovery.user_calibrating`). The protocol records the device in use; a strap or firmware change during a trial is logged in the report and the trial is split at that date in a sensitivity analysis.
- **Wearable coverage.** Check missingness privately before choosing a secondary sensor. Different devices measure different quantities and must not silently substitute for the registered outcome.
- **Missing nights that depend on the arm** (for example not wearing the strap after drinking). Checked by the missingness comparison in Section 8.
- **Carryover.** Modelled in daily designs (b1), and the same-night p-value and interval allow for any one-night carryover (Section 8.1); washout in period designs (Section 5). Carryover past the next night is not covered by the daily analysis.
- **Expectancy and co-interventions.** Open-label arms can change other behaviour (earlier bedtime on the "good" arm). Co-interventions to hold steady are listed in the protocol, and bedtime is a reported secondary variable. Note that changes in sleep caused by the treatment are part of the effect (total effect, as in the causal layer), not bias.
- **Adherence evidence.** Planned stack entries and untimed logs do not prove ingestion time. Timing interventions need reliable real-time capture or must be redesigned.
- **Analysis drift.** A change to `hrv_alignment.py` or the matrix during a trial is caught by the alignment-version guard.

## 12. Phased rollout

| Phase | What | Writes production? | Done when |
|---|---|---|---|
| 0 | This design doc | no | merged |
| 1 | Offline dry runs on real history, read-only: placebo allocations (fake 4-day blocks) on 2025 and the current regime to measure the real type I error and power of the planned analysis on real HRV instead of AR(1); measure the gain from covariates; pick the first treatment with Riley | no | numbers in Section 7 confirmed or corrected on real data |
| 2 | Plumbing: `pds.experiments`, `pds.experiment_schedule` (service-role only), `pds.experiment_days`, `pds.experiment_reports`, protocol lock trigger, `GET /api/experiments/today`, check-in adherence question, report job in dry-run mode, heartbeat, /status card, Notion database. Then a 4-week A/A sham trial (both arms identical) | yes, new tables only | every day revealed, adherence captured on 90% or more of days, report re-runs are idempotent, A/A result not significant |
| 3 | First real trial, pre-registered and locked | yes | final report written; Status stays open on the roadmap until it is verified in production |
| 4 | Calibration with `causal_inference.py`: trial vs AIPW estimate per finished trial, AIPW-based candidate list | yes (`hrv_analysis_results` rows) | first comparison published |

Where it stands (2026-11-14): Phase 0 merged. Phase 1 done (Section 7.6; the first treatment was picked in Section 13). Phase 2 built in code (12.1), including the Notion writer and the A/A check protocol (12.2); it is done once Riley has applied the second SQL file, added the report workflow and run the A/A check to a pass. Phases 3 and 4 not started.

### 12.1 What is built (2026-11-13)

| Piece | Where | Notes |
|---|---|---|
| Tables `pds.experiments`, `pds.experiment_secrets`, `pds.experiment_schedule`, `pds.experiment_days`, view `pds.experiment_day_status` | `sql/experiment_framework_schema.sql` (applied) | Service role only: RLS on, no policies, nothing granted to anon / authenticated; the service role cannot remove rows. All empty. |
| Protocol lock | trigger `experiments_guard` | Once registered, only the status (forward only), the stop fields and the Notion page id can change. The seed and the schedule never change. One active trial at a time (unique index). |
| Registration in one transaction | `pds.experiment_register(id, fields, schedule)` | Protocol fields + every schedule row + the lock; a failure leaves the draft untouched. Refuses a first day that is not in the future, an unbalanced block, a seed that does not match its commitment. |
| Reveal | `pds.experiment_today()` | Returns the arm of `pds.behavioral_today_now()` and nothing later. Stamps `first_revealed_at` once per day and moves `registered` to `running` on the first reveal. |
| Allocation | `experiment_design.py` | Section 4.3 with one change: the block orderings are drawn from PCG64's **raw 64-bit stream** with rejection sampling, not `Generator.integers`, because numpy guarantees only the raw stream across versions. A golden schedule in the tests pins it. |
| End-of-trial analysis | `experiment_analysis.py` | Section 8: model with the carryover term, randomization test, interval by inversion, HAC cross-check, ln(HRV) and per-protocol sensitivity, missingness check, decision rule. `analyze_trial` raises before the pre-registered end. Since 2026-11-16 the tests allow for carryover (Section 8.1) and the decision is withheld until the calibration report (`experiment_calibration.py`, Section 8.2) and an independent review are recorded. |
| Protocol file | `docs/experiments/TEMPLATE.md`, `experiment_design.validate_protocol` | Machine-read YAML front matter. Rules: MID of 8 ms or more, first day after the registration day, alignment version equal to `hrv_alignment.ALIGNMENT_VERSION`, seed commitment equal to the stored one, `stopping.interim: none`; since 2026-11-16 (Section 8.1) `analysis.inference_method` equal to `experiment_analysis.INFERENCE_METHOD`, `analysis.carryover_nights: 1`, a `model_justification` for a treatment trial, and an alpha with room above the nuisance level. The register step also refuses a treatment trial until `METHOD_REVIEW` covers its alpha, re-draw count and block design. |
| Admin command | `experiment_admin.py`, run through `.github/workflows/experiment-admin.yml` (manual, master only) | `seed`, `register`, `verify`, `stop`, `status`, `power`. Never prints a seed or an arm (the logs are public). Heartbeat `experiments|admin` on every write. |
| Today card | `GET /api/experiments/today` (owner session only), `frontend/src/lib/experiments*.ts`, `TodayClient.tsx` | Nothing is rendered when no trial is registered. Read-only: no buttons, and opening Today records nothing about what Riley did. |
| Check-in question (2026-11-14) | `frontend/src/app/check-in/ExperimentAdherence.tsx`, `GET` / `POST /api/experiments/adherence` (owner session only), `pds.experiment_adherence_day()` / `pds.experiment_record_adherence()` in `sql/experiment_adherence_reports_schema.sql` (**not applied yet**) | Section 4.5: "Followed today's arm?" Yes / Partly / No + a note, saved on tap into `pds.experiment_days`, never `pds.habit_journal`. Today, or yesterday when answered the next morning; only for a running trial and only for a day whose arm Today has already shown, so the check-in can never reveal an arm (it never calls the reveal function). Renders nothing with no trial. |
| Adherence per day (2026-11-14) | `experiment_adherence.py` | The objective check decides when the protocol names one and the source has settled (Screen Time pre-bed minutes count only once synced after the day ended and at least an hour after sleep onset, the `bedtimeReady` rule; `pds.experiment_day_status` does not apply it); the check-in answer is the fallback and a counted cross-check; "partly" is not adherent; a day with neither is unknown, never guessed. |
| Daily report job (2026-11-14) | `experiment_report.py`, table `pds.experiment_reports` (same SQL file), heartbeat `experiments\|report`, `/status` card "Experiments" | Section 10: with no trial a no-op with a success heartbeat. While a trial runs, progress counts only (it asks which nights HAVE an outcome and loads no HRV value). From the planned end + 2 days (up to + 4 waiting for the last night's HRV) the final report, once: Section 8 analysis plus `hrv_lag1` / `hrv_7d_mean` covariate fits, Eight Sleep and resting-HR secondary fits, whole-block exclusions for flight, transition and pauses declared before the block, the seed reveal; then the trial is marked complete. The table guard refuses an effect field in a progress row and a final row dated on or before the last day. `GUARD experiment_alignment:` / `GUARD experiment_schedule:` fail the run. The scheduled workflow (`experiment-report.yml`, daily 15:00 UTC) is added by Riley (`.github/` is protected for agents). |
| Notion writer (2026-11-14) | `experiment_notion.py`, `experiment_report.Mirror` | Section 10. One page per experiment in "Onyx Experiments": created on the first run after registration (Status Registered, protocol fields, a link to the protocol at its commit), progress counts as properties while running (the progress writer has no way to send an effect field), and from the final report the effect fields plus the "Report (auto)" toggle section (replaced, never appended; Riley's own blocks stay). Found by `pds.experiments.notion_page_id`, else by title; two pages for one id are refused. The Supabase row is always written first; a failed or unconfigured mirror (no `NOTION_API_KEY`) turns the heartbeat `partial`, and a final report whose mirror failed is retried from the stored payload (`notion_synced_at` empty), never re-analysed. Never called when no trial is registered, never in `--dry-run`. |
| A/A check (2026-11-14) | protocol field `kind: aa` (`experiment_design.validate_protocol`), `docs/experiments/EXP-900.md`, `aa_check` in the final report | Section 12.2. Defined, not seeded or registered. |
| Tests | `tests/test_experiment_framework.py`, `tests/test_experiment_calibration.py`, `tests/test_experiment_report.py`, `tests/test_experiment_notion.py`, `frontend/tests/experiments.test.cjs`, `frontend/tests/checkin-client.test.cjs`, `tests/today-regression.cjs` | Synthetic only. The database guards of the first schema file were also exercised once on the live project inside a single block that always rolls back (nothing was stored). |

How Riley starts a trial (nothing below has been run):

0. Prerequisite for a treatment trial: the PR that records a review-ready calibration report (Section 8.2) in `experiment_analysis.METHOD_REVIEW`, covering the trial's alpha, re-draw count and block design, for the inference code that is running, with the scheduled-suite run that passed its proofs (the independent statistical review is already recorded, Section 8.3). A later change to the inference code needs both halves recorded again. Until it is merged the register step refuses a treatment trial (Section 8.1). The A/A check EXP-900 (Section 12.2) may register first.
1. Copy `docs/experiments/TEMPLATE.md` to `docs/experiments/EXP-001.md` and fill it in. Optional: `gh workflow run experiment-admin.yml -f action=power -f window=120` to re-check the length (Section 7.6).
2. `gh workflow run experiment-admin.yml -f action=seed -f protocol=docs/experiments/EXP-001.md`. The run log prints `seed_sha256`; paste it into the protocol's `allocation.seed_sha256`.
3. Merge the protocol to `master` through a PR, at least one day before its `start` date.
4. `gh workflow run experiment-admin.yml -f action=register -f protocol=docs/experiments/EXP-001.md -f confirm=EXP-001`. From the first day, `/today` shows that day's arm.

Before step 1, once: apply `sql/experiment_adherence_reports_schema.sql` (the check-in functions and the report table; `register` refuses without it), then merge the "[Riley merge] Experiment report schedule" PR, which adds `.github/workflows/experiment-report.yml` (daily 15:00 UTC, with `NOTION_API_KEY` for the mirror) and its `tools/watchdog_cloud.py` line. The first trial to register is the A/A check EXP-900 (Section 12.2), not EXP-001. An optional protocol field `adherence.min_pct` (a number above 0, at most 100) turns the report heartbeat `partial` when adherence falls under it.

Built on 2026-11-14: (a) the "Followed today's arm?" question on `/check-in`; (b) the daily report job with `pds.experiment_reports`, the `experiments|report` heartbeat, the `/status` card and the two `GUARD` checks of Section 10.4; (c) the Notion writer for "Onyx Experiments"; (d) exclusions from flight / transition days and declared pauses wired into the final report; (f) the 4-week A/A check, as a protocol and a verdict in the report (Section 12.2; running it is Riley's step). Left for the next PRs: a way to declare a pause ahead from the app (the report already honours `excluded` rows declared before their block); (e) interim looks and the period design, only if a protocol needs them.

### 12.2 The A/A check

An A/A protocol checks allocation, concealment, reporting and adherence plumbing without an active treatment difference. It does not validate clinical efficacy or guarantee power. Preserve private run status and results outside the public repository.

The verdict (`aa_check` in the final report) reads Fisher's no-effect p and passes only when that test is also supported for the run (`phase2_done.inference_supported`; the failed checks' reasons are in `unsupported_reasons` and on the Notion page). With identical arms, missing nights can be tied to the arm only by a pipeline fault, so the A/A check judges them with Fisher's exact test of the missing nights at the trial's alpha rather than the 10-point rule (Section 8.1).

## 13. Decisions (Riley, 2026-11-11)

1. **Trial duration:** choose a feasible duration before registration using private calibration and sensitivity analysis. The registered plan controls the end date; do not treat a draft duration as evidence of sufficient power.
2. **Wear the WHOOP every night during a trial.** Missed nights add about 50 days (about 184 days at 5% missing instead of 232 at 18.9%, Section 1).
3. **First treatment: phone off in the last hour before bed.** Adherence is verified from Screen Time (`pds.phone_usage_daily.minutes_last_hour_before_sleep_est`, Section 9). Planning input from the observational layer, retrain run 43142943594 (2026-11-12 02:51 UTC), AIPW treatment `journal_viewed_a_screen_device_in_bed` (screen in bed, yes vs no): **AIPW +13.2 ms** (influence-function 95% CI -14.7 to +41.1, block-bootstrap CI -27.0 to +56.5, raw p 0.50, not FDR-significant, 185 treated vs 69 control days), against naive +3.0 ms and PSM +5.9 ms. Positive means higher HRV on nights with a screen in bed, so the sign is the opposite of the trial hypothesis and the interval is wider than the effect. It is a reason to test the treatment, not an estimate of it. The same run flagged 23 of 121 causal rows implausible; this one was not flagged.
4. **Notion database: created now.** "Onyx Experiments" exists under Project Onyx with the fields in Section 10.1 and no rows (URL and ids in Section 10.1). Rows appear when the first protocol is registered.
5. **Daily arm card: `/today` only.** No `/agents` morning card (Section 4.4).

Still open: the check-in adherence question, the report job and the protocol file for EXP-001 (Section 12.1). None of these decisions changes the design in Sections 4 to 11.

**Duration decision.** Before registration, choose a feasible duration using private baseline sensitivity analysis. A short trial may be unable to distinguish a meaningful effect from noise; document that tradeoff before allocation.

## 14. What this doc does not prove

- Power calculations depend on the assumed noise, carryover and missingness process. Examine drift and clustered missingness privately and through synthetic sensitivity simulations.
- The 3 / 5 / 8 ms effect sizes are planning values, not estimates of any real treatment. The alcohol difference quoted is unadjusted and rests on 6 nights.
- Agreement between sensors alone does not identify a physiological cause. Avoid causal or medical interpretations of observational aggregate changes.
- Built but not proven in production (2026-11-13): no trial has been registered, so `experiment-admin.yml` has never run, the `/today` card has only been tested against synthetic answers, and `pds.experiment_today()` has returned an arm only inside a rolled-back test block. The Notion writer does not exist yet.
- Built but not proven (2026-11-14): `sql/experiment_adherence_reports_schema.sql` has not been applied, so the check-in question and the report table have never touched a database; `experiment_report.py` has run only against an in-memory store, and the report workflow does not exist until Riley adds it.
- Built but not proven (2026-11-14, Notion writer and A/A check): `experiment_notion.py` has only written to an in-memory Notion; that the integration behind `NOTION_API_KEY` can write to "Onyx Experiments" is shown only by the first real write (a 403 / 404 says so in the heartbeat). EXP-900 is defined, not seeded or registered, so no A/A result exists. Its tests were written but not run before merge (AGENTS.md "Read this first").
- Built but not proven (2026-11-16, inference under carryover): the Berger-Boos tests, the certified interval, the calibration harness and the fingerprint binding (Section 8.1 to 8.3) were written, not run. The independent statistical review is recorded for the current inference code (Section 8.3); the calibration report is still to come, and until it is recorded in `METHOD_REVIEW` for a trial's configuration and the same inference fingerprint every final report withholds its decision and the register step refuses a treatment trial.

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

Generate synthetic outcomes with explicit variance, autocorrelation, seasonality and carryover assumptions. Apply the registered allocation and estimator across repeated simulations. Vary assumptions and report type-I error and power. Personal calibration and its output belong in private evidence; they must not be embedded in this public method description.
