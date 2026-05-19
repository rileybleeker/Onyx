# Onyx — Claude Code Instructions

Personal health data aggregation and analytics platform.
Syncs biometric data from Garmin, WHOOP, and Eight Sleep into a unified Supabase Postgres database,
visualized via a Next.js frontend with AI-powered analysis through Claude.

## Project Structure

```
Onyx/
├── garmin_etl.py            # Garmin Connect → Supabase (8 tables)
├── whoop_etl.py             # WHOOP API v2 → Supabase (5 tables)
├── whoop_journal_import.py  # WHOOP Journal CSV export → Supabase
├── whoop_journal_email.py   # IMAP monitor: auto-downloads WHOOP export → Supabase
├── whoop_journal_watcher.py # Watches journal_inbox/ for auto-import
├── journal_inbox/           # Drop WHOOP journal CSVs here
├── journal_archive/         # Processed CSVs moved here
├── eight_sleep_etl.py       # Eight Sleep API → Supabase (1 table)
├── myfitnesspal_import.py   # MyFitnessPal CSV → Supabase (nutrition table)
├── myfitnesspal_email.py    # IMAP monitor: auto-imports MFP CSV export emails
├── mfp_inbox/               # Drop MFP nutrition CSVs here for auto-import
├── mfp_archive/             # Processed CSVs moved here
├── spotify_etl.py           # Spotify recently-played → Supabase (plays + tracks + artists w/ MusicBrainz genres)
├── spotify_schema.sql       # Spotify table DDL + spotify_daily_signature view
├── spotify_playlists_schema.sql  # Spotify playlists audit table DDL
├── ci_token_helper.py       # Download/upload OAuth tokens for CI
├── hrv_analysis.py          # HRV deep analysis pipeline (Phases 1-3.5): data loading,
│                            #   ~350-column / ~250-feature matrix, stat analysis, XGBoost/SARIMAX/Prophet,
│                            #   walk-forward backtest, stores results to Supabase
├── hrv_predict.py           # Daily HRV prediction: loads saved model, predicts tomorrow,
│                            #   backfills actuals, recomputes rolling metrics, drift check
├── hrv_backfill_check.py    # Detects historical backfill (any row with calendar_date older
│                            #   than 2 days, updated since the last hrv_analysis_results
│                            #   computed_at). Emits GitHub Actions output
│                            #   backfill_detected=true|false.
├── requirements-analysis.txt # Python deps for HRV analysis (xgboost, statsmodels, prophet, etc.)
├── analysis_output/         # Generated plots + xgboost_hrv_model.pkl (gitignored)
├── .github/workflows/
│   ├── daily-etl.yml            # Hourly Health ETL: Garmin + WHOOP (`0 * * * *`)
│   ├── eight-sleep-etl.yml      # Eight Sleep ETL — daily at 3 PM ET (`0 19 * * *`)
│   ├── mfp-email.yml            # MyFitnessPal email check (`15 * * * *`)
│   ├── whoop-journal-email.yml  # WHOOP journal email check (`30 * * * *`)
│   ├── habits-sync.yml          # Habits sync from Notion (`45 * * * *`)
│   ├── spotify-etl.yml          # Spotify recently-played (`50 */2 * * *`)
│   ├── hrv-prediction.yml       # HRV prediction — auto-runs after each ETL via workflow_run, plus guaranteed 23:50 ET finalization (DST-safe)
│   └── hrv-retrain-on-backfill.yml  # HRV Analysis Retrain — hourly backfill check + daily 12:00 UTC safety-net
├── whoop_schema.sql         # WHOOP table DDL
├── eight_sleep_schema.sql   # Eight Sleep DDL + daily_health_matrix view
├── sql/
│   ├── rls_policies.sql     # Row-Level Security policies
│   └── ci_tokens.sql        # CI token storage table
├── ARCHITECTURE.md          # Full system architecture reference
├── .env                     # Secrets (NEVER commit)
└── frontend/                # Next.js 15 app
    └── src/
        ├── app/             # Pages (14 routes) + API routes
        │   ├── analytics/hrv/  # HRV Analysis dashboard (predictions, SHAP, models)
        │   └── spotify/        # Spotify listening dashboard (volume, mood signature, sonic profile radar, top artists/tracks)
        ├── components/      # AppShell, Sidebar, MobileNav, ChartCard, StatCard
        └── lib/             # Supabase clients, queries.ts, format.ts
```

## Tech Stack

- **ETL**: Python 3, httpx, garminconnect, supabase-py, python-dotenv
- **Database**: Supabase (Postgres 17), schema `pds`, 19 tables + `journal` unified view + 3 HRV analysis tables (`hrv_predictions`, `hrv_model_metrics`, `hrv_analysis_results`) + Spotify (`spotify_plays`, `spotify_tracks`, `spotify_artists`, `spotify_playlists`, `spotify_daily_signature` view)
- **Frontend**: Next.js 15, React 19, Tailwind CSS 4, Recharts 3.8, TypeScript 5
- **AI Chat**: Claude Sonnet 4, agentic tool-use loop with 17 tools (11 query + mark_habit_complete + query_journal + query_eight_sleep + search_spotify_catalog + query_spotify_tracks_by_features + create_spotify_playlist). Habit completion via chat syncs to both Supabase and Notion. Playlist creation goes via `lib/spotify-server.ts` which refreshes the access token on every call against `pds.ci_tokens` and writes any rotated refresh token back so the Python ETL stays in sync.
- **System Status**: `/status` page — 10 source cards (Garmin, WHOOP, Eight Sleep, WHOOP Journal, Habits, MyFitnessPal, HRV Analysis, Spotify, **ReccoBeats**, **MusicBrainz**), KPI summary, 20-entry sync history. `GET /api/status` queries `pds.sync_log` by `(source, data_type)` key + `MAX()` date per data table. Auto-refreshes every 60s. ReccoBeats + MusicBrainz are *enrichment* subsystems (not ingestion) — their freshness is based on `sync_start` recency (heartbeat) rather than data age, because "no new items to enrich today" is healthy, not stale. `enrichmentSource()` helper in `api/status/route.ts` encodes that semantics: >12h since last heartbeat = failed, >4h = partial, otherwise success. `spotify_etl.py` writes a sync_log row for each subsystem every run (even with `records_synced=0`).
- **Auth**: Supabase Auth — email + password (primary) with magic link fallback. RLS on all tables. `/account` page exposes `supabase.auth.updateUser({ password })` for self-service password changes.
- **Hosting**: Vercel (frontend), Supabase Cloud (database)

## Commands

```bash
# ETL (runs automatically via GitHub Actions every hour on :00)
python garmin_etl.py                    # Sync last 7 days
python whoop_etl.py                     # Sync last 30 days
python whoop_journal_import.py <csv>    # Import WHOOP journal CSV export
python whoop_journal_email.py --once   # Check email for WHOOP export, import journal
python whoop_journal_watcher.py        # Watch inbox folder for auto-import
python eight_sleep_etl.py               # Sync last 7 days
python myfitnesspal_import.py <csv>     # Import MFP nutrition CSV export
python myfitnesspal_email.py --once    # Check email for MFP export, import
python <etl>.py --backfill N            # Backfill N days
python spotify_etl.py --auth            # One-time Spotify OAuth bootstrap (local)
python spotify_etl.py                   # Sync recently-played (last 50 since high-water mark)
python spotify_etl.py --refeaturize     # Backfill audio features for tracks with NULL valence
python spotify_etl.py --backfill-artists # Enrich every distinct artist in spotify_plays (one-time, after schema change)
python spotify_etl.py --refresh-genres   # Re-fetch MusicBrainz tags for spotify_artists rows with empty genres

# CI Token Management
python ci_token_helper.py upload garmin   # Seed/update Garmin tokens in Supabase
python ci_token_helper.py upload whoop    # Seed/update WHOOP tokens in Supabase
python ci_token_helper.py upload spotify  # Seed/update Spotify tokens in Supabase
python ci_token_helper.py download garmin # Restore Garmin tokens from Supabase
python ci_token_helper.py download whoop  # Restore WHOOP tokens from Supabase
python ci_token_helper.py download spotify # Restore Spotify tokens from Supabase

# GitHub Actions
gh workflow run daily-etl.yml           # Manually trigger ETL workflow
gh workflow run whoop-journal-email.yml # Manually trigger journal email check

# Frontend
cd frontend && npm run dev              # Dev server on :3000
cd frontend && npm run build            # Production build
cd frontend && npm run lint             # ESLint

# Install
pip install garminconnect supabase python-dotenv httpx requests
pip install -r requirements-analysis.txt  # HRV analysis deps
cd frontend && npm install

# HRV Analysis Pipeline (run once or after major data changes)
python hrv_analysis.py                  # Full pipeline: data + stats + models + store
python hrv_analysis.py --skip-analysis  # Skip stat plots (faster retraining)
python hrv_predict.py --predict         # Daily prediction (run after ETL)
python hrv_predict.py --backfill-only   # Just backfill actuals + recompute metrics
gh workflow run hrv-prediction.yml      # Manually trigger daily prediction in CI
```

## Database

- Schema: `pds`
- All tables use upsert with conflict resolution (idempotent ETL)
- `habit_journal` table stores habit completions (same schema as `whoop_journal`)
- `journal` view UNIONs `whoop_journal` + `habit_journal` with a `source` column for unified analysis
- Habit definitions are managed in Notion (Habits DB under Project Onyx, ID: `29cc936fd5e14ae8b10a4fe5c5f7a6cd`)
- Bidirectional sync: completions from Onyx/Chat update both Supabase and Notion; Notion "Last Completed" syncs to Supabase on page load
- `habit_name_map` tracks Notion page ID → name; renaming a habit in Notion auto-updates all historical `habit_journal` entries
- `myfitnesspal_nutrition` stores daily nutrition totals (calories, macros, fiber, sugar, sodium) + `meals_json` JSONB for per-meal breakdown. Import via CSV export (Settings → Export Data in MFP app). Email automation in `myfitnesspal_email.py` checks inbox every 4h via `mfp-email.yml`. Uses same IMAP credentials as WHOOP journal. Manual: drop CSV in `mfp_inbox/` or run `myfitnesspal_import.py <csv>`.
- `ci_tokens` table stores rotating OAuth tokens for GitHub Actions (Garmin + WHOOP)
- RLS enabled: anon key = read-only, service role key = full access
- Sync operations logged to `pds.sync_log`
- `whoop_journal` data is boolean-only (Yes/No) — WHOOP's CSV export does not include quantity values entered in the app (e.g., "3 drinks", "200mg caffeine"). This is a WHOOP platform limitation.
- HRV analysis tables: `hrv_predictions` (model forecasts + actuals), `hrv_model_metrics` (rolling eval), `hrv_analysis_results` (correlations, journal impact, model comparison as JSON)
- `pds.hrv_predictions_latest` view — DISTINCT ON (prediction_date, model, horizon_days) returning freshest row per forecast, excludes backtest. **All UI/analytics reads should go through the view**; the raw table accumulates multiple runs per day and generic fetches hit row limits fast. DDL in `sql/hrv_predictions_latest.sql`.
- `supabase-py` schema access: always use `supa.schema("pds").from_(table)` — NOT `supa.table()` which defaults to `public`
- `whoop_workouts` has no `cycle_id` column; use `workout_id` + derive `calendar_date` from `start_time` via ET-of-start (see TZ convention below)
- **Timezone convention: `America/New_York` (ET) is canonical for all calendar_date joins.** Raw timestamps are stored as true UTC instants (WHOOP `start_time`, WHOOP `measured_at`, Garmin `sleepStartTimestampGMT`). Date-only columns (MFP, Eight Sleep, WHOOP journal, habits) are already ET-aligned. Derived calendar_dates follow these rules in `daily_health_matrix`:
  - **Point-in-time events** (workouts, weigh-ins): `(start_time AT TIME ZONE 'America/New_York')::date`
  - **WHOOP cycles** (bedtime-to-bedtime spans): `((start_time + INTERVAL '12 hours') AT TIME ZONE 'America/New_York')::date` — lands at midday of the wake day, the canonical "day" the cycle represents. The `+12h` is required because `start_time` is the previous evening's bedtime; a naive ET-of-start would mis-tag the cycle to the day before. Robust to any bedtime drift.
  - **Garmin `start_time_local`**: stored as local wall-clock labeled as UTC (+00); `::date` yields ET date directly.
  - The `hrv_analysis.py` pipeline mirrors these rules via `to_date_str()`, `to_et_date_str()`, and `to_cycle_et_date_str()` helpers.
- **HRV columns are not interchangeable across sources.** `whoop_recovery.hrv_rmssd_milli` is RMSSD in milliseconds, measured during the WHOOP-detected sleep cycle. `garmin_hrv.last_night_avg_ms` is Garmin's proprietary time-weighted average of 5-minute HRV samples during sleep — *not* RMSSD; the unit is ms but the algorithm is different. `eight_sleep_trends.avg_hrv` is undocumented by Eight Sleep. Treat each as its own variable; never average or substitute.
- **Garmin sleep timestamps:** `garmin_sleep.sleep_start` / `sleep_end` are stored as true UTC instants (`sleepStartTimestampGMT` from the API). The previously-used `*Local` field encoded the local clock as UTC, shifting timestamps by ~4-5h.
- **Spotify tables are isolated from health data by design.** `spotify_plays` + `spotify_tracks` are NOT joined into `daily_health_matrix`. Listening behavior stands on its own; any health correlation happens at view/query time only. `spotify_daily_signature` is a per-ET-date aggregate view (play counts, unique tracks/artists, mean audio features) — frontend reads go through it where possible. PK on `spotify_plays` is `(played_at, track_id)` for idempotent upserts. `played_date_et` is a stored generated column matching the ET-canonical TZ convention.
- **Spotify audio features come from ReccoBeats, not Spotify.** Spotify deprecated `/v1/audio-features` for apps registered after 2024-11-27 (this app is post-cutoff). `spotify_tracks.features_source` records provenance (`'reccobeats'` or null when unresolved). The `spotify_daily_signature` view only computes feature means over plays with non-null valence so partial coverage doesn't bias the signal.
- **Spotify OAuth scope is `user-read-recently-played playlist-modify-private`** — both ingestion (ETL) and write (playlist creation from chat or `/spotify` button) use the same refresh token in `pds.ci_tokens`. If the scope changes, re-run `python spotify_etl.py --auth` then `python ci_token_helper.py upload spotify`; old refresh tokens still work but only carry their original scope claim. The Next.js client (`lib/spotify-server.ts`) writes any rotated refresh token back to `ci_tokens` so the Python ETL stays in sync (rare race: last-write-wins, acceptable for personal scale).
- **Spotify Feb 2026 API migration** affects this codebase. Use the post-migration endpoints in `lib/spotify-server.ts`: `POST /me/playlists` (NOT the removed `POST /users/{user_id}/playlists`) for create, and `POST /playlists/{id}/items` (NOT the removed `/tracks`) for add. Symptom of using the old endpoints is a bare `403 {"error":{"status":403,"message":"Forbidden"}}` with no scope hint. Migration guide: https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide. Development Mode apps additionally require the app owner to have an active Spotify Premium subscription. **Batch GET endpoints (`/v1/artists`, `/v1/tracks`, `/v1/albums`, etc.) were also removed** — same bare-403 symptom; replacement is per-id `/v1/artists/{id}` etc. `spotify_etl.py:SpotifyClient.artists()` already does this with a 50ms sleep between calls.
- **`pds.spotify_playlists`** logs every playlist Onyx creates (one row per `playlist_id`) with `track_ids` JSONB, `created_via` (`'chat'` | `'button'`), and the originating `prompt` if from chat. Audit + UI history. Not joined to other tables.
- **`pds.spotify_artists`** is a dim table for artist enrichment (genres, images). Spotify's Dev Mode `GET /v1/artists/{id}` post-Feb 2026 strips `genres`, `popularity`, and `followers` from the response — only `id/name/images/href/uri` come back. So genres come from **MusicBrainz** (no API key, 1 req/sec, polite User-Agent), looked up by artist name; top match's tags (sorted by user-vote count, top 8) populate `genres` as a JSONB array. Hit rate during initial backfill: 49/51 artists matched. Two artists missed via name-format issues (`JAŸ-Z` diacritic, `¥$` collab project). Refresh empty rows with `python spotify_etl.py --refresh-genres`. Initial seed for existing artists: `python spotify_etl.py --backfill-artists` (Spotify enrich) then `--refresh-genres` (MusicBrainz tags). The regular ETL handles both for new artists. Genre tags are crowdsourced — expect some noise like "british", "2020s", "favorites" mixed in with real genres.
- **Spotify play coverage is incomplete by design.** `recently-played` only contains plays that Spotify's backend received — offline playback from Spotify-licensed partner devices (Garmin watches with downloaded playlists, some car head units, older standalone wearables) does **not** report per-track telemetry back to the account, so those plays are invisible to our ETL, to Wrapped, and to Spotify-generated personalization playlists. Phone/desktop/web app plays are reported in real time and *are* captured. The `/spotify` page surfaces this as a coverage note under the page header so users interpreting the sonic profile / volume / ledger understand the dashboard under-counts Garmin-heavy workout listening. No code-level fix is possible — Spotify's partner SDK simply doesn't pipe the data.

## Environment Variables

Root `.env` (Python ETL): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY,
GARMIN_EMAIL, GARMIN_PASSWORD, WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET,
EIGHTSLEEP_EMAIL, EIGHTSLEEP_PASSWORD, IMAP_HOST, IMAP_EMAIL, IMAP_APP_PASSWORD,
MFP_USERNAME, MFP_PASSWORD, SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REDIRECT_URI

`frontend/.env.local`: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY, NOTION_API_KEY, NOTION_HABITS_DB

## Claude Code Permissions

Configured in `.claude/settings.local.json`. Two layers of control:

**Permission Modes** (cycle with Shift+Tab in CLI):
- `default` — prompts for each tool on first use
- `acceptEdits` — auto-approves file edits, still prompts for bash
- `plan` — read-only, no edits or commands
- `bypassPermissions` — skip all prompts (isolated environments only)

**Pre-approved Bash Commands** (run without prompting in any mode):
`python`, `python3`, `pip`, `npm`, `npx`, `node`, `git`, `gh`, `ls`, `pwd`,
`which`, `where`, `find`, `curl`, `export`, `cmd.exe`, `wc`, `diff`, `sort`,
`mkdir`, `cp`, `mv`, `touch`

**Pre-approved Tools**: WebSearch, WebFetch, all Supabase MCP ops, Notion (fetch/search/update/create pages)

**Guard Hooks** (run before every tool call regardless of mode):
- `guard_path.sh` — validates file paths before Write/Edit/NotebookEdit
- `guard_bash.sh` — validates commands before Bash execution

**Not pre-approved** (always prompts): `rm`, `kill`, destructive commands, Supabase project lifecycle ops

## GitHub Actions ETL

All data sources run **hourly** on a staggered schedule to spread load and avoid thundering herds:

| Workflow | File | Cron | What it does |
|---|---|---|---|
| Hourly Health ETL | `daily-etl.yml` | `0 * * * *` | Garmin + WHOOP (2 parallel jobs) |
| Eight Sleep ETL | `eight-sleep-etl.yml` | `0 19 * * *` | Eight Sleep — daily at 3 PM ET (data only updates post-sleep) |
| MyFitnessPal email | `mfp-email.yml` | `15 * * * *` | IMAP check → import MFP nutrition CSV |
| WHOOP journal email | `whoop-journal-email.yml` | `30 * * * *` | IMAP check → import WHOOP journal CSV |
| Habits sync | `habits-sync.yml` | `45 * * * *` | Curls `POST /api/habits/sync` on Vercel |
| Spotify ETL | `spotify-etl.yml` | `50 */2 * * *` | Pulls recently-played; upserts plays + tracks; featurizes new tracks via ReccoBeats |
| HRV prediction | `hrv-prediction.yml` | `workflow_run` after hourly ETL + `50 3 * * *` + `50 4 * * *` | Backfills actuals + predicts next day. Hourly workflow_run runs give intra-day monitoring; the two scheduled crons land on 23:50 ET year-round (one per DST state — the `dst-gate` job skips the wrong-season run by checking `TZ=America/New_York date +%H == 23`). The 23:50 ET run captures the final day's imports (Habits at :45, journal at :30, MFP at :15) before ET midnight closes the day. **`hrv_predict.py` uses `et_today()` (`zoneinfo.ZoneInfo("America/New_York")`) for all date arithmetic** — a UTC `date.today()` on the runner would mis-tag the late-ET-evening run as the day-after-next. |
| HRV Analysis Retrain | `hrv-retrain-on-backfill.yml` | `20 * * * *` + `0 12 * * *` | Two triggers: (1) hourly backfill check via `hrv_backfill_check.py` — runs full `hrv_analysis.py` only if any row with `calendar_date < today-2` was updated since last `hrv_analysis_results.computed_at`. (2) Daily unconditional retrain at 12:00 UTC (~8am ET) — safety net so correlations stay fresh even if no backfill ever fires. The decision is made by the "Decide whether to retrain" step that branches on `github.event.schedule` / `github.event_name`. |

Notes:
- **Filename vs. display name**: `daily-etl.yml` kept for git history; workflow display name is **"Hourly Health ETL"**. The `hrv-prediction.yml` `workflow_run` trigger references the display name.
- **Manual trigger**: `gh workflow run <workflow-file>.yml` for any of them.
- **Token persistence**: Garmin/WHOOP tokens stored in `pds.ci_tokens`, managed by `ci_token_helper.py`.
- **Token recovery (Garmin)**: If Garmin tokens expire in CI, re-run ETL locally then `python ci_token_helper.py upload garmin`.
- **Token recovery (WHOOP)**: If WHOOP refresh token expires (400 on token refresh), re-run `python whoop_etl.py --days 7` locally then `python ci_token_helper.py upload whoop`. WHOOP tokens can expire after several days of failed refreshes — check `/status` page for silent failures. Hourly cadence increases risk here — monitor closely.
- **GitHub Secrets**: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GARMIN_EMAIL, GARMIN_PASSWORD, WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET, EIGHTSLEEP_EMAIL, EIGHTSLEEP_PASSWORD, EIGHTSLEEP_CLIENT_ID, EIGHTSLEEP_CLIENT_SECRET, IMAP_HOST, IMAP_EMAIL, IMAP_APP_PASSWORD, SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET.
- **Spotify bootstrap (one-time, local)**: register app at developer.spotify.com → set redirect URI to `http://127.0.0.1:8888/callback` → put `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` in `.env` → run `python spotify_etl.py --auth` (opens browser) → `python ci_token_helper.py upload spotify`. CI uses `ci_token_helper.py download spotify` at the start of each run and re-uploads after (refresh tokens occasionally rotate).
- **Actions minutes**: Repo is private; hourly schedule is estimated to use ~3000–6000 min/month, likely over the 2000-min free tier. Monitor usage under GitHub → Settings → Billing.

## Conventions

- After making frontend changes, always start the dev server (`cd frontend && npm run dev`) so the user can see updates immediately in the browser
- After completing a task, always commit and push to git — Vercel auto-deploys from `master` (root directory: `frontend`)
- ETL scripts are standalone Python files at the project root (not in a package)
- Frontend follows Next.js App Router conventions (page.tsx per route)
- Supabase queries go in `frontend/src/lib/queries.ts`
- Reusable UI components go in `frontend/src/components/`
- **Sidebar and MobileNav must stay in sync.** `Sidebar.tsx` (desktop) and `MobileNav.tsx` (mobile PWA drawer) maintain independent `nav` arrays — they do not share a source. Any nav change (new route, label, icon, ordering, shortcut) must be applied to **both files** in the same commit, or the mobile app silently falls out of sync. When adding a new route, grep both files (`grep -l "nav = \[" frontend/src/components/`) and update each.
- SQL schema changes: create a .sql file, then apply via Supabase MCP or dashboard
- Always upsert (never raw insert) to keep ETL idempotent
- Never commit secrets (.env files are gitignored)

## Known Issues / TODOs

- **Spotify-created playlists are public, not private** (open as of 2026-05-17). The chat tool and `/spotify` button both pass `public: false` on create, and `lib/spotify-server.ts` also issues a follow-up `PUT /playlists/{id}` with `public: false`, but Spotify's API silently ignores both on Development Mode apps — playlists land in the user's profile as Public. Empirical test: POST `{public:false}` → 201, GET → `public:true`. PUT `{public:false}` → 200, GET → still `public:true`. Verified in the Spotify app: newly-created playlist (commit `498a718`) still shows the "Public Playlist" label. The `PUT /playlists/{id}/followers` endpoint with `public:false` (controls the owner's follow relationship — separate mechanism) was tested but not confirmed end-to-end as of session close. Per Spotify docs ([playlists concepts](https://developer.spotify.com/documentation/web-api/concepts/playlists)), "modifying access is currently not possible through the WebAPI." Long-term fix options: (a) apply for **Extended Quota Mode** in the Spotify dashboard (manual review, days), which unlocks normal API behavior; (b) wire up `PUT /playlists/{id}/followers` properly and verify in the app — possibly the real lever for owner profile visibility; (c) accept the limitation and surface a UI affordance ("Created Public — toggle to Private in Spotify if desired"). Test playlists left in the user's Spotify account that can be deleted manually: "Onyx diag (delete me)", "Onyx Chat Test", "Onyx — Top tracks May 16, 2026", "Onyx visibility test".
