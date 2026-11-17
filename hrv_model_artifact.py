#!/usr/bin/env python3
"""
HRV model artifacts: publish each trained model once, serve a selected one (audit PIPE-08).

Until 2026-11-16 every hourly forecast run saved the pickle it had restored under a new Actions
cache key with the same prefix the retrain used, and a restore took the most recently saved
entry. A forecast run that restored the old model before a retrain finished, and ended after it,
saved the old model again as the newest, so the next run served it while forecasts looked current.

Now:
  * a training run (hrv_analysis.py) writes the pickle plus a sidecar manifest
    (xgboost_hrv_model.manifest.json) with its provenance: training commit and commit time, ref,
    workflow run, data cutoff, alignment and preprocessing versions, package versions and their
    fingerprint, the input-data hash, and the SHA-256 of the pickle bytes. The same provenance is
    inside the pickle, so the checksum covers it;
  * the artifact is cached under a content-addressed key (hrv-model-<os>-v2-<40 hex of the
    checksum>), which never holds anything else;
  * a training is published only when the whole training run succeeded, it ran on master, and its
    artifact can be restored from the cache: one row in pds.hrv_model_artifacts keyed on the
    checksum (sql/hrv_model_artifacts.sql), so publishing again changes nothing;
  * a forecast run reads the registry and never writes it. It serves the newest COMPATIBLE
    published artifact by provenance (training commit time, then data cutoff, then training
    time), never by when an entry was saved; a retired row is never served. A pin decides
    BEFORE compatibility: the newest pinned row is the artifact, and when this code or these
    packages cannot serve it nothing else is served or trained in its place. It fails closed:
    a registry that cannot be read (anything but "table not applied yet"), a pinned artifact
    this code cannot serve, or a pinned artifact that is no longer in the Actions cache, skips
    the forecast with a failed heartbeat instead of serving or training some other model;
  * before unpickling, hrv_predict.py checks the file against the selected checksum and against
    its manifest (checksum, alignment, preprocessing, packages), and every forecast row records the
    checksum of the artifact that produced it (pds.hrv_predictions.model_artifact_sha256).

CLI, run by the two HRV workflows (outputs go to $GITHUB_OUTPUT):
    python hrv_model_artifact.py select               # forecast: which artifact to restore
    python hrv_model_artifact.py key                  # training: cache key of the model just trained
    python hrv_model_artifact.py publish --saved true # training: add it to the registry

Logs carry checksum prefixes, dates and error categories only: never model contents, health
values or exception text (Actions logs are public).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import pickle
import platform
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import date, datetime, timezone
from importlib import metadata
from pathlib import Path
from typing import Callable, Iterable, Mapping

log = logging.getLogger("hrv_model_artifact")

MANIFEST_VERSION = 1
MODEL_PATH = Path("analysis_output") / "xgboost_hrv_model.pkl"
REGISTRY_TABLE = "hrv_model_artifacts"
# The forecast row column that names the artifact (sql/hrv_model_artifacts.sql).
LINK_COLUMN = "model_artifact_sha256"
# Only master's cache entries are visible to every later run; a branch-scoped entry is not.
DEFAULT_BRANCH_REF = "refs/heads/master"
REGISTRY_READ_LIMIT = 500

# Package versions recorded with every artifact (the fingerprint covers all of them). An artifact
# is served only where the packages installed here agree with the ones it was trained with:
#   * EXACT_PACKAGES must be identical. XGBoost does not promise that a pickle written by one
#     release loads, or predicts the same, in another (not even a patch release), and its
#     scikit-learn wrapper pickles the estimator state of the scikit-learn it ran with. Both
#     workflows install unpinned packages, so a new release makes older artifacts unservable;
#     the missing-model training then publishes a replacement built with the new packages.
#   * COMPATIBLE_PARTS must agree on their leading parts (Python minor, numpy major).
# A package missing on either side is not compared.
DEPENDENCY_PACKAGES = ("numpy", "pandas", "scikit-learn", "xgboost")
EXACT_PACKAGES = ("xgboost", "scikit-learn")
COMPATIBLE_PARTS = {"python": 2, "numpy": 1}

# A training that is not published reports on the HRV Retrain card (/status reads the newest row
# of this pair), because the hourly forecast then keeps serving the previous model.
RETRAIN_HEARTBEAT = ("hrv_analysis", "retrain")

_HEX40 = re.compile(r"^[0-9a-f]{40}$")
_HEX64 = re.compile(r"^[0-9a-f]{64}$")
_UTC_MIN = datetime.min.replace(tzinfo=timezone.utc)


class ArtifactError(Exception):
    """A model artifact that must not be served or published (the message says why)."""


@dataclass
class LoadedArtifact:
    bundle: dict
    sha256: str
    manifest: dict | None       # None = a pickle from before PIPE-08 (no provenance)


# ── small helpers ────────────────────────────────────────────────────────────────────────────

def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _is_hex(value, pattern: re.Pattern) -> bool:
    return isinstance(value, str) and bool(pattern.match(value))


def _utc_iso(value) -> str | None:
    """ISO-8601 in UTC for a datetime or an ISO string; None when it cannot be read."""
    if value is None or value == "":
        return None
    try:
        dt = value if isinstance(value, datetime) else datetime.fromisoformat(str(value).strip())
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


def _as_datetime(value) -> datetime:
    iso = _utc_iso(value)
    return datetime.fromisoformat(iso) if iso else _UTC_MIN


def _as_date(value) -> date:
    try:
        return date.fromisoformat(str(value)[:10])
    except (TypeError, ValueError):
        return date.min


def _date_str(value) -> str:
    """'YYYY-MM-DD' for a date, datetime, pandas Timestamp or ISO string."""
    d = _as_date(value)
    if d == date.min:
        raise ArtifactError(f"GUARD model_artifact: data cutoff {value!r} is not a date")
    return d.isoformat()


def runner_os(env: Mapping[str, str] | None = None) -> str:
    """The Actions runner OS (RUNNER_OS), letters only, as used in the cache key."""
    env = os.environ if env is None else env
    name = re.sub(r"[^A-Za-z]", "", env.get("RUNNER_OS") or platform.system() or "")
    return name or "unknown"


def cache_key(sha256: str, os_name: str) -> str:
    """Content-addressed Actions cache key: one key can only ever hold this artifact."""
    if not _is_hex(sha256, _HEX64):
        raise ArtifactError("GUARD model_artifact: not a SHA-256 checksum")
    return f"hrv-model-{os_name}-v2-{sha256[:40]}"


def manifest_path_for(model_path: Path) -> Path:
    return model_path.with_name(model_path.stem + ".manifest.json")


def _atomic_write(path: Path, data: bytes) -> None:
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


# ── provenance ───────────────────────────────────────────────────────────────────────────────

def dependency_versions() -> dict[str, str]:
    deps = {"python": platform.python_version()}
    for name in DEPENDENCY_PACKAGES:
        try:
            deps[name] = metadata.version(name)
        except metadata.PackageNotFoundError:
            pass
    return deps


def dependency_fingerprint(deps: Mapping[str, str]) -> str:
    return sha256_bytes("\n".join(f"{k}=={deps[k]}" for k in sorted(deps)).encode())


def _version_head(version: str, parts: int) -> tuple:
    head = []
    for piece in str(version).split(".")[:parts]:
        m = re.match(r"\d+", piece)
        head.append(m.group() if m else piece)
    return tuple(head)


def dependency_mismatch(recorded: Mapping | None, runtime: Mapping | None) -> str | None:
    """None when the recorded packages can be served by the runtime ones, else what differs."""
    for name in EXACT_PACKAGES:
        a = str((recorded or {}).get(name) or "").strip()
        b = str((runtime or {}).get(name) or "").strip()
        if a and b and a != b:
            return f"{name} {a} at training, {b} here"
    for name, parts in COMPATIBLE_PARTS.items():
        a = (recorded or {}).get(name)
        b = (runtime or {}).get(name)
        if not a or not b:
            continue
        if _version_head(a, parts) != _version_head(b, parts):
            return f"{name} {a} at training, {b} here"
    return None


def _git(args: list[str], run=subprocess.run) -> str | None:
    try:
        out = run(["git", *args], capture_output=True, text=True, timeout=10, check=False)
    except Exception:  # noqa: BLE001 - no git = unknown provenance, never a failed training
        return None
    text = (getattr(out, "stdout", "") or "").strip()
    return text if getattr(out, "returncode", 1) == 0 and text else None


def git_provenance(env: Mapping[str, str] | None = None, run=subprocess.run) -> dict:
    env = os.environ if env is None else env
    sha = env.get("GITHUB_SHA") or _git(["rev-parse", "HEAD"], run)
    sha = sha if _is_hex(sha, _HEX40) else None
    commit_time = _git(["log", "-1", "--format=%cI", sha], run) if sha else None
    return {
        "training_sha": sha,
        "training_commit_time": _utc_iso(commit_time),
        "training_ref": env.get("GITHUB_REF") or None,
    }


def training_run(env: Mapping[str, str] | None = None) -> dict:
    env = os.environ if env is None else env
    return {
        "workflow": env.get("GITHUB_WORKFLOW") or None,
        "job": env.get("GITHUB_JOB") or None,
        "run_id": env.get("GITHUB_RUN_ID") or None,
        "run_attempt": env.get("GITHUB_RUN_ATTEMPT") or None,
    }


def build_provenance(*, model_version: str, data_cutoff, training_rows: int,
                     feat_cols: Iterable[str], input_data_hash: str | None,
                     alignment_version: str, preprocessing_version: str,
                     now: datetime | None = None, env: Mapping[str, str] | None = None,
                     deps: Mapping[str, str] | None = None, git: Mapping | None = None) -> dict:
    """Everything a later run needs to decide whether, and which, model to serve."""
    env = os.environ if env is None else env
    deps = dependency_versions() if deps is None else dict(deps)
    git = git_provenance(env) if git is None else dict(git)
    feats = [str(c) for c in feat_cols]
    return {
        "manifest_version": MANIFEST_VERSION,
        "model_version": str(model_version),
        "trained_at": _utc_iso(now or datetime.now(timezone.utc)),
        "training_sha": git.get("training_sha"),
        "training_commit_time": git.get("training_commit_time"),
        "training_ref": git.get("training_ref"),
        "training_run": training_run(env),
        "data_cutoff": _date_str(data_cutoff),
        "training_rows": int(training_rows),
        "feature_count": len(feats),
        "feature_set_sha256": sha256_bytes("\n".join(feats).encode()),
        "input_data_hash": input_data_hash,
        "alignment_version": str(alignment_version),
        "preprocessing_version": str(preprocessing_version),
        "dependencies": deps,
        "dependency_fingerprint": dependency_fingerprint(deps),
    }


# ── writing and reading one artifact ─────────────────────────────────────────────────────────

def write_artifact(bundle: dict, provenance: dict, model_path: Path = MODEL_PATH,
                   os_name: str | None = None) -> dict:
    """Pickle `bundle` with its provenance and write the sidecar manifest. Returns the manifest.

    The pickle is replaced first: a crash between the two writes leaves a pickle whose checksum
    does not match the old manifest, which is refused (never served as another artifact)."""
    payload = dict(bundle)
    payload["provenance"] = provenance
    data = pickle.dumps(payload)
    sha = sha256_bytes(data)
    manifest = {
        "manifest_version": MANIFEST_VERSION,
        "artifact_sha256": sha,
        "size_bytes": len(data),
        "cache_key": cache_key(sha, os_name or runner_os()),
        "provenance": provenance,
    }
    model_path.parent.mkdir(parents=True, exist_ok=True)
    _atomic_write(model_path, data)
    _atomic_write(manifest_path_for(model_path),
                  (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode("utf-8"))
    return manifest


def read_manifest(path: Path) -> dict | None:
    if not path.exists():
        return None
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise ArtifactError(f"GUARD model_artifact: {path.name} is unreadable ({type(e).__name__})")
    if (not isinstance(manifest, dict) or not _is_hex(manifest.get("artifact_sha256"), _HEX64)
            or not isinstance(manifest.get("provenance"), dict)
            or not isinstance(manifest.get("cache_key"), str)):
        raise ArtifactError(f"GUARD model_artifact: {path.name} is malformed")
    return manifest


def incompatibility(prov: Mapping, *, alignment_version: str,
                    preprocessing_versions: Iterable[str], runtime_deps: Mapping | None) -> str | None:
    """None when this code can serve an artifact with this provenance, else the reason."""
    if prov.get("alignment_version") != alignment_version:
        return f"alignment {prov.get('alignment_version')!r}, this code {alignment_version!r}"
    known = tuple(preprocessing_versions)
    if prov.get("preprocessing_version") not in known:
        return f"preprocessing {prov.get('preprocessing_version')!r}, this code knows {', '.join(known)}"
    mismatch = dependency_mismatch(prov.get("dependencies"), runtime_deps)
    if mismatch:
        return f"packages: {mismatch}"
    return None


def load_artifact(model_path: Path = MODEL_PATH, *, expected_sha: str | None,
                  alignment_version: str, preprocessing_versions: Iterable[str],
                  runtime_deps: Mapping | None) -> LoadedArtifact:
    """Read, check and unpickle one artifact. Every check that can refuse it runs BEFORE the
    bytes are unpickled, and the bytes unpickled are the bytes that were checked."""
    if not model_path.exists():
        raise ArtifactError(f"No model to serve: {model_path} is missing (nothing restored, and the "
                            "missing-model training did not produce one).")
    data = model_path.read_bytes()
    sha = sha256_bytes(data)
    if expected_sha and sha != expected_sha:
        raise ArtifactError(f"GUARD model_artifact: the restored pickle is {sha[:12]}, the selected "
                            f"artifact is {expected_sha[:12]}. Forecast skipped.")
    manifest = read_manifest(manifest_path_for(model_path))
    if manifest is None and expected_sha:
        raise ArtifactError(f"GUARD model_artifact: selected artifact {sha[:12]} was restored without "
                            "its manifest. Forecast skipped.")
    if manifest is not None:
        if manifest["artifact_sha256"] != sha:
            raise ArtifactError(f"GUARD model_artifact: pickle {sha[:12]} does not match its manifest "
                                f"({manifest['artifact_sha256'][:12]}). Forecast skipped.")
        why = incompatibility(manifest["provenance"], alignment_version=alignment_version,
                              preprocessing_versions=preprocessing_versions, runtime_deps=runtime_deps)
        if why:
            raise ArtifactError(f"GUARD model_artifact: artifact {sha[:12]} cannot be served by this "
                                f"code ({why}). Forecast skipped; retrain "
                                "(gh workflow run hrv-retrain-on-backfill.yml).")
    try:
        bundle = pickle.loads(data)
    except Exception as e:  # noqa: BLE001 - an unloadable pickle is refused, never a crash
        raise ArtifactError(f"GUARD model_artifact: artifact {sha[:12]} could not be unpickled "
                            f"({type(e).__name__}). Forecast skipped.")
    if not isinstance(bundle, dict):
        raise ArtifactError(f"GUARD model_artifact: artifact {sha[:12]} is not a model bundle.")
    if manifest is not None and bundle.get("provenance") != manifest["provenance"]:
        raise ArtifactError(f"GUARD model_artifact: the provenance inside artifact {sha[:12]} differs "
                            "from its manifest. Forecast skipped.")
    return LoadedArtifact(bundle=bundle, sha256=sha, manifest=manifest)


def _trained_in_this_run(manifest: Mapping | None, env: Mapping[str, str]) -> bool:
    run = (manifest or {}).get("provenance", {}).get("training_run") or {}
    return (bool(env.get("GITHUB_RUN_ID")) and run.get("run_id") == env.get("GITHUB_RUN_ID")
            and run.get("run_attempt") == env.get("GITHUB_RUN_ATTEMPT"))


def serving_refusal(env: Mapping[str, str] | None = None) -> str | None:
    """Why no forecast may be made at all, whatever model file is on disk (None = go on).

    Fail closed, never serve or train another model in its place:
      * registry "error": the registry could not be read, so the model cannot be checked against
        publication, retirement or a pin (a retired model must not come back during an outage);
      * a pin this code cannot serve (another alignment rule, an unknown preprocessing version,
        other xgboost / scikit-learn packages, another runner): the pin is an explicit rollback,
        so an unpinned dependency upgrade must not silently select another model;
      * a pinned artifact that the exact-key restore did not bring back (GitHub evicts a cache
        entry after seven days without a restore): a model trained in its place would defeat
        the pin, and would be trained again on every run."""
    env = os.environ if env is None else env
    if env.get("HRV_MODEL_REGISTRY", "") == "error":
        return (f"GUARD model_artifact: the model registry pds.{REGISTRY_TABLE} could not be read, so "
                "the model cannot be checked against publication, retirement or a pin. Forecast "
                "skipped (no model is served or trained in its place).")
    if env.get("HRV_MODEL_PIN_BLOCKED", "") == "true":
        reason = (env.get("HRV_MODEL_PIN_REASON") or "the pinned artifact cannot be served").strip()[:300]
        return (f"GUARD model_artifact: {reason}. Forecast skipped (a pin is never replaced by another "
                "model, and nothing is trained in its place). Unpin or retire it "
                f"(UPDATE pds.{REGISTRY_TABLE} ...), then retrain "
                "(gh workflow run hrv-retrain-on-backfill.yml).")
    if env.get("HRV_MODEL_PINNED", "") == "true" and env.get("HRV_MODEL_RESTORED", "") != "true":
        selected = (env.get("HRV_MODEL_SELECTED_SHA256") or "")[:12]
        return (f"GUARD model_artifact: pinned artifact {selected} is no longer in the Actions cache. "
                "Forecast skipped (a pin is never replaced by another model). Unpin or retire it "
                f"(UPDATE pds.{REGISTRY_TABLE} ...), then retrain "
                "(gh workflow run hrv-retrain-on-backfill.yml).")
    return None


PUBLISHED_OUTCOMES = ("published", "already_published")


def serving_report(loaded: LoadedArtifact, env: Mapping[str, str] | None = None) -> tuple[str, str | None]:
    """Heartbeat status + message for the artifact a forecast is made with.

    The workflow passes HRV_MODEL_REGISTRY (ok | not_applied | error), HRV_MODEL_SELECTED_SHA256,
    HRV_MODEL_PINNED, HRV_MODEL_PIN_BLOCKED / HRV_MODEL_PIN_REASON, HRV_MODEL_RESTORED (the
    exact-key restore hit) and HRV_MODEL_PUBLISH (published | already_published | not_published |
    not_attempted: the outcome of publishing a model trained in this same run). Outside the
    workflow none is set. Registry "error", a pin this code cannot serve and a lost pinned
    artifact never get this far (serving_refusal).

    A model trained in this same run is success only when HRV_MODEL_PUBLISH confirms its
    publication: a failed or skipped publish leaves the registry unchanged, so the next run
    serves the previous model while the forecast looked healthy."""
    env = os.environ if env is None else env
    sha = loaded.sha256[:12]
    registry = env.get("HRV_MODEL_REGISTRY", "")
    selected = env.get("HRV_MODEL_SELECTED_SHA256", "")
    restored = env.get("HRV_MODEL_RESTORED", "") == "true"
    if loaded.manifest is None:
        unread = (f" The model registry pds.{REGISTRY_TABLE} is not set up yet."
                  if registry == "not_applied" else "")
        return "partial", (f"Model artifact {sha} has no training provenance (cached before audit "
                           f"PIPE-08); the next retrain publishes one.{unread}")
    trained_here = _trained_in_this_run(loaded.manifest, env)
    if registry == "not_applied":
        return "partial", (f"Model registry pds.{REGISTRY_TABLE} is not set up yet (apply "
                           "sql/hrv_model_artifacts.sql); forecast made with the newest cached "
                           f"training artifact {sha} without a registry check.")
    if selected:
        if restored and loaded.sha256 == selected:
            return "success", None
        if trained_here:
            return "partial", (f"Selected artifact {selected[:12]} was not in the Actions cache; "
                               f"forecast made with {sha}, trained in this run.")
        return "partial", f"Forecast made with artifact {sha}, not the selected {selected[:12]}."
    if registry == "ok":
        if trained_here:
            published = env.get("HRV_MODEL_PUBLISH", "")
            if published in PUBLISHED_OUTCOMES:
                return "success", None  # trained in this run and its publication was confirmed
            if published == "not_published":
                return "partial", (f"Model artifact {sha} was trained in this run, but publishing it "
                                   "failed or did not run; the forecast was made with it and the "
                                   "next run serves the previous published model.")
            if published == "not_attempted":
                return "partial", (f"Forecast made with model artifact {sha}, trained in this run; "
                                   "its publication was not attempted, so the next run serves the "
                                   "previous published model.")
            return "partial", (f"Forecast made with model artifact {sha}, trained in this run; its "
                               f"publication was not confirmed (HRV_MODEL_PUBLISH is "
                               f"{published!r}).")
        return "partial", f"Forecast made with artifact {sha}, which the registry did not select."
    return "success", None              # a run outside the workflow: the manifest checked out


def with_unlinked_forecast(report: dict) -> dict:
    """The report after a forecast was stored without its artifact column (SQL not applied)."""
    note = (f"Forecast stored without its artifact: pds.hrv_predictions has no {LINK_COLUMN} "
            "column yet (apply sql/hrv_model_artifacts.sql).")
    message = f"{report['message']} {note}" if report.get("message") else note
    status = "partial" if report.get("status") == "success" else report.get("status")
    return {**report, "status": status, "message": message}


def _missing_link_column(exc: BaseException) -> bool:
    code = str(getattr(exc, "code", "") or "")
    text = str(getattr(exc, "message", "") or exc)
    return LINK_COLUMN in text and (code in ("PGRST204", "42703") or "column" in text.lower())


def upsert_with_artifact_link(upsert: Callable[[list[dict]], None], rows: list[dict]) -> bool:
    """Store forecast rows with their artifact column. While the database does not have the
    column yet, store them once more without it. True when the link was stored."""
    try:
        upsert(rows)
        return True
    except Exception as e:  # noqa: BLE001 - anything else is re-raised below
        if not _missing_link_column(e):
            raise
    upsert([{k: v for k, v in r.items() if k != LINK_COLUMN} for r in rows])
    return False


# ── the registry ─────────────────────────────────────────────────────────────────────────────

def provenance_order(row: Mapping) -> tuple:
    """Newer training wins: commit time of the training code, then data cutoff, then training
    time; the checksum only breaks exact ties. Publish time and cache save time never count."""
    return (_as_datetime(row.get("training_commit_time")), _as_date(row.get("data_cutoff")),
            _as_datetime(row.get("trained_at")), str(row.get("artifact_sha256") or ""))


def pinned_rows(rows: Iterable[Mapping]) -> list[Mapping]:
    """Rows an operator pinned (rollback) that are not retired, whether or not this code can
    serve them: a pin is an explicit decision and is read before any compatibility check."""
    return [r for r in rows if not r.get("retired_at") and r.get("pinned") is True]


def _unservable(row: Mapping, *, alignment_version: str, preprocessing_versions: tuple,
                runtime_deps: Mapping | None, os_name: str) -> str | None:
    """None when this runner can restore and serve the registry row, else the reason."""
    sha = row.get("artifact_sha256")
    if not _is_hex(sha, _HEX64) or row.get("cache_key") != cache_key(sha, os_name):
        return "cache key for another runner or malformed row"
    return incompatibility(row, alignment_version=alignment_version,
                           preprocessing_versions=preprocessing_versions, runtime_deps=runtime_deps)


def select_artifact(rows: Iterable[Mapping], *, alignment_version: str,
                    preprocessing_versions: Iterable[str], runtime_deps: Mapping | None,
                    os_name: str) -> tuple[dict | None, list[str]]:
    """The registry row to serve (None if no row can be served) and why rows were skipped.

    A pin decides before compatibility: when any row is pinned the newest pinned row (by
    provenance) is THE artifact. If this code, these packages or this runner cannot serve it the
    answer is None with the reason, never another row: otherwise an unpinned dependency upgrade
    would silently undo an explicit rollback (the caller tells a blocked pin from an empty
    registry with pinned_rows)."""
    rows = list(rows)
    known = tuple(preprocessing_versions)
    check = dict(alignment_version=alignment_version, preprocessing_versions=known,
                 runtime_deps=runtime_deps, os_name=os_name)
    pins = pinned_rows(rows)
    if pins:
        target = max(pins, key=provenance_order)
        why = _unservable(target, **check)
        if why:
            sha = str(target.get("artifact_sha256") or "")[:12]
            return None, [f"pinned artifact {sha} cannot be served by this code ({why})"]
        return dict(target), []
    candidates, skipped = [], []
    for row in rows:
        if row.get("retired_at"):
            continue
        why = _unservable(row, **check)
        if why:
            skipped.append(why)
            continue
        candidates.append(dict(row))
    if not candidates:
        return None, skipped
    return max(candidates, key=provenance_order), skipped


def registry_row(manifest: Mapping) -> dict:
    p = manifest["provenance"]
    return {
        "artifact_sha256": manifest["artifact_sha256"],
        "cache_key": manifest["cache_key"],
        "size_bytes": int(manifest["size_bytes"]),
        "model_version": p["model_version"],
        "trained_at": p["trained_at"],
        "training_sha": p.get("training_sha"),
        "training_commit_time": p.get("training_commit_time"),
        "training_ref": p.get("training_ref"),
        "training_run": p.get("training_run") or {},
        "data_cutoff": p["data_cutoff"],
        "training_rows": p.get("training_rows"),
        "feature_count": p.get("feature_count"),
        "feature_set_sha256": p.get("feature_set_sha256"),
        "input_data_hash": p.get("input_data_hash"),
        "alignment_version": p["alignment_version"],
        "preprocessing_version": p["preprocessing_version"],
        "dependencies": p.get("dependencies") or {},
        "dependency_fingerprint": p["dependency_fingerprint"],
        "provenance": dict(p),
    }


def verify_local(model_path: Path = MODEL_PATH, os_name: str | None = None) -> dict:
    """The manifest of the artifact on disk, after checking it describes exactly these bytes."""
    manifest = read_manifest(manifest_path_for(model_path))
    if manifest is None or not model_path.exists():
        raise ArtifactError("Model not published: the training wrote no model artifact.")
    sha = sha256_bytes(model_path.read_bytes())
    if manifest["artifact_sha256"] != sha:
        raise ArtifactError(f"GUARD model_publish: pickle {sha[:12]} does not match its manifest "
                            f"({manifest['artifact_sha256'][:12]}); not published.")
    if manifest["cache_key"] != cache_key(sha, os_name or runner_os()):
        raise ArtifactError(f"GUARD model_publish: manifest cache key of {sha[:12]} is not this "
                            "runner's content key; not published.")
    return manifest


def run_problem(manifest: Mapping, env: Mapping[str, str]) -> str | None:
    """Why this job may not publish the artifact on disk (None = it may)."""
    if env.get("GITHUB_ACTIONS") != "true":
        return "Model not published: publishing runs only in GitHub Actions (the artifact must be in its cache)."
    if not _trained_in_this_run(manifest, env):
        return ("GUARD model_publish: the artifact on disk was not trained by this workflow run; "
                "not published.")
    if not _utc_iso(manifest["provenance"].get("training_commit_time")):
        # The registry orders artifacts by training commit time first; an artifact without one
        # would rank below every older artifact, so a newer training could never be served.
        return ("GUARD model_publish: the artifact has no training commit time (git metadata was "
                "not readable at training), so it cannot be ordered against other artifacts; "
                "not published.")
    return None


def publish(db, manifest: Mapping) -> str:
    """Add the artifact to the registry. 'published', or 'already_published' when the same
    checksum is there with the same provenance (a retried publish changes nothing)."""
    row = registry_row(manifest)
    sha = row["artifact_sha256"]

    def stored():
        resp = (db.schema("pds").from_(REGISTRY_TABLE)
                .select("artifact_sha256,cache_key,provenance,retired_at")
                .eq("artifact_sha256", sha).limit(1).execute())
        return (resp.data or [None])[0]

    def same(existing) -> bool:
        return (existing.get("cache_key") == row["cache_key"]
                and existing.get("provenance") == row["provenance"])

    existing = stored()
    if existing is not None:
        if not same(existing):
            raise ArtifactError(f"GUARD model_publish: artifact {sha[:12]} is already registered with "
                                "other provenance; not published.")
        return "already_published"
    db.schema("pds").from_(REGISTRY_TABLE).upsert(
        row, on_conflict="artifact_sha256", ignore_duplicates=True).execute()
    existing = stored()
    if existing is None:
        raise ArtifactError(f"Model not published: the registry did not keep artifact {sha[:12]}.")
    if not same(existing):
        raise ArtifactError(f"GUARD model_publish: artifact {sha[:12]} is registered with other "
                            "provenance; not published.")
    return "published"


# ── CLI ──────────────────────────────────────────────────────────────────────────────────────

def _github_output(pairs: Mapping[str, str]) -> None:
    lines = [f"{k}={v}" for k, v in pairs.items()]
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
    for line in lines:
        print(line)


def _error_code(exc: BaseException) -> str:
    try:
        from email_log_safety import error_code
        return error_code(exc)
    except Exception:  # noqa: BLE001
        return type(exc).__name__


def _client():
    try:
        from dotenv import load_dotenv
        load_dotenv()
    except ImportError:
        pass
    from supabase import create_client
    return create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])


def _report_unpublished(message: str, db=None) -> None:
    """Partial HRV Retrain heartbeat for a training that was not published (only inside GitHub
    Actions: a local run publishes nothing and reports nothing). Never raises."""
    if os.environ.get("GITHUB_ACTIONS") != "true":
        return
    try:
        from sync_log_helper import log_sync
        source, data_type = RETRAIN_HEARTBEAT
        log_sync(db if db is not None else _client(), source=source, data_type=data_type,
                 status="partial", records=0, error=message[:1000])
    except Exception as e:  # noqa: BLE001
        log.warning(f"  retrain heartbeat write failed ({_error_code(e)})")


SELECT_COLUMNS = ("artifact_sha256,cache_key,trained_at,training_commit_time,data_cutoff,"
                  "alignment_version,preprocessing_version,dependencies,pinned,retired_at")


def read_registry(db) -> list[dict]:
    """Published, not retired rows: the newest REGISTRY_READ_LIMIT plus every pinned one."""
    table = lambda: db.schema("pds").from_(REGISTRY_TABLE)  # noqa: E731
    newest = (table().select(SELECT_COLUMNS).is_("retired_at", "null")
              .order("trained_at", desc=True).limit(REGISTRY_READ_LIMIT).execute().data or [])
    pinned = (table().select(SELECT_COLUMNS).is_("retired_at", "null")
              .is_("pinned", "true").execute().data or [])
    rows = {r.get("artifact_sha256"): r for r in newest}
    for r in pinned:
        rows.setdefault(r.get("artifact_sha256"), r)
    return list(rows.values())


def registry_not_applied(exc: BaseException) -> bool:
    """True when the registry read failed because sql/hrv_model_artifacts.sql was never applied
    (the table is missing). Nothing can be retired or pinned then, so the forecast may still use
    the newest cached training; every other read failure is an error (fail closed)."""
    code = str(getattr(exc, "code", "") or "")
    text = str(getattr(exc, "message", "") or exc)
    return code in ("PGRST205", "42P01") and REGISTRY_TABLE in text


def cmd_select(_args, db=None) -> int:
    """Picks the artifact to restore. Never fails the job itself: registry=ok (a normal answer,
    found or not), registry=not_applied (table missing: legacy restore) or registry=error (the
    registry could not be read: the workflow restores and trains nothing, and hrv_predict.py
    refuses to forecast, see serving_refusal). pin_blocked=true: an active pin this code cannot
    serve (pinned=true too, so nothing is trained in its place; pin_reason says why)."""
    out = {"found": "false", "key": "", "sha": "", "pinned": "false", "pin_blocked": "false",
           "pin_reason": "", "registry": "error"}
    try:
        import hrv_alignment as al
        from hrv_analysis import SPARSE_FILL_VERSIONS
        rows = read_registry(db if db is not None else _client())
        out["registry"] = "ok"
        chosen, skipped = select_artifact(
            rows, alignment_version=al.ALIGNMENT_VERSION, preprocessing_versions=SPARSE_FILL_VERSIONS,
            runtime_deps=dependency_versions(), os_name=runner_os())
        if chosen:
            pinned = chosen.get("pinned") is True
            out.update(found="true", key=chosen["cache_key"], sha=chosen["artifact_sha256"],
                       pinned="true" if pinned else "false")
            log.info(f"Selected model artifact {chosen['artifact_sha256'][:12]} (trained "
                     f"{chosen.get('trained_at')}, data through {chosen.get('data_cutoff')}"
                     f"{', pinned' if pinned else ''}).")
        elif pinned_rows(rows):
            reason = " ".join((skipped or ["the pinned artifact cannot be served"])[0].split())
            out.update(pinned="true", pin_blocked="true", pin_reason=reason)
            log.error(f"{reason}: no model is restored or trained in its place, and the forecast "
                      "is skipped with a failed heartbeat.")
        else:
            log.warning(f"No published model this code can serve ({len(rows)} published, "
                        f"{len(skipped)} not compatible); the missing-model training step trains one.")
    except Exception as e:  # noqa: BLE001
        if registry_not_applied(e):
            out["registry"] = "not_applied"
            log.warning("Model registry is not set up yet (apply sql/hrv_model_artifacts.sql); the "
                        "newest cached training artifact is restored instead, with a partial "
                        "forecast heartbeat.")
        else:
            out["registry"] = "error"
            log.error(f"Model registry unreadable ({_error_code(e)}): no model is restored or "
                      "trained, and the forecast is skipped with a failed heartbeat.")
    _github_output(out)
    return 0


def cmd_key(_args, db=None) -> int:
    try:
        manifest = verify_local()
        problem = run_problem(manifest, os.environ)
        if problem:
            raise ArtifactError(problem)
    except ArtifactError as e:
        log.error(str(e))
        _report_unpublished(str(e), db)
        return 1
    _github_output({"key": manifest["cache_key"], "sha": manifest["artifact_sha256"]})
    return 0


def cmd_publish(args, db=None) -> int:
    """'publish' also reports its outcome to $GITHUB_OUTPUT (publish=published|already_published|
    not_published), so the workflow can pass it to the forecast step (HRV_MODEL_PUBLISH): a model
    trained in the same run counts as success only when its publication was confirmed. A failed
    publish writes no output; the workflow derives 'not_published' from the step outcome."""
    env = os.environ
    try:
        manifest = verify_local()
        problem = run_problem(manifest, env)
        if problem:
            raise ArtifactError(problem)
        sha = manifest["artifact_sha256"][:12]
        if env.get("GITHUB_REF") != DEFAULT_BRANCH_REF:
            log.warning(f"Artifact {sha} was trained on {env.get('GITHUB_REF')!r}, not master: not "
                        "published (its cache entry is visible to that branch only).")
            _github_output({"publish": "not_published"})
            return 0
        if args.saved != "true":
            raise ArtifactError(f"Model not published: artifact {sha} trained, but it is not in the "
                                "Actions cache; the forecast keeps serving the previous model.")
        db = db if db is not None else _client()
        outcome = publish(db, manifest)
    except ArtifactError as e:
        log.error(str(e))
        _report_unpublished(str(e), db)
        return 1
    except Exception as e:  # noqa: BLE001 - registry write failed: nothing advanced
        message = (f"Model not published: the registry write failed ({_error_code(e)}); the "
                   "forecast keeps serving the previous model.")
        log.error(message)
        _report_unpublished(message, db)
        return 1
    _github_output({"publish": outcome})
    log.info(f"Model artifact {sha} {outcome.replace('_', ' ')} (data through "
             f"{manifest['provenance'].get('data_cutoff')}).")
    return 0


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s",
                        datefmt="%H:%M:%S")
    parser = argparse.ArgumentParser(description="HRV model artifacts (audit PIPE-08)")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("select", help="forecast: pick the published artifact to restore")
    sub.add_parser("key", help="training: print the cache key of the artifact just trained")
    pub = sub.add_parser("publish", help="training: add the artifact just trained to the registry")
    pub.add_argument("--saved", default="", help="'true' when the exact cache key restores")
    args = parser.parse_args(argv)
    return {"select": cmd_select, "key": cmd_key, "publish": cmd_publish}[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
