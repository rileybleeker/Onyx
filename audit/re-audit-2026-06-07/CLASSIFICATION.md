# Re-Audit 2026-06-07 — Classification & Remediation Plan

Bundle commit `2f70ba1`. 111 findings across 15 response files (5 bundles × 3 reviewers).
Classified per the playbook in `audit/fixes-2026-05-26/README.md`, cross-referenced
against `FIXES_BY_GROUP.md` (groups P0a/P0b, A–H) and verified against **live prod DB**
(`fewweioupmsnbccqtxdl`) + current source.

## Verdict taxonomy

| Verdict | Meaning | Action |
|---|---|---|
| **STALE_DDL** | Reviewer saw the un-regenerated `SCHEMA_DDL.md`; prod is actually correct/migrated | Regenerate DDL doc; no code/DB fix |
| **CONFIRMED→CODE** | Genuine issue, verified; fixable in working tree (no prod DB) | Fix now (no commit) |
| **CONFIRMED→DB** | Genuine issue, verified; needs a prod DB migration | Stage migration SQL; **apply needs approval** |
| **KNOWN** | Matches a documented deviation / design decision | No action (note only) |
| **DEFER** | Legitimate but larger/methodology/low-priority | Notion roadmap |
| **DISPUTED** | Reviewer claim questionable or needs human judgment | Flag for Riley |
| **GOOD** | Positive note / reviewer says "no fix needed" | None |

## Headline

- **The schema bundle is almost entirely a stale-`SCHEMA_DDL.md` artifact.** Live DB verified:
  RLS writes-to-`public` = **NONE** (both "P0" security findings already fixed by the
  2026-06-06 lockdown), habit_journal.question FK **exists**, hrv tiebreak index **exists**,
  4/4 covering indexes **present**, behavioral helper views **present**, redundant mfp/weight
  indexes **already dropped**. → **Action: regenerate `SCHEMA_DDL.md`**, not migrations.
- **Two genuinely-new high-value bugs**: SARIMAX exog future-leak (`bfill` before split) and the
  Greek-μ (`μg` U+03BC) 1,000,000× supplement overstatement — both confirmed in source.
- **TZ cluster**: the WHOOP cycle-anchor ±6h window + nap-vs-main-cycle selection is flagged by
  all three reviewers — a real DB-trigger improvement.
- Most stats findings are **methodology refinements** (block-bootstrap p-values, fold-local σ,
  cyclic day-of-week) → roadmap, not same-day fixes.

---

## Bucket A — STALE_DDL (prod already correct; regenerate SCHEMA_DDL.md)

DB-verified false alarms — **no migration needed**:

| Finding | Claim | DB truth |
|---|---|---|
| schema/gpt-5/F-001 (P0) | pre-lockdown habit writes via authenticated | `rls_write_to_public`=NONE — lockdown applied |
| schema/gemini/F-002 (P0) | RLS service policies target `public` | NONE target public |
| schema/gpt-5/F-004, deepseek/F-002 | service_full_access TO public | NONE |
| schema/gpt-5/F-002, gemini/F-003 | habit_journal.question FK missing | `fk_habit_journal_question` exists |
| schema/gemini/F-001, gpt-5/F-008 | tiebreak index missing | `idx_hrv_predictions_tiebreak` exists |
| schema/gpt-5/F-009 | covering/partial indexes missing | 4/4 present |
| schema/gemini/F-004 | behavioral helper views missing | 2 present |
| schema/gpt-5/F-005, gemini/F-006, deepseek/F-001 | redundant mfp/weight indexes | already dropped (0) |
| etl/gpt-5/F-005 | spotify_artists table missing | exists in prod (bundle schema-file gap only) |

**Action:** regenerate `schema/SCHEMA_DDL.md` from live prod so the next re-audit doesn't re-raise these; add `CREATE TABLE pds.spotify_artists` to the repo schema file for fresh-deploy completeness.

---

## Bucket B — CONFIRMED → CODE fix (working tree, reversible, no commit)

| Finding | Fix | Sev |
|---|---|---|
| units/gpt-5/F-001 ★ | `unit_to_mg_factor`: keep Greek `μ` (U+03BC) + `μg` branch | P1 |
| units/deepseek/F-002 | preserve `/` so `mg/mL` not collapsed to NULL (fold into above) | P2 |
| units/deepseek/F-005 | `getWhoopCaloriesBurnt`: `isNaN(kj)` guard | P2 |
| units/gemini/F-002 | `formatDuration` round-to-minute | P3 |
| units/deepseek/F-006 | warn on duplicate-cycle overwrite | P3 |
| units/gpt-5/F-003 | rename `formatKcal`→`formatKjAsKcal` (optional) | P2 |
| units/deepseek/F-003 | named constant for 18h gap (optional) | P3 |
| stats/gpt-5/F-001 ★ | SARIMAX exog: drop `bfill`, fill within train slice | P0 |
| stats/gemini/F-001 ★ | Granger on `asfreq('D')` (mirror SARIMAX fix) | P1 |
| stats/gpt-5/F-006 | heatmap restricted to BH-FDR survivors | P2 |
| etl/gemini/F-001 ★ | Spotify HWM must not advance past skipped plays | P1 |
| etl/gemini/F-002 ★ | add `synced_at` to ETL upsert payloads (garmin/eightsleep/mfp/whoop) so backfill detector fires | P1 |
| etl/gpt-5/F-001 ★ | `SpotifyClient._request`: stop duplicate GET on success | P2 |
| etl/gpt-5/F-008 ★ | `refresh_materialized_views`: drop `.schema('pds')` | P2 |
| etl/gpt-5/F-009 | Spotify `after_ms = hwm-1` tiebreak | P2 |
| etl/gemini/F-003 | whoop_journal import `export_received_at` guard (match MFP) | P2 |
| etl/gemini/F-004 ★ | journal ETL: upsert successes even if one embed batch fails | P2 |
| etl/gemini/F-007 + deepseek/F-010 ★ | WHOOP body-measurement: key on day / API ts, stop 24 rows/day | P2 |
| etl/deepseek/F-001 ★ | top-level try/except sync_log heartbeat in garmin/eightsleep/spotify/journal | P2 |
| etl/gpt-5/F-007 | cronometer watcher no-op heartbeat | P3 |
| etl/gemini/F-008 | watchers move failed files to `error/` | P3 |
| etl/deepseek/F-002, F-003 | sync_log for garmin standalone + spotify --refresh-genres | P3 |
| etl/deepseek/F-009 | broaden WHOOP email subject match | P3 |
| tz/gpt-5/F-008 | `gps_tz_backfill` normalize RPC return shape | P3 |

★ = high-confidence / high-value (several agreed by ≥2 reviewers).

---

## Bucket C — CONFIRMED → DB migration (stage SQL in repo; **applying to prod needs Riley's OK**)

| Finding(s) | Migration | Sev |
|---|---|---|
| schema/gpt-5/F-003 | add `set_onyx_dates` BEFORE triggers to `cronometer_nutrition_daily` + `cronometer_servings` (verified: 0 triggers) | P1 |
| tz/gemini/F-001, deepseek/F-001, deepseek/F-002, gpt-5/F-003 | `cycle_offset_for_instant`: widen window / prefer longest (main) cycle over naps on transition days | P1 |
| tz/gpt-5/F-002 | `set_onyx_dates_whoop_journal`: pick longest cycle, not earliest, for behaviors_date | P1 |
| tz/gemini/F-002 | garmin_activities trigger: explicit `AT TIME ZONE 'UTC'` before subtraction | P2 |
| tz/gpt-5/F-001 + deepseek/F-007 | normalize `onyx_tz_source` taxonomy (`user_tz_log_et`→`user_tz_log` etc.) or extend ADR enum | P2 |
| schema/gpt-5/F-007 + tz/gpt-5/F-009 | GDS in behavioral spine — **DISPUTED, verify viewdef first** | P2 |
| schema/deepseek/F-003 | FK hrv_model_metrics.input_data_hash (needs parent unique first — likely not addable; lean DEFER) | P3 |

---

## Bucket D — DEFER → Notion roadmap (legitimate, larger / methodology / low-priority)

- **Stats methodology**: block-bootstrap p-values for causal FDR (stats/gpt-5/F-003 + deepseek/F-001), fold-local PI σ (gpt-5/F-002), cyclic/one-hot day-of-week (gpt-5/F-004), PSM bootstrap re-matching + block bootstrap (gemini/F-002, gpt-5/F-005), mediator exclusion for rolling treatments (gemini/F-003), SARIMAX walk-forward param re-estimation (deepseek/F-003), confounder ffill horizon (gpt-5/F-007), DM kernel lag selection (gpt-5/F-008), exog mediator filter (gpt-5/F-009).
- **Schema**: generic trigger refactor (gpt-5/F-010 + deepseek/F-007), legacy `daily_health_matrix` deprecation (gpt-5/F-011, gemini/F-005, deepseek/F-005), explicit service_role policies for portability (gpt-5/F-012, gemini/F-007, deepseek/F-004), partitioning (deepseek/F-006), supplement view materialization (deepseek/F-008), garmin_activity_laps redundant index (gpt-5/F-006).
- **TZ**: centralize fallback labeling (gpt-5/F-005, F-010), date-only same-day-TZ-change edge (deepseek/F-004, gemini/F-005), garmin_hrv noon-ET fallback off-by-one (deepseek/F-003, gpt-5/F-004), whoop_cycles(start_time) index (gpt-5/F-007), cosmetic rounding (deepseek/F-008, F-010), journal_entries backdating check (gemini/F-003), local_date pre/post-midnight (gemini/F-004), COALESCE cleanup (deepseek/F-005), transition-flag cascade (deepseek/F-009).
- **ETL**: shared retry/backoff cluster (gpt-5/F-003, F-006, deepseek/F-007), Eight Sleep TZ persistence (gpt-5/F-002, deepseek/F-006), nested RepeatGroupDTO (gemini/F-005 — note: garmin_workouts not joined to HRV, low value), Notion image URL expiry (gemini/F-006), cronometer import race (deepseek/F-005), MFP email-Date ordering (deepseek/F-008), upsert-count representation (gpt-5/F-010), sync_log_helper consolidation (deepseek/F-004).
- **Units**: branded unit types (gpt-5/F-005), explicit column lists vs select(*) (gpt-5/F-004), query-layer distance_miles (deepseek/F-004).

---

## Bucket E — KNOWN / no action (documented design)

- units/gpt-5/F-002, gemini/F-001, deepseek/F-001 — IU/oz/mL→NULL is deliberate (`supplement_intake_unmapped` is the sanctioned escape hatch; comment in `supplements_unii_cleanup.sql:57-59`).
- units/gpt-5/F-006 (meters<0.5mi), deepseek/F-004 (display-layer distance) — presentation choices.
- stats/deepseek/F-002 (median-split), deepseek/F-004 (Chinn d→RR), gpt-5/F-008 (lag-7) — documented in CLAUDE.md.
- tz/gpt-5/F-006 (generic IANA fallback), deepseek/F-006 (same-offset GPS, reviewer says "no fix needed").
- etl/gpt-5/F-002 + deepseek/F-006 (Eight Sleep static TZ — documented limitation).

## Bucket F — DISPUTED (Riley judgment)

- stats/gemini/F-004 — claims `GAP_DAYS=28` needlessly discards 28 days of training; the gap was a deliberate leakage guard. Plausible reclaim, but contradicts the original rationale — wants a human call.
- etl/gpt-5/F-004 — Garmin `ON CONFLICT (…, ts)`; Group F5 verified conflict targets match the unique indexes. Reviewer's ts-drift concern is hypothetical. Keep as-is unless ts instability is observed.
- schema/gpt-5/F-007 + tz/gpt-5/F-009 — GDS-in-spine: live view references GDS; confirm whether it's the spine UNION (the bug) or a benign LEFT JOIN before acting.
