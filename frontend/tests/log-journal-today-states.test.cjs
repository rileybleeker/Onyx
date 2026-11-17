// Journal section, "Today" list: the empty sentence may only follow a successful read that returned zero rows.
// Loading shows a loading line; a failed read shows an error with a Retry that re-runs only today's read.
// Reads source only (no network, no data). Run: node --test tests/log-journal-today-states.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', 'src', 'app', 'log', 'sections', 'Journal.tsx');

test('the empty sentence is guarded by a successful list, and failure offers Retry', () => {
  const src = fs.readFileSync(FILE, 'utf8');
  const empty = src.indexOf('No journal entries today yet.');
  assert.ok(empty > 0, 'empty sentence present');
  // The branch that renders it is reached only when the list is loaded (list is non-null).
  assert.match(src.slice(0, empty), /\{list \|\| entries\.length \? \(/, 'empty sentence sits under the loaded-list branch');
  const failBranch = src.indexOf('Couldn&apos;t load today&apos;s journal entries. Try again.');
  assert.ok(failBranch > empty, 'error copy follows the empty branch');
  assert.match(src.slice(failBranch, failBranch + 600), />\s*Retry\s*</, 'error has a Retry button');
  assert.match(src, /void loadList\(urlRef\.current\)/, 'Retry re-runs only the today list read');
  assert.match(src, /Loading today&apos;s journal entries/, 'loading line present');
});
