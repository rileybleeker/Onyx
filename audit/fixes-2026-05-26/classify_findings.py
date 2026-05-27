"""
Classify each re-audit finding per the playbook:
  same-as-before  : reviewer flags a finding in an area we shipped a fix for, same/equivalent issue
  new-in-touched  : reviewer flags a NEW bug in code we touched
  new-in-untouched: reviewer flags an issue in code we didn't touch (deferred or genuinely new)
  good            : positive feedback / "things done well" entry that snuck into findings
  disputed        : reviewer's claim contradicts a verification we did (needs human verify)

Each entry has (bundle, reviewer, id) -> (classification, note).
Note cross-references the fix group / deviation / edge-case record where applicable.
"""

CLASSIFY = {
    # --------- ETL bundle ---------
    ("etl","deepseek-v4-pro","F-001"): ("new-in-untouched", "Eight Sleep ETL not touched in fix scope"),
    ("etl","deepseek-v4-pro","F-002"): ("new-in-touched",   "garmin_etl.py touched in P0b (today=ET); per-function guards are new defense-in-depth"),
    ("etl","deepseek-v4-pro","F-003"): ("new-in-untouched", "spotify_etl.py F2 fix was multi-artist, not auth"),
    ("etl","deepseek-v4-pro","F-004"): ("new-in-untouched", ""),
    ("etl","deepseek-v4-pro","F-005"): ("new-in-touched",   "mfp_email touched in F1 for heartbeat, not ordering"),
    ("etl","deepseek-v4-pro","F-006"): ("new-in-untouched", ""),
    ("etl","deepseek-v4-pro","F-007"): ("new-in-untouched", ""),
    ("etl","deepseek-v4-pro","F-008"): ("good",             "positive callout, not a bug"),

    ("etl","gemini-2.5-pro","F-001"): ("disputed",         "Group F5 verified ON CONFLICT matches; 2/3 reviewers disagree => needs DB-side verification"),
    ("etl","gemini-2.5-pro","F-002"): ("new-in-touched",   "garmin_etl.py touched in P0b; this is a different bug in sync_date exception handling"),
    ("etl","gemini-2.5-pro","F-003"): ("new-in-touched",   "F1 added no-op heartbeats but didn't standardize sync_end"),
    ("etl","gemini-2.5-pro","F-004"): ("new-in-touched",   "F2 changed multi-artist logic but didn't add error handling"),
    ("etl","gemini-2.5-pro","F-005"): ("new-in-touched",   "Email scripts touched in F1"),

    ("etl","gpt-5","F-001"): ("disputed",                  "CLAUDE.md says JSONB double-encoding was audit-fixed at 25+ sites; gpt-5 still sees it at whoop_etl.py:222 => needs file verification"),
    ("etl","gpt-5","F-002"): ("new-in-untouched",          "WHOOP pagination param naming"),
    ("etl","gpt-5","F-003"): ("disputed",                  "Same dispute as gemini-etl-F-001 (Garmin ON CONFLICT keys include ts)"),
    ("etl","gpt-5","F-004"): ("new-in-untouched",          ""),
    ("etl","gpt-5","F-005"): ("new-in-untouched",          ""),
    ("etl","gpt-5","F-006"): ("new-in-touched",            "Same area as gemini-etl-F-003 (sync_log fields)"),
    ("etl","gpt-5","F-007"): ("new-in-touched",            "myfitnesspal_email.py touched in F1"),
    ("etl","gpt-5","F-008"): ("new-in-untouched",          ""),
    ("etl","gpt-5","F-009"): ("new-in-touched",            "spotify_etl.py touched in F2"),
    ("etl","gpt-5","F-010"): ("new-in-untouched",          "bundle-assembly meta finding"),
    ("etl","gpt-5","F-011"): ("new-in-untouched",          ""),

    # --------- Schema bundle ---------
    ("schema","deepseek-v4-pro","F-001"): ("new-in-untouched", "RLS not in fix scope"),
    ("schema","deepseek-v4-pro","F-002"): ("new-in-untouched", "habit_journal FK not in fix scope"),
    ("schema","deepseek-v4-pro","F-003"): ("new-in-touched",   "hrv_predictions touched in G1 PK fix; this FK is additional"),
    ("schema","deepseek-v4-pro","F-004"): ("new-in-untouched", ""),
    ("schema","deepseek-v4-pro","F-005"): ("new-in-untouched", ""),
    ("schema","deepseek-v4-pro","F-006"): ("new-in-touched",   "matrix view touched in G3; this is refactor concern"),
    ("schema","deepseek-v4-pro","F-007"): ("new-in-touched",   "hrv_predictions touched in G1; tiebreak index is follow-on"),
    ("schema","deepseek-v4-pro","F-008"): ("new-in-untouched", ""),
    ("schema","deepseek-v4-pro","F-009"): ("new-in-untouched", ""),
    ("schema","deepseek-v4-pro","F-010"): ("same-as-before",   "Legacy view retention is documented deviation D4 (kept for backward-compat)"),
    ("schema","deepseek-v4-pro","F-011"): ("new-in-untouched", ""),

    ("schema","gemini-2.5-pro","F-001"): ("new-in-untouched", "RLS"),
    ("schema","gemini-2.5-pro","F-002"): ("new-in-untouched", "redundant indexes"),
    ("schema","gemini-2.5-pro","F-003"): ("new-in-touched",   "G1 area; same as deepseek-schema-F-007"),
    ("schema","gemini-2.5-pro","F-004"): ("new-in-untouched", "habit_journal FK"),
    ("schema","gemini-2.5-pro","F-005"): ("same-as-before",   "Same as deepseek-schema-F-010 (deviation D4)"),

    ("schema","gpt-5","F-001"): ("new-in-untouched", "RLS"),
    ("schema","gpt-5","F-002"): ("new-in-untouched", "RLS write policies"),
    ("schema","gpt-5","F-003"): ("disputed",         "G1 migration was applied (audit_p1_g1_hrv_predictions_pk_surrogate); gpt-5 sees old PK => bundle SCHEMA_DDL.md may be stale OR migration didn't take, needs DB-side verify"),
    ("schema","gpt-5","F-004"): ("new-in-untouched", ""),
    ("schema","gpt-5","F-005"): ("new-in-touched",   "matrix view G3 area"),
    ("schema","gpt-5","F-006"): ("same-as-before",   "Same as deepseek-schema-F-010 (deviation D4)"),
    ("schema","gpt-5","F-007"): ("new-in-untouched", "redundant indexes"),
    ("schema","gpt-5","F-008"): ("new-in-untouched", ""),
    ("schema","gpt-5","F-009"): ("new-in-untouched", "habit_journal dim"),
    ("schema","gpt-5","F-010"): ("new-in-touched",   "Triggers extensively touched in Group D + H4"),
    ("schema","gpt-5","F-011"): ("new-in-touched",   "G3 area"),
    ("schema","gpt-5","F-012"): ("new-in-untouched", ""),

    # --------- Stats bundle ---------
    ("stats","deepseek-v4-pro","F-001"): ("new-in-touched", "XGBoost PI touched in E2; labeling concern"),
    ("stats","deepseek-v4-pro","F-002"): ("new-in-touched", "E2 area"),
    ("stats","deepseek-v4-pro","F-003"): ("new-in-touched", "causal_inference touched in E1"),
    ("stats","deepseek-v4-pro","F-004"): ("new-in-touched", "Group A area (VIF for OLS only; XGBoost different)"),
    ("stats","deepseek-v4-pro","F-005"): ("new-in-touched", "Same area as F-003"),

    ("stats","gemini-2.5-pro","F-001"): ("new-in-touched", "SARIMAX touched in A2/A3 but non-contiguous data issue is separate"),
    ("stats","gemini-2.5-pro","F-002"): ("new-in-touched", "causal_inference touched in E1; FDR layer is new concern"),
    ("stats","gemini-2.5-pro","F-003"): ("new-in-touched", "A2 fixed full-data forecast; multi-horizon backtest leakage is separate"),
    ("stats","gemini-2.5-pro","F-004"): ("new-in-touched", "causal_inference E1 area"),
    ("stats","gemini-2.5-pro","F-005"): ("same-as-before", "E2 exactly: pred_std_by_horizon computed on full matrix => EC-3 documents this; deferred"),
    ("stats","gemini-2.5-pro","F-006"): ("new-in-touched", "causal_inference E1 area"),
    ("stats","gemini-2.5-pro","F-007"): ("new-in-touched", "causal_inference area (block bootstrap added in shift audit per CLAUDE.md)"),

    ("stats","gpt-5","F-001"): ("new-in-touched", "Same as gemini-stats-F-004"),
    ("stats","gpt-5","F-002"): ("new-in-touched", "hrv_analysis touched in A/E"),
    ("stats","gpt-5","F-003"): ("new-in-touched", "Same as deepseek-stats-F-001/F-002"),
    ("stats","gpt-5","F-004"): ("new-in-touched", "Same family as gemini-stats-F-003"),
    ("stats","gpt-5","F-005"): ("new-in-touched", "Granger touched in variable-coverage audit (uses FDR survivors); per-lag still unadjusted"),
    ("stats","gpt-5","F-006"): ("new-in-touched", "causal_inference E1 area"),
    ("stats","gpt-5","F-007"): ("new-in-touched", "causal_inference E1 area"),

    # --------- TZ bundle ---------
    ("tz","deepseek-v4-pro","F-001"): ("same-as-before", "G3 deviation D4 / EC-2 -- drop GDS from spine UNION shipped; GDS still LEFT-JOINs via watch-local date; deferred"),
    ("tz","deepseek-v4-pro","F-002"): ("new-in-touched", "adr_0001_03 file touched in H4 (different trigger)"),
    ("tz","deepseek-v4-pro","F-003"): ("new-in-untouched", "transition_day_flag not in fix scope"),
    ("tz","deepseek-v4-pro","F-004"): ("new-in-touched", "adr_0001_04 touched in P0a + Group D"),
    ("tz","deepseek-v4-pro","F-005"): ("new-in-untouched", "whoop_tz_backfill.py not in fix scope"),

    ("tz","gemini-2.5-pro","F-001"): ("new-in-untouched", "backfill scripts not in fix scope"),
    ("tz","gemini-2.5-pro","F-002"): ("new-in-untouched", "tz_log_gaps view not in fix scope"),
    ("tz","gemini-2.5-pro","F-003"): ("new-in-untouched", "whoop_tz_backfill"),
    ("tz","gemini-2.5-pro","F-004"): ("new-in-touched", "P0a fix uses LIMIT 1 by start_time; reviewer says longest-cycle is better. Forward-defense"),

    ("tz","gpt-5","F-001"): ("new-in-untouched", "whoop_tz_backfill.py crash -- not in fix scope but P1 severity"),
    ("tz","gpt-5","F-002"): ("new-in-touched", "Same as gemini-tz-F-004"),
    ("tz","gpt-5","F-003"): ("new-in-touched", "adr_0001_03 touched in H4 (different trigger)"),
    ("tz","gpt-5","F-004"): ("new-in-touched", "Critique of D1 cycle_offset_for_instant"),
    ("tz","gpt-5","F-005"): ("new-in-touched", "Index for D1 helper"),
    ("tz","gpt-5","F-006"): ("new-in-untouched", "gps_tz_backfill"),
    ("tz","gpt-5","F-007"): ("new-in-touched", "D3 tagging refinement"),
    ("tz","gpt-5","F-008"): ("new-in-touched", "adr_0001_03 area (H4)"),
    ("tz","gpt-5","F-009"): ("new-in-touched", "G3 area"),
    ("tz","gpt-5","F-010"): ("new-in-untouched", "tz_log_gaps"),

    # --------- Units bundle ---------
    ("units","deepseek-v4-pro","F-001"): ("same-as-before", "F3/F4 + Deviation D5 + EC-4: IU/oz/mL/scoops explicitly deferred; surfaced via supplement_intake_unmapped view"),
    ("units","deepseek-v4-pro","F-002"): ("new-in-untouched", "getWhoopCaloriesBurnt not touched"),
    ("units","deepseek-v4-pro","F-003"): ("new-in-untouched", "getDailySummaries not touched"),
    ("units","deepseek-v4-pro","F-004"): ("disputed", "Speculative -- view explicitly stores HRV per-source (whoop_hrv_rmssd_ms vs garmin_hrv_last_night_avg_ms etc per CLAUDE.md and G4 rename); needs view inspection to confirm"),
    ("units","deepseek-v4-pro","F-005"): ("new-in-untouched", ""),
    ("units","deepseek-v4-pro","F-006"): ("new-in-untouched", "format.ts magic numbers"),
    ("units","deepseek-v4-pro","F-007"): ("same-as-before", "Same area as F-001; regex behavior not addressed in F3/F4 fix"),

    ("units","gemini-2.5-pro","F-001"): ("same-as-before", "Same as deepseek-units-F-001"),
    ("units","gemini-2.5-pro","F-002"): ("new-in-touched", "queries.ts touched in G4+H1; getWorkoutSleepGap is a different function"),
    ("units","gemini-2.5-pro","F-003"): ("new-in-touched", "queries.ts area"),
    ("units","gemini-2.5-pro","F-004"): ("new-in-untouched", "format.ts not in fix scope"),
    ("units","gemini-2.5-pro","F-005"): ("new-in-touched", "queries.ts area"),
    ("units","gemini-2.5-pro","F-006"): ("new-in-untouched", "format.ts"),

    ("units","gpt-5","F-001"): ("same-as-before", "Same as deepseek/gemini F-001"),
    ("units","gpt-5","F-002"): ("new-in-untouched", "Same as deepseek-units-F-002"),
    ("units","gpt-5","F-003"): ("new-in-untouched", "Same as gemini-units-F-006"),
    ("units","gpt-5","F-004"): ("new-in-untouched", "Same as deepseek-units-F-006"),
}


def main():
    import json, os, sys
    findings = json.load(open("/tmp/audit_parse/findings.json"))
    for f in findings:
        key = (f['bundle'], f['reviewer'], f['id'])
        cls, note = CLASSIFY.get(key, ('UNCLASSIFIED', '*** missing from CLASSIFY ***'))
        f['classification'] = cls
        f['note'] = note
    with open("/tmp/audit_parse/findings_classified.json", "w", encoding="utf-8") as out:
        json.dump(findings, out, indent=2)

    from collections import Counter
    c = Counter(f['classification'] for f in findings)
    print(f"Total findings: {len(findings)}")
    print(f"By classification: {dict(c)}")
    missing = [(f['bundle'],f['reviewer'],f['id']) for f in findings if f['classification']=='UNCLASSIFIED']
    if missing:
        print(f"UNCLASSIFIED: {missing}")
        sys.exit(1)
    print("All findings classified.")


if __name__ == "__main__":
    main()
