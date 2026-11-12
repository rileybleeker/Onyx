import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('./harvest.mjs', import.meta.url), 'utf8');
const postSource = source.match(/async function post\(body\) \{[\s\S]*?\n\}/)[0];
function postWith(status, response, overrides = {}) {
  const context = vm.createContext({
    DRY: false, ONYX: 'https://example.invalid', TOKEN: 'synthetic', AbortSignal,
    fetch: async (_url, options) => {
      assert.ok(options.signal);
      return { status, ok: status >= 200 && status < 300, text: async () => response };
    }, ...overrides,
  });
  return vm.runInContext(postSource + '; post({})', context);
}
test('successful import is accepted', async () => {
  assert.match(await postWith(200, '{"errors":[]}'), /^200 /);
});
for (const status of [401, 403, 429, 500, 503]) {
  test(`HTTP ${status} is a failure without echoing the response body`, async () => {
    await assert.rejects(postWith(status, 'private response'), { message: `Onyx import HTTP ${status}` });
  });
}
for (const response of ['{"errors":["synthetic"]}', '{"error":"synthetic"}', 'not JSON']) {
  test(`invalid or partial success fails: ${response}`, async () => {
    await assert.rejects(postWith(200, response));
  });
}
test('dry run never sends a request', async () => {
  assert.equal(await postWith(200, '{}', { DRY: true, fetch: () => { throw Error('unexpected request'); } }), 'dry-run');
});
test('network error is propagated', async () => {
  await assert.rejects(postWith(200, '{}', { fetch: async () => { throw Error('synthetic network failure'); } }));
});

const main = source.slice(source.indexOf('let ctx;'));
for (const mode of ['normal', 'login', 'dry']) {
  for (const stage of ['launch', 'navigation']) {
    test(`${stage} failure in ${mode} mode exits nonzero and reports only for scheduled runs`, async () => {
      const posts = [], exits = [];
      let closed = false;
      const context = vm.createContext({
        PROFILE: 'synthetic', NOTEBOOK: 'https://example.invalid', LOGIN_MODE: mode === 'login', DRY: mode === 'dry',
        mkdirSync() {}, log() {}, post: async (body) => { posts.push(body); },
        chromium: { launchPersistentContext: async () => {
          if (stage === 'launch') throw Error('synthetic launch failure');
          return { pages: () => [{ goto: async () => { throw Error('synthetic navigation failure'); } }], close: async () => { closed = true; } };
        } }, process: { exit: (code) => exits.push(code) },
      });
      await vm.runInContext('(async () => {' + main + '})()', context);
      assert.deepEqual(exits, [1]);
      assert.equal(posts.length, mode === 'normal' ? 1 : 0);
      assert.equal(closed, stage === 'navigation');
    });
  }
}
test('unavailable error reporting still exits nonzero without an unhandled rejection', async () => {
  const exits = [];
  const context = vm.createContext({
    PROFILE: 'synthetic', LOGIN_MODE: false, DRY: false,
    mkdirSync() {}, log() {}, post: async () => { throw Error('synthetic offline'); },
    chromium: { launchPersistentContext: async () => { throw Error('synthetic launch failure'); } },
    process: { exit: (code) => exits.push(code) },
  });
  await vm.runInContext('(async () => {' + main + '})()', context);
  assert.deepEqual(exits, [1]);
});
test('failed-heartbeat acknowledgement is accepted', async () => {
  const context = vm.createContext({
    DRY: false, ONYX: 'https://example.invalid', TOKEN: 'synthetic', AbortSignal,
    fetch: async () => ({ status: 200, ok: true, text: async () => '{"heartbeat":"failed","error":"synthetic"}' }),
  });
  assert.match(await vm.runInContext(postSource + '; post({error:"synthetic"})', context), /^200 /);
});
