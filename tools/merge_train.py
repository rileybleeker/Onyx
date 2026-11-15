#!/usr/bin/env python3
"""Onyx merge train, post-merge verification and rollback.

Runs in GitHub Actions from the default branch only, with the job's own GITHUB_TOKEN. It reads PR metadata through
the API and never checks out or executes PR code. GitHub branch protection (required checks, up-to-date branch,
enforced for admins) stays the final gate: this script only does the clicking a human or agent used to do.

    train [--dry-run]            merge what is green, bring the next PR up to date, one in flight at a time
    post-merge --sha SHA         wait for the Production deploy of SHA, print result=ok|fail|halt|skipped
    rollback --sha SHA --reason  halt the train, open a revert PR for SHA (needs the Actions PR-creation setting);
             [--halt-only]       with --halt-only (failure provenance unknown) halt and file the issue, no revert
    ensure-labels                create the hold / rollback / train-halt labels
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time

REPO = os.environ.get("GITHUB_REPOSITORY", "rileybleeker/Onyx")
BASE = "master"
CI_WORKFLOW = "autonomous-ci.yml"
POST_MERGE_WORKFLOW = "post-merge.yml"
REQUIRED = ("offline-checks",)  # mirrors branch protection; the rest of the suite runs in scheduled-tests.yml
OWNER_LOGINS = {"rileybleeker"}  # every agent PR is opened with the owner's identity
BOT_LOGINS = {"github-actions[bot]", "app/github-actions", "github-actions"}
HOLD, ROLLBACK, HALT = "hold", "rollback", "train-halt"
LABELS = {HOLD: ("d93f0b", "Merge train skips this PR"),
          ROLLBACK: ("b60205", "Automatic revert of a failed release"),
          HALT: ("b60205", "Merge train halted until this issue closes")}
MAX_FILES = 100
# A PR touching any of these needs the owner (not routine): CI/CD, auth and token boundaries, RLS, secrets.
PROTECTED = [re.compile(p, re.I) for p in (
    r"^\.github/", r"^tools/merge_train\.py$", r"^tests/test_merge_train\.py$", r"^docs/ci-cd\.md$",
    r"^frontend/src/middleware\.ts$", r"(^|/)(auth|login|token|session)[^/]*\.(ts|tsx|js|py)$",
    r"^frontend/src/(app/)?(api/)?(auth|login)(/|$)", r"^sql/.*(rls|polic|owner)", r"(^|/)\.env",
    r"(^|/)CODEOWNERS$", r"^vercel\.json$", r"^frontend/vercel\.json$")]
BAD = {"failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"}
# BEHIND merges as it is (branch protection is not strict): no rebase-and-retest round per PR (Riley 2026-11-14).
MERGEABLE_STATES = {"CLEAN", "UNSTABLE", "HAS_HOOKS", "BEHIND"}


def ignored(name: str) -> bool:
    """Vercel's per-PR preview comment check is advisory and sometimes red for unrelated reasons."""
    return "vercel" in name.lower() and "preview" in name.lower()


# The train's own job shows up as a check on the PR head; waiting on it would wait on itself.
OWN_CHECKS = {"train"}
OWN_WORKFLOWS = {"Merge train", "Post-merge verify"}
# Vercel's preview build status: it queues behind other builds on Vercel and repeats what the Production build
# checks, so a pending preview does not hold a merge. A failed preview still blocks.
PREVIEW_STATUS = "Vercel"


def note(msg: str) -> None:
    print(msg, flush=True)
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(msg + "\n\n")


# ---------- decision logic (pure; unit tested) ----------
def protected_path(path: str) -> bool:
    return any(p.search(path) for p in PROTECTED)


def latest_runs(runs: list[dict]) -> dict[str, dict]:
    """The newest check run per name, which is what GitHub's required-check evaluation looks at."""
    out: dict[str, dict] = {}
    for r in runs:
        if r["name"] not in out or r["id"] > out[r["name"]]["id"]:
            out[r["name"]] = r
    return out


def is_rollback(pr: dict) -> bool:
    return (ROLLBACK in pr["labels"] and pr["author"] in BOT_LOGINS and pr["title"].startswith("Revert")
            and pr["headRefName"].startswith("rollback/"))


def judge(pr: dict, files: list[str] | None, runs: list[dict], statuses: list[dict], active_runs: int,
          halted: bool) -> tuple[str, str]:
    """-> (action, reason); action is merge | update | dispatch | wait | skip."""
    if pr["isDraft"]:
        return "skip", "draft"
    if pr["baseRefName"] != BASE or pr["isCrossRepository"]:
        return "skip", "not a same-repo PR into " + BASE
    rb = is_rollback(pr)
    if not rb and pr["author"] not in OWNER_LOGINS:
        return "skip", f"author {pr['author']} is not on the allow-list"
    if HOLD in pr["labels"]:
        return "skip", "hold label"
    if halted and not rb:
        return "skip", "train halted (open train-halt issue)"
    if files is None or len(files) > MAX_FILES:
        return "skip", "file list incomplete or over %d files" % MAX_FILES
    hit = next((f for f in files if protected_path(f)), None)
    if hit:
        return "skip", f"protected path {hit} (owner merges these)"
    if pr["mergeable"] == "CONFLICTING" or pr["mergeStateStatus"] == "DIRTY":
        return "skip", "merge conflict"
    latest = latest_runs([r for r in runs if not ignored(r["name"]) and r["name"] not in OWN_CHECKS])
    for name, r in latest.items():
        if r["status"] == "completed" and r["conclusion"] in BAD:
            return "skip", f"check {name} {r['conclusion']}"
    for s in statuses:
        if s["state"] in ("failure", "error") and not ignored(s["context"]):
            return "skip", f"status {s['context']} {s['state']}"
    pending = active_runs > 0 or any(r["status"] != "completed" for r in latest.values()) or \
        any(s["state"] == "pending" and not ignored(s["context"]) and s["context"] != PREVIEW_STATUS for s in statuses)
    if pending:
        return "wait", "checks running"
    missing = [n for n in REQUIRED if n not in latest or latest[n]["conclusion"] != "success"]
    if missing:
        return "dispatch", "required checks missing on this head: " + ", ".join(missing)
    if pr["mergeStateStatus"] in MERGEABLE_STATES:
        return "merge", pr["mergeStateStatus"].lower()
    return "wait", "GitHub says " + pr["mergeStateStatus"].lower()


def plan(decisions: list[tuple[dict, str, str]]) -> tuple[str, dict | None, str]:
    """Pick the single next move. Merging wins; otherwise only one PR is brought up to date or kicked at a time,
    and not while another PR that already contains master is still waiting on checks."""
    for pr, action, why in decisions:
        if action == "merge":
            return "merge", pr, why
    for pr, action, why in decisions:
        if action in ("dispatch", "wait") and pr["mergeStateStatus"] != "BEHIND":
            return ("dispatch", pr, why) if action == "dispatch" else ("wait", pr, why)
    for pr, action, why in decisions:
        if action == "update":
            return "update", pr, why
    return "idle", None, "nothing eligible"


# ---------- GitHub I/O ----------
class GhError(RuntimeError):
    pass


def gh(*args: str, check: bool = True) -> str:
    p = subprocess.run(["gh", *args], capture_output=True, text=True, timeout=180)
    if check and p.returncode:
        raise GhError((p.stderr or p.stdout).strip()[:500])
    return p.stdout if p.returncode == 0 else (p.stdout or p.stderr)


def api_json(path: str, *extra: str):
    return json.loads(gh("api", path, *extra))


def api_items(path: str, jq: str) -> list[dict]:
    out = gh("api", "--paginate", path, "--jq", jq)
    return [json.loads(line) for line in out.splitlines() if line.strip()]


def open_prs() -> list[dict]:
    fields = "number,title,isDraft,baseRefName,isCrossRepository,author,labels,headRefOid,headRefName,mergeable,mergeStateStatus"
    rows = json.loads(gh("pr", "list", "-R", REPO, "--state", "open", "--limit", "100", "--json", fields))
    for r in rows:
        r["author"] = (r.get("author") or {}).get("login", "")
        r["labels"] = [l["name"] for l in r.get("labels") or []]
    return sorted(rows, key=lambda r: r["number"])


def pr_files(n: int) -> list[str] | None:
    """Every path the PR touches, including the old name of a rename, so a move out of a protected path still counts."""
    try:
        rows = api_items(f"repos/{REPO}/pulls/{n}/files?per_page=100", ".[]|{filename,previous_filename}")
    except GhError:
        return None
    return [p for r in rows for p in (r["filename"], r.get("previous_filename")) if p]


def head_checks(sha: str) -> tuple[list[dict], list[dict], int]:
    runs = api_items(f"repos/{REPO}/commits/{sha}/check-runs?per_page=100",
                     ".check_runs[]|{id,name,status,conclusion}")
    statuses = api_items(f"repos/{REPO}/commits/{sha}/status?per_page=100",
                         ".statuses[]|{context,state}")
    wf = api_items(f"repos/{REPO}/actions/runs?head_sha={sha}&per_page=100",
                   ".workflow_runs[]|{status,name}")
    return runs, statuses, sum(1 for w in wf if w["status"] != "completed" and w["name"] not in OWN_WORKFLOWS)


def halted() -> bool:
    return bool(api_items(f"repos/{REPO}/issues?state=open&labels={HALT}&per_page=5", ".[]|{number}"))


def master_sha() -> str:
    return gh("api", f"repos/{REPO}/git/ref/heads/{BASE}", "--jq", ".object.sha").strip()


def evaluate() -> list[tuple[dict, str, str]]:
    stop = halted()
    out = []
    for pr in open_prs():
        if pr["isDraft"] or pr["baseRefName"] != BASE:
            out.append((pr, "skip", "draft or other base"))
            continue
        files = pr_files(pr["number"])
        if is_rollback(pr):
            approve_held_runs(pr["headRefOid"])
        runs, statuses, active = head_checks(pr["headRefOid"])
        out.append((pr, *judge(pr, files, runs, statuses, active, stop)))
    return out


def approve_held_runs(sha: str) -> None:
    """GitHub holds pull_request runs on PRs the Actions bot opened. Only called for rollback-shaped PRs (a revert
    of a master commit opened by post-merge verify), so this never releases CI for anyone else's code."""
    for r in api_items(f"repos/{REPO}/actions/runs?head_sha={sha}&status=action_required&per_page=20", ".workflow_runs[]|{id}"):
        gh("api", "-X", "POST", f"repos/{REPO}/actions/runs/{r['id']}/approve", check=False)
        note(f"approved held CI run {r['id']} on rollback head {sha[:7]}")


def close_halt(pr: dict) -> None:
    """A token-made merge does not fire 'Closes #N', so the train closes the halt issue the rollback PR names."""
    body = gh("api", f"repos/{REPO}/pulls/{pr['number']}", "--jq", ".body // \"\"", check=False)
    for n in re.findall(r"Closes #(\d+)", body):
        gh("issue", "close", n, "-R", REPO, "--comment", f"Rollback #{pr['number']} merged; train resumes.", check=False)
        note(f"closed halt issue #{n}")


def merge(pr: dict, why: str) -> str | None:
    """Squash-merge pinned to the evaluated head. GitHub refuses if protection is not satisfied. -> merge sha."""
    out = gh("api", "-X", "PUT", f"repos/{REPO}/pulls/{pr['number']}/merge", "-f", "merge_method=squash",
             "-f", f"sha={pr['headRefOid']}", check=False)
    try:
        body = json.loads(out)
    except ValueError:
        body = {}
    if body.get("merged"):
        sha = body["sha"]
        note(f"MERGED #{pr['number']} {pr['title']} -> {sha} ({why})")
        gh("pr", "comment", str(pr["number"]), "-R", REPO, "--body",
           f"Merge train: squash-merged at `{sha[:7]}` (head `{pr['headRefOid'][:7]}`, required checks green). "
           f"Deploy and smoke verification follow; a failure opens an automatic revert.", check=False)
        gh("api", "-X", "DELETE", f"repos/{REPO}/git/refs/heads/{pr['headRefName']}", check=False)
        if is_rollback(pr):
            close_halt(pr)
        return sha
    note(f"not merged #{pr['number']}: {body.get('message') or out.strip()[:200]}")
    return None


def rollback_target(body: str) -> str | None:
    """Pure: the commit a rollback PR reverts, from the body rollback() writes ("Automatic rollback of `<sha>`")."""
    m = re.search(r"Automatic rollback of `([0-9a-f]{40})`", body or "")
    return m.group(1) if m else None


def retire_fixed_rollback(pr: dict) -> bool:
    """Close, unmerged, a rollback PR whose target's failed build a newer merge has since fixed and deployed, and
    close its halt issue. -> True when closed. Merging it would take a working change off the site (#296)."""
    body = gh("api", f"repos/{REPO}/pulls/{pr['number']}", "--jq", ".body // \"\"", check=False)
    target = rollback_target(body)
    fixer = already_fixed(target) if target else None
    if not fixer:
        return False
    msg = (f"Not merged: the failed build of `{target[:7]}` is already fixed by `{fixer[:7]}`, which contains it and "
           f"deployed to Production successfully. Reverting now would take a working change off the site.")
    gh("pr", "close", str(pr["number"]), "-R", REPO, "--comment", msg, "--delete-branch", check=False)
    for n in re.findall(r"Closes #(\d+)", body):
        gh("issue", "close", n, "-R", REPO, "--comment", f"{msg} Train resumes.", check=False)
    note(f"CLOSED stale rollback #{pr['number']}: {target[:7]} already fixed by {fixer[:7]}")
    return True


def update(pr: dict) -> None:
    gh("api", "-X", "PUT", f"repos/{REPO}/pulls/{pr['number']}/update-branch", "-f",
       f"expected_head_sha={pr['headRefOid']}")
    note(f"UPDATED #{pr['number']} {pr['headRefName']} with {BASE}")
    time.sleep(25)  # a token-made commit starts no PR workflow runs; kick CI if nothing started on the new head
    fresh = next((p for p in open_prs() if p["number"] == pr["number"]), None)
    if fresh and fresh["headRefOid"] != pr["headRefOid"]:
        dispatch_ci(fresh, only_if_idle=True)


def dispatch_ci(pr: dict, only_if_idle: bool = False) -> None:
    if only_if_idle and head_checks(pr["headRefOid"])[2]:
        return
    gh("workflow", "run", CI_WORKFLOW, "-R", REPO, "--ref", pr["headRefName"])
    note(f"DISPATCHED CI for #{pr['number']} on {pr['headRefName']} @ {pr['headRefOid'][:7]}")


def run_train(dry: bool) -> int:
    for _ in range(12):  # each round is one move; merging re-plans against GitHub's fresh state
        decisions = evaluate()
        for pr, action, why in decisions:
            print(f"  #{pr['number']:<4} {action:<8} {why}")
        move, pr, why = plan(decisions)
        note(f"plan: {move}" + (f" #{pr['number']} ({why})" if pr else ""))
        if dry or move in ("idle", "wait"):
            return 0
        if move == "merge" and is_rollback(pr) and retire_fixed_rollback(pr):
            continue
        if move == "merge":
            sha = merge(pr, why)
            if not sha:
                return 0
            gh("workflow", "run", POST_MERGE_WORKFLOW, "-R", REPO, "-f", f"sha={sha}", check=False)
            time.sleep(8)
            continue
        if move == "update":
            update(pr)
        else:
            dispatch_ci(pr)
        return 0
    return 0


# ---------- post-merge verification ----------
def production_verdict(states: list[str], master_moved: bool) -> tuple[str, str] | None:
    """Pure: verdict on the commit's Production deployment statuses, or None while still waiting.

    Vercel marks a deployment inactive once a newer Production deployment replaces it, so with merges landing
    back to back the older one never reads success again. That is superseded, not failed: the newer merge's own
    verification covers it."""
    if "success" in states:
        return "ok", "Production deployment succeeded"
    if states and all(s in ("failure", "error") for s in states):
        return "fail", "Production deployment " + states[0]
    if "inactive" in states or master_moved:
        return "skipped", "Production deployment replaced by a newer merge; that merge's own verification covers this one"
    return None


def wait_production(sha: str, timeout: int = 900) -> tuple[str, str]:
    end = time.time() + timeout
    while time.time() < end:
        deps = api_items(f"repos/{REPO}/deployments?sha={sha}&environment=Production&per_page=5", ".[]|{id}")
        states = []
        for d in deps:
            st = api_items(f"repos/{REPO}/deployments/{d['id']}/statuses?per_page=1", ".[]|{state}")
            states.append(st[0]["state"] if st else "pending")
        verdict = production_verdict(states, master_sha() != sha)
        if verdict:
            return verdict
        time.sleep(20)
    return "fail", f"no successful Production deployment within {timeout // 60} min"


def moved_on_verdict(result: str, why: str, sha: str, head: str) -> tuple[str, str]:
    """Pure: an `ok` verdict turns `skipped` when master moved on while we waited for the deploy.

    The smoke test that runs next checks out THIS commit's tests but loads PRODUCTION, which by then serves the newer
    merge. Old tests against newer pages fail on copy the newer merge changed (2026-11-14: #113's run failed on
    /procurement and /health headings that #120 and #124, merged during its 14-minute wait, had rewritten together
    with the tests). The newer merge's own verification smoke-tests what production actually serves."""
    if result == "ok" and head != sha:
        return "skipped", f"master moved on to {head[:7]} while this merge was verified; that merge's own verification covers this one"
    return result, why


def build_state(states: list[str]) -> str:
    """Pure: what a commit's Production deployment statuses prove about its build.

    good    = a deployment succeeded.
    failed  = every deployment ended `failure`, which is what Vercel posts when the build fails
              ("Deployment has failed").
    unknown = anything else: no deployment at all (Vercel skips a commit superseded by a newer push, e.g. #187),
              `inactive` (Vercel posts it for a deployment canceled from its dashboard, so it never built), still
              pending, `error` (an infrastructure error, not evidence against the source) or a mix."""
    if "success" in states:
        return "good"
    if states and all(s == "failure" for s in states):
        return "failed"
    return "unknown"


def culprit_of(chain: list[tuple[str, list[str]]]) -> str | None:
    """Pure: chain = [(sha, production states)] from the failing merge back through its parents. Returns the commit
    to revert, or None when the evidence does not name one (Codex review 2026-11-14).

    The culprit is the oldest commit of the unbroken run of failed builds, and only when that run ends at a good
    build: reverting a later commit would drop a good change and leave the build broken. A commit with no build
    result (skipped, canceled, errored, pending) inside the run, a failing merge that itself has no failed build (a
    deploy timeout), or no good build within the commits read means the breaking commit is not known: if A broke the
    build, B was never built and C failed, the walk cannot tell A from B, and stopping at B would revert C, an
    unrelated change. Then nothing is reverted and the train halts for a diagnosis."""
    if not chain or build_state(chain[0][1]) != "failed":
        return None
    culprit = chain[0][0]
    for commit, states in chain[1:]:
        state = build_state(states)
        if state == "good":
            return culprit
        if state == "unknown":
            return None
        culprit = commit
    return None


def fixed_later(own_states: list[str], later: list[tuple[str, list[str]]]) -> str | None:
    """Pure: a failed build is already fixed when a newer master commit that contains it built successfully.

    later = [(sha, production states)] from master head back through first parents, down to (not including) the
    commit itself, so every entry contains it. Returns the newest good commit, or None. Only a build failure can be
    fixed this way: a smoke failure on a commit whose own build succeeded is not disproved by a later good build.
    (2026-11-15: #294's build failed, #297 fixed it and deployed, and the rollback of #294 still merged as #296,
    taking a working /log off the site.)"""
    if build_state(own_states) != "failed":
        return None
    return next((c for c, s in later if build_state(s) == "good"), None)


def production_states(sha: str) -> list[str]:
    states = []
    for d in api_items(f"repos/{REPO}/deployments?sha={sha}&environment=Production&per_page=5", ".[]|{id}"):
        st = api_items(f"repos/{REPO}/deployments/{d['id']}/statuses?per_page=1", ".[]|{state}")
        states.append(st[0]["state"] if st else "pending")
    return states


def later_chain(sha: str, depth: int = 20) -> list[tuple[str, list[str]]]:
    """[(commit, states)] from master head back through first parents down to sha (excluded). Empty when sha is
    master head or is not on that path within depth (then nothing is known to contain it)."""
    chain, cur = [], master_sha()
    for _ in range(depth):
        if cur == sha:
            return chain
        chain.append((cur, production_states(cur)))
        cur = gh("api", f"repos/{REPO}/commits/{cur}", "--jq", ".parents[0].sha", check=False).strip()
        if not cur:
            break
    return []


def already_fixed(sha: str) -> str | None:
    """I/O wrapper of fixed_later: the newer master commit whose good build shows sha's failed build is fixed."""
    return fixed_later(production_states(sha), later_chain(sha))


def describe_chain(chain: list[tuple[str, list[str]]]) -> str:
    """Pure: one line of evidence for the halt issue, newest first, e.g. `c3cf45d failure, 769fe65 no deployment`."""
    return ", ".join(f"{c[:7]} {'/'.join(s) if s else 'no deployment'}" for c, s in chain)


def build_chain(sha: str, depth: int = 8) -> list[tuple[str, list[str]]]:
    """[(sha, states)] from sha back through first parents, stopping after the first good build."""
    chain, cur = [], sha
    for _ in range(depth):
        states = production_states(cur)
        chain.append((cur, states))
        if build_state(states) == "good":
            break
        parent = gh("api", f"repos/{REPO}/commits/{cur}", "--jq", ".parents[0].sha", check=False).strip()
        if not parent:
            break
        cur = parent
    return chain


def post_merge(sha: str, drill: bool) -> int:
    head = master_sha()
    out = os.environ.get("GITHUB_OUTPUT")

    def emit(result: str, detail: str):
        note(f"post-merge {sha[:7]}: {result}: {detail}")
        if out:
            with open(out, "a", encoding="utf-8") as fh:
                fh.write(f"result={result}\nsha={sha}\ndetail={detail}\n")
    if drill:  # any commit on master, so a drill can target a harmless one while other merges keep landing
        emit("fail", "DRILL: failure injected to exercise rollback; nothing is actually broken")
        return 0
    if head != sha:
        emit("skipped", f"master moved on to {head[:7]}; that merge's own verification covers this one")
        return 0
    result, why = wait_production(sha)  # deploys do not wait for tests (scheduled-tests.yml runs them)
    if result == "fail":
        chain = build_chain(sha)
        culprit = culprit_of(chain)
        if culprit is None:
            result = "halt"
            why += (f"; the commit that broke it is not known ({describe_chain(chain)}), so nothing is reverted: "
                    "the train halts until someone reads the deployment logs")
        else:
            if culprit != sha:
                why += f"; the build was already broken by {culprit[:7]}, which is reverted instead"
                sha = culprit
            fixer = already_fixed(sha)
            if fixer:
                result = "skipped"
                why = (f"the build of {sha[:7]} failed, but {fixer[:7]}, which contains it, deployed to Production "
                       f"successfully: already fixed, nothing to revert")
    result, why = moved_on_verdict(result, why, sha, master_sha())
    emit(result, why)
    return 0


# ---------- rollback ----------
def rollback(sha: str, reason: str, halt_only: bool = False) -> int:
    ensure_labels()
    short = sha[:7]
    subject = subprocess.run(["git", "log", "-1", "--format=%s", sha], capture_output=True, text=True).stdout.strip()
    if halt_only:  # failure provenance unknown: halt and diagnose, never revert a change that is not proven bad
        gh("issue", "create", "-R", REPO, "--title", f"Release {short} failed verification: cause unknown, train halted",
           "--label", HALT, "--body",
           f"Post-merge verification failed for `{sha}` ({subject}).\n\n**Reason:** {reason}\n\n"
           f"No automatic revert: the deployment history does not show which commit broke the build (a merge "
           f"without a finished build, a canceled or errored deployment, or a deploy that never finished). Open the "
           f"failed deployment's Vercel log, then either revert the commit that broke it or, for a transient Vercel "
           f"error, redeploy. Close this issue to resume the merge train.", check=False)
        note(f"HALTED train without a revert for {short}: failure provenance unknown")
        return 1
    fixer = already_fixed(sha)  # the verify job can finish before a fix lands; this job runs later
    if fixer:
        note(f"no rollback for {short}: its failed build is fixed by {fixer[:7]}, which deployed successfully")
        return 0
    if halted() or subject.startswith("Revert"):  # never revert a revert or stack rollbacks: a person decides
        gh("issue", "create", "-R", REPO, "--title", f"Release {short} failed verification while halted or after a revert",
           "--label", HALT, "--body", f"`{sha}` ({subject}) failed verification: {reason}\n\nNo automatic revert was "
           f"attempted because the train is already halted or this commit is itself a revert. Decide by hand.", check=False)
        note(f"no automatic revert for {short}: already halted or a revert commit")
        return 1
    title = f"Release {short} failed verification: train halted"
    body = (f"Post-merge verification failed for `{sha}`.\n\n**Reason:** {reason}\n\n"
            f"The merge train is halted: no further PRs merge until this issue closes. "
            f"A revert PR is opened automatically; merging it closes this issue and resumes the train.")
    issue = json.loads(gh("api", f"repos/{REPO}/issues", "-f", f"title={title}", "-f", f"body={body}",
                          "-f", f"labels[]={HALT}"))["number"]
    note(f"HALTED train: issue #{issue}")
    branch = f"rollback/{short}"
    try:
        subprocess.run(["git", "config", "user.name", "github-actions[bot]"], check=True)
        subprocess.run(["git", "config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"], check=True)
        subprocess.run(["git", "checkout", "-b", branch, BASE], check=True)
        subprocess.run(["git", "revert", "--no-edit", sha], check=True)
        subprocess.run(["git", "push", "origin", branch], check=True)
    except subprocess.CalledProcessError as e:
        gh("issue", "comment", str(issue), "-R", REPO, "--body",
           f"Could not build the revert automatically ({e}). Revert `{sha}` by hand.", check=False)
        note("revert branch failed; issue carries the recovery steps")
        return 1
    try:
        url = gh("pr", "create", "-R", REPO, "--base", BASE, "--head", branch, "--title",
                 f"Revert {short}: failed post-merge verification", "--label", ROLLBACK, "--body",
                 f"Automatic rollback of `{sha}`.\n\nReason: {reason}\n\nCloses #{issue}").strip()
    except GhError as e:
        gh("issue", "comment", str(issue), "-R", REPO, "--body",
           f"Revert branch `{branch}` is pushed but the PR could not be opened: {e}\n\n"
           f"Open it from https://github.com/{REPO}/compare/{BASE}...{branch}?expand=1 (label `rollback`, body "
           f"`Closes #{issue}`). To let the workflow do this unattended, enable Settings > Actions > General > "
           f"'Allow GitHub Actions to create and approve pull requests'.", check=False)
        note(f"revert PR creation blocked ({e}); branch {branch} pushed, issue #{issue} has the steps")
        return 1
    note(f"OPENED rollback PR {url}")
    num = int(url.rstrip("/").rsplit("/", 1)[1])
    pr = next((p for p in open_prs() if p["number"] == num), None)
    if pr:
        dispatch_ci(pr)
    return 0


def ensure_labels() -> None:
    have = {l["name"] for l in api_items(f"repos/{REPO}/labels?per_page=100", ".[]|{name}")}
    for name, (color, desc) in LABELS.items():
        if name not in have:
            gh("api", f"repos/{REPO}/labels", "-f", f"name={name}", "-f", f"color={color}", "-f",
               f"description={desc}", check=False)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("train")
    t.add_argument("--dry-run", action="store_true")
    p = sub.add_parser("post-merge")
    p.add_argument("--sha", required=True)
    p.add_argument("--drill", action="store_true")
    r = sub.add_parser("rollback")
    r.add_argument("--sha", required=True)
    r.add_argument("--reason", required=True)
    r.add_argument("--halt-only", action="store_true", help="halt the train and file the issue, no revert")
    sub.add_parser("ensure-labels")
    a = ap.parse_args(argv)
    if a.cmd == "train":
        return run_train(a.dry_run)
    if a.cmd == "post-merge":
        return post_merge(a.sha, a.drill)
    if a.cmd == "rollback":
        return rollback(a.sha, a.reason, a.halt_only)
    ensure_labels()
    return 0


if __name__ == "__main__":
    sys.exit(main())
