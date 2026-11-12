#!/usr/bin/env python3
"""Integration planner for parallel git worktrees. Advisory and read-only.

Answers, before anyone merges: which in-flight branches conflict with master,
which pairs of branches conflict with each other, which ones can merge in any
order, and which ones have to wait for another one and then rebase.

How conflicts are detected (no checkout, no working-tree or index writes):

* branch vs base: `git merge-tree --write-tree base ref` (git >= 2.38). This is
  the same three-way merge GitHub runs for its mergeable/DIRTY flag.
* pair A, B: build the tree "base + A" (merge-tree), turn it into a synthetic
  commit (parents: base, A), then `git merge-tree --write-tree <base+A> B`. The
  merge base git picks is then B's own fork point, so the result is exactly what
  merging B after A has landed would do, even when A and B forked from
  different master commits. A direct `merge-tree A B` is NOT used: it would
  mix whatever master changed between the two fork points into the verdict.
  Conflicts that B already has against master alone are subtracted, so the
  pair verdict only reports collisions caused by A. Conflicts are symmetric, so
  one direction is tested: the one whose first element merges cleanly into base.
* every object merge-tree/commit-tree writes goes to a throwaway object
  directory (the real object store is only read), so running this never changes
  the repository.

Pairs with disjoint file sets are `independent`: they cannot textually conflict
(directory renames and semantic conflicts are not detected).

Ordering rule for a conflicting pair (who merges first): green CI first (needs
--checks), then the smaller diff (lines changed, then files), then the older
PR. Two tiers sit above that because they decide who *can* go first: a PR that
is a draft or carries the `hold` label sorts last (it cannot merge yet), and a
branch that already conflicts with base sorts after clean ones (it needs a
rebase anyway, so it should rebase once, after the others).

Exit code is 0 unless the arguments are wrong (2); --fail-on-conflict makes it
1 when any ref conflicts with base or with another ref. Nothing is ever deleted.
"""
import argparse
import concurrent.futures as cf
import dataclasses
import datetime as dt
import fnmatch
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from collections import Counter, defaultdict
from typing import Optional

DEFAULT_BASE = 'origin/master'
MAX_REFS = 30
HOT_THRESHOLD = 3
HOLD_LABELS = frozenset({'hold'})
GIT_TIMEOUT = 120
GH_TIMEOUT = 90
IGNORED_CHECKS = ('vercel',)  # deployment-preview statuses that stay pending and say nothing about the code
CI_RANK = {'pass': 0, 'pending': 1, 'unknown': 1, 'fail': 2}
ORDER_RULE = ('draft/hold last, then conflicts-with-base last, then green CI first, '
              'then smaller diff (lines, files), then older PR')
IDENT = {'GIT_AUTHOR_NAME': 'integration-plan', 'GIT_AUTHOR_EMAIL': 'integration-plan@localhost',
         'GIT_COMMITTER_NAME': 'integration-plan', 'GIT_COMMITTER_EMAIL': 'integration-plan@localhost',
         'GIT_AUTHOR_DATE': '2000-01-01T00:00:00Z', 'GIT_COMMITTER_DATE': '2000-01-01T00:00:00Z'}


class ToolError(Exception):
    """Usage-level problem (bad repo, bad base, git missing): exit code 2."""


# --------------------------------------------------------------------------- process helpers

def _run(cmd, cwd=None, env=None, timeout=GIT_TIMEOUT):
    try:
        return subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, encoding='utf-8',
                              errors='replace', timeout=timeout, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(cmd, 124, '', 'timed out')
    except (FileNotFoundError, NotADirectoryError):
        return subprocess.CompletedProcess(cmd, 127, '', f'{cmd[0]} or the working directory was not found')


def pmap(fn, items, jobs):
    items = list(items)
    if jobs <= 1 or len(items) <= 1:
        return [fn(i) for i in items]
    with cf.ThreadPoolExecutor(max_workers=jobs) as pool:
        return list(pool.map(fn, items))


def _rmtree(path):
    def onerror(func, p, _exc):
        try:
            os.chmod(p, stat.S_IWRITE)
            func(p)
        except OSError:
            pass
    shutil.rmtree(path, onerror=onerror)


class MergeOutcome:
    """Parsed `git merge-tree --write-tree --name-only -z` result."""

    def __init__(self, state, tree='', files=None, detail=''):
        self.state = state  # clean | conflict | error
        self.tree = tree
        self.files = files or []
        self.detail = detail


def parse_merge_tree(returncode, stdout, stderr=''):
    """Output with -z is `<tree>\\0<file>\\0<file>\\0\\0<messages>`; rc 0 clean, 1 conflicts."""
    if returncode not in (0, 1):
        return MergeOutcome('error', detail=(stderr.strip().splitlines() or ['merge-tree failed'])[0])
    parts = stdout.split('\0')
    tree = parts[0].strip()
    if not re.fullmatch(r'[0-9a-f]{40,64}', tree):
        return MergeOutcome('error', detail='unexpected merge-tree output')
    files = []
    for p in parts[1:]:
        if p == '':
            break
        files.append(p)
    return MergeOutcome('clean' if returncode == 0 else 'conflict', tree, sorted(set(files)))


class Git:
    def __init__(self, repo):
        self.repo = os.path.abspath(repo)
        self.env = dict(os.environ, GIT_OPTIONAL_LOCKS='0', GIT_TERMINAL_PROMPT='0')
        for k in ('GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'):
            self.env.pop(k, None)
        self.qdir = None
        self.qenv = None
        self.merge_tree_ok = False

    def run(self, *args, cwd=None, quarantine=False):
        env = self.env
        if quarantine:
            env = self.qenv or dict(self.env, **IDENT)
        return _run(['git', *args], cwd=cwd or self.repo, env=env)

    def out(self, *args, cwd=None):
        r = self.run(*args, cwd=cwd)
        return r.stdout.strip() if r.returncode == 0 else ''

    def enable_quarantine(self, probe_sha):
        """Send object writes to a temp dir; the real object store stays read-only (alternates)."""
        r = self.run('rev-parse', '--git-path', 'objects')
        if r.returncode != 0 or not r.stdout.strip():
            return False
        real = os.path.abspath(os.path.join(self.repo, r.stdout.strip()))
        tmp = tempfile.mkdtemp(prefix='integration-plan-')
        env = dict(self.env, **IDENT)
        env['GIT_OBJECT_DIRECTORY'] = tmp
        prev = self.env.get('GIT_ALTERNATE_OBJECT_DIRECTORIES')
        env['GIT_ALTERNATE_OBJECT_DIRECTORIES'] = real + (os.pathsep + prev if prev else '')
        self.qdir, self.qenv = tmp, env
        if self.run('cat-file', '-e', probe_sha + '^{commit}', quarantine=True).returncode != 0:
            self.close()
            return False
        return True

    def close(self):
        if self.qdir:
            _rmtree(self.qdir)
        self.qdir = self.qenv = None

    def probe_merge_tree(self, sha):
        self.merge_tree_ok = self.merge_tree(sha, sha).state == 'clean'
        return self.merge_tree_ok

    def merge_tree(self, a, b):
        r = self.run('merge-tree', '--write-tree', '--name-only', '-z', a, b, quarantine=True)
        return parse_merge_tree(r.returncode, r.stdout, r.stderr)

    def synthetic_merge_commit(self, tree, base_sha, ref_sha):
        r = self.run('commit-tree', tree, '-p', base_sha, '-p', ref_sha, '-m', 'integration-plan synthetic merge',
                     quarantine=True)
        return r.stdout.strip() if r.returncode == 0 else ''

    def is_ancestor(self, a, b):
        return self.run('merge-base', '--is-ancestor', a, b).returncode == 0


# --------------------------------------------------------------------------- data model

@dataclasses.dataclass
class RefInfo:
    name: str
    label: str
    sha: str = ''
    pr: Optional[dict] = None
    ahead: int = 0
    behind: int = 0
    files: list = dataclasses.field(default_factory=list)
    lines: int = 0
    tip_ts: int = 0
    base_status: str = 'unknown'  # clean | conflicts | no-changes | unknown
    base_conflicts: list = dataclasses.field(default_factory=list)
    detail: str = ''
    warn: str = ''
    ci: str = 'unknown'
    conflicts_with: list = dataclasses.field(default_factory=list)
    stacked_with: list = dataclasses.field(default_factory=list)
    base_tree: str = ''
    merged_commit: str = ''

    @property
    def number(self):
        return (self.pr or {}).get('number')

    @property
    def held(self):
        pr = self.pr or {}
        return bool(pr.get('draft')) or bool(HOLD_LABELS & set(pr.get('labels') or []))

    @property
    def created_ts(self):
        return parse_ts((self.pr or {}).get('created_at')) or self.tip_ts

    def status(self):
        if self.base_status == 'no-changes':
            return 'no-changes'
        if self.base_status == 'unknown':
            return 'unknown'
        if self.base_status == 'conflicts':
            return 'conflicts-with-base'
        return 'conflicts-with' if self.conflicts_with else 'clean'

    def status_text(self):
        s = self.status()
        if s == 'unknown':
            return 'unknown: ' + (self.detail or 'not analysed')
        if s == 'no-changes':
            return self.detail or 'no changes vs base'
        extra = ('conflicts-with:' + ','.join(self.conflicts_with)) if self.conflicts_with else ''
        if s == 'conflicts-with-base':
            return 'conflicts-with-base' + (' + ' + extra if extra else '')
        return extra or 'clean'

    def to_dict(self):
        return {'ref': self.name, 'label': self.label, 'sha': self.sha, 'pr': self.pr,
                'status': self.status(), 'conflicts_with': self.conflicts_with, 'stacked_with': self.stacked_with,
                'base_conflict_files': self.base_conflicts, 'detail': self.detail,
                'ahead': self.ahead, 'behind': self.behind, 'files': self.files, 'lines_changed': self.lines,
                'ci': self.ci, 'held': self.held, 'tip_time': self.tip_ts}


@dataclasses.dataclass
class Pair:
    first: str
    second: str
    shared: list
    status: str  # conflict | ok | stacked | unknown
    files: list = dataclasses.field(default_factory=list)
    detail: str = ''
    second_action: str = ''
    approx: bool = False

    def to_dict(self):
        return dataclasses.asdict(self)


def parse_ts(value):
    if not value:
        return 0
    try:
        return int(dt.datetime.fromisoformat(str(value).replace('Z', '+00:00')).timestamp())
    except ValueError:
        return 0


def short_name(name):
    return re.sub(r'^(refs/(heads|remotes)/)?(origin/)?', '', name)


def order_key(r):
    """Sort key deciding who merges first in a conflicting pair (smaller = earlier)."""
    return (1 if r.held else 0, 1 if r.base_status == 'conflicts' else 0, CI_RANK.get(r.ci, 1),
            r.lines, len(r.files), r.created_ts, r.number or 10 ** 9, r.name)


def fmt_age(seconds):
    s = max(0, int(seconds))
    for unit, size in (('d', 86400), ('h', 3600), ('m', 60)):
        if s >= size:
            return f'{s // size}{unit}'
    return f'{s}s'


# --------------------------------------------------------------------------- gh (optional)

def _gh_json(args, cwd):
    if not shutil.which('gh'):
        return None, 'gh is not installed'
    r = _run(['gh', *args], cwd=cwd, timeout=GH_TIMEOUT)
    try:
        return json.loads(r.stdout), ''
    except ValueError:
        return None, (r.stderr.strip().splitlines() or [f'gh exited {r.returncode}'])[0]


def normalize_pr(p):
    return {'number': p.get('number'), 'head': p.get('headRefName', ''), 'draft': bool(p.get('isDraft')),
            'labels': sorted(l.get('name', '') for l in p.get('labels') or []), 'title': p.get('title', ''),
            'updated_at': p.get('updatedAt'), 'created_at': p.get('createdAt'), 'head_oid': p.get('headRefOid'),
            'base': p.get('baseRefName'), 'cross_repo': bool(p.get('isCrossRepository'))}


def load_open_prs(cwd):
    fields = 'number,headRefName,isDraft,labels,updatedAt,createdAt,title,headRefOid,baseRefName,isCrossRepository'
    data, err = _gh_json(['pr', 'list', '--state', 'open', '--limit', '200', '--json', fields], cwd)
    return ([normalize_pr(p) for p in data], '') if isinstance(data, list) else (None, err)


def summarize_checks(data, ignore=IGNORED_CHECKS):
    """pass / fail / pending / unknown from `gh pr checks --json bucket,name` rows."""
    rows = [c for c in data if not any(str(c.get('name', '')).lower().startswith(i.lower()) for i in ignore)]
    if not rows:
        return 'unknown'
    buckets = {c.get('bucket') for c in rows}
    if buckets & {'fail', 'cancel'}:
        return 'fail'
    return 'pending' if 'pending' in buckets else 'pass'


def load_checks(cwd, number, ignore=IGNORED_CHECKS):
    """gh exits non-zero for failing/pending checks, so parse stdout rather than trusting the exit code."""
    data, _ = _gh_json(['pr', 'checks', str(number), '--json', 'bucket,state,name'], cwd)
    return summarize_checks(data, ignore) if isinstance(data, list) else 'unknown'


# --------------------------------------------------------------------------- per-ref analysis

def parse_numstat(out):
    files, lines = set(), 0
    for entry in out.split('\0'):
        parts = entry.split('\t', 2)
        if len(parts) != 3:
            continue
        added, deleted, path = parts
        files.add(path)
        lines += int(added) + int(deleted) if added.isdigit() and deleted.isdigit() else 1
    return sorted(files), lines


def analyze_ref(git, base_sha, spec):
    name, pr, label = spec
    ref = RefInfo(name=name, label=label, pr=pr)
    r = git.run('rev-parse', '--verify', '--quiet', name + '^{commit}')
    if r.returncode != 0:
        ref.detail = 'ref not found (git fetch?)'
        return ref
    ref.sha = r.stdout.strip()
    if pr and pr.get('head_oid') and pr['head_oid'] != ref.sha:
        ref.warn = f"local {name} differs from the PR head {pr['head_oid'][:7]} (run with --fetch)"
    ref.tip_ts = int(git.out('log', '-1', '--format=%ct', ref.sha) or 0)
    counts = git.out('rev-list', '--left-right', '--count', f'{base_sha}...{ref.sha}').split()
    if len(counts) == 2:
        ref.behind, ref.ahead = int(counts[0]), int(counts[1])
    if ref.ahead == 0 and counts:
        ref.base_status = 'no-changes'
        return ref
    if git.run('merge-base', base_sha, ref.sha).returncode != 0:
        ref.detail = 'no common ancestor with base'
        return ref
    d = git.run('diff', '--numstat', '-z', '--no-renames', f'{base_sha}...{ref.sha}')
    if d.returncode == 0:
        ref.files, ref.lines = parse_numstat(d.stdout)
    if not git.merge_tree_ok:
        ref.detail = 'git merge-tree --write-tree unavailable (needs git >= 2.38)'
        return ref
    mt = git.merge_tree(base_sha, ref.sha)
    if mt.state == 'error':
        ref.detail = mt.detail
    elif mt.state == 'clean' and mt.tree == git.out('rev-parse', base_sha + '^{tree}'):
        # Merging it changes nothing: the work is already in base (typically squash-merged under another sha).
        ref.base_status, ref.detail = 'no-changes', 'already integrated (merging it would change nothing)'
    elif mt.state == 'clean':
        ref.base_status, ref.base_tree = 'clean', mt.tree
    else:
        ref.base_status, ref.base_conflicts = 'conflicts', mt.files
    return ref


# --------------------------------------------------------------------------- pairs

def second_action(status, first, files, approx=False):
    tag = ' [approximate: both conflict with master, re-run after rebasing]' if approx else ''
    if status == 'conflict':
        more = ' ...' if len(files) > 5 else ''
        return f'rebase onto master after {first} merges (conflicts in: {", ".join(files[:5])}{more}){tag}'
    if status == 'stacked':
        return f'rebase onto master after {first} merges (this branch contains its commits)'
    if status == 'ok':
        return 'no action, auto-resolves' + tag
    return 'unknown: rebase one onto master and re-run'


def analyze_pairs(git, base_sha, refs, jobs):
    cands = []
    refs = [r for r in refs if r.base_status != 'no-changes']
    for i, a in enumerate(refs):
        for b in refs[i + 1:]:
            shared = sorted(set(a.files) & set(b.files))
            if shared:
                first, second = (a, b) if order_key(a) <= order_key(b) else (b, a)
                cands.append((first, second, shared))
    # Build "base + X" synthetic commits once per ref that will be the first element of a test.
    testers = {}
    for first, second, _ in cands:
        for x in (first, second):
            if x.base_status == 'clean' and not x.merged_commit:
                testers[x.label] = x

    def build(x):
        x.merged_commit = git.synthetic_merge_commit(x.base_tree, base_sha, x.sha)
    pmap(build, list(testers.values()), jobs)

    def test(c):
        first, second, shared = c
        if git.is_ancestor(first.sha, second.sha) or git.is_ancestor(second.sha, first.sha):
            # Stacked branches: the ancestor merges first, whatever the ordering rule says.
            lower, upper = (first, second) if git.is_ancestor(first.sha, second.sha) else (second, first)
            return Pair(lower.label, upper.label, shared, 'stacked', detail=f'{upper.label} contains {lower.label}',
                        second_action=second_action('stacked', lower.label, shared))
        if not git.merge_tree_ok:
            return Pair(first.label, second.label, shared, 'unknown', detail='merge-tree unavailable (git >= 2.38)',
                        second_action=second_action('unknown', first.label, shared))
        tester, other = (first, second) if first.base_status == 'clean' else (second, first)
        if tester.base_status != 'clean' or not tester.merged_commit:
            if first.base_status == 'conflicts' and second.base_status == 'conflicts':
                # Neither can be placed on master, so compare the two heads directly. Master's drift between
                # their fork points can leak into this verdict, hence the `approx` flag.
                mt = git.merge_tree(first.sha, second.sha)
                if mt.state != 'error':
                    status = 'conflict' if mt.state == 'conflict' else 'ok'
                    return Pair(first.label, second.label, shared, status, mt.files if status == 'conflict' else [],
                                detail='both conflict with base: tested head against head', approx=True,
                                second_action=second_action(status, first.label, mt.files or shared, approx=True))
            why = 'both conflict with base' if other.base_status == 'conflicts' else 'a ref could not be analysed'
            return Pair(first.label, second.label, shared, 'unknown', detail=why,
                        second_action=second_action('unknown', first.label, shared))
        mt = git.merge_tree(tester.merged_commit, other.sha)
        if mt.state == 'error':
            return Pair(first.label, second.label, shared, 'unknown', detail=mt.detail,
                        second_action=second_action('unknown', first.label, shared))
        extra = [f for f in mt.files if f not in other.base_conflicts]
        if mt.state == 'conflict' and extra:
            return Pair(first.label, second.label, shared, 'conflict', extra,
                        second_action=second_action('conflict', first.label, extra))
        detail = 'only files that already conflict with base' if mt.state == 'conflict' else ''
        return Pair(first.label, second.label, shared, 'ok', detail=detail,
                    second_action=second_action('ok', first.label, shared))

    pairs = pmap(test, cands, jobs)
    by_label = {r.label: r for r in refs}
    for p in pairs:
        a, b = by_label[p.first], by_label[p.second]
        if p.status == 'conflict':
            a.conflicts_with.append(b.label)
            b.conflicts_with.append(a.label)
        elif p.status == 'stacked':
            a.stacked_with.append(b.label)
            b.stacked_with.append(a.label)
    return pairs


# --------------------------------------------------------------------------- plan

def linear_order(refs, edges):
    key = {r.label: order_key(r) for r in refs}
    indeg = dict.fromkeys(key, 0)
    succ = defaultdict(list)
    for u, v in edges:
        succ[u].append(v)
        indeg[v] += 1
    remaining, order, broken = set(key), [], []
    while remaining:
        ready = [l for l in remaining if indeg[l] == 0]
        if not ready:
            ready = [min(remaining, key=key.get)]
            broken.append(ready[0])
        n = min(ready, key=key.get)
        order.append(n)
        remaining.discard(n)
        for v in succ[n]:
            indeg[v] -= 1
    return order, broken


def build_plan(refs, pairs):
    by_label = {r.label: r for r in refs}
    analysed = [r for r in refs if r.base_status != 'no-changes']
    pair_edges = [p for p in pairs if p.status in ('conflict', 'stacked')]
    edges = [(p.first, p.second) for p in pair_edges]
    order, broken = linear_order(analysed, edges)
    pos = {l: i for i, l in enumerate(order)}
    deps, dep_pair = defaultdict(set), {}
    for p in pair_edges:
        u, v = (p.first, p.second) if pos[p.first] < pos[p.second] else (p.second, p.first)
        deps[v].add(u)
        dep_pair[(u, v)] = p
    parent = {l: l for l in order}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for p in pair_edges:
        parent[find(p.first)] = find(p.second)
    wave = {}
    for l in order:
        wave[l] = 1 + max(wave[d] for d in deps[l]) if deps[l] else 0

    def step(l):
        r = by_label[l]
        after = sorted(deps[l], key=pos.get)
        files = {d: dep_pair[(d, l)].files or dep_pair[(d, l)].shared for d in after}
        if after:
            verb = 'merges' if len(after) == 1 else 'merge'
            action = f'rebase onto master after {", ".join(after)} {verb}'
            if r.base_status == 'conflicts':
                action += f' (also conflicts with master now: {len(r.base_conflicts)} file(s))'
        elif r.base_status == 'conflicts':
            action = f'rebase onto master now (conflicts with master in {len(r.base_conflicts)} file(s))'
        elif r.base_status == 'unknown':
            action = 'cannot analyse: ' + (r.detail or 'unknown')
        else:
            action = 'merge as-is, no wait'
        if r.held:
            action += ' [draft/hold: the merge runner skips it until cleared]'
        return {'ref': l, 'wave': wave[l], 'after': after, 'action': action, 'files': files}

    groups = defaultdict(list)
    for l in order:
        groups[find(l)].append(l)
    serial = [g for g in groups.values() if len(g) > 1]
    singles = [g[0] for g in groups.values() if len(g) == 1]
    plan = {
        'order_rule': ORDER_RULE,
        'independent': [l for l in singles if by_label[l].base_status == 'clean'],
        'held': [r.label for r in refs if r.held],
        'rebase_only': [step(l) for l in singles if by_label[l].base_status == 'conflicts'],
        'unanalysed': [{'ref': l, 'reason': by_label[l].detail} for l in singles if by_label[l].base_status == 'unknown'],
        'groups': [{'refs': g, 'steps': [step(l) for l in g]} for g in sorted(serial, key=lambda g: pos[g[0]])],
        'auto_merge': [p.to_dict() for p in pairs if p.status == 'ok'],
        'unknown_pairs': [p.to_dict() for p in pairs if p.status == 'unknown'],
        'already_in_base': [r.label for r in refs if r.base_status == 'no-changes'],
        'cycle_breaks': broken,
    }
    return plan


# --------------------------------------------------------------------------- claims

def area_of(path):
    d = path.rsplit('/', 1)[0] if '/' in path else ''
    return '/'.join(d.split('/')[:3]) if d else '(root)'


def path_matches(pattern, path):
    pattern = pattern.replace('\\', '/')
    if pattern.startswith('./'):
        pattern = pattern[2:]
    if any(c in pattern for c in '*?['):
        return fnmatch.fnmatchcase(path, pattern)
    return path == pattern or path.startswith(pattern.rstrip('/') + '/')


def build_claims(refs, hot, touching):
    refs = [r for r in refs if r.base_status != 'no-changes']  # work already in base claims nothing
    by_file = defaultdict(list)
    for r in refs:
        for f in r.files:
            by_file[f].append(r.label)
    claims = {
        'hot_threshold': hot,
        'by_ref': {r.label: {'files': len(r.files), 'lines': r.lines, 'areas': dict(Counter(area_of(f) for f in r.files))}
                   for r in refs},
        'contested': {f: o for f, o in sorted(by_file.items()) if len(o) >= 2},
        'hot': {f: o for f, o in sorted(by_file.items()) if len(o) >= hot},
    }
    if touching:
        claims['touching'] = {pat: {f: o for f, o in sorted(by_file.items()) if path_matches(pat, f)}
                              for pat in touching}
    return claims


# --------------------------------------------------------------------------- worktrees

def parse_worktree_list(text):
    entries, cur = [], None
    for line in text.splitlines():
        if not line.strip():
            if cur:
                entries.append(cur)
            cur = None
            continue
        key, _, val = line.partition(' ')
        if key == 'worktree':
            cur = {'path': val, 'head': '', 'branch': None, 'detached': False, 'bare': False,
                   'locked': False, 'prunable': False}
        elif cur is None:
            continue
        elif key == 'HEAD':
            cur['head'] = val
        elif key == 'branch':
            cur['branch'] = val[len('refs/heads/'):] if val.startswith('refs/heads/') else val
        elif key in ('detached', 'bare'):
            cur[key] = True
        elif key in ('locked', 'prunable'):
            cur[key] = val or True
    if cur:
        entries.append(cur)
    return entries


def parse_status_z(out):
    tracked = untracked = 0
    toks, i = out.split('\0'), 0
    while i < len(toks):
        t = toks[i]
        i += 1
        if len(t) < 4:
            continue
        xy = t[:2]
        if xy == '??':
            untracked += 1
        elif xy != '!!':
            tracked += 1
            if xy[0] in 'RC':
                i += 1  # rename/copy entries carry the original path as the next token
    return tracked, untracked


def best_pr_by_branch(prs):
    best = {}
    for p in prs:
        cur = best.get(p['head'])
        rank = (p['state'] == 'OPEN', p['number'])
        if cur is None or rank > (cur['state'] == 'OPEN', cur['number']):
            best[p['head']] = p
    return best


def worktree_report(git, base_sha, prs, now=None, jobs=8):
    """REPORT ONLY. prs: list of {number, head, state} or None when gh is unavailable."""
    now = now or time.time()
    top = os.path.normcase(os.path.abspath(git.out('rev-parse', '--show-toplevel') or git.repo))
    entries = parse_worktree_list(git.out('worktree', 'list', '--porcelain'))
    by_branch = best_pr_by_branch(prs) if prs is not None else {}

    def info(item):
        idx, e = item
        row = {'path': e['path'], 'branch': e['branch'], 'head': e['head'][:7], 'main': idx == 0,
               'current': os.path.normcase(os.path.abspath(e['path'])) == top, 'locked': bool(e['locked']),
               'prunable': bool(e['prunable']), 'modified': 0, 'untracked': 0, 'dirty': False,
               'last_commit_age': None, 'ahead': None, 'behind': None, 'pr': None, 'stale_candidate': False}
        if e['prunable'] or not os.path.isdir(e['path']):
            row['verdict'], row['note'] = 'missing', 'directory is gone (git worktree prune would drop the entry)'
            return row
        cwd = e['path']
        st = git.run('status', '--porcelain=v1', '-z', '--untracked-files=normal', cwd=cwd)
        if st.returncode == 0:
            row['modified'], row['untracked'] = parse_status_z(st.stdout)
            row['dirty'] = bool(row['modified'] or row['untracked'])
        ts = git.out('log', '-1', '--format=%ct', cwd=cwd)
        row['last_commit_age'] = fmt_age(now - int(ts)) if ts.isdigit() else None
        if e['branch'] and base_sha:
            c = git.out('rev-list', '--left-right', '--count', f'{base_sha}...{e["head"]}', cwd=cwd).split()
            if len(c) == 2:
                row['behind'], row['ahead'] = int(c[0]), int(c[1])
        pr = by_branch.get(e['branch']) if e['branch'] else None
        row['pr'] = {'number': pr['number'], 'state': pr['state']} if pr else None
        if row['main']:
            row['verdict'], row['note'] = 'main checkout', ''
        elif not e['branch']:
            row['verdict'], row['note'] = 'detached', 'no branch; nothing to match against a PR'
        elif prs is None:
            row['verdict'], row['note'] = 'unknown', 'gh unavailable, PR state not checked'
        elif pr is None:
            row['verdict'] = 'no-pr'
            row['note'] = f'{row["ahead"]} commit(s) ahead of base, no PR' if row['ahead'] else 'no PR'
        elif pr['state'] == 'OPEN':
            row['verdict'], row['note'] = 'active', f'PR #{pr["number"]} open'
        else:
            row['verdict'] = 'stale-candidate'
            row['stale_candidate'] = True
            row['note'] = f'PR #{pr["number"]} {pr["state"].lower()}'
        if row['dirty']:
            row['note'] += ('; ' if row['note'] else '') + f'{row["modified"]} modified, {row["untracked"]} untracked: inspect first'
        return row
    return pmap(info, list(enumerate(entries)), jobs)


# --------------------------------------------------------------------------- orchestration

def resolve_remote(git, base):
    head = base.split('/', 1)[0] if '/' in base else 'origin'
    return head if head in git.out('remote').split() else 'origin'


def local_branches_ahead(git, base_sha):
    names = git.out('branch', '--no-merged', base_sha, '--format=%(refname:short)').splitlines()
    return [n.strip() for n in names if n.strip() and not n.startswith('(')]


def collect_specs(git, base, base_sha, explicit, no_gh, max_refs, warnings):
    remote = resolve_remote(git, base)
    base_branch = base.split('/', 1)[1] if base.startswith(remote + '/') else base
    prs, source = None, 'explicit refs' if explicit else 'local branches ahead of base'
    if not no_gh:
        prs, err = load_open_prs(git.repo)
        if prs is None:
            warnings.append(f'gh unavailable ({err}); PR metadata, labels and --checks are off')
    prs = [p for p in prs or [] if p['base'] in (None, base_branch)] if prs is not None else None
    by_head = {p['head']: p for p in prs or []}
    if explicit:
        specs = [(n, by_head.get(short_name(n))) for n in explicit]
    elif prs is not None:
        source = 'open PRs via gh'
        specs = []
        for p in prs:
            if p['cross_repo']:
                warnings.append(f"#{p['number']} is from a fork, skipped")
            else:
                specs.append((f'{remote}/{p["head"]}', p))
    else:
        specs = [(n, None) for n in local_branches_ahead(git, base_sha)]
    if len(specs) > max_refs:
        # newest activity first: those are the ones still in flight
        specs.sort(key=lambda s: -(parse_ts((s[1] or {}).get('updated_at'))))
        warnings.append(f'{len(specs)} refs, capped at {max_refs}: skipped ' + ', '.join(s[0] for s in specs[max_refs:]))
        specs = specs[:max_refs]
    taken, out = set(), []
    for name, pr in specs:
        label = f"#{pr['number']}" if pr and pr.get('number') else short_name(name)
        while label in taken:
            label += "'"
        taken.add(label)
        out.append((name, pr, label))
    out.sort(key=lambda s: ((s[1] or {}).get('number') or 10 ** 9, s[0]))
    return out, source


def analyze(git, base_sha, specs, deep, jobs, checks, hot, touching, warnings, ignore=IGNORED_CHECKS):
    refs = pmap(lambda s: analyze_ref(git, base_sha, s), specs, jobs)
    warnings.extend(f'{r.label}: {r.warn}' for r in refs if r.warn)
    if checks:
        for r, ci in zip(refs, pmap(lambda r: load_checks(git.repo, r.number, ignore) if r.number else 'unknown', refs, min(jobs, 4))):
            r.ci = ci
    pairs = analyze_pairs(git, base_sha, refs, jobs) if deep else []
    result = {'refs': refs, 'pairs': pairs, 'claims': build_claims(refs, hot, touching)}
    if deep:
        result['plan'] = build_plan(refs, pairs)
    return result


# --------------------------------------------------------------------------- rendering

def md_cell(v):
    return str(v).replace('|', '\\|').replace('\n', ' ')


def md_table(headers, rows):
    lines = ['| ' + ' | '.join(headers) + ' |', '|' + '|'.join([' --- '] * len(headers)) + '|']
    lines += ['| ' + ' | '.join(md_cell(c) for c in row) + ' |' for row in rows]
    return '\n'.join(lines)


def fmt_files(files, n=4):
    shown = ', '.join(f'`{f}`' for f in files[:n])
    return shown + (f' (+{len(files) - n} more)' if len(files) > n else '') if files else '-'


def pr_cell(r):
    if not r.number:
        return '-'
    bits = [f'#{r.number}'] + sorted(HOLD_LABELS & set(r.pr.get('labels') or []))
    if r.pr.get('draft'):
        bits.append('draft')
    return ' '.join(bits)


def render_refs(refs):
    rows = []
    for r in refs:
        rows.append([r.label, r.name, pr_cell(r), f'{r.ahead}/{r.behind}', len(r.files), r.lines, r.ci, r.status_text()])
    return md_table(['Ref', 'Branch', 'PR', 'Ahead/Behind', 'Files', 'Lines', 'CI', 'Status'], rows)


def render_plan(result):
    plan, pairs = result['plan'], result['pairs']
    out = ['## Integration plan', '', f"Order rule: {plan['order_rule']}.", '']
    held = set(plan['held'])
    indep = [l + (' (held)' if l in held else '') for l in plan['independent']]
    out.append('**Independent - merge in any order or in parallel:** ' + (', '.join(indep) or 'none'))
    if plan['already_in_base']:
        out.append('')
        out.append('**Already in base (nothing to merge):** ' + ', '.join(plan['already_in_base']))
    if plan['rebase_only']:
        out += ['', '**Conflict with base only - rebase onto master (no other ref involved):**', '']
        out.append(md_table(['Ref', 'Action'], [[s['ref'], s['action']] for s in plan['rebase_only']]))
    for i, g in enumerate(plan['groups'], 1):
        shared = sorted({f for s in g['steps'] for fl in s['files'].values() for f in fl})
        out += ['', f"**Serial group {i}** ({', '.join(g['refs'])}) - shared: {fmt_files(shared, 5)}", '',
                'Refs in the same wave do not depend on each other; wave N waits for the refs it names.', '']
        out.append(md_table(['Wave', 'Ref', 'Action'], [[s['wave'], s['ref'], s['action']] for s in g['steps']]))
    if plan['unanalysed']:
        out += ['', '**Could not analyse:** ' + '; '.join(f"{u['ref']} ({u['reason']})" for u in plan['unanalysed'])]
    shared_rows = [[p.first, p.second, fmt_files(p.shared, 3), p.status + (' (approx)' if p.approx else ''),
                    fmt_files(p.files, 3) if p.files else '-', p.second_action]
                   for p in pairs]
    if shared_rows:
        out += ['', '### Pairs that share files', '',
                md_table(['First', 'Second', 'Shared files', 'Result', 'Conflicts', 'Action for second'], shared_rows)]
    n = len(result['refs'])
    out += ['', f'{n * (n - 1) // 2 - len(pairs)} other pair(s) touch disjoint files (independent).']
    if plan['cycle_breaks']:
        out += ['', 'Note: ordering constraints formed a cycle, broke it at: ' + ', '.join(plan['cycle_breaks'])]
    return '\n'.join(out)


def render_claims(claims, hot_only=False):
    out = ['## Claims (files in flight)', '']
    rows = [[l, d['files'], d['lines'], ', '.join(f'{a} ({c})' for a, c in sorted(d['areas'].items(), key=lambda x: -x[1])[:3])]
            for l, d in claims['by_ref'].items()]
    if not hot_only:
        out += [md_table(['Ref', 'Files', 'Lines', 'Main areas'], rows), '']
    hot = claims['hot']
    out.append(f"**Hot files (touched by {claims['hot_threshold']}+ refs):** " + ('none' if not hot else ''))
    if hot:
        out += ['', md_table(['File', 'Refs'], [[f'`{f}`', ', '.join(o)] for f, o in hot.items()])]
    if not hot_only:
        other = {f: o for f, o in claims['contested'].items() if f not in hot}
        out += ['', '**Contested (2 refs):** ' + ('none' if not other else '')]
        if other:
            out += ['', md_table(['File', 'Refs'], [[f'`{f}`', ', '.join(o)] for f, o in other.items()])]
    if 'touching' in claims:
        out += ['', '### Collision check for the paths you plan to touch', '']
        rows = []
        for pat, hits in claims['touching'].items():
            rows.append([f'`{pat}`', 'free' if not hits else 'CLAIMED',
                         '; '.join(f'`{f}`: {", ".join(o)}' for f, o in list(hits.items())[:6]) or '-'])
        out.append(md_table(['Path or glob', 'Result', 'Claimed by'], rows))
    return '\n'.join(out)


def render_worktrees(rows):
    out = ['## Worktrees (report only, nothing is deleted)', '']
    table = []
    for r in rows:
        flags = ', '.join(x for x, on in (('main', r['main']), ('current', r['current']), ('locked', r['locked'])) if on)
        pr = f"#{r['pr']['number']} {r['pr']['state'].lower()}" if r['pr'] else '-'
        state = 'dirty' if r['dirty'] else ('clean' if r['verdict'] != 'missing' else '-')
        table.append([r['path'], r['branch'] or '(detached)', flags or '-', state, r['last_commit_age'] or '-',
                      f"{r['ahead']}/{r['behind']}" if r['ahead'] is not None else '-', pr, r['verdict'], r['note']])
    out.append(md_table(['Path', 'Branch', 'Flags', 'State', 'Last commit', 'Ahead/Behind', 'PR', 'Verdict', 'Note'], table))
    stale = [r for r in rows if r['stale_candidate']]
    out += ['', f'{len(stale)} stale candidate(s): PR merged or closed. Clean ones are safe to review for removal; '
                'dirty ones may hold unsaved work. This tool never removes anything.']
    return '\n'.join(out)


def render_markdown(meta, data, modes):
    head = f"base `{meta['base']}` @ `{meta['base_sha'][:7]}` | git {meta['git']}"
    if meta['merge_tree'] is not None:
        head += f" | merge-tree: {'yes' if meta['merge_tree'] else 'NO (statuses are unknown)'} | refs: {meta['ref_source']}"
    out = ['# Integration planner', '', head]
    for w in meta['warnings']:
        out.append(f'- warning: {w}')
    if 'refs' in data:
        out += ['', '## Refs', '', render_refs(data['refs'])]
    if 'plan' in data:
        out += ['', render_plan(data)]
        if data['claims']['hot'] and 'claims' not in modes:
            out += ['', render_claims(data['claims'], hot_only=True)]
    if 'claims' in data and 'plan' not in data:
        out += ['', render_claims(data['claims'])]
    elif 'plan' in data and 'claims' in modes:
        out += ['', render_claims(data['claims'])]
    if 'worktrees' in data:
        out += ['', render_worktrees(data['worktrees'])]
    return '\n'.join(out) + '\n'


# --------------------------------------------------------------------------- CLI

def build_parser():
    p = argparse.ArgumentParser(prog='integration_plan.py', description='Advisory conflict detection and merge ordering '
                                'for parallel feature branches/worktrees. Read-only.')
    p.add_argument('--repo', default='.', help='any path inside the repository (default: current directory)')
    p.add_argument('--base', default=DEFAULT_BASE, help=f'integration target (default: {DEFAULT_BASE})')
    p.add_argument('--refs', nargs='+', metavar='REF', help='refs to analyse (space or comma separated); default: '
                   'origin/* branches with an open PR (gh), else local branches ahead of base')
    p.add_argument('--max-refs', type=int, default=MAX_REFS, help=f'cap on analysed refs (default {MAX_REFS})')
    p.add_argument('--plan', action='store_true', help='conflict table and integration plan (default mode)')
    p.add_argument('--claims', action='store_true', help='which files each in-flight ref claims; hot files')
    p.add_argument('--worktrees', action='store_true', help='list git worktrees: dirty state, age, PR merged/closed')
    p.add_argument('--all', action='store_true', help='plan + claims + worktrees')
    p.add_argument('--touching', nargs='+', metavar='PATH', help='paths/globs you plan to edit; shows who already claims '
                   'them (implies --claims)')
    p.add_argument('--hot', type=int, default=HOT_THRESHOLD, help=f'refs touching one file to call it hot (default {HOT_THRESHOLD})')
    p.add_argument('--checks', action='store_true', help='use `gh pr checks` so green CI merges first')
    p.add_argument('--ignore-checks', default=','.join(IGNORED_CHECKS), metavar='PREFIXES',
                   help='comma-separated check-name prefixes that do not count towards CI state '
                        f'(default: {",".join(IGNORED_CHECKS)}; deployment previews stay pending)')
    p.add_argument('--no-gh', action='store_true', help='never call gh (local branches only, no PR labels or states)')
    p.add_argument('--fetch', action='store_true', help='git fetch --prune the base remote first (writes remote-tracking refs)')
    p.add_argument('--json', action='store_true', help='print JSON instead of markdown')
    p.add_argument('--jobs', type=int, default=8, help='parallel git processes (default 8)')
    p.add_argument('--fail-on-conflict', action='store_true', help='exit 1 if any ref conflicts with base or another ref')
    return p


def run(args):
    git = Git(args.repo)
    top = git.run('rev-parse', '--show-toplevel')
    if top.returncode != 0:
        raise ToolError(f'not a git repository: {args.repo}' if top.returncode != 127 else top.stderr.strip())
    git.repo = os.path.abspath(top.stdout.strip())
    modes = {m for m, on in (('plan', args.plan), ('claims', args.claims or bool(args.touching)),
                             ('worktrees', args.worktrees)) if on}
    if args.all:
        modes = {'plan', 'claims', 'worktrees'}
    modes = modes or {'plan'}
    base_sha = git.out('rev-parse', '--verify', '--quiet', args.base + '^{commit}')
    if not base_sha:
        raise ToolError(f'cannot resolve --base {args.base} (run `git fetch origin`, or pass --base)')
    remote = resolve_remote(git, args.base)
    warnings = []
    if args.fetch:
        f = git.run('fetch', '--prune', remote)
        if f.returncode != 0:
            warnings.append(f'git fetch {remote} failed: ' + (f.stderr.strip().splitlines() or ['?'])[0])
        base_sha = git.out('rev-parse', '--verify', '--quiet', args.base + '^{commit}') or base_sha
    jobs = max(1, args.jobs)
    meta = {'base': args.base, 'base_sha': base_sha, 'git': git.out('--version').replace('git version ', ''),
            'generated_at': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'modes': sorted(modes)}
    data = {}
    try:
        deep = 'plan' in modes
        if deep or 'claims' in modes:
            if not git.enable_quarantine(base_sha):
                warnings.append('could not isolate object writes; merge-tree may leave unreachable objects in .git')
            git.probe_merge_tree(base_sha)
            explicit = [r for chunk in (args.refs or []) for r in chunk.split(',') if r] or None
            specs, source = collect_specs(git, args.base, base_sha, explicit, args.no_gh, max(1, args.max_refs), warnings)
            res = analyze(git, base_sha, specs, deep, jobs, args.checks and not args.no_gh, args.hot,
                          args.touching, warnings, tuple(x for x in args.ignore_checks.split(',') if x))
            data.update(refs=res['refs'], claims=res['claims'])
            if deep:
                data.update(pairs=res['pairs'], plan=res['plan'])
            meta['ref_source'] = source
        else:
            meta['ref_source'] = 'n/a'
        if 'worktrees' in modes:
            prs = None
            if not args.no_gh:
                raw, err = _gh_json(['pr', 'list', '--state', 'all', '--limit', '300', '--json',
                                     'number,headRefName,state'], git.repo)
                if raw is None:
                    warnings.append(f'gh unavailable ({err}); PR state of worktrees unknown')
                else:
                    prs = [{'number': p['number'], 'head': p['headRefName'], 'state': p['state']} for p in raw]
            data['worktrees'] = worktree_report(git, base_sha, prs, jobs=jobs)
    finally:
        git.close()
    meta['merge_tree'] = git.merge_tree_ok if ('plan' in modes or 'claims' in modes) else None
    meta['warnings'] = warnings
    if args.json:
        doc = {'meta': meta}
        if 'refs' in data:
            doc['refs'] = [r.to_dict() for r in data['refs']]
            doc['claims'] = data['claims']
        if 'plan' in data:
            doc['pairs'] = [p.to_dict() for p in data['pairs']]
            doc['plan'] = data['plan']
        if 'worktrees' in data:
            doc['worktrees'] = data['worktrees']
        print(json.dumps(doc, indent=2))
    else:
        print(render_markdown(meta, data, modes))
    if args.fail_on_conflict and 'plan' in data:
        bad = any(r.base_status == 'conflicts' or r.conflicts_with for r in data['refs'])
        return 1 if bad else 0
    return 0


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    args = build_parser().parse_args(argv)
    try:
        return run(args)
    except ToolError as e:
        print(f'integration_plan: {e}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
