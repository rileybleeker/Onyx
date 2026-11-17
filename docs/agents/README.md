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
| `hrv_alignment.py`, `hrv_feature_sources.py`, `hrv_model_artifact.py`, `hrv_analysis.py`, `hrv_predict.py`, `hrv_backfill_check.py`, `causal_inference.py`, `requirements-analysis*`, `frontend/src/app/analytics/hrv/`, `lib/queries-hrv.ts`, `lib/sweet-spot.ts`, `lib/causal-plausibility.ts`, `lib/hrv-forecast-cutover.ts` | [hrv-pipeline.md](hrv-pipeline.md) |
| `experiment_*.py`, `sql/experiment_*.sql`, `docs/experiments/`, `docs/experiment-framework.md`, `app/api/experiments/`, `lib/experiments-server.ts` | [experiments.md](experiments.md) |
| `app/habits/`, `app/check-in/`, `app/api/habits/`, `lib/checkin*.ts`, `lib/habits-notion.ts`, `whoop_journal_*.py`, `sql/whoop_journal_merge.sql`, `sql/habit_journal_*.sql` | [habits-checkin.md](habits-checkin.md) |
| `cronometer_*.py`, `myfitnesspal_*.py`, `cronometer_schema.sql`, `meal_schema.sql`, `sql/caffeine_*.sql`, `delivery_email_etl.py`, `tools/ubereats_harvest/`, `tools/gopuff_harvest/`, `uber_rides_import.py`, `sql/uber_rides_schema.sql`, `sql/delivery_*.sql`, `sql/photo_meals.sql`, `app/nutrition/`, `app/caffeine/`, `lib/delivery*.ts`, `lib/photo-meal.ts`, `components/DeliveryPortions.tsx` | [nutrition.md](nutrition.md) |
| `supplement_lookup.py`, `supplement_*schema.sql`, `sql/supplement_*.sql`, `sql/melatonin_unified.sql`, `app/supplements/`, `app/api/supplements/`, `lib/supplement-*.ts`, `lib/dsld.ts`, `components/BarcodeScannerModal.tsx` | [supplements.md](supplements.md) |
| `garmin_etl.py`, `whoop_etl.py`, `eight_sleep_*.py`, `tanita_etl.py`, `tanita_schema.sql`, `weight_schema.sql`, `air_quality_etl.py`, `weather_etl.py`, `pollen_etl.py`, `sql/activity_*.sql`, `app/activities/`, `app/sleep/`, `lib/steps.ts`, `lib/weather.ts`, `lib/activity-tags.ts` | [wearables-environment.md](wearables-environment.md) |
| `spotify_etl.py`, `spotify_*schema.sql`, `app/spotify/`, `app/api/spotify/`, `lib/spotify-*.ts` | [spotify.md](spotify.md) |
| `flights_email_etl.py`, `orders_email_etl.py`, `google_calendar_etl.py`, `sql/flights_schema.sql`, `sql/flight_day_unified.sql`, `sql/online_orders_schema.sql`, `sql/calendar_events_schema.sql`, `app/orders/`, `app/analytics/travel/`, `lib/online-orders*.ts`, `lib/calendar-events*.ts`, `lib/amazon-orders.ts` | [email-calendar-sources.md](email-calendar-sources.md) |
| `tools/screentime_ios/`, `tools/pc_activity_logger/`, `tools/ai_usage_harvest/`, `tools/youtube_history/`, `sql/youtube_watch_history_schema.sql`, `sql/apple_health_schema.sql`, `app/api/apple-health/`, `lib/apple-health.ts`, `app/api/phone-messages/`, `lib/phone-messages.ts`, `sql/phone_*.sql`, `sql/pc_activity_schema.sql`, `sql/ai_tool_usage_schema.sql`, `sql/focus_unlock_config.sql`, `app/screen-time/`, `app/install/`, `public/manifest.json`, `components/DesktopApp.tsx`, `lib/desktop-app.ts`, `lib/go-shortcuts.ts`, `lib/focus-unlock.ts`, `lib/screen-time*.ts` | [devices.md](devices.md) |
| `app/reading/`, `app/api/reading/`, `lib/reading*.ts`, `lib/kindle-import.ts`, `tools/kindle_harvest/`, `sql/reading_*.sql`, `journal_etl.py`, `journal_schema.sql`, `app/journal/`, `app/api/journal/`, `lib/journal-*.ts` | [reading-journal.md](reading-journal.md) |
| `lib/client-cache*.ts`, `lib/warmup.ts`, `components/AppData.tsx`, `components/ContinuousScroll.tsx`, `lib/feed-*.ts`, `components/FeedContext.tsx`, `app/*/FeedSection.tsx`, `lib/early-fetch.ts`, `lib/autosave.ts`, `lib/use-autosave.ts`, `app/globals.css`, `lib/chart-theme.ts`, `components/InfoHint.tsx`, `components/DeferredMount.tsx`, `lib/nav.ts`, `components/Sidebar.tsx`, `components/MobileNav.tsx`, `components/CommandPalette.tsx`, any `loading.tsx`; any page's speed, copy or autosave | [frontend.md](frontend.md) |
| `components/personalize/`, `lib/personalize-*.ts`, `lib/nav-areas.ts`, `lib/nav-arrange.ts`, `lib/mobile-tabs.ts`, `lib/ui-preferences.ts`, `app/api/ui/`, `sql/ui_preferences.sql` | [personalize.md](personalize.md) |
| `app/log/`, `lib/log-*.ts`, `components/LogLink.tsx`; any form that enters daily data | [log-screen.md](log-screen.md) |
| `app/today/`, `app/page.tsx`, `components/HomeResetPanel.tsx`, `lib/home-reset.ts`, `app/api/home-reset/`, `sql/home_reset.sql`, `components/overview/`, `lib/overview-*.ts`, `lib/today-*.ts`, `lib/urgent-email*.ts`, `lib/money-alerts-view.ts`, `urgent_email_etl.py`, `sql/inbox_emails_schema.sql`, `sql/today_cleared_emails.sql` | [today.md](today.md) |
| `app/chat/`, `app/api/chat/`, `lib/chat-*.ts`, `app/agents/`, `lib/agents-api.ts`, `app/nyc/`, `lib/nyc.ts` | [chat-agents.md](chat-agents.md) |
| `app/status/`, `app/api/status/`, `lib/status-*.ts`; any new data source | [status-page.md](status-page.md) |
| `simplefin_etl.py`, `sql/finance_*.sql`, `app/financials/`, `app/api/finance/`, `lib/finance-*.ts`, `lib/cash-forecast*.ts`, `lib/tax-*.ts`, `tools/rocketmoney_harvest/` | [finance.md](finance.md) |
| `app/procurement/`, `app/api/procurement/`, `lib/procurement-*.ts`, `sql/procurement_*.sql` | [procurement.md](procurement.md) |
| `app/health/`, `app/api/care/`, `app/api/medical/`, `lib/care-*.ts`, `lib/medical-records*.ts`, `tools/medical_recovery/`, `sql/care_*.sql`, `sql/medical_records_schema.sql` | [health-records.md](health-records.md) |
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
- **Rebase 2026-11-17 (onto `master` at `86eef57c`).** Every edit master made to the old root after `d376776` (58 commits, each listed under "Root edits made after the split") was applied to the domain file that holds that text, verbatim. Where placement was a choice: Uber rides and goPuff items sit with the Uber Eats section in nutrition.md; Apple Health, iPhone Messages and YouTube watch history in devices.md (the last two are `##` sections master added to the old root after the split); the Apartment reset paragraph in today.md; PIPE-09's HRV input manifest in hrv-pipeline.md.
- Rebase 2026-11-17, two wording changes in moved text: the PIPE-09 bullet's "the habit_journal trigger signal above" now names habits-checkin.md ("Backdated habit completions trigger HRV retraining"), and master's two copies of the Speed budget bullet (the second the first plus one repeated sentence, after a merge) are kept once in frontend.md, with all of the sentences of both.
- Rebase 2026-11-17, root: the "Delivery accountability" review bullet now says Codex reviews only after merge (cf08a456, e85d0281; the full text is in ops-ci.md), and the "Find your domain rules" paragraph was tightened to stay inside the size budget.

## Root edits made after the split

A branch written against the old long `AGENTS.md` conflicts with the new root when it rebases. Keep the new root, find the edited line's old section under **Where the old sections went**, make the same edit in that domain file (verbatim, or the line's tightened copy there), and add a row here. `tests/test_agents_docs.py` (`REHOMED`) checks each row's text is still in its file.

| Commit on `master` | Edit | Now in |
|---|---|---|
| `d376776` (#357, HIST-TZ-01) | Timezone convention: the sentence on journal entries (`pds.journal_entry_onyx_dates`), no backfill, the rollback, pre-apply counts, post-deploy checks and WHOOP follow-up files | [database.md › Timezone convention and matrix views](database.md#timezone-convention-and-matrix-views) |
| `90de62c5` (#363), `50ce9825` (#496) | keyboard focus, skip link and focus return on Log and Personalize (PROD-T11); list every adopted PartGrid page and refresh feed-registry count | [personalize.md › Personalize (2026-11-15)](personalize.md#personalize-2026-11-15) |
| `a2955a30` (#364), `f71d6f3e` (#429) | source-preserving obligation priorities and an opt-in quiet view (PROD-T04, PROD-T05); apartment reset card, one cleanup action then opt-in upkeep | [today.md › Today home (2026-11-11)](today.md#today-home-2026-11-11) |
| `d57d6ceb` (#365) | save a stack's header and items in one transaction with a version check (PROD-T12) | [supplements.md › Stacks and reminders](supplements.md#stacks-and-reminders) |
| `ef17db5e` (#375), `3030285b` (#379) | valid same-night N-of-1 inference when carryover is non-zero (PIPE-06); record the method review, bind it to the code, design-scoped gate (PIPE-06 follow-up to #375) | [experiments.md › Experiments: N-of-1 trials (2026-11-13)](experiments.md#experiments-n-of-1-trials-2026-11-13) |
| `846a24d8` (#361), `eafd66a4` (#397), `93a90b2c` (#449) | recovery plan, RPO/RTO and a read-only recovery check (SEC-06); encrypted off-site backup, restore drill and status card (SEC-06); confirm off-site backup from OneDrive cloud state (SEC-06-R3) | [health-records.md › Medical records (2026-11-14)](health-records.md#medical-records-2026-11-14) |
| `aa11f1fe` (#374) | bind post-merge smoke evidence to the deployment it tested (DEL-02) | [ops-ci.md › Smoke testing (Playwright)](ops-ci.md#smoke-testing-playwright) |
| `16206d24` (#370) | explicit date contract; temperatures pair with trend days by session id (HIST-ETL-01) | [wearables-environment.md › Eight Sleep](wearables-environment.md#eight-sleep) |
| `9bbc479c` (#362), `9a5c4538` (#376), `fd9eef3d` (#406), `a4f0a4b1` (#470), `ed46b6f4` (#414) | atomic replay-safe reviews and quizzes, clearer review card, versioned learning questions (PROD-T02, PROD-T03, PROD-T07); keep unsaved Log entries across feed eviction and remounts, with clear save states (PROD-T01); READ-QUIZ-01 s7: a book's own flavour as data on pds.books.theme; question-bank tools on the replay ledger and the write-authority gate (READ-QUIZ-01 S6 port); voluntary learning pacing (PROD-T06) | [reading-journal.md › Reading module](reading-journal.md#reading-module) |
| `44233681` (#366), `4d9a25ab` (#396) | withhold safe-to-move unless forecast inputs are complete and fresh (PIPE-02); load the forecast engine only when a stored result is recomputed (PERF-02) | [finance.md › Cash forecast, budgets and taxes (2026-11-14)](finance.md#cash-forecast-budgets-and-taxes-2026-11-14) |
| `44255edb` (#383) | publish each trained model once and serve it by provenance (PIPE-08) | [hrv-pipeline.md › Alignment and dates](hrv-pipeline.md#alignment-and-dates) |
| `67921de8` (#372) | judge forms by what they send and show, not by source regexes (VAL-01) | [frontend.md › Input saves itself](frontend.md#input-saves-itself) |
| `66608bab` (#382) | keep unit classes apart in dose-response and the compound table (HIST-UNIT-01) | [supplements.md › Products, intake and the compound rollup](supplements.md#products-intake-and-the-compound-rollup) |
| `ee1618f4` (#367), `825a4d1e` (#463) | heartbeat text is safe codes only; cutover drops a row only on identity evidence (SEC-07, PIPE-04); Fidelity positions and activity from SimpleFIN into finance_holdings, Investments panel on /financials | [finance.md › Financials (2026-11-12; SimpleFIN feed since 2026-11-14)](finance.md#financials-2026-11-12-simplefin-feed-since-2026-11-14) |
| `98ae3503` (#384), `a2d8807b` (#373), `ba4af90b` (#390), `30e76720` (#417) | early reads from the head, urgent email and calendar on the edge (PERF-01); harness v2 records the measured SHA, cache state, a fixed window by purpose and a phone scenario (PROD-T10); diagnose isolated multi-second slow views (PERF-02); PERF-02 diagnosis separates observations from hypotheses | [frontend.md › Speed budget](frontend.md#speed-budget) |
| `afecf1b7` (#381) | pds matviews become service-role only (SEC-01-B) | [access-and-auth.md › Access model](access-and-auth.md#access-model) |
| `dc1f183a` (#369) | empty a day removed in Cronometer, only from a complete automated export (PIPE-03) | [nutrition.md › MyFitnessPal and Cronometer](nutrition.md#myfitnesspal-and-cronometer) |
| `5b1b1903` (#387) | wind-down progress and honest streaks on Today and Log (PROD-SLEEP-01) | [log-screen.md › Log screen (2026-11-15)](log-screen.md#log-screen-2026-11-15) |
| `39fef078` (#388), `84ad0217` (#469) | carry export completeness through storage, charts and adherence (PIPE-11); Apple Health sync from the Onyx iPhone app (steps, walking metrics, mindful minutes, workouts, State of Mind) | [devices.md › Phone screen time](devices.md#phone-screen-time) |
| `61dd90b5` (#368), `b842aaae` (#398), `07656bd0` (#448) | make chat write tools replay-safe across lost answers (SEC-04); write authority from the user's own message, not retrieved text (SEC-05); read-only query_photo_meals tool for Onyx Chat | [chat-agents.md › AI Chat](chat-agents.md#ai-chat) |
| `99c5a7be` (#380), `c06ff3ac` (#413), `269d1661` (#418), `c9d58f68` (#432) | Sonnet low for dish estimates, explicit low effort on playlist and supplement photo (OPS-MODEL-01-ONYX); signed-in harvester for goPuff order items (provider gopuff on the existing import route); rides from Uber's privacy download, no scraping (importer, table, status card); est_intake_kcal from Uber Eats + photo meal estimates (exploratory Spearman only) | [nutrition.md › Uber Eats delivery orders](nutrition.md#uber-eats-delivery-orders) |
| `e23e474c` (#393) | one input manifest for retrain invalidation; rescore corrected actuals (PIPE-09) | [hrv-pipeline.md › Tables, forecasts and accuracy rows](hrv-pipeline.md#tables-forecasts-and-accuracy-rows) |
| `23c40aa8` (#399), `cf08a456` (#408), `e85d0281` (#411) | Codex reviews after deploy and never gates a merge (Riley 2026-11-17); Codex reviews only after merge and files fixes as backlog items (Riley 2026-11-17); hold reasons need passing prerequisites; separate Codex roles | [AGENTS.md › Delivery accountability (Riley, 2026-11-15)](../../AGENTS.md#delivery-accountability-riley-2026-11-15) (shortened), [ops-ci.md › Delivery accountability (Riley, 2026-11-15)](ops-ci.md#delivery-accountability-riley-2026-11-15) |
| `753af004` (#407), `901e910a` (#424) | status of pollen, AI usage, experiments, local cleanup and PC activity (live 2026-11-17); replace stale route/table counts; add missing root scripts and workflows to the structure tree | [orientation.md › Project Structure](orientation.md#project-structure) |
| `78210319` (#410) | retry transient autosave failures on /health instead of stopping at Retry | [health-records.md › Health & appointments (2026-11-13)](health-records.md#health--appointments-2026-11-13) |
| `1455ccca` (#415) | import Google Takeout watch history from OneDrive, /status card | [devices.md › YouTube watch history (2026-11-17)](devices.md#youtube-watch-history-2026-11-17) |
| `409486f3` (#431) | mark the daily check-in flow built, not parked | [habits-checkin.md › Tri-state answers and the daily check-in](habits-checkin.md#tri-state-answers-and-the-daily-check-in) |
| `79ce8365` (#428) | photo-meal timing view meal_timing_from_photo_meals (additive, not applied) | [nutrition.md › Meal timing](nutrition.md#meal-timing) |
| `f926f9c7` (#447), `d5de1c76` (#494) | PC activity pre-fills for tooling and worked-late questions; merge PC activity daily totals as pc_* features | [devices.md › PC activity logger (2026-11-14)](devices.md#pc-activity-logger-2026-11-14) |
| `fdd3c742` (#442) | optional iCloud CalDAV source for the calendar sync | [email-calendar-sources.md › Google Calendar (read-only feeds)](email-calendar-sources.md#google-calendar-read-only-feeds) |
| `6ba5801c` (#464) | refresh path robust both ways, rejected token fails loud | [wearables-environment.md › Body weight (Tanita)](wearables-environment.md#body-weight-tanita) |
| `5f115c5a` (#466) | Shortcuts push ingestion for iPhone texts, off behind the flag | [devices.md › iPhone Messages (2026-11-17)](devices.md#iphone-messages-2026-11-17) |
| `3ede71e7` (#455) | MusicBrainz lookup retries with normalized artist name (NFKD, accents stripped, casefolded, symbols removed) | [spotify.md › Spotify](spotify.md#spotify) |
| `016216d7` (#459) | pollen features from pds.pollen_daily into the HRV matrix | [wearables-environment.md › Air quality, weather and pollen](wearables-environment.md#air-quality-weather-and-pollen) |
| `5f7506a0` (#436) | photo-meal features in the HRV pipeline (merge_photo_meal_features) | [nutrition.md › Food by photo](nutrition.md#food-by-photo) |
