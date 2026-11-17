# Delivery accountability

This is the operating contract for authorized Onyx delivery. Codex supervises headless Claude Code execution, reviews the actual diff and carries the work through acceptance. Riley should not have to prompt the orchestrator to check whether a handoff finished. This document sets requirements; it is not evidence that a new worker capability has shipped. Existing mechanics and activation limits are documented in [personal-agents feature worker](https://github.com/rileybleeker/personal-agents/blob/main/docs/feature-worker.md) and [delivery controls](https://github.com/rileybleeker/personal-agents/blob/main/docs/ci-cd.md).

## Completion evidence

Keep these states separate and attach evidence to the same task and attempt:

- **Launched:** authorized scope, acceptance criteria, task/attempt IDs, worktree, branch, owner, process/run reference and recovery checkpoint recorded. Launch is not completion.
- **Code written:** actual changed files and commit/head identified; builder output retained as a claim to verify.
- **Reviewed:** after merge, Codex reviews the merged and deployed revision and files each finding as a dev backlog item for Claude to fix (Riley, 2026-11-17: Codex never reviews before merge). Before merge, only the builder's own type check and the repo's CI checks run; a PR is held only for a required migration not yet applied, a decision that is Riley's, or an investigation-only change, and that hold list applies only once those prerequisites have succeeded — a failed prerequisite is fixed before the PR goes forward. The builder's own in-workflow Codex CLI consultation (pre-merge, part of the builder workflow, never a merge gate) is distinct from the independent post-deploy Codex advisor (after deployment, files findings as dev backlog items, never a merge approval gate). The orchestrator agent that performed the release owns triage of post-deploy findings into backlog items until Riley reassigns it, and a finding is not closed until its fix PR is merged and deployed.
- **Merged:** PR and exact merge commit recorded after authorized release gates. One owner performs the transition; another agent or merge train must not independently release the same worker branch.
- **Deployed:** observed Production deployment identifies the merge revision, or a newer revision proved to contain it. Record which revision is actually served; do not substitute a queued build or another deployment's success.
- **Verified:** task-specific acceptance observed on the serving revision. Relevant UI changes include authenticated Today, desktop and phone widths, and the changed interaction. A login health check or passing automated suite alone does not establish product acceptance. Missing access, device coverage or observations remain explicit gaps.

Mark **Done** only when the acceptance criteria are met and their evidence is recorded. Keep partial completion, failed checks and blockers visible with an owner and next action. Notify Riley of essential blockers or decisions, rather than silently waiting for another prompt. Do not claim a background supervisor is active unless its installation and observed operation support that claim.

## Recovery and ownership

Before a long-running attempt or external transition, persist its identity, phase, revision, retry budget and recovery action. After interruption, reconcile the recorded process, PR, deployment and receipts before retrying; a missing response is not proof that an action did not occur. Reserve attempts before launch, bound retries, and record exhausted attempts as blockers. Preserve successful observations instead of overwriting them with a later attempt's assumptions.

Use one writer for each task/worktree, the existing worker lock and release ownership rules. A reviewer does not edit the builder's active worktree. Recover stale ownership from evidence; never clear another live worker's lock or reset its checkout merely to make progress. Publish reconciled status from the designated writer so the roadmap and receipts agree.

## Private evidence retention and restoration

Keep task/attempt/revision receipts, review outcomes, deployment evidence, acceptance results and recovery checkpoints in the established private runtime/audit storage, not only in chat history or a short rolling log. Retain them across chats, restarts and routine cleanup until Riley authorizes disposal. Minimize contents: identifiers, timestamps, outcomes and artifact references; no credentials, health record bodies or unnecessary private transcripts in public repositories or PRs.

Provide a versioned private export/backup of the receipts and recovery state before migrating or replacing their store. Record its location and restoration procedure in the private operational record; verify restorability without replaying writes. Restore into an idle, locked worker, then reconcile revision and remote action evidence before resuming. Restored records are historical evidence, not fresh authorization or proof that production still serves that revision. Where retention, export or restoration is not yet implemented, report the gap rather than claiming durability.

## Checks policy

The [AGENTS.md testing policy](../AGENTS.md#read-this-first-testing-and-checks-riley-2026-11-15) governs: author/update tests, do not run automated tests or local builds before merge, and type-check frontend changes with `npx tsc --noEmit`. Record the actual premerge checks and subsequent postdeployment results separately. These accountability rules do not expand implementation authority, weaken release gates or authorize additional production writes.
