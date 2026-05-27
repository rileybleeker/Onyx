"""Filter classified findings to the P2/P3 polish batch (Batch 3).

Excludes everything already covered in Batches 1 and 2, plus disputed/same-as-before/good.
"""
import json

findings = json.load(open("/tmp/audit_parse/findings_classified.json"))

BATCH1_COVERED = {
    ("schema","deepseek-v4-pro","F-001"),
    ("schema","gemini-2.5-pro","F-001"),
    ("schema","gpt-5","F-001"),
    ("schema","gpt-5","F-002"),
    ("schema","deepseek-v4-pro","F-011"),
    ("schema","deepseek-v4-pro","F-002"),
    ("schema","gemini-2.5-pro","F-004"),
    ("schema","deepseek-v4-pro","F-004"),
    ("schema","deepseek-v4-pro","F-005"),
    ("schema","gemini-2.5-pro","F-002"),
    ("schema","gpt-5","F-007"),
    ("schema","deepseek-v4-pro","F-006"),
    ("schema","gpt-5","F-005"),
    ("schema","deepseek-v4-pro","F-007"),
    ("schema","gemini-2.5-pro","F-003"),
    ("stats","deepseek-v4-pro","F-001"),
    ("stats","deepseek-v4-pro","F-002"),
    ("stats","gpt-5","F-003"),
    ("stats","deepseek-v4-pro","F-003"),
    ("stats","deepseek-v4-pro","F-005"),
    ("stats","gemini-2.5-pro","F-006"),
    ("stats","gemini-2.5-pro","F-003"),
    ("stats","gpt-5","F-004"),
    ("stats","gemini-2.5-pro","F-004"),
    ("stats","gpt-5","F-001"),
    ("tz","deepseek-v4-pro","F-002"),
    ("tz","gpt-5","F-003"),
    ("tz","gemini-2.5-pro","F-004"),
    ("tz","gpt-5","F-002"),
    ("units","deepseek-v4-pro","F-006"),
    ("units","gpt-5","F-004"),
    ("units","gemini-2.5-pro","F-006"),
    ("units","gpt-5","F-003"),
    ("tz","gpt-5","F-009"),
    ("schema","gpt-5","F-011"),
}

# Batch 2 single-reviewer P0/P1 already ticketed.
# Note: gpt-5/etl/F-006 (sync_end) was rolled into the Batch 2 sync_log standardization ticket.
BATCH2_COVERED = {
    ("etl","deepseek-v4-pro","F-001"),
    ("etl","gemini-2.5-pro","F-002"),
    ("stats","gemini-2.5-pro","F-001"),
    ("stats","gemini-2.5-pro","F-002"),
    ("tz","gpt-5","F-001"),
    ("etl","deepseek-v4-pro","F-002"),
    ("etl","deepseek-v4-pro","F-003"),
    ("etl","gemini-2.5-pro","F-003"),
    ("etl","gemini-2.5-pro","F-004"),
    ("etl","gpt-5","F-002"),
    ("etl","gpt-5","F-006"),    # rolled into sync_log standardization ticket
    ("etl","gemini-2.5-pro","F-005"),  # also rolled into sync_log standardization
    ("stats","gpt-5","F-002"),
    ("tz","gemini-2.5-pro","F-001"),
    ("units","deepseek-v4-pro","F-003"),
    ("units","deepseek-v4-pro","F-005"),
    ("units","gemini-2.5-pro","F-002"),
}

EXCLUDE_CLASSIFICATIONS = {'disputed', 'same-as-before', 'good'}


def main():
    rows = []
    for f in findings:
        key = (f['bundle'], f['reviewer'], f['id'])
        if key in BATCH1_COVERED: continue
        if key in BATCH2_COVERED: continue
        if f['classification'] in EXCLUDE_CLASSIFICATIONS: continue
        rows.append(f)

    rows.sort(key=lambda f: (f['severity'], f['bundle'], f['reviewer'], f['id']))
    print(f"Batch 3 candidates: {len(rows)} remaining findings")
    print()
    by_sev = {}
    for f in rows:
        by_sev[f['severity']] = by_sev.get(f['severity'], 0) + 1
    print(f"  by severity: {by_sev}")
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
