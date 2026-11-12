# Integration planner

`tools/integration_plan.py` tells parallel feature builds (one git worktree and branch each) which of them
conflict with master, which conflict with each other, which can merge in any order, and which have to wait for
another one and then rebase. It is advisory and read-only: it never checks anything out, rebases, merges, pushes
or deletes. Python 3 standard library only; shells out to `git` (2.38 or newer for conflict tests) and optionally
`gh`. Runs the same on Windows and Linux. About 4 s for 6 open PRs, capped at 30 refs.

## Before you claim work

1. `git fetch origin` (or pass `--fetch`).
2. `python tools/integration_plan.py --claims --touching <files or dirs you expect to edit>`
3. If a path is `CLAIMED`, either pick other work, or accept that you are the second one: plan to rebase onto
   master after the claimant merges. A file marked hot (3+ in-flight refs, e.g. `frontend/src/lib/nav.ts`) is
   best avoided or edited in the smallest possible hunk.
4. Before you open the PR: `python tools/integration_plan.py` and read the row for your branch.

## Commands

```
python tools/integration_plan.py                  # status table + integration plan (default)
python tools/integration_plan.py --claims         # which files each in-flight ref owns, hot files
python tools/integration_plan.py --worktrees      # git worktree list: dirty, age, PR merged/closed (report only)
python tools/integration_plan.py --all --json     # everything, machine readable
python tools/integration_plan.py --checks         # use `gh pr checks` so green CI merges first
python tools/integration_plan.py --refs mybranch other --base origin/master
python tools/integration_plan.py --fail-on-conflict   # exit 1 if anything conflicts (default exit is 0)
```

Refs default to every `origin/<branch>` with an open PR (`gh pr list`); without `gh` they are the local branches
that are ahead of the base. `--no-gh` forces the second mode (it can include old, squash-merged local branches
that are detected as `no-changes`). `--max-refs` (default 30) caps the work, newest PR activity first.

## Reading the result

Per ref: `clean`, `conflicts-with-base` (what GitHub shows as DIRTY), `conflicts-with:[refs]` (merges into master
alone, collides with those refs), `no-changes` (already in base, including squash-merged work), or `unknown`
(ref missing, no common ancestor, or git older than 2.38).

The plan groups refs into:

- **Independent**: clean against master and sharing no conflicting file with anyone. Merge in any order or in
  parallel. Refs marked `(held)` are drafts or carry the `hold` label; the merge runner skips them.
- **Serial groups**: refs connected by conflicts. Each gets a wave number; refs in the same wave do not depend on
  each other, and wave N waits for the refs it names. The action for the one that goes second is
  `rebase onto master after #N merges (conflicts in: ...)`. A pair that shares files but merges cleanly is
  `no action, auto-resolves`.
- **Rebase only**: conflicts with master and with nobody else; rebase now.

Who goes first in a conflicting pair: green CI first (`--checks`), then the smaller diff (lines changed, then
files), then the older PR. Two tiers sit above that: a draft or `hold` PR goes last (it cannot merge yet), and a
branch that already conflicts with master goes after clean ones (it has to rebase anyway, so it rebases once).
Vercel preview checks are ignored when judging CI (`--ignore-checks` changes the list).

## How conflicts are detected

- Ref vs base: `git merge-tree --write-tree base ref`, the same three-way merge GitHub runs. No checkout, no
  index, no working-tree writes. A merge that changes nothing marks the ref `no-changes`.
- Pair (A first, B second): build "master + A" as a synthetic merge commit, then `git merge-tree` that commit
  against B. Git then merges from B's own fork point, so this is what merging B after A has landed would do, even
  when A and B forked from different master commits. A direct `merge-tree A B` is not used because master's drift
  between their fork points would leak into the verdict. Files that B already conflicts on against master alone
  are subtracted, so a pair is only blamed for collisions A causes. If both conflict with master, the two heads
  are compared directly and the result is marked `approx`; re-run after one of them is rebased.
- Stacked branches (one contains the other's commits) are detected with `merge-base --is-ancestor`; the ancestor
  merges first.
- Every object these commands write goes to a throwaway object directory, so the repository is left
  unchanged: no new objects, refs or index writes (the object store is only read).

## Limits

- Pairs with disjoint file sets are treated as independent. Directory renames, moved code and semantic conflicts
  (two branches that each compile alone) are not detected.
- Results describe the refs as fetched locally. A stale `origin/*` gives stale answers; use `--fetch`.
- It does not know about a merge that happens while it runs. Re-run after each merge.
- `--worktrees` classifies a worktree as a stale candidate only when its branch's PR is merged or closed. It
  reports and never removes; a dirty stale worktree may hold unsaved work.
- Shallow clones lack the history for merge bases and report `unknown`; fetch full history first.

## Tests

`python -m unittest discover -s tests -p test_integration_plan.py -v` builds a temporary git repo (clean branch,
conflict with base, a pair that collides only through a shared file, auto-merge, independent pair, stacked
branches, squash-merged branch, orphan history, missing ref, no `merge-tree`). No network, no `gh`.
