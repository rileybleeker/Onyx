"""Onyx-only, exact-head merge guard. No scheduling or credentials are created.

Trusted orchestrators supply an independently obtained two-agent review receipt.
A receipt is evidence, not an authentication mechanism; never accept one from PR
content. The default is a read-only preflight. --execute performs one merge.
"""
from __future__ import annotations
import argparse
import json
import re
import subprocess
from pathlib import Path

REPO = 'rileybleeker/Onyx'
NODE_ID = 'R_kgDORt_8EQ'
REQUIRED = {'offline-checks', 'frontend-types'}
SHA = re.compile(r'[0-9a-f]{40}')
# Start with a narrow component-path allowlist. The agent reviews must still
# establish presentation-only semantics; path checks cannot prove data safety.
ALLOWED = ('frontend/src/components/',)
BLOCKED = ('auth', 'supabase', 'chat', 'token', 'login', 'middleware')


def problems(pr, checks, review, base, repo):
    errors = []
    head = pr.get('headRefOid', '')
    if repo.get('id') != NODE_ID or repo.get('nameWithOwner') != REPO:
        errors.append('repository identity mismatch')
    if pr.get('state') != 'OPEN' or pr.get('isDraft'):
        errors.append('PR is not open and ready')
    if pr.get('baseRefName') != 'master' or pr.get('isCrossRepository'):
        errors.append('wrong base or fork PR')
    if not SHA.fullmatch(head):
        errors.append('invalid head SHA')
    if pr.get('mergeable') != 'MERGEABLE' or pr.get('mergeStateStatus') != 'CLEAN':
        errors.append('merge state is not clean')
    if review.get('head_sha') != head or review.get('base_sha') != base:
        errors.append('review is stale')
    verdicts = review.get('reviews', [])
    if not isinstance(verdicts, list) or len(verdicts) != 2:
        errors.append('need author validation and a separate agent review')
    elif {v.get('agent') for v in verdicts} != {'codex', 'claude'} or any(
        v.get('verdict') != 'pass' or v.get('unresolved_findings') != []
        for v in verdicts
    ):
        errors.append('both Codex and Claude must pass with no unresolved findings')
    if review.get('author') not in ('codex', 'claude'):
        errors.append('missing author identity')
    files = pr.get('files', [])
    if not files or len(files) > 20:
        errors.append('empty or oversized change')
    for f in files:
        path = f.get('path', '')
        if not path.startswith(ALLOWED) or not path.endswith(('.tsx', '.css')) or any(word in path.lower() for word in BLOCKED):
            errors.append('outside presentation-only scope: ' + path)
        if f.get('previous_filename') or f.get('status') not in ('added', 'modified', 'removed'):
            errors.append('renames require a separate reviewed change')
    names = {c.get('name') for c in checks if c.get('app_id') == 15368 and c.get('head_sha') == head}
    if not REQUIRED <= names:
        errors.append('required CI is missing')
    if not checks or any(c.get('state') != 'SUCCESS' or c.get('head_sha') != head for c in checks):
        errors.append('all reported checks must succeed (no skipped or neutral checks)')
    return errors


def run(*args):
    return subprocess.check_output(args, text=True, timeout=90).strip()


def inspect(number, review):
    pr = json.loads(run('gh', 'pr', 'view', str(number), '-R', REPO, '--json',
        'state,isDraft,baseRefName,headRefOid,isCrossRepository,mergeable,mergeStateStatus'))
    repo = json.loads(run('gh', 'repo', 'view', REPO, '--json', 'id,nameWithOwner'))
    base = run('gh', 'api', f'repos/{REPO}/git/ref/heads/master', '--jq', '.object.sha')
    head = pr.get('headRefOid', '')
    if not SHA.fullmatch(head) or not SHA.fullmatch(base):
        raise SystemExit('Invalid head/base SHA')
    comparison = json.loads(run('gh', 'api', f'repos/{REPO}/compare/{base}...{head}'))
    # The compare endpoint includes old names; never use gh pr view's lossy files.
    pr['files'] = [dict(f, path=f.get('filename', '')) for f in comparison.get('files', [])]
    runs = json.loads(run('gh', 'api', '--paginate', '--slurp',
        f'repos/{REPO}/commits/{head}/check-runs?per_page=100'))
    checks = [dict(name=c.get('name'), head_sha=c.get('head_sha'),
        app_id=(c.get('app') or {}).get('id'),
        state='SUCCESS' if c.get('status') == 'completed' and c.get('conclusion') == 'success' else 'BLOCKED')
        for page in runs for c in page.get('check_runs', [])]
    statuses = json.loads(run('gh', 'api', f'repos/{REPO}/commits/{head}/status'))
    errors = problems(pr, checks, review, base, repo)
    if statuses.get('total_count', 0) and statuses.get('state') != 'success':
        errors.append('commit statuses have not all succeeded')
    protection = json.loads(run('gh', 'api', f'repos/{REPO}/branches/master/protection'))
    required = protection.get('required_status_checks') or {}
    pinned = {c.get('context') for c in required.get('checks', []) if c.get('app_id') == 15368}
    if not required.get('strict') or not REQUIRED <= pinned:
        errors.append('GitHub must require up-to-date branches and both GitHub Actions checks')
    if not (protection.get('enforce_admins') or {}).get('enabled'):
        errors.append('GitHub checks must also apply to administrators')
    if comparison.get('status') not in ('ahead', 'identical'):
        errors.append('branch must include current master')
    return pr, errors

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pr', type=int)
    parser.add_argument('--review', required=True, type=Path)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    if args.pr <= 0:
        parser.error('PR must be positive')
    review = json.loads(args.review.read_text(encoding='utf-8-sig'))
    pr, errors = inspect(args.pr, review)
    if errors:
        raise SystemExit('\n'.join(errors))
    if not args.execute:
        print(json.dumps({'status': 'eligible', 'pr': args.pr, 'head': pr['headRefOid']}))
        return
    # Recheck immediately before the exact-head merge. No --admin, no bypass.
    fresh, errors = inspect(args.pr, review)
    if errors or fresh['headRefOid'] != pr['headRefOid']:
        raise SystemExit('PR changed during validation: ' + '; '.join(errors))
    try:
        run('gh', 'pr', 'merge', str(args.pr), '-R', REPO, '--squash',
            '--match-head-commit', pr['headRefOid'])
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        raise SystemExit('merge outcome unconfirmed; inspect before retrying') from exc
    receipt = json.loads(run('gh', 'pr', 'view', str(args.pr), '-R', REPO,
        '--json', 'state,mergeCommit,url'))
    if receipt.get('state') != 'MERGED' or not receipt.get('mergeCommit'):
        raise SystemExit('merge outcome unconfirmed; inspect before retrying')
    commit = json.loads(run('gh', 'api', f'repos/{REPO}/git/commits/{receipt["mergeCommit"]["oid"]}'))
    source = json.loads(run('gh', 'api', f'repos/{REPO}/git/commits/{pr["headRefOid"]}'))
    if [p.get('sha') for p in commit.get('parents', [])] != [review['base_sha']] or commit['tree']['sha'] != source['tree']['sha']:
        raise SystemExit('MERGED but base/tree verification failed; stop the lane and inspect ' + receipt['url'])
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
