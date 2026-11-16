#!/usr/bin/env python3
"""Onyx merge train, post-merge verification and rollback.

Runs in GitHub Actions from the default branch only, with the job's own GITHUB_TOKEN. It reads PR metadata through
the API and never checks out or executes PR code. GitHub branch protection (required checks, up-to-date branch,
enforced for admins) stays the final gate: this script only does the clicking a human or agent used to do.

    train [--dry-run]            merge what is green, bring the next PR up to date, one in flight at a time
    post-merge --sha SHA         wait for the Production deploy of SHA, print result=ok|fail|halt|skipped and the
                                 immutable deployment URL it found
    smoke-target --sha SHA       (smoke-test.yml) resolve the exact target: SHA must be on master, have a
             [--mode MODE]       successful Production deployment and (post-merge) not be superseded by a deployed
                                 newer head; scheduled: the newest deployed master commit; print ready, sha, URL
    smoke-verdict --sha SHA      (smoke-test.yml) pass | fail | deferred | unverified from the test outcome and the
             [--mode MODE]       revision production served before and after the run; writes the receipt. A
                                 scheduled run also fails when it could not test what production serves
    smoke-receipt --sha SHA      (post-merge.yml) record the attempts as the commit status post-merge/smoke and
                                 decide none | revert | halt, with the culprit read from the smoke receipts
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
from datetime import datetime

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
    # Only the local feature worker has the exact-head review/typecheck receipt. A ready PR can gain a new
    # head after that check, so ordinary CI cannot authorize this train to release a worker-owned branch.
    if pr["headRefName"].startswith("builder/"):
        return "skip", "builder branch: feature worker owns review, type check and merge"
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
    msg = (f"Not merged: the failure of `{target[:7]}` is already fixed by `{fixer[:7]}`, which contains it and "
           f"deployed to Production successfully (a failed build) or passed the smoke test on its own deployment (a "
           f"failed smoke test). Reverting now would take a working change off the site.")
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


def wait_production(sha: str, timeout: int = 900) -> tuple[str, str, str]:
    """-> (result, why, the immutable URL of the successful deployment or "")."""
    end = time.time() + timeout
    while time.time() < end:
        deps = production_deployments(sha)
        verdict = production_verdict([s for s, _ in deps], master_sha() != sha)
        if verdict:
            url = pick_deployment(deps, "", sha)[0] if verdict[0] == "ok" else None
            return verdict[0], verdict[1], url or ""
        time.sleep(20)
    return "fail", f"no successful Production deployment within {timeout // 60} min", ""


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


def production_deployments(sha: str) -> list[tuple[str, str]]:
    """[(latest state, environment_url)] of sha's Production deployments, newest first. environment_url is the
    deployment's own immutable address (Vercel posts it), never the production alias."""
    out = []
    for d in api_items(f"repos/{REPO}/deployments?sha={sha}&environment=Production&per_page=5", ".[]|{id}"):
        st = api_items(f"repos/{REPO}/deployments/{d['id']}/statuses?per_page=1",
                       ".[]|{state,environment_url:(.environment_url // \"\")}")
        out.append((st[0]["state"], st[0]["environment_url"]) if st else ("pending", ""))
    return out


def production_states(sha: str) -> list[str]:
    return [s for s, _ in production_deployments(sha)]


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
    """I/O wrapper of fixed_later and smoke_fixed_later: the newer master commit whose good build shows sha's failed
    build is fixed, or whose exact smoke pass shows sha's failed smoke test is fixed (DEL-02)."""
    later = later_chain(sha)
    own_states = production_states(sha)
    fixer = fixed_later(own_states, later)
    if fixer or build_state(own_states) == "failed":  # a failed build never reached the smoke test
        return fixer
    try:  # an unreadable receipt proves nothing: never let it stop a revert or a halt issue
        own = smoke_state(sha)
        if own != "fail":  # only then are the later receipts worth reading
            return None
        return smoke_fixed_later(own, [(c, smoke_state(c)) for c, _ in later])
    except GhError:
        return None


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
    deployment_url = ""

    def emit(result: str, detail: str):
        note(f"post-merge {sha[:7]}: {result}: {detail}" + (f" ({deployment_url})" if deployment_url else ""))
        # the smoke test receives sha + deployment_url and checks production serves exactly that (DEL-02)
        set_outputs(result=result, sha=sha, detail=detail, deployment_url=deployment_url if result == "ok" else "")
    if drill:  # any commit on master, so a drill can target a harmless one while other merges keep landing
        emit("fail", "DRILL: failure injected to exercise rollback; nothing is actually broken")
        return 0
    if head != sha:
        emit("skipped", f"master moved on to {head[:7]}; that merge's own verification covers this one")
        return 0
    result, why, deployment_url = wait_production(sha)  # deploys do not wait for tests (scheduled-tests.yml runs them)
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


def set_outputs(**values: str) -> None:
    """GitHub step outputs, one line each (a newline would start a new output)."""
    path = os.environ.get("GITHUB_OUTPUT")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as fh:
        for k, v in values.items():
            fh.write(f"{k}={' '.join(str(v or '').split())}\n")


# ---------- smoke provenance (DEL-02) ----------
# The smoke test loads the production ALIAS (generated deployment URLs sit behind Vercel's sign-in), which moves to
# every newer deployment. So a result counts for a commit only when production served exactly that commit and
# deployment before AND after the run, read from the signed-in /api/version (VERCEL_GIT_COMMIT_SHA + VERCEL_URL).
# Anything else is deferred (pending verification): never a pass, never a reason to revert that commit.
SMOKE_CONTEXT = "post-merge/smoke"  # commit status = the durable smoke receipt of a master commit
HEX40 = re.compile(r"[0-9a-f]{40}")
HOSTNAME = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+")
VERDICTS = ("pass", "fail", "deferred", "unverified")
FAILED = {"fail", "unverified"}  # verdicts that fail the smoke job (and so get the one retry)
MODES = ("post-merge", "scheduled")  # post-merge: bound to one commit + deployment; scheduled: what production serves
SCHEDULED_DEPTH = 8  # a scheduled run tests the newest deployed commit among this many master commits
# A smoke failure reverts a commit only when its parent passed this recently: the suite reads live data, so an older
# pass says less about whether the parent would still pass now (an ETL outage can empty a panel in between).
SMOKE_PARENT_MAX_AGE_S = 3 * 3600


def deployment_host(url: str | None) -> str | None:
    """Pure: the host of an https deployment address ("https://<host>" with at most a trailing slash), or None."""
    m = re.fullmatch(r"https://([^/?#:@\s]+)/?", (url or "").strip().lower())
    return m.group(1) if m and HOSTNAME.fullmatch(m.group(1)) else None


def on_master(compare_status: str) -> bool:
    """Pure: GitHub's compare status of `<sha>...master`. Only a merged commit may run with the smoke credentials."""
    return compare_status in ("ahead", "identical")


def pick_deployment(deps: list[tuple[str, str]], requested: str, sha: str) -> tuple[str | None, str]:
    """Pure: deps = [(latest state, environment_url)] newest first. -> (https URL of the successful Production
    deployment to smoke-test, why). A requested URL must be one of sha's own deployments and its latest status must be
    success. That does NOT prove the alias still serves it: Vercel's GitHub records keep a single `success` status
    even after a newer deployment replaced it (checked 2026-11-16), so superseded targets are refused by smoke_target
    (a deployed newer head) and by the provenance check, never by this state alone."""
    short = sha[:7]
    if requested:
        host = deployment_host(requested)
        if not host:
            return None, "the deployment URL is not an https deployment address"
        same = [s for s, u in deps if deployment_host(u) == host]
        if not same:
            return None, f"{host} is not a Production deployment of {short}"
        if same[0] != "success":
            return None, (f"the Production deployment {host} of {short} is {same[0]}, not success: it failed, was "
                          f"replaced or never finished")
        return f"https://{host}", f"successful Production deployment {host} of {short}"
    for state, url in deps:
        host = deployment_host(url)
        if state == "success" and host:
            return f"https://{host}", f"successful Production deployment {host} of {short}"
    return None, f"no successful Production deployment of {short}"


def provenance_record(raw) -> dict | None:
    """Pure: what one provenance file says production served, reduced to {version, deployment}; None when it proves
    nothing (missing, not an object, no 40-hex commit, or a malformed deployment host). A null deployment = a build
    that does not report one (older than this check): it is matched on the commit alone."""
    if not isinstance(raw, dict):
        return None
    version = raw.get("version")
    if not isinstance(version, str) or not HEX40.fullmatch(version):
        return None
    dep = raw.get("deployment")
    if dep is None or dep == "":
        return {"version": version, "deployment": None}
    if not isinstance(dep, str) or not HOSTNAME.fullmatch(dep.lower()):
        return None
    return {"version": version, "deployment": dep.lower()}


def served_label(rec: dict | None) -> str:
    if rec is None:
        return "not confirmed"
    return rec["version"][:7] + " on " + (rec["deployment"] or "a deployment it does not name")


def smoke_verdict(sha: str, host: str | None, tests_ok: bool, before: dict | None, after: dict | None,
                  exact_deployment: bool = True) -> tuple[str, str]:
    """Pure: (verdict, detail) of one smoke run against expected commit sha (+ deployment host).

    exact_deployment (post-merge runs, which attribute the result to sha): both records must name exactly `host`; a
    record that names no deployment counts as not confirmed, since two deployments of one commit (a redeploy, a
    Vercel rollback) could not be told apart. False (scheduled runs, which attribute nothing): the commit alone.

    pass / fail   = production served exactly that target before and after the run.
    deferred      = it served something else at either end (alias moved, a redeploy, a rollback in Vercel), or the
                    tests passed but the target was not confirmed: pending verification, never a pass.
    unverified    = the tests failed and the target was not confirmed: the failure is not attributed."""
    short = sha[:7]
    unconfirmed = []
    for phase, rec in (("before", before), ("after", after)):
        if rec is None:
            unconfirmed.append(phase)
            continue
        if rec["version"] != sha:
            return "deferred", f"production served {rec['version'][:7]} {phase} the run, not {short}"
        if not exact_deployment:
            continue
        if not host or not rec["deployment"]:
            unconfirmed.append(phase)
        elif rec["deployment"] != host:
            return "deferred", (f"production served another deployment of {short} ({rec['deployment']}) {phase} the "
                                f"run, not {host}")
    if unconfirmed:
        what = "served deployment" if exact_deployment else "served commit"
        missing = " and ".join(unconfirmed)
        if tests_ok:
            return "deferred", f"tests passed but the {what} was not confirmed {missing} the run: not a pass"
        return "unverified", f"tests failed and the {what} was not confirmed {missing} the run: not attributed to {short}"
    if exact_deployment:
        where = f"{host} serving {short}"
    else:
        where = f"production serving {short} (scheduled run: matched on the commit)"
    if tests_ok:
        return "pass", f"passed on {where} before and after the run"
    return "fail", f"failed on {where} before and after the run"


def served_other(sha: str, before: dict | None, after: dict | None) -> str | None:
    """Pure: the first other commit production served at either end of the run, or None."""
    return next((r["version"] for r in (before, after) if r and r["version"] != sha), None)


def smoke_exit(verdict: str, scheduled: bool, benign: bool) -> int:
    """Pure: the smoke job's exit code. fail and unverified always fail it. A scheduled run has no commit to attribute
    a deferral to, so a deferral fails it too unless it is benign (production moved on to a newer master commit, whose
    own post-merge verification covers it, or a newer run superseded this one): otherwise a Vercel rollback, a
    broken provenance read or a target that cannot be resolved would leave the 6-hourly tripwire green forever."""
    if verdict in FAILED:
        return 1
    if scheduled and verdict == "deferred" and not benign:
        return 1
    return 0


def attempt_verdict(verdict: str, result: str) -> str:
    """Pure: one smoke attempt from its job outputs. A cancelled or skipped job (superseded by a newer merge's smoke
    run, or never started) proves nothing; a job that failed before writing a verdict (install, runner) is
    unverified."""
    if result in ("cancelled", "skipped", ""):
        return "deferred"
    if verdict in VERDICTS:
        return verdict
    return "unverified"


def retry_verdict(verdict: str, result: str) -> str:
    """Pure: the retry, read only after a failed first attempt, so it must have run. A retry the workflow skipped or
    never started is unverified: a failure must never become "pending verification" just because the retry was not
    scheduled (a job `if` without a status function is skipped after a failed dependency). A cancelled retry was
    superseded by a newer run for the same commit: deferred, as for any attempt."""
    if result in ("skipped", ""):
        return "unverified"
    return attempt_verdict(verdict, result)


def smoke_outcome(first: str, retry: str) -> str:
    """Pure: pass | fail | pending | halt from the attempt verdicts. retry only counts after a failed first attempt.
    fail = BOTH attempts failed on the exact deployment; a failure next to an unconfirmed attempt halts without a
    revert; a deferred final attempt is pending verification."""
    final = retry if first in FAILED else first
    if final == "pass":
        return "pass"
    if final == "deferred":
        return "pending"
    if first == "fail" and retry == "fail":
        return "fail"
    return "halt"


def smoke_receipt_row(rows: list[dict]) -> dict | None:
    """Pure: rows = sha's commit statuses newest first. -> the newest exact smoke receipt (success / failure) the
    workflow's own token wrote. Pending rows are skipped: a later re-run that only reached "pending verification" does
    not erase an exact pass or fail recorded earlier. A status another account posted is ignored."""
    for r in rows:
        if (r.get("context") == SMOKE_CONTEXT and r.get("creator") in BOT_LOGINS
                and r.get("state") in ("success", "failure")):
            return r
    return None


def smoke_state_of(rows: list[dict]) -> str:
    """Pure: pass | fail | unknown from the newest exact smoke receipt (smoke_receipt_row)."""
    r = smoke_receipt_row(rows)
    return {"success": "pass", "failure": "fail"}[r["state"]] if r else "unknown"


def receipt_age_s(created_at: str | None, now: float) -> float | None:
    """Pure: seconds from a status's created_at (ISO 8601) to now, or None when it cannot be read."""
    try:
        return now - datetime.fromisoformat(str(created_at).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def smoke_culprit(sha: str, parent_state: str, parent_age_s: float | None) -> str | None:
    """Pure: the commit to revert after BOTH smoke attempts failed on sha's own deployment. Only sha itself, and only
    when its parent passed the smoke test on its own deployment within SMOKE_PARENT_MAX_AGE_S: then the change that
    broke it is sha. A parent that was never verified on its own deployment (superseded, deferred, unverified) may
    hold the breaking change, a parent that already failed was handled by its own verification, and an old pass does
    not rule out live data that changed since (the suite reads production data); all of these halt for a person."""
    if parent_state != "pass" or parent_age_s is None or parent_age_s > SMOKE_PARENT_MAX_AGE_S:
        return None
    return sha


def smoke_fixed_later(own_state: str, later: list[tuple[str, str]]) -> str | None:
    """Pure: a failed smoke test is already fixed when a newer master commit that contains it (later, newest first)
    passed the smoke test on its own deployment. Reverting then would take a working change off the site."""
    if own_state != "fail":
        return None
    return next((c for c, s in later if s == "pass"), None)


def smoke_status(outcome: str) -> str:
    """Pure: the commit status state that records an outcome. halt and pending are pending verification."""
    return {"pass": "success", "fail": "failure"}.get(outcome, "pending")


def smoke_receipt_of(sha: str) -> tuple[str, str]:
    """-> (pass | fail | unknown, created_at of that receipt or "")."""
    rows = api_items(f"repos/{REPO}/commits/{sha}/statuses?per_page=100",
                     ".[]|{context,state,created_at,creator:(.creator.login // \"\")}")
    r = smoke_receipt_row(rows)
    return smoke_state_of(rows), (r or {}).get("created_at") or ""


def smoke_state(sha: str) -> str:
    return smoke_receipt_of(sha)[0]


def annotate(level: str, title: str, msg: str) -> None:
    """A GitHub annotation on the run (warning / error), one line."""
    text = " ".join(str(msg).split()).replace("%", "%25")
    print(f"::{level} title={title}::{text}", flush=True)


def scheduled_target(start: str, depth: int = SCHEDULED_DEPTH) -> tuple[str | None, str, str]:
    """-> (URL, why, commit): the newest commit from start back through first parents that has a successful Production
    deployment, which is what production serves unless someone rolled it back in Vercel. A head that is still
    deploying, or whose build failed, falls back to its parent instead of leaving the run without a target."""
    cur, newer = start, []
    for _ in range(depth):
        url, why = pick_deployment(production_deployments(cur), "", cur)
        if url:
            if newer:
                why += f" (newer {', '.join(newer)} has no successful Production deployment yet)"
            return url, why, cur
        newer.append(cur[:7])
        cur = gh("api", f"repos/{REPO}/commits/{cur}", "--jq", ".parents[0].sha", check=False).strip()
        if not HEX40.fullmatch(cur):
            break
    return None, f"no successful Production deployment among the {len(newer)} newest {BASE} commits", start


def smoke_target(sha: str, requested: str, mode: str = "post-merge") -> int:
    """smoke-test.yml: resolve the target before any checkout or credential use. Never fails the job (the verdict
    step does). post-merge: exactly sha + its deployment, refused when a newer head already deployed (production no
    longer serves sha, so checking out and signing in would only produce a deferral). scheduled: the newest deployed
    master commit from sha (default: master head now), matched on the commit alone (no deployment pin)."""
    scheduled = mode == "scheduled"

    def done(ready: bool, detail: str, url: str = "") -> int:
        note(f"smoke target ({mode}) {sha[:7] if HEX40.fullmatch(sha or '') else sha!r}: "
             f"{'ready' if ready else 'deferred'}: {detail}")
        set_outputs(ready="true" if ready else "false", sha=sha if ready else "",
                    deployment_url="" if scheduled else url, detail=detail)
        return 0
    try:
        if scheduled and not sha:
            sha = master_sha()
        if not HEX40.fullmatch(sha or ""):
            return done(False, "the expected commit is not a 40-hex SHA")
        status = gh("api", f"repos/{REPO}/compare/{sha}...{BASE}", "--jq", ".status").strip()
        if not on_master(status):
            return done(False, f"{sha[:7]} is not a commit on {BASE} ({status or 'unknown'}): unmerged code never runs "
                               f"with the smoke credentials")
        if scheduled:
            url, why, sha = scheduled_target(sha)
            return done(bool(url), why, url or "")
        head = master_sha()
        if head != sha and pick_deployment(production_deployments(head), "", head)[0]:
            return done(False, f"superseded: {BASE} head {head[:7]} already has a successful Production deployment, "
                               f"so production no longer serves {sha[:7]}; that merge's own verification covers it")
        url, why = pick_deployment(production_deployments(sha), requested, sha)
    except GhError:
        return done(False, "could not read the commit or its deployment history")
    return done(bool(url), why, url or "")


def load_provenance(directory: str, phase: str) -> dict | None:
    try:
        with open(os.path.join(directory, f"{phase}.json"), encoding="utf-8") as fh:
            return provenance_record(json.load(fh))
    except (OSError, ValueError):
        return None


def newer_master_commit(sha: str, other: str) -> bool:
    """Whether `other` is a master commit that contains sha (production moved on to a newer merge)."""
    try:
        ahead = gh("api", f"repos/{REPO}/compare/{sha}...{other}", "--jq", ".status").strip()
        merged = gh("api", f"repos/{REPO}/compare/{other}...{BASE}", "--jq", ".status").strip()
    except GhError:
        return False
    return ahead == "ahead" and on_master(merged)


def smoke_verdict_cmd(sha: str, url: str, ready: bool, target_detail: str, tests: str, directory: str,
                      mode: str = "post-merge") -> int:
    """smoke-test.yml: the verdict and the receipt (job summary). Exit 1 = the smoke job fails (smoke_exit)."""
    scheduled = mode == "scheduled"
    host = deployment_host(url)
    before = load_provenance(directory, "before") if ready and directory else None
    after = load_provenance(directory, "after") if ready and directory else None
    benign = False
    if not ready:
        verdict, detail = "deferred", f"not run: {target_detail or 'no exact target'}"
    elif tests == "cancelled":
        verdict, detail, benign = "deferred", "cancelled: superseded by a newer smoke run", True
    else:
        verdict, detail = smoke_verdict(sha, host, tests == "success", before, after, exact_deployment=not scheduled)
    if verdict == "deferred" and not benign and ready:
        other = served_other(sha, before, after)
        if other and newer_master_commit(sha, other):
            benign = True
            detail += f"; production moved on to the newer {BASE} commit {other[:7]}, whose own verification covers it"
    code = smoke_exit(verdict, scheduled, benign)
    if verdict == "deferred":
        if code:
            detail += ("; a scheduled run must test what production serves: check for a Vercel rollback, a broken "
                       "/api/version or a deploy that failed")
            annotate("error", "Smoke target not confirmed", detail)
        else:
            annotate("warning", "Smoke deferred", detail)
    exact = verdict in ("pass", "fail")
    if exact and not scheduled and host:
        tested_deployment = f"https://{host}"
    elif exact and scheduled and before and after and before["deployment"] and before["deployment"] == after["deployment"]:
        tested_deployment = f"https://{before['deployment']}"
    else:
        tested_deployment = ""
    set_outputs(verdict=verdict, detail=detail, tested_sha=sha if exact else "", tested_deployment=tested_deployment)
    note("\n".join([
        f"### Smoke receipt ({mode})",
        f"- expected commit: `{sha or 'none'}`",
        f"- expected deployment: `{host or ('any deployment of the commit' if scheduled else 'none')}`",
        f"- production served before the run: {served_label(before)}",
        f"- production served after the run: {served_label(after)}",
        f"- tests: {tests or 'not run'}",
        f"- verdict: **{verdict}**{' (fails this scheduled run)' if verdict == 'deferred' and code else ''}: {detail}",
    ]))
    return code


def smoke_receipt(sha: str, url: str, verify: str, verify_detail: str, attempts: list[tuple[str, str, str]],
                  now: float | None = None) -> int:
    """post-merge.yml: record the smoke attempts on the commit and decide the action. attempts = [(verdict, job
    result, detail)] for the first run and the retry. Outputs action = none | revert | halt, culprit, reason, and
    only once the receipt is recorded: when it cannot be written (or sha cannot be checked against master) the job
    fails with no action, and post-merge.yml halts without a revert if the smoke test failed."""
    host = deployment_host(url) or "production"
    now = time.time() if now is None else now
    if not HEX40.fullmatch(sha or ""):
        set_outputs(action="none", culprit="", reason="", outcome="pending")
        note(f"smoke receipt: no commit to record ({sha!r})")
        return 0
    if verify != "ok":
        outcome, detail = "pending", f"not smoke-tested: {verify_detail or verify}"
    else:
        (v1, r1, d1), (v2, r2, d2) = attempts
        first = attempt_verdict(v1, r1)
        retry = retry_verdict(v2, r2) if first in FAILED else ""
        outcome = smoke_outcome(first, retry)
        detail = (d2 if first in FAILED else d1) or f"smoke job {r2 if first in FAILED else r1}"
    action, culprit, reason = "none", "", ""
    state = smoke_status(outcome)
    label = {"pass": "pass", "fail": "fail", "pending": "pending verification",
             "halt": "pending verification (failure not attributed)"}[outcome]
    try:
        # a receipt belongs on a master commit only: a dispatch with a PR head would put a pending status on that PR
        # and stall the merge train on it
        compare = gh("api", f"repos/{REPO}/compare/{sha}...{BASE}", "--jq", ".status").strip()
        if not on_master(compare):
            set_outputs(action="none", culprit="", reason="", outcome=outcome)
            note(f"smoke receipt {sha[:7]}: not a commit on {BASE} ({compare or 'unknown'}): nothing recorded")
            return 0
        if outcome == "fail":
            parent = gh("api", f"repos/{REPO}/commits/{sha}", "--jq", ".parents[0].sha", check=False).strip()
            known = bool(HEX40.fullmatch(parent))
            try:
                parent_state, parent_at = smoke_receipt_of(parent) if known else ("unknown", "")
            except GhError:  # an unreadable receipt proves nothing about the parent
                parent_state, parent_at = "unknown", ""
            age = receipt_age_s(parent_at, now) if parent_at else None
            culprit = smoke_culprit(sha, parent_state, age) or ""
            if culprit:
                action = "revert"
                reason = (f"production smoke test failed twice on {host} serving {sha[:7]} (its parent passed "
                          f"{int(age // 60)} min earlier)")
            else:
                action = "halt"
                when = f" from {parent_at}" if parent_at else ""
                reason = (f"production smoke test failed twice on {host} serving {sha[:7]}, but its parent "
                          f"{parent[:7] if known else '(unreadable)'} has smoke receipt '{parent_state}'{when} (a "
                          f"revert needs a pass within {SMOKE_PARENT_MAX_AGE_S // 3600} h), so the breaking commit "
                          f"is not known: nothing is reverted")
        elif outcome == "halt":
            action = "halt"
            reason = f"production smoke test failed but the failure is not attributed to {sha[:7]}: {detail}"
        try:
            existing = smoke_state(sha) if state == "pending" else "unknown"
        except GhError:
            existing = "unknown"
        if existing in ("pass", "fail"):
            note(f"smoke receipt {sha[:7]}: this run is {label}; the earlier exact receipt ({existing}) stands")
        else:
            run = (f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/{REPO}/actions/runs/"
                   f"{os.environ.get('GITHUB_RUN_ID', '')}")
            gh("api", "-X", "POST", f"repos/{REPO}/statuses/{sha}", "-f", f"state={state}",
               "-f", f"context={SMOKE_CONTEXT}", "-f", f"description={(label + ': ' + detail)[:140]}",
               "-f", f"target_url={run}")
    except GhError as e:
        note(f"smoke receipt {sha[:7]}: could not record the receipt ({e}); no action published, so a failed smoke "
             f"test halts the train without a revert")
        return 1
    set_outputs(action=action, culprit=culprit, reason=reason, outcome=outcome)
    note(f"smoke receipt {sha[:7]}: {state} ({label}): {detail}; action {action}" + (f" {culprit[:7]}" if culprit else ""))
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
           f"No automatic revert: the evidence does not show which commit broke the release. For a build: a merge "
           f"without a finished build, a canceled or errored deployment, or a deploy that never finished. For the "
           f"smoke test: a failure on a deployment whose served revision was not confirmed, or whose parent was never "
           f"smoke-tested on its own deployment or passed too long ago to rule out changed live data (see its "
           f"`{SMOKE_CONTEXT}` commit status). Open the failed run or "
           f"deployment log, then either revert the commit that broke it or, for a transient error, redeploy or "
           f"re-run. Close this issue to resume the merge train.", check=False)
        note(f"HALTED train without a revert for {short}: failure provenance unknown")
        return 1
    fixer = already_fixed(sha)  # the verify job can finish before a fix lands; this job runs later
    if fixer:
        note(f"no rollback for {short}: its failure is fixed by {fixer[:7]}, which contains it and deployed "
             f"successfully (or passed the smoke test on its own deployment)")
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
    st = sub.add_parser("smoke-target")
    st.add_argument("--sha", required=True, help="the commit; empty in scheduled mode = master head now")
    st.add_argument("--deployment-url", default="")
    st.add_argument("--mode", choices=MODES, default="post-merge")
    sv = sub.add_parser("smoke-verdict")
    sv.add_argument("--sha", default="")
    sv.add_argument("--deployment-url", default="")
    sv.add_argument("--ready", default="false")
    sv.add_argument("--target-detail", default="")
    sv.add_argument("--tests", default="")
    sv.add_argument("--provenance-dir", default="")
    sv.add_argument("--mode", choices=MODES, default="post-merge")
    sr = sub.add_parser("smoke-receipt")
    sr.add_argument("--sha", required=True)
    sr.add_argument("--deployment-url", default="")
    sr.add_argument("--verify", default="")
    sr.add_argument("--verify-detail", default="")
    for n in ("first", "retry"):
        sr.add_argument(f"--{n}", default="")
        sr.add_argument(f"--{n}-result", default="")
        sr.add_argument(f"--{n}-detail", default="")
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
    if a.cmd == "smoke-target":
        return smoke_target(a.sha, a.deployment_url, a.mode)
    if a.cmd == "smoke-verdict":
        return smoke_verdict_cmd(a.sha, a.deployment_url, a.ready == "true", a.target_detail, a.tests, a.provenance_dir,
                                 a.mode)
    if a.cmd == "smoke-receipt":
        return smoke_receipt(a.sha, a.deployment_url, a.verify, a.verify_detail,
                             [(a.first, a.first_result, a.first_detail), (a.retry, a.retry_result, a.retry_detail)])
    if a.cmd == "rollback":
        return rollback(a.sha, a.reason, a.halt_only)
    ensure_labels()
    return 0


if __name__ == "__main__":
    sys.exit(main())
