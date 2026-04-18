# Onyx — Claude Code Instructions

Personal health data aggregation and analytics platform.
Syncs biometric data from Garmin, WHOOP, and Eight Sleep into a unified Supabase Postgres database,
visualized via a Next.js frontend with AI-powered analysis through Claude.

## Project Structure

```
Onyx/
├── garmin_etl.py            # Garmin Connect → Supabase (9 tables)
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
├── ci_token_helper.py       # Download/upload OAuth tokens for CI
├── hrv_analysis.py          # HRV deep analysis pipeline (Phases 1-3.5): data loading,
│                            #   ~350-column / ~250-feature matrix, stat analysis, XGBoost/SARIMAX (Prophet opt-in),
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
        ├── app/             # Pages (13 routes) + API routes
        │   └── analytics/hrv/  # HRV Analysis dashboard (predictions, SHAP, models)
        ├── components/      # AppShell, Sidebar, MobileNav, ChartCard, StatCard
        └── lib/             # Supabase clients, queries.ts (19 functions), format.ts
```

## Tech Stack

- **ETL**: Python 3, httpx, garminconnect, supabase-py, python-dotenv
- **Database**: Supabase (Postgres 17), schema `pds`, 17 tables + `journal` unified view + 3 HRV analysis tables (`hrv_predictions`, `hrv_model_metrics`, `hrv_analysis_results`)
- **Frontend**: Next.js 15, React 19, Tailwind CSS 4, Recharts 3.8, TypeScript 5
- **AI Chat**: Claude Sonnet 4, agentic tool-use loop with 14 tools (11 query + mark_habit_complete + query_journal + query_eight_sleep). Habit completion via chat syncs to both Supabase and Notion.
- **System Status**: `/status` page — 6 source cards (Garmin, WHOOP, Eight Sleep, WHOOP Journal, Habits, MyFitnessPal), KPI summary, 20-entry sync history. `GET /api/status` queries `pds.sync_log` by `(source, data_type)` key + `MAX()` date per data table. Auto-refreshes every 60s.
- **Auth**: Supabase Auth (magic link), RLS on all tables
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

# CI Token Management
python ci_token_helper.py upload garmin   # Seed/update Garmin tokens in Supabase
python ci_token_helper.py upload whoop    # Seed/update WHOOP tokens in Supabase
python ci_token_helper.py download garmin # Restore Garmin tokens from Supabase
python ci_token_helper.py download whoop  # Restore WHOOP tokens from Supabase

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
- `supabase-py` schema access: always use `supa.schema("pds").from_(table)` — NOT `supa.table()` which defaults to `public`
- `whoop_workouts` has no `cycle_id` column; use `workout_id` + derive `calendar_date` from `start_time` via ET-of-start (see TZ convention below)
- **Timezone convention: `America/New_York` (ET) is canonical for all calendar_date joins.** Raw timestamps are stored as true UTC instants (WHOOP `start_time`, WHOOP `measured_at`, Garmin `sleepStartTimestampGMT`). Date-only columns (MFP, Eight Sleep, WHOOP journal, habits) are already ET-aligned. Derived calendar_dates follow these rules in `daily_health_matrix`:
  - **Point-in-time events** (workouts, weigh-ins): `(start_time AT TIME ZONE 'America/New_York')::date`
  - **WHOOP cycles** (bedtime-to-bedtime spans): `((start_time + INTERVAL '12 hours') AT TIME ZONE 'America/New_York')::date` — lands at midday of the wake day, the canonical "day" the cycle represents. The `+12h` is required because `start_time` is the previous evening's bedtime; a naive ET-of-start would mis-tag the cycle to the day before. Robust to any bedtime drift.
  - **Garmin `start_time_local`**: stored as local wall-clock labeled as UTC (+00); `::date` yields ET date directly.
  - The `hrv_analysis.py` pipeline mirrors these rules via `to_date_str()`, `to_et_date_str()`, and `to_cycle_et_date_str()` helpers.
- **HRV columns are not interchangeable across sources.** `whoop_recovery.hrv_rmssd_milli` is RMSSD in milliseconds, measured during the WHOOP-detected sleep cycle. `garmin_hrv.last_night_avg_ms` is Garmin's proprietary time-weighted average of 5-minute HRV samples during sleep — *not* RMSSD; the unit is ms but the algorithm is different. `eight_sleep_trends.avg_hrv` is undocumented by Eight Sleep. Treat each as its own variable; never average or substitute.
- **Garmin sleep timestamps:** `garmin_sleep.sleep_start` / `sleep_end` are stored as true UTC instants (`sleepStartTimestampGMT` from the API). The previously-used `*Local` field encoded the local clock as UTC, shifting timestamps by ~4-5h.

## Environment Variables

Root `.env` (Python ETL): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY,
GARMIN_EMAIL, GARMIN_PASSWORD, WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET,
EIGHTSLEEP_EMAIL, EIGHTSLEEP_PASSWORD, IMAP_HOST, IMAP_EMAIL, IMAP_APP_PASSWORD,
MFP_USERNAME, MFP_PASSWORD

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
| HRV prediction | `hrv-prediction.yml` | `workflow_run` after hourly ETL + `50 3 * * *` + `50 4 * * *` | Backfills actuals + predicts next day. Hourly workflow_run runs give intra-day monitoring; the two scheduled crons land on 23:50 ET year-round (one per DST state — the `dst-gate` job skips the wrong-season run by checking `TZ=America/New_York date +%H == 23`). The 23:50 ET run captures the final day's imports (Habits at :45, journal at :30, MFP at :15) before ET midnight closes the day. **`hrv_predict.py` uses `et_today()` (`zoneinfo.ZoneInfo("America/New_York")`) for all date arithmetic** — a UTC `date.today()` on the runner would mis-tag the late-ET-evening run as the day-after-next. |
| HRV Analysis Retrain | `hrv-retrain-on-backfill.yml` | `20 * * * *` + `0 12 * * *` | Two triggers: (1) hourly backfill check via `hrv_backfill_check.py` — runs full `hrv_analysis.py` only if any row with `calendar_date < today-2` was updated since last `hrv_analysis_results.computed_at`. (2) Daily unconditional retrain at 12:00 UTC (~8am ET) — safety net so correlations stay fresh even if no backfill ever fires. The decision is made by the "Decide whether to retrain" step that branches on `github.event.schedule` / `github.event_name`. |

Notes:
- **Filename vs. display name**: `daily-etl.yml` kept for git history; workflow display name is **"Hourly Health ETL"**. The `hrv-prediction.yml` `workflow_run` trigger references the display name.
- **Manual trigger**: `gh workflow run <workflow-file>.yml` for any of them.
- **Token persistence**: Garmin/WHOOP tokens stored in `pds.ci_tokens`, managed by `ci_token_helper.py`.
- **Token recovery (Garmin)**: If Garmin tokens expire in CI, re-run ETL locally then `python ci_token_helper.py upload garmin`.
- **Token recovery (WHOOP)**: If WHOOP refresh token expires (400 on token refresh), re-run `python whoop_etl.py --days 7` locally then `python ci_token_helper.py upload whoop`. WHOOP tokens can expire after several days of failed refreshes — check `/status` page for silent failures. Hourly cadence increases risk here — monitor closely.
- **GitHub Secrets**: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GARMIN_EMAIL, GARMIN_PASSWORD, WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET, EIGHTSLEEP_EMAIL, EIGHTSLEEP_PASSWORD, EIGHTSLEEP_CLIENT_ID, EIGHTSLEEP_CLIENT_SECRET, IMAP_HOST, IMAP_EMAIL, IMAP_APP_PASSWORD.
- **Actions minutes**: Repo is private; hourly schedule is estimated to use ~3000–6000 min/month, likely over the 2000-min free tier. Monitor usage under GitHub → Settings → Billing.

## Conventions

- After making frontend changes, always start the dev server (`cd frontend && npm run dev`) so the user can see updates immediately in the browser
- After completing a task, always commit and push to git — Vercel auto-deploys from `master` (root directory: `frontend`)
- ETL scripts are standalone Python files at the project root (not in a package)
- Frontend follows Next.js App Router conventions (page.tsx per route)
- Supabase queries go in `frontend/src/lib/queries.ts`
- Reusable UI components go in `frontend/src/components/`
- SQL schema changes: create a .sql file, then apply via Supabase MCP or dashboard
- Always upsert (never raw insert) to keep ETL idempotent
- Never commit secrets (.env files are gitignored)
