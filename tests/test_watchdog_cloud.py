"""Offline tests for tools/watchdog_cloud.py. No network, no gh CLI: GitHub is a fake."""
import datetime as dt
import importlib.util
import pathlib
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('watchdog_cloud', ROOT / 'tools' / 'watchdog_cloud.py')
w = importlib.util.module_from_spec(spec)
sys.modules['watchdog_cloud'] = w          # dataclasses needs the module registered
spec.loader.exec_module(w)

REPO = 'rileybleeker/Onyx'
NOW = dt.datetime(2026, 11, 12, 12, 0, tzinfo=dt.timezone.utc)
REAL_WORKFLOWS = ROOT / '.github' / 'workflows'


def ts(minutes_ago=0, hours_ago=0):
    return w.iso(NOW - dt.timedelta(minutes=minutes_ago, hours=hours_ago))


class FakeGH:
    """Stateful stand-in for GhCli. Reads are routed by longest matching path prefix."""

    def __init__(self):
        self.routes = []
        self.prs = []
        self.sent = []
        self.issues = {}
        self.comments = {}
        self.labels = set()
        self.next_number = 100
        self.fail_post_with_assignees = False

    def on(self, prefix, value):
        self.routes.append((prefix, value))

    def _lookup(self, path):
        best = None
        for prefix, value in self.routes:
            if path.startswith(prefix) and (best is None or len(prefix) >= len(best[0])):
                best = (prefix, value)
        if best is None:
            raise w.GhError(f'no route for {path}', 404)
        return best[1](path) if callable(best[1]) else best[1]

    # -- the interface the watchdog uses
    def get(self, path):
        if path == f'repos/{REPO}':
            return {'default_branch': 'master', 'owner': {'login': 'rileybleeker'}}
        if path.startswith(f'repos/{REPO}/labels/'):
            name = path.rsplit('/', 1)[1]
            if name not in self.labels:
                raise w.GhError('Not Found (HTTP 404)', 404)
            return {'name': name}
        return self._lookup(path)

    def get_all(self, path, key=None):
        if path.startswith(f'repos/{REPO}/issues?labels='):
            label = path.split('labels=')[1].split('&')[0]
            state = path.split('state=')[1].split('&')[0]
            return [i for i in self.issues.values() if label in i['labels']
                    and (state == 'all' or i['state'] == state)]
        if '/issues/' in path and '/comments' in path:
            number = int(path.split('/issues/')[1].split('/')[0])
            return self.comments.get(number, [])
        return self._lookup(path)

    def pr_list(self):
        return self.prs

    def send(self, method, path, body=None):
        self.sent.append((method, path, body))
        if method == 'POST' and path == f'repos/{REPO}/issues':
            if body.get('assignees') and self.fail_post_with_assignees:
                raise w.GhError('Validation Failed (HTTP 422)', 422)
            self.next_number += 1
            issue = {'number': self.next_number, 'state': 'open', 'title': body['title'],
                     'body': body['body'], 'labels': list(body.get('labels', [])), 'created_at': ts()}
            self.issues[issue['number']] = issue
            return issue
        if method == 'PATCH' and '/issues/' in path:
            issue = self.issues[int(path.rsplit('/', 1)[1])]
            issue.update(body)
            return issue
        if method == 'POST' and path.endswith('/comments'):
            number = int(path.split('/issues/')[1].split('/')[0])
            self.comments.setdefault(number, []).append({'body': body['body']})
            return {}
        if method == 'POST' and path == f'repos/{REPO}/labels':
            self.labels.add(body['name'])
            return {}
        return None

    def writes(self):
        return [s for s in self.sent if s[0] != 'GET']


def check_run(name, conclusion='success', status='completed', completed=0, started=None, run_id=1,
              app=15368, head='h' * 40):
    return {'id': run_id, 'name': name, 'status': status, 'conclusion': conclusion if status == 'completed' else None,
            'started_at': started or ts(minutes_ago=completed + 5),
            'completed_at': ts(minutes_ago=completed) if status == 'completed' else None,
            'html_url': f'https://example.test/run/{run_id}', 'app': {'id': app}, 'head_sha': head}


def green(minutes_ago, head='h' * 40):
    return [check_run('offline-checks', completed=minutes_ago, run_id=1, head=head),
            check_run('frontend-types', completed=minutes_ago, run_id=2, head=head)]


def pr(number=1, mss='CLEAN', head='h' * 40, **extra):
    base = {'number': number, 'title': f'PR {number}', 'headRefName': f'feature/{number}', 'headRefOid': head,
            'baseRefName': 'master', 'isDraft': False, 'isCrossRepository': False, 'labels': [],
            'mergeStateStatus': mss, 'mergeable': 'MERGEABLE', 'createdAt': ts(hours_ago=9),
            'updatedAt': ts(), 'url': f'https://example.test/pull/{number}'}
    base.update(extra)
    return base


def make_ctx(fake, state=None, workflows_dir=None, now=NOW):
    state = state or w.State()
    return w.Ctx(gh=fake, repo=REPO, now=now, state=state, tracker=w.Tracker(state.first_seen, now),
                 workflows_dir=workflows_dir or REAL_WORKFLOWS, default_branch='master', owner='rileybleeker')


def keys(findings):
    return sorted(f.key for f in findings)


# ---------------------------------------------------------------------------
class HelperTests(unittest.TestCase):
    def test_code_neutralises_mentions_backticks_and_newlines(self):
        out = w.code('hi @victim `x`\n# heading')
        self.assertEqual(out[0], '`')
        self.assertEqual(out[-1], '`')
        self.assertNotIn('\n', out)
        self.assertEqual(out.count('`'), 2)

    def test_code_truncates(self):
        self.assertLessEqual(len(w.code('a' * 500, 40)), 42)

    def test_ago(self):
        self.assertEqual(w.ago(dt.timedelta(minutes=5)), '5m')
        self.assertEqual(w.ago(dt.timedelta(hours=2, minutes=5)), '2h 05m')
        self.assertEqual(w.ago(dt.timedelta(days=2, hours=3)), '2d 3h')

    def test_tracker_remembers_first_sight_and_forgets_untouched(self):
        t = w.Tracker({'a': ts(hours_ago=3), 'gone': ts(hours_ago=9)}, NOW)
        self.assertEqual(t.since('a'), NOW - dt.timedelta(hours=3))
        self.assertEqual(t.since('b'), NOW)
        self.assertEqual(sorted(t.dump()), ['a', 'b'])
        t.keep_previous = True
        self.assertEqual(sorted(t.dump()), ['a', 'b', 'gone'])

    def test_state_round_trip_and_garbage(self):
        s = w.State(first_run=ts(), first_seen={'k': ts()}, announced=['x'], last_comment_at=ts(),
                    dispatched={'a.yml': ts()}, enabled={'b.yml': ts()})
        self.assertEqual(w.State.from_body(s.to_body()), s)
        self.assertEqual(w.State.from_body('nothing here'), w.State())
        self.assertEqual(w.State.from_body(f'{w.STATE_BEGIN}\n```json\n{{oops\n```\n{w.STATE_END}'), w.State())


class CronTests(unittest.TestCase):
    def test_nominal_gaps(self):
        self.assertEqual(w.nominal_gap(['0 * * * *']), dt.timedelta(hours=1))
        self.assertEqual(w.nominal_gap(['25 */3 * * *']), dt.timedelta(hours=3))
        self.assertEqual(w.nominal_gap(['30 2 * * *', '0 16 * * *']), dt.timedelta(hours=13, minutes=30))
        self.assertEqual(w.nominal_gap(['0 12 * * 1']), dt.timedelta(days=7))
        self.assertEqual(w.nominal_gap(['0 13 1 * *']), dt.timedelta(days=31))
        self.assertEqual(w.nominal_gap(['0 */6 * * *']), dt.timedelta(hours=6))
        self.assertIsNone(w.nominal_gap([]))

    def test_workflow_crons_ignores_comments_and_trailing_text(self):
        text = ("on:\n  schedule:\n    - cron: '50 3 * * *'   # 23:50 EDT\n"
                "#   - cron: '15 * * * *'\n    - cron: \"0 12 * * 1\"\n")
        self.assertEqual(w.workflow_crons(text), ['50 3 * * *', '0 12 * * 1'])

    def test_has_workflow_dispatch_ignores_comments(self):
        self.assertTrue(w.has_workflow_dispatch('on:\n  workflow_dispatch: # manual\n'))
        self.assertFalse(w.has_workflow_dispatch('on:\n  # workflow_dispatch:\n  push:\n'))


class AllowListConsistencyTests(unittest.TestCase):
    """The table must stay in step with the real workflow files."""

    def setUp(self):
        self.files = w.read_workflow_files(REAL_WORKFLOWS)

    def test_every_scheduled_workflow_is_listed_or_exempt(self):
        scheduled = {n for n, t in self.files.items() if w.workflow_crons(t)}
        unlisted = scheduled - set(w.SCHEDULED) - set(w.EXEMPT_SCHEDULED)
        self.assertEqual(unlisted, set(), 'add these to SCHEDULED or EXEMPT_SCHEDULED in tools/watchdog_cloud.py')

    def test_every_listed_workflow_exists_and_is_scheduled(self):
        for name in w.SCHEDULED:
            self.assertIn(name, self.files, f'{name} is in SCHEDULED but the file is gone')
            self.assertTrue(w.workflow_crons(self.files[name]), f'{name} no longer has a schedule')

    def test_recoverable_workflows_have_workflow_dispatch(self):
        for name, spec in w.SCHEDULED.items():
            if spec.recover:
                self.assertTrue(w.has_workflow_dispatch(self.files[name]), f'{name} cannot be dispatched')

    def test_max_gap_is_above_cron_gap_with_bounded_slack(self):
        for name, spec in w.SCHEDULED.items():
            nominal = w.nominal_gap(w.workflow_crons(self.files[name]))
            self.assertGreater(spec.max_gap, nominal, name)
            self.assertLessEqual(spec.max_gap, nominal * 2 + dt.timedelta(hours=1), f'{name}: gap far too loose')

    def test_exempt_and_listed_do_not_overlap_and_have_reasons(self):
        self.assertEqual(set(w.SCHEDULED) & set(w.EXEMPT_SCHEDULED), set())
        for name, why in w.EXEMPT_SCHEDULED.items():
            self.assertTrue(why.strip(), name)

    def test_no_drift_in_real_repo(self):
        self.assertEqual(w.config_drift(self.files), [])

    def test_drift_detects_unlisted_schedule_and_missing_dispatch(self):
        files = dict(self.files)
        files['new-job.yml'] = "on:\n  schedule:\n    - cron: '0 * * * *'\n"
        files['keepalive.yml'] = "on:\n  schedule:\n    - cron: '0 12 * * 1'\n"
        problems = ' | '.join(w.config_drift(files))
        self.assertIn('new-job.yml has a schedule but is not in', problems)
        self.assertIn('keepalive.yml is marked recoverable but has no workflow_dispatch', problems)

    def test_every_flag_only_entry_says_why(self):
        for name, spec in w.SCHEDULED.items():
            if not spec.recover:
                self.assertTrue(spec.no_recovery.strip(), f'{name} is flag-only but gives no reason')

    def test_expected_recovery_policy(self):
        self.assertFalse(w.SCHEDULED['monthly-audit.yml'].recover)
        self.assertFalse(w.SCHEDULED['live-checks.yml'].recover)        # touches the production database
        self.assertTrue(w.SCHEDULED['merge-train.yml'].recover)
        self.assertFalse(w.SCHEDULED['hrv-retrain-on-backfill.yml'].recover)
        self.assertTrue(w.SCHEDULED['daily-etl.yml'].recover)


# ---------------------------------------------------------------------------
def hb_comment(at, ok=True, stalled=0, assoc='OWNER', raw=None):
    body = raw or f'heartbeat:v1\n{{"at":"{at}","ok":{str(ok).lower()},"stalled":{stalled}}}'
    return {'body': body, 'author_association': assoc, 'updated_at': at, 'created_at': at}


class HeartbeatTests(unittest.TestCase):
    def fake(self, comments=None, issue=True, watchdog_created=None):
        f = FakeGH()
        if issue:
            f.issues[7] = {'number': 7, 'state': 'open', 'title': 'PC runner heartbeat', 'body': '',
                           'labels': [w.HEARTBEAT_LABEL], 'created_at': ts(hours_ago=50)}
            f.comments[7] = comments or []
        wf = [] if watchdog_created is None else [
            {'id': 1, 'name': 'Watchdog', 'path': '.github/workflows/watchdog.yml', 'state': 'active',
             'created_at': watchdog_created}]
        f.on(f'repos/{REPO}/actions/workflows?', wf)
        return f

    def run_check(self, fake, state=None):
        ctx = make_ctx(fake, state)
        return w.check_heartbeat(ctx), ctx

    def test_parse_good_and_bad(self):
        ok = w.parse_heartbeat('heartbeat:v1\n{"at":"2026-11-12T11:55:00Z","ok":true,"stalled":0}')
        self.assertTrue(ok['ok'])
        self.assertEqual(ok['at'].minute, 55)
        for bad in ['hello', 'heartbeat:v2\n{}', 'heartbeat:v1\nnot json', 'heartbeat:v1\n[1]',
                    'heartbeat:v1\n{"at":"2026-11-12T11:55:00Z","ok":"yes","stalled":0}',
                    'heartbeat:v1\n{"at":"2026-11-12T11:55:00Z","ok":true,"stalled":-1}',
                    'heartbeat:v1\n{"at":"2026-11-12T11:55:00Z","ok":true,"stalled":true}',
                    'heartbeat:v1\n{"at":"yesterday","ok":true,"stalled":0}',
                    'heartbeat:v1\n{"ok":true,"stalled":0}']:
            with self.assertRaises(ValueError, msg=bad):
                w.parse_heartbeat(bad)

    def test_fresh_ok_heartbeat_is_quiet(self):
        found, _ = self.run_check(self.fake([hb_comment(ts(minutes_ago=10))]))
        self.assertEqual(found, [])

    def test_stale_after_45_minutes(self):
        found, _ = self.run_check(self.fake([hb_comment(ts(minutes_ago=46))]))
        self.assertEqual(keys(found), ['runner-heartbeat-stale'])
        found, _ = self.run_check(self.fake([hb_comment(ts(minutes_ago=44))]))
        self.assertEqual(found, [])

    def test_ok_false_and_stalled(self):
        found, _ = self.run_check(self.fake([hb_comment(ts(minutes_ago=5), ok=False, stalled=2)]))
        self.assertEqual(keys(found), ['runner-not-ok', 'runner-stalled'])

    def test_stale_heartbeat_does_not_also_report_old_ok_false(self):
        found, _ = self.run_check(self.fake([hb_comment(ts(hours_ago=3), ok=False, stalled=4)]))
        self.assertEqual(keys(found), ['runner-heartbeat-stale'])

    def test_unreadable_comment(self):
        found, _ = self.run_check(self.fake([hb_comment(ts(), raw='heartbeat:v1\n{broken')]))
        self.assertEqual(keys(found), ['runner-heartbeat-unreadable'])

    def test_stranger_cannot_fake_a_fresh_heartbeat(self):
        comments = [hb_comment(ts(hours_ago=3)), hb_comment(ts(minutes_ago=1), assoc='NONE')]
        found, _ = self.run_check(self.fake(comments))
        self.assertEqual(keys(found), ['runner-heartbeat-stale'])

    def test_newest_trusted_comment_wins(self):
        comments = [hb_comment(ts(hours_ago=3)), hb_comment(ts(minutes_ago=2))]
        found, _ = self.run_check(self.fake(comments))
        self.assertEqual(found, [])

    def test_never_reported_inside_grace_period_is_quiet(self):
        found, ctx = self.run_check(self.fake(issue=False, watchdog_created=ts(hours_ago=23)))
        self.assertEqual(found, [])
        self.assertTrue(any('grace' in line for line in ctx.watching))

    def test_never_reported_after_24h_is_flagged(self):
        found, _ = self.run_check(self.fake(issue=False, watchdog_created=ts(hours_ago=25)))
        self.assertEqual(keys(found), ['runner-heartbeat-missing'])

    def test_issue_without_comment_after_24h_is_flagged(self):
        found, _ = self.run_check(self.fake(comments=[], watchdog_created=ts(hours_ago=30)))
        self.assertEqual(keys(found), ['runner-heartbeat-missing'])

    def test_unknown_watchdog_age_never_flags_on_day_one(self):
        found, _ = self.run_check(self.fake(issue=False))
        self.assertEqual(found, [])

    def test_falls_back_to_state_first_run(self):
        found, _ = self.run_check(self.fake(issue=False), w.State(first_run=ts(hours_ago=30)))
        self.assertEqual(keys(found), ['runner-heartbeat-missing'])


# ---------------------------------------------------------------------------
class PrCheckTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeGH()

    def checks_for(self, runs, head='h' * 40):
        self.fake.on(f'repos/{REPO}/commits/{head}/check-runs', runs)

    def run_check(self, state=None):
        ctx = make_ctx(self.fake, state)
        return w.check_prs(ctx), ctx

    def test_merge_stall_after_20_minutes(self):
        self.fake.prs = [pr(1, 'CLEAN')]
        self.checks_for(green(30))
        found, _ = self.run_check()
        self.assertEqual(keys(found), ['merge-stall:pr-1'])
        self.assertIn('gh pr merge 1', found[0].next_step)
        self.assertIn('RileyPC', found[0].next_step)

    def test_green_for_less_than_20_minutes_is_only_watched(self):
        self.fake.prs = [pr(1, 'CLEAN')]
        self.checks_for(green(10))
        found, ctx = self.run_check()
        self.assertEqual(found, [])
        self.assertTrue(any('PR #1' in line for line in ctx.watching))

    def test_unstable_counts_as_mergeable(self):
        self.fake.prs = [pr(1, 'UNSTABLE')]
        self.checks_for(green(40))
        self.assertEqual(keys(self.run_check()[0]), ['merge-stall:pr-1'])

    def test_blocked_unknown_and_dirty_are_not_merge_stalls(self):
        for mss in ('BLOCKED', 'UNKNOWN', 'DIRTY', 'BEHIND'):
            self.fake.prs = [pr(1, mss)]
            self.checks_for(green(90))
            self.assertNotIn('merge-stall:pr-1', keys(self.run_check()[0]), mss)

    def test_hold_draft_fork_and_other_base_are_skipped(self):
        self.checks_for(green(90))
        self.fake.prs = [
            pr(1, labels=[{'name': 'hold'}]), pr(2, isDraft=True), pr(3, isCrossRepository=True),
            pr(4, baseRefName='release')]
        found, ctx = self.run_check()
        self.assertEqual(found, [])
        self.assertTrue(any('hold' in line for line in ctx.watching))

    def test_red_for_more_than_6_hours(self):
        self.fake.prs = [pr(1, 'UNSTABLE')]
        self.checks_for([check_run('offline-checks', 'failure', completed=7 * 60, run_id=1),
                         check_run('frontend-types', completed=7 * 60, run_id=2)])
        found, _ = self.run_check()
        self.assertEqual(keys(found), ['pr-red:pr-1'])
        self.assertIn('offline-checks', found[0].detail)

    def test_red_for_less_than_6_hours_is_only_watched(self):
        self.fake.prs = [pr(1, 'UNSTABLE')]
        self.checks_for([check_run('offline-checks', 'failure', completed=5 * 60, run_id=1),
                         check_run('frontend-types', completed=5 * 60, run_id=2)])
        found, ctx = self.run_check()
        self.assertEqual(found, [])
        self.assertTrue(any('red since' in line for line in ctx.watching))

    def test_a_rerun_that_passed_replaces_the_old_failure(self):
        self.fake.prs = [pr(1, 'CLEAN')]
        self.checks_for([check_run('offline-checks', 'failure', completed=9 * 60, run_id=1),
                         check_run('offline-checks', completed=60, run_id=5),
                         check_run('frontend-types', completed=60, run_id=2)])
        self.assertEqual(keys(self.run_check()[0]), ['merge-stall:pr-1'])

    def test_pending_more_than_45_minutes(self):
        self.fake.prs = [pr(1, 'BLOCKED')]
        self.checks_for([check_run('offline-checks', completed=50, run_id=1),
                         check_run('frontend-types', status='in_progress', started=ts(minutes_ago=50), run_id=2)])
        found, _ = self.run_check()
        self.assertEqual(keys(found), ['pr-pending:pr-1'])
        self.assertIn('frontend-types (pending)', found[0].detail)

    def test_pending_under_45_minutes_is_quiet(self):
        self.fake.prs = [pr(1, 'BLOCKED')]
        self.checks_for([check_run('offline-checks', status='queued', started=ts(minutes_ago=20), run_id=1),
                         check_run('frontend-types', status='in_progress', started=ts(minutes_ago=20), run_id=2)])
        self.assertEqual(self.run_check()[0], [])

    def test_missing_checks_use_the_head_commit_date(self):
        self.fake.prs = [pr(1, 'BLOCKED')]
        self.checks_for([])
        self.fake.on(f'repos/{REPO}/commits/{"h" * 40}', {'commit': {'committer': {'date': ts(hours_ago=2)}}})
        self.assertEqual(keys(self.run_check()[0]), ['pr-pending:pr-1'])

    def test_check_from_another_app_does_not_count(self):
        self.fake.prs = [pr(1, 'CLEAN')]
        self.checks_for([check_run('offline-checks', completed=90, app=999, run_id=1),
                         check_run('frontend-types', completed=90, run_id=2)])
        self.fake.on(f'repos/{REPO}/commits/{"h" * 40}', {'commit': {'committer': {'date': ts(hours_ago=2)}}})
        found, _ = self.run_check()
        self.assertEqual(keys(found), ['pr-pending:pr-1'])

    def test_conflict_needs_two_hours_of_observation(self):
        self.fake.prs = [pr(1, 'DIRTY')]
        self.checks_for(green(600))
        found, ctx = self.run_check()
        self.assertEqual(found, [])                          # first sight: starts the clock
        self.assertIn('pr-conflict:pr-1', ctx.tracker.dump())
        older = w.State(first_seen={'pr-conflict:pr-1': ts(hours_ago=3)})
        self.fake.on(f'repos/{REPO}/pulls/1/files', [{'filename': 'src/a.ts'}, {'filename': 'src/b.ts'}])
        self.fake.prs.append(pr(2, 'CLEAN', head='i' * 40))
        self.checks_for(green(5, head='i' * 40), head='i' * 40)
        self.fake.on(f'repos/{REPO}/pulls/2/files', [{'filename': 'src/b.ts'}, {'filename': 'src/z.ts'}])
        self.fake.on(f'repos/{REPO}/pulls?state=closed', [
            {'number': 9, 'merged_at': ts(hours_ago=5), 'base': {'ref': 'master'}},
            {'number': 8, 'merged_at': ts(hours_ago=90), 'base': {'ref': 'master'}}])
        self.fake.on(f'repos/{REPO}/pulls/9/files', [{'filename': 'src/a.ts'}])
        self.fake.on(f'repos/{REPO}/pulls/8/files', [{'filename': 'src/b.ts'}])
        found, _ = self.run_check(older)
        conflict = [f for f in found if f.key == 'pr-conflict:pr-1']
        self.assertEqual(len(conflict), 1)
        self.assertEqual(conflict[0].since, NOW - dt.timedelta(hours=3))
        self.assertIn('open PR #2', conflict[0].detail)
        self.assertIn('src/b.ts', conflict[0].detail)
        self.assertIn('recently merged PR #9', conflict[0].detail)
        self.assertNotIn('#8', conflict[0].detail)            # merged too long ago

    def test_conflict_without_overlap_says_master_moved(self):
        self.fake.prs = [pr(1, 'DIRTY')]
        self.checks_for(green(600))
        self.fake.on(f'repos/{REPO}/pulls/1/files', [{'filename': 'only/mine.ts'}])
        self.fake.on(f'repos/{REPO}/pulls?state=closed', [])
        found, _ = self.run_check(w.State(first_seen={'pr-conflict:pr-1': ts(hours_ago=3)}))
        self.assertIn('master itself moved', found[0].detail)

    def test_behind_green_pr_after_three_hours(self):
        self.fake.prs = [pr(1, 'BEHIND')]
        self.checks_for(green(600))
        self.assertEqual(self.run_check()[0], [])
        found, _ = self.run_check(w.State(first_seen={'pr-behind:pr-1': ts(hours_ago=2, minutes_ago=30)}))
        self.assertEqual(found, [])
        found, _ = self.run_check(w.State(first_seen={'pr-behind:pr-1': ts(hours_ago=3, minutes_ago=5)}))
        self.assertEqual(keys(found), ['pr-behind:pr-1'])

    def test_merge_stall_mentions_a_halted_train(self):
        self.fake.prs = [pr(1, 'CLEAN')]
        self.checks_for(green(30))
        self.fake.issues[36] = {'number': 36, 'state': 'open', 'title': 'halt', 'body': '',
                                'labels': [w.TRAIN_HALT_LABEL], 'created_at': ts(minutes_ago=30)}
        found, _ = self.run_check()
        self.assertIn('halted by issue #36', found[0].detail)
        self.assertIn('Merge train', found[0].next_step)

    def test_titles_are_rendered_as_inline_code(self):
        self.fake.prs = [pr(1, 'CLEAN', title='ping @victim `now`')]
        self.checks_for(green(60))
        found, _ = self.run_check()
        self.assertIn('`ping @victim \'now\'`', found[0].title)


# ---------------------------------------------------------------------------
def run_obj(conclusion, minutes_ago, run_id, event='push', status='completed'):
    return {'id': run_id, 'conclusion': conclusion, 'status': status, 'event': event,
            'created_at': ts(minutes_ago=minutes_ago), 'updated_at': ts(minutes_ago=minutes_ago - 3),
            'html_url': f'https://example.test/actions/runs/{run_id}'}


class MasterHealthTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeGH()
        self.fake.on(f'repos/{REPO}/actions/workflows?', [])

    def runs(self, workflow, runs):
        self.fake.on(f'repos/{REPO}/actions/workflows/{workflow}/runs', {'workflow_runs': runs})

    def check(self):
        self.runs('autonomous-ci.yml', [run_obj('success', 10, 1)])
        self.runs('smoke-test.yml', [run_obj('success', 10, 2)])
        return None

    def test_all_green_is_quiet(self):
        self.check()
        self.fake.issues = {}
        self.assertEqual(w.check_master(make_ctx(self.fake)), [])

    def test_autonomous_ci_failure_on_master(self):
        self.runs('autonomous-ci.yml', [run_obj('failure', 20, 1), run_obj('success', 200, 0)])
        self.runs('smoke-test.yml', [])
        self.assertEqual(keys(w.check_master(make_ctx(self.fake))), ['master-ci-failed'])

    def test_newer_success_clears_it_and_cancelled_runs_are_ignored(self):
        self.runs('autonomous-ci.yml', [run_obj('cancelled', 5, 3), run_obj('success', 20, 2), run_obj('failure', 90, 1)])
        self.runs('smoke-test.yml', [])
        self.assertEqual(w.check_master(make_ctx(self.fake)), [])

    def test_cancelled_run_does_not_hide_a_failure(self):
        self.runs('autonomous-ci.yml', [run_obj('cancelled', 5, 3), run_obj('failure', 20, 2)])
        self.runs('smoke-test.yml', [])
        self.assertEqual(keys(w.check_master(make_ctx(self.fake))), ['master-ci-failed'])

    def test_smoke_failing_twice_but_not_once(self):
        self.runs('autonomous-ci.yml', [])
        self.runs('smoke-test.yml', [run_obj('failure', 30, 2, 'schedule'), run_obj('failure', 400, 1, 'schedule')])
        self.assertEqual(keys(w.check_master(make_ctx(self.fake))), ['smoke-failed-twice'])
        self.runs('smoke-test.yml', [run_obj('failure', 30, 2, 'schedule'), run_obj('success', 400, 1, 'schedule')])
        self.assertEqual(w.check_master(make_ctx(self.fake)), [])
        self.runs('smoke-test.yml', [run_obj('failure', 30, 2, 'schedule')])
        self.assertEqual(w.check_master(make_ctx(self.fake)), [])

    def test_live_db_checks_found_by_real_name_or_file(self):
        self.runs('autonomous-ci.yml', [])
        self.runs('smoke-test.yml', [])
        for entry in ({'id': 55, 'name': 'Live DB Checks', 'state': 'active', 'path': '.github/workflows/other.yml'},
                      {'id': 55, 'name': 'renamed', 'state': 'active', 'path': '.github/workflows/live-checks.yml'}):
            self.fake.routes = [r for r in self.fake.routes if not r[0].endswith('workflows?')]
            self.fake.on(f'repos/{REPO}/actions/workflows?', [entry])
            self.runs('55', [run_obj('failure', 15, 7, 'schedule')])
            found = w.check_master(make_ctx(self.fake))
            self.assertEqual(keys(found), ['live-checks-failed'])
            self.assertIn('Live DB Checks', found[0].title)

    def test_live_checks_absent_is_ignored_present_and_failing_is_flagged(self):
        self.runs('autonomous-ci.yml', [])
        self.runs('smoke-test.yml', [])
        self.assertEqual(w.check_master(make_ctx(self.fake)), [])
        self.fake.routes = [r for r in self.fake.routes if not r[0].endswith('workflows?')]
        self.fake.on(f'repos/{REPO}/actions/workflows?', [{'id': 55, 'name': 'Live DB Checks', 'state': 'active',
                                                              'path': '.github/workflows/live-checks.yml'}])
        self.runs('55', [run_obj('failure', 15, 7, 'schedule')])
        self.assertEqual(keys(w.check_master(make_ctx(self.fake))), ['live-checks-failed'])

    def test_train_halt_issue_and_rollback_pr(self):
        self.runs('autonomous-ci.yml', [])
        self.runs('smoke-test.yml', [])
        self.fake.issues[36] = {'number': 36, 'state': 'open', 'title': 'Release x failed: train halted',
                                'body': '', 'labels': [w.TRAIN_HALT_LABEL], 'created_at': ts(minutes_ago=30)}
        self.fake.issues[37] = {'number': 37, 'state': 'closed', 'title': 'old halt', 'body': '',
                                'labels': [w.TRAIN_HALT_LABEL], 'created_at': ts(hours_ago=30)}
        self.fake.prs = [pr(40, headRefName='rollback/55c2601'), pr(41, headRefName='feature/x'),
                         pr(42, headRefName='rollback/evil', isCrossRepository=True)]
        self.assertEqual(keys(w.check_master(make_ctx(self.fake))), ['rollback-pr:pr-40', 'train-halt:issue-36'])


# ---------------------------------------------------------------------------
def workflow_entries(overrides=None, missing=()):
    overrides = overrides or {}
    out = []
    for i, (file, spec) in enumerate(w.SCHEDULED.items(), 1):
        if file in missing:
            continue
        out.append({'id': 1000 + i, 'name': spec.name, 'path': f'.github/workflows/{file}',
                    'state': overrides.get(file, 'active'), 'created_at': ts(hours_ago=24 * 90)})
    return out


class ScheduledTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeGH()

    def setup_runs(self, stale=None, minutes_ago=5):
        stale = stale or {}
        self.fake.on(f'repos/{REPO}/actions/workflows/', {'workflow_runs': [run_obj('success', minutes_ago, 1, 'schedule')]})
        for file, age in stale.items():
            runs = [] if age is None else [run_obj('success', age, 2, 'schedule')]
            self.fake.on(f'repos/{REPO}/actions/workflows/{file}/runs', {'workflow_runs': runs})

    def check(self, entries, state=None, workflows_dir=None):
        self.fake.on(f'repos/{REPO}/actions/workflows?', entries)
        ctx = make_ctx(self.fake, state, workflows_dir)
        return w.check_scheduled(ctx), ctx

    def test_everything_fresh_is_quiet(self):
        self.setup_runs()
        found, ctx = self.check(workflow_entries())
        self.assertEqual((found, ctx.actions), ([], []))

    def test_stale_hourly_workflow_is_flagged_and_dispatch_planned(self):
        self.setup_runs({'spotify-etl.yml': 3 * 60})
        found, ctx = self.check(workflow_entries())
        self.assertEqual(keys(found), ['sched-stale:spotify-etl.yml'])
        self.assertEqual([(a.kind, a.file) for a in ctx.actions], [('dispatch', 'spotify-etl.yml')])

    def test_just_inside_the_gap_is_quiet(self):
        self.setup_runs({'spotify-etl.yml': 149})
        self.assertEqual(self.check(workflow_entries())[0], [])

    def test_workflow_with_no_runs_uses_its_creation_time(self):
        self.setup_runs({'spotify-etl.yml': None})
        found, _ = self.check(workflow_entries())
        self.assertEqual(keys(found), ['sched-stale:spotify-etl.yml'])
        entries = workflow_entries()
        for e in entries:
            if e['path'].endswith('spotify-etl.yml'):
                e['created_at'] = ts(minutes_ago=30)
        self.assertEqual(self.check(entries)[0], [])

    def test_flag_only_workflows_are_never_dispatched(self):
        self.setup_runs({'monthly-audit.yml': 40 * 24 * 60, 'hrv-retrain-on-backfill.yml': 5 * 60})
        found, ctx = self.check(workflow_entries())
        self.assertEqual(keys(found), ['sched-stale:hrv-retrain-on-backfill.yml', 'sched-stale:monthly-audit.yml'])
        self.assertEqual(ctx.actions, [])
        self.assertIn('it writes to Supabase', found[1].next_step)

    def test_disabled_workflow_is_flagged_and_enable_planned(self):
        self.setup_runs()
        found, ctx = self.check(workflow_entries({'habits-sync.yml': 'disabled_inactivity'}))
        self.assertEqual(keys(found), ['sched-disabled:habits-sync.yml'])
        self.assertEqual([(a.kind, a.file) for a in ctx.actions], [('enable', 'habits-sync.yml')])

    def test_manually_disabled_workflow_is_a_brake_and_is_left_alone(self):
        self.setup_runs({'merge-train.yml': 5 * 60})
        found, ctx = self.check(workflow_entries({'merge-train.yml': 'disabled_manually'}))
        self.assertEqual(keys(found), ['sched-disabled:merge-train.yml'])     # flagged, but no stale finding
        self.assertEqual(ctx.actions, [])                                     # never re-enabled or dispatched
        self.assertIn('documented brake', found[0].detail)

    def test_disabled_and_stale_plans_enable_then_dispatch(self):
        self.setup_runs({'habits-sync.yml': 20 * 60})
        found, ctx = self.check(workflow_entries({'habits-sync.yml': 'disabled_inactivity'}))
        self.assertEqual(keys(found), ['sched-disabled:habits-sync.yml', 'sched-stale:habits-sync.yml'])
        self.assertEqual({(a.kind, a.needs_enable) for a in ctx.actions}, {('enable', False), ('dispatch', True)})

    def test_file_without_workflow_dispatch_is_flag_only(self):
        self.setup_runs({'spotify-etl.yml': 5 * 60})
        with tempfile.TemporaryDirectory() as d:
            (pathlib.Path(d) / 'spotify-etl.yml').write_text("on:\n  schedule:\n    - cron: '50 * * * *'\n")
            found, ctx = self.check(workflow_entries(), workflows_dir=pathlib.Path(d))
        self.assertEqual(keys(found), ['sched-stale:spotify-etl.yml'])
        self.assertEqual(ctx.actions, [])
        self.assertIn('gh workflow run spotify-etl.yml', found[0].next_step)

    def test_workflows_missing_from_the_repo_are_skipped(self):
        self.setup_runs()
        found, ctx = self.check(workflow_entries(missing=('tanita-etl.yml',)))
        self.assertEqual((found, ctx.actions), ([], []))

    def test_unlisted_workflows_are_never_looked_at(self):
        self.setup_runs()
        entries = workflow_entries() + [{'id': 5, 'name': 'Random', 'path': '.github/workflows/random.yml',
                                          'state': 'disabled_manually', 'created_at': ts(hours_ago=999)}]
        found, ctx = self.check(entries)
        self.assertEqual((found, ctx.actions), ([], []))

    def test_config_drift_finding(self):
        with tempfile.TemporaryDirectory() as d:
            (pathlib.Path(d) / 'new-job.yml').write_text("on:\n  schedule:\n    - cron: '0 * * * *'\n")
            ctx = make_ctx(self.fake, workflows_dir=pathlib.Path(d))
            found = w.check_config_drift(ctx)
        self.assertEqual(keys(found), ['watchdog-config-drift'])
        self.assertEqual(w.check_config_drift(make_ctx(self.fake)), [])


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeGH()

    def plan(self, *actions, state=None):
        ctx = make_ctx(self.fake, state)
        ctx.actions = list(actions)
        findings = [w.Finding(a.finding_key, 't', 'd', 'n') for a in actions]
        return ctx, findings

    def dispatch(self, file='spotify-etl.yml', needs_enable=False):
        return w.Action('dispatch', file, 1, f'sched-stale:{file}', needs_enable)

    def test_dispatch_sends_post_with_default_branch_and_is_recorded(self):
        ctx, findings = self.plan(self.dispatch())
        w.execute_actions(ctx, findings, False, lambda s: None)
        self.assertEqual(self.fake.writes(), [
            ('POST', f'repos/{REPO}/actions/workflows/spotify-etl.yml/dispatches', {'ref': 'master'})])
        self.assertEqual(ctx.state.dispatched['spotify-etl.yml'], w.iso(NOW))
        self.assertIn('dispatch sent', findings[0].notes[0])

    def test_second_dispatch_within_six_hours_is_suppressed(self):
        state = w.State(dispatched={'spotify-etl.yml': ts(hours_ago=5)})
        ctx, findings = self.plan(self.dispatch(), state=state)
        w.execute_actions(ctx, findings, False, lambda s: None)
        self.assertEqual(self.fake.writes(), [])
        self.assertIn('suppressed', findings[0].notes[0])

    def test_dispatch_allowed_again_after_six_hours(self):
        state = w.State(dispatched={'spotify-etl.yml': ts(hours_ago=6, minutes_ago=1)})
        ctx, findings = self.plan(self.dispatch(), state=state)
        w.execute_actions(ctx, findings, False, lambda s: None)
        self.assertEqual(len(self.fake.writes()), 1)

    def test_limit_is_per_workflow(self):
        state = w.State(dispatched={'spotify-etl.yml': ts(hours_ago=1)})
        ctx, findings = self.plan(self.dispatch(), self.dispatch('habits-sync.yml'), state=state)
        w.execute_actions(ctx, findings, False, lambda s: None)
        self.assertEqual([p for _, p, _ in self.fake.writes()],
                         [f'repos/{REPO}/actions/workflows/habits-sync.yml/dispatches'])

    def test_allow_list_is_enforced_at_execution_time(self):
        rogue = w.Action('dispatch', 'autonomous-ci.yml', 1, 'sched-stale:autonomous-ci.yml')
        flag_only = w.Action('dispatch', 'monthly-audit.yml', 2, 'sched-stale:monthly-audit.yml')
        weird = w.Action('delete', 'spotify-etl.yml', 3, 'sched-stale:spotify-etl.yml')
        ctx, findings = self.plan(rogue, flag_only, weird)
        w.execute_actions(ctx, findings, False, lambda s: None)
        self.assertEqual(self.fake.writes(), [])
        self.assertTrue(all('refused' in f.notes[0] for f in findings))

    def test_enable_goes_first_then_dispatch(self):
        enable = w.Action('enable', 'habits-sync.yml', 77, 'sched-disabled:habits-sync.yml')
        ctx, findings = self.plan(self.dispatch('habits-sync.yml', needs_enable=True), enable)
        w.execute_actions(ctx, findings, False, lambda s: None)
        self.assertEqual([(m, p) for m, p, _ in self.fake.writes()], [
            ('PUT', f'repos/{REPO}/actions/workflows/77/enable'),
            ('POST', f'repos/{REPO}/actions/workflows/habits-sync.yml/dispatches')])

    def test_dispatch_deferred_when_enable_is_rate_limited(self):
        enable = w.Action('enable', 'habits-sync.yml', 77, 'sched-disabled:habits-sync.yml')
        state = w.State(enabled={'habits-sync.yml': ts(hours_ago=1)})
        ctx, findings = self.plan(self.dispatch('habits-sync.yml', needs_enable=True), enable, state=state)
        w.execute_actions(ctx, findings, False, lambda s: None)
        self.assertEqual(self.fake.writes(), [])

    def test_failed_dispatch_is_reported_and_counts_against_the_limit(self):
        def boom(method, path, body=None):
            raise w.GhError('Workflow does not have workflow_dispatch (HTTP 422)', 422)
        self.fake.send = boom
        ctx, findings = self.plan(self.dispatch())
        w.execute_actions(ctx, findings, False, lambda s: None)
        self.assertIn('recovery failed', findings[0].notes[0])
        self.assertIn('spotify-etl.yml', ctx.state.dispatched)

    def test_dry_run_writes_nothing_and_records_nothing(self):
        said = []
        ctx, findings = self.plan(self.dispatch())
        w.execute_actions(ctx, findings, True, said.append)
        self.assertEqual(self.fake.writes(), [])
        self.assertEqual(ctx.state.dispatched, {})
        self.assertTrue(any('would dispatch' in s for s in said))


# ---------------------------------------------------------------------------
def finding(key, title='something wrong'):
    return w.Finding(key, title, 'detail', 'do this', since=NOW - dt.timedelta(hours=1))


class AlertTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeGH()
        self.fake.labels = {w.ALERT_LABEL, w.STATE_LABEL, w.HEARTBEAT_LABEL}
        self.state = w.State()

    def reconcile(self, findings, now=NOW, dry_run=False):
        ctx = make_ctx(self.fake, self.state, now=now)
        w.reconcile_alerts(ctx, findings, w.Writer(self.fake, dry_run, lambda s: None))
        return ctx

    def alert(self):
        return [i for i in self.fake.issues.values() if w.ALERT_LABEL in i['labels']][0]

    def comments(self):
        return [c['body'] for c in self.fake.comments.get(self.alert()['number'], [])]

    def test_first_findings_create_one_labelled_assigned_issue(self):
        self.reconcile([finding('a'), finding('b')])
        issue = self.alert()
        self.assertEqual(issue['title'], 'Watchdog: 2 finding(s)')
        self.assertIn('`a`', issue['body'])
        created = [s for s in self.fake.writes() if s[1] == f'repos/{REPO}/issues'][0]
        self.assertEqual(created[2]['assignees'], ['rileybleeker'])
        self.assertEqual(created[2]['labels'], [w.ALERT_LABEL])
        self.assertEqual(self.state.announced, ['a', 'b'])
        self.assertEqual(self.comments(), [])

    def test_unassignable_owner_falls_back_to_plain_create(self):
        self.fake.fail_post_with_assignees = True
        self.reconcile([finding('a')])
        self.assertEqual(len([i for i in self.fake.issues.values()]), 1)

    def test_same_keys_do_not_comment_or_rewrite(self):
        self.reconcile([finding('a')])
        before = len(self.fake.writes())
        self.reconcile([finding('a')], now=NOW + dt.timedelta(minutes=30))
        self.assertEqual(len(self.fake.writes()), before)

    def test_new_key_adds_a_comment_that_mentions_the_owner(self):
        self.reconcile([finding('a')])
        self.reconcile([finding('a'), finding('b')], now=NOW + dt.timedelta(minutes=30))
        self.assertEqual(len(self.comments()), 1)
        self.assertIn('@rileybleeker', self.comments()[0])
        self.assertIn('`b`', self.comments()[0])
        self.assertNotIn('`a`', self.comments()[0])
        self.assertEqual(self.alert()['title'], 'Watchdog: 2 finding(s)')

    def test_comment_rate_limit_one_per_hour_then_catches_up(self):
        self.reconcile([finding('a')])
        self.reconcile([finding('a'), finding('b')], now=NOW + dt.timedelta(minutes=10))
        self.reconcile([finding('a'), finding('b'), finding('c')], now=NOW + dt.timedelta(minutes=40))
        self.assertEqual(len(self.comments()), 1)                   # c is held back
        self.assertIn('`c`', self.alert()['body'])                  # but the body is current
        self.reconcile([finding('a'), finding('b'), finding('c')], now=NOW + dt.timedelta(minutes=71))
        self.assertEqual(len(self.comments()), 2)
        self.assertIn('`c`', self.comments()[1])

    def test_all_clear_comments_and_closes(self):
        self.reconcile([finding('a')])
        self.reconcile([], now=NOW + dt.timedelta(hours=2))
        issue = self.alert()
        self.assertEqual(issue['state'], 'closed')
        self.assertEqual(issue['title'], 'Watchdog: 0 finding(s)')
        self.assertIn('All clear', self.comments()[-1])
        self.assertEqual(self.state.announced, [])

    def test_all_clear_waits_out_the_comment_limit_before_closing(self):
        self.reconcile([finding('a')])
        self.reconcile([finding('a'), finding('b')], now=NOW + dt.timedelta(minutes=5))   # comment at +5m
        self.reconcile([], now=NOW + dt.timedelta(minutes=35))
        self.assertEqual(self.alert()['state'], 'open')
        self.assertEqual(len(self.comments()), 1)
        self.reconcile([], now=NOW + dt.timedelta(minutes=66))
        self.assertEqual(self.alert()['state'], 'closed')
        self.assertEqual(len(self.comments()), 2)

    def test_new_problem_reopens_a_closed_issue(self):
        self.reconcile([finding('a')])
        self.reconcile([], now=NOW + dt.timedelta(hours=2))
        self.reconcile([finding('z')], now=NOW + dt.timedelta(hours=5))
        issue = self.alert()
        self.assertEqual(issue['state'], 'open')
        self.assertEqual(issue['title'], 'Watchdog: 1 finding(s)')
        self.assertIn('`z`', self.comments()[-1])
        self.assertEqual(len([i for i in self.fake.issues.values() if w.ALERT_LABEL in i['labels']]), 1)

    def test_issue_closed_by_a_human_is_not_reopened_for_the_same_findings(self):
        self.reconcile([finding('a')])
        self.alert()['state'] = 'closed'
        writes = len(self.fake.writes())
        self.reconcile([finding('a')], now=NOW + dt.timedelta(hours=3))
        self.assertEqual(self.alert()['state'], 'closed')
        self.assertEqual(len(self.fake.writes()), writes)
        self.reconcile([finding('a'), finding('new')], now=NOW + dt.timedelta(hours=4))
        self.assertEqual(self.alert()['state'], 'open')

    def test_nothing_to_report_and_no_issue_means_no_writes(self):
        self.reconcile([])
        self.assertEqual(self.fake.writes(), [])

    def test_dry_run_writes_nothing(self):
        self.reconcile([finding('a')], dry_run=True)
        self.assertEqual(self.fake.writes(), [])
        self.assertEqual(self.fake.issues, {})

    def test_labels_are_created_when_missing_only(self):
        self.fake.labels = {w.ALERT_LABEL}
        w.ensure_labels(self.fake, REPO, w.Writer(self.fake, False, lambda s: None))
        created = sorted(b['name'] for m, p, b in self.fake.writes() if p.endswith('/labels'))
        self.assertEqual(created, [w.HEARTBEAT_LABEL, w.STATE_LABEL])
        w.ensure_labels(self.fake, REPO, w.Writer(self.fake, False, lambda s: None))
        self.assertEqual(len(self.fake.writes()), 2)

    def test_body_lists_key_since_and_next_step_for_every_finding(self):
        f = finding('x')
        f.notes.append('recovery: dispatch sent at later')
        body = w.render_body([f, finding('y')])
        for needle in ('`x`', '`y`', 'Since:** 2026-11-12T11:00:00Z', 'Next step:** do this', 'Recovery:** recovery: dispatch'):
            self.assertIn(needle, body)
        self.assertIn('All clear', w.render_body([]))


class EndToEndTests(unittest.TestCase):
    def build(self):
        f = FakeGH()
        f.on(f'repos/{REPO}/actions/workflows?', workflow_entries())
        f.on(f'repos/{REPO}/actions/workflows/', {'workflow_runs': [run_obj('success', 5, 1, 'schedule')]})
        f.on(f'repos/{REPO}/actions/workflows/spotify-etl.yml/runs', {'workflow_runs': [run_obj('success', 5 * 60, 2, 'schedule')]})
        f.prs = [pr(1, 'CLEAN')]
        f.on(f'repos/{REPO}/commits/{"h" * 40}/check-runs', green(45))
        return f

    def test_dry_run_prints_and_writes_nothing(self):
        f = self.build()
        out = []
        code_ = w.run(f, REPO, NOW, REAL_WORKFLOWS, True, out.append)
        self.assertEqual(code_, 0)
        self.assertEqual(f.writes(), [])
        text = '\n'.join(out)
        self.assertIn('merge-stall:pr-1', text)
        self.assertIn('sched-stale:spotify-etl.yml', text)
        self.assertIn('would dispatch spotify-etl.yml', text)

    def test_real_run_dispatches_once_creates_issue_and_state_then_settles(self):
        f = self.build()
        self.assertEqual(w.run(f, REPO, NOW, REAL_WORKFLOWS, False, lambda s: None), 0)
        writes = f.writes()
        self.assertEqual(len([s for s in writes if s[1].endswith('/dispatches')]), 1)
        alert = [i for i in f.issues.values() if w.ALERT_LABEL in i['labels']]
        state = [i for i in f.issues.values() if w.STATE_LABEL in i['labels']]
        self.assertEqual((len(alert), len(state)), (1, 1))
        self.assertIn('sched-stale:spotify-etl.yml', alert[0]['body'])
        self.assertIn('dispatch sent', alert[0]['body'])
        # Second pass 30 minutes later: the dispatched run now exists in reality; here the fake still shows the
        # old run, so only the 6 h limit prevents a second dispatch.
        later = NOW + dt.timedelta(minutes=30)
        w.run(f, REPO, later, REAL_WORKFLOWS, False, lambda s: None)
        self.assertEqual(len([s for s in f.writes() if s[1].endswith('/dispatches')]), 1)
        self.assertEqual(len(f.comments.get(alert[0]['number'], [])), 0)     # no new keys, no comment

    def test_a_crashing_check_is_flagged_only_when_it_repeats(self):
        f = self.build()
        f.prs = None                      # makes check_prs raise on the first access
        out = []
        w.run(f, REPO, NOW, REAL_WORKFLOWS, False, out.append)
        self.assertFalse([i for i in f.issues.values() if w.ALERT_LABEL in i['labels'] and 'check-error' in i['body']])
        state_issue = [i for i in f.issues.values() if w.STATE_LABEL in i['labels']][0]
        w.run(f, REPO, NOW + dt.timedelta(minutes=50), REAL_WORKFLOWS, False, out.append)
        alert = [i for i in f.issues.values() if w.ALERT_LABEL in i['labels']]
        self.assertTrue(alert and 'watchdog-check-error:prs' in alert[0]['body'])
        self.assertIn('watchdog-check-error:prs', state_issue['body'])


class WorkflowContractTests(unittest.TestCase):
    """watchdog.yml must stay a trusted-code-only, default-branch-only workflow."""

    def setUp(self):
        self.text = (REAL_WORKFLOWS / 'watchdog.yml').read_text(encoding='utf-8-sig')

    def test_triggers_are_schedule_and_dispatch_only(self):
        self.assertEqual(w.workflow_crons(self.text), ['*/30 * * * *'])
        self.assertTrue(w.has_workflow_dispatch(self.text))
        self.assertIn('dry_run:', self.text)
        for forbidden in ('pull_request', 'pull_request_target', 'workflow_run', 'push:'):
            self.assertNotIn(forbidden, self.text.replace('pull-requests', ''))

    def test_permissions_are_exactly_the_documented_set(self):
        for line in ('contents: read', 'issues: write', 'pull-requests: read', 'actions: write',
                     'checks: read', 'statuses: read'):
            self.assertIn(f'  {line}', self.text)
        self.assertNotIn('contents: write', self.text)
        self.assertNotIn('pull-requests: write', self.text)

    def test_serialised_pinned_and_default_branch_only(self):
        self.assertIn('group: watchdog', self.text)
        self.assertIn('cancel-in-progress: false', self.text)
        self.assertIn('persist-credentials: false', self.text)
        self.assertIn("github.event.repository.default_branch", self.text)
        self.assertRegex(self.text, r'actions/checkout@[0-9a-f]{40}')
        self.assertNotRegex(self.text, r'actions/checkout@v\d')
        self.assertNotIn('github.head_ref', self.text)
        self.assertNotIn('secrets.', self.text)


if __name__ == '__main__':
    unittest.main()
