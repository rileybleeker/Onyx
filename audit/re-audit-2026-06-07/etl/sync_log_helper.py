"""
Shared sync_log emitter for every Onyx ETL.

Why this exists: each ETL grew its own ad-hoc sync_log insert. Some passed
sync_start as a derived timestamp, some relied on the Postgres NOW() default;
none populated sync_end, so the /status freshness / duration computation was
inconsistent. This module is the one and only writer — every ETL should call
log_sync() and pass the started_at it captured at function entry.

Schema columns populated:
  source, data_type, status, records_synced,
  sync_start, sync_end, duration_seconds,
  date_range_start, date_range_end, error_message

Insert failures are swallowed with a warning — the ETL should never crash
because the heartbeat write failed.
"""

import logging
import time
from datetime import date, datetime, timezone
from typing import Optional, Union

log = logging.getLogger(__name__)

StartedAt = Union[float, datetime, None]


def _to_dt(started_at: StartedAt) -> datetime:
    """Normalize a float epoch or datetime to an aware UTC datetime."""
    if started_at is None:
        return datetime.now(timezone.utc)
    if isinstance(started_at, datetime):
        return started_at if started_at.tzinfo else started_at.replace(tzinfo=timezone.utc)
    return datetime.fromtimestamp(float(started_at), tz=timezone.utc)


def log_sync(
    supa,
    source: str,
    data_type: str,
    status: str,
    records: int = 0,
    started_at: StartedAt = None,
    error: Optional[str] = None,
    date_range_start: Optional[date] = None,
    date_range_end: Optional[date] = None,
) -> None:
    """Insert a sync_log heartbeat. Both sync_start and sync_end are always set.

    started_at may be a float (time.time()), a datetime, or None.
    sync_end is captured at write time. duration_seconds is computed from both.
    """
    end_dt = datetime.now(timezone.utc)
    start_dt = _to_dt(started_at)
    duration = max(0, int((end_dt - start_dt).total_seconds()))
    row = {
        "source": source,
        "data_type": data_type,
        "status": status,
        "records_synced": records,
        "duration_seconds": duration,
        "error_message": error,
        "sync_start": start_dt.isoformat(),
        "sync_end": end_dt.isoformat(),
    }
    if date_range_start is not None:
        row["date_range_start"] = date_range_start.isoformat()
    if date_range_end is not None:
        row["date_range_end"] = date_range_end.isoformat()
    try:
        supa.schema("pds").table("sync_log").insert(row).execute()
    except Exception as e:
        log.warning(f"sync_log insert ({source}|{data_type}) failed: {e}")


def now_epoch() -> float:
    """Convenience for ETLs that want a started_at floating point timestamp."""
    return time.time()
