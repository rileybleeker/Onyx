# Cloud watchdog

The system must never silently leave work waiting. A PC runner (RileyPC) squash-merges green PRs
and runs builders; when it sleeps, restarts or pegs the CPU nothing tells anyone, and GitHub cron
workflows are sometimes dropped or delayed. The cloud watchdog is the dead-man switch that works
while the PC is down.

- Code: `tools/watchdog_cloud.py` (stdlib Python, `gh` CLI, `GITHUB_TOKEN` only, no AI).
- Workflow: `.github/workflows/watchdog.yml`, every 30 minutes plus manual dispatch.
- Tests: `tests/test_watchdog_cloud.py` (offline, GitHub is a fake). Run
  `python tests/run_offline_tests.py tests/test_watchdog_cloud.py`. The offline runner discovers it
  automatically, so it runs on every PR (Stats Tests). A side effect worth knowing: a PR that adds a
  scheduled workflow without updating the `SCHEDULED` table below fails that check, by design.

## Contract with the PC half

**Heartbeat (the PC half writes, the cloud half only reads).** One issue labelled `runner-heartbeat`
("PC runner heartbeat (do not close)") with ONE comment:

```
heartbeat:v1
{"at":"2026-11-12T11:55:00Z","ok":true,"stalled":0}
```

- Found by the comment body starting with `heartbeat:v1`. The comment author must be the repo
  owner, a member or a collaborator (`author_association`); a stranger's comment on a public repo
  is ignored, so nobody can fake a healthy runner.
- Flagged when `at` is older than 45 minutes, when `ok` is false, or when `stalled` is above 0.
  A stale heartbeat reports only "stale" (its `ok` and `stalled` are old news).
- Never reported: if the issue or the comment does not exist, the watchdog flags it only once
  `watchdog.yml` has existed for 24 hours (its `created_at` from the Actions API, falling back to the
  first run recorded in the state issue). Before that it only prints a "grace period" line.
- The cloud half cannot watch itself. The PC half should check the age of the newest `Watchdog`
  run and alert if it is older than ~2 hours.

**Alert sink.** One issue labelled `watchdog`, titled `Watchdog: N finding(s)`, edited in place.

- Each finding has a stable key, what and since when, and the exact next step.
- When the set of keys gains a key: a comment that mentions the repo owner (so GitHub notifies).
- When the set becomes empty: an "All clear" comment, then the issue is closed.
- A new problem later reopens it. If a human closes it while the same findings persist, it stays
  closed until a *new* key appears.
- Never more than one new comment per hour. A held-back comment is posted on a later run; the issue
  body is always current. An all-clear waits out the hour before closing.
- The issue is created assigned to the repo owner. Labels `runner-heartbeat`, `watchdog` and
  `watchdog-state` are created if missing.
- Bookkeeping lives in a third issue, `watchdog-state` ("Watchdog state (do not close)"): when a
  condition was first seen, announced keys, last comment time, last recovery attempt per workflow.
  It is overwritten by the watchdog; do not edit it.

## Checks

PRs considered: open, same-repo, not draft, based on the default branch, **without the `hold`
label** (a parked PR is deliberately quiet). Merging is done by the cloud `Merge train` workflow
(see `docs/ci-cd.md`) and by the PC runner for what the train will not touch (`.github/**` and other
protected paths); the watchdog does not care which of them is late.

| Key | Condition | Since |
|---|---|---|
| `merge-stall:pr-N` | `offline-checks` and `frontend-types` (GitHub Actions app) green on the head, merge state CLEAN or UNSTABLE, for more than 20 min | later of the two completion times |
| `pr-red:pr-N` | a required check failed on the current head more than 6 h ago (a new commit gives a new head, so "no new commit" is implied) | failure completion |
| `pr-pending:pr-N` | a required check queued, running or absent for more than 45 min | check start, or head commit time if absent |
| `pr-conflict:pr-N` | merge state DIRTY for more than 2 h; names open PRs and PRs merged in the last 48 h that touch the same files | first seen by the watchdog |
| `pr-behind:pr-N` | green but BEHIND for more than 3 h (the train updates one behind PR at a time) | first seen by the watchdog |
| `master-ci-failed` | newest conclusive `Autonomous CI` run on master failed (cancelled and skipped runs are ignored) | run time |
| `smoke-failed-twice` | the two newest conclusive `Production Smoke Test` runs on master both failed | older failure |
| `live-checks-failed` | newest conclusive `Live DB Checks` run (`live-checks.yml`) failed (ignored if the workflow is absent or disabled) | run time |
| `train-halt:issue-N` | an open issue labelled `train-halt` (opened by a failed release; merging is paused) | issue creation |
| `rollback-pr:pr-N` | an open same-repo PR whose head branch starts with `rollback/` (master was reverted or is about to be) | PR creation |
| `sched-stale:<file>` | newest run (any event) of a scheduled workflow older than its allowed gap | newest run |
| `sched-disabled:<file>` | workflow state is `disabled_*` | first seen by the watchdog |
| `runner-heartbeat-*`, `runner-not-ok`, `runner-stalled` | see the contract above | heartbeat time |
| `watchdog-config-drift` | `SCHEDULED` table and `.github/workflows` disagree | first seen |
| `watchdog-check-error:<name>` | one of the watchdog's own checks raised on two runs in a row 45 min apart | first error |

The merge-stall limit is a flat 20 minutes; the finding also says when an open `train-halt` issue is
the reason. If the train merges one PR per pass and several are queued, the last in line can briefly
exceed the limit; the finding then names a real wait.

## Missed-run recovery and its limits

The allow-list is the `SCHEDULED` table in `tools/watchdog_cloud.py`, keyed by workflow file. Nothing
outside it is ever dispatched or enabled (also enforced at execution time, and tested).

- **Stale** (newest run older than the entry's `max_gap`): flag it and, if the entry has
  `recover=True` **and** the file has a `workflow_dispatch` trigger, dispatch it on the default branch.
- **Disabled by inactivity** (`disabled_inactivity`, GitHub's 60-day rule): flag it and
  `PUT .../enable`. If it is also stale, enable first, then dispatch.
- **Disabled by a person** (`disabled_manually`): flag it, nothing else. Disabling the `Merge train`
  workflow is the documented emergency brake, so the watchdog neither re-enables it nor reports it
  stale. (The weekly `Workflow Keepalive` does `PUT enable` on every workflow, manual or not, so it
  will undo that brake within a week.)
- At most **one automatic dispatch and one enable per workflow per 6 hours**, counting failed
  attempts. The note on the finding says what was done, suppressed or refused.
- Flag-only entries: `HRV Analysis Retrain` (a manual dispatch forces an unconditional full retrain;
  the 12:00 UTC run already covers it), `Monthly GH Actions Audit` (writes to Supabase) and
  `Live DB Checks` (queries the production database).
- `Merge train` is recoverable (gap 90 min; it runs every 15 min plus on PR and CI events), so a
  dropped cron costs at most one watchdog cycle.

Gaps are the cron's longest gap plus slack, checked against run history on 2026-11-12. Some differ
from first guesses because GitHub's own delay would have tripped them: Cronometer is 15 h (its
normal gap is 13h30 and 14h05 was observed), Eight Sleep 28 h (26h46 observed), Smoke Test 8 h
(7h18 observed), Flights/Delivery 4 h (3h19 is routine). The hourly workflows allow 2h30.

**Adding or changing a scheduled workflow:** add it to `SCHEDULED` (or to `EXEMPT_SCHEDULED` with a
reason). The test `AllowListConsistencyTests` fails otherwise, and at runtime the watchdog raises
`watchdog-config-drift`. It also checks that each gap exceeds the cron's own longest gap and that
recoverable entries have `workflow_dispatch`.

## Running it

```
python tools/watchdog_cloud.py --dry-run        # needs an authenticated `gh`; prints, writes nothing
gh workflow run watchdog.yml -f dry_run=true    # same, from Actions (default branch only)
```

Dry run reads real state (including the state issue) but creates no labels, issues, comments,
dispatches or enables, and does not persist first-seen timers, so "first seen" conditions such as
`pr-conflict` appear under "Watching" instead of as findings.

## Trust model

- Reads and writes only through the workflow's `GITHUB_TOKEN`. Permissions: contents read, issues
  write, pull-requests read, actions write, checks read, statuses read.
- Checks out the default branch only, never PR code. The job refuses to run from any other ref.
- Anything an outsider can influence (PR titles, branch names, heartbeat comments) is either
  rendered as inline code, where an `@name` notifies nobody, or filtered by `author_association`.
  Fork PRs are ignored.
- Individual check failures never stop the other checks; a check that keeps failing becomes a
  finding. The job exits non-zero only when it could not write the alert or state issue.

## Not covered

- A PR that is BLOCKED for a non-check reason (required review, conversation resolution) is not
  flagged; only the listed conditions are.
- Whether a scheduled workflow's *latest run succeeded* is `/status`'s job; the watchdog only checks
  that it ran.
- The `hold` label silences every PR check for that PR.
