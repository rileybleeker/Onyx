"""Private-config migration coverage; no browser, credentials or network."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

MODULE = (Path(__file__).resolve().parents[1] / 'tools/kindle_harvest/book-config.mjs').as_uri()


class PrivateConfig(unittest.TestCase):
    def test_private_precedence_legacy_migration_and_missing_config(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            local, home = root / 'local', root / 'home'
            local.mkdir()
            home.mkdir()
            code = ('import { readBookConfig } from ' + json.dumps(MODULE) + ';'
                    'console.log(JSON.stringify(readBookConfig(process.argv[1], process.argv[2])));')

            def read():
                return subprocess.run(['node', '--input-type=module', '-e', code, str(local), str(home)],
                                      text=True, capture_output=True, check=False)

            self.assertNotEqual(read().returncode, 0)
            (local / 'books.json').write_text('{"books":[{"slug":"synthetic-legacy"}]}')
            self.assertEqual(json.loads(read().stdout)['books'][0]['slug'], 'synthetic-legacy')
            private = home / '.onyx_kindle_books.json'
            private.write_text('{"books":[{"slug":"synthetic-private"}]}')
            self.assertEqual(json.loads(read().stdout)['books'][0]['slug'], 'synthetic-private')
            private.write_text('invalid')
            self.assertNotEqual(read().returncode, 0)  # no fallback to stale targets


if __name__ == '__main__':
    unittest.main()
