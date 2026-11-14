---
# Protocol template for an Onyx N-of-1 trial (docs/experiment-framework.md section 6).
# Copy to docs/experiments/EXP-NNN.md, fill it in, run the seed step, paste the printed
# seed_sha256 below, merge to master, then run the register step (AGENTS.md, "Experiments").
# EXP-000 is the template id and can never be registered. Every date here is a placeholder.
id: EXP-000
title: Phone off in the last hour before bed
status: draft
question: Does no phone use in the 60 min before sleep raise same-night HRV?
arms:
  A: No phone in the 60 minutes before you go to sleep.
  B: Usual evening (control). Use your phone as you normally would.
control_arm: B
adherence:
  self_report: check-in "Followed today's arm?"
  objective:                    # checked on days of the named arm only
    source: pds.phone_usage_daily.minutes_last_hour_before_sleep_est
    max: 5                      # minutes
    arm: A
outcome:
  primary: whoop_hrv_rmssd of the sleep that closes the behavioral day (hrv_alignment.outcome_series h=1)
  alignment_version: same_night_v1
  secondary: [eight_sleep_hrv of the same sleep, whoop_rhr, b0 + b1 (two-night total)]
direction: A > B (tested two-sided)
mid_ms: 8                       # minimal important difference; 8 ms or more (section 13, decision 1)
design:
  type: daily_4day_permuted_blocks
  n_blocks: 58
  n_days: 232                   # n_blocks * 4
  washout_days: 0
start: 2099-01-05               # first behavioral day; must be after the registration day
planned_end: 2099-08-24         # start + n_days - 1
power_inputs:                   # Appendix A queries on the registration date; see section 7.6 first
  sigma_ms: 21.4
  rho_lag1: 0.476
  missing_rate: 0.189
allocation:
  generator: numpy PCG64 raw stream, rejection-sampled (experiment_design.py)
  seed_sha256: paste-the-value-printed-by-the-seed-step
analysis:
  model: Y ~ block FE + arm + arm_yesterday + day_of_week, OLS on observed nights
  test: randomization test, re-draws of the block orderings, two-sided
  alpha: 0.05
  n_redraws: 10000
  ci: inversion of the randomization test (HAC Newey-West maxlags=7 as a quick check)
  sensitivity: [ln HRV, per-protocol, plus hrv_lag1 covariate, excluding travel blocks]
exclusions:                     # decided without looking at HRV, applied to whole blocks
  - block contains a flight day (pds.flight_day_unified.flew = 1) or onyx_is_transition_day
  - illness or travel pause declared before the block starts
stopping:
  interim: none                 # analysed only at the pre-registered end (section 13, decision 1)
  safety: Riley may stop any time; recorded as stopped_early
decision:
  adopt_A: p < 0.05 and estimate favours A
  no_meaningful_effect: 95% CI inside (-mid, +mid)
  otherwise: inconclusive
co_interventions_held_steady: [bedtime target, supplement stack, training plan]
device: WHOOP strap worn every night (section 13, decision 2)
---

# EXP-000 (template)

Free text: why this treatment, what a typical A day and B day look like, anything a reader of
the final report should know. Only the block above is read by `experiment_admin.py`.
