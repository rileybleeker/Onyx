"""Post-deployment regression coverage for private audit output boundaries."""
from pathlib import Path
import ast
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]


class AuditEvidencePrivacy(unittest.TestCase):
    def test_generated_evidence_is_not_tracked(self):
        tracked = subprocess.check_output(['git', 'ls-files', 'audit/'], cwd=ROOT, text=True).splitlines()
        generated_names = {'DATA_PROFILE.md', 'VARIABLE_COVERAGE_AUDIT.md', 'CONTEXT.md',
                           'EMPIRICAL.md', '_findings_digest.md'}
        violations = [p for p in tracked if Path(p).suffix in {'.json', '.jsonl', '.csv', '.log'}
                      or Path(p).name in generated_names]
        self.assertEqual(violations, [], 'Generated evidence must remain private')

    def test_runner_outputs_and_default_input_are_private(self):
        # Inspect configuration without importing the API client or loading .env.
        tree = ast.parse((ROOT / 'audit_runner.py').read_text(encoding='utf-8'))
        assignments = {n.targets[0].id: ast.unparse(n.value) for n in tree.body
                       if isinstance(n, ast.Assign) and isinstance(n.targets[0], ast.Name)}
        for name in ('DEFAULT_BUNDLE_DIR', 'RESPONSE_DIR'):
            self.assertIn("'analysis_output'", assignments[name])
        for sample in ('analysis_output/audit/responses/example.json',
                       'audit/new-review/DATA_PROFILE.md'):
            result = subprocess.run(['git', 'check-ignore', '--no-index', '--quiet', sample],
                                    cwd=ROOT, check=False)
            self.assertEqual(result.returncode, 0)

    def test_monthly_upload_is_an_explicit_metadata_allowlist(self):
        import yaml
        workflow = yaml.safe_load((ROOT / '.github/workflows/monthly-audit.yml').read_text())
        uploads = [s for s in workflow['jobs']['audit']['steps']
                   if str(s.get('uses', '')).startswith('actions/upload-artifact@')]
        self.assertEqual(len(uploads), 1)
        self.assertEqual(set(uploads[0]['with']['path'].split()),
                         {'audit/all_runs.jsonl', 'audit/summary.json'})


if __name__ == '__main__':
    unittest.main()
