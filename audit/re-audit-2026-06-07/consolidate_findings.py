"""Consolidate the 15 re-audit-2026-06-07 response JSONs into a structured
digest for triage. Writes UTF-8 files (no stdout printing of unicode, so the
Windows cp1252 console can't choke). Outputs:
  _consolidated_findings.json  — full machine-readable findings list
  _findings_digest.md          — compact human-readable digest for classification
"""
import json
import glob
import os
from collections import defaultdict, Counter

HERE = os.path.dirname(os.path.abspath(__file__))
RESP_DIR = os.path.join(HERE, "..", "responses")
COMMIT = "2f70ba1"
BUNDLES = ["units", "stats", "schema", "tz", "etl"]
REV_ORDER = {"gpt-5": 0, "gemini-2.5-pro": 1, "deepseek-v4-pro": 2}

records = []  # one per finding
meta = defaultdict(dict)  # (bundle, reviewer) -> {scores, summary, things_done_well, questions}

for path in glob.glob(os.path.join(RESP_DIR, f"*-{COMMIT}-*.json")):
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)
    reviewer = doc.get("reviewer", "?")
    bundle = doc.get("bundle") or os.path.basename(path).split("-")[0]
    resp = doc.get("response", {})
    ds = resp.get("domain_scores", {})
    scores = {k: (v.get("score") if isinstance(v, dict) else v) for k, v in ds.items()}
    meta[(bundle, reviewer)] = {
        "scores": scores,
        "summary": resp.get("summary", ""),
        "things_done_well": resp.get("things_done_well", []),
        "questions": resp.get("questions_for_followup", []),
        "fname": os.path.basename(path),
    }
    for fd in resp.get("findings", []):
        records.append({
            "bundle": bundle,
            "reviewer": reviewer,
            "id": fd.get("id", "?"),
            "title": fd.get("title", ""),
            "severity": fd.get("severity", "?"),
            "effort": fd.get("effort", "?"),
            "dimensions": fd.get("dimensions", []),
            "file_ref": fd.get("file_ref", ""),
            "description": fd.get("description", ""),
            "evidence": fd.get("evidence", ""),
            "recommendation": fd.get("recommendation", ""),
        })

# Write full JSON
with open(os.path.join(HERE, "_consolidated_findings.json"), "w", encoding="utf-8") as f:
    json.dump({"meta": {f"{b}|{r}": m for (b, r), m in meta.items()}, "findings": records},
              f, indent=2, ensure_ascii=False)

# Build digest
def sev_key(s):
    return {"P0": 0, "P1": 1, "P2": 2, "P3": 3}.get(s, 9)

lines = []
def w(s=""):
    lines.append(s)

# Counts
by_bundle = Counter(r["bundle"] for r in records)
by_bundle_rev = Counter((r["bundle"], r["reviewer"]) for r in records)
by_sev = Counter(r["severity"] for r in records)
w(f"# Re-Audit 2026-06-07 — Consolidated Findings Digest (commit {COMMIT})")
w()
w(f"Total findings: {len(records)}")
w(f"By severity: " + ", ".join(f"{s}={by_sev[s]}" for s in ['P0','P1','P2','P3'] if by_sev[s]))
w()
w("## Counts per bundle x reviewer")
w()
w("| bundle | gpt-5 | gemini-2.5-pro | deepseek-v4-pro | total |")
w("|---|---|---|---|---|")
for b in BUNDLES:
    g = by_bundle_rev.get((b, "gpt-5"), 0)
    gm = by_bundle_rev.get((b, "gemini-2.5-pro"), 0)
    d = by_bundle_rev.get((b, "deepseek-v4-pro"), 0)
    w(f"| {b} | {g} | {gm} | {d} | {by_bundle[b]} |")
w()
w("## Domain scores (per reviewer)")
w()
for b in BUNDLES:
    w(f"### {b}")
    for r in sorted([rv for (bb, rv) in meta if bb == b], key=lambda x: REV_ORDER.get(x, 9)):
        m = meta[(b, r)]
        sc = m["scores"]
        w(f"- **{r}**: " + ", ".join(f"{k}={v}" for k, v in sc.items()))
    w()

# Full findings, grouped by bundle then severity
w("## Findings (grouped by bundle, sorted by severity)")
w()
for b in BUNDLES:
    w(f"---")
    w(f"## BUNDLE: {b}")
    w()
    recs = sorted([r for r in records if r["bundle"] == b],
                  key=lambda r: (sev_key(r["severity"]), REV_ORDER.get(r["reviewer"], 9), r["id"]))
    for r in recs:
        dims = ",".join(r["dimensions"]) if r["dimensions"] else ""
        w(f"### [{b}/{r['reviewer']}/{r['id']}] {r['severity']} ({r['effort']}) — {r['title']}")
        w(f"- file_ref: `{r['file_ref']}`  | dimensions: {dims}")
        w(f"- desc: {r['description']}")
        if r["evidence"]:
            w(f"- evidence: {r['evidence']}")
        w(f"- rec: {r['recommendation']}")
        w()

with open(os.path.join(HERE, "_findings_digest.md"), "w", encoding="utf-8") as f:
    f.write("\n".join(lines))

# ascii-safe stdout summary
print(f"parsed {len(records)} findings from {len(meta)} response files")
print("by bundle:", dict(by_bundle))
print("by severity:", {s: by_sev[s] for s in ['P0', 'P1', 'P2', 'P3'] if by_sev[s]})
print("wrote _consolidated_findings.json and _findings_digest.md")
