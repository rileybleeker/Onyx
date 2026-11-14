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

Only NULL columns are written; existing values are never overwritten. Reads
at most 1000 rows per run, so re-run until it reports 0 candidate rows.
"""

import sys
import logging

import eight_sleep_etl as es

log = logging.getLogger("eight_sleep_temp_backfill")

BACKFILL_MAX_LOOKUPS = 1000   # per-ID API calls per run
BACKFILL_SCAN_LIMIT = 1000    # PostgREST returns at most 1000 rows per request


def main(argv: list[str] | None = None) -> dict:
    apply = "--apply" in (sys.argv[1:] if argv is None else argv)

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
