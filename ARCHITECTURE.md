# Onyx — System Architecture

> Personal health data aggregation and analytics platform.
> Syncs biometric data from Garmin, WHOOP, and Eight Sleep into a unified
> Supabase Postgres database, visualized via a Next.js frontend with
> AI-powered analysis through Claude.

---

## High-Level Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    WEARABLE DEVICES                         │
├────────────────────┬──────────────────┬─────────────────────┤
│   Garmin Connect   │   WHOOP API v2   │  Eight Sleep API    │
│   (garminconnect)  │   (OAuth2 code)  │  (OAuth2 password)  │
└────────┬───────────┴──────┬───────────┴─────────┬───────────┘
         │                  │                     │
         ▼                  ▼                     ▼
┌─────────────────────────────────────────────────────────────┐
│               GITHUB ACTIONS (daily cron)                   │
│  Schedule: 10:00 UTC (5-6 AM ET) + manual dispatch          │
│  Three parallel jobs, token persistence via Supabase         │
├─────────────────────────────────────────────────────────────┤
│                   PYTHON ETL PIPELINES                      │
│  garmin_etl.py (9 tables) │ whoop_etl.py (5) │ eight_sleep │
│  Token refresh + retry    │ Paginated + 429   │ Multi-side  │
│  Rate-limited (1s/day)    │ backoff           │ discovery   │
└─────────────────────────────┬───────────────────────────────┘
                              │ Upsert (conflict resolution)
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              SUPABASE — POSTGRES 17                         │
│  Schema: pds                                                │
│  13 tables + daily_health_matrix view                       │
│  Row-Level Security (anon = read-only)                      │
│  Sync logging (pds.sync_log)                                │
└──────────┬──────────────────────────────┬───────────────────┘
           │                              │
           ▼ (anon key)                   ▼ (service role key)
┌────────────────────────┐    ┌───────────────────────────────┐
│   NEXT.JS 15 FRONTEND  │    │   CLAUDE AI CHAT (/api/chat)  │
│   Deployed on Vercel    │    │   Agentic tool-use loop       │
│   9 pages, Recharts     │    │   12 query tools              │
│   Supabase Auth         │    │   Cross-device analysis       │
└─────────────────────────┘    └───────────────────────────────┘
```

---

## Directory Structure

```
Onyx/
├── .env                         # Secrets (gitignored)
├── .gitignore
├── ARCHITECTURE.md              # This file
│
├── garmin_etl.py                # Garmin Connect → Supabase
├── whoop_etl.py                 # WHOOP API v2 → Supabase
├── eight_sleep_etl.py           # Eight Sleep API → Supabase
├── ci_token_helper.py           # Download/upload OAuth tokens for CI
│
├── .github/workflows/
│   ├── daily-etl.yml            # Hourly Health ETL: Garmin + WHOOP (`0 * * * *`)
│   ├── eight-sleep-etl.yml      # Eight Sleep ETL — daily at 3 PM ET (`0 19 * * *`)
│   ├── mfp-email.yml            # MyFitnessPal email check (`15 * * * *`)
│   ├── whoop-journal-email.yml  # WHOOP journal email check (`30 * * * *`)
│   ├── habits-sync.yml          # Habits sync from Notion (`45 * * * *`)
│   └── hrv-prediction.yml       # HRV prediction — auto-runs after each ETL
│
├── whoop_schema.sql             # WHOOP tables + indexes
├── eight_sleep_schema.sql       # Eight Sleep table + daily_health_matrix view
├── sql/
│   ├── rls_policies.sql         # Row-Level Security policies
│   └── ci_tokens.sql            # CI token storage table
│
└── frontend/
    ├── package.json
    ├── vercel.json
    ├── next.config.ts
    └── src/
        ├── app/
        │   ├── layout.tsx       # Root layout
        │   ├── page.tsx         # Dashboard (Garmin daily)
        │   ├── login/           # Supabase Auth
        │   ├── auth/callback/   # OAuth callback
        │   ├── sleep/           # Garmin sleep deep-dive
        │   ├── heart/           # HRV & resting HR
        │   ├── activities/      # Garmin workouts
        │   ├── whoop/           # WHOOP recovery/strain/sleep
        │   ├── eight-sleep/     # Eight Sleep scores/biometrics
        │   ├── matrix/          # Cross-device Health Matrix
        │   ├── chat/            # Claude AI chat
        │   └── api/chat/        # Claude API endpoint
        ├── components/
        │   ├── AppShell.tsx
        │   ├── Sidebar.tsx
        │   ├── MobileNav.tsx
        │   ├── ChartCard.tsx
        │   └── StatCard.tsx
        └── lib/
            ├── supabase.ts
            ├── supabase-browser.ts
            ├── supabase-server.ts
            ├── queries.ts       # 17 Supabase query functions
            ├── format.ts
            └── middleware.ts
```

---

## ETL Pipelines

### Garmin (`garmin_etl.py`)

| Table | Data |
|-------|------|
| `garmin_daily_summary` | Steps, calories, stress, body battery, SpO2, RHR |
| `garmin_sleep` | Duration, stages, scores, HRV, SpO2 |
| `garmin_heart_rate` | Resting/min/max HR, 7-day avg |
| `garmin_hrv` | Weekly avg, baseline, status |
| `garmin_stress` | Stress levels, duration by intensity |
| `garmin_training_status` | Readiness score, contributing factors |
| `garmin_activities` | Type, distance, duration, HR zones, VO2 max |
| `garmin_activity_laps` | Lap-level splits |

**Auth**: Email/password + saved token refresh via `garminconnect` library.

### WHOOP (`whoop_etl.py`)

| Table | Data |
|-------|------|
| `whoop_cycles` | Daily cycle, strain, kilojoules |
| `whoop_recovery` | Recovery score, RHR, HRV (RMSSD), SpO2, skin temp |
| `whoop_sleep` | Performance %, efficiency %, stages, disturbances |
| `whoop_workouts` | Sport, strain, HR zones, distance |
| `whoop_body_measurements` | Height, weight, max HR |

**Auth**: OAuth2 authorization code flow. Tokens stored at `~/.whoop_tokens.json`.

### Eight Sleep (`eight_sleep_etl.py`)

| Table | Data |
|-------|------|
| `eight_sleep_trends` | Sleep score, fitness score, HR, HRV, breath rate, bed/room temp, stages, toss & turns |

**Auth**: OAuth2 password grant via direct `httpx` client. Supports dual-side beds.

### Common Patterns

All ETL pipelines share:
- **Upsert** with conflict resolution (idempotent)
- **Backfill** mode (`--backfill N` days)
- **Sync logging** to `pds.sync_log`
- **Rate limiting** and error handling

```bash
python garmin_etl.py                # Last 7 days
python whoop_etl.py --backfill 730  # 2-year backfill
python eight_sleep_etl.py --side left  # Single side
```

### Automated Scheduling (GitHub Actions)

All data sources run **hourly** on a staggered schedule:
- **Hourly Health ETL** (`daily-etl.yml`, `0 * * * *`): Garmin + WHOOP, 2 parallel jobs
- **Eight Sleep ETL** (`eight-sleep-etl.yml`, `0 19 * * *`): daily at 3 PM ET — Eight Sleep data only updates post-sleep
- **MyFitnessPal email** (`mfp-email.yml`, `15 * * * *`): IMAP check → nutrition import
- **WHOOP journal email** (`whoop-journal-email.yml`, `30 * * * *`): IMAP check → journal import
- **Habits sync** (`habits-sync.yml`, `45 * * * *`): curls `POST /api/habits/sync`
- **HRV prediction** (`hrv-prediction.yml`, `workflow_run`): auto-runs after each hourly ETL

Every workflow also supports `workflow_dispatch` for on-demand runs. Concurrency groups prevent overlapping runs from corrupting tokens.

**Token persistence**: Garmin and WHOOP require rotating OAuth tokens. Since CI runners
are ephemeral, tokens are stored in `pds.ci_tokens` (Supabase). The `ci_token_helper.py`
script downloads tokens before each run and uploads (potentially refreshed) tokens after.
Upload uses `if: always()` so tokens are saved even if the ETL fails partway through.

**Secrets**: All credentials stored as GitHub Actions secrets (10 total). See CLAUDE.md for the full list.

---

## Database

**Platform**: Supabase (Postgres 17)
**Schema**: `pds`
**Tables**: 13 (9 Garmin + 5 WHOOP + 1 Eight Sleep — some share `sync_log`)

### Unified View: `daily_health_matrix`

Joins all three device sources by `calendar_date` (~40 columns):
- Garmin: steps, calories, RHR, stress, body battery, sleep score, HRV
- WHOOP: recovery score, RHR, HRV RMSSD, SpO2, skin temp, sleep performance, strain
- Eight Sleep: sleep score, fitness score, HRV, HR, breath rate, bed/room temp, stages

### Security

- **Row-Level Security (RLS)** on every table
- Anon key = read-only access (frontend)
- Service role key = full access (ETL + chat API)
- All secrets in `.env` (gitignored, never committed)

---

## HRV Analytics Pipeline

Three jobs run on different cadences. They share one model artifact + three Postgres tables (`pds.hrv_predictions`, `pds.hrv_model_metrics`, `pds.hrv_analysis_results`).

| Job | Trigger | Action |
|---|---|---|
| `hrv-prediction.yml` | `workflow_run` after every hourly Health ETL + `50 3 * * *` & `50 4 * * *` UTC (DST-gated to land on 23:50 ET year-round) | Run `hrv_predict.py` — backfills actuals, forecasts tomorrow using the saved model. No retrain. |
| `hrv-retrain-on-backfill.yml` (hourly path) | `20 * * * *` | `hrv_backfill_check.py` checks for any row with `calendar_date < today − 2` updated since last `hrv_analysis_results.computed_at`, OR a `backfill_signal` from the `habit_journal` trigger. If either: full `hrv_analysis.py` retrain. |
| `hrv-retrain-on-backfill.yml` (daily path) | `0 12 * * *` UTC (~08:00 ET) | Unconditional full retrain — safety net so descriptive stats and causal estimates stay current even when no backfill ever fires. |

Net effect: hourly predictions, retraining at least daily, more often when something old changes.

### Feature coverage scales with data automatically

The pipeline is data-driven; new features get analyzed on the next retrain with **zero code change**. The causal layer (`causal_inference.py`) enumerates binary treatments by prefix — `journal_*`, `habit_*`, `supplement_*_amount` — so a new WHOOP journal question, a new Notion-managed habit, or a new supplement compound auto-promotes into the next run. Welch t-tests + Spearman correlations apply the same prefix-based discovery.

Three cell-size tiers manage statistical honesty as `n` grows:

| Tier | n threshold (per arm, for binary treatments) | Rendering |
|---|---|---|
| Dropped | `< 10` in either arm | Excluded; recorded in `causal/dropped_low_n` for traceability |
| Low-n | `10–19` in either arm | Reported but flagged `low_n=true` → faded bar + ⚠ marker on `/analytics/hrv` |
| Full | `≥ 20` in both arms | Full opacity, default rendering |

A treatment graduates between tiers automatically on the retrain after the threshold is crossed. Welch journal/habit/supplement t-tests have analogous gates (≥5 Yes + ≥5 No nights). The matrix-level Spearman pass excludes columns whose non-null coverage falls below 5%.

**What does NOT auto-include:** entirely new *data sources* (a new wearable, a new third-party CSV) need to be added to the loader + matrix view manually. New *columns* on existing sources are picked up by the data-driven pivots without code edits.

---

## Time Conventions

> Onyx makes a deliberate choice about how to bucket activity into "days".
> The full rationale lives in `CLAUDE.md` under "Timezone convention" and
> "Supplement intake — behavioral-day convention"; this is the summary.

**Canonical timezone:** `America/New_York` (ET). All `calendar_date` join keys in `daily_health_matrix` are ET-aligned. Raw timestamps are stored as true UTC instants; date-only columns (MFP, Eight Sleep, WHOOP journal, habits, supplements) are stored ET-aligned at the source.

**Two competing definitions of "a day"** coexist in the schema, on purpose:

| Convention | Day boundary | Used by | Rationale |
|---|---|---|---|
| **Clock-date** (midnight-to-midnight ET) | 00:00 ET → 00:00 ET | MFP nutrition, point-in-time events (workouts, weigh-ins) | The analytical target is *daily energy balance* / discrete events. A midnight snack genuinely adds to the new day's calorie tally. |
| **Behavioral-day** (bedtime-to-bedtime, ≈ WHOOP cycle) | bedtime → next bedtime | WHOOP cycles, WHOOP journal, supplement intake | The analytical target is *next-night recovery / sleep effects*. Pre-bed activity at 12:05 AM ET belongs to the day that just ended — it affects the sleep that immediately follows. |

**WHOOP cycle derivation:** `((start_time + INTERVAL '12 hours') AT TIME ZONE 'America/New_York')::date` — lands at midday of the wake day. Robust to any bedtime drift.

**Supplement intake:** `intake_date` is the behavioral day; `intake_time TIMESTAMPTZ` is the truthful clock instant. The two are stored independently so a 12:05 AM May 21 click attributed to May 20 keeps the accurate timestamp without losing the date semantics. The `/supplements` UI defaults intake_date to the current ET date but exposes a manual date override on the quick-tap log flow.

**Why this matters for analysis:** `hrv_analysis.py:build_feature_matrix` uses `shift(-1)` to predict HRV(N+1) from behaviors(N). Any behavior that affects sleep (journal entries, supplements) must land on the date *before* the sleep it influenced — which is exactly what the behavioral-day convention guarantees. Putting a pre-bed 12:05 AM supplement on the new clock date would silently mis-train the model.

---

## Frontend

**Stack**: Next.js 15, React 19, Tailwind CSS 4, Recharts 3.8, Supabase JS 2.99

### Pages

| Route | Purpose |
|-------|---------|
| `/` | Dashboard — Garmin daily summary, body battery, sleep |
| `/sleep` | Garmin sleep stages, scores, HRV |
| `/heart` | HRV & resting HR trends |
| `/activities` | Garmin workouts |
| `/whoop` | WHOOP recovery, strain, sleep, SpO2 |
| `/eight-sleep` | Eight Sleep scores, stages, biometrics |
| `/matrix` | Cross-device Health Matrix |
| `/chat` | Claude AI chat |
| `/login` | Supabase Auth (magic link) |

### Deployment

Hosted on **Vercel**. Environment variables set in Vercel dashboard.

---

## AI Chat System

**Endpoint**: `POST /api/chat`
**Model**: Claude Sonnet 4
**Pattern**: Agentic tool-use loop

```
User message
  → Claude (with 12 tools)
  → tool_use? → execute Supabase query → return result
  → Claude reasons over data
  → repeat until end_turn
  → final response to user
```

**Tools**: `query_daily_summary`, `query_sleep`, `query_hrv`, `query_activities`,
`query_training_status`, `query_stress`, `query_whoop_recovery`, `query_whoop_cycles`,
`query_whoop_sleep`, `query_whoop_workouts`, `query_eight_sleep`, `query_health_matrix`

---

## Source-of-Truth Assignments

| Domain | Source | Reason |
|--------|--------|--------|
| Resting heart rate | WHOOP | Continuous overnight measurement |
| HRV | WHOOP | All-night RMSSD measurement |
| Sleep duration | WHOOP | Recovery-integrated tracking |
| Sleep scoring | WHOOP | Sleep performance percentage |
| Deep sleep | WHOOP | Slow-wave sleep detection |
| REM sleep | WHOOP | REM stage tracking |
| SpO2 | WHOOP | Continuous overnight pulse oximetry |
| Respiratory rate | WHOOP | Continuous overnight measurement |
| Recovery & readiness | WHOOP | Purpose-built recovery algorithm |
| Activities & workouts | Garmin | GPS, cadence, power, training effect, VO2 max |
| Daily wellness (steps, stress, body battery) | Garmin | Wrist-based all-day tracking |
| Body composition | Garmin | Scale integration (Index S2) |
| Training readiness | Garmin | Training load & recovery factors |
| Sleep environment | Eight Sleep | Bed/room temperature, thermal comfort |
| Toss & turns | Eight Sleep | Mattress-based movement detection |

Where sources overlap, both are stored for cross-validation.

---

## Tech Stack Summary

| Layer | Technology |
|-------|-----------|
| ETL | Python 3, httpx, garminconnect, python-dotenv |
| Scheduling | GitHub Actions (daily cron), ci_token_helper.py |
| Database | Supabase, Postgres 17 |
| Frontend | Next.js 15, React 19, Tailwind CSS 4, Recharts |
| AI | Claude Sonnet 4 (@anthropic-ai/sdk) |
| Auth | Supabase Auth (magic link) |
| Hosting | Vercel (frontend), Supabase Cloud (database) |
| Version Control | Git, GitHub |
