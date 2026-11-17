"""HRV columns are not interchangeable across sources (AGENTS.md).

whoop_recovery.hrv_rmssd_milli (matrix `whoop_hrv_rmssd`), garmin_hrv.
last_night_avg_ms (`garmin_hrv_last_night`) and eight_sleep_trends.avg_hrv
(`eight_sleep_hrv`) are three different algorithms in the same unit. The
pipeline must never average, coalesce, fill or substitute them for one another.

Two guards in hrv_column_guard.py:
  * a static source scan over hrv_analysis.py / hrv_predict.py /
    causal_inference.py that flags any statement combining two or more of the
    three columns with an averaging or coalescing operation;
  * a runtime assertion that the pipeline TARGET is the WHOOP column.

Synthetic snippets only — no real values, no personal data, no network, no
credentials. The scan is pure regex/string work and never imports the scanned
code.

Run: python tests/test_hrv_columns_not_blended.py
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import hrv_column_guard as guard  # noqa: E402
from hrv_column_guard import HRVColumnBlendError  # noqa: E402

import hrv_alignment as al  # noqa: E402
import hrv_analysis as h  # noqa: E402


REPO_ROOT = Path(__file__).resolve().parent.parent


# ---------------------------------------------------------------------------
# Runtime assertion: TARGET is the WHOOP column
# ---------------------------------------------------------------------------

def test_assert_target_accepts_whoop_column():
    guard.assert_target_is_whoop("whoop_hrv_rmssd")  # must not raise


def test_assert_target_rejects_anything_else():
    for bad in ("garmin_hrv_last_night", "eight_sleep_hrv", "hrv_blend"):
        try:
            guard.assert_target_is_whoop(bad, label="fake_target")
        except HRVColumnBlendError as exc:
            assert "WHOOP" in str(exc)
        else:
            raise AssertionError(f"expected HRVColumnBlendError for {bad!r}")


def test_pipeline_target_is_whoop_column():
    # hrv_alignment owns the target; hrv_analysis binds TARGET from it and the
    # module-level assertion in hrv_analysis has already run on import.
    assert al.TARGET == guard.WHOOP_HRV_COLUMN
    assert h.TARGET == al.TARGET
    guard.assert_target_is_whoop(h.TARGET)
    guard.assert_target_is_whoop(al.TARGET)


# ---------------------------------------------------------------------------
# Static scan: positive detection on synthetic snippets
# ---------------------------------------------------------------------------

def test_scan_flags_average_of_two_sources():
    bad = 'df["blend"] = (df["whoop_hrv_rmssd"] + df["eight_sleep_hrv"]) / 2'
    violations = guard.scan_text(bad, origin="synthetic")
    assert len(violations) == 1, violations
    assert "whoop" in violations[0] and "eight_sleep" in violations[0]


def test_scan_flags_mean_over_all_three_sources():
    bad = ('df["hrv_any"] = np.nanmean('
           'df[["whoop_hrv_rmssd", "garmin_hrv_last_night", "eight_sleep_hrv"]],'
           ' axis=1)')
    violations = guard.scan_text(bad, origin="synthetic")
    assert len(violations) == 1, violations


def test_scan_flags_coalescing_fillna():
    bad = 'df["hrv"] = df["whoop_hrv_rmssd"].fillna(df["garmin_hrv_last_night"])'
    violations = guard.scan_text(bad, origin="synthetic")
    assert len(violations) == 1, violations
    assert "blend call" in violations[0]


def test_scan_flags_combine_first_and_interpolate():
    for bad in (
        'df["x"] = df["eight_sleep_hrv"].combine_first(df["whoop_hrv_rmssd"])',
        'df["x"] = df["whoop_hrv_rmssd"].interpolate() + df["avg_hrv"]',
    ):
        violations = guard.scan_text(bad, origin="synthetic")
        assert len(violations) == 1, (bad, violations)


def test_scan_flags_raw_source_names():
    # Aliases inside select strings / raw frames count too.
    bad = 'row["hrv"] = (row["hrv_rmssd_milli"] + row["last_night_avg_ms"]) / 2'
    violations = guard.scan_text(bad, origin="synthetic")
    assert len(violations) == 1, violations


def test_scan_flags_multiline_blend():
    bad = (
        'df["blend"] = (\n'
        '    df["whoop_hrv_rmssd"] +\n'
        '    df["garmin_hrv_last_night"]\n'
        ') / 2\n'
    )
    violations = guard.scan_text(bad, origin="synthetic")
    assert len(violations) == 1, violations


def test_scan_flags_docstring_free_of_false_positives():
    # A docstring describing the rule must not itself count as a blend.
    text = (
        '"""\n'
        "Never do df[a] + df[b] of whoop_hrv_rmssd and eight_sleep_hrv.\n"
        '"""\n'
        'x = 1\n'
    )
    assert guard.scan_text(text, origin="synthetic") == []


# ---------------------------------------------------------------------------
# Static scan: benign statements are allowed
# ---------------------------------------------------------------------------

def test_scan_allows_comparisons_correlation_and_lists():
    good = "\n".join([
        'ok = abs(df["whoop_hrv_rmssd"] - df["eight_sleep_hrv"]) <= tol',
        'r = df["whoop_hrv_rmssd"].corr(df["garmin_hrv_last_night"])',
        'drop_cols = ["whoop_hrv_rmssd", "eight_sleep_hrv", "garmin_hrv_last_night"]',
        'sel = "calendar_date,hrv_rmssd_milli,score_state"',
    ])
    assert guard.scan_text(good, origin="synthetic") == []


def test_scan_allows_single_source_operations():
    good = "\n".join([
        'df["whoop_hrv_rmssd"] = pd.to_numeric(df["whoop_hrv_rmssd"])',
        'df["eight_sleep_hrv"] = df["eight_sleep_hrv"].fillna(0)',
        'm = df.groupby("calendar_date")["whoop_hrv_rmssd"].mean()',
    ])
    assert guard.scan_text(good, origin="synthetic") == []


def test_scan_allows_prefixed_derivatives():
    # whoop_hrv_rmssd_lag1 / garmin_hrv_last_night_x are different tokens.
    good = 'df["pair"] = df["whoop_hrv_rmssd_lag1"] + df["garmin_hrv_last_night_lag1"]'
    assert guard.scan_text(good, origin="synthetic") == []


def test_scan_allows_comments_mentioning_all_three():
    good = (
        "# blend whoop_hrv_rmssd + garmin_hrv_last_night + eight_sleep_hrv is banned\n"
        'x = 2 + 2\n'
    )
    assert guard.scan_text(good, origin="synthetic") == []


# ---------------------------------------------------------------------------
# Static scan: the real pipeline files
# ---------------------------------------------------------------------------

def test_scanned_pipeline_files_are_clean():
    violations = guard.scan_repository(REPO_ROOT)
    assert violations == [], "HRV column blends found:\n" + "\n".join(violations)


def test_check_repository_passes():
    guard.check_repository(REPO_ROOT)  # must not raise


def test_check_repository_raises_on_blend():
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        (tmp / "hrv_predict.py").write_text(
            'df["blend"] = df["avg_hrv"].fillna(df["whoop_hrv_rmssd"])\n',
            encoding="utf-8",
        )
        try:
            guard.check_repository(tmp)
        except HRVColumnBlendError:
            pass
        else:
            raise AssertionError("expected HRVColumnBlendError from probe root")


def main() -> int:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"PASS {t.__name__}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"FAIL {t.__name__}: {exc}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
