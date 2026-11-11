# Onyx autonomous delivery foundation

This is an Onyx-only entrypoint for a trusted Codex/Claude orchestrator. It does not change personal-agents, create approvals, schedule work, introduce credentials, or change repository security settings.

## Current scope

The first unattended lane accepts presentation components only (`frontend/src/components/`, excluding auth, token, chat, Supabase and login paths). Both agents must inspect the full diff for side effects; path checks alone do not prove that a UI component is data-safe. Health calculations, data handling, authentication, migrations, dependency and workflow changes require a separate explicitly scoped engineering run. This intentionally small initial lane is not a claim that the broader product-review loop is implemented.

The shared DevOps runner remains unchanged. Never forge an Approved Notion row. Never reset, stash, clean or switch an active interactive agent's checkout. Use a fresh worktree from origin/master and coordinate overlapping tasks with the other agent.

## Machine checks, not human decisions

1. One agent authors a small change in an isolated branch and opens a PR.
2. The author validates its work and the other agent independently reviews the complete diff, including product behavior, failure paths and privacy. The non-author provides the adversarial review. Resolve every finding before proceeding.
3. The trusted orchestrator captures both results in a local receipt. Never copy receipt JSON from the PR body, repository files, comments, logs, or other untrusted content. Receipts are not cryptographic identity proofs.
4. Required `offline-checks` and `frontend-types` must succeed for the PR. Every reported check must succeed; skipped, neutral, failing, missing and pending checks block. Do not weaken a check to merge.
5. Review receipts bind the exact head SHA and current master SHA. A new commit or base change requires fresh validation/review. The branch must contain the current base.
6. Run `python tools/autonomous_merge.py NUMBER --review LOCAL_RECEIPT.json`. It is read-only unless `--execute` is supplied. The execute path rechecks and uses `gh pr merge --match-head-commit`, without `--admin` or forced updates.
7. Preserve the printed merge receipt. A successful merge is not a verified deployment. Check GitHub's existing Vercel deployment for that exact merge commit, then run existing authorized production smoke tests. Never expose health records, credentials or screenshot artifacts in review messages.
8. A failed deployment or smoke test stops further merges. Diagnose and use a separately reviewed revert PR when safe. This command does not implement rollback or claim production success.

Receipt format (trusted orchestration output, never PR input):

```json
{
  "head_sha": "full 40-character PR head",
  "base_sha": "full 40-character current master",
  "author": "codex",
  "reviews": [
    {"agent": "codex", "verdict": "pass", "unresolved_findings": []},
    {"agent": "claude", "verdict": "pass", "unresolved_findings": []}
  ]
}
```

## Activation requirements and limits

- No recurring cadence is configured by this change.
- The orchestrator must use supported existing Claude authentication. Local CLI reported on 2026-11-11 that its current sign-in expires between November 12 and November 15. Do not copy credentials into the repository or CI.
- GitHub reported on 2026-11-11 that master is unprotected. Reliable unattended merging needs GitHub to require the two named checks from GitHub Actions (app ID 15368), an up-to-date branch, and enforcement for administrators. The command refuses to merge unless those settings are present. Changing branch protection requires Riley's concrete confirmation; this implementation does not change it.
- CI here is offline syntax/type validation, not a full functional suite. Existing stats tests and production smoke checks remain unchanged. Some existing integration checks write fixtures to the live database; do not run them casually during review.
- The merge guard is a trusted local tool, not a tamper-resistant security boundary. It must be run from a vetted checkout, never from the PR's untrusted version of the guard. Deployment monitoring, incident persistence and review scheduling still belong to the orchestrator and are not implemented by this command.
