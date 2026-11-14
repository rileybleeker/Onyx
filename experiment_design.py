"""N-of-1 experiment framework: allocation and protocol rules (pure, no I/O besides reading a file).

Design: docs/experiment-framework.md. This module holds everything that has to be reproducible
by an auditor from the published seed alone:

  * block_orderings()      the orderings one block can take (6 for 2 A + 2 B days)
  * generate_schedule()    seed -> arm per behavioral day, permuted blocks
  * seed_commitment()      sha256(seed), published in the protocol BEFORE the trial starts
  * redraw_blocks()        the same draw procedure, vectorized, for the randomization test
  * load_protocol() / validate_protocol()   the pre-registered protocol file

Allocation procedure (docs/experiment-framework.md 4.1 and 4.3)
---------------------------------------------------------------
The orderings of a block are listed in lexicographic order (AABB, ABAB, ABBA, BAAB, BABA, BBAA).
Block i takes ordering number k_i, where k_0, k_1, ... are uniform integers in [0, n_orderings)
made from the raw 64-bit output of numpy's PCG64 bit generator seeded with
SeedSequence(int.from_bytes(seed, "big")): a raw value r is used as r % n_orderings unless
r >= 2**64 - (2**64 % n_orderings), in which case it is skipped (so every ordering is exactly
equally likely). Only PCG64's raw stream and SeedSequence are used; numpy guarantees both are
stable across versions, unlike Generator.integers(). tests/test_experiment_framework.py pins a
golden schedule so a change in either would fail CI.

Nothing here reads the database or the clock, and nothing prints a seed.
"""
from __future__ import annotations

import hashlib
import itertools
import re
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np

ARMS = ("A", "B")
DESIGN_DAILY_BLOCKS = "daily_4day_permuted_blocks"
DESIGN_PERIOD = "period_ab"                 # designed (doc 4.2), not implemented in this phase
SEED_BYTES = 32
ID_PATTERN = re.compile(r"^EXP-\d{3}$")
TEMPLATE_ID = "EXP-000"                     # docs/experiments/TEMPLATE.md; can never be registered
# Riley's decision 1 (docs/experiment-framework.md section 13): only trial effects of 8 ms or more.
MIN_MID_MS = 8.0
GENERATOR = f"numpy PCG64 raw stream + SeedSequence, rejection-sampled (numpy {np.__version__})"
_HEX64 = re.compile(r"^[0-9a-f]{64}$")
# Objective adherence sources pds.experiment_day_status knows how to read (sql/experiment_framework_schema.sql).
OBJECTIVE_SOURCES = ("pds.phone_usage_daily.minutes_last_hour_before_sleep_est",)


# ---------------------------------------------------------------------------
# Allocation
# ---------------------------------------------------------------------------

def block_orderings(block_len: int = 4, n_a: int = 2) -> tuple[str, ...]:
    """Every ordering of n_a 'A' days and block_len - n_a 'B' days, lexicographic."""
    if not (0 < n_a < block_len):
        raise ValueError("a block needs at least one day of each arm")
    out = []
    for a_positions in itertools.combinations(range(block_len), n_a):
        out.append("".join("A" if i in a_positions else "B" for i in range(block_len)))
    return tuple(sorted(out))


def seed_commitment(seed: bytes) -> str:
    """The hash that is published before the trial; the seed itself is published in the final report."""
    _check_seed(seed)
    return hashlib.sha256(seed).hexdigest()


def _check_seed(seed: bytes) -> None:
    if not isinstance(seed, (bytes, bytearray)) or len(seed) != SEED_BYTES:
        raise ValueError(f"seed must be {SEED_BYTES} bytes")


def _bitgen(seed_int: int) -> np.random.PCG64:
    return np.random.PCG64(np.random.SeedSequence(seed_int))


def _uniform_ints(bitgen: np.random.PCG64, n_choices: int, size: int) -> np.ndarray:
    """`size` exactly-uniform integers in [0, n_choices) from the raw 64-bit stream (see module doc)."""
    if n_choices < 1:
        raise ValueError("n_choices must be positive")
    excess = (1 << 64) % n_choices
    out = np.empty(0, dtype=np.uint64)
    while out.size < size:
        raw = bitgen.random_raw(size - out.size).astype(np.uint64, copy=False)
        if excess:
            raw = raw[raw < np.uint64((1 << 64) - excess)]
        out = np.concatenate([out, raw])
    return (out % np.uint64(n_choices)).astype(np.int64)


def generate_schedule(seed: bytes, n_blocks: int, block_len: int = 4, n_a: int = 2) -> list[str]:
    """Arm ('A' / 'B') for each of n_blocks * block_len consecutive behavioral days."""
    _check_seed(seed)
    if n_blocks < 1:
        raise ValueError("n_blocks must be positive")
    orderings = block_orderings(block_len, n_a)
    picks = _uniform_ints(_bitgen(int.from_bytes(seed, "big")), len(orderings), n_blocks)
    return list("".join(orderings[k] for k in picks))


def redraw_blocks(seed_int: int, n_redraws: int, n_blocks: int, block_len: int = 4, n_a: int = 2) -> np.ndarray:
    """(n_redraws, n_blocks * block_len) array of 0/1 (1 = arm A): fresh schedules drawn by the
    registered procedure. Used by the randomization test; seed_int comes from redraw_seed()."""
    orderings = block_orderings(block_len, n_a)
    table = np.array([[1 if ch == "A" else 0 for ch in o] for o in orderings], dtype=np.int8)
    picks = _uniform_ints(_bitgen(seed_int), len(orderings), n_redraws * n_blocks)
    return table[picks].reshape(n_redraws, n_blocks * block_len)


def redraw_seed(experiment_id: str, as_of: date) -> int:
    """Seed of the randomization test's re-draws: fixed by (experiment, as-of date), so a re-run
    of the same report returns the same p-value (doc 8 and 10.3). Not secret."""
    digest = hashlib.sha256(f"{experiment_id}|{as_of.isoformat()}|randomization-test".encode()).digest()
    return int.from_bytes(digest[:16], "big")


def schedule_rows(experiment_id: str, start: date, arms: list[str], block_len: int = 4) -> list[dict[str, Any]]:
    """Rows for pds.experiment_schedule (one per behavioral day)."""
    return [
        {
            "experiment_id": experiment_id,
            "behavioral_date": (start + timedelta(days=i)).isoformat(),
            "day_index": i,
            "block_index": i // block_len,
            "pos_in_block": i % block_len,
            "arm": arm,
        }
        for i, arm in enumerate(arms)
    ]


# ---------------------------------------------------------------------------
# Protocol file (docs/experiments/EXP-NNN.md: YAML front matter + free text)
# ---------------------------------------------------------------------------

class ProtocolError(ValueError):
    """The protocol file cannot be registered. `problems` lists every reason."""

    def __init__(self, problems: list[str]):
        super().__init__("; ".join(problems))
        self.problems = problems


def protocol_sha256(raw: bytes) -> str:
    """SHA-256 of the protocol file with LF line endings (a Windows checkout may hold CRLF)."""
    return hashlib.sha256(raw.replace(b"\r\n", b"\n")).hexdigest()


def parse_protocol(raw: bytes) -> dict[str, Any]:
    """The YAML front matter of a protocol file as a dict."""
    import yaml  # PyYAML; imported here so the allocation code above needs numpy only

    text = raw.decode("utf-8-sig").replace("\r\n", "\n")
    if not text.startswith("---\n"):
        raise ProtocolError(["the file must start with a '---' YAML front matter block"])
    end = text.find("\n---", 4)
    if end < 0:
        raise ProtocolError(["the YAML front matter is not closed with '---'"])
    data = yaml.safe_load(text[4:end + 1])
    if not isinstance(data, dict):
        raise ProtocolError(["the YAML front matter must be a mapping"])
    return data


def load_protocol(path: str | Path) -> tuple[dict[str, Any], str]:
    raw = Path(path).read_bytes()
    return parse_protocol(raw), protocol_sha256(raw)


def _as_date(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return date.fromisoformat(value.strip())
        except ValueError:
            return None
    return None


def _jsonable(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    return value


def validate_protocol(p: dict[str, Any], *, today: date, alignment_version: str,
                      seed_sha256: str | None = None) -> dict[str, Any]:
    """Check a parsed protocol against the design rules and return the normalized fields the
    registration writes. Raises ProtocolError listing every problem.

    today              ET today; the first behavioral day must be later (register before the start).
    alignment_version  hrv_alignment.ALIGNMENT_VERSION at registration time.
    seed_sha256        commitment of the seed stored for this experiment; must equal the file's.
    """
    problems: list[str] = []

    def need(mapping: Any, key: str, where: str) -> Any:
        value = mapping.get(key) if isinstance(mapping, dict) else None
        if value in (None, "", [], {}):
            problems.append(f"{where}{key} is missing")
        return value

    exp_id = str(need(p, "id", "") or "")
    if exp_id and not ID_PATTERN.match(exp_id):
        problems.append("id must look like EXP-001")
    if exp_id == TEMPLATE_ID:
        problems.append(f"{TEMPLATE_ID} is the template id and cannot be registered")
    title = need(p, "title", "")
    question = need(p, "question", "")

    arms = need(p, "arms", "") or {}
    arm_a = need(arms, "A", "arms.")
    arm_b = need(arms, "B", "arms.")
    control = str(p.get("control_arm", "B"))
    if control not in ARMS:
        problems.append("control_arm must be A or B")

    outcome = need(p, "outcome", "") or {}
    primary = need(outcome, "primary", "outcome.")
    registered_alignment = need(outcome, "alignment_version", "outcome.")
    if registered_alignment and registered_alignment != alignment_version:
        problems.append(
            f"outcome.alignment_version is {registered_alignment!r} but hrv_alignment.ALIGNMENT_VERSION "
            f"is {alignment_version!r}")

    mid = p.get("mid_ms")
    if not isinstance(mid, (int, float)) or isinstance(mid, bool):
        problems.append("mid_ms must be a number")
    elif mid < MIN_MID_MS:
        problems.append(f"mid_ms is {mid}; only effects of {MIN_MID_MS:g} ms or more are trialled "
                        "(docs/experiment-framework.md section 13, decision 1)")

    design = need(p, "design", "") or {}
    design_type = need(design, "type", "design.")
    block_len, n_a = 4, 2
    n_blocks, n_days = design.get("n_blocks"), design.get("n_days")
    if design_type == DESIGN_PERIOD:
        problems.append("the period design (doc 4.2) is not implemented yet; only "
                        f"{DESIGN_DAILY_BLOCKS} can be registered")
    elif design_type and design_type != DESIGN_DAILY_BLOCKS:
        problems.append(f"design.type must be {DESIGN_DAILY_BLOCKS}")
    if not isinstance(n_blocks, int) or isinstance(n_blocks, bool) or n_blocks < 2:
        problems.append("design.n_blocks must be an integer of 2 or more")
    elif n_days != n_blocks * block_len:
        problems.append(f"design.n_days must be n_blocks * {block_len} = {n_blocks * block_len}")
    if design.get("washout_days", 0) != 0:
        problems.append("design.washout_days must be 0 for the daily block design (carryover is modelled)")

    start, planned_end = _as_date(p.get("start")), _as_date(p.get("planned_end"))
    if start is None:
        problems.append("start must be a date (YYYY-MM-DD)")
    elif start <= today:
        problems.append(f"start ({start}) must be after today ({today}): a protocol is registered before its first day")
    if planned_end is None:
        problems.append("planned_end must be a date (YYYY-MM-DD)")
    if start and planned_end and isinstance(n_days, int) and planned_end != start + timedelta(days=n_days - 1):
        problems.append(f"planned_end must be start + n_days - 1 = {start + timedelta(days=n_days - 1)}")

    allocation = need(p, "allocation", "") or {}
    file_commitment = str(allocation.get("seed_sha256") or "")
    if not _HEX64.match(file_commitment):
        problems.append("allocation.seed_sha256 must be the 64-hex-digit commitment printed by `experiment_admin.py seed`")
    elif seed_sha256 is not None and file_commitment != seed_sha256:
        problems.append("allocation.seed_sha256 does not match the seed stored for this experiment")

    objective = (p.get("adherence") or {}).get("objective") if isinstance(p.get("adherence"), dict) else None
    if objective is not None:
        if not isinstance(objective, dict) or objective.get("source") not in OBJECTIVE_SOURCES:
            problems.append("adherence.objective.source must be one of: " + ", ".join(OBJECTIVE_SOURCES))
        elif not isinstance(objective.get("max"), (int, float)) or isinstance(objective.get("max"), bool)                 or objective.get("arm") not in ARMS:
            problems.append("adherence.objective needs a numeric max and arm A or B")

    stopping = p.get("stopping") if isinstance(p.get("stopping"), dict) else {}
    if str(stopping.get("interim", "none")).strip().lower() != "none":
        problems.append("stopping.interim must be 'none': interim looks are not built yet, and the effect is "
                        "analysed only at the pre-registered end (docs/experiment-framework.md 12.1 and 13)")

    analysis = p.get("analysis") or {}
    alpha = analysis.get("alpha", 0.05)
    n_redraws = analysis.get("n_redraws", 10000)
    if not isinstance(alpha, (int, float)) or not (0 < alpha < 1):
        problems.append("analysis.alpha must be between 0 and 1")
    if not isinstance(n_redraws, int) or n_redraws < 999:
        problems.append("analysis.n_redraws must be an integer of 999 or more")

    if problems:
        raise ProtocolError(problems)

    return {
        "experiment_id": exp_id,
        "title": str(title),
        "question": str(question),
        "arm_a_instruction": str(arm_a),
        "arm_b_instruction": str(arm_b),
        "control_arm": control,
        "outcome_primary": str(primary),
        "alignment_version": str(registered_alignment),
        "mid_ms": float(mid),
        "design_type": str(design_type),
        "block_len": block_len,
        "n_a_per_block": n_a,
        "n_blocks": int(n_blocks),
        "n_days": int(n_days),
        "washout_days": 0,
        "start_date": start.isoformat(),
        "planned_end": planned_end.isoformat(),
        "alpha": float(alpha),
        "n_redraws": int(n_redraws),
        "seed_sha256": file_commitment,
        "adherence": _jsonable(p.get("adherence") or {}),
        "protocol": _jsonable(p),
    }
