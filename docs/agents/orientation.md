# Orientation: layout, stack, commands, environment

Part of the Onyx agent instructions: [root](../../AGENTS.md) · [index](README.md). These rules bind every change in this area.

- **Owner (source of truth):** repo root, `ARCHITECTURE.md`, `frontend/package.json`, `requirements*.txt`.
- **Moved** from the root `AGENTS.md` at `65d813f` on 2026-11-16, verbatim except where a line says "Corrected" and the cross references listed under "Edited while moving" in [README.md](README.md). Last reviewed 2026-11-16.
- Dated notes, counts, schedules and "not applied yet" remarks are history: check them against the current source. Paths are repository-root-relative; `lib/…`, `app/…`, `components/…` mean `frontend/src/…`. A section name in quotes ("under Database", "see Conventions") is listed in [README.md](README.md).

## About Onyx

Personal health data aggregation and analytics platform.
Syncs biometric data from Garmin, WHOOP, and Eight Sleep into a unified Supabase Postgres database,
visualized via a Next.js frontend with AI-powered analysis through Claude.

## Project Structure

```
Onyx/
├── garmin_etl.py            # Garmin Connect → Supabase (8 tables)
├── whoop_etl.py             # WHOOP API v2 → Supabase (5 tables)
├── whoop_journal_import.py  # DECOMMISSIONED 2026-06-11 (WHOOP journal → habits merge; archive importer kept runnable)
├── whoop_journal_email.py   # DECOMMISSIONED 2026-06-11 (cron removed; workflow_dispatch fallback only)
├── whoop_journal_watcher.py # DECOMMISSIONED 2026-06-11 (local watcher; pds.whoop_journal is write-blocked)
├── journal_inbox/           # (legacy) WHOOP journal CSV drop folder — no longer consumed
├── journal_archive/         # Processed WHOOP CSVs (historical raw exports — keep)
├── eight_sleep_etl.py       # Eight Sleep API → Supabase (1 table)
├── myfitnesspal_import.py   # MyFitnessPal CSV → Supabase (nutrition table); manual fallback only, Cronometer is primary
├── myfitnesspal_email.py    # IMAP monitor for MFP export emails; manual fallback only (workflow cron removed 2026-05-31)
├── mfp_inbox/               # MFP CSVs picked up only when `myfitnesspal_email.py` is run by hand (no scheduled job)
├── mfp_archive/             # Processed CSVs moved here
├── cronometer_etl.py        # Automated Cronometer web-export → Supabase (unofficial endpoints; replaces the manual export click)
├── cronometer_import.py     # Cronometer CSV/ZIP parser → Supabase (cronometer_nutrition_daily + cronometer_servings); run_import() reused by the ETL
├── cronometer_watcher.py    # FALLBACK: watches cronometer_inbox/ for manual ZIP drops (the ETL is the primary path now)
├── cronometer_schema.sql    # cronometer_nutrition_daily + cronometer_servings DDL (~80 cols, RLS, indexes)
├── cronometer_inbox/        # Drop Cronometer servings.csv + dailysummary.csv here (sole nutrition source post 2026-05-31)
├── cronometer_archive/      # Processed Cronometer CSVs moved here
├── spotify_etl.py           # Spotify recently-played → Supabase (plays + tracks + artists w/ MusicBrainz genres)
├── supplement_lookup.py     # NIH DSLD → Supabase (supplement_products dim; CLI: search/seed/seed-from-upc/list)
├── supplement_schema.sql    # supplement_products + supplement_intake + compound rollup views
├── supplement_stack_schema.sql # supplement_stack + supplement_stack_item (BOM-style recurring lists) + supplement_intake.stack_id provenance
├── meal_schema.sql          # meal_events + meal_timing_daily view (clock-time meal events for HRV timing analysis)
├── weight_schema.sql        # weight_log: one row per ET day, kg-stored body weight (tanita rollup primary + manual /nutrition override)
├── tanita_etl.py            # Tanita Health Planet → Supabase (tanita_measurements raw + weight_log daily rollup)
├── flights_email_etl.py     # Delta confirmation/trip-details/check-in emails (IMAP, BOTH Gmail accounts) → pds.flights (+ user_tz_log flight-auto)
├── delivery_email_etl.py    # Uber Eats receipt emails (IMAP, shares flights_email_etl.py plumbing) → pds.delivery_orders (merchant, order/delivery time, total — NO items)
├── air_quality_etl.py       # Open-Meteo Air Quality (keyless) → pds.air_quality_daily (hourly PM2.5 / US AQI averaged per ET day; heartbeat `air_quality|daily`); `--dry-run` needs no .env
├── google_calendar_etl.py   # Calendar iCal feeds (Google secret addresses; any ICS feed) → pds.calendar_events (one row per event instance, read-only, service-role only; heartbeat `google_calendar|events`); `--dry-run` prints counts only and needs no .env
├── weather_etl.py           # Open-Meteo archive (keyless) → pds.weather_daily (hourly weather aggregated per ET day; same home location as air quality; heartbeat `weather|daily`); `--dry-run` needs no .env
├── pollen_etl.py            # Atlanta Allergy & Asthma daily pollen count (keyless public page, ONE request per routine run; month calendar + the day's tree/grass/weed/mold block) → pds.pollen_daily; heartbeat `pollen|daily`; `--dry-run` needs no .env
├── simplefin_etl.py         # SimpleFIN Bridge (read-only bank feed, Access URL secret) -> pds.finance_accounts / finance_transactions / finance_balance_snapshots for /financials; counts-only output; heartbeats `simplefin|transactions` + `simplefin|balances`
├── orders_email_etl.py      # Shipping / delivery emails from stores, Amazon and UPS/FedEx/USPS (IMAP, both Gmail accounts, read-only) → pds.online_order_events → pds.online_orders for /orders
├── urgent_email_etl.py      # inbox-triage's Gmail labels Agent/Action + Agent/Deadline (IMAP, read-only, both accounts) → pds.inbox_emails metadata for Today's Urgent email
├── tanita_schema.sql        # tanita_measurements DDL (ADR-0001 quad trigger, RLS) + weight_log.source column
├── spotify_schema.sql       # Spotify table DDL + spotify_daily_signature view
├── spotify_playlists_schema.sql  # Spotify playlists audit table DDL
├── journal_etl.py           # Notion personal Journal → Supabase (entries + Voyage embeddings)
├── journal_schema.sql       # pds.journal_entries table + search_journal_entries RPC
├── ci_token_helper.py       # Download/upload OAuth tokens for CI
├── sync_log_helper.py       # Shared pds.sync_log writer — always sets sync_start + sync_end + duration
├── retry_helper.py          # Shared httpx retry wrapper: exponential backoff + 429 Retry-After honoring
├── experiment_design.py     # N-of-1 trials: permuted-block allocation from a committed seed + protocol validation (pure)
├── experiment_analysis.py   # N-of-1 trials: end-of-trial randomization test with carryover term; refuses before the registered end (pure)
├── experiment_admin.py      # N-of-1 trials: seed / register / verify / stop, run by Riley via experiment-admin.yml (see "Experiments")
├── experiment_adherence.py  # N-of-1 trials: per-day adherence from Screen Time (once settled) + the check-in answer (pure)
├── experiment_report.py     # N-of-1 trials: daily report job (progress counts while running, the final analysis once, at the end)
├── experiment_notion.py     # N-of-1 trials: Notion mirror of a trial in "Onyx Experiments" (called by experiment_report.py; best-effort)
├── hrv_analysis.py          # HRV deep analysis pipeline (Phases 1-3.5): data loading,
│                            #   ~350-column / ~250-feature matrix, stat analysis, XGBoost/SARIMAX/Prophet,
│                            #   walk-forward backtest, stores results to Supabase
├── causal_inference.py      # Phase 2.5: doubly-robust causal estimates (AIPW + PSM + naive)
│                            #   for every binary + continuous treatment, with E-value sensitivity
│                            #   analysis. Imported by hrv_analysis.py; surfaced as causal/* rows
│                            #   in pds.hrv_analysis_results and rendered on /analytics/hrv.
├── hrv_predict.py           # Daily HRV prediction: loads saved model, predicts tomorrow,
│                            #   backfills actuals, recomputes rolling metrics, drift check
├── hrv_backfill_check.py    # Detects historical backfill (any row with calendar_date older
│                            #   than 2 days, updated since the last hrv_analysis_results
│                            #   computed_at). Emits GitHub Actions output
│                            #   backfill_detected=true|false.
├── requirements-analysis.txt # Python deps for HRV analysis (xgboost, statsmodels, prophet, etc.)
├── analysis_output/         # Generated plots + xgboost_hrv_model.pkl (gitignored)
├── tools/kindle_harvest/    # LOCAL-PC Kindle harvester (Playwright + signed-in Chrome, Task Scheduler every 3h): reads the Kindle for Web reader (TOC, page map, annotations w/ positions+timestamps, Whispersync position) → POST /api/reading/highlights/import (CI token) → auto sessions; heartbeats kindle|highlights
├── tools/ubereats_harvest/  # LOCAL-PC Uber Eats item harvester (Playwright + signed-in Chrome in an OFF-SCREEN window — headless is blocked by Uber; Task Scheduler "Onyx Uber Eats Harvest" every 6h): order history → POST /api/delivery/items/import (CI token) → pds.delivery_order_items + per-dish kcal/macro estimates; heartbeats ubereats|items
├── tools/pc_activity_logger/ # LOCAL-PC activity logger (stdlib Python under pythonw.exe, Task Scheduler "Onyx PC Activity Logger", one long-running process sampling every 30 s): idle seconds + the foreground program's exe name only (never titles, URLs or keys) → hourly upsert to pds.pc_activity_hours/apps with ~/.onyx_supabase_secret; heartbeats pc_activity|usage
├── tools/local_cleanup/     # LOCAL-PC %TEMP% cleanup (stdlib Python, dry run by default; weekly Task Scheduler "Onyx Local Cleanup" via pythonw --apply once Riley runs register-task.ps1): Recycle Bin only, for agent scratch / test temp leftovers; never .git folders, listed Claude sessions' scratch, anything touched in 12 h or paths over 259 chars. Rules: docs/local-cleanup.md
├── tools/ai_usage_harvest/ # LOCAL-PC AI tool usage harvester (stdlib Python under pythonw.exe, Task Scheduler "Onyx AI Usage Harvest" every 3h): Claude Code + Codex session logs → METADATA ONLY (times, token counts, prompt / tool-call counts, model names, project folder name; never text, paths or ids) → per-day upsert to pds.ai_tool_usage_daily with ~/.onyx_supabase_secret; heartbeats ai_usage|sessions
├── .github/workflows/
│   ├── daily-etl.yml            # Hourly Health ETL: Garmin + WHOOP (`0 * * * *`)
│   ├── eight-sleep-etl.yml      # Eight Sleep ETL - 19:00 UTC daily (3 PM EDT / 2 PM EST)
│   ├── mfp-email.yml            # MyFitnessPal email check - manual fallback only (Cronometer cutover)
│   ├── whoop-journal-email.yml  # WHOOP journal - decommissioned; archive frozen, do not run (see warning below)
│   ├── journal-sync.yml         # Notion personal Journal sync (`35 * * * *`)
│   ├── habits-sync.yml          # Habits sync from Notion (`45 * * * *`)
│   ├── spotify-etl.yml          # Spotify recently-played (`50 * * * *`)
│   ├── tanita-etl.yml           # Tanita weight ETL — daily 10am + 1:30pm ET
│   ├── flights-email.yml        # Flights Email ETL — every 3h at :25 (`25 */3 * * *`) catch-up
│   ├── delivery-email.yml       # Delivery Email ETL — every 3h at :40 (`40 */3 * * *`)
│   ├── air-quality-etl.yml      # Air Quality ETL — every 3h at :12 (`12 */3 * * *`), SUPABASE_* secrets only
│   ├── weather-etl.yml          # Weather ETL — every 3h at :32 (`32 1-23/3 * * *`), SUPABASE_* secrets only
│   ├── pollen-etl.yml           # Pollen ETL — 16:20 + 21:20 UTC (`20 16,21 * * *`), SUPABASE_* secrets only
│   ├── urgent-email.yml         # Urgent Email Labels — hourly at :15 (`15 * * * *`)
│   ├── google-calendar-etl.yml  # Google Calendar ETL — hourly at :55 (`55 * * * *`)
│   ├── orders-email.yml         # Online Orders Email — every 3h at :05 (`5 */3 * * *`)
│   ├── simplefin-etl.yml        # SimpleFIN ETL — every 6h at :30 (`30 */6 * * *`), finance ledger
│   ├── hrv-prediction.yml       # HRV prediction — auto-runs after each ETL via workflow_run, plus guaranteed 23:50 ET finalization (DST-safe)
│   └── hrv-retrain-on-backfill.yml  # HRV Analysis Retrain — hourly backfill check + daily 12:00 UTC safety-net
├── whoop_schema.sql         # WHOOP table DDL
├── eight_sleep_schema.sql   # Eight Sleep DDL + daily_health_matrix view
├── sql/
│   ├── rls_policies.sql     # Row-Level Security policies
│   ├── ci_tokens.sql        # CI token storage table
│   ├── flights_schema.sql   # pds.flights (one row per flight segment) + pds.flight_email_log (parse ledger)
│   ├── delivery_orders_schema.sql # pds.delivery_orders (one row per Uber Eats order) + pds.delivery_email_log + pds.delivery_daily view
│   ├── air_quality_schema.sql # pds.air_quality_daily (one row per ET clock day: PM2.5 mean/max, US AQI mean/max, n_hours, lat/lon; service-role only)
│   ├── calendar_events_schema.sql # pds.calendar_events (one row per calendar event instance: title, start/end, all-day, inclusive dates, tz, location, status, labels; service-role only)
│   ├── weather_schema.sql   # pds.weather_daily (one row per ET clock day: temperature, humidity, pressure, rain, wind, cloud, daylight, sunshine, UV, night temperature, n_hours, lat/lon; service-role only)
│   ├── pollen_schema.sql    # pds.pollen_daily (one row per PUBLISHED count day, count_date; total + level, tree/grass/weed/mold levels + top contributors; owner read + service role)
│   ├── online_orders_schema.sql  # pds.online_order_events (one row per email read) + pds.online_orders (recomputed per run) + pds.online_order_marks (Riley's Got it / Hide); service-role only
│   ├── inbox_emails_schema.sql   # pds.inbox_emails (service-role only): metadata of Agent/Action + Agent/Deadline labelled mail for Today
│   ├── today_cleared_emails.sql  # pds.today_cleared_emails (service-role only): labelled threads Riley cleared from Today
│   ├── delivery_order_items_schema.sql # pds.delivery_order_items (cart lines) + pds.delivery_item_nutrition (per-dish estimate) + delivery_items_unestimated / delivery_nutrition_daily views
│   ├── photo_meals.sql      # pds.photo_meals (meals logged from a plate photo: Claude estimate, confirmed by Riley) + pds.photo_meal_daily view
│   ├── phone_screen_time_schema.sql # RETIRED 2026-11-13 (v1 Shortcuts path, never used): pds.phone_app_events + phone_app_sessions + phone_screen_daily views still exist, empty
│   ├── pc_activity_schema.sql # PC activity logger: pds.pc_activity_hours (per UTC hour: active/idle s) + pds.pc_activity_apps (per hour + program) + view pds.pc_activity_daily (behavioral day); service-role only
│   ├── ai_tool_usage_schema.sql # AI tool usage harvester: pds.ai_tool_usage_daily (per device, behavioral day, tool, project folder name: sessions, prompts, tool calls, active / late minutes, tokens, models); owner read + service role. NOT APPLIED yet (Riley)
│   ├── reading_schema.sql   # Reading module: books, reading_sessions, book_highlights (SM-2 review), reading_reviews, reading_quizzes
│   └── medical_records_schema.sql # /health/records: pds.medical_documents + pds.lab_results + private bucket medical-records (service-role only)
├── ARCHITECTURE.md          # Full system architecture reference
├── .env                     # Secrets (NEVER commit)
└── frontend/                # Next.js 15 app
    └── src/
        ├── app/             # Pages (13 routes; `/` redirects to /today, `/meals` redirects to /nutrition) + API routes
        │   ├── analytics/hrv/  # HRV Analysis dashboard (predictions, SHAP, models)
        │   ├── reading/        # Reading quest: progress ring + pace, streak, XP/levels, badges, checkpoints, burn-up chart, SM-2 review, session + highlight capture (Kindle export import); mirrors to Notion
        │   └── spotify/        # Spotify listening dashboard (volume, mood signature, sonic profile radar, top artists/tracks)
        ├── components/      # AppShell, Sidebar, MobileNav, ChartCard, StatCard
        └── lib/             # Supabase clients, queries.ts, queries-hrv.ts (/analytics/hrv data layer), format.ts
```

## Tech Stack (summary)

- **ETL**: Python 3, httpx, garminconnect, supabase-py, python-dotenv
- **Database**: Supabase (Postgres 17), schema `pds`, 19 tables + `journal` unified view + 3 HRV analysis tables (`hrv_predictions`, `hrv_model_metrics`, `hrv_analysis_results`) + Spotify (`spotify_plays`, `spotify_tracks`, `spotify_artists`, `spotify_playlists`, `spotify_daily_signature` view) + Supplements (`supplement_products`, `supplement_intake`, `supplement_intake_by_compound` view, `daily_supplement_matrix` view) + Notion personal Journal (`journal_entries` with pgvector embeddings, `search_journal_entries` RPC) + Tanita body comp (`tanita_measurements` raw + `weight_log` daily rollup)
- **Frontend**: Next.js 15, React 19, Tailwind CSS 4, Recharts 3.8, TypeScript 5
- **Hosting**: Vercel (frontend; **Pro plan since 2026-11-12** — the Hobby cap of 100 deployments/day was exhausted by agent PR previews, which blocked production deploys; `frontend/vercel.json` `ignoreCommand` now builds `master` only, so PRs get no Vercel preview), Supabase Cloud (database)

## Commands

```bash
# ETL (runs automatically via GitHub Actions every hour on :00)
python garmin_etl.py                    # Sync last 7 days
python garmin_etl.py --backfill-training-status 930  # Re-read only training readiness + acute/chronic load
python whoop_etl.py                     # Sync last 30 days
python whoop_journal_import.py <csv>    # ARCHIVE ONLY: retired WHOOP journal importer
python whoop_journal_email.py --once   # ARCHIVE ONLY: retired WHOOP journal email importer
python whoop_journal_watcher.py        # ARCHIVE ONLY: retired watcher; do not start routinely
python eight_sleep_etl.py               # Sync last 7 days
python myfitnesspal_import.py <csv>     # Manual fallback only; Cronometer is primary
python myfitnesspal_email.py --once    # Manual fallback only; Cronometer is primary
python <etl>.py --backfill N            # Backfill N days
python spotify_etl.py --auth            # Spotify OAuth sign-in in a local browser (fallback; the normal renewal is Reconnect on the /status Spotify card)
python spotify_etl.py                   # Sync recently-played (last 50 since high-water mark)
python spotify_etl.py --refeaturize     # Backfill audio features for tracks with NULL valence
python spotify_etl.py --backfill-artists # Enrich every distinct artist in spotify_plays (one-time, after schema change)
python spotify_etl.py --refresh-genres   # Re-fetch MusicBrainz tags for spotify_artists rows with empty genres
python tanita_etl.py --auth             # One-time Health Planet OAuth bootstrap (local, copy-paste code)
python tanita_etl.py --inspect          # Print newest raw measurement (timestamp TZ verification)
python tanita_etl.py                    # Sync last 14 days of Tanita weigh-ins
python tanita_etl.py --backfill N       # Backfill N days (paged in <=80-day API windows)
gh workflow run tanita-etl.yml -f days=120      # Same backfill from Actions (local box has no .env)
gh workflow run daily-etl.yml -f days=800 -f whoop_cycles_only=true  # Deep WHOOP cycle re-read (step_count); skips Garmin + the TZ pass
gh workflow run cronometer-etl.yml -f days=125  # Wide-window Cronometer re-import from Actions

# Cronometer (automated web-export ETL — runs 2x daily via GitHub Actions)
python cronometer_etl.py --auth         # One-time bootstrap: fresh login + 1-day export, validates creds/flow
python cronometer_etl.py                # Rolling 30-day export → run_import → Supabase
python cronometer_etl.py --days 14      # Custom window
python cronometer_etl.py --dry-run      # Fetch + parse, no DB writes
python cronometer_import.py <zip|dir|csvs>  # Manual fallback: import a hand-downloaded export

# CI Token Management
python ci_token_helper.py upload garmin   # Seed/update Garmin tokens in Supabase
python ci_token_helper.py upload whoop    # Seed/update WHOOP tokens in Supabase
python ci_token_helper.py upload spotify  # Seed/update Spotify tokens in Supabase
python ci_token_helper.py upload tanita   # Seed/update Tanita tokens in Supabase
python ci_token_helper.py upload cronometer # Seed/update Cronometer session in Supabase
python ci_token_helper.py download garmin # Restore Garmin tokens from Supabase
python ci_token_helper.py download whoop  # Restore WHOOP tokens from Supabase
python ci_token_helper.py download spotify # Restore Spotify tokens from Supabase
python ci_token_helper.py download tanita  # Restore Tanita tokens from Supabase
python ci_token_helper.py download cronometer # Restore Cronometer session from Supabase

# GitHub Actions
gh workflow run daily-etl.yml           # Manually trigger ETL workflow
gh workflow run whoop-journal-email.yml # ARCHIVE ONLY: not a routine sync; see warning below

# Frontend
cd frontend && npm run dev              # Dev server on :3000
cd frontend && npm run build            # Production build
cd frontend && npm run lint             # ESLint

# Install
pip install garminconnect supabase python-dotenv httpx requests timezonefinder
pip install -r requirements-analysis.txt  # HRV analysis deps
cd frontend && npm install

# HRV Analysis Pipeline (run once or after major data changes)
python hrv_analysis.py                  # Full pipeline: data + stats + models + store
python hrv_analysis.py --skip-analysis  # Skip stat plots (faster retraining)
python hrv_predict.py --predict         # Daily prediction (run after ETL)
python hrv_predict.py --backfill-only   # Just backfill actuals + recompute metrics
gh workflow run hrv-prediction.yml      # Manually trigger daily prediction in CI
```

**Retired WHOOP journal commands:** the journal pipeline was decommissioned on 2026-06-11. Its archive table is frozen and no longer read by the app. Do not run the importer, watcher, or manual workflow as routine maintenance or incident recovery. Any deliberate archive write requires a separate review of the freeze and the intended migration; current habits use the habits sync pipeline.

## Environment Variables

Root `.env` (Python ETL): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY,
GARMIN_EMAIL, GARMIN_PASSWORD, WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET,
EIGHTSLEEP_EMAIL, EIGHTSLEEP_PASSWORD, IMAP_HOST, IMAP_EMAIL, IMAP_APP_PASSWORD,
MFP_USERNAME, MFP_PASSWORD, SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REDIRECT_URI,
TANITA_CLIENT_ID, TANITA_CLIENT_SECRET, CRONOMETER_EMAIL, CRONOMETER_PASSWORD,
NOTION_API_KEY, NOTION_JOURNAL_DB, VOYAGE_API_KEY, GOOGLE_CALENDAR_ICS_SECRET (JSON list of {account, calendar, url})

`frontend/.env.local`: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY, NOTION_API_KEY, NOTION_HABITS_DB, VOYAGE_API_KEY, SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET

## Code layout conventions

- ETL scripts are standalone Python files at the project root (not in a package)
- Frontend follows Next.js App Router conventions (page.tsx per route)
- Supabase queries go in `frontend/src/lib/queries.ts`
- Reusable UI components go in `frontend/src/components/`
