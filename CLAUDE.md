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
│                            #   268-feature matrix, stat analysis, XGBoost/SARIMAX/Prophet,
│                            #   walk-forward backtest, stores results to Supabase
├── hrv_predict.py           # Daily HRV prediction: loads saved model, predicts tomorrow,
│                            #   backfills actuals, recomputes rolling metrics, drift check
├── requirements-analysis.txt # Python deps for HRV analysis (xgboost, statsmodels, prophet, etc.)
├── analysis_output/         # Generated plots + xgboost_hrv_model.pkl (gitignored)
├── .github/workflows/
│   ├── daily-etl.yml        # GitHub Actions daily ETL cron
│   ├── whoop-journal-email.yml  # WHOOP journal email check (every 4h)
│   └── hrv-prediction.yml   # Daily HRV prediction (runs after ETL, caches model)
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
# ETL (runs automatically via GitHub Actions daily at 5-6 AM ET)
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
- `whoop_workouts` has no `cycle_id` column; use `workout_id` + derive `calendar_date` from UTC `start_time`

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

All three ETLs run daily via `.github/workflows/daily-etl.yml`:
- **Schedule**: `0 10 * * *` (10:00 UTC = 5-6 AM ET)
- **Manual trigger**: `gh workflow run daily-etl.yml`
- **Token persistence**: Garmin/WHOOP tokens stored in `pds.ci_tokens`, managed by `ci_token_helper.py`
- **Token recovery**: If Garmin tokens expire in CI, re-run ETL locally then `python ci_token_helper.py upload garmin`
- **WHOOP token recovery**: If WHOOP refresh token expires (400 on token refresh), re-run `python whoop_etl.py --days 7` locally then `python ci_token_helper.py upload whoop`. WHOOP tokens can expire after several days of failed refreshes — check `/status` page for silent failures.
- **GitHub Secrets**: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GARMIN_EMAIL, GARMIN_PASSWORD, WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET, EIGHTSLEEP_EMAIL, EIGHTSLEEP_PASSWORD, EIGHTSLEEP_CLIENT_ID, EIGHTSLEEP_CLIENT_SECRET

WHOOP journal email check runs separately via `.github/workflows/whoop-journal-email.yml`:
- **Schedule**: `30 */4 * * *` (every 4 hours at :30)
- **Manual trigger**: `gh workflow run whoop-journal-email.yml`
- **Additional GitHub Secrets**: IMAP_HOST, IMAP_EMAIL, IMAP_APP_PASSWORD

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
