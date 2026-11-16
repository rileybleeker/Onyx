"""Manual backfill: recover median_bed_temp / median_room_temp for EVERY
pds.eight_sleep_trends row that stores a NULL temp, whatever its age.

The daily ETL already does this on its own for the last 60 days
(eight_sleep_etl.self_heal_temps, at most 20 lookups per run). This script
runs the same function with no look-back bound and a much higher cap, for a
gap older than that window. From GitHub Actions the same thing is
`gh workflow run eight-sleep-etl.yml -f selfheal_days=N`.

Why it works: Eight Sleep's /intervals collection endpoint only returns the
10 most recent sessions, but the per-ID endpoint /users/{uid}/intervals/{sid}
returns the full interval with timeseries for ANY session ID, and every
stored trends payload carries mainSessionId + sessionIds.

Usage:
    python eight_sleep_temp_backfill.py            # dry-run, no DB writes
    python eight_sleep_temp_backfill.py --apply    # actually write to Supabase
    python eight_sleep_temp_backfill.py --compare  # read-only: stored vs main session
    python eight_sleep_temp_backfill.py --compare --max-lookups 3000  # raise the lookup cap

Only NULL columns are written; existing values are never overwritten. Reads
at most 1000 rows per run, so re-run until it reports 0 candidate rows.

--compare is step 1 of the affected-history plan in
docs/eight-sleep-date-contract.md: until 2026-11-16 the daily sync paired an
interval with a trend day by the date the session STARTED, so a night that
began before local midnight (or a nap) could put another session's temps on a
row. It pages through EVERY stored row, looks up each row's main session and
prints COUNTS only (same, differ, partial, ...) plus `complete` and `clean`;
it never writes and never prints a date or a value. Each run starts again
from the newest row, so an identical re-run repeats the same capped lookups:
when it reports over_cap > 0, re-run with a larger --max-lookups (at least
lookups + over_cap) instead. Provider and HTTP logging is
turned down while it runs, but treat the whole transcript as private anyway
(a crash traceback can still carry a provider id).

Credentials (every mode): importing eight_sleep_etl needs SUPABASE_URL,
SUPABASE_SERVICE_ROLE_KEY, EIGHTSLEEP_EMAIL and EIGHTSLEEP_PASSWORD in the
environment or a .env. Riley's PC has no .env and the Eight Sleep login is
held only as GitHub Actions secrets, so there the script stops with a
KeyError before it reads anything. Run --compare only in a shell session that
holds those variables for that session (never saved to a file in the repo or
under OneDrive), and never from Actions: its log is public and the counts are
aggregates of Riley's nights. Record the counts line privately (the
HIST-ETL-01 roadmap row), never in the repo, a PR or a public log. Details:
docs/eight-sleep-date-contract.md, "Affected-history plan".
"""

import sys
import time
import logging
from contextlib import contextmanager

import eight_sleep_etl as es

log = logging.getLogger("eight_sleep_temp_backfill")

BACKFILL_MAX_LOOKUPS = 1000   # per-ID API calls per run
BACKFILL_SCAN_LIMIT = 1000    # PostgREST returns at most 1000 rows per request


COMPARE_TOLERANCE = 0.005    # stored temps are NUMERIC(5,2)
COMPARE_PAGE_SIZE = 1000     # PostgREST's per-request maximum
COMPARE_MAX_ROWS = 50000     # stop paging here and report truncated=True
COMPARE_MAX_LOOKUPS = COMPARE_MAX_ROWS  # highest --max-lookups accepted

# Counts that leave a row unchecked: the row is neither clean nor a difference.
NOT_VERIFIABLE = ("unmapped_side", "no_session", "not_found", "no_temp")


def _stored_rows(sb, page_size: int, max_rows: int) -> tuple[list[dict], bool]:
    """Every eight_sleep_trends row, paged (newest first, stable order).

    Returns (rows, truncated). truncated=True when paging stopped at max_rows
    with a full last page, i.e. more rows may exist. A row read twice (a sync
    inserting a newer row between two pages shifts the offsets) counts once.
    """
    out: list[dict] = []
    seen: set[tuple] = set()
    offset = 0
    while True:
        page = (
            sb.schema("pds").from_("eight_sleep_trends")
            .select("calendar_date,bed_side,raw_json,median_bed_temp,median_room_temp")
            .order("calendar_date", desc=True)
            .order("bed_side")
            .range(offset, offset + page_size - 1)
            .execute()
        ).data or []
        for row in page:
            key = (row.get("calendar_date"), row.get("bed_side"))
            if key not in seen:
                seen.add(key)
                out.append(row)
        offset += page_size
        if len(page) < page_size:
            return out, False
        if offset >= max_rows:
            return out, True


def compare_temps(client, sb, users: dict[str, str],
                  max_lookups: int = BACKFILL_MAX_LOOKUPS,
                  page_size: int = COMPARE_PAGE_SIZE,
                  max_rows: int = COMPARE_MAX_ROWS,
                  delay_s: float = es.SELFHEAL_DELAY_S) -> dict:
    """Read-only: does each stored temp equal its trend day's main session?

    Pages through every row of the table. For each row with a stored bed or
    room temp, fetch /intervals/{id} of the row's main session (one call per
    distinct user + session, capped) and compare the medians the ETL would
    compute. Returns counts only:
      scanned              rows read (all rows, with or without temps)
      rows                 rows with at least one stored temp
      same                 every stored temp matches the main session
      differ               at least one stored temp does not match
      partial              no stored temp differs, but one could not be checked
                           (the session has no readings for that column)
      unmapped_side        bed side not on the device now (e.g. 'away')
      no_session           no known main session (see _session_id_from_raw)
      not_found / no_temp  session gone, or no readings for any stored column
      failed / over_cap    lookup error, or beyond the lookup cap
      not_verifiable       unmapped_side + no_session + not_found + no_temp
    `complete` (the scan finished) is True only when the whole table was read
    and every row with a stored temp was checked in full or is counted as not
    verifiable: truncated is False and failed, over_cap and partial are all 0.
    `clean` (the history question is answered "no harm") is True only when
    complete is True, differ is 0 AND not_verifiable is 0: a row that could
    not be checked is never clean, so complete with differ = 0 but
    not_verifiable > 0 means "no difference among the rows that could be
    checked", with the rest unresolved. `differ = 0` with complete=False
    proves nothing about the rows left out. Writes nothing.
    """
    stats = {"scanned": 0, "truncated": False, "rows": 0, "same": 0, "differ": 0,
             "partial": 0, "unmapped_side": 0, "no_session": 0, "not_found": 0,
             "no_temp": 0, "failed": 0, "over_cap": 0, "lookups": 0}
    rows, stats["truncated"] = _stored_rows(sb, page_size, max_rows)
    stats["scanned"] = len(rows)
    fetched: dict[tuple[str, str], object] = {}
    for row in rows:
        stored = {c: row.get(c) for c in es.TEMP_COLUMNS if row.get(c) is not None}
        if not stored:
            continue
        stats["rows"] += 1
        user_id = users.get(row.get("bed_side"))
        if not user_id:
            stats["unmapped_side"] += 1
            continue
        session_id = es._session_id_from_raw(row.get("raw_json"))
        if not session_id:
            stats["no_session"] += 1
            continue
        key = (user_id, session_id)
        if key not in fetched:
            if stats["lookups"] >= max_lookups:
                stats["over_cap"] += 1
                continue
            stats["lookups"] += 1
            try:
                fetched[key] = client.get_interval(*key)
            except Exception as e:  # noqa: BLE001 — counted, never raised
                fetched[key] = e
            time.sleep(delay_s)
        interval = fetched[key]
        if isinstance(interval, Exception):
            stats["failed"] += 1
            continue
        if interval is None:
            stats["not_found"] += 1
            continue
        ts = interval.get("timeseries") or {}
        found = {"median_bed_temp": es.median_timeseries(ts.get("tempBedC")),
                 "median_room_temp": es.median_timeseries(ts.get("tempRoomC"))}
        pairs = [(float(v), found[c]) for c, v in stored.items() if found[c] is not None]
        if not pairs:
            stats["no_temp"] += 1
        elif any(abs(a - b) > COMPARE_TOLERANCE for a, b in pairs):
            stats["differ"] += 1
        elif len(pairs) < len(stored):
            stats["partial"] += 1
        else:
            stats["same"] += 1
    stats["not_verifiable"] = sum(stats[k] for k in NOT_VERIFIABLE)
    stats["complete"] = (not stats["truncated"] and stats["failed"] == 0
                         and stats["over_cap"] == 0 and stats["partial"] == 0)
    stats["clean"] = (stats["complete"] and stats["differ"] == 0
                      and stats["not_verifiable"] == 0)
    return stats


def _max_lookups(args: list[str]) -> int:
    """The --max-lookups N value (per-ID calls for --compare), default 1000."""
    if "--max-lookups" not in args:
        return BACKFILL_MAX_LOOKUPS
    i = args.index("--max-lookups")
    try:
        n = int(args[i + 1])
    except (IndexError, ValueError):
        raise SystemExit("--max-lookups needs a whole number") from None
    if not 1 <= n <= COMPARE_MAX_LOOKUPS:
        raise SystemExit(f"--max-lookups must be between 1 and {COMPARE_MAX_LOOKUPS}")
    return n


@contextmanager
def _quiet_provider_logs():
    """Turn down the loggers that print provider ids (the ETL's authenticate
    line, retry warnings, httpx request URLs) while --compare runs."""
    names = ("eight_sleep_etl", "retry_helper", "httpx", "httpcore")
    saved = {n: logging.getLogger(n).level for n in names}
    for n in names:
        logging.getLogger(n).setLevel(logging.ERROR)
    try:
        yield
    finally:
        for n, level in saved.items():
            logging.getLogger(n).setLevel(level)


def main(argv: list[str] | None = None) -> dict:
    args = sys.argv[1:] if argv is None else argv
    apply = "--apply" in args
    compare = "--compare" in args
    if apply and compare:
        raise SystemExit("--compare is read-only; it cannot be combined with --apply")
    if "--max-lookups" in args and not compare:
        raise SystemExit("--max-lookups only applies to --compare")

    if compare:
        max_lookups = _max_lookups(args)
        with _quiet_provider_logs():
            client = es.EightSleepClient(es.EIGHTSLEEP_EMAIL, es.EIGHTSLEEP_PASSWORD,
                                         es.EIGHTSLEEP_TIMEZONE)
            try:
                client.authenticate()
                sb = es.get_supabase_client()
                stats = compare_temps(client, sb, es.discover_users(client),
                                      max_lookups=max_lookups)
            finally:
                client.close()
        log.info("=" * 60)
        log.info("COMPARE (read-only, nothing written): "
                 + ", ".join(f"{k}={v}" for k, v in stats.items()))
        if not stats["complete"]:
            log.info("Incomplete: differ=0 here does not clear the rows left out "
                     "(truncated, failed, over_cap or partial is not 0).")
            if stats["over_cap"]:
                log.info("An identical re-run repeats the same lookups; re-run with "
                         f"--max-lookups {stats['lookups'] + stats['over_cap']} or more.")
        elif not stats["clean"]:
            why = []
            if stats["differ"]:
                why.append(f"differ={stats['differ']} (Riley decides)")
            if stats["not_verifiable"]:
                why.append(f"{stats['not_verifiable']} row(s) could not be checked and "
                           "stay unresolved")
            log.info("Complete but not clean: " + "; ".join(why) + ".")
        return stats

    client = es.EightSleepClient(es.EIGHTSLEEP_EMAIL, es.EIGHTSLEEP_PASSWORD,
                                 es.EIGHTSLEEP_TIMEZONE)
    client.authenticate()
    sb = es.get_supabase_client()
    try:
        users = es.discover_users(client)  # {bed_side: user_id}
        stats = es.self_heal_temps(
            client, sb, users, es._today(),
            max_rows=BACKFILL_MAX_LOOKUPS, lookback_days=None,
            dry_run=not apply, scan_limit=BACKFILL_SCAN_LIMIT,
        )
    finally:
        client.close()

    log.info("=" * 60)
    log.info(f"{'APPLIED' if apply else 'DRY RUN'}: "
             f"{es._selfheal_summary(stats, BACKFILL_MAX_LOOKUPS)}")
    if not apply:
        log.info("Re-run with --apply to write these to the database.")
    return stats


if __name__ == "__main__":
    main()
