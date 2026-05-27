# Context — Onyx ETL Correctness & Idempotency Audit

You are reviewing 13 ETL Python scripts + 9 GitHub Actions workflows that ingest data from 8 third-party sources into Supabase Postgres for a personal health-analytics platform.

## What Onyx is

n=1 single-user system. Riley. Daily-or-hourly batch ETL via GitHub Actions, no real-time streaming. Frontend on Vercel reads from the same Supabase. All write paths go through these ETL scripts; the frontend is read-only with two narrow exceptions (habit completions + supplement intake + meal events + weight log have small POST APIs that write directly).

## Data sources covered by this bundle

| ETL | Source | Cadence | API type | Token model |
|---|---|---|---|---|
| `garmin_etl.py` | Garmin Connect | hourly | unofficial API (`garminconnect` lib) | OAuth1 + persisted session via `pds.ci_tokens` |
| `whoop_etl.py` | WHOOP API v2 | hourly | official REST | OAuth2 refresh token in `pds.ci_tokens` |
| `eight_sleep_etl.py` | Eight Sleep | daily (3 PM ET) | unofficial API | email + password (re-auth per run) |
| `spotify_etl.py` | Spotify | every 2h | official REST | OAuth2 + Feb 2026 API migration paths |
| `journal_etl.py` | Notion personal journal | hourly | Notion API + Voyage embeddings | API key |
| `myfitnesspal_email.py` + `_import.py` | MFP CSV email export | hourly | IMAP poll | app password |
| `whoop_journal_email.py` + `_import.py` + `_watcher.py` | WHOOP journal CSV email export | hourly | IMAP poll | app password |
| `supplement_lookup.py` | NIH DSLD (supplement product lookup) | manual / on-demand | public DSLD REST | none |
| `ci_token_helper.py` | OAuth token rotation utility | manual | n/a | reads/writes `pds.ci_tokens` |
| `hrv_backfill_check.py` | Backfill detection + retrain trigger | hourly | reads sync_log | n/a |

## Orchestration (GitHub Actions workflows in `workflows/`)

| Workflow | Cron | What it runs |
|---|---|---|
| `daily-etl.yml` | `0 * * * *` | Hourly: Garmin + WHOOP (2 parallel jobs, both call their .py) |
| `eight-sleep-etl.yml` | `0 19 * * *` | Daily 3 PM ET (data only updates post-sleep) |
| `mfp-email.yml` | `15 * * * *` | Hourly: IMAP check → MFP CSV import |
| `whoop-journal-email.yml` | `30 * * * *` | Hourly: IMAP check → WHOOP journal CSV import |
| `journal-sync.yml` | `35 * * * *` | Hourly: Notion → embeddings → `journal_entries` |
| `habits-sync.yml` | `45 * * * *` | Hourly: curls Vercel API route (sync logic lives in Next.js) |
| `spotify-etl.yml` | `50 */2 * * *` | Every 2h: recently-played + featurize via ReccoBeats |
| `hrv-prediction.yml` | `workflow_run` after ETL + 23:50 ET | Daily HRV prediction + actuals backfill |
| `hrv-retrain-on-backfill.yml` | `20 * * * *` + `0 12 * * *` | Conditional retrain on backfill signal + daily safety net |

## 30-day sync_log track record (as of 2026-05-25)

| source | runs | success | failed | partial | avg records/run |
|---|---|---|---|---|---|
| garmin | 220 | 220 | 0 | 0 | 34.7 |
| whoop | 590 | 590 | 0 | 0 | 26.1 |
| eight_sleep | 29 | 29 | 0 | 0 | 19.6 |
| spotify | 111 | 111 | 0 | 0 | 6.5 |
| reccobeats | 85 | 82 | 0 | 3 | 4.3 |
| musicbrainz | 85 | 80 | 0 | 5 | 1.6 |
| notion_journal | 131 | 131 | 0 | 0 | 40.2 |
| whoop_journal_email | 7 | 7 | 0 | 0 | 11486.7 |
| myfitnesspal | 2 | 2 | 0 | 0 | 3.5 |
| habit_journal | 311 | 311 | 0 | 0 | 1.0 (backfill signals) |

Operationally clean. Partial = MusicBrainz/ReccoBeats sometimes can't enrich every track (by design).

## Architectural patterns to evaluate

1. **Upsert idempotency.** Every write should be `INSERT ... ON CONFLICT DO UPDATE` on a natural key, never raw insert. Does every ETL hold to this? Are the conflict keys correct?
2. **Backfill semantics.** Most ETLs accept `--backfill N` and `--date YYYY-MM-DD`. Does `--backfill N` produce identical state to a fresh full sweep? Are dates idempotent on re-run?
3. **sync_log heartbeats.** Every run should write a row to `pds.sync_log` so the /status page shows freshness. Even on no-op (0 records) — does it?
4. **Token rotation safety.** WHOOP refresh tokens can rotate. Spotify scope changes mid-Feb-2026 require re-auth. `ci_token_helper.py` is the canonical write path. Does the ETL race-condition on writes? (CLAUDE.md documents Spotify last-write-wins as acceptable.)
5. **Retry behavior.** API rate limits, transient 5xx, OAuth token refresh during a run — what does each ETL do?
6. **IMAP-based imports.** `myfitnesspal_email.py` and `whoop_journal_email.py` poll an inbox for a user-triggered CSV export. What happens if the email is duplicated, malformed, or partial? What if Riley exports twice in a row?
7. **The behavioral-day attribution chain.** Every ETL writes a TIMESTAMPTZ event; triggers populate `onyx_*` columns. Does each ETL pass the right timestamp? Does any ETL bypass triggers via direct SQL?
8. **GitHub Actions failure modes.** What happens if a workflow's token expires? If the cron skips? If a step ooms? Is there alerting?
9. **Cross-ETL dependencies.** WHOOP cycles must land before WHOOP journal can attribute behaviors_date. Garmin activities must land before GPS-TZ backfill can run. Are these ordering constraints respected?

## Where this overlaps with prior bundles

The schema bundle audited table structure; the TZ bundle audited the ADR-0001 trigger functions; the stats bundle audited the analysis pipeline. **This bundle audits the upstream ingestion paths feeding all of those.** A bug in `whoop_etl.py:upsert_cycles` is in scope here; a bug in `set_onyx_dates_whoop_cycles` is in scope for the TZ audit (already complete).

## Out of scope

- Frontend code (separate review)
- Statistical analysis on top of ingested data (covered by stats bundle)
- Schema design itself (covered by schema bundle)
- TZ trigger correctness (covered by TZ bundle)
