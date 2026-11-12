"""Offline tests for tools/integration_plan.py: a throwaway git repo, no network, no gh."""
import contextlib
import importlib.util
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).parents[1]
SCRIPT = ROOT / 'tools' / 'integration_plan.py'
spec = importlib.util.spec_from_file_location('integration_plan', SCRIPT)
ip = importlib.util.module_from_spec(spec)
sys.modules['integration_plan'] = ip
spec.loader.exec_module(ip)

CLOCK = [1_700_000_000]


def lines(prefix, n=10):
    return ''.join(f'{prefix}{i}\n' for i in range(1, n + 1))


class Fixture:
    """base commit c0, then branches off c0, then master moves on (c1 edits a.txt line 2)."""

    def __init__(self, root):
        self.root = str(root)
        empty_cfg = os.path.join(self.root, 'empty.gitconfig')
        pathlib.Path(empty_cfg).write_text('')
        self.env = dict(os.environ, GIT_CONFIG_GLOBAL=empty_cfg, GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_SYSTEM=empty_cfg,
                        GIT_AUTHOR_NAME='t', GIT_AUTHOR_EMAIL='t@localhost',
                        GIT_COMMITTER_NAME='t', GIT_COMMITTER_EMAIL='t@localhost')
        self.repo = os.path.join(self.root, 'repo')
        os.mkdir(self.repo)
        self.git('init', '-q', '-b', 'master')
        self.git('config', 'core.autocrlf', 'false')
        self.write({'nav.ts': lines('n'), 'shared.txt': lines('s'), 'a.txt': lines('a', 6), 'README.md': 'hi\n'})
        self.commit('c0')
        self.c0 = self.git('rev-parse', 'HEAD')

    def git(self, *args, cwd=None):
        r = subprocess.run(['git', *args], cwd=cwd or self.repo, env=self.env, capture_output=True, text=True)
        if r.returncode != 0:
            raise AssertionError(f'git {args} failed: {r.stderr}')
        return r.stdout.strip()

    def write(self, files):
        for path, text in files.items():
            full = os.path.join(self.repo, path)
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, 'w', newline='\n') as f:
                f.write(text)

    def edit_line(self, path, n, text):
        full = os.path.join(self.repo, path)
        with open(full, newline='\n') as f:
            rows = f.read().splitlines(keepends=True)
        rows[n - 1] = text + '\n'
        self.write({path: ''.join(rows)})

    def commit(self, msg):
        CLOCK[0] += 3600
        stamp = f'{CLOCK[0]} +0000'
        self.env.update(GIT_AUTHOR_DATE=stamp, GIT_COMMITTER_DATE=stamp)
        self.git('add', '-A')
        self.git('commit', '-q', '-m', msg)

    def branch(self, name, start=None):
        self.git('checkout', '-q', '-b', name, start or self.c0)

    def done(self):
        self.git('checkout', '-q', 'master')


def build_repo(root):
    fx = Fixture(root)
    fx.branch('clean_b')
    fx.write({'c.txt': 'c\n'})
    fx.commit('clean')
    fx.done()
    fx.branch('conflict_base')
    fx.edit_line('a.txt', 2, 'CB')
    fx.commit('conflict_base edits a.txt:2')
    fx.done()
    fx.branch('cb2')
    fx.edit_line('a.txt', 5, 'CB2')
    fx.commit('cb2 edits a.txt:5 (clean vs master, shares a.txt with conflict_base)')
    fx.done()
    fx.branch('cb3')
    fx.edit_line('a.txt', 2, 'CB3')
    fx.commit('cb3 edits a.txt:2')
    fx.done()
    fx.branch('p1')
    fx.edit_line('nav.ts', 2, 'P1')
    fx.write({'p1.txt': 'p1\n', 'p1b.txt': 'p1b\n'})
    fx.commit('p1 edits nav.ts:2 plus two files (bigger diff)')
    fx.done()
    fx.branch('p2')
    fx.edit_line('nav.ts', 2, 'P2')
    fx.commit('p2 edits nav.ts:2 (smaller diff)')
    fx.done()
    fx.branch('p3')
    fx.edit_line('nav.ts', 9, 'P3')
    fx.commit('p3 edits nav.ts:9 (auto-merges with p1/p2)')
    fx.done()
    fx.branch('q1')
    fx.edit_line('shared.txt', 1, 'Q1')
    fx.commit('q1')
    fx.done()
    fx.branch('q2')
    fx.edit_line('shared.txt', 10, 'Q2')
    fx.commit('q2')
    fx.done()
    fx.branch('i1')
    fx.write({'i1.txt': 'i1\n'})
    fx.commit('i1')
    fx.done()
    fx.branch('i2')
    fx.write({'i2.txt': 'i2\n'})
    fx.commit('i2')
    fx.done()
    fx.branch('st1')
    fx.write({'st.txt': 'st1\n'})
    fx.commit('st1')
    fx.branch('st2', 'st1')
    fx.write({'st.txt': 'st1\nst2\n'})
    fx.commit('st2 builds on st1')
    fx.done()
    fx.branch('already_merged')
    fx.done()
    fx.branch('squashed')
    fx.write({'sq.txt': 'squash me' + chr(10)})
    fx.commit('squashed')
    fx.done()
    fx.git('checkout', '-q', '--orphan', 'orphan')
    fx.git('rm', '-rfq', '.')
    fx.write({'x.txt': 'unrelated\n'})
    fx.commit('orphan root')
    fx.done()
    fx.write({'sq.txt': 'squash me' + chr(10)})
    fx.commit('master lands the same change as a squash commit')
    fx.edit_line('a.txt', 2, 'MASTER')  # master moves: conflict_base and cb3 now collide with it
    fx.commit('master c1 edits a.txt:2')
    return fx


def specs_for(names, prs=None):
    prs = prs or {}
    return [(n, prs.get(n), (f"#{prs[n]['number']}" if n in prs else n)) for n in names]


def analyze(fx, names, prs=None, deep=True, checks=False, hot=3, touching=None):
    git = ip.Git(fx.repo)
    base_sha = git.out('rev-parse', 'master')
    try:
        git.enable_quarantine(base_sha)
        git.probe_merge_tree(base_sha)
        return ip.analyze(git, base_sha, specs_for(names, prs), deep, 4, checks, hot, touching, [])
    finally:
        git.close()


def run_cli(*argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = ip.main(list(argv))
    return code, out.getvalue(), err.getvalue()


ALL = ['clean_b', 'conflict_base', 'cb2', 'cb3', 'p1', 'p2', 'p3', 'q1', 'q2', 'i1', 'i2', 'st1', 'st2',
       'already_merged', 'squashed', 'orphan', 'does_not_exist']


class IntegrationPlanTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        cls.fx = build_repo(cls.tmp.name)
        cls.env_patch = mock.patch.dict(os.environ, {k: v for k, v in cls.fx.env.items()})
        cls.env_patch.start()
        cls.res = analyze(cls.fx, ALL)
        cls.refs = {r.label: r for r in cls.res['refs']}
        cls.pairs = {frozenset((p.first, p.second)): p for p in cls.res['pairs']}

    @classmethod
    def tearDownClass(cls):
        cls.env_patch.stop()
        cls.tmp.cleanup()

    def pair(self, a, b):
        return self.pairs[frozenset((a, b))]

    # --- per ref
    def test_clean_branch(self):
        r = self.refs['clean_b']
        self.assertEqual('clean', r.status())
        self.assertEqual(['c.txt'], r.files)
        self.assertEqual((1, 2), (r.ahead, r.behind))  # master has two commits the branch lacks
        self.assertEqual([], r.conflicts_with)

    def test_conflict_with_base(self):
        r = self.refs['conflict_base']
        self.assertEqual('conflicts-with-base', r.status())
        self.assertEqual(['a.txt'], r.base_conflicts)

    def test_already_in_base_and_unresolvable_and_unrelated_are_not_conflicts(self):
        self.assertEqual('no-changes', self.refs['already_merged'].status())
        squashed = self.refs['squashed']  # same change landed on master under a different sha
        self.assertEqual('no-changes', squashed.status())
        self.assertIn('already integrated', squashed.status_text())
        self.assertNotIn('squashed', self.res['claims']['by_ref'])
        self.assertIn('squashed', self.res['plan']['already_in_base'])
        self.assertEqual('unknown', self.refs['does_not_exist'].status())
        self.assertIn('not found', self.refs['does_not_exist'].detail)
        self.assertEqual('unknown', self.refs['orphan'].status())
        self.assertIn('no common ancestor', self.refs['orphan'].detail)

    def test_detached_sha_is_a_valid_ref(self):
        sha = self.fx.git('rev-parse', 'clean_b')
        res = analyze(self.fx, [sha])
        self.assertEqual('clean', res['refs'][0].status())

    # --- pairs
    def test_pair_conflict_only_through_shared_file(self):
        p = self.pair('p1', 'p2')
        self.assertEqual('conflict', p.status)
        self.assertEqual(['nav.ts'], p.files)
        self.assertFalse(p.approx)
        # each side is clean against master on its own: the conflict exists only between them
        self.assertEqual(('clean', 'clean'), (self.refs['p1'].base_status, self.refs['p2'].base_status))
        self.assertEqual(['p2'], self.refs['p1'].conflicts_with)
        self.assertEqual(['p1'], self.refs['p2'].conflicts_with)
        self.assertEqual('conflicts-with', self.refs['p1'].status())

    def test_shared_file_that_auto_merges(self):
        p = self.pair('q1', 'q2')
        self.assertEqual('ok', p.status)
        self.assertEqual('no action, auto-resolves', p.second_action)
        self.assertEqual('clean', self.refs['q1'].status())
        p = self.pair('p3', 'p1')
        self.assertEqual('ok', p.status)  # same file, different hunk

    def test_independent_pair_is_not_listed(self):
        self.assertNotIn(frozenset(('i1', 'i2')), self.pairs)
        self.assertNotIn(frozenset(('i1', 'clean_b')), self.pairs)
        plan = self.res['plan']
        for label in ('i1', 'i2', 'clean_b', 'q1', 'q2', 'p3'):
            self.assertIn(label, plan['independent'] + [s['ref'] for g in plan['groups'] for s in g['steps']])
        self.assertIn('i1', plan['independent'])
        self.assertIn('i2', plan['independent'])

    def test_base_conflict_is_subtracted_from_pair_verdict(self):
        # cb2 is clean vs master, conflict_base is not; the only collision is a.txt which conflict_base
        # already has against master, so it must not be blamed on cb2.
        p = self.pair('cb2', 'conflict_base')
        self.assertEqual('ok', p.status)
        self.assertIn('already conflict', p.detail)

    def test_both_dirty_pair_is_tested_head_to_head_and_flagged_approximate(self):
        p = self.pair('conflict_base', 'cb3')
        self.assertEqual('conflict', p.status)
        self.assertTrue(p.approx)
        self.assertEqual(['a.txt'], p.files)

    def test_stacked_branches_force_ancestor_first(self):
        p = self.pair('st1', 'st2')
        self.assertEqual('stacked', p.status)
        self.assertEqual(('st1', 'st2'), (p.first, p.second))
        step = {s['ref']: s for g in self.res['plan']['groups'] for s in g['steps']}
        self.assertEqual(['st1'], step['st2']['after'])
        self.assertEqual(1, step['st2']['wave'])

    # --- plan and ordering
    def test_plan_orders_smaller_diff_first_and_names_the_action(self):
        group = next(g for g in self.res['plan']['groups'] if 'p1' in g['refs'])
        self.assertEqual(['p2', 'p1'], group['refs'])
        steps = {s['ref']: s for s in group['steps']}
        self.assertEqual('merge as-is, no wait', steps['p2']['action'])
        self.assertEqual('rebase onto master after p2 merges', steps['p1']['action'])
        self.assertEqual(['p2'], steps['p1']['after'])
        self.assertEqual(['nav.ts'], steps['p1']['files']['p2'])

    def test_two_refs_that_both_conflict_with_master_are_ordered_by_age(self):
        group = next(g for g in self.res['plan']['groups'] if 'cb3' in g['refs'])
        self.assertEqual(2, len(group['refs']))
        # both conflict with master, so the older commit (conflict_base) goes first, the other rebases after it
        steps = {s['ref']: s for s in group['steps']}
        self.assertEqual('rebase onto master now (conflicts with master in 1 file(s))', steps['conflict_base']['action'])
        self.assertTrue(steps['cb3']['action'].startswith('rebase onto master after conflict_base merges'))

    def _key(self, **kw):
        base = dict(name='x', label='x', lines=10, files=['f'], tip_ts=100, ci='unknown', base_status='clean')
        base.update(kw)
        return ip.order_key(ip.RefInfo(**base))

    def test_ordering_rule_ci_then_size_then_age(self):
        self.assertLess(self._key(ci='pass', lines=500), self._key(ci='unknown', lines=1))  # green beats small
        self.assertLess(self._key(ci='unknown'), self._key(ci='fail'))
        self.assertLess(self._key(lines=5), self._key(lines=6))  # smaller diff
        self.assertLess(self._key(lines=5, files=['a']), self._key(lines=5, files=['a', 'b']))
        self.assertLess(self._key(tip_ts=1), self._key(tip_ts=2))  # older
        old_pr = {'number': 9, 'created_at': '2026-11-01T00:00:00Z', 'labels': []}
        new_pr = {'number': 3, 'created_at': '2026-11-05T00:00:00Z', 'labels': []}
        self.assertLess(self._key(pr=old_pr), self._key(pr=new_pr))  # PR creation date beats PR number
        # tiers above the rule: hold/draft and already-conflicting go last
        self.assertLess(self._key(lines=999), self._key(lines=1, pr={'number': 1, 'labels': ['hold']}))
        self.assertLess(self._key(lines=999), self._key(lines=1, pr={'number': 1, 'labels': [], 'draft': True}))
        self.assertLess(self._key(lines=999), self._key(lines=1, base_status='conflicts'))

    def test_ci_outranks_diff_size_end_to_end(self):
        prs = {'p1': {'number': 1, 'head': 'p1', 'labels': [], 'draft': False, 'created_at': None},
               'p2': {'number': 2, 'head': 'p2', 'labels': [], 'draft': False, 'created_at': None}}
        ci = {1: 'pass', 2: 'fail'}  # p1 has the bigger diff but green CI
        with mock.patch.object(ip, 'load_checks', side_effect=lambda cwd, n, ignore=(): ci[n]):
            res = analyze(self.fx, ['p1', 'p2'], prs, checks=True)
        group = res['plan']['groups'][0]
        self.assertEqual(['#1', '#2'], group['refs'])
        self.assertEqual('rebase onto master after #1 merges', group['steps'][1]['action'])

    def test_summarize_checks_ignores_vercel_preview(self):
        rows = [{'name': 'offline-checks', 'bucket': 'pass'}, {'name': 'Vercel', 'bucket': 'pending'}]
        self.assertEqual('pass', ip.summarize_checks(rows))
        self.assertEqual('pending', ip.summarize_checks(rows, ignore=()))
        self.assertEqual('fail', ip.summarize_checks(rows + [{'name': 'x', 'bucket': 'fail'}]))
        self.assertEqual('unknown', ip.summarize_checks([]))

    def test_held_ref_is_flagged_in_plan(self):
        prs = {'i1': {'number': 7, 'head': 'i1', 'labels': ['hold'], 'draft': False, 'created_at': None}}
        res = analyze(self.fx, ['i1', 'i2'], prs)
        self.assertEqual(['#7'], res['plan']['held'])

    # --- claims
    def test_claims_flag_hot_files(self):
        claims = self.res['claims']
        self.assertEqual({'a.txt', 'nav.ts'}, set(claims['hot']))
        self.assertEqual(['p1', 'p2', 'p3'], sorted(claims['hot']['nav.ts']))
        self.assertEqual(['q1', 'q2'], sorted(claims['contested']['shared.txt']))
        self.assertNotIn('c.txt', claims['contested'])
        self.assertEqual(3, claims['hot_threshold'])
        res = analyze(self.fx, ['p1', 'p2', 'p3', 'i1'], hot=4, touching=['nav.ts', 'i2.txt', '*.txt', 'nope/'])
        self.assertEqual({}, res['claims']['hot'])
        touching = res['claims']['touching']
        self.assertEqual({'nav.ts': ['p1', 'p2', 'p3']}, touching['nav.ts'])
        self.assertEqual({}, touching['i2.txt'])
        self.assertEqual({}, touching['nope/'])
        self.assertEqual({'i1.txt', 'p1.txt', 'p1b.txt'}, set(touching['*.txt']))

    def test_path_matching(self):
        self.assertTrue(ip.path_matches('frontend/src', 'frontend/src/lib/nav.ts'))
        self.assertTrue(ip.path_matches('frontend/src/', 'frontend/src/lib/nav.ts'))
        self.assertTrue(ip.path_matches('./tools', 'tools/x.py'))
        self.assertFalse(ip.path_matches('frontend/sr', 'frontend/src/lib/nav.ts'))
        self.assertTrue(ip.path_matches('**/nav.ts', 'frontend/src/lib/nav.ts'))

    def test_claims_only_mode_skips_pair_tests(self):
        res = analyze(self.fx, ['p1', 'p2'], deep=False)
        self.assertNotIn('plan', res)
        self.assertEqual([], res['pairs'])
        self.assertEqual('clean', res['refs'][0].status())  # per-ref status is still known
        self.assertEqual(['nav.ts', 'p1.txt', 'p1b.txt'], res['refs'][0].files)

    # --- degraded environments
    def test_old_git_without_merge_tree_reports_unknown(self):
        with mock.patch.object(ip.Git, 'probe_merge_tree', lambda self, sha: False):
            res = analyze(self.fx, ['clean_b', 'p1', 'p2'])
        self.assertEqual({'unknown'}, {r.status() for r in res['refs']})
        self.assertEqual('unknown', res['pairs'][0].status)
        self.assertEqual({'clean_b', 'p1', 'p2'}, {u['ref'] for u in res['plan']['unanalysed']})
        # files and claims are still known without merge-tree
        self.assertEqual(['nav.ts', 'p1.txt', 'p1b.txt'], res['refs'][1].files)

    def test_parse_merge_tree(self):
        tree = 'a' * 40
        self.assertEqual('clean', ip.parse_merge_tree(0, tree + '\0').state)
        clean_with_messages = ip.parse_merge_tree(0, tree + '\0\0Auto-merging x\n\0')
        self.assertEqual(([], 'clean'), (clean_with_messages.files, clean_with_messages.state))
        out = ip.parse_merge_tree(1, tree + '\0b.txt\0a.txt\0b.txt\0\0msg\0')
        self.assertEqual(('conflict', ['a.txt', 'b.txt']), (out.state, out.files))
        self.assertEqual('error', ip.parse_merge_tree(129, '', 'usage: git merge-tree').state)
        self.assertEqual('error', ip.parse_merge_tree(128, '', 'fatal: refusing to merge unrelated histories').state)
        self.assertEqual('error', ip.parse_merge_tree(0, 'not a tree id').state)

    # --- CLI and safety
    def snapshot(self):
        return (self.fx.git('count-objects', '-v'), self.fx.git('for-each-ref'), self.fx.git('status', '--porcelain'),
                self.fx.git('rev-parse', 'HEAD'))

    @staticmethod
    def scratch_dirs():
        return sorted(d for d in os.listdir(tempfile.gettempdir()) if d.startswith('integration-plan-'))

    def test_run_is_read_only(self):
        before, scratch_dirs = self.snapshot(), self.scratch_dirs()
        code, out, err = run_cli('--repo', self.fx.repo, '--base', 'master', '--no-gh', '--all',
                                 '--refs', 'p1,p2', 'q1', 'q2', 'conflict_base')
        self.assertEqual((0, ''), (code, err))
        self.assertEqual(before, self.snapshot())
        self.assertEqual(scratch_dirs, self.scratch_dirs())  # the throwaway object directory is cleaned up

    def test_cli_json_and_markdown(self):
        code, out, _ = run_cli('--repo', self.fx.repo, '--base', 'master', '--no-gh', '--json', '--plan', '--claims',
                               '--refs', 'p1', 'p2', 'i1')
        self.assertEqual(0, code)
        doc = json.loads(out)
        self.assertEqual({'p1', 'p2', 'i1'}, {r['label'] for r in doc['refs']})
        self.assertEqual(['i1'], doc['plan']['independent'])
        self.assertEqual({'p2', 'p1'}, set(doc['plan']['groups'][0]['refs']))
        self.assertTrue(doc['meta']['merge_tree'])
        self.assertIn('claims', doc)
        code, md, _ = run_cli('--repo', self.fx.repo, '--base', 'master', '--no-gh', '--refs', 'p1', 'p2', 'i1')
        self.assertEqual(0, code)
        self.assertIn('| p1 |', md)
        self.assertIn('rebase onto master after p2 merges', md)
        self.assertIn('conflicts-with:p2', md)

    def test_fail_on_conflict_is_opt_in(self):
        args = ('--repo', self.fx.repo, '--base', 'master', '--no-gh', '--json')
        self.assertEqual(0, run_cli(*args, '--refs', 'p1', 'p2')[0])
        self.assertEqual(1, run_cli(*args, '--refs', 'p1', 'p2', '--fail-on-conflict')[0])
        self.assertEqual(1, run_cli(*args, '--refs', 'conflict_base', '--fail-on-conflict')[0])
        self.assertEqual(0, run_cli(*args, '--refs', 'clean_b', 'i1', '--fail-on-conflict')[0])

    def test_usage_errors_exit_2(self):
        code, _, err = run_cli('--repo', self.fx.repo, '--base', 'no-such-base', '--no-gh')
        self.assertEqual(2, code)
        self.assertIn('--base', err)
        # a plain directory (git must not walk up into some enclosing repository)
        with mock.patch.dict(os.environ, {'GIT_CEILING_DIRECTORIES': os.path.dirname(self.tmp.name)}):
            code, _, err = run_cli('--repo', self.tmp.name, '--no-gh')
        self.assertEqual(2, code)
        self.assertIn('not a git repository', err)
        with self.assertRaises(SystemExit) as cm, contextlib.redirect_stderr(io.StringIO()):
            ip.main(['--no-such-flag'])
        self.assertEqual(2, cm.exception.code)

    def test_fallback_lists_local_branches_ahead_of_base(self):
        code, out, _ = run_cli('--repo', self.fx.repo, '--base', 'master', '--no-gh', '--json')
        self.assertEqual(0, code)
        doc = json.loads(out)
        labels = {r['label'] for r in doc['refs']}
        self.assertIn('p1', labels)
        self.assertNotIn('master', labels)
        self.assertNotIn('already_merged', labels)  # not ahead of base
        self.assertEqual('local branches ahead of base', doc['meta']['ref_source'])

    def test_script_runs_standalone(self):
        r = subprocess.run([sys.executable, str(SCRIPT), '--repo', self.fx.repo, '--base', 'master', '--no-gh',
                            '--refs', 'p1', 'p2'], capture_output=True, text=True, env=os.environ)
        self.assertEqual(0, r.returncode, r.stderr)
        self.assertIn('Integration plan', r.stdout)

    # --- worktrees
    def test_worktree_report_is_report_only(self):
        wt = os.path.join(self.tmp.name, 'wt-stale')
        self.fx.git('worktree', 'add', '-q', wt, 'i1')
        self.addCleanup(self.fx.git, 'worktree', 'remove', '--force', wt)
        wt2 = os.path.join(self.tmp.name, 'wt-active')
        self.fx.git('worktree', 'add', '-q', wt2, 'i2')
        self.addCleanup(self.fx.git, 'worktree', 'remove', '--force', wt2)
        pathlib.Path(wt, 'scratch.txt').write_text('uncommitted\n')
        git = ip.Git(self.fx.repo)
        base_sha = git.out('rev-parse', 'master')
        prs = [{'number': 5, 'head': 'i1', 'state': 'MERGED'}, {'number': 6, 'head': 'i2', 'state': 'OPEN'},
               {'number': 4, 'head': 'i1', 'state': 'CLOSED'}]
        rows = {os.path.basename(r['path']): r for r in ip.worktree_report(git, base_sha, prs)}
        stale, active, main = rows['wt-stale'], rows['wt-active'], rows['repo']
        self.assertEqual('stale-candidate', stale['verdict'])  # newest PR (#5, merged) wins over the closed #4
        self.assertTrue(stale['stale_candidate'] and stale['dirty'])
        self.assertEqual((0, 1), (stale['modified'], stale['untracked']))
        self.assertIn('inspect first', stale['note'])
        self.assertEqual(('active', False), (active['verdict'], active['dirty']))
        self.assertTrue(main['main'])
        self.assertEqual((1, 2), (stale['ahead'], stale['behind']))
        self.assertTrue(stale['last_commit_age'])
        self.assertTrue(os.path.exists(os.path.join(wt, 'scratch.txt')), 'report mode must not delete anything')
        self.assertTrue(os.path.isdir(wt2))
        unknown = {os.path.basename(r['path']): r for r in ip.worktree_report(git, base_sha, None)}
        self.assertEqual('unknown', unknown['wt-stale']['verdict'])

    def test_parsers(self):
        text = 'worktree /a\nHEAD abc\nbranch refs/heads/x/y\n\nworktree /b\nHEAD def\ndetached\nlocked why\n\n'
        a, b = ip.parse_worktree_list(text)
        self.assertEqual(('/a', 'x/y'), (a['path'], a['branch']))
        self.assertTrue(b['detached'] and b['locked'])
        self.assertEqual((2, 1), ip.parse_status_z(' M a.txt\0R  new.txt\0old.txt\0?? u.txt\0!! ignored\0'))
        self.assertEqual((['a b.txt', 'c.txt'], 5), ip.parse_numstat('3\t1\ta b.txt\0-\t-\tc.txt\0'))
        self.assertEqual('3h', ip.fmt_age(3 * 3600 + 5))


if __name__ == '__main__':
    unittest.main()
