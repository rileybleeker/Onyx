#!/usr/bin/env python3
"""Cloud watchdog: the dead-man switch that keeps working while the PC runner is down.

Deterministic (no AI), stdlib only, GITHUB_TOKEN only, talks to GitHub through the
`gh` CLI. It never checks out or runs PR code. See docs/watchdog.md.

What it looks at:
  1. PRs that are ready to merge but nobody merged them (the PC merger is down).
  2. PRs that are red, pending too long, in conflict or behind master.
  3. Master health: Autonomous CI, Production Smoke Test, Live checks, train-halt,
     rollback PRs.
  4. Scheduled workflows that missed their window or were disabled (bounded
     recovery: dispatch or re-enable, from a fixed allow-list, at most once per 6 h).
  5. The PC runner heartbeat (issue labelled `runner-heartbeat`).

Findings are written to ONE issue labelled `watchdog`, edited in place. Bookkeeping
(when a condition was first seen, which keys were announced, when recovery last ran)
lives in the body of an issue labelled `watchdog-state`.

Usage:  python tools/watchdog_cloud.py [--dry-run]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import urllib.parse
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

UTC = dt.timezone.utc
DEFAULT_REPO = 'rileybleeker/Onyx'
WORKFLOWS_DIR = Path(__file__).resolve().parent.parent / '.github' / 'workflows'

# ---------------------------------------------------------------------------
# Thresholds (all in one place so docs/watchdog.md and the tests can quote them)
# ---------------------------------------------------------------------------
REQUIRED_CHECKS = ('offline-checks', 'frontend-types')
ACTIONS_APP_ID = 15368                       # GitHub Actions; branch protection pins it
MERGE_STALL_AFTER = dt.timedelta(minutes=20)
RED_AFTER = dt.timedelta(hours=6)
PENDING_AFTER = dt.timedelta(minutes=45)
CONFLICT_AFTER = dt.timedelta(hours=2)
BEHIND_AFTER = dt.timedelta(hours=3)     # the merge train updates one behind PR at a time
HEARTBEAT_STALE_AFTER = dt.timedelta(minutes=45)
HEARTBEAT_NEVER_AFTER = dt.timedelta(hours=24)   # grace after the workflow first exists
CHECK_ERROR_AFTER = dt.timedelta(minutes=45)     # a failing check must fail twice in a row
RECOVERY_GAP = dt.timedelta(hours=6)             # per workflow, for dispatch and enable
COMMENT_GAP = dt.timedelta(hours=1)              # never more than one new comment per hour
TRUSTED_ASSOCIATIONS = ('OWNER', 'MEMBER', 'COLLABORATOR')

HEARTBEAT_LABEL = 'runner-heartbeat'
ALERT_LABEL = 'watchdog'
STATE_LABEL = 'watchdog-state'
TRAIN_HALT_LABEL = 'train-halt'
LIVE_CHECKS_FILE = 'live-checks.yml'
LIVE_CHECKS_NAME = 'Live DB Checks'
LABELS = {
    HEARTBEAT_LABEL: ('0E8A16', 'PC runner heartbeat issue (read by the cloud watchdog)'),
    ALERT_LABEL: ('B60205', 'Findings from the cloud watchdog (edited in place)'),
    STATE_LABEL: ('BFD4F2', 'Bookkeeping for the cloud watchdog'),
}
STATE_BEGIN = '<!-- watchdog-state:begin -->'
STATE_END = '<!-- watchdog-state:end -->'
WATCHDOG_FILE = 'watchdog.yml'


@dataclass(frozen=True)
class Sched:
    """One scheduled workflow the watchdog is allowed to watch (and maybe recover)."""
    name: str
    max_gap: dt.timedelta          # newest run older than this = missed window
    recover: bool                  # may the watchdog workflow_dispatch it?
    why: str                       # cadence and how the gap was chosen
    no_recovery: str = ''          # when recover is False: why a human decides instead


def _m(minutes: int) -> dt.timedelta:
    return dt.timedelta(minutes=minutes)


def _h(hours: float) -> dt.timedelta:
    return dt.timedelta(hours=hours)


# The allow-list. Keyed by workflow FILE name. Nothing outside this table is ever
# dispatched or enabled. Gaps are the cron's own longest gap plus slack, checked
# against run history on 2026-11-12 (observed worst normal gaps in the comments).
SCHEDULED: dict[str, Sched] = {
    'daily-etl.yml': Sched('Hourly Health ETL', _m(150), True, 'hourly; worst seen 1h07'),
    'spotify-etl.yml': Sched('Spotify ETL', _m(150), True, 'hourly; worst seen 1h14'),
    'habits-sync.yml': Sched('Habits Sync', _m(150), True, 'hourly; worst seen 1h17'),
    'journal-sync.yml': Sched('Notion Journal Sync', _m(150), True, 'hourly; worst seen 1h27'),
    'hrv-retrain-on-backfill.yml': Sched(
        'HRV Analysis Retrain', _m(150), False, 'hourly detector; worst seen 1h33',
        'a manual dispatch forces an unconditional full retrain, and the 12:00 UTC safety net already covers it'),
    'hrv-prediction.yml': Sched('HRV Prediction', _h(26), True, 'daily crons plus a run after every hourly ETL'),
    'flights-email.yml': Sched('Flights Email ETL', _h(4), True, 'every 3h; routinely 3h19 in practice'),
    'delivery-email.yml': Sched('Delivery Email ETL', _h(4), True, 'every 3h; worst seen 3h08'),
    'air-quality-etl.yml': Sched(
        'Air Quality ETL', _h(4), True, 'every 3h at :12; new 2026-11-11, same cadence as the email ETLs'),
    'orders-email.yml': Sched(
        'Online Orders Email', _h(4), True, 'every 3h at :05; new 2026-11-12, same cadence as the email ETLs'),
    'urgent-email.yml': Sched(
        'Urgent Email Labels', _m(150), False, 'hourly :15; new 2026-11-11, no run history yet',
        'every run fails until sql/inbox_emails_schema.sql is applied, so a re-run cannot help; Riley decides'),
    'cronometer-etl.yml': Sched(
        'Cronometer ETL', _h(15), True, '02:30 and 16:00 UTC (13h30 gap); 14h would fire on normal delay'),
    'tanita-etl.yml': Sched('Tanita ETL', _h(26), True, '14:00 and 17:30 UTC (20h30 gap); worst seen 21h19'),
    'eight-sleep-etl.yml': Sched('Eight Sleep ETL', _h(28), True, 'daily; worst seen 26h46'),
    'smoke-test.yml': Sched('Production Smoke Test', _h(8), True, 'every 6h; worst seen 7h18'),
    'merge-train.yml': Sched(
        'Merge train', _m(90), True, '*/15 plus PR and CI events; the cron alone can be delayed by half an hour'),
    'live-checks.yml': Sched(
        'Live DB Checks', _h(28), False, 'daily 08:25 UTC plus pushes to master',
        'it queries the production database'),
    'keepalive.yml': Sched('Workflow Keepalive', dt.timedelta(days=8), True, 'weekly; worst seen 7d01h'),
    'monthly-audit.yml': Sched(
        'Monthly GH Actions Audit', dt.timedelta(days=33), False, 'monthly', 'it writes to Supabase'),
}

# Workflows that have a `schedule:` but are deliberately not in SCHEDULED.
EXEMPT_SCHEDULED: dict[str, str] = {
    WATCHDOG_FILE: 'cannot report its own absence; the PC half should check the age of the newest watchdog run',
}


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------
def parse_ts(value: str) -> dt.datetime:
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(UTC)


def iso(t: dt.datetime) -> str:
    return t.astimezone(UTC).strftime('%Y-%m-%dT%H:%M:%SZ')


def ago(delta: dt.timedelta) -> str:
    secs = max(int(delta.total_seconds()), 0)
    days, rem = divmod(secs, 86400)
    hours, rem = divmod(rem, 3600)
    minutes = rem // 60
    if days:
        return f'{days}d {hours}h'
    if hours:
        return f'{hours}h {minutes:02d}m'
    return f'{minutes}m'


def code(text, limit: int = 80) -> str:
    """Inline code for anything a stranger can influence (PR titles, branch names).

    Inside backticks an `@name` does not notify anyone and markdown cannot be injected.
    """
    s = re.sub(r'\s+', ' ', str(text)).replace('`', "'")
    if len(s) > limit:
        s = s[: limit - 3] + '...'
    return f'`{s}`'


def uncommented_lines(text: str):
    for line in text.splitlines():
        if not line.lstrip().startswith('#'):
            yield line


def workflow_crons(text: str) -> list[str]:
    out = []
    for line in uncommented_lines(text):
        m = re.match(r'^\s*-\s*cron:\s*[\'"]([^\'"]+)[\'"]', line)
        if m:
            out.append(m.group(1).strip())
    return out


def has_workflow_dispatch(text: str) -> bool:
    return any(re.match(r'^\s*workflow_dispatch\s*:', line) for line in uncommented_lines(text))


def _expand(field_: str, lo: int, hi: int) -> set[int]:
    values: set[int] = set()
    for part in field_.split(','):
        step = 1
        if '/' in part:
            part, step_s = part.split('/', 1)
            step = int(step_s)
        if part in ('*', ''):
            a, b = lo, hi
        elif '-' in part:
            a_s, b_s = part.split('-', 1)
            a, b = int(a_s), int(b_s)
        else:
            a = int(part)
            b = hi if step != 1 else a
        values.update(range(a, b + 1, step))
    return values


def nominal_gap(crons: list[str]) -> Optional[dt.timedelta]:
    """Longest gap between two firings of a workflow's cron lines (None if no cron)."""
    daily: set[int] = set()          # minutes since midnight, UTC
    longest: Optional[dt.timedelta] = None
    for expr in crons:
        parts = expr.split()
        if len(parts) != 5:
            raise ValueError(f'unsupported cron: {expr!r}')
        minute, hour, dom, _month, dow = parts
        if dom != '*':
            gap = dt.timedelta(days=31)
        elif dow != '*':
            gap = dt.timedelta(days=7 // max(len(_expand(dow, 0, 6)), 1))
        else:
            for h in _expand(hour, 0, 23):
                for mi in _expand(minute, 0, 59):
                    daily.add(h * 60 + mi)
            continue
        longest = gap if longest is None else max(longest, gap)
    if daily:
        times = sorted(daily)
        gaps = [b - a for a, b in zip(times, times[1:])] + [times[0] + 1440 - times[-1]]
        d = dt.timedelta(minutes=max(gaps))
        longest = d if longest is None else max(longest, d)
    return longest


def read_workflow_files(workflows_dir: Path) -> dict[str, str]:
    return {p.name: p.read_text(encoding='utf-8-sig') for p in sorted(workflows_dir.glob('*.yml'))}


def config_drift(files: dict[str, str]) -> list[str]:
    """Differences between the workflow files and the SCHEDULED / EXEMPT tables."""
    problems = []
    for name, text in files.items():
        if workflow_crons(text) and name not in SCHEDULED and name not in EXEMPT_SCHEDULED:
            problems.append(f'{name} has a schedule but is not in SCHEDULED or EXEMPT_SCHEDULED')
    for name, spec in SCHEDULED.items():
        text = files.get(name)
        if text is None:
            problems.append(f'SCHEDULED lists {name} but the file does not exist')
            continue
        crons = workflow_crons(text)
        if not crons:
            problems.append(f'SCHEDULED lists {name} but it has no schedule any more')
            continue
        if spec.recover and not has_workflow_dispatch(text):
            problems.append(f'{name} is marked recoverable but has no workflow_dispatch trigger')
        nominal = nominal_gap(crons)
        if nominal is not None and spec.max_gap <= nominal:
            problems.append(f'{name}: max_gap {ago(spec.max_gap)} is not above the cron gap {ago(nominal)}')
    for name in EXEMPT_SCHEDULED:
        if name in SCHEDULED:
            problems.append(f'{name} is both SCHEDULED and EXEMPT_SCHEDULED')
    return problems


# ---------------------------------------------------------------------------
# GitHub access (injectable)
# ---------------------------------------------------------------------------
class GhError(RuntimeError):
    def __init__(self, message: str, status: Optional[int] = None):
        super().__init__(message)
        self.status = status


PR_FIELDS = ('number,title,headRefName,headRefOid,baseRefName,isDraft,isCrossRepository,'
             'labels,mergeStateStatus,mergeable,createdAt,updatedAt,url')


class GhCli:
    """Thin wrapper over the `gh` CLI. Tests replace this with a fake."""

    def __init__(self, repo: str):
        self.repo = repo

    def _run(self, args: list[str], stdin: Optional[str] = None) -> str:
        proc = subprocess.run(['gh', *args], input=stdin, capture_output=True, text=True, timeout=90)
        if proc.returncode:
            text = (proc.stderr or proc.stdout).strip()
            m = re.search(r'HTTP (\d{3})', text)
            raise GhError(text[:300], int(m.group(1)) if m else None)
        return proc.stdout

    def get(self, path: str):
        out = self._run(['api', path])
        return json.loads(out) if out.strip() else None

    def get_all(self, path: str, key: Optional[str] = None) -> list:
        pages = json.loads(self._run(['api', '--paginate', '--slurp', path]) or '[]')
        items: list = []
        for page in pages:
            if isinstance(page, list):
                items.extend(page)
            elif key:
                items.extend(page.get(key, []))
        return items

    def send(self, method: str, path: str, body: Optional[dict] = None):
        out = self._run(['api', '-X', method, path, '--input', '-'], stdin=json.dumps(body or {}))
        return json.loads(out) if out.strip() else None

    def pr_list(self) -> list:
        return json.loads(self._run(['pr', 'list', '-R', self.repo, '--state', 'open',
                                     '--limit', '100', '--json', PR_FIELDS]) or '[]')


# ---------------------------------------------------------------------------
# State, findings, context
# ---------------------------------------------------------------------------
@dataclass
class State:
    first_run: Optional[str] = None
    first_seen: dict = field(default_factory=dict)       # condition key -> iso
    announced: list = field(default_factory=list)        # finding keys already notified
    last_comment_at: Optional[str] = None
    dispatched: dict = field(default_factory=dict)       # workflow file -> iso of last attempt
    enabled: dict = field(default_factory=dict)          # workflow file -> iso of last attempt

    @classmethod
    def from_body(cls, body: str) -> 'State':
        m = re.search(re.escape(STATE_BEGIN) + r'.*?```json\s*(.*?)\s*```.*?' + re.escape(STATE_END), body or '', re.S)
        if not m:
            return cls()
        try:
            raw = json.loads(m.group(1))
        except ValueError:
            return cls()
        known = {k: raw[k] for k in ('first_run', 'first_seen', 'announced', 'last_comment_at',
                                     'dispatched', 'enabled') if k in raw}
        return cls(**known)

    def to_body(self) -> str:
        payload = json.dumps(self.__dict__, indent=2, sort_keys=True)
        return ('Bookkeeping for `tools/watchdog_cloud.py` (edited automatically; do not close or edit).\n\n'
                f'{STATE_BEGIN}\n```json\n{payload}\n```\n{STATE_END}\n')


class Tracker:
    """Remembers when a condition was first observed (for conditions the API cannot date)."""

    def __init__(self, previous: dict, now: dt.datetime):
        self.previous = {k: parse_ts(v) for k, v in previous.items()}
        self.now = now
        self.current: dict[str, dt.datetime] = {}
        self.keep_previous = False       # set when a check crashed: do not forget its timers

    def since(self, key: str) -> dt.datetime:
        t = self.previous.get(key, self.now)
        self.current[key] = t
        return t

    def dump(self) -> dict:
        merged = {**self.previous, **self.current} if self.keep_previous else self.current
        return {k: iso(v) for k, v in sorted(merged.items())}


@dataclass
class Finding:
    key: str
    title: str
    detail: str
    next_step: str
    since: Optional[dt.datetime] = None
    notes: list = field(default_factory=list)


@dataclass
class Action:
    kind: str                       # 'dispatch' | 'enable'
    file: str
    workflow_id: int
    finding_key: str
    needs_enable: bool = False


@dataclass
class Ctx:
    gh: object
    repo: str
    now: dt.datetime
    state: State
    tracker: Tracker
    workflows_dir: Path
    default_branch: str = 'master'
    owner: str = ''
    watching: list = field(default_factory=list)
    actions: list = field(default_factory=list)
    _workflows: Optional[list] = None
    _prs: Optional[list] = None
    _halts: Optional[list] = None

    def workflows(self) -> list:
        if self._workflows is None:
            self._workflows = self.gh.get_all(f'repos/{self.repo}/actions/workflows?per_page=100', key='workflows')
        return self._workflows

    def prs(self) -> list:
        if self._prs is None:
            self._prs = self.gh.pr_list()
        return self._prs

    def runs(self, workflow: str, extra: str = '', per_page: int = 10) -> list:
        q = f'branch={self.default_branch}&per_page={per_page}&exclude_pull_requests=true{extra}'
        data = self.gh.get(f'repos/{self.repo}/actions/workflows/{workflow}/runs?{q}') or {}
        return data.get('workflow_runs', [])


def labelled_issues(gh, repo: str, label: str, state: str = 'all') -> list:
    q = urllib.parse.urlencode({'labels': label, 'state': state, 'per_page': 100, 'sort': 'created', 'direction': 'asc'})
    return [i for i in gh.get_all(f'repos/{repo}/issues?{q}') if 'pull_request' not in i]


# ---------------------------------------------------------------------------
# Check 5: PC runner heartbeat
# ---------------------------------------------------------------------------
def parse_heartbeat(body: str) -> dict:
    """`heartbeat:v1` on line 1, JSON {"at","ok","stalled"} after it. Raises ValueError."""
    lines = (body or '').strip().splitlines()
    if not lines or lines[0].strip() != 'heartbeat:v1':
        raise ValueError('first line is not heartbeat:v1')
    try:
        data = json.loads('\n'.join(lines[1:]))
    except ValueError as exc:
        raise ValueError(f'JSON after heartbeat:v1 is not valid: {exc}') from exc
    if not isinstance(data, dict):
        raise ValueError('heartbeat JSON is not an object')
    if not isinstance(data.get('ok'), bool):
        raise ValueError('"ok" must be true or false')
    stalled = data.get('stalled')
    if isinstance(stalled, bool) or not isinstance(stalled, int) or stalled < 0:
        raise ValueError('"stalled" must be a non-negative integer')
    try:
        at = parse_ts(str(data['at']))
    except (KeyError, ValueError) as exc:
        raise ValueError('"at" must be an ISO-8601 timestamp') from exc
    return {'at': at, 'ok': data['ok'], 'stalled': stalled}


def check_heartbeat(ctx: Ctx) -> list[Finding]:
    gh, repo, now = ctx.gh, ctx.repo, ctx.now
    issues = labelled_issues(gh, repo, HEARTBEAT_LABEL)
    comment = None
    if issues:
        comments = gh.get_all(f'repos/{repo}/issues/{issues[0]["number"]}/comments?per_page=100')
        # Anyone can comment on a public repo's issue, so only repo-side authors count.
        mine = [c for c in comments if c.get('author_association') in TRUSTED_ASSOCIATIONS
                and (c.get('body') or '').lstrip().startswith('heartbeat:v1')]
        if mine:
            comment = max(mine, key=lambda c: c.get('updated_at') or c.get('created_at') or '')
    if comment is None:
        ref = None
        for w in ctx.workflows():
            if Path(w.get('path', '')).name == WATCHDOG_FILE and w.get('created_at'):
                ref = parse_ts(w['created_at'])
        if ref is None and ctx.state.first_run:
            ref = parse_ts(ctx.state.first_run)
        where = f'issue #{issues[0]["number"]} has no trusted heartbeat comment' if issues \
            else f'no issue labelled `{HEARTBEAT_LABEL}` exists'
        if ref is None or now - ref < HEARTBEAT_NEVER_AFTER:
            ctx.watching.append(f'runner heartbeat never reported ({where}); inside the 24 h grace period')
            return []
        return [Finding(
            'runner-heartbeat-missing', 'PC runner has never reported a heartbeat',
            f'{where}; the watchdog has existed since {iso(ref)}.',
            f'On RileyPC start the runner so it creates the heartbeat issue (label `{HEARTBEAT_LABEL}`, one comment '
            'starting `heartbeat:v1`). If the PC half is not deployed yet, this finding is expected.',
            since=ref + HEARTBEAT_NEVER_AFTER)]
    issue_no = issues[0]['number']
    try:
        hb = parse_heartbeat(comment['body'])
    except ValueError as exc:
        return [Finding(
            'runner-heartbeat-unreadable', 'PC runner heartbeat comment cannot be read',
            f'Comment on issue #{issue_no}: {exc}.',
            'Fix the PC half so the comment is `heartbeat:v1` then JSON {"at","ok","stalled"}.',
            since=ctx.tracker.since('runner-heartbeat-unreadable'))]
    out = []
    age = now - hb['at']
    if age > HEARTBEAT_STALE_AFTER:
        out.append(Finding(
            'runner-heartbeat-stale', f'PC runner has not reported for {ago(age)}',
            f'Last heartbeat {iso(hb["at"])} (issue #{issue_no}); limit is {ago(HEARTBEAT_STALE_AFTER)}. '
            'While it is silent nothing merges and no builders run.',
            'Check RileyPC: awake and signed in? Task Scheduler runner tasks running? `gh auth status` valid? '
            'Wake or restart it; the heartbeat refreshes on the next runner tick.',
            since=hb['at']))
        return out        # ok / stalled in an old heartbeat tell us nothing current
    if not hb['ok']:
        out.append(Finding(
            'runner-not-ok', 'PC runner reports ok=false',
            f'Heartbeat at {iso(hb["at"])} on issue #{issue_no} says the last runner pass failed.',
            'Read the runner log on RileyPC (path in the PC half README) and fix the cause.',
            since=hb['at']))
    if hb['stalled'] > 0:
        out.append(Finding(
            'runner-stalled', f'PC runner reports {hb["stalled"]} stalled item(s)',
            f'Heartbeat at {iso(hb["at"])} on issue #{issue_no} lists stalled work.',
            'Open the PC half status (it names the stalled items) and unblock or cancel them.',
            since=hb['at']))
    return out


# ---------------------------------------------------------------------------
# Checks 1 and 2: pull requests
# ---------------------------------------------------------------------------
@dataclass
class RC:
    name: str
    state: str                       # success | failed | pending | missing
    at: Optional[dt.datetime] = None
    url: str = ''


def required_checks(ctx: Ctx, head: str) -> dict[str, RC]:
    runs = ctx.gh.get_all(f'repos/{ctx.repo}/commits/{head}/check-runs?per_page=100', key='check_runs')
    out = {}
    for name in REQUIRED_CHECKS:
        mine = [r for r in runs if r.get('name') == name and (r.get('app') or {}).get('id') == ACTIONS_APP_ID
                and r.get('head_sha', head) == head]
        if not mine:
            out[name] = RC(name, 'missing')
            continue
        run = max(mine, key=lambda r: r.get('id', 0))
        url = run.get('html_url', '')
        if run.get('status') != 'completed':
            out[name] = RC(name, 'pending', parse_ts(run['started_at']) if run.get('started_at') else None, url)
        elif run.get('conclusion') in ('success', 'neutral', 'skipped'):
            out[name] = RC(name, 'success', parse_ts(run['completed_at']) if run.get('completed_at') else None, url)
        else:
            out[name] = RC(name, 'failed', parse_ts(run['completed_at']) if run.get('completed_at') else None, url)
    return out


def pr_files(ctx: Ctx, number: int) -> set[str]:
    return {f['filename'] for f in ctx.gh.get_all(f'repos/{ctx.repo}/pulls/{number}/files?per_page=100')}


def conflict_hint(ctx: Ctx, pr: dict) -> str:
    """Which other PR a conflicting PR most likely collides with (file overlap only)."""
    mine = pr_files(ctx, pr['number'])
    if not mine:
        return 'Could not list this PR\'s files, so no overlap hint.'
    hits = []
    for other in ctx.prs():
        if other['number'] == pr['number'] or other.get('isDraft') or other.get('isCrossRepository'):
            continue
        common = sorted(mine & pr_files(ctx, other['number']))
        if common:
            hits.append(f'open PR #{other["number"]} ({", ".join(code(f, 60) for f in common[:3])})')
    closed = ctx.gh.get(f'repos/{ctx.repo}/pulls?state=closed&sort=updated&direction=desc&per_page=10') or []
    for other in closed:
        merged = other.get('merged_at')
        if not merged or (other.get('base') or {}).get('ref') != ctx.default_branch \
                or ctx.now - parse_ts(merged) > dt.timedelta(hours=48):
            continue
        common = sorted(mine & pr_files(ctx, other['number']))
        if common:
            hits.append(f'recently merged PR #{other["number"]} ({", ".join(code(f, 60) for f in common[:3])})')
    if not hits:
        return 'No file overlap with other open or recently merged PRs; master itself moved.'
    return 'Likely conflicts with ' + '; '.join(hits) + '.'


def open_train_halts(ctx: Ctx) -> list:
    if ctx._halts is None:
        ctx._halts = labelled_issues(ctx.gh, ctx.repo, TRAIN_HALT_LABEL, state='open')
    return ctx._halts


def check_prs(ctx: Ctx) -> list[Finding]:
    out: list[Finding] = []
    for pr in ctx.prs():
        n = pr['number']
        if pr.get('isDraft') or pr.get('isCrossRepository') or pr.get('baseRefName', ctx.default_branch) != ctx.default_branch:
            continue
        if 'hold' in {lab.get('name') for lab in pr.get('labels', [])}:
            ctx.watching.append(f'PR #{n}: label `hold` set, not watched')
            continue
        head = pr['headRefOid']
        label = f'PR #{n} {code(pr.get("title", ""))}'
        rcs = required_checks(ctx, head)
        mss = pr.get('mergeStateStatus')
        green = all(rc.state == 'success' for rc in rcs.values())
        failed = [rc for rc in rcs.values() if rc.state == 'failed']
        pending = [rc for rc in rcs.values() if rc.state in ('pending', 'missing')]

        if green and mss in ('CLEAN', 'UNSTABLE'):
            since = max((rc.at for rc in rcs.values() if rc.at), default=ctx.now)
            if ctx.now - since > MERGE_STALL_AFTER:
                halts = open_train_halts(ctx)
                halted = (f' The merge train is halted by issue #{halts[0]["number"]} ({TRAIN_HALT_LABEL}); '
                          'close it to resume.') if halts else ''
                out.append(Finding(
                    f'merge-stall:pr-{n}', f'{label} is green and mergeable but has not been merged',
                    f'Required checks passed at {iso(since)} and the merge state is {mss}; a merger should '
                    f'have taken it within {ago(MERGE_STALL_AFTER)}.{halted}',
                    'No merger is working: check the latest Merge train run in Actions (the train skips drafts, `hold`, '
                    'conflicts and protected paths such as `.github/**`), then RileyPC and the `runner-heartbeat` '
                    f'issue. To merge by hand: `gh pr merge {n} -R {ctx.repo} --squash --match-head-commit {head}`.',
                    since=since))
            else:
                ctx.watching.append(f'PR #{n}: green and {mss} since {iso(since)} (limit {ago(MERGE_STALL_AFTER)})')

        if failed:
            since = max((rc.at for rc in failed if rc.at), default=ctx.now)
            if ctx.now - since > RED_AFTER:
                names = ', '.join(rc.name for rc in failed)
                out.append(Finding(
                    f'pr-red:pr-{n}', f'{label} has been red for {ago(ctx.now - since)}',
                    f'Required check(s) {names} failed at {iso(since)} on head {head[:10]} with no newer commit.',
                    f'Open {failed[0].url or "the failing run"}, fix on branch {code(pr.get("headRefName", ""))} '
                    f'and push, or close the PR.',
                    since=since))
            else:
                ctx.watching.append(f'PR #{n}: red since {iso(since)} (limit {ago(RED_AFTER)})')

        if pending:
            starts = [rc.at for rc in pending if rc.at]
            if any(rc.state == 'missing' for rc in pending):
                commit = ctx.gh.get(f'repos/{ctx.repo}/commits/{head}') or {}
                date = ((commit.get('commit') or {}).get('committer') or {}).get('date')
                starts.append(parse_ts(date) if date else ctx.now)
            since = min(starts) if starts else ctx.now
            if ctx.now - since > PENDING_AFTER:
                names = ', '.join(f'{rc.name} ({rc.state})' for rc in pending)
                out.append(Finding(
                    f'pr-pending:pr-{n}', f'{label} checks have not finished after {ago(ctx.now - since)}',
                    f'Required check(s) not complete: {names}; waiting since {iso(since)}.',
                    f'`gh pr checks {n} -R {ctx.repo}`; if a run is stuck, `gh run list -R {ctx.repo} --branch '
                    f'{pr.get("headRefName", "")} --limit 3` then `gh run rerun <id>`; if no run exists, push a commit.',
                    since=since))
            else:
                ctx.watching.append(f'PR #{n}: checks pending since {iso(since)} (limit {ago(PENDING_AFTER)})')

        if mss == 'DIRTY':
            since = ctx.tracker.since(f'pr-conflict:pr-{n}')
            if ctx.now - since > CONFLICT_AFTER:
                out.append(Finding(
                    f'pr-conflict:pr-{n}', f'{label} has merge conflicts',
                    f'Conflicting with {ctx.default_branch} since the watchdog first saw it at {iso(since)} '
                    f'(limit {ago(CONFLICT_AFTER)}). {conflict_hint(ctx, pr)}',
                    f'Merge or rebase {ctx.default_branch} into {code(pr.get("headRefName", ""))}, resolve and push.',
                    since=since))
            else:
                ctx.watching.append(f'PR #{n}: conflicting, first seen {iso(since)} (limit {ago(CONFLICT_AFTER)})')

        if green and mss == 'BEHIND':
            since = ctx.tracker.since(f'pr-behind:pr-{n}')
            if ctx.now - since > BEHIND_AFTER:
                out.append(Finding(
                    f'pr-behind:pr-{n}', f'{label} is green but behind {ctx.default_branch}',
                    f'Branch protection needs it up to date; first seen behind at {iso(since)}.',
                    f'`gh pr update-branch {n} -R {ctx.repo}`, then let CI run again.',
                    since=since))
            else:
                ctx.watching.append(f'PR #{n}: behind, first seen {iso(since)} (limit {ago(BEHIND_AFTER)})')
    return out


# ---------------------------------------------------------------------------
# Check 3: master health
# ---------------------------------------------------------------------------
CONCLUSIVE = ('success', 'failure', 'timed_out', 'startup_failure')
BAD = ('failure', 'timed_out', 'startup_failure')


def conclusive_runs(ctx: Ctx, workflow: str, count: int) -> list[dict]:
    runs = ctx.runs(workflow, extra='&status=completed', per_page=15)
    runs = [r for r in runs if r.get('conclusion') in CONCLUSIVE]     # cancelled/skipped say nothing
    runs.sort(key=lambda r: r.get('created_at', ''), reverse=True)
    return runs[:count]


def check_master(ctx: Ctx) -> list[Finding]:
    out: list[Finding] = []
    latest = conclusive_runs(ctx, 'autonomous-ci.yml', 1)
    if latest and latest[0]['conclusion'] in BAD:
        r = latest[0]
        out.append(Finding(
            'master-ci-failed', 'Autonomous CI is failing on master',
            f'Latest completed run on {ctx.default_branch} ended {r["conclusion"]} at {r.get("updated_at", "?")}: '
            f'{r.get("html_url", "")}',
            'Find the failing job in that run. Fix forward, or revert the merge that broke it; '
            'check for a `train-halt` issue or `rollback/` PR that is already handling it.',
            since=parse_ts(r['updated_at']) if r.get('updated_at') else None))

    last_two = conclusive_runs(ctx, 'smoke-test.yml', 2)
    if len(last_two) == 2 and all(r['conclusion'] in BAD for r in last_two):
        newest = last_two[0]
        out.append(Finding(
            'smoke-failed-twice', 'Production Smoke Test failed twice in a row',
            f'Last two completed runs failed ({last_two[1].get("html_url", "")} and {newest.get("html_url", "")}); '
            'production is serving an empty or broken panel.',
            'Open the newest run, download the Playwright report artifact, and fix the page or the data behind it.',
            since=parse_ts(last_two[1]['created_at']) if last_two[1].get('created_at') else None))

    live = [w for w in ctx.workflows() if w.get('state') == 'active'
            and (w.get('name') == LIVE_CHECKS_NAME or Path(w.get('path', '')).name == LIVE_CHECKS_FILE)]
    if live:
        runs = conclusive_runs(ctx, str(live[0]['id']), 1)
        if runs and runs[0]['conclusion'] in BAD:
            r = runs[0]
            out.append(Finding(
                'live-checks-failed', f'{LIVE_CHECKS_NAME} failed',
                f'Latest completed run ended {r["conclusion"]}: {r.get("html_url", "")}',
                'Open the run and fix what the live check found (or the check itself).',
                since=parse_ts(r['updated_at']) if r.get('updated_at') else None))

    for issue in open_train_halts(ctx):
        out.append(Finding(
            f'train-halt:issue-{issue["number"]}', f'Merge train halted (issue #{issue["number"]})',
            f'Open issue #{issue["number"]} carries `{TRAIN_HALT_LABEL}`: {code(issue.get("title", ""))}. '
            'Merging is paused until it is closed.',
            f'Read #{issue["number"]}, fix the cause, then close it to resume the train.',
            since=parse_ts(issue['created_at']) if issue.get('created_at') else None))

    for pr in ctx.prs():
        if pr.get('headRefName', '').startswith('rollback/') and not pr.get('isCrossRepository'):
            n = pr['number']
            out.append(Finding(
                f'rollback-pr:pr-{n}', f'Rollback PR #{n} is open',
                f'Branch {code(pr["headRefName"])} means master was reverted or is about to be.',
                f'Review PR #{n} and merge it (or close it if superseded).',
                since=parse_ts(pr['createdAt']) if pr.get('createdAt') else None))
    return out


# ---------------------------------------------------------------------------
# Check 4: scheduled workflows (missed-run recovery)
# ---------------------------------------------------------------------------
def check_scheduled(ctx: Ctx) -> list[Finding]:
    out: list[Finding] = []
    by_file = {Path(w.get('path', '')).name: w for w in ctx.workflows()}
    files = read_workflow_files(ctx.workflows_dir) if ctx.workflows_dir.is_dir() else {}
    for file, spec in SCHEDULED.items():
        wf = by_file.get(file)
        if wf is None:
            continue                           # config_drift reports a table entry with no file
        wf_state = str(wf.get('state', 'active'))
        disabled = wf_state.startswith('disabled')
        if disabled:
            key = f'sched-disabled:{file}'
            auto = wf_state == 'disabled_inactivity'
            out.append(Finding(
                key, f'{spec.name} is disabled ({wf_state})',
                f'GitHub will not run {file} while it is disabled.' + (
                    ' This is the 60-days-without-a-push auto-disable.' if auto else
                    ' It was switched off by a person, which is a documented brake (for example on the merge train), '
                    'so the watchdog leaves it alone.'),
                (f'`gh workflow enable {file} -R {ctx.repo}` (the watchdog tries this automatically).' if auto else
                 f'If this was not deliberate: `gh workflow enable {file} -R {ctx.repo}`.'),
                since=ctx.tracker.since(key)))
            if not auto:
                continue                       # no stale finding, no dispatch while a human has it off
            ctx.actions.append(Action('enable', file, wf['id'], key))
        runs = ctx.runs(file, per_page=5)
        newest = max((parse_ts(r['created_at']) for r in runs), default=None)
        reference = newest or (parse_ts(wf['created_at']) if wf.get('created_at') else None)
        if reference is None or ctx.now - reference <= spec.max_gap:
            continue
        key = f'sched-stale:{file}'
        can_dispatch = spec.recover and has_workflow_dispatch(files.get(file, ''))
        if spec.recover and not can_dispatch:
            why_not = f'{file} has no workflow_dispatch trigger'
        else:
            why_not = spec.no_recovery
        out.append(Finding(
            key, f'{spec.name} has not run for {ago(ctx.now - reference)}',
            f'Newest run {iso(reference) if newest else "(none; workflow created " + iso(reference) + ")"}; '
            f'expected at least every {ago(spec.max_gap)} ({spec.why}).',
            ('The watchdog dispatches it once per 6 h (see notes); if it keeps going stale, open Actions and read the '
             'last run.' if can_dispatch else
             f'Automatic recovery is off here ({why_not}). Check Actions for {file}, then run it by hand if '
             f'appropriate: `gh workflow run {file} -R {ctx.repo}`.'),
            since=reference))
        if can_dispatch:
            ctx.actions.append(Action('dispatch', file, wf['id'], key, needs_enable=disabled))
    return out


def check_config_drift(ctx: Ctx) -> list[Finding]:
    if not ctx.workflows_dir.is_dir():
        return []
    problems = config_drift(read_workflow_files(ctx.workflows_dir))
    if not problems:
        return []
    return [Finding(
        'watchdog-config-drift', 'Watchdog allow-list is out of date',
        '; '.join(problems) + '.',
        'Edit SCHEDULED / EXEMPT_SCHEDULED in tools/watchdog_cloud.py to match .github/workflows, and run '
        '`python -m unittest tests.test_watchdog_cloud`.',
        since=ctx.tracker.since('watchdog-config-drift'))]


def execute_actions(ctx: Ctx, findings: list[Finding], dry_run: bool, say: Callable[[str], None]) -> None:
    """Run the planned recovery actions, at most one per workflow per 6 h, allow-list only."""
    by_key = {f.key: f for f in findings}
    enabled_now: set[str] = set()
    ordered = sorted(ctx.actions, key=lambda a: (a.kind != 'enable', a.file))
    for act in ordered:
        finding = by_key.get(act.finding_key)
        spec = SCHEDULED.get(act.file)
        note = finding.notes.append if finding else (lambda _s: None)
        if spec is None or (act.kind == 'dispatch' and not spec.recover) or act.kind not in ('enable', 'dispatch'):
            note(f'recovery refused: {act.file} is not on the allow-list')
            continue
        book = ctx.state.enabled if act.kind == 'enable' else ctx.state.dispatched
        last = book.get(act.file)
        if last and ctx.now - parse_ts(last) < RECOVERY_GAP:
            note(f'recovery suppressed: {act.kind} already tried at {last} (limit one per {ago(RECOVERY_GAP)})')
            continue
        if act.kind == 'dispatch' and act.needs_enable and act.file not in enabled_now:
            note('recovery deferred: workflow is still disabled')
            continue
        if dry_run:
            say(f'[dry-run] would {act.kind} {act.file}')
            note(f'dry run: would {act.kind}')
            continue
        try:
            if act.kind == 'enable':
                ctx.gh.send('PUT', f'repos/{ctx.repo}/actions/workflows/{act.workflow_id}/enable')
                enabled_now.add(act.file)
            else:
                ctx.gh.send('POST', f'repos/{ctx.repo}/actions/workflows/{act.file}/dispatches',
                            {'ref': ctx.default_branch})
            book[act.file] = iso(ctx.now)
            note(f'recovery: {act.kind} sent at {iso(ctx.now)}')
        except GhError as exc:
            book[act.file] = iso(ctx.now)            # a failing attempt also counts against the limit
            note(f'recovery failed ({act.kind} at {iso(ctx.now)}): {exc}')


# ---------------------------------------------------------------------------
# Running the checks
# ---------------------------------------------------------------------------
CHECKS: list[tuple[str, Callable[[Ctx], list[Finding]]]] = [
    ('heartbeat', check_heartbeat),
    ('prs', check_prs),
    ('master', check_master),
    ('scheduled', check_scheduled),
    ('config-drift', check_config_drift),
]


def run_checks(ctx: Ctx) -> list[Finding]:
    findings: list[Finding] = []
    for name, fn in CHECKS:
        try:
            findings.extend(fn(ctx))
        except Exception as exc:          # a broken check must not go quiet, nor stop the others
            ctx.tracker.keep_previous = True
            key = f'watchdog-check-error:{name}'
            since = ctx.tracker.since(key)
            message = f'{type(exc).__name__}: {exc}'
            if ctx.now - since >= CHECK_ERROR_AFTER:
                findings.append(Finding(
                    key, f'Watchdog check "{name}" keeps failing',
                    f'Since {iso(since)}: {code(message, 200)}',
                    'Open the latest Watchdog run in Actions; fix tools/watchdog_cloud.py or the API it calls.',
                    since=since))
            else:
                ctx.watching.append(f'check "{name}" raised {code(message, 120)} (first time; flagged if it repeats)')
    findings.sort(key=lambda f: f.key)
    return findings


# ---------------------------------------------------------------------------
# Alert issue
# ---------------------------------------------------------------------------
def render_body(findings: list[Finding], repo: str = DEFAULT_REPO) -> str:
    head = ('Written by `tools/watchdog_cloud.py` '
            f'([docs/watchdog.md](https://github.com/{repo}/blob/master/docs/watchdog.md)). '
            'Edited in place; a comment is added when a new finding appears and when all is clear.\n\n')
    if not findings:
        return head + '**All clear.** No open findings.\n'
    parts = [head]
    for i, f in enumerate(findings, 1):
        parts.append(f'### {i}. `{f.key}`: {f.title}\n'
                     f'- **What:** {f.detail}\n'
                     f'- **Since:** {iso(f.since) if f.since else "unknown"}\n'
                     f'- **Next step:** {f.next_step}\n')
        for n in f.notes:
            parts.append(f'- **Recovery:** {n}\n')
        parts.append('\n')
    return ''.join(parts)


def render_text(findings: list[Finding], now: dt.datetime) -> str:
    if not findings:
        return 'No findings.'
    lines = []
    for f in findings:
        age = f' ({ago(now - f.since)} ago)' if f.since else ''
        lines.append(f'- {f.key}: {f.title}\n    since {iso(f.since) if f.since else "unknown"}{age}\n'
                     f'    what: {f.detail}\n    next: {f.next_step}')
        lines.extend(f'    recovery: {n}' for n in f.notes)
    return '\n'.join(lines)


class Writer:
    """Performs writes, or just describes them in dry-run mode."""

    def __init__(self, gh, dry_run: bool, say: Callable[[str], None]):
        self.gh, self.dry_run, self.say = gh, dry_run, say

    def send(self, method: str, path: str, body: Optional[dict], desc: str):
        if self.dry_run:
            self.say(f'[dry-run] would {desc}')
            return {'number': 0}
        return self.gh.send(method, path, body)


def ensure_labels(gh, repo: str, writer: Writer) -> None:
    for name, (color, description) in LABELS.items():
        try:
            gh.get(f'repos/{repo}/labels/{urllib.parse.quote(name)}')
        except GhError as exc:
            if exc.status != 404:
                raise
            writer.send('POST', f'repos/{repo}/labels',
                        {'name': name, 'color': color, 'description': description}, f'create label {name}')


def reconcile_alerts(ctx: Ctx, findings: list[Finding], writer: Writer) -> None:
    gh, repo, now, state = ctx.gh, ctx.repo, ctx.now, ctx.state
    keys = sorted({f.key for f in findings})
    title = f'Watchdog: {len(keys)} finding(s)'
    body = render_body(findings, repo)
    issues = labelled_issues(gh, repo, ALERT_LABEL)
    issue = issues[0] if issues else None
    announced = set(state.announced) & set(keys)
    new = sorted(set(keys) - announced)
    last = parse_ts(state.last_comment_at) if state.last_comment_at else None
    can_comment = last is None or now - last >= COMMENT_GAP

    def comment(text: str) -> None:
        writer.send('POST', f'repos/{repo}/issues/{issue["number"]}/comments', {'body': text}, 'add a comment')
        state.last_comment_at = iso(now)

    def edit(**fields) -> None:
        writer.send('PATCH', f'repos/{repo}/issues/{issue["number"]}', fields, f'edit issue #{issue["number"]} ({", ".join(fields)})')

    if keys:
        if issue is None:
            payload = {'title': title, 'body': body, 'labels': [ALERT_LABEL], 'assignees': [ctx.owner]}
            try:
                writer.send('POST', f'repos/{repo}/issues', payload, f'create issue {title!r}')
            except GhError as exc:
                if exc.status != 422:
                    raise
                payload.pop('assignees')           # owner not assignable: retry plain
                writer.send('POST', f'repos/{repo}/issues', payload, f'create issue {title!r}')
            announced = set(keys)                   # creating (and assigning) it is the notification
        else:
            reopen = issue.get('state') == 'closed' and bool(new)
            if issue.get('state') == 'open' or reopen:
                if issue.get('title') != title or issue.get('body') != body or reopen:
                    fields = {'title': title, 'body': body}
                    if reopen:
                        fields['state'] = 'open'
                    edit(**fields)
            if new and (issue.get('state') == 'open' or reopen) and can_comment:
                lines = [f'@{ctx.owner} new watchdog finding(s), {len(keys)} open in total:']
                lines += [f'- `{f.key}`: {f.title}. Next: {f.next_step}' for f in findings if f.key in new]
                comment('\n'.join(lines))
                announced |= set(new)
            elif issue.get('state') == 'closed' and not reopen:
                announced = set(keys)               # closed by a human with nothing new: leave it closed
    else:
        if issue is not None and issue.get('state') == 'open':
            if can_comment:
                edit(title=title, body=body, state='closed')
                comment(f'All clear at {iso(now)}: no open findings. Closing; a new problem reopens this issue.')
            elif issue.get('title') != title or issue.get('body') != body:
                edit(title=title, body=body)      # wait out the hourly comment limit, then close
        announced = set()
    state.announced = sorted(announced)


def load_state(gh, repo: str) -> tuple[Optional[dict], State]:
    issues = labelled_issues(gh, repo, STATE_LABEL)
    if not issues:
        return None, State()
    return issues[0], State.from_body(issues[0].get('body') or '')


def save_state(ctx: Ctx, issue: Optional[dict], writer: Writer) -> None:
    ctx.state.first_seen = ctx.tracker.dump()
    body = ctx.state.to_body()
    if issue is None:
        writer.send('POST', f'repos/{ctx.repo}/issues',
                    {'title': 'Watchdog state (do not close)', 'body': body, 'labels': [STATE_LABEL]},
                    'create the watchdog-state issue')
    elif issue.get('body') != body:
        writer.send('PATCH', f'repos/{ctx.repo}/issues/{issue["number"]}', {'body': body}, 'update the watchdog-state issue')


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def run(gh, repo: str, now: dt.datetime, workflows_dir: Path, dry_run: bool,
        say: Callable[[str], None] = print) -> int:
    info = gh.get(f'repos/{repo}') or {}
    state_issue, state = load_state(gh, repo)
    if state.first_run is None:
        state.first_run = iso(now)
    ctx = Ctx(gh=gh, repo=repo, now=now, state=state, tracker=Tracker(state.first_seen, now),
              workflows_dir=workflows_dir, default_branch=info.get('default_branch', 'master'),
              owner=(info.get('owner') or {}).get('login') or repo.split('/')[0])
    findings = run_checks(ctx)
    writer = Writer(gh, dry_run, say)
    execute_actions(ctx, findings, dry_run, say)
    say(f'{len(findings)} finding(s) at {iso(now)} for {repo}:')
    say(render_text(findings, now))
    if ctx.watching:
        say('Watching (below threshold or deliberately skipped):')
        for line in ctx.watching:
            say(f'  - {line}')
    errors = 0
    try:
        ensure_labels(gh, repo, writer)
        reconcile_alerts(ctx, findings, writer)
    except GhError as exc:
        say(f'ERROR updating the alert issue: {exc}')
        errors += 1
    try:
        save_state(ctx, state_issue, writer)
    except GhError as exc:
        say(f'ERROR saving state: {exc}')
        errors += 1
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a', encoding='utf-8') as fh:
            fh.write(f'## Watchdog {"(dry run) " if dry_run else ""}{iso(now)}\n\n{render_body(findings, repo)}\n')
    return 1 if errors else 0


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--dry-run', action='store_true', help='print findings and actions; write nothing')
    parser.add_argument('--repo', default=os.environ.get('GITHUB_REPOSITORY', DEFAULT_REPO))
    parser.add_argument('--workflows-dir', type=Path, default=WORKFLOWS_DIR)
    args = parser.parse_args(argv)
    return run(GhCli(args.repo), args.repo, dt.datetime.now(UTC), args.workflows_dir, args.dry_run)


if __name__ == '__main__':
    sys.exit(main())
