# CI/CD run log

Evidence that the merge train (see `ci-cd.md`) ran unattended. Newest first.

- 2026-11-12: first unattended PR-to-production run. This file was added by a PR that no one merged by hand; the train merged it once `offline-checks` and `frontend-types` were green, Vercel deployed it to Production, and Post-merge verify confirmed the deploy and master CI.
