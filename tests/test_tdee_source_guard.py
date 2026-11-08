"""TDEE source guard (audit P1: calorie-source conflation).

WHOOP `kilojoule / 4.184` is the canonical "calories burnt" in Onyx; Garmin's
`total_kilocalories` must never be surfaced as TDEE. The two allowed frontend
touchpoints rename Garmin's field to `garmin_total_kcal_NOT_TDEE` on the way
out. This test fails if any other frontend file starts reading
`total_kilocalories` directly, or if either rename is removed.

Run: python tests/test_tdee_source_guard.py
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "frontend" / "src"

# file (relative to frontend/src) -> marker that proves the rename is in place
ALLOWED = {
    "lib/queries.ts": "garmin_total_kcal_NOT_TDEE",
    "app/api/chat/route.ts": "garmin_total_kcal_NOT_TDEE",
}


def main() -> None:
    offenders = []
    for path in SRC.rglob("*"):
        if path.suffix not in (".ts", ".tsx") or not path.is_file():
            continue
        rel = path.relative_to(SRC).as_posix()
        text = path.read_text(encoding="utf-8", errors="ignore")
        if "total_kilocalories" in text and rel not in ALLOWED:
            offenders.append(rel)

    missing = [
        rel for rel, marker in ALLOWED.items()
        if marker not in (SRC / rel).read_text(encoding="utf-8")
    ]

    assert not offenders, (
        "Garmin total_kilocalories read outside the guarded query layer — "
        f"use getWhoopCaloriesBurnt() / WHOOP kJ for TDEE instead: {offenders}"
    )
    assert not missing, f"TDEE rename guard removed from: {missing}"
    print("TDEE source guard OK")


if __name__ == "__main__":
    main()
