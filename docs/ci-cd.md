# Onyx CI/CD: PR to production without handoffs

Riley authorized routine PR merges without per-PR approval (2026-11-11). This is how that works.

## Flow

1. **PR opens** (any agent, same repo, owner identity, not draft). `Autonomous CI` (required: `offline-checks`, `frontend-types`) and path-filtered `Stats Tests` run in parallel on GitHub-hosted runners. Vercel builds the preview.
2. **Merge train** (`.github/workflows/merge-train.yml`, `tools/merge_train.py`) runs on PR events, on CI completion, and every 15 min. Per pass it:
   - merges the oldest PR whose required checks are green on its exact head (squash, pinned to that head SHA; GitHub still enforces branch protection, there is no admin bypass);
   - brings **one** behind PR up to date and kicks its CI (the only genuinely serial step: strict branch protection means a merge makes every other PR behind). Parallel CI otherwise.
3. **Production**: Vercel deploys master on merge. `post-merge.yml` waits for the `Production` deployment of that commit, for master CI, then runs the production smoke test (one retry). If master CI of that commit was cancelled only because the next merge landed (Autonomous CI cancels in-progress master runs), the result is `skipped`, not a failure: the newer merge's own verification covers it.
4. **Failure**: the train halts (open `train-halt` issue), a `rollback/<sha>` revert PR is opened and labeled `rollback`; the train merges it (checks still apply), its `Closes #N` closes the halt issue and the train resumes. The revert is itself verified like any release. Never reverts a revert.

## What the train will not merge (the owner does)

Drafts, forks, PRs from anyone but the owner login, PRs with the `hold` label, conflicts, any red or running check (the Vercel Preview Comments check is ignored), more than 100 files, and any PR touching a protected path: `.github/**`, the train itself, auth/login/token/session code, `middleware.ts`, RLS/owner-read SQL, `.env*`, `vercel.json`, `CODEOWNERS`.

## Conventions

- **Tests are discovered, not listed.** Add `frontend/tests/<name>.test.cjs` (run with `node --test`) or `frontend/scripts/test-<name>.mjs` (files ending `-ui.mjs` need a browser and are not auto-run). Do not edit `autonomous-ci.yml` to add a test line: it is a protected path, and every PR appending to the same lines conflicts.
- **Stop a PR:** `hold` label or draft. **Stop everything:** open an issue labeled `train-halt`, or disable the "Merge train" workflow.
- **Audit:** every action is in the run summary of Merge train / Post-merge verify and as a comment on the PR; halts and reverts are issues/PRs; git history is the release log.
- **Rollback drill** (exercise the path without breaking prod): Actions > Post-merge verify > Run workflow, `sha` = any harmless commit on master (a docs-only one), `drill` = true.

## Security notes

Uses only the workflow `GITHUB_TOKEN` (no PAT, no stored secrets in the train). `pull_request_target` is safe here because nothing from the PR is checked out or executed; fork PRs are ignored. Opening the revert PR needs Settings > Actions > General > "Allow GitHub Actions to create and approve pull requests"; until enabled, a failed release halts the train, pushes the revert branch and files an issue with the one-click compare link.
