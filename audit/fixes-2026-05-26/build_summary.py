"""Build the re-audit summary table from /tmp/audit_parse/findings_classified.json."""
import json, os, sys
from collections import Counter, defaultdict

findings = json.load(open("/tmp/audit_parse/findings_classified.json"))

CLS_ORDER = ['same-as-before', 'disputed', 'new-in-touched', 'new-in-untouched', 'good']
SEV_ORDER = ['P0', 'P1', 'P2', 'P3']
REV_ORDER = ['gpt-5', 'gemini-2.5-pro', 'deepseek-v4-pro']
BUNDLES = ['units', 'stats', 'schema', 'tz', 'etl']


def ascii_safe(s: str) -> str:
    return s.encode('ascii', 'replace').decode()


sep = "=" * 95
thin = "-" * 95
lines: list[str] = []
def w(s=""): lines.append(s)

w(sep)
w(" Onyx Re-Audit -- 2026-05-26 -- Summary at commit 011ccb4")
w(sep)
w()
w(f"Total findings: {len(findings)}  (5 bundles x 3 reviewers = 15 review runs)")
w()

# ─── 1. classification x severity ───
w(thin)
w("1. By classification x severity")
w(thin)
w(f"  {'classification':22s}  P0   P1   P2   P3  total")
matrix = defaultdict(lambda: defaultdict(int))
for f in findings:
    matrix[f['classification']][f['severity']] += 1
for cls in CLS_ORDER:
    if cls not in matrix: continue
    row = matrix[cls]
    cells = "  ".join(f"{row.get(s,0):>3d}" for s in SEV_ORDER)
    w(f"  {cls:22s}  {cells}  {sum(row.values()):>4d}")
total_by_sev = Counter(f['severity'] for f in findings)
cells = "  ".join(f"{total_by_sev.get(s,0):>3d}" for s in SEV_ORDER)
w(f"  {'TOTAL':22s}  {cells}  {sum(total_by_sev.values()):>4d}")
w()

# ─── 2. bundle x reviewer count ───
w(thin)
w("2. Findings per bundle per reviewer")
w(thin)
w(f"  {'bundle':10s}  gpt-5    gemini   deepseek   total")
m = defaultdict(lambda: defaultdict(int))
for f in findings:
    m[f['bundle']][f['reviewer']] += 1
for bundle in BUNDLES:
    r = m[bundle]
    cells = "    ".join(f"{r.get(rv,0):>3d}" for rv in REV_ORDER)
    w(f"  {bundle:10s}  {cells}      {sum(r.values()):>3d}")
w()

# ─── 3. bundle x classification (H/T) ───
w(thin)
w("3. Per-bundle classification breakdown (P0+P1 count / total count)")
w(thin)
w(f"  {'bundle':10s}  {'same':>10s}  {'disputed':>10s}  {'newTouched':>12s}  {'newUntouch':>12s}  {'good':>6s}")
cnt = defaultdict(lambda: defaultdict(int))
hi = defaultdict(lambda: defaultdict(int))
for f in findings:
    cnt[f['bundle']][f['classification']] += 1
    if f['severity'] in ('P0', 'P1'):
        hi[f['bundle']][f['classification']] += 1
for bundle in BUNDLES:
    cells = []
    for cls in ['same-as-before', 'disputed', 'new-in-touched', 'new-in-untouched', 'good']:
        t = cnt[bundle].get(cls, 0)
        h = hi[bundle].get(cls, 0)
        cells.append('-' if t == 0 else f"{h}/{t}")
    w(f"  {bundle:10s}  {cells[0]:>10s}  {cells[1]:>10s}  {cells[2]:>12s}  {cells[3]:>12s}  {cells[4]:>6s}")
w("  legend: H/T = (P0+P1 count) / (total count)")
w()

# ─── 4. same-as-before details ───
w(thin)
w("4. SAME-AS-BEFORE -- findings in areas we fixed where the issue persists")
w(thin)
for f in findings:
    if f['classification'] != 'same-as-before': continue
    w(f"  [{f['bundle']}/{f['reviewer'].split('-')[0]:8s}/{f['id']}] {f['severity']} {ascii_safe(f['title'])}")
    w(f"     -> {ascii_safe(f['note'])}")
w()

# ─── 5. disputed details ───
w(thin)
w("5. DISPUTED -- reviewer claim contradicts a documented verification")
w(thin)
for f in findings:
    if f['classification'] != 'disputed': continue
    w(f"  [{f['bundle']}/{f['reviewer'].split('-')[0]:8s}/{f['id']}] {f['severity']} {ascii_safe(f['title'])}")
    w(f"     -> {ascii_safe(f['note'])}")
w()

# ─── 6. cross-reviewer corroboration ───
w(thin)
w("6. Cross-reviewer corroboration (issues raised by >=2 reviewers)")
w(thin)
TOPIC_PATTERNS = [
    ('unit_to_mg_factor drops IU / mL / scoops / mg/mL', ['unit_to_mg_factor', 'iu, ml', 'silently drops', 'iu, oz, ml', 'mg/ml', 'non-mass units']),
    ('Garmin upsert on_conflict includes ts', ['on_conflict', 'conflict keys include ts', 'incorrect on_conflict']),
    ('RLS public role vs service_role', ['rls polic', 'public role', 'service_full_access', 'public instead of service_role']),
    ('Redundant indexes on PK columns', ['duplicate index', 'redundant index', 'idx_mfp_nutrition_date', 'idx_weight_log']),
    ('Legacy daily_health_matrix view still exists', ['legacy daily_health_matrix', 'legacy and behavioral matrix', 'legacy view']),
    ('Habit_journal FK to habit_name_map missing', ['habit_journal.question', 'foreign key on habit_journal']),
    ('Matrix view LATERAL+LIMIT-1 pattern repetition', ['lateral', 'helper view', 'matrix view repeats']),
    ('hrv_predictions_latest tiebreak index missing', ['hrv_predictions_latest', 'distinct on sort', 'tiebreak order']),
    ('Future leakage in causal scaler / standardization', ['standardscaler', 'standardization fit on full', 'future-fold info', 'leaks future-fold']),
    ('Inconsistent PI nominal levels across models', ['nominal level', 'ci nominal', 'prediction-interval nominal', 'pi nominal', 'ci_coverage not comparable']),
    ('Multi-horizon backtest uses realized future regressors', ['realized regressor', 'multi-horizon backtest', 'actual future exog', 'realized exog', 'realized regressors']),
    ('whoop_journal trigger picks earliest cycle (vs longest)', ['picks earliest cycle', 'picks the longest', 'order by start_time limit 1', 'whoop cycle selection']),
    ('Falsy formatters render 0 as missing marker', ['falsy', 'render 0', 'zero value', 'displays "?" for exactly zero']),
    ('METERS_PER_MILE magic number duplicated', ['meters-per-mile', '1609', 'magic number']),
    ('Per-source duration normalization (sec vs ms)', ['millisec', 'normalised before display', 'normalized before display', 'off-by-1000']),
    ('FDR correction missing from causal layer', ['fdr correction', 'fdr in the causal']),
    ('garmin_hrv fallback uses watch-local calendar_date', ['garmin_hrv fallback', 'garmin hrv', 'unadjusted calendar_date']),
    ('Behavioral spine vs GDS watch-local mismatch', ['matrix spine mixes', 'spine mixes', 'garmin daily dates', 'unaligned garmin daily']),
    ('Behavioral matrix exposes onyx_* as spine literals', ['onyx_et_date/local', 'onyx_* as calendar_date', 'exposes onyx_']),
    ('Confounder ffill loses sample silently', ['confounder ffill', 'ffill limit', 'silent large sample loss']),
]


def find_topic(f):
    text = (f['title'] + ' ' + f['description']).lower()
    for name, pats in TOPIC_PATTERNS:
        for p in pats:
            if p in text:
                return name
    return None


clusters = defaultdict(list)
for f in findings:
    t = find_topic(f)
    if t:
        clusters[t].append(f)

corroborated_ids = set()
def_order = lambda c: ['same-as-before','disputed','new-in-touched','new-in-untouched','good'].index(c)
for topic in sorted(clusters, key=lambda t: -len(set(x['reviewer'] for x in clusters[t]))):
    reviewers = sorted(set(x['reviewer'] for x in clusters[topic]))
    if len(reviewers) >= 2:
        sev = min((x['severity'] for x in clusters[topic]))
        cls = sorted(set(x['classification'] for x in clusters[topic]), key=def_order)[0]
        rv_short = ', '.join(r.split('-')[0] for r in reviewers)
        w(f"  [{sev} | {cls:16s}] {topic}")
        w(f"      seen by {len(reviewers)}/3 reviewers: {rv_short}")
        for x in clusters[topic]:
            corroborated_ids.add((x['bundle'], x['reviewer'], x['id']))
w()

# ─── 7. full finding list ───
w(thin)
w("7. Full finding list grouped by bundle x reviewer")
w(thin)
for bundle in BUNDLES:
    w(f"\n=== {bundle.upper()} ===")
    for rv in REV_ORDER:
        for f in findings:
            if f['bundle'] != bundle or f['reviewer'] != rv: continue
            title = ascii_safe(f['title'])[:80]
            note = ascii_safe(f['note'])[:100]
            rv_short = rv.split('-')[0]
            corr = ' [seen-by-multiple]' if (f['bundle'], f['reviewer'], f['id']) in corroborated_ids else ''
            w(f"  {f['id']} [{rv_short:8s}|{f['severity']}|{f['classification']:18s}] {title}{corr}")
            if note:
                w(f"       note: {note}")

out = "\n".join(lines)
os.makedirs("/tmp/audit_parse", exist_ok=True)
with open("/tmp/audit_parse/SUMMARY.txt", "w", encoding="utf-8") as fp:
    fp.write(out + "\n")

# Print first chunk to stdout
for line in lines[:140]:
    sys.stdout.write(line + "\n")
print(f"\n... ({len(lines)} lines total; full file at /tmp/audit_parse/SUMMARY.txt)")
