# Audit Prompt — Onyx ETL Correctness & Idempotency (Domain 4)

> **Re-audit notice:** This bundle was assembled fresh from current code on 2026-05-26. Audit independently — do not assume prior findings are still present or that the code has been fixed since.

## Role

You are an **independent reviewer of ETL correctness and idempotency** for a personal health-analytics pipeline. 13 Python ETL scripts + 9 GitHub Actions workflows feed Supabase Postgres from 8 third-party sources. The code was written by another AI without external review. Audit it.

**Framing:**
- n=1 single-user system. Daily-or-hourly batch (no streaming). GitHub Actions cron + workflow_run.
- 30-day sync_log shows operationally clean track record (0 fails / 1581 runs) but this is no guarantee of correctness — silent bugs can mis-write without raising. Your job is to look for those.
- You cannot run the code or query Supabase. Reason from the Python + YAML in this bundle.

**Do not assume the existing implementation is correct.**

## What to review

Files in this bundle:
- **13 Python ETLs** at bundle root (`garmin_etl.py`, `whoop_etl.py`, `eight_sleep_etl.py`, `spotify_etl.py`, `journal_etl.py`, `myfitnesspal_*.py`, `whoop_journal_*.py`, `supplement_lookup.py`, `ci_token_helper.py`, `hrv_backfill_check.py`)
- **9 GitHub workflows** in `workflows/` — orchestration + scheduling
- **7 schema files** in `schemas/` — for understanding write targets

Read in this order: `CONTEXT.md` → workflows/ (to understand cadence) → each ETL Python file → schemas for the write target.

## Rubric — four 1-5 scores

| Dimension | What 1 means | What 5 means |
|---|---|---|
| **Correctness** | ETLs write wrong data, silently drop rows, or violate idempotency. | Every write is upsert-on-natural-key. Backfills are deterministic. Right values land in right rows. |
| **Robustness** | Breaks on rate limit, transient 5xx, malformed source data, token expiry. | Handles every reasonable failure mode. Retries with backoff. Token rotation is safe. sync_log captures everything. |
| **Scalability** | Won't survive 3× growth. Linear scans where indexed lookups exist. Polling without backoff. | Linear or sub-linear. Pagination correct. Polling intervals match source's rate limits. |
| **Idiomaticness** | Bespoke patterns. Doesn't use library features correctly (supabase-py, garminconnect, etc.). | Standard idioms. Composable functions. Clear separation between fetch / parse / write. |

## Severity scale

- **P0** — produces wrong data today. Example: upsert key wrong; writes orphan rows; loses records on rerun; token rotation race actually corrupts shared state.
- **P1** — incorrect under foreseeable conditions. Example: API returns a new field type and the parser crashes; refresh token expires and the script has no recovery path; IMAP duplicates trigger duplicate imports.
- **P2** — works but brittle or inefficient. Example: per-row HTTP call where batch is available; missing retry on 5xx; sync_log heartbeat skipped on no-op runs.
- **P3** — style / consistency.

## Effort

- **S** — < 1 hour
- **M** — half-day
- **L** — full day
- **XL** — multi-day (e.g. rewriting an ETL's upsert layer)

## Highest-priority audit questions

1. **Upsert correctness.** For every write: is the conflict key correct? Are there missed `ON CONFLICT DO UPDATE` clauses falling back to INSERT-fail?
2. **Backfill idempotency.** Does `--backfill N` produce the same database state as a fresh full sweep? Are there time-window edge cases?
3. **Token rotation safety.** WHOOP, Spotify, Garmin all have refresh-token flows. What happens if the ETL is mid-run when the token rotates? What if two cron jobs overlap?
4. **IMAP-based imports.** `myfitnesspal_email.py` and `whoop_journal_email.py` poll Gmail. Duplicate handling? Partial/truncated CSVs? What if Riley exports twice?
5. **Cross-ETL ordering.** WHOOP cycles must land before WHOOP journal attributes behaviors_date. Garmin activities must land before GPS TZ backfill runs. Are dependencies respected?
6. **sync_log coverage.** Every run should write a heartbeat row, even on no-op (0 records). Spotify writes 3 heartbeats per run (plays + reccobeats + musicbrainz). Are heartbeats consistent?
7. **Error handling vs silent skip.** When an API returns 5xx, does the ETL retry? Skip and continue? Crash? What's the failure visibility?
8. **GitHub Actions concurrency.** Two `daily-etl.yml` runs can't overlap (probably) — but two different workflows might (Spotify + Garmin). Are there shared resources that race?
9. **Trigger bypass risk.** Some ETLs may use raw SQL or batch writes that bypass the ADR-0001 triggers. Does any?
10. **The semi-automated MFP path.** Riley has to manually request CSV export from MFP's web UI, then the cron picks it up. Document this workflow's robustness end-to-end.

## Output format — REQUIRED

Single JSON object, no prose outside it, no markdown fences. Same schema as the other bundles:

```json
{
  "reviewer_metadata": {"model": "...", "review_date": "2026-05-26", "bundle_commit": "83f7a0a"},
  "domain_scores": {
    "correctness":    {"score": 4, "rationale": "..."},
    "robustness":     {"score": 3, "rationale": "..."},
    "scalability":    {"score": 4, "rationale": "..."},
    "idiomaticness":  {"score": 4, "rationale": "..."}
  },
  "summary": "200-500 word narrative — what's working, what isn't, top 3 fixes.",
  "findings": [
    {
      "id": "F-001",
      "title": "Short title (<80 chars)",
      "severity": "P0|P1|P2|P3",
      "effort": "S|M|L|XL",
      "dimensions": ["Correctness", ...],
      "file_ref": "<file>:<line>",
      "description": "What's wrong.",
      "evidence": "Code reference / reasoning.",
      "recommendation": "What to do."
    }
  ],
  "things_done_well": [...],
  "questions_for_followup": [...]
}
```

5–20 substantive findings. Save credit in `things_done_well`. Concrete file refs always.

Now produce the JSON.
