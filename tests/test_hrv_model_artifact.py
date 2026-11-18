"""HRV model artifacts are published once and served by provenance (audit PIPE-08).

Until 2026-11-16 every hourly forecast run saved the pickle it had restored under a new Actions
cache key with the same prefix the retrain used, and the restore took the most recently SAVED
entry. A forecast run that restored the old model before a retrain finished, and ended after it,
saved the old model again as the newest, so later runs served it while forecasts looked current.

These tests pin:
  1. an artifact carries its provenance (training commit, data cutoff, alignment and
     preprocessing versions, package fingerprint) and the SHA-256 of its exact bytes;
  2. every check that can refuse an artifact runs BEFORE the bytes are unpickled (a tripwire
     object proves nothing was unpickled): wrong checksum, pickle/manifest mismatch, another
     alignment rule, an unknown preprocessing version, another xgboost / scikit-learn release
     (exact match: not even a patch release), another numpy major or Python minor;
  3. selection is by provenance, never by save or publish time; a retired row is never served;
     a pin decides BEFORE compatibility, so a pin this code cannot serve (a dependency upgrade,
     another alignment rule) stops the forecast instead of selecting another row; the forecast
     also fails closed when the registry cannot be read (anything but "table not applied yet")
     and when a pinned artifact is gone from the cache (no other model is served or trained in
     its place);
  4. a synthetic interleaving of an old forecast run and a new training cannot put the old
     model back as the served one (the forecast workflow has no save step for a restored model,
     and the publish command refuses an artifact another run trained);
  5. a failed or unsaved training never advances the registry (nor one with no training commit
     time, which could not be ordered), and publishing again is a no-op;
  6. each forecast row names the artifact that produced it (hrv_predict.py and the retrain's
     own live row), with a fallback while the column does not exist yet, and a model-artifact
     heartbeat for every way a forecast can be made without the registry check;
  7. the workflow files and the SQL keep that contract.

Synthetic data only: fake models, fake registry, fake cache. No credentials, no network.
Run: python tests/test_hrv_model_artifact.py
"""
from __future__ import annotations

import contextlib
import json
import os
import pickle
import re
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

import hrv_alignment as al  # noqa: E402
import hrv_analysis as h  # noqa: E402
import hrv_model_artifact as ma  # noqa: E402

NAN = np.nan
OS = "Linux"
MASTER = "refs/heads/master"
CURRENT_FILL = h.SPARSE_FILL_VERSION
KNOWN_FILLS = tuple(h.SPARSE_FILL_VERSIONS)
DEPS = {"python": "3.12.7", "numpy": "2.1.3", "pandas": "2.2.3",
        "scikit-learn": "1.5.2", "xgboost": "2.1.2"}
T0 = datetime(2026, 11, 1, 10, 0, tzinfo=timezone.utc)
ENV_KEYS = ("GITHUB_ACTIONS", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_REF", "GITHUB_SHA",
            "GITHUB_WORKFLOW", "GITHUB_JOB", "GITHUB_OUTPUT", "RUNNER_OS",
            "HRV_MODEL_REGISTRY", "HRV_MODEL_SELECTED_SHA256", "HRV_MODEL_PINNED",
            "HRV_MODEL_PIN_BLOCKED", "HRV_MODEL_PIN_REASON", "HRV_MODEL_RESTORED",
            "HRV_MODEL_PUBLISH")


# ── synthetic pieces ─────────────────────────────────────────────────────────────────────────

_TRIPPED: list[int] = []


def _trip():
    _TRIPPED.append(1)
    return "unpickled"


class _Tripwire:
    """Unpickling this object records it: proves whether a refused artifact was unpickled."""

    def __reduce__(self):
        return (_trip, ())


class _FakeModel:
    def predict(self, X):
        return np.array([55.0] * len(X))


def _run_env(run_id: str, *, attempt: str = "1", ref: str = MASTER) -> dict:
    return {"GITHUB_ACTIONS": "true", "GITHUB_RUN_ID": run_id, "GITHUB_RUN_ATTEMPT": attempt,
            "GITHUB_REF": ref, "GITHUB_WORKFLOW": "synthetic", "GITHUB_JOB": "synthetic",
            "RUNNER_OS": OS}


@contextlib.contextmanager
def _environ(**values):
    saved = {k: os.environ.get(k) for k in ENV_KEYS}
    for k in ENV_KEYS:
        os.environ.pop(k, None)
    os.environ.update({k: v for k, v in values.items() if v is not None})
    try:
        yield
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


@contextlib.contextmanager
def _workspace():
    """A fresh runner workspace (cwd), like a new Actions job."""
    old = os.getcwd()
    with tempfile.TemporaryDirectory() as tmp:
        os.chdir(tmp)
        try:
            yield Path(tmp)
        finally:
            os.chdir(old)


def _provenance(*, run_id="100", commit_offset_h=0, cutoff="2026-11-01", trained_offset_h=0,
                alignment=None, preprocessing=CURRENT_FILL, deps=None, attempt="1",
                commit_time_known=True):
    return ma.build_provenance(
        model_version="2026-11-01_behavioral_v1", data_cutoff=cutoff, training_rows=400,
        feat_cols=["f_a", "f_b"], input_data_hash="ab" * 32,
        alignment_version=alignment or al.ALIGNMENT_VERSION, preprocessing_version=preprocessing,
        now=T0 + timedelta(hours=trained_offset_h), env=_run_env(run_id, attempt=attempt),
        deps=deps or DEPS,
        git={"training_sha": "c" * 40,
             "training_commit_time": ((T0 + timedelta(hours=commit_offset_h)).isoformat()
                                      if commit_time_known else None),
             "training_ref": MASTER})


def _bundle(model=None, preprocessing=CURRENT_FILL):
    return {"model": model if model is not None else _FakeModel(), "feat_cols": ["f_a", "f_b"],
            "pred_std": 10.0, "model_version": "2026-11-01_behavioral_v1",
            "alignment": al.ALIGNMENT_VERSION, "preprocessing": preprocessing}


def _write(path: Path, **prov_kwargs) -> dict:
    model = prov_kwargs.pop("model", None)
    return ma.write_artifact(_bundle(model), _provenance(**prov_kwargs), path, os_name=OS)


def _load(path: Path, expected=None, deps=None, alignment=None):
    return ma.load_artifact(path, expected_sha=expected,
                            alignment_version=alignment or al.ALIGNMENT_VERSION,
                            preprocessing_versions=KNOWN_FILLS, runtime_deps=deps or DEPS)


def _refused(fn, fragment: str) -> str:
    try:
        fn()
    except ma.ArtifactError as e:
        assert fragment in str(e), str(e)
        return str(e)
    raise AssertionError(f"expected a refusal containing {fragment!r}")


# ── fake Supabase (registry + sync_log) and fake Actions cache ───────────────────────────────

class _Resp:
    def __init__(self, data):
        self.data = data


class _MissingTable(Exception):
    """What PostgREST raises while sql/hrv_model_artifacts.sql has not been applied."""

    code = "PGRST205"
    message = f"Could not find the table 'pds.{ma.REGISTRY_TABLE}' in the schema cache"


class _Query:
    def __init__(self, db, table):
        self.db, self.table = db, table
        self.filters: list[tuple] = []
        self.cols: list[str] | None = None
        self.op = ("select",)
        self._order = None
        self._limit = None

    def select(self, cols="*"):
        self.cols = None if cols == "*" else [c.strip() for c in cols.split(",")]
        return self

    def eq(self, col, val):
        self.filters.append((col, val))
        return self

    def is_(self, col, val):
        self.filters.append((col, {"null": None, "true": True, "false": False}[val]))
        return self

    def order(self, col, desc=False):
        self._order = (col, desc)
        return self

    def limit(self, n):
        self._limit = n
        return self

    def upsert(self, row, on_conflict="", ignore_duplicates=False):
        self.op = ("upsert", row, ignore_duplicates)
        return self

    def insert(self, row):
        self.op = ("insert", row)
        return self

    def execute(self):
        rows = self.db.tables.setdefault(self.table, [])
        if self.op[0] == "select":
            if self.table in self.db.missing_tables:
                raise _MissingTable(_MissingTable.message)
            if self.table in self.db.fail_reads:
                raise RuntimeError("synthetic read failure SECRET-MARKER")
            out = [r for r in rows if all(r.get(c) == v for c, v in self.filters)]
            if self._order:     # ties: the row written last counts as the newest
                col, desc = self._order
                ranked = sorted(enumerate(out), key=lambda t: (str(t[1].get(col) or ""), t[0]),
                                reverse=desc)
                out = [r for _, r in ranked]
            if self._limit is not None:
                out = out[: self._limit]
            if self.cols:
                out = [{c: r.get(c) for c in self.cols} for r in out]
            return _Resp([dict(r) for r in out])
        if self.table in self.db.fail_writes:
            raise RuntimeError("synthetic write failure SECRET-MARKER")
        row = json.loads(json.dumps(self.op[1]))      # what a JSONB round trip returns
        if self.op[0] == "upsert" and self.table == ma.REGISTRY_TABLE:
            if any(r["artifact_sha256"] == row["artifact_sha256"] for r in rows):
                assert self.op[2], "the registry publish must never update a published row"
                return _Resp([])
            row.setdefault("pinned", False)
            row.setdefault("retired_at", None)
        rows.append(row)
        return _Resp([row])


class _FakeDb:
    def __init__(self):
        self.tables: dict[str, list[dict]] = {}
        self.fail_reads: set[str] = set()
        self.fail_writes: set[str] = set()
        self.missing_tables: set[str] = set()
        self.files: dict[str, bytes] = {}
        self.fail_storage = False

    @property
    def storage(self):
        db = self

        class _Bucket:
            def upload(self, path, data, _opts=None):
                if db.fail_storage:
                    raise RuntimeError("storage down")
                db.files[path] = bytes(data)

            def download(self, path):
                if db.fail_storage or path not in db.files:
                    raise RuntimeError("missing")
                return db.files[path]

        class _Storage:
            def from_(self, bucket):
                assert bucket == ma.DURABLE_BUCKET
                return _Bucket()

        return _Storage()

    def schema(self, _name):
        return self

    def from_(self, table):
        return _Query(self, table)

    table = from_

    def registry(self) -> list[dict]:
        return self.tables.get(ma.REGISTRY_TABLE, [])

    def beats(self, source, data_type) -> list[dict]:
        return [r for r in self.tables.get("sync_log", [])
                if (r["source"], r["data_type"]) == (source, data_type)]

    def write_beat(self, _supa, source, data_type, status, records=0, error=None, **_k):
        self.tables.setdefault("sync_log", []).append(
            {"source": source, "data_type": data_type, "status": status, "error_message": error,
             "sync_start": datetime.now(timezone.utc).isoformat()})


class _FakeCache:
    """GitHub Actions cache: a key is written once; restore-keys prefix = newest SAVED entry."""

    def __init__(self):
        self.entries: list[tuple[str, dict[str, bytes]]] = []

    def save(self, key: str, workspace: Path) -> None:
        if any(k == key for k, _ in self.entries):
            return
        files = {}
        for name in ("xgboost_hrv_model.pkl", "xgboost_hrv_model.manifest.json"):
            p = workspace / "analysis_output" / name
            if p.exists():
                files[name] = p.read_bytes()
        self.entries.append((key, files))

    def restore(self, key: str, workspace: Path, prefix: str | None = None) -> bool:
        hit = next((f for k, f in self.entries if k == key), None)
        if hit is None and prefix:
            hit = next((f for k, f in reversed(self.entries) if k.startswith(prefix)), None)
        if hit is None:
            return False
        out = workspace / "analysis_output"
        out.mkdir(parents=True, exist_ok=True)
        for name, data in hit.items():
            (out / name).write_bytes(data)
        return True


class _Args:
    def __init__(self, saved="true"):
        self.saved = saved


# ── 1-2: one artifact ────────────────────────────────────────────────────────────────────────

def test_artifact_records_provenance_and_checksum():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "analysis_output" / "xgboost_hrv_model.pkl"
        manifest = _write(path, cutoff=pd.Timestamp("2026-10-31"))
        data = path.read_bytes()
        assert manifest["artifact_sha256"] == ma.sha256_bytes(data)
        assert manifest["size_bytes"] == len(data)
        assert manifest["cache_key"] == f"hrv-model-{OS}-v2-{manifest['artifact_sha256'][:40]}"
        on_disk = json.loads(ma.manifest_path_for(path).read_text(encoding="utf-8"))
        assert on_disk == json.loads(json.dumps(manifest))
        prov = manifest["provenance"]
        assert prov["training_sha"] == "c" * 40 and prov["training_ref"] == MASTER
        assert prov["data_cutoff"] == "2026-10-31"
        assert prov["alignment_version"] == al.ALIGNMENT_VERSION
        assert prov["preprocessing_version"] == CURRENT_FILL
        assert prov["dependencies"] == DEPS
        assert prov["dependency_fingerprint"] == ma.dependency_fingerprint(DEPS)
        assert prov["training_run"]["run_id"] == "100"
        assert prov["training_rows"] == 400 and prov["feature_count"] == 2
        loaded = _load(path, expected=manifest["artifact_sha256"])
        assert loaded.sha256 == manifest["artifact_sha256"]
        # the provenance is inside the pickle too, so the checksum covers it
        assert loaded.bundle["provenance"] == prov
        assert loaded.bundle["preprocessing"] == CURRENT_FILL
    print("PASS: an artifact carries its provenance and the checksum of its exact bytes")


def test_every_refusal_happens_before_unpickling():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "xgboost_hrv_model.pkl"
        manifest = _write(path, model=_Tripwire())
        sha = manifest["artifact_sha256"]
        _TRIPPED.clear()

        _refused(lambda: _load(path, expected="f" * 64), "selected")
        _refused(lambda: _load(path, expected=sha, alignment="other_rule_v0"), "alignment")
        _refused(lambda: _load(path, expected=sha, deps={**DEPS, "numpy": "3.0.1"}), "numpy")
        _refused(lambda: _load(path, expected=sha, deps={**DEPS, "python": "3.13.0"}), "python")
        _refused(lambda: _load(path, expected=sha, deps={**DEPS, "xgboost": "3.0.0"}), "xgboost")
        # XGBoost promises no pickle compatibility between releases, not even a minor or a patch
        # one, and its wrapper pickles the scikit-learn estimator state: both must match exactly
        _refused(lambda: _load(path, expected=sha, deps={**DEPS, "xgboost": "2.2.0"}), "xgboost")
        _refused(lambda: _load(path, expected=sha, deps={**DEPS, "xgboost": "2.1.3"}), "xgboost")
        _refused(lambda: _load(path, expected=sha, deps={**DEPS, "scikit-learn": "1.6.0"}), "scikit-learn")
        _refused(lambda: _load(path, expected=sha, deps={**DEPS, "scikit-learn": "1.5.3"}), "scikit-learn")
        assert _TRIPPED == [], "an incompatible artifact was unpickled"

        # an unknown preprocessing version (a newer pickle after a code rollback)
        unknown = Path(tmp) / "unknown" / "xgboost_hrv_model.pkl"
        _write(unknown, model=_Tripwire(), preprocessing="unknown_fill_v9")
        _refused(lambda: _load(unknown), "preprocessing")
        assert _TRIPPED == []

        # the pickle replaced after its manifest was written (or a crash between the two writes)
        # (different bytes: the same bundle and provenance would pickle to the original's exact
        # bytes and checksum, so nothing would be replaced)
        other = pickle.dumps({**_bundle(_Tripwire()), "pred_std": 11.0,
                              "provenance": manifest["provenance"]})
        assert ma.sha256_bytes(other) != sha
        path.write_bytes(other)
        _refused(lambda: _load(path), "does not match its manifest")
        _refused(lambda: _load(path, expected=sha), "selected")
        assert _TRIPPED == []

        # the selected artifact restored without its manifest
        path2 = Path(tmp) / "nomanifest" / "xgboost_hrv_model.pkl"
        m2 = _write(path2, model=_Tripwire())
        ma.manifest_path_for(path2).unlink()
        _refused(lambda: _load(path2, expected=m2["artifact_sha256"]), "without its manifest")
        assert _TRIPPED == []

        # a malformed manifest
        path3 = Path(tmp) / "malformed" / "xgboost_hrv_model.pkl"
        _write(path3, model=_Tripwire())
        ma.manifest_path_for(path3).write_text("{not json", encoding="utf-8")
        _refused(lambda: _load(path3), "unreadable")
        assert _TRIPPED == []

        # a compatible artifact is unpickled (the tripwire itself works)
        path4 = Path(tmp) / "ok" / "xgboost_hrv_model.pkl"
        m4 = _write(path4, model=_Tripwire())
        _load(path4, expected=m4["artifact_sha256"], deps={**DEPS, "numpy": "2.3.0", "pandas": "2.3.1"})
        assert _TRIPPED == [1]

        missing = Path(tmp) / "none" / "xgboost_hrv_model.pkl"
        _refused(lambda: _load(missing), "No model to serve")
    print("PASS: every refusal (checksum, manifest, alignment, preprocessing, exact packages) runs before unpickling")


def test_pre_pipe08_pickle_is_served_with_a_partial_report():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "xgboost_hrv_model.pkl"
        path.write_bytes(pickle.dumps(_bundle()))
        loaded = _load(path)
        assert loaded.manifest is None
        status, message = ma.serving_report(loaded, env={})
        assert status == "partial" and "no training provenance" in message
        status, message = ma.serving_report(loaded, env={"HRV_MODEL_REGISTRY": "not_applied"})
        assert status == "partial" and "not set up yet" in message
    print("PASS: a pickle from before provenance is served, reported partial until the next retrain")


def test_serving_report_names_every_unchecked_path():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "xgboost_hrv_model.pkl"
        manifest = _write(path, run_id="500")
        sha = manifest["artifact_sha256"]
        loaded = _load(path)
        ok = {"HRV_MODEL_REGISTRY": "ok"}
        cases = [
            ({**ok, "HRV_MODEL_SELECTED_SHA256": sha, "HRV_MODEL_RESTORED": "true"}, "success", None),
            # the selected artifact was gone from the cache; this run trained its own
            ({**ok, "HRV_MODEL_SELECTED_SHA256": "e" * 64, "HRV_MODEL_RESTORED": "false",
              "GITHUB_RUN_ID": "500", "GITHUB_RUN_ATTEMPT": "1"}, "partial", "not in the Actions cache"),
            ({**ok, "HRV_MODEL_SELECTED_SHA256": "e" * 64, "HRV_MODEL_RESTORED": "false",
              "GITHUB_RUN_ID": "501", "GITHUB_RUN_ATTEMPT": "1"}, "partial", "not the selected"),
            ({"HRV_MODEL_REGISTRY": "not_applied"}, "partial", "not set up yet"),
            # nothing published yet: the missing-model training of this run, published in this run
            ({**ok, "GITHUB_RUN_ID": "500", "GITHUB_RUN_ATTEMPT": "1",
              "HRV_MODEL_PUBLISH": "published"}, "success", None),
            ({**ok, "GITHUB_RUN_ID": "500", "GITHUB_RUN_ATTEMPT": "1",
              "HRV_MODEL_PUBLISH": "already_published"}, "success", None),
            # the same self-trained model with publication NOT confirmed: never success
            ({**ok, "GITHUB_RUN_ID": "500", "GITHUB_RUN_ATTEMPT": "1",
              "HRV_MODEL_PUBLISH": "not_published"}, "partial", "publishing it failed or did not run"),
            ({**ok, "GITHUB_RUN_ID": "500", "GITHUB_RUN_ATTEMPT": "1",
              "HRV_MODEL_PUBLISH": "not_attempted"}, "partial", "publication was not attempted"),
            # an older workflow that passes no publication outcome: not confirmed either
            ({**ok, "GITHUB_RUN_ID": "500", "GITHUB_RUN_ATTEMPT": "1"}, "partial",
             "publication was not confirmed"),
            ({**ok, "GITHUB_RUN_ID": "500", "GITHUB_RUN_ATTEMPT": "1",
              "HRV_MODEL_PUBLISH": "something_else"}, "partial", "publication was not confirmed"),
            ({**ok, "GITHUB_RUN_ID": "500", "GITHUB_RUN_ATTEMPT": "2"}, "partial", "did not select"),
            ({}, "success", None),   # outside the workflow: the manifest checked out
        ]
        for env, status, fragment in cases:
            got_status, got_message = ma.serving_report(loaded, env=env)
            assert got_status == status, (env, got_status, got_message)
            assert (got_message is None) if fragment is None else (fragment in got_message), got_message
        linked = ma.with_unlinked_forecast({"sha256": sha, "status": "success", "message": None})
        assert linked["status"] == "partial" and ma.LINK_COLUMN in linked["message"]
        failed = ma.with_unlinked_forecast({"sha256": None, "status": "failed", "message": "x"})
        assert failed["status"] == "failed" and failed["message"].startswith("x ")
    print("PASS: the forecast heartbeat says success only for the selected, exactly restored artifact")


# ── 3: selection ─────────────────────────────────────────────────────────────────────────────

def _row(sha_char: str, *, commit_h=0, cutoff="2026-11-01", trained_h=0, **extra):
    sha = sha_char * 64
    row = {"artifact_sha256": sha, "cache_key": ma.cache_key(sha, OS),
           "training_commit_time": (T0 + timedelta(hours=commit_h)).isoformat(),
           "data_cutoff": cutoff, "trained_at": (T0 + timedelta(hours=trained_h)).isoformat(),
           "alignment_version": al.ALIGNMENT_VERSION, "preprocessing_version": CURRENT_FILL,
           "dependencies": dict(DEPS), "pinned": False, "retired_at": None}
    row.update(extra)
    return row


def _select(rows, deps=None, os_name=OS):
    return ma.select_artifact(rows, alignment_version=al.ALIGNMENT_VERSION,
                              preprocessing_versions=KNOWN_FILLS, runtime_deps=deps or DEPS,
                              os_name=os_name)


def test_selection_is_by_provenance_never_by_save_order():
    a = _row("a", commit_h=0, cutoff="2026-11-05", trained_h=50)   # old code, newest data
    b = _row("b", commit_h=5, cutoff="2026-11-02", trained_h=10)   # newest training code
    c = _row("c", commit_h=5, cutoff="2026-11-01", trained_h=40)
    import itertools
    for perm in itertools.permutations([a, b, c]):
        chosen, _ = _select(list(perm))
        assert chosen["artifact_sha256"] == "b" * 64, "training commit time decides first"
    # same code: the later data cutoff, then the later training time
    d = _row("d", commit_h=5, cutoff="2026-11-03", trained_h=1)
    e = _row("e", commit_h=5, cutoff="2026-11-03", trained_h=2)
    for perm in itertools.permutations([b, d, e]):
        assert _select(list(perm))[0]["artifact_sha256"] == "e" * 64
    # an unreadable commit time sorts below every readable one
    f = _row("f", commit_h=0, cutoff="2026-12-01", trained_h=90, training_commit_time=None)
    assert _select([f, a])[0]["artifact_sha256"] == "a" * 64
    print("PASS: the served artifact is the newest by provenance, whatever order rows come in")


def test_pinned_retired_and_incompatible_rows():
    newest = _row("1", commit_h=9)
    pinned = _row("2", commit_h=1, pinned=True)
    retired = _row("3", commit_h=20, retired_at=T0.isoformat())
    assert _select([newest, retired])[0]["artifact_sha256"] == "1" * 64, "retired is never served"
    assert _select([newest, pinned, retired])[0]["artifact_sha256"] == "2" * 64, "pinned wins"
    # a retired pin is no pin: the newest servable row is served again
    old_pin = _row("b", commit_h=2, pinned=True, retired_at=T0.isoformat(),
                   alignment_version="other_rule_v0")
    assert _select([newest, old_pin])[0]["artifact_sha256"] == "1" * 64
    assert not ma.pinned_rows([newest, old_pin]) and len(ma.pinned_rows([newest, pinned])) == 1
    incompatible = [
        _row("5", commit_h=30, preprocessing_version="unknown_fill_v9"),
        _row("6", commit_h=31, dependencies={**DEPS, "numpy": "3.0.0"}),
        _row("7", commit_h=32, cache_key=ma.cache_key("7" * 64, "Windows")),
        _row("8", commit_h=33, artifact_sha256="not-a-checksum"),
        _row("9", commit_h=34, dependencies={**DEPS, "xgboost": "2.1.3"}),
        _row("a", commit_h=35, dependencies={**DEPS, "scikit-learn": "1.5.3"}),
    ]
    chosen, skipped = _select([newest, *incompatible])
    assert chosen["artifact_sha256"] == "1" * 64 and len(skipped) == 6
    assert _select(incompatible)[0] is None
    assert _select([])[0] is None
    print("PASS: pinned beats newer, retired and incompatible rows are never served")


def test_a_pin_decides_before_compatibility():
    """An unpinned dependency upgrade (or another alignment rule) must not turn a rollback pin
    into 'serve the newest other row'; the caller stops the forecast instead."""
    newest = _row("1", commit_h=9)
    other_pin_target = {
        "alignment": {"alignment_version": "other_rule_v0"},
        "xgboost release": {"dependencies": {**DEPS, "xgboost": "2.1.3"}},
        "scikit-learn release": {"dependencies": {**DEPS, "scikit-learn": "1.5.3"}},
        "preprocessing": {"preprocessing_version": "unknown_fill_v9"},
        "runner": {"cache_key": ma.cache_key("4" * 64, "Windows")},
    }
    for label, change in other_pin_target.items():
        bad_pin = _row("4", commit_h=1, pinned=True, **change)
        chosen, skipped = _select([newest, bad_pin])
        assert chosen is None, f"{label}: the pin must not fall back to another row"
        assert len(skipped) == 1 and skipped[0].startswith("pinned artifact " + "4" * 12), skipped
        assert ma.pinned_rows([newest, bad_pin]), "the caller can tell a blocked pin from no model"
    # a malformed pinned row blocks too
    chosen, skipped = _select([newest, _row("4", pinned=True, artifact_sha256="not-a-checksum")])
    assert chosen is None and "malformed" in skipped[0]
    # the same pin servable again (the upgrade is undone): it is served, not the newest row
    good_pin = _row("4", commit_h=1, pinned=True)
    assert _select([newest, good_pin])[0]["artifact_sha256"] == "4" * 64
    # several pins: the newest by provenance is THE pin, even when an older one is servable
    older_ok = _row("5", commit_h=1, pinned=True)
    newer_bad = _row("6", commit_h=3, pinned=True, alignment_version="other_rule_v0")
    chosen, skipped = _select([newest, older_ok, newer_bad])
    assert chosen is None and skipped[0].startswith("pinned artifact " + "6" * 12)
    assert _select([newest, older_ok, _row("7", commit_h=3, pinned=True)])[0]["artifact_sha256"] == "7" * 64
    print("PASS: a pin this code cannot serve selects nothing; no other row takes its place")


# ── 4: the interleaving that used to shadow a retrain ────────────────────────────────────────

def _train(cache: _FakeCache, db: _FakeDb, run_id: str, *, commit_h: int, cutoff: str,
           publish: bool = True) -> dict:
    """One training job: write the artifact, save it under its content key, confirm, publish."""
    with _workspace() as ws, _environ(**_run_env(run_id)):
        manifest = ma.write_artifact(
            _bundle(), _provenance(run_id=run_id, commit_offset_h=commit_h, cutoff=cutoff,
                                   trained_offset_h=commit_h, deps=ma.dependency_versions()),
            Path("analysis_output") / "xgboost_hrv_model.pkl")
        cache.save(manifest["cache_key"], ws)
        if publish:
            assert ma.cmd_publish(_Args("true"), db=db) == 0
    return manifest


def test_old_forecast_run_cannot_shadow_a_newer_training():
    cache, db = _FakeCache(), _FakeDb()

    # the retrain before: artifact A, published
    a = _train(cache, db, "100", commit_h=0, cutoff="2026-11-01")

    # a forecast run starts, selects A and restores it ...
    with _workspace() as ws_forecast, _environ(**_run_env("200"), GITHUB_OUTPUT=str(Path(ws_forecast) / "out")):
        assert ma.cmd_select(None, db=db) == 0
        out = dict(line.split("=", 1) for line in
                   Path(os.environ["GITHUB_OUTPUT"]).read_text().splitlines())
        assert out == {"found": "true", "key": a["cache_key"], "sha": a["artifact_sha256"],
                       "pinned": "false", "pin_blocked": "false", "pin_reason": "", "registry": "ok"}
        assert cache.restore(out["key"], ws_forecast)

        # ... a retrain finishes meanwhile: artifact B (newer code and data), published
        b = _train(cache, db, "300", commit_h=6, cutoff="2026-11-02")

        # ... and the forecast run ends. It has no save step for a restored model (pinned by
        # the workflow contract test below); even asked to, it cannot publish A or make a key.
        assert ma.cmd_key(None, db=db) == 1
        assert ma.cmd_publish(_Args("true"), db=db) == 1
        refusals = [r["error_message"] for r in db.beats(*ma.RETRAIN_HEARTBEAT)]
        assert refusals and all("not trained by this workflow run" in m for m in refusals)

        # the OLD workflow's failure mode, for contrast: it saved the restored pickle under a new
        # run key, and the next restore took the newest SAVED entry: A again
        cache.save("hrv-model-Linux-v1-200", ws_forecast)
        with _workspace() as ws_old:
            assert cache.restore("hrv-model-Linux-v1-999", ws_old, prefix="hrv-model-Linux-")
            old = ma.sha256_bytes((ws_old / "analysis_output" / "xgboost_hrv_model.pkl").read_bytes())
            assert old == a["artifact_sha256"], "the synthetic cache reproduces the old race"

    assert {r["artifact_sha256"] for r in db.registry()} == {a["artifact_sha256"], b["artifact_sha256"]}

    # the next forecast run serves B, restored by its exact key
    with _workspace() as ws_next, _environ(**_run_env("400"), GITHUB_OUTPUT=str(Path(ws_next) / "out")):
        assert ma.cmd_select(None, db=db) == 0
        out = dict(line.split("=", 1) for line in
                   Path(os.environ["GITHUB_OUTPUT"]).read_text().splitlines())
        assert out["sha"] == b["artifact_sha256"] and out["key"] == b["cache_key"]
        assert cache.restore(out["key"], ws_next)
        loaded = ma.load_artifact(Path("analysis_output") / "xgboost_hrv_model.pkl",
                                  expected_sha=out["sha"], alignment_version=al.ALIGNMENT_VERSION,
                                  preprocessing_versions=h.SPARSE_FILL_VERSIONS,
                                  runtime_deps=ma.dependency_versions())
        assert loaded.sha256 == b["artifact_sha256"]
    print("PASS: an old forecast run finishing after a retrain cannot bring the old model back")


# ── 5: failed training, retries ──────────────────────────────────────────────────────────────

def test_a_failed_or_unsaved_training_never_advances_the_registry():
    db = _FakeDb()
    with _workspace() as ws, _environ(**_run_env("600")):
        # the training wrote nothing (it crashed before saving the model)
        assert ma.cmd_key(None, db=db) == 1
        assert ma.cmd_publish(_Args("true"), db=db) == 1
        assert db.registry() == []

        manifest = ma.write_artifact(_bundle(), _provenance(run_id="600", deps=ma.dependency_versions()),
                                     Path("analysis_output") / "xgboost_hrv_model.pkl")
        # the cache save did not stick (confirm step found nothing)
        assert ma.cmd_publish(_Args(""), db=db) == 1
        assert db.registry() == []
        assert "not in the Actions cache" in db.beats(*ma.RETRAIN_HEARTBEAT)[-1]["error_message"]

        # the registry write failed: nothing advanced, no exception text in the heartbeat
        db.fail_writes.add(ma.REGISTRY_TABLE)
        assert ma.cmd_publish(_Args("true"), db=db) == 1
        db.fail_writes.clear()
        assert db.registry() == []
        last = db.beats(*ma.RETRAIN_HEARTBEAT)[-1]
        assert last["status"] == "partial" and "registry write failed" in last["error_message"]
        assert "SECRET-MARKER" not in last["error_message"]

        # the pickle changed after its manifest was written
        good = (ws / "analysis_output" / "xgboost_hrv_model.pkl").read_bytes()
        (ws / "analysis_output" / "xgboost_hrv_model.pkl").write_bytes(good + b"\x00")
        assert ma.cmd_key(None, db=db) == 1
        assert ma.cmd_publish(_Args("true"), db=db) == 1
        assert db.beats(*ma.RETRAIN_HEARTBEAT)[-1]["error_message"].startswith("GUARD model_publish:")
        (ws / "analysis_output" / "xgboost_hrv_model.pkl").write_bytes(good)
        assert db.registry() == []

        # a retried publish after the fix stores it once
        assert ma.cmd_publish(_Args("true"), db=db) == 0
        assert [r["artifact_sha256"] for r in db.registry()] == [manifest["artifact_sha256"]]

    # no training commit time (git metadata unreadable): it could not be ordered against other
    # artifacts, so it is neither cached under a key nor published
    db4 = _FakeDb()
    with _workspace(), _environ(**_run_env("650")):
        ma.write_artifact(_bundle(), _provenance(run_id="650", commit_time_known=False),
                          Path("analysis_output") / "xgboost_hrv_model.pkl")
        assert ma.cmd_key(None, db=db4) == 1
        assert ma.cmd_publish(_Args("true"), db=db4) == 1
        assert db4.registry() == []
        last = db4.beats(*ma.RETRAIN_HEARTBEAT)[-1]
        assert last["status"] == "partial" and "no training commit time" in last["error_message"]

    # trained on a branch: its cache entry is not visible to master, so never published
    db2 = _FakeDb()
    with _workspace(), _environ(**_run_env("700", ref="refs/heads/feature")):
        ma.write_artifact(_bundle(), _provenance(run_id="700"), Path("analysis_output") / "xgboost_hrv_model.pkl")
        assert ma.cmd_publish(_Args("true"), db=db2) == 0
        assert db2.registry() == [] and db2.beats(*ma.RETRAIN_HEARTBEAT) == []

    # outside GitHub Actions nothing is published and nothing is reported
    db3 = _FakeDb()
    with _workspace(), _environ(RUNNER_OS=OS):
        ma.write_artifact(_bundle(), _provenance(run_id="800"), Path("analysis_output") / "xgboost_hrv_model.pkl")
        assert ma.cmd_publish(_Args("true"), db=db3) == 1
        assert db3.registry() == [] and db3.tables.get("sync_log") is None
    print("PASS: a failed, unsaved, tampered or unorderable training never reaches the registry")


def test_publishing_again_changes_nothing():
    db = _FakeDb()
    with tempfile.TemporaryDirectory() as tmp:
        manifest = _write(Path(tmp) / "xgboost_hrv_model.pkl", run_id="900")
        assert ma.publish(db, manifest) == "published"
        assert ma.publish(db, manifest) == "already_published"
        assert len(db.registry()) == 1
        row = db.registry()[0]
        assert row["provenance"] == json.loads(json.dumps(manifest["provenance"]))
        assert row["data_cutoff"] == "2026-11-01" and row["training_sha"] == "c" * 40
        assert row["dependency_fingerprint"] == ma.dependency_fingerprint(DEPS)

        # a retired artifact published again stays retired
        row["retired_at"] = T0.isoformat()
        assert ma.publish(db, manifest) == "already_published"
        assert db.registry()[0]["retired_at"] == T0.isoformat()

        # the same checksum registered with other provenance (never expected) is refused
        db2 = _FakeDb()
        other = json.loads(json.dumps(manifest))
        other["provenance"]["data_cutoff"] = "2026-10-01"
        db2.tables[ma.REGISTRY_TABLE] = [ma.registry_row(other)]
        _refused(lambda: ma.publish(db2, manifest), "other provenance")
        assert len(db2.registry()) == 1
    print("PASS: publishing the same artifact again is a no-op")


def test_publish_reports_its_outcome_to_the_workflow():
    """'publish' writes publish=published|already_published|not_published to $GITHUB_OUTPUT, so
    the forecast heartbeat can tell a confirmed publication from a failed or skipped one; a
    failed publish writes no output (the workflow derives 'not_published' from the outcome)."""
    import io
    import contextlib as cl

    def run_publish(db, run_id, saved="true", ref=MASTER):
        buf = io.StringIO()
        with tempfile.TemporaryDirectory() as tmp, _workspace(), \
                _environ(**_run_env(run_id, ref=ref), GITHUB_OUTPUT=str(Path(tmp) / "out")):
            ma.write_artifact(_bundle(), _provenance(run_id=run_id, deps=ma.dependency_versions()),
                              Path("analysis_output") / "xgboost_hrv_model.pkl")
            with cl.redirect_stdout(buf):
                code = ma.cmd_publish(_Args(saved), db=db)
            out_file = Path(os.environ["GITHUB_OUTPUT"])
            outputs = dict(line.split("=", 1) for line in
                           (out_file.read_text().splitlines() if out_file.exists() else []))
        return code, outputs, buf.getvalue()

    db = _FakeDb()
    code, outputs, printed = run_publish(db, "910")
    assert code == 0 and outputs == {"publish": "published"}
    assert "publish=published" in printed
    # the same run publishing again (a retried publish step: same run id and attempt, so the
    # same bytes and provenance): already_published, still a confirmed publication
    code, outputs, printed = run_publish(db, "910")
    assert code == 0 and outputs == {"publish": "already_published"}
    assert len(db.registry()) == 1
    # a later run (911) trained a new artifact: it is published as its own row
    code, outputs, printed = run_publish(db, "911")
    assert code == 0 and outputs == {"publish": "published"}
    assert len(db.registry()) == 2
    # the guard: the artifact on disk was trained by run 910, but this job is run 912 (not the
    # training run): refused, no output, nothing written, the registry is unchanged
    db6 = _FakeDb()
    with _workspace(), _environ(**_run_env("912")):
        ma.write_artifact(_bundle(), _provenance(run_id="910", deps=ma.dependency_versions()),
                          Path("analysis_output") / "xgboost_hrv_model.pkl")
        assert ma.cmd_publish(_Args("true"), db=db6) == 1
        assert db6.registry() == []
    # the cache confirm step found nothing: not published, and no output is trusted from it
    db2 = _FakeDb()
    code, outputs, _ = run_publish(db2, "912", saved="")
    assert code == 1 and outputs == {} and db2.registry() == []
    # a branch training: reported, never published
    db3 = _FakeDb()
    code, outputs, _ = run_publish(db3, "913", ref="refs/heads/feature")
    assert code == 0 and outputs == {"publish": "not_published"} and db3.registry() == []
    print("PASS: the publish step reports its outcome; failures write no output")


def _select_output(db) -> dict:
    with _workspace() as ws, _environ(RUNNER_OS=OS):
        out_file = ws / "out"
        os.environ["GITHUB_OUTPUT"] = str(out_file)
        assert ma.cmd_select(None, db=db) == 0, "select reports through its outputs, never by failing"
        text = out_file.read_text()
        assert "SECRET-MARKER" not in text
        return dict(line.split("=", 1) for line in text.splitlines())


def test_select_reports_the_registry_state_and_never_fails():
    db = _FakeDb()
    out = _select_output(db)                                    # empty registry: train one
    assert out == {"found": "false", "key": "", "sha": "", "pinned": "false",
                   "pin_blocked": "false", "pin_reason": "", "registry": "ok"}

    db.missing_tables.add(ma.REGISTRY_TABLE)                    # SQL not applied: legacy restore
    out = _select_output(db)
    assert out["registry"] == "not_applied" and out["found"] == "false"
    db.missing_tables.clear()

    db.fail_reads.add(ma.REGISTRY_TABLE)                        # unreadable: fail closed
    out = _select_output(db)
    assert out["registry"] == "error" and out["found"] == "false" and out["pinned"] == "false"
    db.fail_reads.clear()

    # a pin is reported, so the workflow never trains a replacement for it
    with tempfile.TemporaryDirectory() as tmp:
        manifest = _write(Path(tmp) / "xgboost_hrv_model.pkl", run_id="1100",
                          deps=ma.dependency_versions())
        assert ma.publish(db, manifest) == "published"
    out = _select_output(db)
    assert out["found"] == "true" and out["pinned"] == "false" and out["registry"] == "ok"
    db.registry()[0]["pinned"] = True
    out = _select_output(db)
    assert out["found"] == "true" and out["pinned"] == "true" and out["pin_blocked"] == "false"

    # a pin this code cannot serve (e.g. a dependency upgrade after the pin was set): nothing is
    # restored, and pinned=true keeps the workflow from training a replacement
    with tempfile.TemporaryDirectory() as tmp:
        newer = _write(Path(tmp) / "xgboost_hrv_model.pkl", run_id="1200", commit_offset_h=48,
                       deps=ma.dependency_versions())
        assert ma.publish(db, newer) == "published"
    db.registry()[0]["alignment_version"] = "other_rule_v0"
    out = _select_output(db)
    assert out["found"] == "false" and out["key"] == "" and out["sha"] == ""
    assert out["pinned"] == "true" and out["pin_blocked"] == "true" and out["registry"] == "ok"
    assert out["pin_reason"].startswith("pinned artifact ") and "alignment" in out["pin_reason"]
    db.registry()[0]["pinned"] = False                       # unpinned: the newest servable row
    out = _select_output(db)
    assert out["found"] == "true" and out["sha"] == newer["artifact_sha256"]
    assert out["pinned"] == "false" and out["pin_blocked"] == "false"
    print("PASS: select says ok / not_applied / error / pin_blocked and never fails the job")


def test_registry_not_applied_is_only_the_missing_table():
    class E(Exception):
        def __init__(self, code, message):
            super().__init__(message)
            self.code, self.message = code, message

    t = ma.REGISTRY_TABLE
    assert ma.registry_not_applied(E("PGRST205", f"Could not find the table 'pds.{t}' in the schema cache"))
    assert ma.registry_not_applied(E("42P01", f'relation "pds.{t}" does not exist'))
    assert not ma.registry_not_applied(E("PGRST205", "Could not find the table 'pds.other' in the schema cache"))
    assert not ma.registry_not_applied(E("PGRST301", "JWT expired"))
    assert not ma.registry_not_applied(E("57014", "canceling statement due to statement timeout"))
    assert not ma.registry_not_applied(RuntimeError("connection reset"))
    print("PASS: only a missing registry table counts as not applied; every other failure is an error")


def test_forecast_fails_closed_without_a_checked_registry_or_a_pinned_artifact():
    ok = {"HRV_MODEL_REGISTRY": "ok"}
    cases = [
        ({"HRV_MODEL_REGISTRY": "error"}, "registry"),
        ({"HRV_MODEL_REGISTRY": "error", "HRV_MODEL_RESTORED": "true"}, "registry"),
        ({**ok, "HRV_MODEL_SELECTED_SHA256": "a" * 64, "HRV_MODEL_PINNED": "true",
          "HRV_MODEL_RESTORED": "false"}, "pinned artifact " + "a" * 12),
        ({**ok, "HRV_MODEL_SELECTED_SHA256": "a" * 64, "HRV_MODEL_PINNED": "true"}, "pinned artifact"),
        # a pin this code cannot serve: the reason is the select step's, and nothing is trained
        ({**ok, "HRV_MODEL_PINNED": "true", "HRV_MODEL_PIN_BLOCKED": "true",
          "HRV_MODEL_PIN_REASON": "pinned artifact " + "a" * 12 + " cannot be served by this code "
                                  "(packages: xgboost 2.1.2 at training, 2.1.3 here)"},
         "xgboost 2.1.2 at training"),
        ({**ok, "HRV_MODEL_PIN_BLOCKED": "true"}, "never replaced by another model"),
    ]
    for env, fragment in cases:
        why = ma.serving_refusal(env)
        assert why and why.startswith("GUARD model_artifact:") and fragment in why, (env, why)
    for env in (
        {}, ok, {"HRV_MODEL_REGISTRY": "not_applied"},
        {**ok, "HRV_MODEL_SELECTED_SHA256": "a" * 64, "HRV_MODEL_PINNED": "true", "HRV_MODEL_RESTORED": "true"},
        # an unpinned selected artifact that was evicted is replaced by this run's own training
        {**ok, "HRV_MODEL_SELECTED_SHA256": "a" * 64, "HRV_MODEL_PINNED": "false", "HRV_MODEL_RESTORED": "false"},
        {**ok, "HRV_MODEL_PIN_BLOCKED": "false"},
    ):
        assert ma.serving_refusal(env) is None, env
    print("PASS: an unreadable registry, an unservable pin or a lost pinned artifact refuses the forecast outright")


# ── 6: forecasts name their artifact ─────────────────────────────────────────────────────────

class _MissingColumn(Exception):
    code = "PGRST204"
    message = f"Could not find the '{ma.LINK_COLUMN}' column of 'hrv_predictions' in the schema cache"


def test_upsert_falls_back_while_the_column_is_missing():
    calls = []

    def missing(rows):
        calls.append(rows)
        if len(calls) == 1:
            raise _MissingColumn(_MissingColumn.message)

    rows = [{"model": "xgboost", ma.LINK_COLUMN: "a" * 64}, {"model": "sarimax"}]
    assert ma.upsert_with_artifact_link(missing, rows) is False
    assert len(calls) == 2 and all(ma.LINK_COLUMN not in r for r in calls[1])

    stored = []
    assert ma.upsert_with_artifact_link(stored.append, rows) is True
    assert stored == [rows]

    def other_error(_rows):
        raise RuntimeError("connection reset")
    try:
        ma.upsert_with_artifact_link(other_error, rows)
        raise AssertionError("an unrelated error must not be swallowed")
    except RuntimeError:
        pass
    print("PASS: forecasts are stored without the link only while the column does not exist")


def _live_frame() -> pd.DataFrame:
    today = al.behavioral_today()
    return pd.DataFrame({
        "calendar_date": [(today - timedelta(days=1)).isoformat(), today.isoformat()],
        "whoop_hrv_rmssd": [52.0, NAN],
        "hrv_lag1": [50.0, 52.0],
        "f_a": [1.0, 2.0],
        "f_b": [3.0, 4.0],
    })


def _patch_predict(hp, db, stored):
    hp.supa = db
    hp._shared_log_sync = db.write_beat
    frame = _live_frame()
    hp.get_latest_features = lambda feat_cols: (frame, frame[feat_cols])
    hp.backfill_actuals = lambda: 0
    hp.recompute_rolling_metrics = lambda: None
    hp.check_drift = lambda *_a, **_k: None
    hp.latest_live_mae = lambda *_a, **_k: None
    hp._store_forecast = stored


def _run_main(hp) -> int:
    old_argv = sys.argv
    sys.argv = ["hrv_predict.py", "--predict"]
    try:
        hp.main()
        return 0
    except SystemExit as e:
        return int(e.code or 0)
    finally:
        sys.argv = old_argv


def test_each_forecast_names_the_artifact_that_made_it():
    import hrv_predict as hp
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "xgboost_hrv_model.pkl"
        manifest = ma.write_artifact(
            _bundle(preprocessing=h.SPARSE_FILL_VERSION),
            _provenance(run_id="1000", preprocessing=h.SPARSE_FILL_VERSION,
                        deps=ma.dependency_versions()), path, os_name=OS)
        sha = manifest["artifact_sha256"]
        hp.MODEL_PATH = path
        db, stored = _FakeDb(), []
        _patch_predict(hp, db, stored.append)
        selected = {"HRV_MODEL_REGISTRY": "ok", "HRV_MODEL_SELECTED_SHA256": sha,
                    "HRV_MODEL_RESTORED": "true", "RUNNER_OS": OS}
        beats = lambda: db.beats(*hp.MODEL_ARTIFACT_HEARTBEAT)  # noqa: E731

        # (a) the selected artifact, exactly restored: the forecast row names it
        with _environ(**selected):
            assert _run_main(hp) == 0
        assert len(stored) == 1 and stored[0][0][ma.LINK_COLUMN] == sha
        assert stored[0][0]["predicted_hrv"] == 55.0
        assert beats() == [], "success is written only to clear an earlier problem"

        # (b) the column does not exist yet: stored without it, partial heartbeat
        stored.clear()
        first = []

        def missing_then_ok(rows):
            first.append(rows)
            if len(first) == 1:
                raise _MissingColumn(_MissingColumn.message)
            stored.append(rows)
        hp._store_forecast = missing_then_ok
        with _environ(**selected):
            assert _run_main(hp) == 0
        assert len(stored) == 1 and ma.LINK_COLUMN not in stored[0][0]
        assert beats()[-1]["status"] == "partial" and ma.LINK_COLUMN in beats()[-1]["error_message"]

        # (c) back to normal: one success row clears it
        hp._store_forecast = stored.append
        with _environ(**selected):
            assert _run_main(hp) == 0
        assert beats()[-1]["status"] == "success" and beats()[-1]["error_message"] is None

        # (d) the restored file is not the selected artifact: refused, nothing stored
        stored.clear()
        with _environ(**{**selected, "HRV_MODEL_SELECTED_SHA256": "f" * 64}):
            assert _run_main(hp) == 1
        assert stored == []
        assert beats()[-1]["status"] == "failed"
        assert beats()[-1]["error_message"].startswith("GUARD model_artifact:")

        # (e) the registry table is not applied yet: forecast made, reported partial
        with _environ(HRV_MODEL_REGISTRY="not_applied", RUNNER_OS=OS):
            assert _run_main(hp) == 0
        assert stored and stored[-1][0][ma.LINK_COLUMN] == sha
        assert beats()[-1]["status"] == "partial" and "not set up yet" in beats()[-1]["error_message"]

        # (e2) the registry could not be read: no forecast, however good the file on disk is
        stored.clear()
        with _environ(HRV_MODEL_REGISTRY="error", RUNNER_OS=OS):
            assert _run_main(hp) == 1
        assert stored == []
        assert beats()[-1]["status"] == "failed"
        assert beats()[-1]["error_message"].startswith("GUARD model_artifact:")
        assert "registry" in beats()[-1]["error_message"]

        # (e3) a pinned artifact that is no longer in the cache: no forecast, no other model
        with _environ(**{**selected, "HRV_MODEL_PINNED": "true", "HRV_MODEL_RESTORED": "false"}):
            assert _run_main(hp) == 1
        assert stored == []
        assert beats()[-1]["status"] == "failed" and "pinned artifact" in beats()[-1]["error_message"]
        assert "never replaced" in beats()[-1]["error_message"]
        # (e3b) a pin this code cannot serve (dependency upgrade): no forecast, whatever file is
        # on disk, and the heartbeat carries the select step's reason
        reason = ("pinned artifact " + sha[:12] + " cannot be served by this code "
                  "(packages: xgboost 2.1.2 at training, 2.1.3 here)")
        with _environ(HRV_MODEL_REGISTRY="ok", HRV_MODEL_PINNED="true", HRV_MODEL_PIN_BLOCKED="true",
                      HRV_MODEL_PIN_REASON=reason, RUNNER_OS=OS):
            assert _run_main(hp) == 1
        assert stored == []
        assert beats()[-1]["status"] == "failed" and reason in beats()[-1]["error_message"]
        assert beats()[-1]["error_message"].startswith("GUARD model_artifact:")
        # the same pin, restored: served as selected, the heartbeat clears
        with _environ(**{**selected, "HRV_MODEL_PINNED": "true"}):
            assert _run_main(hp) == 0
        assert stored and stored[-1][0][ma.LINK_COLUMN] == sha
        assert beats()[-1]["status"] == "success"

        # (f) the heartbeat writer failing never stops the forecast
        def broken(*_a, **_k):
            raise RuntimeError("synthetic write failure")
        hp._shared_log_sync = broken
        stored.clear()
        with _environ(**{**selected, "HRV_MODEL_REGISTRY": "not_applied"}):
            assert _run_main(hp) == 0
        assert stored
    print("PASS: every forecast row names its artifact; every unchecked path is a partial or failed heartbeat")


def test_the_retrain_links_its_own_live_row():
    sent = []
    original = h.upsert_batch
    h.upsert_batch = lambda table, rows, conflict: sent.append((table, rows))
    try:
        h.store_predictions({"tomorrow_pred": 50.0, "serve_date": "2026-11-01", "pred_std": 5.0,
                             "artifact_sha256": "d" * 64}, {}, {}, {})
    finally:
        h.upsert_batch = original
    assert sent and sent[0][0] == "hrv_predictions"
    live = [r for r in sent[0][1] if r["model"] == "xgboost"]
    assert live and live[0][ma.LINK_COLUMN] == "d" * 64

    src = (ROOT / "hrv_analysis.py").read_text(encoding="utf-8")
    body = src.split("def train_xgboost(", 1)[1].split("\ndef ", 1)[0]
    assert "model_artifact.write_artifact(" in body and "pickle.dump(" not in body
    assert "data_cutoff=" in body and "preprocessing_version=SPARSE_FILL_VERSION" in body
    print("PASS: the retrain writes one artifact and links its own live forecast row")


# ── 7: workflows and SQL ─────────────────────────────────────────────────────────────────────

def _steps(workflow: str, job: str) -> list[dict]:
    import yaml
    doc = yaml.safe_load((ROOT / ".github" / "workflows" / workflow).read_text(encoding="utf-8"))
    return doc["jobs"][job]["steps"]


def _model_steps(steps: list[dict]) -> list[tuple[int, dict]]:
    return [(i, s) for i, s in enumerate(steps)
            if "xgboost_hrv_model" in str((s.get("with") or {}).get("path", ""))]


def _index(steps: list[dict], fragment: str) -> int:
    hits = [i for i, s in enumerate(steps) if fragment in str(s.get("run", ""))]
    assert len(hits) == 1, (fragment, hits)
    return hits[0]


MODEL_PATHS = {"analysis_output/xgboost_hrv_model.pkl", "analysis_output/xgboost_hrv_model.manifest.json"}


def _paths(step: dict) -> set[str]:
    return {p.strip() for p in str(step["with"]["path"]).splitlines() if p.strip()}


def test_forecast_workflow_never_saves_a_restored_model():
    steps = _steps("hrv-prediction.yml", "hrv-predict")
    model = _model_steps(steps)
    assert model, "the forecast workflow restores a model"
    for _i, s in model:
        uses = s.get("uses", "")
        assert uses.startswith(("actions/cache/restore@", "actions/cache/save@")), (
            "the combined actions/cache action saves whatever it restored at the end of the job: "
            f"{s.get('name')}")
        assert "github.run_id" not in str(s["with"].get("key", "")), s.get("name")
    select = _index(steps, "hrv_model_artifact.py select")
    train = _index(steps, "hrv_analysis.py --skip-analysis")
    key = _index(steps, "hrv_model_artifact.py key")
    publish = _index(steps, "hrv_model_artifact.py publish")
    predict = _index(steps, "hrv_predict.py --predict")
    assert select < min(i for i, _ in model) and select < train < key < publish < predict
    assert "hashFiles('analysis_output/xgboost_hrv_model.pkl') == ''" in steps[train]["if"]
    # no replacement training when the registry could not be read, or for a pinned artifact that
    # is gone from the cache (hrv_predict.py then refuses the forecast, see serving_refusal)
    assert "steps.select.outputs.registry != 'error'" in steps[train]["if"]
    assert "steps.select.outputs.pinned != 'true'" in steps[train]["if"]
    assert "steps.select.outputs.pin_blocked != 'true'" in steps[train]["if"]
    assert steps[key]["if"] == "steps.self-train.outcome == 'success'"
    saves = [(i, s) for i, s in model if s["uses"].startswith("actions/cache/save@")]
    assert len(saves) == 1, "one save: the model trained in this run"
    i, save = saves[0]
    assert key < i < publish
    assert save["if"] == "steps.trained.outcome == 'success'"
    assert save["with"]["key"] == "${{ steps.trained.outputs.key }}"
    assert steps[publish]["if"] == "steps.trained.outcome == 'success'"
    assert steps[publish].get("id") == "publish", "the forecast step reads the publish outcome"
    assert "${{ steps.saved.outputs.cache-hit }}" in steps[publish]["run"]
    exact = next(s for _, s in model if s.get("id") == "model-cache")
    assert exact["with"]["key"] == "${{ steps.select.outputs.key }}" and "restore-keys" not in exact["with"]
    for _i, s in model:
        if "v2" in str(s["with"].get("key", "")) or s.get("id") in ("model-cache", "saved") or \
                s["uses"].startswith("actions/cache/save@"):
            assert _paths(s) == MODEL_PATHS, f"same paths = same cache version: {s.get('name')}"
    env = steps[predict]["env"]
    assert env["HRV_MODEL_PINNED"] == "${{ steps.select.outputs.pinned }}"
    assert env["HRV_MODEL_PIN_BLOCKED"] == "${{ steps.select.outputs.pin_blocked }}"
    assert env["HRV_MODEL_PIN_REASON"] == "${{ steps.select.outputs.pin_reason }}"
    assert env["HRV_MODEL_SELECTED_SHA256"] == "${{ steps.select.outputs.sha }}"
    assert env["HRV_MODEL_RESTORED"] == "${{ steps.model-cache.outputs.cache-hit }}"
    assert env["HRV_MODEL_REGISTRY"] == "${{ steps.select.outputs.registry }}"
    # the publication outcome of a model trained in this run reaches the forecast heartbeat:
    # the publish step's output when it succeeded, not_published when it failed or was skipped
    # after a training, not_attempted when nothing was trained here.
    publish_env = env["HRV_MODEL_PUBLISH"]
    assert "steps.publish.outcome == 'success'" in publish_env
    assert "steps.publish.outputs.publish" in publish_env
    assert "steps.trained.outcome == 'success' && 'not_published'" in publish_env
    assert "'not_attempted'" in publish_env
    assert "steps.self-train.outcome != 'failure'" in steps[predict]["if"]
    assert "steps.select.outcome == 'success'" in steps[predict]["if"], "not after a failed setup step"
    # the legacy restore is for the table-not-applied window only; nothing is restored on an error
    for _i, step in model:
        cond = str(step.get("if", ""))
        if "registry" in cond:
            assert "registry == 'not_applied'" in cond and "'error'" not in cond, step.get("name")
    assert all(i < predict for i, s in saves), "nothing is saved after the forecast"
    print("PASS: the forecast workflow saves and publishes only a model it trained itself")


def test_retrain_publishes_only_after_the_whole_training():
    steps = _steps("hrv-retrain-on-backfill.yml", "check-and-retrain")
    train = _index(steps, "python hrv_analysis.py")
    key = _index(steps, "hrv_model_artifact.py key")
    publish = _index(steps, "hrv_model_artifact.py publish")
    model = _model_steps(steps)
    saves = [i for i, s in model if s["uses"].startswith("actions/cache/save@")]
    assert len(saves) == 1 and train < key < saves[0] < publish
    for i in (key, *saves, publish):
        cond = steps[i].get("if", "")
        assert "always()" not in cond and "failure()" not in cond, steps[i].get("name")
        assert not steps[i].get("continue-on-error"), "a failed publish must be visible"
    assert steps[saves[0]]["with"]["key"] == "${{ steps.trained.outputs.key }}"
    assert "${{ steps.saved.outputs.cache-hit }}" in steps[publish]["run"]
    for _i, s in model:
        assert _paths(s) == MODEL_PATHS and "github.run_id" not in str(s["with"]["key"])
    print("PASS: the retrain publishes after the analysis, the save and a confirmed restore")


def test_sql_is_additive_and_service_role_only():
    sql = (ROOT / "sql" / "hrv_model_artifacts.sql").read_text(encoding="utf-8")
    banned = re.findall(r"(?i)\b(?:drop|truncate|delete)\w*", sql)
    assert banned == [], f"the migration must be additive (found {banned})"
    assert "CREATE TABLE IF NOT EXISTS pds.hrv_model_artifacts" in sql
    assert re.search(r"ALTER TABLE pds\.hrv_model_artifacts ENABLE ROW LEVEL SECURITY", sql)
    grants = re.findall(r"(?im)^GRANT\b.*?;", sql, flags=re.S)
    assert grants and all(re.search(r"TO service_role\s*;", g) for g in grants)
    assert "REVOKE ALL ON pds.hrv_model_artifacts FROM anon, authenticated" in sql
    assert "TO service_role USING (true)" in sql and "TO anon" not in sql and "TO authenticated" not in sql
    assert f"ADD COLUMN IF NOT EXISTS {ma.LINK_COLUMN}" in sql
    assert "BEFORE UPDATE ON pds.hrv_model_artifacts" in sql, "published provenance is immutable"
    # the key pattern in the table accepts exactly what cache_key() writes
    pattern = re.search(r"cache_key ~ '([^']+)'", sql).group(1)
    assert re.match(pattern, ma.cache_key("a" * 64, OS))
    assert not re.match(pattern, "hrv-model-Linux-v1-12345")
    # every column the publish writes exists in the table
    for column in ma.registry_row(_write_manifest_for_sql()).keys():
        assert re.search(rf"^\s+{column}\s", sql, flags=re.M), column
    print("PASS: the registry SQL is additive, service-role only and matches the publisher")


def _write_manifest_for_sql() -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        return _write(Path(tmp) / "xgboost_hrv_model.pkl")


def test_no_target_shift_and_no_secrets_in_logs():
    src = (ROOT / "hrv_model_artifact.py").read_text(encoding="utf-8")
    assert ".shift(" not in src
    # failures are logged as a category code, never the exception text
    for line in src.splitlines():
        if "log." in line and "{e}" in line:
            raise AssertionError(f"exception text in a log line: {line.strip()}")
    print("PASS: the artifact module builds no outcome and logs no exception text")


def test_durable_copy_survives_cache_eviction_and_blocks_a_failed_store():
    cache, db = _FakeCache(), _FakeDb()
    m = _train(cache, db, "700", commit_h=1, cutoff="2026-11-01")
    sha = m["artifact_sha256"]
    assert f"{sha}/xgboost_hrv_model.pkl" in db.files
    with _workspace() as ws:  # cache entry gone: only the bucket holds the artifact
        ma.restore_durable(db, sha)
        assert ma.sha256_bytes((ws / "analysis_output" / "xgboost_hrv_model.pkl").read_bytes()) == sha
    db.files[f"{sha}/xgboost_hrv_model.pkl"] = b"tampered"
    with _workspace() as ws:
        try:
            ma.restore_durable(db, sha)
            raise AssertionError("tampered copy restored")
        except ma.ArtifactError:
            assert not (ws / "analysis_output" / "xgboost_hrv_model.pkl").exists()
    cache2, db2 = _FakeCache(), _FakeDb()
    db2.fail_storage = True
    with _workspace() as ws, _environ(**_run_env("701")):
        man = ma.write_artifact(_bundle(), _provenance(run_id="701", commit_offset_h=1,
                                cutoff="2026-11-01", trained_offset_h=1, deps=ma.dependency_versions()),
                                Path("analysis_output") / "xgboost_hrv_model.pkl")
        cache2.save(man["cache_key"], ws)
        assert ma.cmd_publish(_Args("true"), db=db2) == 1
    assert db2.registry() == []
    print("PASS: durable copy restores after eviction; tampering and a failed store publish nothing")


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
