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


class _FakeClient:
    """In-memory stand-in for the PostgREST client: upsert overwrites whole rows, like the real table."""

    def __init__(self):
        self.table = {}

    def get_json(self, _table, _query):
        return [dict(r, watched_at=r["watched_at"].replace("Z", "+00:00")) for r in self.table.values()]

    def upsert(self, _table, rows, _on_conflict):
        for r in rows:
            self.table[(r["watched_at"], r["video_id"])] = dict(r)


def _import(client, events, label):
    client.upsert("t", yh.merge_with_stored(client, yh.build_rows(events, label)), yh.ON_CONFLICT)


def test_sparse_and_rich_exports_keep_metadata_in_both_orders():
    rich = [dict(EVENTS[0], header="YouTube Music"), dict(EVENTS[4])]
    sparse = [{"title": "Watched SENTINEL_TITLE", "titleUrl": EVENTS[0]["titleUrl"], "time": EVENTS[0]["time"]},
              {"title": "Watched Ad", "titleUrl": EVENTS[4]["titleUrl"], "time": EVENTS[4]["time"]}]
    for first, second in ((rich, sparse), (sparse, rich)):
        c = _FakeClient()
        _import(c, first, "one")
        _import(c, second, "two")
        by_id = {r["video_id"]: r for r in c.table.values()}
        a, ad = by_id["abc123DEF_-"], by_id["adv1"]
        assert a["channel_id"] == "UCxyz" and a["channel_name"] == "Chan" and a["is_music"] is True
        assert ad["is_ad"] is True


def test_legacy_fingerprint_is_a_distinct_format():
    with tempfile.TemporaryDirectory() as t:
        f = Path(t) / "takeout-1.zip"
        f.write_bytes(b"x")
        assert yh.legacy_fingerprint(f) and yh.legacy_fingerprint(f) != yh.fingerprint(f)


# ---------------------------------------------------------------- run(): legacy receipts and the import lock
import os  # noqa: E402
import threading  # noqa: E402


class _Beats:
    """The sync_log heartbeat path (supa.schema().table().insert().execute()), recorded in memory."""

    def __init__(self):
        self.rows = []

    def table(self, _name):
        return self

    def insert(self, row):
        self.rows.append(row)
        return self

    def execute(self):
        return None


class _RunClient(_FakeClient):
    """_FakeClient that run() can use end to end, over a row store that several clients may share."""

    def __init__(self, store=None, name=""):
        super().__init__()
        if store is not None:
            self.table = store
        self.name = name
        self.beats = _Beats()

    def schema(self, _name):
        return self.beats


class _Env:
    """A temporary LOCALAPPDATA so run() keeps its state and lock in a throwaway folder."""

    def __enter__(self):
        self._t = tempfile.TemporaryDirectory()
        self._old = os.environ.get("LOCALAPPDATA")
        os.environ["LOCALAPPDATA"] = self._t.name
        return Path(self._t.name)

    def __exit__(self, *exc):
        if self._old is None:
            os.environ.pop("LOCALAPPDATA", None)
        else:
            os.environ["LOCALAPPDATA"] = self._old
        self._t.cleanup()


def _export_folder(base: Path, events) -> Path:
    root = base / "Takeout"
    nested = root / "YouTube" / "history"
    nested.mkdir(parents=True, exist_ok=True)
    (nested / "watch-history.json").write_text(json.dumps(events), encoding="utf-8")
    return root


def test_run_reimports_changed_contents_under_a_legacy_receipt():
    """YT832-1: a folder recorded under the old name|size|mtime receipt whose nested file changed (same folder
    metadata) must be imported once more, recorded by content hash, and the legacy receipt retired."""
    with _Env() as appdata, tempfile.TemporaryDirectory() as t:
        t = Path(t)
        root = _export_folder(t / "od", EVENTS[:1])
        d = yh.data_dir()
        legacy = yh.legacy_fingerprint(root)
        yh.save_state(d, {"done": {legacy: {"imported": "2026-11-01T00:00:00+00:00", "events": 1}}})
        # The nested file changes; the outer folder's name, size and mtime are pinned so the legacy key holds.
        st = root.stat()
        (root / "YouTube" / "history" / "watch-history.json").write_text(json.dumps(EVENTS[:2]), encoding="utf-8")
        os.utime(root, (st.st_atime, st.st_mtime))
        assert yh.legacy_fingerprint(root) == legacy
        c = _RunClient()
        store = c.table
        assert yh.run(roots=[(t / "od", 3)], client=c) == 0
        assert {k[1] for k in store} == {"abc123DEF_-", "zzz111"}  # the changed contents were imported
        done = yh.load_state(d)["done"]
        assert yh.fingerprint(root) in done and legacy not in done
        # A second run with nothing new skips it (the content hash is now the receipt).
        store.clear()
        assert yh.run(roots=[(t / "od", 3)], client=c) == 0
        assert store == {}
        assert appdata in d.parents


def test_two_runs_never_both_read_before_either_writes():
    """YT832-2: a rich import and a sparse import started together. Without the lock both read the empty
    table, the rich one writes, then the sparse one writes its stale merge and erases the channel and the
    music flag. With the lock the second run reads only after the first has written."""
    rich = [dict(EVENTS[0], header="YouTube Music")]
    sparse = [{"title": "Watched SENTINEL_TITLE", "titleUrl": EVENTS[0]["titleUrl"], "time": EVENTS[0]["time"]}]
    with _Env(), tempfile.TemporaryDirectory() as t:
        t = Path(t)
        _export_folder(t / "a", rich)
        _export_folder(t / "b", sparse)
        store, order = {}, []
        a_reading, b_read = threading.Event(), threading.Event()

        class Slow(_RunClient):
            def get_json(self, table, query):
                order.append(f"{self.name}:read")
                got = _FakeClient.get_json(self, table, query)
                if self.name == "A":
                    a_reading.set()
                    b_read.wait(1.0)  # without the lock B reads here, before A writes
                else:
                    b_read.set()
                return got

            def upsert(self, table, rows, on_conflict):
                order.append(f"{self.name}:write")
                _FakeClient.upsert(self, table, rows, on_conflict)

        results = {}
        ta = threading.Thread(target=lambda: results.__setitem__("A", yh.run(roots=[(t / "a", 3)], client=Slow(store, "A"))))
        ta.start()
        assert a_reading.wait(5.0)
        tb = threading.Thread(target=lambda: results.__setitem__(
            "B", yh.run(roots=[(t / "b", 3)], client=Slow(store, "B"), lock_wait=10.0)))
        tb.start()
        ta.join(15.0)
        tb.join(15.0)
        assert results == {"A": 0, "B": 0}
        assert order == ["A:read", "A:write", "B:read", "B:write"], order
        (row,) = store.values()
        assert row["channel_id"] == "UCxyz" and row["channel_name"] == "Chan" and row["is_music"] is True


def test_lock_timeout_is_a_failed_run_that_writes_nothing():
    with _Env(), tempfile.TemporaryDirectory() as t:
        t = Path(t)
        _export_folder(t / "a", EVENTS[:1])
        c = _RunClient()
        store = c.table
        with yh.import_lock(yh.data_dir()):
            done = []
            th = threading.Thread(target=lambda: done.append(yh.run(roots=[(t / "a", 3)], client=c, lock_wait=0.2)))
            th.start()
            th.join(5.0)
        assert done == [1] and store == {}
        assert c.beats.rows and c.beats.rows[-1]["status"] == "failed"
        assert c.beats.rows[-1]["error_message"] == "ImportLockTimeout"
