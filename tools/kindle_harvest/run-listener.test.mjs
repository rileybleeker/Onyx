// Run: node --test run-listener.test.mjs   (offline: pure helpers only, no socket, no PowerShell)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { backoffMs, joinMessage, heartbeatMessage, parseFrame, runResult } from './run-listener.mjs';

const T0 = Date.parse('2030-03-05T15:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

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

test('the listener never logs the key or the websocket URL', () => {
  const src = readFileSync(new URL('./run-listener.mjs', import.meta.url), 'utf8');
  for (const line of src.split('\n').filter((l) => /\blog\(/.test(l))) {
    assert.doesNotMatch(line, /\bKEY\b|\burl\b|apikey/, line.trim());
  }
});
