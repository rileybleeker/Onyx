import copy
import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('merge', pathlib.Path(__file__).parents[1] / 'tools/autonomous_merge.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class MergeGuardTests(unittest.TestCase):
    def setUp(self):
        self.base = 'b' * 40
        self.pr = dict(state='OPEN', isDraft=False, baseRefName='master', headRefOid='a'*40,
            isCrossRepository=False, mergeable='MERGEABLE', mergeStateStatus='CLEAN',
            files=[dict(path='frontend/src/components/StatCard.tsx', status='modified')])
        self.checks = [dict(name=n, app_id=15368, head_sha='a'*40, state='SUCCESS') for n in m.REQUIRED]
        self.review = dict(head_sha='a'*40, base_sha=self.base, author='codex', reviews=[
            dict(agent=a, verdict='pass', unresolved_findings=[]) for a in ('codex', 'claude')])
        self.repo = dict(id=m.NODE_ID, nameWithOwner=m.REPO)
    def errors(self):
        return m.problems(self.pr, self.checks, self.review, self.base, self.repo)
    def test_valid(self): self.assertEqual([], self.errors())
    def test_missing_checks(self):
        self.checks=[]; self.assertTrue(self.errors())
    def test_skipped(self):
        self.checks[0]['state']='SKIPPED'; self.assertTrue(self.errors())
    def test_stale_head(self):
        self.review['head_sha']='c'*40; self.assertTrue(self.errors())
    def test_stale_base(self):
        self.review['base_sha']='c'*40; self.assertTrue(self.errors())
    def test_other_repo(self):
        self.repo['nameWithOwner']='rileybleeker/personal-agents'; self.assertTrue(self.errors())
    def test_policy_change(self):
        self.pr['files']=[dict(path='.github/workflows/autonomous-ci.yml')]; self.assertTrue(self.errors())
    def test_health_pipeline(self):
        self.pr['files']=[dict(path='hrv_analysis.py')]; self.assertTrue(self.errors())
    def test_auth_component(self):
        self.pr['files']=[dict(path='frontend/src/components/AuthProvider.tsx')]; self.assertTrue(self.errors())
    def test_single_agent(self):
        self.review['reviews'][1]['agent']='codex'; self.assertTrue(self.errors())
    def test_open_finding(self):
        self.review['reviews'][1]['unresolved_findings']=['bug']; self.assertTrue(self.errors())
    def test_behind(self):
        self.pr['mergeStateStatus']='BEHIND'; self.assertTrue(self.errors())
    def test_renamed_from_sensitive(self):
        self.pr['files'][0]['previous_filename']='server/auth.py'; self.assertTrue(self.errors())
    def test_spoofed_check(self):
        self.checks[0]['app_id']=1; self.assertTrue(self.errors())
    def test_check_wrong_head(self):
        self.checks[0]['head_sha']='c'*40; self.assertTrue(self.errors())
    def test_component_script(self):
        self.pr['files'][0]['path']='frontend/src/components/run.py'; self.assertTrue(self.errors())
    def test_fork(self):
        self.pr['isCrossRepository']=True; self.assertTrue(self.errors())

if __name__ == '__main__': unittest.main()
