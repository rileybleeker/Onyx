// Run: node --test tests/personalize-draft.test.cjs
// Personalize announces the side panel's unsaved draft (layout.areas) so the continuous scroll follows it live:
// src/lib/personalize-store.ts (LAYOUT_DRAFT_EVENT from src/lib/nav-areas.ts). Offline, fake window, invented layouts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTs } = require('./helpers/load-ts.cjs');

const events = [];
const store = new Map();
const listeners = new Map();
globalThis.window = {
  location: { search: '', protocol: 'https:' },
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  },
  dispatchEvent: (e) => {
    events.push({ type: e.type, detail: e.detail });
    for (const fn of listeners.get(e.type) ?? []) fn(e);
    return true;
  },
  addEventListener: (type, fn) => { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
};
if (typeof globalThis.CustomEvent !== 'function') {
  globalThis.CustomEvent = class extends Event { constructor(type, o) { super(type); this.detail = o?.detail; } };
}
globalThis.fetch = async () => { throw new Error('offline'); };

const S = loadTs('lib/personalize-store.ts', {
  './client-cache': { clientCache: { revalidate: async () => undefined }, fetchJsonValue: async () => undefined },
  './ui-preferences': { UI_PREFS_PATH: '/api/ui/preferences', parseUiPref: () => ({ value: null, updatedAt: null }), uiPrefUrl: (k) => `/api/ui/preferences?key=${k}` },
  './personalize-registry': { setEditingKey() {}, setEditorRef() {} },
});
const N = loadTs('lib/nav-areas.ts');

const LAYOUT = { v: 1, grids: { main: { order: ['sleep', 'today', 'log'] } } };
const drafts = () => events.filter((e) => e.type === N.LAYOUT_DRAFT_EVENT);

test('each change to the side panel draft is announced; page-only changes are not', () => {
  events.length = 0;
  S.beginEdit('layout.sleep', '/sleep', 'Sleep');
  S.updateDraftFor(N.AREAS_KEY, () => LAYOUT);
  assert.deepEqual(drafts(), [{ type: N.LAYOUT_DRAFT_EVENT, detail: { key: N.AREAS_KEY, layout: LAYOUT } }]);
  S.updateDraftFor('layout.sleep', (l) => ({ ...l, grids: { main: { order: ['x'] } } }));
  assert.equal(drafts().length, 1, 'a page layout draft is not the area order');
  S.endEdit(false);
  assert.deepEqual(drafts().at(-1).detail, { key: N.AREAS_KEY, layout: null }, 'Cancel: back to the saved order');
  assert.equal(store.get('onyx.layout.areas'), undefined, 'Cancel saves nothing');
});

test('Done saves first, then ends the draft (the scroll goes straight to the saved copy)', () => {
  events.length = 0;
  S.beginEdit('layout.sleep', '/sleep', 'Sleep');
  S.updateDraftFor(N.AREAS_KEY, () => LAYOUT);
  S.endEdit(true);
  const saved = events.findIndex((e) => e.type === N.LAYOUT_EVENT && e.detail === N.AREAS_KEY);
  const ended = events.findIndex((e) => e.type === N.LAYOUT_DRAFT_EVENT && e.detail.layout === null);
  assert.ok(saved !== -1 && ended > saved, JSON.stringify(events));
  assert.deepEqual(JSON.parse(store.get('onyx.layout.areas')).l, LAYOUT);
});

test('a session that never touched the side panel announces no draft', () => {
  events.length = 0;
  S.beginEdit('layout.sleep', '/sleep', 'Sleep');
  S.endEdit(true);
  assert.equal(drafts().length, 0);
});

test('a scroll that starts listening mid-session gets the current draft; none when nothing was drafted', () => {
  events.length = 0;
  window.dispatchEvent(new CustomEvent(N.LAYOUT_DRAFT_REQUEST_EVENT));
  assert.equal(drafts().length, 0, 'no session');
  S.beginEdit('layout.sleep', '/sleep', 'Sleep');
  window.dispatchEvent(new CustomEvent(N.LAYOUT_DRAFT_REQUEST_EVENT));
  assert.equal(drafts().length, 0, 'session, side panel untouched');
  S.updateDraftFor(N.AREAS_KEY, () => LAYOUT);
  events.length = 0;
  window.dispatchEvent(new CustomEvent(N.LAYOUT_DRAFT_REQUEST_EVENT));
  assert.deepEqual(drafts(), [{ type: N.LAYOUT_DRAFT_EVENT, detail: { key: N.AREAS_KEY, layout: LAYOUT } }]);
  S.endEdit(false);
});
