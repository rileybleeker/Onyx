"""HRV column non-blending guard (AGENTS.md: "HRV columns are not interchangeable
across sources").

whoop_recovery.hrv_rmssd_milli (matrix column `whoop_hrv_rmssd`), garmin_hrv.
last_night_avg_ms (`garmin_hrv_last_night`) and eight_sleep_trends.avg_hrv
(`eight_sleep_hrv`) measure HRV with three different algorithms. They must never
be averaged, coalesced, filled from one another or substituted for one another:
a blend would silently corrupt the analysis target and every feature built from
it.

This module is PURE (re + pathlib only, no pandas/numpy, no network):

  * a static source scan (regex over assignment / combination statements) over
    hrv_analysis.py, hrv_predict.py and causal_inference.py that flags any
    statement combining two or more of the three source columns with an
    averaging or coalescing operation;
  * a runtime assertion, assert_target_is_whoop(), that the pipeline TARGET is
    the WHOOP column (wired in hrv_analysis.py right after TARGET is bound).

Coverage is intentionally narrow: only statements that BUILD something from
two or more source columns via a blend (arithmetic mean shapes `+` / `/` between
the refs, or mean / average / fillna / combine_first / coalesce / interpolate /
ffill / bfill) are flagged. Merely naming several of the columns in one
statement (drop lists, select strings, comparisons, correlation) is allowed —
the rule guards construction, not mention.

Test: tests/test_hrv_columns_not_blended.py (synthetic only; no real values).
"""
from __future__ import annotations

import re
from pathlib import Path

# The one true endogenous target of the HRV pipeline.
WHOOP_HRV_COLUMN = "whoop_hrv_rmssd"

# The three non-interchangeable source columns. Each entry maps a source to
# every identifier its HRV value can carry inside the pipeline files: the
# matrix column name plus the raw select-string / frame name. (garmin_sleep's
# unrelated `avg_hrv` shares the bare name with Eight Sleep's; it is only ever
# read alone in a select string, and a blend flag needs TWO sources plus a
# blend operation in one statement, so that overlap cannot false-positive.)
SOURCE_HRV_COLUMNS: dict[str, tuple[str, ...]] = {
    "whoop": (WHOOP_HRV_COLUMN, "hrv_rmssd_milli"),
    "garmin": ("garmin_hrv_last_night", "last_night_avg_ms"),
    "eight_sleep": ("eight_sleep_hrv", "avg_hrv"),
}

# Pipeline files the static scan covers. hrv_alignment.py re-keys these columns
# by date (legitimate) and is checked at runtime by its own alignment guard.
SCANNED_FILES: tuple[str, ...] = (
    "hrv_analysis.py",
    "hrv_predict.py",
    "causal_inference.py",
)

# Substrings that turn "several HRV columns in one statement" into a blend.
# mean(/average(/nanmean( also cover np.mean(...) etc.
_BLEND_FUNC_SUBSTRINGS: tuple[str, ...] = (
    "mean(",
    "average(",
    "nanmean(",
    "fillna(",
    "combine_first(",
    "coalesce",
    "interpolate(",
    "ffill(",
    "bfill(",
    ".add(",
    "clip(",
)

# Arithmetic characters that, appearing BETWEEN two source columns of different
# sources, mark an averaging-style combination ((a + b) / 2, ratios, sums).
_BLEND_ARITHMETIC = "+*/"


class HRVColumnBlendError(RuntimeError):
    """A pipeline statement blended the non-interchangeable HRV columns, or the
    TARGET is not the WHOOP HRV column."""


def assert_target_is_whoop(target: str, label: str = "TARGET") -> None:
    """Runtime assertion: the pipeline's outcome column IS the WHOOP HRV column.

    Never substituted, never coalesced with the Garmin / Eight Sleep copies —
    a TARGET built any other way would silently train on a different metric.
    """
    if target != WHOOP_HRV_COLUMN:
        raise HRVColumnBlendError(
            f"{label} is {target!r}, but the pipeline outcome must be the WHOOP "
            f"column {WHOOP_HRV_COLUMN!r} (AGENTS.md: HRV columns are not "
            "interchangeable across sources and must never be averaged or "
            "substituted)."
        )


# ---------------------------------------------------------------------------
# Static source scan
# ---------------------------------------------------------------------------

_TOKEN_RES: dict[str, list[re.Pattern[str]]] = {
    source: [re.compile(r"(?<![A-Za-z0-9_])" + re.escape(name) + r"(?![A-Za-z0-9_])")
             for name in names]
    for source, names in SOURCE_HRV_COLUMNS.items()
}


def _strip_comments(text: str) -> str:
    """Blank out `#` comments, respecting quotes."""
    out: list[str] = []
    for line in text.splitlines():
        quote = None
        cut = len(line)
        i = 0
        while i < len(line):
            ch = line[i]
            if quote:
                if ch == "\\":
                    i += 2
                    continue
                if ch == quote:
                    quote = None
            elif ch in "\"'":
                quote = ch
            elif ch == "#":
                cut = i
                break
            i += 1
        out.append(line[:cut])
    return "\n".join(out)


def _strip_docstrings(text: str) -> str:
    """Blank the CONTENTS of triple-quoted strings (docstrings), preserving
    newlines and line numbers. Short single/double-quoted strings are kept:
    that is where column names live (df["whoop_hrv_rmssd"])."""
    out: list[str] = list(text)
    i = 0
    n = len(text)
    while i < n:
        if text.startswith('"""', i) or text.startswith("'''", i):
            delim = text[i:i + 3]
            j = i + 3
            while j < n and not text.startswith(delim, j):
                if text[j] != "\n":
                    out[j] = " "
                j += 1
            for k in range(i, min(i + 3, n)):
                out[k] = " "
            i = j + 3 if j < n else n
        else:
            i += 1
    return "".join(out)


def _logical_statements(text: str) -> list[str]:
    """Split into logical statements: join physical lines while brackets stay
    open or a backslash continues, so a blend spread over several lines is
    still one statement."""
    statements: list[str] = []
    buf: list[str] = []
    depth = 0
    for raw in text.splitlines():
        buf.append(raw)
        for ch in raw:
            if ch in "([{":
                depth += 1
            elif ch in ")]}":
                depth = max(0, depth - 1)
        if depth > 0 or raw.rstrip().endswith("\\"):
            continue
        statements.append(" ".join(part.rstrip() for part in buf))
        buf = []
    if buf:
        statements.append(" ".join(part.rstrip() for part in buf))
    return statements


def scan_text(text: str, origin: str = "<text>") -> list[str]:
    """Return a violation message per statement that blends two or more of the
    three source HRV columns. Pure regex/string work; no imports of the scanned
    code."""
    cleaned = _strip_comments(_strip_docstrings(text))
    violations: list[str] = []
    for lineno, stmt in enumerate(_logical_statements(cleaned), start=1):
        hits: dict[str, list[int]] = {}
        for source, patterns in _TOKEN_RES.items():
            for pat in patterns:
                for m in pat.finditer(stmt):
                    hits.setdefault(source, []).append(m.start())
        sources = sorted(hits)
        if len(sources) < 2:
            continue
        left = min(pos for poss in hits.values() for pos in poss)
        right = max(pos for poss in hits.values() for pos in poss)
        reasons: list[str] = []
        for sub in _BLEND_FUNC_SUBSTRINGS:
            if sub in stmt:
                reasons.append(f"blend call {sub!r}")
        between = stmt[left:right]
        if any(ch in _BLEND_ARITHMETIC for ch in between):
            reasons.append("arithmetic between the source columns")
        if reasons:
            violations.append(
                f"{origin}: statement {lineno} blends HRV columns from "
                f"{'+'.join(sources)} ({', '.join(reasons)}): {stmt.strip()[:200]}"
            )
    return violations


def scan_file(path: Path) -> list[str]:
    return scan_text(path.read_text(encoding="utf-8"), origin=str(path))


def scan_repository(root: str | Path | None = None) -> list[str]:
    """Scan the pipeline files (SCANNED_FILES) under `root` (default: this
    module's directory, the repo root)."""
    base = Path(root) if root is not None else Path(__file__).resolve().parent
    violations: list[str] = []
    for name in SCANNED_FILES:
        path = base / name
        if path.exists():
            violations.extend(scan_file(path))
    return violations


def check_repository(root: str | Path | None = None) -> None:
    """Raise HRVColumnBlendError if any scanned pipeline file blends the
    source HRV columns."""
    violations = scan_repository(root)
    if violations:
        raise HRVColumnBlendError(
            "Non-interchangeable HRV columns blended in the HRV pipeline "
            "(AGENTS.md: whoop hrv_rmssd_milli, garmin last_night_avg_ms and "
            "eight_sleep avg_hrv must never be averaged or substituted):\n  "
            + "\n  ".join(violations)
        )


if __name__ == "__main__":
    # Read-only CLI, like experiment_fingerprint.py: prints the violations so a
    # human or agent can run the scan directly (python hrv_column_guard.py).
    found = scan_repository()
    if found:
        print(f"{len(found)} HRV column blend(s) found:")
        for v in found:
            print(f"  {v}")
        raise SystemExit(1)
    print("clean: no HRV source-column blends in " + ", ".join(SCANNED_FILES))
