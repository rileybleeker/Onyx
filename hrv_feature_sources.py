"""
One manifest of the HRV pipeline's input sources and how a correction to each is seen
(audit PIPE-09, 2026-11-16).

Both sides of the retrain decision read this file:
  * hrv_backfill_check.py (hourly) asks whether any source's HISTORY changed since the last
    retrain, and
  * hrv_analysis.py records, before it loads its data, a fingerprint of every source's history
    (stored as hrv_analysis_results lineage/source_fingerprints once the run's results are stored).

Three ways a change is seen, per source:
  1. Row scan: rows dated before the source's settle cutoff whose change column moved after the
     last retrain read its data. "change" columns move on any real change (a bump trigger, the
     source API's own updated_at, or an ETL that stamps every upsert inside its settle window);
     "insert" columns are set once, so they show backdated NEW rows only.
  2. Signal: a sync_log row a trigger writes for every past-date INSERT / UPDATE / DELETE
     (habit_journal_backfill_trigger).
  3. Fingerprint: the row count + an md5 of the content of every row dated before the cutoff,
     computed by pds.hrv_source_fingerprint (sql/hrv_source_fingerprint.sql) and compared with the
     one the last retrain recorded. This is the one that sees edits on insert-only tables and
     DELETES, without a trigger on any high-churn table. A relation with no date of its own
     (Garmin laps, supplement products) is fingerprinted through a Link: its rows tied to a
     historical row of another relation. A fingerprint reads the relation the pipeline actually
     LOADS ("prefer": a materialized copy first, the live view when the copy is missing or fails,
     the loader's own order), so a correction counts as trained only once it reached what the
     retrain loaded.

A check that cannot be made (a read error, a missing baseline) is UNKNOWN, never "no change"
(decide() below). Only names and error codes are reported; never a row, a count or a hash.

Standard library only: the hourly detector installs supabase + python-dotenv, nothing else.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone

# Rows dated within this many days of today are still being written by their hourly ETL and are
# not "history" (the old HISTORICAL_DAYS of hrv_backfill_check.py).
DEFAULT_SETTLE_DAYS = 2

# Never hashed: the moment a row was last written is not its content (and some ETLs stamp it on
# every upsert). pds.hrv_source_fingerprint also never hashes raw_* payload columns or vectors.
ALWAYS_EXCLUDE = ("synced_at",)

# hrv_analysis_results row holding the fingerprints the last retrain trained on.
LINEAGE_RESULT_TYPE = "lineage"
LINEAGE_RESULT_KEY = "source_fingerprints"
LINEAGE_VERSION = 1

# The lineage row is the LAST hrv_analysis_results row a retrain writes, so after a complete run it
# is the newest row (computed_at is the "last analysis"). A lineage row older than the newest row
# was not written by the latest retrain (its own lineage write failed): it is not a baseline, with
# no grace period (a retrain an hour after its predecessor must not inherit the older baseline).
LINEAGE_MAX_LAG = timedelta(0)

# An unknown check retrains only when the last retrain is at least this old, so a source that
# stays unreadable costs one retrain every few hours (plus the daily 12:00 UTC run), not one an
# hour. The hourly detector keeps retrying the check itself in between.
UNKNOWN_RETRAIN_AFTER_HOURS = 3

FINGERPRINT_RPC = "hrv_source_fingerprint"
# PostgREST: function not found in the schema cache / Postgres: undefined function.
_MISSING_FUNCTION_CODES = {"PGRST202", "42883"}


@dataclass(frozen=True)
class RowScan:
    table: str
    date_col: str
    change_col: str
    moves_on: str  # "change" | "insert"


@dataclass(frozen=True)
class Link:
    """Rows of the fingerprinted relation whose key_col appears in parent_key of a parent row
    dated (parent_date_col) before the cutoff."""
    key_col: str
    parent: str
    parent_key: str
    parent_date_col: str


@dataclass(frozen=True)
class Fingerprint:
    relation: str
    date_col: str | None          # None: the rows are chosen by `link`
    exclude: tuple[str, ...] = ()
    link: Link | None = None
    # Relations tried before `relation`, in the loader's own order (e.g. a matview the pipeline
    # prefers); any failure on one moves to the next, exactly as the loader falls back.
    prefer: tuple[str, ...] = ()


@dataclass(frozen=True)
class FeatureSource:
    name: str
    feeds: str
    settle_days: int = DEFAULT_SETTLE_DAYS
    scans: tuple[RowScan, ...] = ()
    fingerprint: Fingerprint | None = None
    signal: tuple[str, str] | None = None


def _garmin(table: str, date_col: str = "calendar_date", moves_on: str = "insert") -> FeatureSource:
    return FeatureSource(
        name=table, feeds=f"hrv_analysis.load_all_data: {table}",
        scans=(RowScan(table, date_col, "synced_at", moves_on),),
        fingerprint=Fingerprint(table, date_col),
    )


def _whoop(table: str, date_col: str = "start_time") -> FeatureSource:
    # updated_at is WHOOP's own last-change time (re-scores move it). Riley's activity tags
    # (is_sauna, split_labels, muscle_groups, is_excluded) do not: the fingerprint sees those.
    return FeatureSource(
        name=table, feeds=f"hrv_analysis.load_all_data: {table}",
        scans=(RowScan(table, date_col, "updated_at", "change"),),
        fingerprint=Fingerprint(table, date_col),
    )


SOURCES: tuple[FeatureSource, ...] = (
    FeatureSource(
        name="matrix",
        feeds=("daily_health_matrix_behavioral: WHOOP cycle / recovery / sleep, Garmin daily summary / "
               "stress / zones / training status, Eight Sleep, Cronometer behavioral totals, MFP, "
               "caffeine (supplement intakes + Cronometer servings), meal timing"),
        scans=(
            RowScan("myfitnesspal_nutrition", "calendar_date", "synced_at", "change"),
            RowScan("cronometer_nutrition_daily", "calendar_date", "synced_at", "insert"),
            RowScan("meal_events", "event_date", "updated_at", "change"),
        ),
        fingerprint=Fingerprint("daily_health_matrix_behavioral", "calendar_date"),
    ),
    _whoop("whoop_cycles"),
    _whoop("whoop_recovery", date_col="created_at"),
    _whoop("whoop_sleep"),
    _whoop("whoop_workouts"),
    _garmin("garmin_daily_summary", moves_on="change"),   # zzz_bump_synced_at trigger
    _garmin("garmin_sleep"),
    _garmin("garmin_hrv"),
    _garmin("garmin_heart_rate"),
    _garmin("garmin_stress"),
    _garmin("garmin_training_status"),
    _garmin("garmin_activities", date_col="onyx_behavioral_date"),
    # Laps have no date; garmin_etl.backfill_laps writes them without touching their activity.
    FeatureSource(
        name="garmin_activity_laps", feeds="hrv_analysis.load_all_data: garmin_activity_laps",
        fingerprint=Fingerprint("garmin_activity_laps", None,
                                link=Link("activity_id", "garmin_activities", "activity_id",
                                          "onyx_behavioral_date")),
    ),
    FeatureSource(
        name="eight_sleep_trends", feeds="hrv_analysis.load_all_data: eight_sleep_trends",
        scans=(RowScan("eight_sleep_trends", "calendar_date", "synced_at", "change"),),  # bump trigger
        fingerprint=Fingerprint("eight_sleep_trends", "calendar_date"),
    ),
    FeatureSource(
        name="habit_journal", feeds="journal view (journal_* / habit_* columns)",
        scans=(RowScan("habit_journal", "cycle_date", "synced_at", "insert"),),
        signal=("habit_journal", "backfill_signal"),
        fingerprint=Fingerprint("habit_journal", "cycle_date"),
    ),
    # hrv_analysis.fetch_supplement_rollup reads the matview first (refreshed ~5 min after a write)
    # and the live view when it is missing or fails: the fingerprint reads them in the same order.
    FeatureSource(
        name="supplement_rollup",
        feeds="supplement_intake_by_compound(_mat) (intakes x product ingredients)",
        fingerprint=Fingerprint("supplement_intake_by_compound", "calendar_date",
                                prefer=("supplement_intake_by_compound_mat",)),
    ),
    # load_supplement_unquantified reads these two directly: an intake of a product whose label
    # gives no readable amount is not in the rollup, so only these see it (edits and deletions).
    FeatureSource(
        name="supplement_intake",
        feeds="hrv_analysis.load_supplement_unquantified: supplement_intake",
        scans=(RowScan("supplement_intake", "intake_date", "created_at", "insert"),),
        fingerprint=Fingerprint("supplement_intake", "intake_date"),
    ),
    FeatureSource(
        name="supplement_products",
        feeds="hrv_analysis.load_supplement_unquantified: ingredients of products taken in the past",
        # Archiving a product or refetching its label page changes no past intake.
        fingerprint=Fingerprint("supplement_products", None, exclude=("fetched_at", "is_active"),
                                link=Link("product_id", "supplement_intake", "product_id", "intake_date")),
    ),
    FeatureSource(name="melatonin_unified", feeds="melatonin_unified (journal + supplement bridge)",
                  fingerprint=Fingerprint("melatonin_unified", "calendar_date")),
    FeatureSource(name="flight_day_unified", feeds="flight_day_unified (plane habit + flights)",
                  fingerprint=Fingerprint("flight_day_unified", "calendar_date")),
    FeatureSource(name="delivery_daily",
                  feeds="delivery_daily (Uber Eats receipts, portions eaten, leftovers)",
                  fingerprint=Fingerprint("delivery_daily", "behavioral_date")),
    # hrv_analysis.load_all_data reads the receipts NOT parsed ('unmatched' / 'error'): their day and
    # the day before are never zero-filled. A historical receipt that parses later (or fails on a
    # --reprocess) turns delivery features between 0 and unknown without changing delivery_daily, so
    # its coverage is fingerprinted on its own. Only identity, receive time and status reach the
    # pipeline; the parser's own bookkeeping columns are not hashed (a --reprocess restamps them).
    FeatureSource(
        name="delivery_email_log", feeds="delivery_email_log (unread receipts: days not zero-filled)",
        fingerprint=Fingerprint("delivery_email_log", "received_at",
                                exclude=("processed_at", "error", "subject", "kind", "merchant_name",
                                         "account")),
    ),
    # The phone syncs once a day and may resend the last days; a day is final a week later.
    FeatureSource(name="phone_usage_daily", feeds="phone_usage_daily (Screen Time app)", settle_days=8,
                  fingerprint=Fingerprint("phone_usage_daily", "behavioral_date")),
    # air_quality_etl.py re-upserts (and restamps) the last 7 days, weather_etl.py the last 10.
    FeatureSource(
        name="air_quality_daily", feeds="air_quality_daily (aqi_*)", settle_days=8,
        scans=(RowScan("air_quality_daily", "calendar_date", "synced_at", "change"),),
        fingerprint=Fingerprint("air_quality_daily", "calendar_date"),
    ),
    FeatureSource(
        name="weather_daily", feeds="weather_daily (wx_*)", settle_days=11,
        scans=(RowScan("weather_daily", "calendar_date", "synced_at", "change"),),
        fingerprint=Fingerprint("weather_daily", "calendar_date"),
    ),
    FeatureSource(
        name="journal_entries", feeds="journal_entries (nj_* mood / confidence / words)",
        scans=(RowScan("journal_entries", "entry_date", "notion_edited_at", "change"),),
        fingerprint=Fingerprint("journal_entries", "entry_date", exclude=("content_md", "notion_edited_at")),
    ),
)

# Inputs the pipeline reads that are deliberately NOT watched, and why (the manifest is the
# complete list: a new loader read either joins SOURCES or gets a line here).
UNWATCHED: dict[str, str] = {
    "cronometer_servings": "replaced by date on every import; its values reach the pipeline only through "
                           "the matrix (behavioral totals, caffeine), whose fingerprint sees them",
    "whoop_body_measurements": "profile values with no day; every retrain reads the newest row",
    "spotify_daily_signature": "off unless ONYX_INCLUDE_SPOTIFY=1",
    "sync_log": "heartbeats read for delivery coverage, not values: they move only the zero-fill of the "
                "newest, not yet settled days",
    "user_tz_log": "a new time zone row re-dates only rows written after it; a re-derived row is an update "
                   "the sources above see",
}


# Relations hrv_analysis.py reads under another name than the one watched above.
READ_ALIASES: dict[str, str] = {
    "journal": "habit_journal",                                        # view over habit_journal
}


def watched_relations(sources=None) -> set[str]:
    """Every relation a source scans or fingerprints."""
    out: set[str] = set()
    for src in (SOURCES if sources is None else sources):
        out.update(scan.table for scan in src.scans)
        if src.fingerprint:
            out.add(src.fingerprint.relation)
            out.update(src.fingerprint.prefer)
    return out


def covers(relation: str, sources=None) -> bool:
    """True when a relation the pipeline reads is watched, or listed in UNWATCHED with a reason."""
    rel = READ_ALIASES.get(relation, relation)
    return rel in watched_relations(sources) or rel in UNWATCHED


def cutoff(today: date, source: FeatureSource) -> str:
    """Rows dated before this ISO date are this source's history."""
    return (today - timedelta(days=source.settle_days)).isoformat()


def error_code(e: BaseException) -> str:
    """A PostgREST / Postgres code, else the exception's type name. Never its text: a message can
    quote a value."""
    code = getattr(e, "code", None)
    if isinstance(code, str) and code and len(code) <= 16 and code.replace("_", "").isalnum():
        return code
    return type(e).__name__


def parse_ts(value) -> datetime | None:
    if not value:
        return None
    try:
        ts = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# Reads (each takes the supabase client; every failure is returned, never raised)
# ---------------------------------------------------------------------------

def scan_rows(supa, scan: RowScan, since: str, before: str) -> str:
    """'changed' | 'unchanged' | 'unknown:<code>'."""
    try:
        resp = (
            supa.schema("pds").from_(scan.table).select(scan.date_col)
            .gt(scan.change_col, since).lt(scan.date_col, before).limit(1).execute()
        )
    except Exception as e:  # noqa: BLE001
        return f"unknown:{error_code(e)}"
    return "changed" if resp.data else "unchanged"


def scan_signal(supa, signal: tuple[str, str], since: str, before: str) -> str:
    source, data_type = signal
    try:
        resp = (
            supa.schema("pds").from_("sync_log").select("sync_start")
            .eq("source", source).eq("data_type", data_type)
            .gt("sync_start", since).lt("date_range_start", before).limit(1).execute()
        )
    except Exception as e:  # noqa: BLE001
        return f"unknown:{error_code(e)}"
    return "changed" if resp.data else "unchanged"


class FingerprintUnavailable(Exception):
    """pds.hrv_source_fingerprint is not installed (sql/hrv_source_fingerprint.sql not applied)."""


def _fingerprint_params(fp: Fingerprint, relation: str, before: str) -> dict:
    params = {
        "p_relation": relation,
        "p_date_col": fp.date_col,
        "p_before": before,
        "p_exclude": list(dict.fromkeys((*ALWAYS_EXCLUDE, *fp.exclude))),
    }
    if fp.link is not None:
        params.update({"p_link_col": fp.link.key_col, "p_parent_relation": fp.link.parent,
                       "p_parent_key": fp.link.parent_key, "p_parent_date_col": fp.link.parent_date_col})
    return params


def fingerprint(supa, fp: Fingerprint, before: str) -> dict:
    """{'row_count', 'fingerprint'}. Raises FingerprintUnavailable when the function is missing,
    any other exception for a failed read (of the last relation tried)."""
    relations = (*fp.prefer, fp.relation)
    resp = None
    used = fp.relation
    for i, relation in enumerate(relations):
        try:
            resp = supa.schema("pds").rpc(FINGERPRINT_RPC, _fingerprint_params(fp, relation, before)).execute()
        except Exception as e:  # noqa: BLE001
            if error_code(e) in _MISSING_FUNCTION_CODES:
                raise FingerprintUnavailable() from None
            if i < len(relations) - 1:
                continue    # the loader falls back the same way on any error
            raise
        used = relation
        break
    data = resp.data
    row = data[0] if isinstance(data, list) and data else data
    if not isinstance(row, dict) or "fingerprint" not in row:
        raise ValueError("unexpected fingerprint response")
    return {"row_count": int(row.get("row_count") or 0), "fingerprint": str(row["fingerprint"]),
            "relation": used}


def capture(supa, today: date, now: datetime | None = None, sources=None) -> dict | None:
    """The fingerprints of every source's history, taken BEFORE a retrain loads its data.

    None when the fingerprint function is not installed (nothing to record). A source whose read
    fails is recorded with its error code: the detector treats that source as unknown until a later
    retrain records it."""
    snapshot = {"version": LINEAGE_VERSION,
                "captured_at": (now or datetime.now(timezone.utc)).isoformat(),
                "sources": {}}
    for src in (SOURCES if sources is None else sources):
        if src.fingerprint is None:
            continue
        before = cutoff(today, src)
        try:
            snapshot["sources"][src.name] = {"before": before, **fingerprint(supa, src.fingerprint, before)}
        except FingerprintUnavailable:
            return None
        except Exception as e:  # noqa: BLE001
            snapshot["sources"][src.name] = {"before": before, "error": error_code(e)}
    return snapshot


def mark_failed(snapshot: dict | None, names) -> None:
    """Mark sources whose data this retrain could not use (a fail-open load or merge) as errored in
    the snapshot about to be stored, so the detector treats them as unknown, never as consumed."""
    if not snapshot:
        return
    for name in names:
        entry = snapshot["sources"].get(name)
        if entry is not None:
            entry["error"] = "load_failed"


def mark_relation_mismatch(snapshot: dict | None, loaded: dict[str, str]) -> None:
    """`loaded` = {source name: relation the retrain actually read}. A source fingerprinted from a
    different relation than the one training used (e.g. capture read the live view after the
    matview failed, training then read a stale matview) is marked unknown: after the matview
    refreshes, the two would otherwise match and hide an untrained correction."""
    if not snapshot:
        return
    for name, relation in loaded.items():
        entry = snapshot["sources"].get(name)
        if entry is not None and not entry.get("error") and entry.get("relation") != relation:
            entry["error"] = "relation_mismatch"


def read_baseline(supa) -> tuple[dict | None, str | None, str | None]:
    """(lineage snapshot, its computed_at, error code). (None, None, None) = never stored."""
    try:
        resp = (
            supa.schema("pds").from_("hrv_analysis_results").select("result_json,computed_at")
            .eq("result_type", LINEAGE_RESULT_TYPE).eq("result_key", LINEAGE_RESULT_KEY)
            .limit(1).execute()
        )
    except Exception as e:  # noqa: BLE001
        return None, None, error_code(e)
    row = (resp.data or [None])[0]
    if not row:
        return None, None, None
    snap = row.get("result_json")
    if not isinstance(snap, dict) or snap.get("version") != LINEAGE_VERSION:
        return None, row.get("computed_at"), "bad_baseline"
    return snap, row.get("computed_at"), None


def store_baseline(supa, snapshot: dict | None, input_data_hash: str | None = None) -> bool:
    """Store the snapshot a retrain trained on. Called only after the run's results are stored;
    carries the run's input_data_hash like the other hrv_analysis_results rows.
    Never raises; False when nothing was stored."""
    if not snapshot:
        return False
    try:
        supa.schema("pds").from_("hrv_analysis_results").upsert({
            "result_type": LINEAGE_RESULT_TYPE,
            "result_key": LINEAGE_RESULT_KEY,
            "result_json": snapshot,
            "computed_at": datetime.now(timezone.utc).isoformat(),
            "input_data_hash": input_data_hash,
        }, on_conflict="result_type,result_key").execute()
    except Exception:  # noqa: BLE001
        return False
    return True


# ---------------------------------------------------------------------------
# Detection and decision
# ---------------------------------------------------------------------------

@dataclass
class Detection:
    changed: list[str] = field(default_factory=list)   # "<source>/<layer>"
    unknown: list[str] = field(default_factory=list)   # "<source>/<layer>:<code>"
    fingerprint_installed: bool = True
    no_baseline: bool = False                          # first run with the function installed


def detect(supa, today: date, last_analysis: str, baseline: dict | None,
           baseline_computed_at: str | None, baseline_error: str | None,
           sources=None) -> Detection:
    sources = SOURCES if sources is None else sources
    det = Detection()

    # Row scans start where the last retrain READ its data (the baseline's captured_at) when the
    # baseline belongs to that retrain; a change written while it trained is then not missed.
    since = last_analysis
    usable_baseline = baseline
    last_ts, base_ts = parse_ts(last_analysis), parse_ts(baseline_computed_at)
    if baseline is not None:
        if last_ts and base_ts and base_ts < last_ts - LINEAGE_MAX_LAG:
            usable_baseline = None
            det.unknown.append("lineage/baseline:stale")
        else:
            captured = parse_ts(baseline.get("captured_at"))
            if captured and last_ts and captured < last_ts:
                since = captured.isoformat()
    elif baseline_error:
        det.unknown.append(f"lineage/baseline:{baseline_error}")

    for src in sources:
        before = cutoff(today, src)
        for scan in src.scans:
            _record(det, f"{src.name}/rows:{scan.table}", scan_rows(supa, scan, since, before))
        if src.signal:
            _record(det, f"{src.name}/signal", scan_signal(supa, src.signal, since, before))

    if baseline_error or (baseline is not None and usable_baseline is None):
        return det          # the fingerprints have nothing to be compared with (already unknown)
    for src in sources:
        if src.fingerprint is None or not det.fingerprint_installed:
            continue
        stored = (usable_baseline or {}).get("sources", {}).get(src.name)
        before = (stored or {}).get("before") or cutoff(today, src)
        try:
            now_fp = fingerprint(supa, src.fingerprint, before)
        except FingerprintUnavailable:
            det.fingerprint_installed = False
            continue
        except Exception as e:  # noqa: BLE001
            det.unknown.append(f"{src.name}/fingerprint:{error_code(e)}")
            continue
        if usable_baseline is None:
            det.no_baseline = True
        elif stored is None:
            det.changed.append(f"{src.name}/fingerprint:new_source")
        elif stored.get("error"):
            det.unknown.append(f"{src.name}/fingerprint:baseline_{stored['error']}")
        elif (stored.get("row_count"), stored.get("fingerprint")) != (now_fp["row_count"], now_fp["fingerprint"]):
            det.changed.append(f"{src.name}/fingerprint")
    return det


def _record(det: Detection, label: str, state: str) -> None:
    if state == "changed":
        det.changed.append(label)
    elif state.startswith("unknown:"):
        det.unknown.append(f"{label}:{state.split(':', 1)[1]}")


@dataclass(frozen=True)
class Decision:
    retrain: bool
    status: str          # heartbeat: "success" | "partial"
    message: str | None  # starts with "GUARD <name>:" when not success
    reason: str


def decide(det: Detection, last_analysis_age_hours: float | None) -> Decision:
    """last_analysis_age_hours None = the last analysis time could not be read."""
    problems: list[str] = []
    if det.unknown:
        problems.append(f"could not check {len(det.unknown)} input(s): " + ", ".join(det.unknown[:8])
                        + ("…" if len(det.unknown) > 8 else ""))
    if not det.fingerprint_installed:
        problems.append("pds.hrv_source_fingerprint is not installed (apply sql/hrv_source_fingerprint.sql); "
                        "deletions and edits to insert-only sources are not seen")
    message = ("GUARD hrv_backfill_detection: " + "; ".join(problems)) if problems else None
    status = "partial" if problems else "success"

    if det.changed:
        return Decision(True, status, message, "history changed: " + ", ".join(det.changed[:8]))
    if det.no_baseline:
        return Decision(True, status, message, "no recorded fingerprints yet (first run)")
    if det.unknown:
        if last_analysis_age_hours is None or last_analysis_age_hours >= UNKNOWN_RETRAIN_AFTER_HOURS:
            return Decision(True, status, message, "detection incomplete: retraining as a precaution")
        return Decision(False, status, message,
                        f"detection incomplete; retrain deferred (last retrain {last_analysis_age_hours:.1f} h ago, "
                        f"retries at {UNKNOWN_RETRAIN_AFTER_HOURS} h)")
    return Decision(False, status, message, "no change to any watched source's history")
