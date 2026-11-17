"""merge_spotify_features: opt-in Spotify daily signature merge.

Checks (synthetic rows only): no sp_ columns when the data is absent (the
default path — load_data only fills spotify_daily when ONYX_INCLUDE_SPOTIFY=1);
sp_ columns appear when present; audio-feature means on featurized_plays < 5
days are NaN while counts/minutes stay as-is; rows stay on their own
calendar_date (no shifting).

Run: python tests/test_spotify_daily_features.py
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

import hrv_analysis as h  # noqa: E402


DAYS = ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"]


def _matrix():
    return pd.DataFrame({
        "calendar_date": DAYS,
        "whoop_hrv_rmssd": [50.0, 55.0, 48.0, 52.0],
    })


def _sp_row(date, plays, featurized, valence, energy=0.5, minutes=30.0):
    return {
        "calendar_date": date,
        "play_count": plays,
        "unique_tracks": plays,
        "unique_artists": max(1, plays - 1),
        "total_minutes": minutes,
        "featurized_plays": featurized,
        "avg_valence": valence,
        "avg_energy": energy,
        "avg_tempo": 120.0,
        "avg_danceability": 0.6,
        "avg_acousticness": 0.3,
        "avg_instrumentalness": 0.1,
        "avg_loudness": -8.0,
    }


def _sp_data():
    # Day 1: well-featurized. Day 2: thin (featurized_plays=2 < 5).
    # Day 3: featurized_plays NULL -> treated as thin. Day 4: exactly 5 -> kept.
    return pd.DataFrame([
        _sp_row(DAYS[0], 10, 10, 0.8),
        _sp_row(DAYS[1], 2, 2, 0.7),
        _sp_row(DAYS[2], 8, None, 0.4),
        _sp_row(DAYS[3], 5, 5, 0.9),
    ])


def test_off_by_default_adds_no_columns():
    df, masked = h.merge_spotify_features(_matrix(), pd.DataFrame())
    assert masked is None
    assert not any(c.startswith("sp_") for c in df.columns)
    df2, masked2 = h.merge_spotify_features(_matrix(), None)
    assert masked2 is None
    assert not any(c.startswith("sp_") for c in df2.columns)


def test_on_adds_columns_and_keeps_row_count():
    out, masked = h.merge_spotify_features(_matrix(), _sp_data())
    assert len(out) == 4
    for c in ("sp_play_count", "sp_total_minutes", "sp_featurized_plays",
              "sp_avg_valence", "sp_avg_energy", "sp_avg_tempo"):
        assert c in out.columns, f"missing {c}"
    # Counts/minutes are never masked, only the audio-feature means.
    assert out["sp_play_count"].tolist() == [10, 2, 8, 5]
    assert out["sp_total_minutes"].tolist() == [30.0, 30.0, 30.0, 30.0]


def test_thin_days_masked_as_documented():
    out, masked = h.merge_spotify_features(_matrix(), _sp_data())
    assert masked == 2  # the featurized_plays=2 day and the NULL day
    v = out.set_index("calendar_date")["sp_avg_valence"]
    assert v[DAYS[0]] == 0.8
    assert np.isnan(v[DAYS[1]])  # featurized_plays < 5 -> NaN
    assert np.isnan(v[DAYS[2]])  # NULL featurized_plays -> treated as 0 -> NaN
    assert v[DAYS[3]] == 0.9     # exactly 5 is not below the threshold
    # The energy mean on a thin day is masked too, the count is not.
    assert np.isnan(out.set_index("calendar_date").loc[DAYS[1], "sp_avg_energy"])
    assert out.set_index("calendar_date").loc[DAYS[1], "sp_featurized_plays"] == 2


def test_no_shifting_rows_stay_on_their_day():
    out, _ = h.merge_spotify_features(_matrix(), _sp_data())
    by_day = out.set_index("calendar_date")
    assert by_day.loc[DAYS[0], "sp_play_count"] == 10
    assert by_day.loc[DAYS[3], "sp_play_count"] == 5
    # A spine day with no spotify row (left join) gets all-NaN sp_ columns.
    matrix = pd.DataFrame({
        "calendar_date": DAYS + ["2026-01-05"],
        "whoop_hrv_rmssd": [50.0, 55.0, 48.0, 52.0, 51.0],
    })
    out5, _ = h.merge_spotify_features(matrix, _sp_data())
    row = out5[out5["calendar_date"] == "2026-01-05"]
    assert len(row) == 1
    assert np.isnan(row["sp_play_count"].iloc[0])


def run_all():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"PASS {t.__name__}")
    print(f"{len(tests)} tests passed")


if __name__ == "__main__":
    run_all()
