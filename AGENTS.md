# Onyx — Agent Instructions

Read by every coding agent (Claude Code, Codex, Cursor, …). This is the only project-instructions file; there is no CLAUDE.md. It holds the rules for every task; the domain files in `docs/agents/` bind too.

Onyx is Riley's personal health-data platform: root-level Python ETL scripts load devices, apps, email and finance into Supabase Postgres (schema `pds`, DDL in `sql/`); the Next.js app in `frontend/` deploys to Vercel from `master`; schedules are in `.github/workflows/`.

## Read this first: testing and checks (Riley, 2026-11-15)

- **Do not run automated tests before merging, not even locally or "just the relevant one".** That means no `node --test`, no `frontend/scripts/test-*.mjs` (above all the `-ui.mjs` browser tests), no pytest and no `tests/run_offline_tests.py`. The scheduled suite runs every test against each deployed revision within 30 minutes, and a red run comes back as a normal fix PR. Running them first only slows you and the other agents on this PC.
- **Do type-check frontend changes:** for any change under `frontend/`, run `npx tsc --noEmit` in `frontend/` (2–15 s; `npm install` first if `node_modules` is missing) and fix every error before opening the PR. It is not a test, so the rule above allows it. Nothing else checks types before production: no PR check runs tsc and the Vercel build skips type checking (`ignoreBuildErrors` in `frontend/next.config.ts`), so a type error deploys and shows up only when the scheduled suite's `frontend-types` job goes red.
- **Still write tests.** Add or update tests when behavior changes, with synthetic data only. The "Tests:" lists in `docs/agents/` name what covers an area so you know what to update. They are not steps to run.
- Automatic tests never write real user data. CI and smoke: [ops-ci.md](docs/agents/ops-ci.md), `docs/ci-cd.md`.

Every credential (token, session, key, certificate) has an entry in the sign-in registry and follows [docs/signins.md](docs/signins.md).

## Find your domain rules

Read the file below for the paths you touch, and its source. Dated notes, counts and schedules there are history: the source wins; if they disagree, raise it. Path table, old `AGENTS.md "<name>"` citations and edits to the old file: [docs/agents/README.md](docs/agents/README.md). Change a rule in its file; a new section needs an index row (`tests/test_agents_docs.py`).

Files (`docs/agents/<name>.md`; what each covers is under [Domain file topics](docs/agents/README.md#domain-file-topics)):

**ops-ci** · **database** · **access-and-auth** · **hrv-pipeline** · **experiments** · **habits-checkin** · **nutrition** · **supplements** · **wearables-environment** · **email-calendar-sources** · **devices** · **frontend** · **log-screen** · **personalize** · **today** · **spotify** · **reading-journal** · **chat-agents** · **status-page** · **finance** · **procurement** · **health-records** · **orientation**

## Delivery accountability (Riley, 2026-11-15)

- Authorized implementation: headless Claude Code builders, bounded scope and acceptance criteria. **Codex reviews only AFTER merge, never before (Riley, 2026-11-17)**: the deployed revision, with fixes filed as dev-backlog items; never a merge gate. Pre-merge: only the builder's `npx tsc --noEmit` (frontend) and repo CI. Hold a PR only for an unapplied required migration, a decision that is Riley's, or an investigation-only change. A builder's summary or exit code is not a review.
- **Launched, code written, reviewed, merged, deployed and verified are distinct states.** Record task, attempt, exact revisions, evidence and next action. Never mark Done from launch, a model's claim, a merge or a `/login` 200.
- The orchestrator supervises to verified completion or an explicit blocker without reminders: persist recovery state first, bound retries, reconcile after a restart instead of duplicating, tell Riley essential blockers and decisions.
- One writer per task/worktree, one owner per release transition; respect locks and branch ownership. A new head voids its review/check receipts. Keep private receipts across chats; never invent evidence.
- Verify production behavior against the criteria (UI: authenticated **Today entry point, desktop and phone widths**, the changed interaction). A deployed revision is not acceptance; unavailable checks are gaps, not passes. [Contract](docs/delivery-accountability.md); full text in ops-ci.

## Agent Permissions

Each agent's permissions live in that agent's own settings, not in this repo (Claude Code: `~/.claude/settings.json` + the untracked `.claude/settings.local.json`). Whatever the agent, ask before `rm`, `kill`, other destructive commands, and Supabase project lifecycle operations (pause, restore, delete, branch merge/reset). A code task is no authority for credential changes, data repair or production operations.

## Rules for every task

- **Secrets, privacy.** Never commit secrets (`.env` files are gitignored). The repo and its Actions logs are public: no health, medical, finance, mail, journal or client data in code, tests, fixtures, logs, screenshots, PRs or commits.
- **Access.** The anon key reads nothing in `pds`: never grant it. The browser reads through the owner session + `owner_read` RLS; the service role stays server-side. `isCiRoute()` holds exact paths only: never widen one, and never add a route a domain file calls session-only.
- **SQL** changes go in a `sql/*.sql` file, applied via the Supabase MCP or dashboard. A migration sent through the MCP must contain no `DROP …`, not even `IF EXISTS` guards or the word in a comment.
- **ETL** (database). Always upsert; one key set per bulk upsert; pass dicts to supabase-py JSONB, never `json.dumps()`. Every script writing to Supabase writes a `pds.sync_log` heartbeat on EVERY run, success and failure. A run relying on another layer's assumption checks it, else a `failed`/`partial` heartbeat starting `GUARD <name>:`.
- **Every integration appears on `/status`** in the same commit (status-page): not done without its card.
- **Dates** (database, hrv-pipeline). Behavioral day = local instant − 6 h (ADR-0001); ET via `ZoneInfo("America/New_York")`, never naive `date.today()`. Row D's HRV is the sleep closing day D; outcomes only via `hrv_alignment.py`, never `.shift(-…)`.
- **Frontend** (frontend, log-screen). Nothing Riley waits for takes a full second (state before/after timing). Input saves itself (`lib/autosave.ts`; no Save buttons for data entry; never on open). Scrolling never writes: a page in the continuous scroll makes only side-effect-free GETs (`useInFeed()`). Daily entries are made on `/log`. UI copy: no explanatory paragraphs on screen except statistics. Nav lives in `frontend/src/lib/nav.ts`.
- **Audit and review findings are settled against the data, never against docs or tests.** A finding that claims wrong results may be closed as refuted only by a check on live data or by running the code; these instructions, audit CONTEXT files and existing tests are not evidence against it. Anything DISPUTED or unverified when an audit or review ends becomes a roadmap row in the same session (`Source = "Onyx Roadmap"`) at the audit's severity (P0 → `Critical`, P1 → `High`), with what would settle it in Notes.
- **Git.** Commit and push finished work (Vercel deploys `master`); releases follow Delivery accountability.

## Backlog

Open work is the Notion Tasks DB, `Source = "Onyx Roadmap"`, never this file: mark shipped rows Done, file what you won't fix as Not Started. Use `python tools/notion_tasks.py`; MCP quota: ops-ci.
