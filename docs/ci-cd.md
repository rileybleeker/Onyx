# Onyx CI/CD: PR to production without handoffs

Riley authorized routine PR merges without per-PR approval (2026-11-11). Since 2026-11-14 ("one user, move fast") a PR
runs only one fast check, the full test suite runs on a schedule, and testing and deploying are independent: target
PR to merge in about a minute.

## Flow

1. **PR opens** (any agent, same repo, owner identity, not draft). `Autonomous CI` runs the single required check `offline-checks` (Python syntax validation only; no behavioral tests). Nothing else runs per PR; Vercel builds `master` only.
2. **Merge train** (`.github/workflows/merge-train.yml`, `tools/merge_train.py`) runs on PR events, on CI completion, and every 15 min. Per pass it:
   - merges every PR whose required check is green on its exact head, oldest first (squash, pinned to that head SHA; GitHub still enforces branch protection, there is no admin bypass);
   - merges a PR that is behind master as it is: protection is not strict, so there is no rebase-and-retest round. Two PRs that each pass but break together are caught by the Production build and the scheduled tests.
3. **Production**: Vercel deploys master on merge; its `next build` type-checks, so a type error deploys nothing. `post-merge.yml` waits for the `Production` deployment of that commit (not for tests), then runs the production smoke test (one retry). A failed build is pinned on the commit that broke it: when the parent's Production build failed too, the oldest failing commit is reverted, not the later merge that was verified (`culprit_of`). When master moves on while a merge waits for its deploy: its smoke test would run this commit's tests against the newer production build, so the result is `skipped` and the newer merge's verification smoke-tests what production serves.
4. **Failure**: the train halts (open `train-halt` issue), a `rollback/<sha>` revert PR is opened and labeled `rollback`; the train merges it (checks still apply), its `Closes #N` closes the halt issue and the train resumes. The revert is itself verified like any release. Never reverts a revert.

## Tests run on a schedule

`scheduled-tests.yml` runs the rest of the suite against master every 30 minutes: `frontend-types` (all `frontend/tests/*.test.cjs` and `scripts/test-*.mjs`, `tsc`, a compile-only `next build`, the Today browser regressions) and `stats-tests` (`tests/run_offline_tests.py`, no secrets). A commit that already passed is skipped in seconds. A failure never blocks a merge or a deploy: the run goes red, the cloud watchdog raises it, and the fix ships as a normal PR. `focus-ios`, `kindle-harvester-test` and `rocketmoney-harvester-test` run after merge (push to master, path-filtered), not per PR. Run the suite by hand: Actions > Scheduled tests > Run workflow (`force` re-tests a commit that passed).

## What the train will not merge (the owner does)

Drafts, forks, PRs from anyone but the owner login, PRs with the `hold` label, conflicts, any red or running check (the Vercel Preview Comments check is ignored), more than 100 files, and any PR touching a protected path: `.github/**`, the train itself, auth/login/token/session code, `middleware.ts`, RLS/owner-read SQL, `.env*`, `vercel.json`, `CODEOWNERS`.

## Conventions

- **Tests are discovered, not listed.** Add `frontend/tests/<name>.test.cjs` (run with `node --test`) or `frontend/scripts/test-<name>.mjs` (files ending `-ui.mjs` need a browser and are not auto-run); `scheduled-tests.yml` picks them up. Do not edit the workflows to add a test line: they are protected paths, and every PR appending to the same lines conflicts. Do not run it before merging, not even locally (Riley, 2026-11-15): the scheduled suite runs it against each deployed revision, and a red run comes back as a fix PR.
- **Stop a PR:** `hold` label or draft. **Stop everything:** open an issue labeled `train-halt`, or disable the "Merge train" workflow.
- **Audit:** every action is in the run summary of Merge train / Post-merge verify and as a comment on the PR; halts and reverts are issues/PRs; git history is the release log.
- **Rollback drill** (exercise the path without breaking prod): Actions > Post-merge verify > Run workflow, `sha` = any harmless commit on master (a docs-only one), `drill` = true.

## Security notes

Uses only the workflow `GITHUB_TOKEN` (no PAT, no stored secrets in the train). `pull_request_target` is safe here because nothing from the PR is checked out or executed; fork PRs are ignored. Opening the revert PR needs Settings > Actions > General > "Allow GitHub Actions to create and approve pull requests"; until enabled, a failed release halts the train, pushes the revert branch and files an issue with the one-click compare link.

## Postdeployment-only automated tests (Riley, 2026-11-15)

The existing required `offline-checks` status now parses Python only; it is not a test pass. Branch protection and security settings are unchanged. Vercel compilation, authentication, signing and permission controls remain. Behavioral/offline tests run after evidence of a successful Production deployment for the exact revision. Post-merge verification starts the credential-free suite; the 30-minute schedule retries deployed revisions. A skipped/deferred run is not evidence of a passing test. Production smoke remains after deployment, and existing live write tests stay manual opt-in only. No automated tests were run before deploying this policy change, per Riley's instruction; independent source review is the validation before publication.

The live HRV matrix check remains daily/manual, not every UI release, to avoid additional production database load. Model-retraining data-integrity checks and iOS entitlement/signing checks are separate safety/build workflows and are unchanged.
