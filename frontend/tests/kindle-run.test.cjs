// Run: node --test tests/kindle-run.test.cjs
// "Run now" on the /status Kindle card (src/lib/kindle-run.ts, /api/kindle/run). Offline, invented data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const src = (...p) => readFileSync(path.join(__dirname, '..', 'src', ...p), 'utf8');
const { outputText } = ts.transpileModule(src('lib', 'kindle-run.ts'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', outputText)((name) => { throw new Error(`kindle-run.ts must stay import-free (imported ${name})`); }, mod, mod.exports);
const { checkRunRequest, parseRunBody, isRunId, shouldReuse, runView, NO_ANSWER_MS, GIVE_UP_UNANSWERED_MS } = mod.exports;

const NOW = Date.parse('2030-03-05T15:00:00Z');
const ID = '00000000-0000-4000-8000-000000000001';
const headers = (h) => ({ get: (n) => h[n.toLowerCase()] ?? null });
const row = (over = {}) => ({ id: ID, requested_at: new Date(NOW - 10_000).toISOString(), picked_up_at: null, outcome: null, finished_at: null, exit_code: null, detail: null, ...over });

test('request checks: same origin, JSON, small body', () => {
  const ok = { origin: 'https://onyx.example', host: 'onyx.example', 'content-type': 'application/json', 'content-length': '2' };
  assert.equal(checkRunRequest(headers(ok), 'https://onyx.example'), null);
  assert.equal(checkRunRequest(headers({ ...ok, origin: 'https://evil.example' }), 'https://onyx.example').status, 403);
  assert.equal(checkRunRequest(headers({ ...ok, origin: undefined }), 'https://onyx.example').status, 403);
  assert.equal(checkRunRequest(headers({ ...ok, 'content-type': 'text/plain' }), 'https://onyx.example').status, 415);
  assert.equal(checkRunRequest(headers({ ...ok, 'content-length': '9999' }), 'https://onyx.example').status, 413);
});

test('body: an empty object only', () => {
  assert.deepEqual(parseRunBody('{}'), { ok: true });
  assert.deepEqual(parseRunBody(''), { ok: true });
  assert.equal(parseRunBody('{"task":"kindle"}').ok, false);
  assert.equal(parseRunBody('[]').ok, false);
  assert.equal(parseRunBody('nope').ok, false);
});

test('ids are UUIDs', () => {
  assert.equal(isRunId(ID), true);
  assert.equal(isRunId('1; select'), false);
  assert.equal(isRunId(null), false);
});

test('a second press reuses an unanswered or running request, not a finished one', () => {
  assert.equal(shouldReuse(null, NOW), false);
  assert.equal(shouldReuse(row(), NOW), true);
  assert.equal(shouldReuse(row({ requested_at: new Date(NOW - 3 * 60_000).toISOString() }), NOW), false);
  assert.equal(shouldReuse(row({ picked_up_at: new Date(NOW - 5000).toISOString(), outcome: 'started', requested_at: new Date(NOW - 10 * 60_000).toISOString() }), NOW), true);
  assert.equal(shouldReuse(row({ picked_up_at: new Date(NOW).toISOString(), outcome: 'started', finished_at: new Date(NOW).toISOString(), exit_code: 0 }), NOW), false);
  assert.equal(shouldReuse(row({ picked_up_at: new Date(NOW).toISOString(), outcome: 'failed', detail: 'task_missing' }), NOW), false);
});

test('what the button says, from asking to done', () => {
  assert.equal(runView(null, 0).phase, 'waiting');
  assert.equal(runView(row(), NO_ANSWER_MS).phase, 'no_answer');
  assert.equal(runView(row(), NO_ANSWER_MS).final, false);
  const gone = runView(row(), GIVE_UP_UNANSWERED_MS);
  assert.equal(gone.phase, 'failed');
  assert.equal(gone.final, true);
  assert.match(gone.text, /asleep or off/);
  const picked = { picked_up_at: new Date(NOW).toISOString() };
  assert.equal(runView(row({ ...picked, outcome: 'started' }), 5000).phase, 'running');
  assert.match(runView(row({ ...picked, outcome: 'already_running' }), 5000).text, /already running/);
  const done = runView(row({ ...picked, outcome: 'started', finished_at: new Date(NOW).toISOString(), exit_code: 0 }), 90_000);
  assert.deepEqual([done.phase, done.tone, done.final], ['done', 'ok', true]);
  assert.match(runView(row({ ...picked, outcome: 'started', finished_at: new Date(NOW).toISOString(), exit_code: 2 }), 90_000).text, /--login/);
  assert.match(runView(row({ ...picked, outcome: 'failed', detail: 'task_missing' }), 3000).text, /register-task\.ps1/);
  assert.match(runView(row({ ...picked, outcome: 'started', finished_at: new Date(NOW).toISOString(), detail: 'task_result_800710e0' }), 3000).text, /task_result_800710e0/);
});

test('the route is not a CI route', () => {
  const mw = src('middleware.ts');
  assert.doesNotMatch(mw, /\/api\/kindle/);
});

test('the failed branch of the Run now button never echoes server text', () => {
  const component = src('components', 'KindleRunNow.tsx');
  assert.doesNotMatch(component, /\$\{body\.error\}/);
  assert.match(component, /Couldn't ask the PC\. Try again\./);
});
