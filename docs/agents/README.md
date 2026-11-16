# Agent instructions: domain index

The root [AGENTS.md](../../AGENTS.md) holds the rules for every task. The files in this folder hold the domain rules, moved out of the root on 2026-11-16 (baseline `65d813f`: about 370 KB, all of it loaded into every session) so an agent reads only what applies. They bind as much as the root does.

1. Find the paths you will change under **By path** and read that file and the owning source it names. A task that crosses areas reads each file.
2. A comment or document citing `AGENTS.md "<name>"`, or moved text saying "under Database" or "see Conventions", means a section of the old root file: look the name up under **Where the old sections went** or **Cited names**, or search `docs/agents/` for it.
3. Dated notes, counts, cron schedules, "not applied yet" remarks and test counts are history. The current source wins; when a rule and the source disagree, raise it instead of guessing.
4. Change a rule in its domain file, in the same commit as the code. A new section or file gets a row here, and a new file a line in the root's list. A new rule for every task goes in the root, kept short. `tests/test_agents_docs.py` checks this index, the links, the cited names and the root's hard rules and size.

Last reviewed 2026-11-16. Whoever adds or moves a section updates this index in the same commit.

## By path

Paths under `app/`, `lib/` and `components/` are in `frontend/src/`.

| You change | Read |
|---|---|
| `tests/`, `frontend/tests/`, `frontend/scripts/test-*`, `frontend/e2e/`, `.github/workflows/`, `ci_token_helper.py`, `tools/notion_tasks.py`, `tools/watchdog_cloud.py`; commits, PRs, releases, the Notion backlog | [ops-ci.md](ops-ci.md) |
| `sql/`, `sync_log_helper.py`, `retry_helper.py`, `gps_tz_backfill.py`, `whoop_tz_backfill.py`, `docs/adr/`; any ETL's Supabase writes; dates and time zones | [database.md](database.md) |
| `frontend/src/middleware.ts` (`isCiRoute()`), `frontend/src/lib/supabase.ts`, `sql/pds_owner_only_read.sql`; grants, RLS, a new API route | [access-and-auth.md](access-and-auth.md) |
| `hrv_alignment.py`, `hrv_analysis.py`, `hrv_predict.py`, `hrv_backfill_check.py`, `causal_inference.py`, `requirements-analysis*`, `frontend/src/app/analytics/hrv/`, `lib/queries-hrv.ts`, `lib/sweet-spot.ts`, `lib/causal-plausibility.ts`, `lib/hrv-forecast-cutover.ts` | [hrv-pipeline.md](hrv-pipeline.md) |
| `experiment_*.py`, `sql/experiment_*.sql`, `docs/experiments/`, `docs/experiment-framework.md`, `app/api/experiments/`, `lib/experiments-server.ts` | [experiments.md](experiments.md) |
| `app/habits/`, `app/check-in/`, `app/api/habits/`, `lib/checkin*.ts`, `lib/habits-notion.ts`, `whoop_journal_*.py`, `sql/whoop_journal_merge.sql`, `sql/habit_journal_*.sql` | [habits-checkin.md](habits-checkin.md) |
| `cronometer_*.py`, `myfitnesspal_*.py`, `cronometer_schema.sql`, `meal_schema.sql`, `sql/caffeine_*.sql`, `delivery_email_etl.py`, `tools/ubereats_harvest/`, `sql/delivery_*.sql`, `sql/photo_meals.sql`, `app/nutrition/`, `app/caffeine/`, `lib/delivery*.ts`, `lib/photo-meal.ts`, `components/DeliveryPortions.tsx` | [nutrition.md](nutrition.md) |
| `supplement_lookup.py`, `supplement_*schema.sql`, `sql/supplement_*.sql`, `sql/melatonin_unified.sql`, `app/supplements/`, `app/api/supplements/`, `lib/supplement-*.ts`, `lib/dsld.ts`, `components/BarcodeScannerModal.tsx` | [supplements.md](supplements.md) |
| `garmin_etl.py`, `whoop_etl.py`, `eight_sleep_*.py`, `tanita_etl.py`, `tanita_schema.sql`, `weight_schema.sql`, `air_quality_etl.py`, `weather_etl.py`, `pollen_etl.py`, `sql/activity_*.sql`, `app/activities/`, `app/sleep/`, `lib/steps.ts`, `lib/weather.ts`, `lib/activity-tags.ts` | [wearables-environment.md](wearables-environment.md) |
| `spotify_etl.py`, `spotify_*schema.sql`, `app/spotify/`, `app/api/spotify/`, `lib/spotify-*.ts` | [spotify.md](spotify.md) |
| `flights_email_etl.py`, `orders_email_etl.py`, `google_calendar_etl.py`, `sql/flights_schema.sql`, `sql/flight_day_unified.sql`, `sql/online_orders_schema.sql`, `sql/calendar_events_schema.sql`, `app/orders/`, `app/analytics/travel/`, `lib/online-orders*.ts`, `lib/calendar-events*.ts`, `lib/amazon-orders.ts` | [email-calendar-sources.md](email-calendar-sources.md) |
| `tools/screentime_ios/`, `tools/pc_activity_logger/`, `tools/ai_usage_harvest/`, `sql/phone_*.sql`, `sql/pc_activity_schema.sql`, `sql/ai_tool_usage_schema.sql`, `sql/focus_unlock_config.sql`, `app/screen-time/`, `app/install/`, `public/manifest.json`, `components/DesktopApp.tsx`, `lib/desktop-app.ts`, `lib/go-shortcuts.ts`, `lib/focus-unlock.ts`, `lib/screen-time*.ts` | [devices.md](devices.md) |
| `app/reading/`, `app/api/reading/`, `lib/reading*.ts`, `lib/kindle-import.ts`, `tools/kindle_harvest/`, `sql/reading_*.sql`, `journal_etl.py`, `journal_schema.sql`, `app/journal/`, `app/api/journal/`, `lib/journal-*.ts` | [reading-journal.md](reading-journal.md) |
| `lib/client-cache*.ts`, `lib/warmup.ts`, `components/AppData.tsx`, `components/ContinuousScroll.tsx`, `lib/feed-*.ts`, `components/FeedContext.tsx`, `app/*/FeedSection.tsx`, `lib/early-fetch.ts`, `lib/autosave.ts`, `lib/use-autosave.ts`, `app/globals.css`, `lib/chart-theme.ts`, `components/InfoHint.tsx`, `components/DeferredMount.tsx`, `lib/nav.ts`, `components/Sidebar.tsx`, `components/MobileNav.tsx`, `components/CommandPalette.tsx`, any `loading.tsx`; any page's speed, copy or autosave | [frontend.md](frontend.md) |
| `components/personalize/`, `lib/personalize-*.ts`, `lib/nav-areas.ts`, `lib/nav-arrange.ts`, `lib/mobile-tabs.ts`, `lib/ui-preferences.ts`, `app/api/ui/`, `sql/ui_preferences.sql` | [personalize.md](personalize.md) |
| `app/log/`, `lib/log-*.ts`, `components/LogLink.tsx`; any form that enters daily data | [log-screen.md](log-screen.md) |
| `app/today/`, `app/page.tsx`, `components/overview/`, `lib/overview-*.ts`, `lib/today-*.ts`, `lib/urgent-email*.ts`, `lib/money-alerts-view.ts`, `urgent_email_etl.py`, `sql/inbox_emails_schema.sql`, `sql/today_cleared_emails.sql` | [today.md](today.md) |
| `app/chat/`, `app/api/chat/`, `lib/chat-*.ts`, `app/agents/`, `lib/agents-api.ts`, `app/nyc/`, `lib/nyc.ts` | [chat-agents.md](chat-agents.md) |
| `app/status/`, `app/api/status/`, `lib/status-*.ts`; any new data source | [status-page.md](status-page.md) |
| `simplefin_etl.py`, `sql/finance_*.sql`, `app/financials/`, `app/api/finance/`, `lib/finance-*.ts`, `lib/cash-forecast*.ts`, `lib/tax-*.ts`, `tools/rocketmoney_harvest/` | [finance.md](finance.md) |
| `app/procurement/`, `app/api/procurement/`, `lib/procurement-*.ts`, `sql/procurement_*.sql` | [procurement.md](procurement.md) |
| `app/health/`, `app/api/care/`, `app/api/medical/`, `lib/care-*.ts`, `lib/medical-records*.ts`, `sql/care_*.sql`, `sql/medical_records_schema.sql` | [health-records.md](health-records.md) |
| repository layout, the command list, environment variable names | [orientation.md](orientation.md) |

## Where the old sections went

Every heading of the old root `AGENTS.md`. A section that was split lists each part; "Database" also lists files whose bullets came from it.

| Old heading | Now |
|---|---|
| Onyx — Agent Instructions | [AGENTS.md](../../AGENTS.md) |
| Read this first: testing and checks (Riley, 2026-11-15) | [AGENTS.md › Read this first: testing and checks (Riley, 2026-11-15)](../../AGENTS.md#read-this-first-testing-and-checks-riley-2026-11-15), [ops-ci.md › Testing and CI](ops-ci.md#testing-and-ci) |
| Delivery accountability (Riley, 2026-11-15) | [AGENTS.md › Delivery accountability (Riley, 2026-11-15)](../../AGENTS.md#delivery-accountability-riley-2026-11-15), [ops-ci.md › Delivery accountability (Riley, 2026-11-15)](ops-ci.md#delivery-accountability-riley-2026-11-15) |
| Project Structure | [orientation.md › Project Structure](orientation.md#project-structure) |
| Tech Stack | [orientation.md › Tech Stack (summary)](orientation.md#tech-stack-summary), [frontend.md › Frontend perf architecture](frontend.md#frontend-perf-architecture), [frontend.md › Theme](frontend.md#theme), [frontend.md › Client cache, warm-up and skeletons](frontend.md#client-cache-warm-up-and-skeletons), [frontend.md › Continuous scroll](frontend.md#continuous-scroll), [frontend.md › Frontend render conventions](frontend.md#frontend-render-conventions), [chat-agents.md › AI Chat](chat-agents.md#ai-chat), [status-page.md › System Status](status-page.md#system-status), [access-and-auth.md › Auth](access-and-auth.md#auth) |
| Commands | [orientation.md › Commands](orientation.md#commands) |
| Database | [database.md › Database basics](database.md#database-basics), [database.md › Timezone convention and matrix views](database.md#timezone-convention-and-matrix-views), [access-and-auth.md › Access model](access-and-auth.md#access-model), [personalize.md › UI preferences](personalize.md#ui-preferences), [habits-checkin.md](habits-checkin.md), [nutrition.md](nutrition.md), [supplements.md](supplements.md), [hrv-pipeline.md](hrv-pipeline.md), [wearables-environment.md](wearables-environment.md), [spotify.md](spotify.md), [email-calendar-sources.md](email-calendar-sources.md), [devices.md › Phone screen time](devices.md#phone-screen-time), [reading-journal.md](reading-journal.md) |
| Environment Variables | [orientation.md › Environment Variables](orientation.md#environment-variables) |
| Agent Permissions | [AGENTS.md › Agent Permissions](../../AGENTS.md#agent-permissions) |
| GitHub Actions ETL | [ops-ci.md › GitHub Actions ETL](ops-ci.md#github-actions-etl) |
| Conventions | [AGENTS.md › Rules for every task](../../AGENTS.md#rules-for-every-task), [ops-ci.md › Testing and CI](ops-ci.md#testing-and-ci), [ops-ci.md › Commit, push and the dev server](ops-ci.md#commit-push-and-the-dev-server), [ops-ci.md › Audit and review findings](ops-ci.md#audit-and-review-findings), [frontend.md › Speed budget](frontend.md#speed-budget), [frontend.md › Input saves itself](frontend.md#input-saves-itself), [frontend.md › UI copy](frontend.md#ui-copy), [frontend.md › Navigation](frontend.md#navigation), [nutrition.md › Logging surfaces](nutrition.md#logging-surfaces), [chat-agents.md › Agents chat](chat-agents.md#agents-chat), [chat-agents.md › NYC apartment search](chat-agents.md#nyc-apartment-search), [orientation.md › Code layout conventions](orientation.md#code-layout-conventions), [status-page.md › Every integration must appear on /status](status-page.md#every-integration-must-appear-on-status), [database.md › SQL and ETL write conventions](database.md#sql-and-etl-write-conventions), [hrv-pipeline.md › Alignment and dates](hrv-pipeline.md#alignment-and-dates) |
| Smoke testing (Playwright) | [ops-ci.md › Smoke testing (Playwright)](ops-ci.md#smoke-testing-playwright) |
| Backlog & Open Items | [ops-ci.md › Backlog & Open Items](ops-ci.md#backlog--open-items), [AGENTS.md › Backlog](../../AGENTS.md#backlog) |
| Personalize (2026-11-15) | [personalize.md › Personalize (2026-11-15)](personalize.md#personalize-2026-11-15) |
| Log screen (2026-11-15) | [log-screen.md › Log screen (2026-11-15)](log-screen.md#log-screen-2026-11-15) |
| One place to enter data (2026-11-15) | [log-screen.md › One place to enter data (2026-11-15)](log-screen.md#one-place-to-enter-data-2026-11-15) |
| Desktop app (2026-11-14) | [devices.md › Desktop app (2026-11-14)](devices.md#desktop-app-2026-11-14) |
| Today home (2026-11-11) | [today.md › Today home (2026-11-11)](today.md#today-home-2026-11-11) |
| Procurement (2026-11-13) | [procurement.md › Procurement (2026-11-13)](procurement.md#procurement-2026-11-13), [today.md › Clearing (was filed under Procurement)](today.md#clearing-was-filed-under-procurement), [today.md › Calendar (was filed under Procurement)](today.md#calendar-was-filed-under-procurement) |
| PC activity logger (2026-11-14) | [devices.md › PC activity logger (2026-11-14)](devices.md#pc-activity-logger-2026-11-14) |
| AI tool usage harvester (2026-11-14) | [devices.md › AI tool usage harvester (2026-11-14)](devices.md#ai-tool-usage-harvester-2026-11-14) |
| Screen Time page (2026-11-13) | [devices.md › Screen Time page (2026-11-13)](devices.md#screen-time-page-2026-11-13) |
| Experiments: N-of-1 trials (2026-11-13) | [experiments.md › Experiments: N-of-1 trials (2026-11-13)](experiments.md#experiments-n-of-1-trials-2026-11-13) |
| Health & appointments (2026-11-13) | [health-records.md › Health & appointments (2026-11-13)](health-records.md#health--appointments-2026-11-13) |
| Medical records (2026-11-14) | [health-records.md › Medical records (2026-11-14)](health-records.md#medical-records-2026-11-14) |
| Financials (2026-11-12; SimpleFIN feed since 2026-11-14) | [finance.md › Financials (2026-11-12; SimpleFIN feed since 2026-11-14)](finance.md#financials-2026-11-12-simplefin-feed-since-2026-11-14) |
| Cash forecast, budgets and taxes (2026-11-14) | [finance.md › Cash forecast, budgets and taxes (2026-11-14)](finance.md#cash-forecast-budgets-and-taxes-2026-11-14) |
| Focus habit unlock (2026-11-13) | [devices.md › Focus habit unlock (2026-11-13)](devices.md#focus-habit-unlock-2026-11-13) |

## Cited names

| Name | File |
|---|---|
| Read this first | [AGENTS.md › Read this first: testing and checks (Riley, 2026-11-15)](../../AGENTS.md#read-this-first-testing-and-checks-riley-2026-11-15) |
| Conventions (universal rules) | [AGENTS.md › Rules for every task](../../AGENTS.md#rules-for-every-task) |
| Log screen | [log-screen.md › Log screen (2026-11-15)](log-screen.md#log-screen-2026-11-15) |
| One place to enter data | [log-screen.md › One place to enter data (2026-11-15)](log-screen.md#one-place-to-enter-data-2026-11-15) |
| Input saves itself | [frontend.md › Input saves itself](frontend.md#input-saves-itself) |
| Speed budget | [frontend.md › Speed budget](frontend.md#speed-budget) |
| UI copy | [frontend.md › UI copy](frontend.md#ui-copy) |
| Continuous scroll | [frontend.md › Continuous scroll](frontend.md#continuous-scroll) |
| Client cache, warm-up and skeletons | [frontend.md › Client cache, warm-up and skeletons](frontend.md#client-cache-warm-up-and-skeletons) |
| Every integration must appear on /status | [status-page.md › Every integration must appear on /status](status-page.md#every-integration-must-appear-on-status) |
| Experiments | [experiments.md › Experiments: N-of-1 trials (2026-11-13)](experiments.md#experiments-n-of-1-trials-2026-11-13) |
| Token recovery (Spotify), Spotify bootstrap | [ops-ci.md › GitHub Actions ETL](ops-ci.md#github-actions-etl) |
| Spotify sign-in renewal, Spotify OAuth scope | [spotify.md › Spotify](spotify.md#spotify) |
| When creating a journal entry in Notion, Field rules, VERBATIM RULE | [reading-journal.md › Personal journal (Notion Entries)](reading-journal.md#personal-journal-notion-entries) |
| Daily check-in, Check-in: less typing, Tri-state habit answers | [habits-checkin.md › Tri-state answers and the daily check-in](habits-checkin.md#tri-state-answers-and-the-daily-check-in) |
| Access model, `/api/habits/*` boundary | [access-and-auth.md](access-and-auth.md) |
| HRV alignment rule, ET date arithmetic | [hrv-pipeline.md › Alignment and dates](hrv-pipeline.md#alignment-and-dates) |
| Causal inference layer | [hrv-pipeline.md › Causal inference layer](hrv-pipeline.md#causal-inference-layer) |
| Timezone convention, behavioral-day rule, matrix matview | [database.md › Timezone convention and matrix views](database.md#timezone-convention-and-matrix-views) |
| Supplement intake behavioral-day convention | [supplements.md › Behavioral-day convention](supplements.md#behavioral-day-convention) |
| Unified caffeine layer, the caffeine rule | [nutrition.md › Caffeine](nutrition.md#caffeine) |
| Delivery orders (Uber Eats) | [nutrition.md › Uber Eats delivery orders](nutrition.md#uber-eats-delivery-orders) |
| Phone screen time v1 / v2 | [devices.md › Phone screen time](devices.md#phone-screen-time) |
| Google Calendar (iCal feeds) | [email-calendar-sources.md › Google Calendar (read-only feeds)](email-calendar-sources.md#google-calendar-read-only-feeds) |
| Google Calendar sync (care items), the Health section | [health-records.md › Health & appointments (2026-11-13)](health-records.md#health--appointments-2026-11-13) |
| Flights, flight-day bridge | [email-calendar-sources.md › Flights](email-calendar-sources.md#flights) |
| Online orders | [email-calendar-sources.md › Online orders](email-calendar-sources.md#online-orders) |
| Activity taxonomy | [wearables-environment.md › Activity taxonomy](wearables-environment.md#activity-taxonomy) |
| WHOOP daily steps | [wearables-environment.md › WHOOP steps and energy](wearables-environment.md#whoop-steps-and-energy) |
| Reading module | [reading-journal.md › Reading module](reading-journal.md#reading-module) |
| Backlog, Notion MCP read quota | [ops-ci.md › Backlog & Open Items](ops-ci.md#backlog--open-items) |

## Edited while moving

- [ops-ci.md › Testing and CI](ops-ci.md#testing-and-ci), "Type-check the frontend before you open a PR": **corrected**. It said the Production build runs the type check; since 2026-11-14 `frontend/next.config.ts` sets `typescript.ignoreBuildErrors`, so a type error deploys and is caught by the scheduled suite's `frontend-types` job. The root "Read this first" bullet says the same.
- [ops-ci.md › GitHub Actions ETL](ops-ci.md#github-actions-etl), "Actions minutes": **corrected** (it said the repo is private).
- Cross references that said "above", "below" or "this file" now name the file they point to: habits-checkin.md (the journal field rules), hrv-pipeline.md (training load: the worn rule and Garmin's own load values), supplements.md (the `+12h` rule; "Earlier versions of AGENTS.md"), wearables-environment.md ("Calories burnt"), ops-ci.md ("Audit and review findings", "Backlog & Open Items").
- Two links are now relative to this folder: delivery accountability (ops-ci.md) and ADR-0001 (database.md).
- Today's "Clearing" and "Calendar" paragraphs sat under the Procurement heading; they are in today.md.
- The root restates, shorter, the rules that bind every task: testing and type-check, delivery accountability (full text in ops-ci.md), privacy and access, SQL, ETL heartbeats, `/status`, dates and HRV alignment, the frontend rules and the audit-finding rule. Agent Permissions and "Never commit secrets" are in the root only.
