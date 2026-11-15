# CI checks: offline on pull requests, live only after merge

Pull-request checks hold no secrets and never touch production data. Anything that needs the production Supabase project runs only after the code is on master, on a schedule, or when someone starts it by hand.

## Why

A pull request can edit `tests/*.py` or the workflow files themselves, so any secret a PR job can read is exposed to unreviewed code before anyone merges it. The old Stats Tests job carried the production service-role key, and its live tests queried the production database on every PR. On 2026-11-11 a burst of PR runs preceded a Postgres stall. Moving the live tests out of the PR path fixes both problems at the source instead of throttling them.

## What runs where

| Check | Workflow | Runs on | Secrets | Touches production |
|---|---|---|---|---|
| `offline-checks` (the only required check) | `autonomous-ci.yml` | every PR | none | no |
| `frontend-types`, `stats-tests` | `scheduled-tests.yml` | master every 30 min (a commit that passed is skipped), manual | none | no |
| Live DB Checks | `live-checks.yml` | push to master (pipeline and test paths), daily 08:25 UTC, manual | step-scoped Supabase service-role key | read-only; one run at a time |
| HRV alignment before each retrain | `hrv-retrain-on-backfill.yml` | hourly (conditional) and daily 12:00 UTC | job-level | read-only, writes a failure heartbeat |
| Production smoke | `smoke-test.yml` | every 6 hours | smoke login | read-only |

Since 2026-11-14 `stats-tests` runs on master in `scheduled-tests.yml` and always runs the full suite (the TDEE source guard is part of it). The frontend-only scope in `tools/stats_ci_scope.py` (2026-11-14, #171) only applied to `pull_request` events and is no longer used by any workflow; its dependency fingerprint and inventory are kept as the audit record.

This reduces redundant runner work; it does not guarantee a shorter release when the parallel frontend job is already slower. Measure actual Actions durations before claiming a wall-clock improvement.

`stats-tests` has no `SUPABASE_*` variables at all. Its single install step is `pip install -r requirements-ci.txt` (the pinned `requirements-analysis.lock` plus the one extra package the ETL modules import). Pip downloads are cached on the hash of those two files.

## Offline Python suite: `tests/run_offline_tests.py` (scheduled, since 2026-11-14)

The job runs `python tests/run_offline_tests.py`. It finds every `tests/test_*.py` except the live ones, runs each in its own process (the same `python tests/test_x.py` the file's docstring documents), one process per CPU, and exits non-zero if any file fails. Secret-looking environment variables are stripped from the child processes, so even a developer machine with a loaded `.env` runs the same way CI does.

Run it locally the same way:

```
python tests/run_offline_tests.py              # everything offline, in parallel
python tests/run_offline_tests.py -j 1         # one at a time
python tests/run_offline_tests.py tests/test_causal_fdr.py   # just these files
python tests/run_offline_tests.py --list       # what runs, what is live, what is known broken
```

Offline test files set stub `SUPABASE_*` values with `os.environ.setdefault(...)` before importing a pipeline module; the module-level client creation then succeeds without any network call.

## Live job: `live-checks.yml`

| Test | When |
|---|---|
| `tests/test_hrv_alignment_live.py` | every run, with `ONYX_REQUIRE_LIVE=1` (missing credentials are a failure, not a skip). `ONYX_ALIGNMENT_HEARTBEAT` is not set, so it writes nothing. |
| `tests/test_habit_rename.py` | only when you start the workflow by hand and tick `run_live_write_tests`. It writes uuid-tagged fixtures to the live database and deletes them. Never on push or schedule. |

A failure is a red run (and GitHub's failure email). Concurrency group `live-checks` does not cancel in-progress runs, so two runs never query the database at once. Because this runs after merge, a bad alignment change is caught within minutes of landing rather than before it; the retrain workflow also refuses to publish results when the same test fails.

## Adding a test

1. Offline (the normal case): create `tests/test_<name>.py` that needs no credentials, network or database. Stub what the module reads at import time (`os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")` and `"SUPABASE_SERVICE_ROLE_KEY"`), and finish with a `__main__` block that runs every `test_*` function and exits non-zero on failure (copy the loop from `tests/test_delivery_features.py`). It is discovered automatically; there is nothing to register. Check it with `python tests/run_offline_tests.py tests/test_<name>.py`.
2. Needs production: it is not an offline test. Add it to `LIVE_TESTS` in `tests/run_offline_tests.py` and give it a step in `live-checks.yml` with the secrets in that step's `env`. The runner fails if a name in `LIVE_TESTS` does not appear in `live-checks.yml`, so a live test cannot be excluded from the PR job and then forgotten. Keep it read-only; anything that writes goes behind a manual input like `run_live_write_tests`.
3. A test that fails for a reason unrelated to your change: do not delete or skip it silently. Add it to `KNOWN_BROKEN` in `tests/run_offline_tests.py` with the reason. It still runs and is reported as a warning; once it passes the job fails until you remove the entry. The list is empty today.

## Parallel feature builds

When several branches are in flight at once (one git worktree each), CI checks each PR on its own and cannot tell you whether two PRs collide with each other. Use `tools/integration_plan.py` for that: it is read-only and reports which branches conflict with master, which pairs conflict with each other, and the order to merge them in. Run `python tools/integration_plan.py --claims --touching <paths>` before claiming work and `python tools/integration_plan.py` before opening a PR. Full usage and the ordering rules are in `docs/integration-plan.md`.

## Not covered by this change

- `autonomous-ci.yml` (including its `offline-checks` and `frontend-types` jobs, the required checks) is unchanged.
- Dependencies installed by `requirements-ci.txt` come from the lock file, which was last regenerated 2026-04-16 and pins `supabase==2.19.0`. Local development uses newer versions, so a pin bump should be tried through this job first.

The scoped-job dependency inventory and audit limits are in [stats-ci-dependency-inventory.md](stats-ci-dependency-inventory.md).

Postdeployment-only policy (2026-11-15) supersedes the historical PR descriptions above: `offline-checks` only parses Python; behavioral tests require successful exact-revision Production deployment. See `docs/ci-cd.md`.
