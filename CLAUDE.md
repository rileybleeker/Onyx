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
├── ci_token_helper.py       # Download/upload OAuth tokens for CI
├── .github/workflows/
│   ├── daily-etl.yml        # GitHub Actions daily ETL cron
│   └── whoop-journal-email.yml  # WHOOP journal email check (every 4h)
├── whoop_schema.sql         # WHOOP table DDL
├── eight_sleep_schema.sql   # Eight Sleep DDL + daily_health_matrix view
├── sql/
│   ├── rls_policies.sql     # Row-Level Security policies
│   └── ci_tokens.sql        # CI token storage table
├── ARCHITECTURE.md          # Full system architecture reference
├── .env                     # Secrets (NEVER commit)
└── frontend/                # Next.js 15 app
    └── src/
        ├── app/             # Pages (11 routes) + API routes
        ├── components/      # AppShell, Sidebar, MobileNav, ChartCard, StatCard
        └── lib/             # Supabase clients, queries.ts (19 functions), format.ts
```

## Tech Stack

- **ETL**: Python 3, httpx, garminconnect, supabase-py, python-dotenv
- **Database**: Supabase (Postgres 17), schema `pds`, 16 tables + `daily_health_matrix` view + `journal` unified view
- **Frontend**: Next.js 15, React 19, Tailwind CSS 4, Recharts 3.8, TypeScript 5
- **AI Chat**: Claude Sonnet 4, agentic tool-use loop with 15 tools (12 query + mark_habit_complete + query_journal + query_health_matrix)
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
cd frontend && npm install
```

## Database

- Schema: `pds`
- All tables use upsert with conflict resolution (idempotent ETL)
- `daily_health_matrix` view joins all three sources by `calendar_date` (~40 columns)
- `habit_journal` table stores habit completions (same schema as `whoop_journal`)
- `journal` view UNIONs `whoop_journal` + `habit_journal` with a `source` column for unified analysis
- Habit definitions are managed in Notion (Habits DB under Project Onyx, ID: `29cc936fd5e14ae8b10a4fe5c5f7a6cd`)
- `ci_tokens` table stores rotating OAuth tokens for GitHub Actions (Garmin + WHOOP)
- RLS enabled: anon key = read-only, service role key = full access
- Sync operations logged to `pds.sync_log`
- `whoop_journal` data is boolean-only (Yes/No) — WHOOP's CSV export does not include quantity values entered in the app (e.g., "3 drinks", "200mg caffeine"). This is a WHOOP platform limitation.

## Environment Variables

Root `.env` (Python ETL): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY,
GARMIN_EMAIL, GARMIN_PASSWORD, WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET,
EIGHTSLEEP_EMAIL, EIGHTSLEEP_PASSWORD, IMAP_HOST, IMAP_EMAIL, IMAP_APP_PASSWORD

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
- **GitHub Secrets**: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GARMIN_EMAIL, GARMIN_PASSWORD, WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET, EIGHTSLEEP_EMAIL, EIGHTSLEEP_PASSWORD, EIGHTSLEEP_CLIENT_ID, EIGHTSLEEP_CLIENT_SECRET

WHOOP journal email check runs separately via `.github/workflows/whoop-journal-email.yml`:
- **Schedule**: `30 */4 * * *` (every 4 hours at :30)
- **Manual trigger**: `gh workflow run whoop-journal-email.yml`
- **Additional GitHub Secrets**: IMAP_HOST, IMAP_EMAIL, IMAP_APP_PASSWORD

## Conventions

- After making frontend changes, always start the dev server (`cd frontend && npm run dev`) so the user can see updates immediately in the browser
- After completing a task, always commit and push to git so Vercel deploys automatically
- ETL scripts are standalone Python files at the project root (not in a package)
- Frontend follows Next.js App Router conventions (page.tsx per route)
- Supabase queries go in `frontend/src/lib/queries.ts`
- Reusable UI components go in `frontend/src/components/`
- SQL schema changes: create a .sql file, then apply via Supabase MCP or dashboard
- Always upsert (never raw insert) to keep ETL idempotent
- Never commit secrets (.env files are gitignored)
