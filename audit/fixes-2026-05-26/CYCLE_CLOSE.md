# Cycle Close — 2026-05-26 Audit-Fix Cycle

Empirical wrap-up of the audit-fix sprint that began with commit `dd415b3`
and ended with the spotify FK regression hotfix `b54c99f`. Captured here so
the next audit cycle has a playbook + ground-truth baseline.

## Headline

- **45 of 45 tracked tickets shipped** across 46 commits over ~24h
  (overlapping CLI sessions, never more than 2 concurrent).
- Breakdown by audit-tagged priority (re-audit findings + carryover roadmap):
  **5 P0 / 12 P1 / 7 P2 / 4 P3** explicit. Remaining commits closed
  adjacent untagged polish / regression / test-harness items in the same
  scope.
- Starting backlog (after re-audit triage): 47 tracked tickets. 45 shipped,
  2 deferred (below). Re-audit input: 107 findings classified across
  5 bundles × 3 reviewers.

## Fix completion

45/45 shipped. **Deferred (2, both schema design-tax):**

- **`habit_journal.cycle_date` → `entry_date` rename.** Touches every
  consumer of `pds.journal` (the WHOOP+habit UNION view), the trigger,
  and the bidirectional Notion sync. Pure semantic cleanup; current
  schema works. Deferred to a focused PR.
- **`hrv_predictions.input_data_hash` FK to a `hrv_input_snapshots`
  table.** Audit recommended a content-addressable lineage table for
  reproducibility. New table + backfill from existing prediction
  metadata is a meaningful schema add — deferred until either re-run
  reproducibility comes up in practice, or we ship the model-registry
  work that wants the same join.

## Empirical validation

**14 new regression tests added** (all in `tests/test_*.py`, all asserting
the specific failure mode each fix addresses):

| Test | Covers |
|---|---|
| `test_aipw_fold_local_scaler.py` | AIPW StandardScaler fit inside TimeSeriesSplit (no leakage) |
| `test_block_bootstrap_nan_gaps.py` | NaN-aware 7-day block bootstrap on `ψ` with gaps |
| `test_causal_confounder_ffill.py` | Confounder ffill row-drop count is logged |
| `test_causal_fdr.py` | BH-FDR applied to AIPW family at q=0.05 |
| `test_causal_robustness_polish.py` | E-value bound + AIPW IF SE polish |
| `test_eight_sleep_zero_preservation.py` | Trend/interval merge keeps explicit zero values |
| `test_error_mode_feature_date.py` | Error-mode residuals join on `feature_date` not `prediction_date` |
| `test_garmin_future_date_guards.py` | Per-`sync_*` future-date defense (belt + suspenders to `main()`) |
| `test_garmin_sync_date_errors.py` | `garmin_etl.sync_date` propagates per-type errors via `partial` status |
| `test_sarimax_asfreq.py` | SARIMAX fits on contiguous daily `pd.date_range` reindex |
| `test_sarimax_naive_exog.py` | Walk-forward backtest uses naive future-exog proxy (no leakage) |
| `test_spotify_etl_ordering.py` | Tracks + artists upserted **before** plays so FK doesn't fire |
| `test_tz_backfill_in_memory_current_tz.py` | TZ auto-population updates in-memory `current_tz` after each insert |
| `test_whoop_tz_backfill.py` | Regression: `NameError(log_offset_str)` in `whoop_tz_backfill` |

**2 shared helpers extracted** (eliminates ad-hoc duplication across ETLs):

- **`sync_log_helper.log_sync(supa, source, data_type, status, ...)`** —
  single writer for `pds.sync_log`. Always sets `sync_start + sync_end +
  duration_seconds`. Swallows insert failures with a warning so a
  heartbeat write never crashes the ETL.
- **`retry_helper.retry_http(call, *, max_attempts=3, max_wait=30.0,
  base_wait=1.0)`** — exponential backoff + jitter for 5xx + network
  errors; honors `Retry-After` on 429 (seconds form). Non-retryable 4xx
  propagate on the first attempt.

**Production health, last 24h** (`pds.sync_log` rollup per source/data_type):

| Source / data_type | runs | ok | failed | partial | last run (UTC) |
|---|---|---|---|---|---|
| eight_sleep / trends | 1 | 1 | 0 | 0 | 2026-05-27 19:43 |
| garmin / full_sync | 16 | 16 | 0 | 0 | 2026-05-27 23:28 |
| habit_journal / backfill_signal | 63 | 63 | 0 | 0 | 2026-05-27 23:11 |
| hrv_analysis / retrain | 4 | 4 | 0 | 0 | 2026-05-27 14:54 |
| musicbrainz / artist_tags | 8 | 8 | 0 | 0 | 2026-05-27 23:15 |
| myfitnesspal / nutrition | 12 | 12 | 0 | 0 | 2026-05-27 22:48 |
| notion_journal / entries | 13 | 13 | 0 | 0 | 2026-05-27 23:04 |
| reccobeats / audio_features | 8 | 8 | 0 | 0 | 2026-05-27 23:15 |
| **spotify / plays** | **14** | **7** | **6** | **1** | **2026-05-27 23:16** |
| whoop / full_sync | 16 | 16 | 0 | 0 | 2026-05-27 23:28 |
| whoop / journal_email | 13 | 13 | 0 | 0 | 2026-05-27 22:58 |

Every source has a fresh `sync_end` and `sync_start`. The 6 spotify
failures + 1 partial are the Spotify FK regression (next section); recent
runs after `b54c99f` are green.

## What surprised us

- **1 production regression: Spotify FK ordering.** Group C's
  `audit_p1_group_c_fks` migration (commit `855e6cf`) added
  `spotify_plays.track_id → spotify_tracks(track_id)` as `DEFERRABLE
  INITIALLY DEFERRED`. We assumed deferred constraints would let the
  ETL upsert in any order. They don't with `supabase-py`: every
  `.upsert(...).execute()` is its own HTTP round-trip → its own
  transaction → deferred FK is checked at commit on each call, not at
  end-of-script. Result: 6 production ETL runs failed when a new track
  hit `spotify_plays` before `spotify_tracks` was populated. Fixed in
  a separate session by reordering `spotify_etl.run_etl` to upsert
  tracks + artists first, then plays (commit `b54c99f`, plus
  `test_spotify_etl_ordering.py` as guard).
- **2 stale-bundle false positives** during initial re-audit triage —
  bundle copies were assembled from a pre-fix snapshot but labeled with
  the post-fix commit SHA, so two reviewer findings flagged code that
  had already been changed at HEAD (`schema/gpt-5/F-003` re: hrv_predictions PK;
  `etl/gemini/F-001` re: ON CONFLICT). DB-side verification refuted
  both.
- **4-of-5 disputed findings confirmed FP via DB queries.** Of the 5
  disputed items in `classify_findings.py`, 4 (`etl/gemini/F-001`,
  `etl/gpt-5/F-001`, `etl/gpt-5/F-003`, `schema/gpt-5/F-003`) resolved
  to false-positives after querying live state. The 1 remaining
  (`units/deepseek/F-004`) is still pending a view-definition check.
- **107-finding triage decomposed cleanly:** 9 same-as-before
  (acknowledged deviations), 5 disputed (4 confirmed FP), 47
  new-in-touched (legitimate adjacent bugs surfaced by the fix scope),
  45 new-in-untouched (deferred or out-of-scope), 1 positive callout.
  The "new-in-touched" volume is high because the audit fixes
  intentionally rewrote large surfaces (TZ trigger cluster, ETL
  hygiene); reviewers found polish items in the rewritten code.

## Process lessons (for next cycle)

- **Bundle staleness:** assemble the re-audit bundle from current HEAD
  via a script, not by hand. Build `audit/assemble_bundle.py` that
  reads file lists per topic (units/stats/schema/tz/etl), checks out
  the named commit, snapshots the files, and stamps the bundle with
  the actual HEAD SHA + a manifest. Hand-assembly cost us 2 reviewer
  cycles on stale code.
- **Memory scope gotcha:** project-scoped memories live in
  `~/.claude/projects/<dir-hash>/memory/` and only load when the CLI
  session is launched FROM that project directory. The Spotify FK
  hotfix session was launched from `~` and missed the project's
  cycle-close convention until we re-rooted. Mitigation: either
  always launch from project dir, OR include explicit memory-file
  paths in handoff prompts to other CLI sessions.
- **Parallel sessions:** 2 was the sweet spot. The brief 3-session
  experiment had diminishing returns + coordination tax (file conflicts
  on shared `sql/` and `hrv_analysis.py`). File-disjoint scopes are
  mandatory; topic-disjoint isn't enough.
- **Handoff prompts must include verification steps before destructive
  actions.** The Spotify hotfix handoff initially read "production down
  ~6 runs, just fix it" — the receiving session needed a way to
  independently verify the regression cause before reordering ETL.
  Updated handoff template: always include a `SELECT ... FROM
  pds.sync_log` query (or equivalent) the new session can run to
  confirm the problem state before changing code.

## Next-cycle readiness

The re-audit playbook is now mature: `audit/fixes-2026-05-26/README.md`
("How to use this when the re-audit returns") + `classify_findings.py`
(per-finding triage table) + `build_summary.py` (rollup) +
`batch2_single_reviewer_p01.py` / `batch3_p23_polish.py` (priority
filters). Future audit cycles should compress significantly — the
expensive parts (triage taxonomy, bundle structure, reviewer prompts)
are reusable as-is. Open items for next cycle: assemble-bundle script,
handoff-prompt verification template, and the 2 deferred design-tax
tickets above.
