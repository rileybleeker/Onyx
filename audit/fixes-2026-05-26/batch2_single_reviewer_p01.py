"""Filter classified findings to the single-reviewer P0/P1 batch (Batch 2).

Excludes corroborated topics already covered by Batch 1 tickets.
Excludes disputed (all FP). Excludes same-as-before (deferred per DEVIATIONS).
Excludes "good" (positive feedback).
"""
import json

findings = json.load(open("/tmp/audit_parse/findings_classified.json"))

# Topic IDs already covered by Batch 1 (cross-reviewer corroborated)
BATCH1_COVERED = {
    # RLS public vs service_role
    ("schema","deepseek-v4-pro","F-001"),
    ("schema","gemini-2.5-pro","F-001"),
    ("schema","gpt-5","F-001"),
    ("schema","gpt-5","F-002"),
    ("schema","deepseek-v4-pro","F-011"),
    # habit_journal FK
    ("schema","deepseek-v4-pro","F-002"),
    ("schema","gemini-2.5-pro","F-004"),
    # Redundant indexes (P3 but included in Batch 1)
    ("schema","deepseek-v4-pro","F-004"),
    ("schema","deepseek-v4-pro","F-005"),
    ("schema","gemini-2.5-pro","F-002"),
    ("schema","gpt-5","F-007"),
    # Matrix view LATERAL refactor
    ("schema","deepseek-v4-pro","F-006"),
    ("schema","gpt-5","F-005"),
    # hrv_predictions_latest tiebreak index
    ("schema","deepseek-v4-pro","F-007"),
    ("schema","gemini-2.5-pro","F-003"),
    # PI nominal levels
    ("stats","deepseek-v4-pro","F-001"),
    ("stats","deepseek-v4-pro","F-002"),
    ("stats","gpt-5","F-003"),
    # Confounder ffill drops sample
    ("stats","deepseek-v4-pro","F-003"),
    ("stats","deepseek-v4-pro","F-005"),
    ("stats","gemini-2.5-pro","F-006"),
    # Multi-horizon backtest leakage
    ("stats","gemini-2.5-pro","F-003"),
    ("stats","gpt-5","F-004"),
    # AIPW scaler leakage
    ("stats","gemini-2.5-pro","F-004"),
    ("stats","gpt-5","F-001"),
    # garmin_hrv fallback
    ("tz","deepseek-v4-pro","F-002"),
    ("tz","gpt-5","F-003"),
    # whoop_journal picks earliest cycle
    ("tz","gemini-2.5-pro","F-004"),
    ("tz","gpt-5","F-002"),
    # METERS_PER_MILE
    ("units","deepseek-v4-pro","F-006"),
    ("units","gpt-5","F-004"),
    # Falsy formatters
    ("units","gemini-2.5-pro","F-006"),
    ("units","gpt-5","F-003"),
    # Behavioral matrix passthroughs
    ("tz","gpt-5","F-009"),
    ("schema","gpt-5","F-011"),
}

EXCLUDE_CLASSIFICATIONS = {'disputed', 'same-as-before', 'good'}


def main():
    rows = []
    for f in findings:
        key = (f['bundle'], f['reviewer'], f['id'])
        if key in BATCH1_COVERED: continue
        if f['classification'] in EXCLUDE_CLASSIFICATIONS: continue
        if f['severity'] not in ('P0', 'P1'): continue
        rows.append(f)

    rows.sort(key=lambda f: (f['severity'], f['bundle'], f['reviewer'], f['id']))
    print(f"Batch 2 candidates: {len(rows)} P0/P1 single-reviewer findings")
    print()
    for f in rows:
        title = f['title'].encode('ascii','replace').decode()[:90]
        note = f['note'].encode('ascii','replace').decode()[:100]
        rv = f['reviewer'].split('-')[0]
        print(f"[{f['severity']}|{f['bundle']:6s}|{rv:8s}|{f['classification']:18s}|{f['id']}] {title}")
        if note:
            print(f"     note: {note}")


if __name__ == "__main__":
    main()
