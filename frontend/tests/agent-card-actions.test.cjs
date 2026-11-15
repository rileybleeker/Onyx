// Run: node --test tests/agent-card-actions.test.cjs
// The Agents chat card buttons and the settled-state labels (src/app/agents/agent-ui.tsx), with the React /
// Next imports stubbed: only the pure cardActions() and settledLabel() functions run. Offline, invented data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const source = readFileSync(path.join(__dirname, '..', 'src', 'app', 'agents', 'agent-ui.tsx'), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
});
const stubs = { 'next/link': {}, 'lucide-react': { Check: () => null, ExternalLink: () => null }, 'react/jsx-runtime': { jsx: () => null, jsxs: () => null, Fragment: 'fragment' } };
const mod = { exports: {} };
new Function('require', 'module', 'exports', outputText)((name) => {
  if (!(name in stubs)) throw new Error(`unexpected import ${name}`);
  return stubs[name];
}, mod, mod.exports);
const { cardActions, settledLabel } = mod.exports;

const card = (type, extra = {}) => ({ code: 'A12', agent: 'onyx', type, name: 'x', details: '', link: '', expires: null, updated: false, ...extra });

test('supplement cards offer Log it (primary) and Skip, which send "<code> log" / "<code> skip"', () => {
  assert.deepEqual(cardActions(card('supplement')), [
    { label: 'Log it', text: 'A12 log', primary: true },
    { label: 'Skip', text: 'A12 skip' },
  ]);
  assert.deepEqual(cardActions(card('Supplement')).map((a) => a.label), ['Log it', 'Skip'], 'type match is case-insensitive');
});

test('approval, check-in, lead, question and unknown cards keep their buttons', () => {
  assert.deepEqual(cardActions(card('approval')).map((a) => [a.label, a.text ?? null]), [['Approve', 'A12 yes'], ['Decline', 'A12 no'], ['Reply', null]]);
  assert.deepEqual(cardActions(card('checkin', { link: '/check-in?date=2026-11-11' })), [{ label: 'Open check-in', href: '/check-in?date=2026-11-11', primary: true }]);
  assert.deepEqual(cardActions(card('lead')).map((a) => a.label), ['Interested', 'Pass', 'Reply']);
  assert.deepEqual(cardActions(card('question')).map((a) => a.label), ['Reply', 'Done']);
  assert.deepEqual(cardActions(card('something-new')).map((a) => a.label), ['Reply']);
});

test('renewal cards are informational: one fixed link to /procurement, no reply or answer button', () => {
  assert.deepEqual(cardActions(card('renewal', { code: 'R0123456789abcdef', link: '/procurement' })), [{ label: 'Open procurement', href: '/procurement', primary: true }]);
  assert.deepEqual(cardActions(card('Renewal', { link: 'https://elsewhere.example/cart' })), [{ label: 'Open procurement', href: '/procurement', primary: true }], 'the link is fixed, whatever the card carries');
});

test('settled labels: the Worker decisions "logged" and "skipped" read as Logged / Skipped', () => {
  assert.equal(settledLabel(undefined, 'logged'), 'Logged');
  assert.equal(settledLabel(undefined, 'skipped'), 'Skipped');
  assert.equal(settledLabel(undefined, 'open'), null);
});

test('settled labels: a tap on a supplement card is labelled by its own words', () => {
  assert.equal(settledLabel('log', undefined, 'supplement'), 'Logged');
  assert.equal(settledLabel('skip', undefined, 'supplement'), 'Skipped');
  assert.equal(settledLabel('Log it', undefined, 'Supplement'), 'Logged');
});

test('settled labels for the other cards are unchanged', () => {
  assert.equal(settledLabel('yes', undefined), 'Approved');
  assert.equal(settledLabel('no', undefined), 'Declined');
  assert.equal(settledLabel('skip', undefined), 'Declined', 'skip on a non-supplement card still reads as declined');
  assert.equal(settledLabel('skip', undefined, 'approval'), 'Declined');
  assert.equal(settledLabel('done', undefined, 'question'), 'Marked done');
  assert.equal(settledLabel('interested', undefined, 'lead'), 'Interested');
  assert.equal(settledLabel(undefined, 'approve'), 'Approved');
  assert.equal(settledLabel(undefined, 'decline'), 'Declined');
  assert.equal(settledLabel(undefined, 'closed'), 'Closed by the agent');
  assert.equal(settledLabel('maybe later', undefined, 'supplement'), 'You replied: maybe later');
});
