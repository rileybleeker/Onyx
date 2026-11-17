// Run: node --test run-listener.test.mjs   (offline: pure helpers only, no socket, no PowerShell)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { backoffMs, joinMessage, heartbeatMessage, parseFrame, runResult, createPatchWriter } from './run-listener.mjs';

const T0 = Date.parse('2030-03-05T15:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const noSleep = () => Promise.resolve();

test('join subscribes to INSERTs on pds.pc_run_requests only', () => {
  const m = joinMessage('7');
  assert.equal(m.event, 'phx_join');
  assert.equal(m.ref, '7');
  assert.deepEqual(m.payload.config.postgres_changes, [{ event: 'INSERT', schema: 'pds', table: 'pc_run_requests' }]);
  assert.equal(JSON.stringify(m).includes('access_token'), false);
});

test('frames: heartbeat ack, join, subscribe, insert, errors', () => {
  assert.deepEqual(parseFrame(JSON.stringify({ topic: 'phoenix', event: 'phx_reply', ref: '9', payload: { status: 'ok' } }), '1'), { kind: 'heartbeat_ack', ref: '9' });
  assert.deepEqual(parseFrame(JSON.stringify({ topic: 'realtime:onyx-pc-run', event: 'phx_reply', ref: '1', payload: { status: 'ok' } }), '1'), { kind: 'joined' });
  assert.equal(parseFrame(JSON.stringify({ topic: 'realtime:onyx-pc-run', event: 'phx_reply', ref: '1', payload: { status: 'error' } }), '1').kind, 'error');
  assert.equal(parseFrame(JSON.stringify({ event: 'system', payload: { extension: 'postgres_changes', status: 'ok' } }), '1').kind, 'subscribed');
  assert.equal(parseFrame(JSON.stringify({ event: 'system', payload: { extension: 'postgres_changes', status: 'error' } }), '1').kind, 'error');
  const record = { id: '00000000-0000-4000-8000-000000000001', task: 'kindle' };
  assert.deepEqual(parseFrame(JSON.stringify({ event: 'postgres_changes', payload: { data: { type: 'INSERT', record } } }), '1'), { kind: 'insert', record });
  assert.equal(parseFrame(JSON.stringify({ event: 'postgres_changes', payload: { data: { type: 'UPDATE', record } } }), '1').kind, 'other');
  assert.equal(parseFrame('not json', '1').kind, 'other');
  assert.equal(parseFrame(JSON.stringify({ event: 'phx_close' }), '1').kind, 'error');
  assert.equal(heartbeatMessage('3').topic, 'phoenix');
});

test('backoff grows to a minute and stays there', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(backoffMs), [1000, 2000, 5000, 10000, 30000, 60000, 60000]);
});

test('run result: still running, finished with an exit code, never started', () => {
  assert.deepEqual(runResult({ state: 'Running', lastRun: iso(T0), last: 267009 }, T0, 'started', 1), { done: false });
  assert.deepEqual(runResult({ state: 'Ready', lastRun: iso(T0 - 1000), last: 0 }, T0, 'started', 3), { done: true, exit_code: 0, detail: null });
  assert.deepEqual(runResult({ state: 'Ready', lastRun: iso(T0 + 5000), last: 2 }, T0, 'started', 3), { done: true, exit_code: 2, detail: null });
  // No run since the press: one more check, then reported.
  assert.deepEqual(runResult({ state: 'Ready', lastRun: iso(T0 - 3 * 3600e3), last: 0 }, T0, 'started', 1), { done: false });
  assert.deepEqual(runResult({ state: 'Ready', lastRun: iso(T0 - 3 * 3600e3), last: 0 }, T0, 'started', 2), { done: true, exit_code: null, detail: 'did_not_start' });
  // A scheduled run that was already going started before the press.
  assert.deepEqual(runResult({ state: 'Ready', lastRun: iso(T0 - 600e3), last: 0 }, T0, 'already_running', 4), { done: true, exit_code: 0, detail: null });
  // A Task Scheduler code that is not a process exit code.
  assert.deepEqual(runResult({ state: 'Ready', lastRun: iso(T0), last: 2147946720 }, T0, 'started', 2), { done: true, exit_code: null, detail: 'task_result_800710e0' });
});

test('patch writer: a PATCH that fails every attempt is queued, then a later drain retries and lands it once the REST layer recovers', async () => {
  let calls = 0;
  // Fail the first 4 attempts (the initial write), then succeed like the recovered REST layer.
  const fakeRest = async () => (++calls > 4 ? { ok: true, status: 200 } : { ok: false, status: 503 });
  const logs = [];
  const w = createPatchWriter(fakeRest, { log: (s) => logs.push(s), sleep: noSleep });
  const landed = await w.write(['id-1'], { outcome: 'started' });
  assert.equal(landed, false, 'first write fails all 4 attempts');
  assert.equal(w.pending.length, 1, 'failed write is kept for a later retry');
  assert.deepEqual(w.pending[0].ids, ['id-1']);
  assert.deepEqual(w.pending[0].fields, { outcome: 'started' });
  assert.equal(calls, 4, 'the failed write went through the backoff retries');

  await w.drain();
  assert.equal(calls, 5, 'drain makes one more attempt');
  assert.equal(w.pending.length, 0, 'entry is dropped only after a PATCH succeeds');
});

test('patch writer: a write that succeeds immediately is not queued', async () => {
  const fakeRest = async () => ({ ok: true, status: 200 });
  const w = createPatchWriter(fakeRest, { sleep: noSleep });
  assert.equal(await w.write([], {}), true);
  assert.equal(w.pending.length, 0);
});

test('patch writer: the list is capped and an overflow drops the oldest with a logged count', async () => {
  const fail = async () => ({ ok: false, status: 500 });
  const logs = [];
  const w = createPatchWriter(fail, { limit: 2, log: (s) => logs.push(s), sleep: noSleep });
  await w.write(['a'], {});
  await w.write(['b'], {});
  await w.write(['c'], {}); // over the cap: oldest ('a') is dropped, 'b' + 'c' stay
  assert.equal(w.pending.length, 2);
  assert.deepEqual(w.pending.map((e) => e.ids), [['b'], ['c']]);
  assert.match(logs.join('\n'), /pending-writes: dropped 1 \(2 left\)/);
});

test('patch writer: drain re-runs a whole failed batch once the REST layer recovers', async () => {
  let calls = 0;
  const w = createPatchWriter(async () => (++calls > 3 ? { ok: true, status: 200 } : { ok: false, status: 503 }), { sleep: noSleep });
  assert.equal(await w.write(['x'], { a: 1 }), false);
  assert.equal(await w.write(['y'], { b: 2 }), false);
  assert.equal(w.pending.length, 2);
  await w.drain(); // the REST layer has recovered: both are retried in order and land
  assert.equal(w.pending.length, 0);
  assert.equal(calls, 10);
});

test('patch writer logs only the status code or network error, never an id or secret', () => {
  const src = readFileSync(new URL('./run-listener.mjs', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('export function createPatchWriter'), src.indexOf('const patchWriter'));
  for (const hit of block.matchAll(/logFn\(`([^`]+)`\)/g)) {
    assert.doesNotMatch(hit[1], /id|KEY|apikey|token/i, hit[1]);
  }
});

test('the listener never logs the key or the websocket URL', () => {
  const src = readFileSync(new URL('./run-listener.mjs', import.meta.url), 'utf8');
  for (const line of src.split('\n').filter((l) => /\blog\(/.test(l))) {
    assert.doesNotMatch(line, /\bKEY\b|\burl\b|apikey/, line.trim());
  }
});
