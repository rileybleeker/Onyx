# CI/CD run log

Evidence for the merge train (see `ci-cd.md`). Newest first.

- 2026-11-12 (third try, after the two verifier fixes): this entry rides a docs-only PR that nobody merges by hand. Proof is the PR comment "Merge train: squash-merged" and a merger of `github-actions[bot]`.
- 2026-11-12: train went live with #31. First live run exposed a bug: Post-merge verify read a CI run cancelled by the next merge as a failure and halted the train (issue #36, false positive, closed). PR #33 was merged by hand while the train was halted, so it is not evidence of an unattended run. Fixed by #37 (cancelled CI) and the Production-deployment follow-up.
