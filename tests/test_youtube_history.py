"""Synthetic tests for tools/youtube_history (no network, no key). Run by the post-deploy suite."""
import json
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools" / "youtube_history"))
import youtube_history as yh  # noqa: E402

EVENTS = [
    {"header": "YouTube", "title": "Watched SENTINEL_TITLE", "titleUrl": "https://www.youtube.com/watch?v=abc123DEF_-",
     "subtitles": [{"name": "Chan", "url": "https://www.youtube.com/channel/UCxyz"}],
     "time": "2026-11-10T03:04:05.678Z", "products": ["YouTube"]},
    {"header": "YouTube Music", "title": "Watched Song", "titleUrl": "https://music.youtube.com/watch?v=zzz111",
     "time": "2026-11-10T04:00:00Z"},
    {"title": "Watched a video that has been removed", "time": "2026-11-10T05:00:00Z"},
    {"title": "Viewed post", "titleUrl": "https://www.youtube.com/post/x", "time": "2026-11-10T06:00:00Z"},
    {"title": "Watched Ad", "titleUrl": "https://www.youtube.com/watch?v=adv1", "details": [{"name": "From Google Ads"}],
     "time": "2026-11-10T07:00:00Z"},
    {"title": "Watched SENTINEL_TITLE", "titleUrl": "https://www.youtube.com/watch?v=abc123DEF_-",
     "time": "2026-11-10T03:04:05.678Z"},
    {"title": "no time", "titleUrl": "https://www.youtube.com/watch?v=q"},
]


def test_rows_flags_and_dedupe():
    rows = yh.build_rows(EVENTS, "lbl")
    assert len(rows) == 4
    by = {r["video_id"]: r for r in rows}
    assert by["zzz111"]["is_music"] and not by["abc123DEF_-"]["is_music"]
    assert by["adv1"]["is_ad"]
    assert by["removed"]["title"].startswith("a video that has been removed")
    assert by["abc123DEF_-"]["channel_id"] == "UCxyz" and by["abc123DEF_-"]["channel_name"] == "Chan"
    assert [r["watched_at"] for r in rows] == sorted(r["watched_at"] for r in rows)
    yh.check_rows(rows)


def test_zip_and_folder_and_output_has_no_titles(capsys=None):
    with tempfile.TemporaryDirectory() as t:
        t = Path(t)
        z = t / "takeout-20261110T000000Z-001.zip"
        with zipfile.ZipFile(z, "w") as zf:
            zf.writestr("Takeout/YouTube and YouTube Music/history/watch-history.json", json.dumps(EVENTS))
        assert len(yh.read_history(z, "zip")) == len(EVENTS)
        assert [e[0] for e in yh.find_exports([(t, 1)])] == [z.name]
        folder = t / "x" / "Takeout" / "YouTube" / "history"
        folder.mkdir(parents=True)
        (folder / "watch-history.json").write_text(json.dumps(EVENTS), encoding="utf-8")
        found = yh.find_exports([(t / "x", 4)])
        assert len(found) == 1 and found[0][2] == "dir"
        s = json.dumps(yh.summarize(yh.build_rows(EVENTS, "lbl")))
        assert "SENTINEL" not in s


def test_duplicate_keeps_known_channel_in_either_order():
    rich, bare = EVENTS[0], EVENTS[5]
    for order in ([rich, bare], [bare, rich]):
        (row,) = yh.build_rows(order, "lbl")
        assert row["channel_id"] == "UCxyz" and row["channel_name"] == "Chan"


def test_nested_history_change_changes_fingerprint():
    with tempfile.TemporaryDirectory() as t:
        root = Path(t) / "Takeout"
        nested = root / "YouTube" / "history"
        nested.mkdir(parents=True)
        f = nested / "watch-history.json"
        f.write_text(json.dumps(EVENTS[:1]), encoding="utf-8")
        before = yh.fingerprint(root)
        assert before == yh.fingerprint(root)
        f.write_text(json.dumps(EVENTS[:2]), encoding="utf-8")
        assert yh.fingerprint(root) != before


def test_bad_format_is_an_error():
    try:
        yh._as_list({"a": 1})
    except ValueError:
        return
    raise AssertionError("expected ValueError")
