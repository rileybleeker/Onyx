// Run: node --test tests/today-cleared-open.test.cjs
// The /today quiet view's "Cleared from Unread, still waiting for an answer" list (src/app/today/TodayClient.tsx).
// Source-level checks: the file is read as text and the clearedOpen definition, its filter, its render gate and its
// React key are matched. Offline, no data; nothing is rendered.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const source = readFileSync(path.join(__dirname, '..', 'src', 'app', 'today', 'TodayClient.tsx'), 'utf8');

// The single-line definition of clearedOpen (one statement, so one line).
const definition = source.split('\n').find((line) => line.includes('const clearedOpen ='));

test('clearedOpen is defined once, and only reads dismissedOpen when the inbox is ready', () => {
  assert.ok(definition, 'clearedOpen definition exists');
  assert.equal(source.split('const clearedOpen =').length - 1, 1, 'defined exactly once');
  assert.match(
    definition,
    /const clearedOpen = inbox\.state === "ready" \? \(inbox\.value\.dismissedOpen \?\? \[\]\)\.filter\(/,
    'reads inbox.value.dismissedOpen only in the ready branch, with an empty-array fallback',
  );
  assert.match(definition, /: \[\];\s*$/, 'the loading, error and failed branches fall back to an empty list');
  assert.doesNotMatch(definition, /inbox\.value\.items/, 'does not read the open items list');
});

test('clearedOpen keeps only items with kind === "card"', () => {
  assert.match(
    definition,
    /\.filter\(\(item\): item is RequestCard => item\.kind === "card"\)/,
    'filter narrows to RequestCard and checks kind === "card"',
  );
});

test('the cleared list renders only when clearedOpen has items, and its heading shows the count', () => {
  assert.match(source, /\{clearedOpen\.length > 0 && <div className="mt-3">/, 'render is gated on clearedOpen.length > 0');
  assert.match(
    source,
    /Cleared from Unread, still waiting for an answer \(\{clearedOpen\.length\}\)/,
    'heading text carries the count in parentheses',
  );
  assert.match(source, /<ul aria-label="Cleared requests still open"/, 'list has its accessible label');
  assert.match(source, /\{clearedOpen\.map\(\(item\) => </, 'list items come from clearedOpen');
});

test('the All open items count and empty state include the cleared-but-open collection', () => {
  const countDefinition = source.split('\n').find((line) => line.includes('const openRowCount ='));
  assert.ok(countDefinition, 'openRowCount definition exists');
  assert.match(
    countDefinition,
    /const openRowCount = listed\.length \+ clearedOpen\.length;/,
    'row count is the ranked list plus the cleared-but-open cards',
  );
  assert.match(
    source,
    /<summary>All open items \(\{openRowCount\}\)<\/summary>/,
    'summary shows openRowCount, not listed.length alone',
  );
  assert.match(
    source,
    /\{openRowCount === 0 \? <p className="mt-1 text-sm text-text-secondary">Nothing open from the sources that answered\.<\/p>/,
    'the empty message is gated on openRowCount === 0 (both collections empty)',
  );
  assert.doesNotMatch(source, /<summary>All open items \(\{listed\.length\}\)<\/summary>/, 'summary no longer counts listed alone');
  assert.doesNotMatch(source, /\{listed\.length === 0 \? <p/, 'empty state no longer checks listed alone');
});

test('cleared-only case: no rows in the ranked list and one cleared-but-open request gives count 1 and no empty message', () => {
  // Mirrors the render logic with synthetic data: the same expressions as TodayClient.tsx.
  const listed = [];
  const clearedOpen = [{ thread: 't-1', messageId: 7, kind: 'card', card: { code: 'A1', name: 'Synthetic request' } }];
  const openRowCount = listed.length + clearedOpen.length;
  assert.equal(openRowCount, 1, 'summary reads 1');
  assert.equal(openRowCount === 0, false, 'empty message is not shown');
});

test('the React key for each cleared row includes thread, messageId and card.code', () => {
  assert.match(
    source,
    /clearedOpen\.map\(\(item\) => <li key=\{`\$\{item\.thread\}:\$\{item\.messageId\}:\$\{item\.card\.code\}`\}/,
    'key is thread:messageId:card.code',
  );

  // Behavioural check of the key shape with synthetic rows: two cards from one thread must not collide.
  const keyOf = (item) => `${item.thread}:${item.messageId}:${item.card.code}`;
  const rows = [
    { thread: 't-1', messageId: 7, kind: 'card', card: { code: 'A1', name: 'First' } },
    { thread: 't-1', messageId: 7, kind: 'card', card: { code: 'B2', name: 'Second' } },
    { thread: 't-1', messageId: 8, kind: 'card', card: { code: 'A1', name: 'Same code, next message' } },
  ];
  const keys = rows.map(keyOf);
  assert.equal(new Set(keys).size, rows.length, 'keys are unique across cards from one thread');
});
