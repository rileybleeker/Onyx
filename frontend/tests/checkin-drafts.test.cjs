// SYNTHETIC ONLY: invented answers/dates, in-memory storage and fake POST responses. No network or browser.
// Run: node --test tests/checkin-drafts.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");

const K = loadTs("lib/checkin-cells.ts");
const { CheckinDraftStore, dayDraftKey, nightDraftKey, recoveryTarget } = loadTs("lib/checkin-drafts.ts");
const DAY = "Synthetic daytime question";
const SECOND = "Synthetic optional question";
const SLEEP = "Synthetic sleep question";
const item = (name, sleep = false) => ({ name, sleep, notionPageId: "synthetic", category: "general", frequency: "daily", channel: "habit", group: "core" });
const ITEMS = [item(DAY), item(SECOND), item(SLEEP, true)];
const addDays = (date, offset) => new Date(Date.parse(`${date}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);

function page(today = "2031-03-05", date = today) {
  return {
    today, date, items: ITEMS, answers: {}, suggestions: {},
    days: [0, -1, -2].map((offset) => ({ date: addDays(today, offset), answered: 0, total: 2 })),
    nights: [-1, -2].map((offset) => ({ date: addDays(today, offset), answers: {}, suggestions: {}, usualKit: {} })),
  };
}

function storage(initial = {}) {
  const entries = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]));
  const fail = new Set();
  const check = (method) => { if (fail.has(method)) throw new Error(`synthetic ${method} failure`); };
  return {
    entries, fail,
    get length() { check("length"); return entries.size; },
    key(index) { check("key"); return [...entries.keys()][index] ?? null; },
    getItem(key) { check("getItem"); return entries.get(key) ?? null; },
    setItem(key, value) { check("setItem"); entries.set(key, value); },
    removeItem(key) { check("removeItem"); entries.delete(key); },
  };
}

function savePlan(store, data) {
  const dayItems = data.items.filter((i) => !i.sleep);
  const sleepItems = data.items.filter((i) => i.sleep);
  const cells = K.buildCells(dayItems, data.answers, data.suggestions, store.active(dayDraftKey(data.date)));
  const nightCells = Object.fromEntries(data.nights.map((n) => [n.date, K.buildCells(sleepItems, n.answers, n.suggestions, store.active(nightDraftKey(n.date)))]));
  return K.savePlan({ dayItems, dayAnswers: data.answers, cells, sleepItems, nights: K.visibleNights(data.nights, sleepItems, nightCells), nightCells });
}

function applySaved(saved, patch) {
  const next = { ...saved };
  for (const [name, answer] of Object.entries(patch)) {
    if (answer === null) delete next[name];
    else next[name] = answer;
  }
  return next;
}

// Exercise the sequential save contract with fake responses. Only an acknowledged part updates the
// baseline and settles its captured snapshot. A failed part stops the remaining requests.
async function saveSequence(store, data, responses) {
  const plan = savePlan(store, data);
  const parts = [
    ...(Object.keys(plan.dayPatch).length ? [{ key: dayDraftKey(data.date), date: data.date, patch: plan.dayPatch, night: false }] : []),
    ...plan.nightPatches.map((n) => ({ key: nightDraftKey(n.date), date: n.date, patch: n.changes, night: true })),
  ].map((part) => ({ ...part, sent: store.read(part.key) }));
  const calls = [];
  let current = data;
  for (const part of parts) {
    calls.push({ date: part.date, answers: part.patch, today: data.today });
    const response = await responses(calls.length - 1, part);
    if (!response.ok) {
      if (response.stale) store.holdAll();
      return { current, calls, failed: true };
    }
    store.settle(part.key, part.patch, part.sent);
    current = part.night
      ? { ...current, nights: current.nights.map((n) => n.date === part.date ? { ...n, answers: applySaved(n.answers, part.patch) } : n) }
      : { ...current, answers: applySaved(current.answers, part.patch) };
  }
  return { current, calls, failed: false };
}

test("stale before any write preserves both original dates and stops subsequent requests", async () => {
  const disk = storage();
  const store = new CheckinDraftStore(() => disk);
  const initial = page();
  const dayKey = dayDraftKey(initial.date);
  const nightKey = nightDraftKey("2031-03-04");
  store.prepare(initial);
  store.write(dayKey, { [DAY]: "Yes" }, {});
  store.write(nightKey, { [SLEEP]: "No" }, {});
  const savedBefore = new Map(disk.entries);

  const result = await saveSequence(store, initial, async () => ({ ok: false, stale: true }));
  assert.deepEqual(result.calls, [{ date: "2031-03-05", answers: { [DAY]: "Yes" }, today: "2031-03-05" }]);
  assert.deepEqual(disk.entries, savedBefore);
  assert.deepEqual(store.recovery().map(({ date, night }) => ({ date, night })), [
    { date: "2031-03-05", night: false }, { date: "2031-03-04", night: true },
  ]);
  store.prepare(page("2031-03-06"));
  assert.equal(savePlan(store, page("2031-03-06")).changeCount, 0);
  assert.equal(store.read(dayKey)[DAY].a, "Yes");
  assert.equal(store.read(nightKey)[SLEEP].a, "No");
});

test("day success then stale night settles only the day; recovery never resubmits it", async () => {
  const disk = storage();
  const store = new CheckinDraftStore(() => disk);
  const initial = page();
  store.prepare(initial);
  store.write(dayDraftKey(initial.date), { [DAY]: "Yes" }, {});
  store.write(nightDraftKey("2031-03-04"), { [SLEEP]: "No" }, {});
  const result = await saveSequence(store, initial, async (index) => index === 0 ? { ok: true } : { ok: false, stale: true });
  assert.deepEqual(result.calls.map((call) => call.date), ["2031-03-05", "2031-03-04"]);
  assert.deepEqual(result.current.answers, { [DAY]: "Yes" });
  assert.deepEqual(store.read(dayDraftKey(initial.date)), {});
  assert.equal(disk.entries.has(dayDraftKey(initial.date)), false);
  assert.deepEqual(store.recovery().map((entry) => entry.key), [nightDraftKey("2031-03-04")]);

  const refreshed = page("2031-03-06", "2031-03-05");
  refreshed.answers = result.current.answers;
  store.prepare(refreshed);
  assert.equal(savePlan(store, refreshed).changeCount, 0);
  assert.equal(store.recover(nightDraftKey("2031-03-04"), refreshed), true);
  const retry = await saveSequence(store, refreshed, async () => ({ ok: true }));
  assert.deepEqual(retry.calls, [{ date: "2031-03-04", answers: { [SLEEP]: "No" }, today: "2031-03-06" }]);
  assert.equal(savePlan(store, retry.current).changeCount, 0);
});

test("ordinary failure preserves unfinished answers and a retry omits the successful day", async () => {
  const storageForTest = storage();
  const store = new CheckinDraftStore(() => storageForTest);
  const initial = page();
  store.prepare(initial);
  store.write(dayDraftKey(initial.date), { [DAY]: "Yes" }, {});
  store.write(nightDraftKey("2031-03-04"), { [SLEEP]: "No" }, {});
  const result = await saveSequence(store, initial, async (index) => ({ ok: index === 0 }));
  assert.equal(store.read(nightDraftKey("2031-03-04"))[SLEEP].a, "No");
  const retry = await saveSequence(store, result.current, async () => ({ ok: true }));
  assert.deepEqual(retry.calls.map((call) => call.date), ["2031-03-04"]);
  assert.equal(store.hasPending(), false);
});

test("refresh/reopen lists original dated drafts but cannot submit them before explicit review", () => {
  const dayKey = dayDraftKey("2031-03-05");
  const nightKey = nightDraftKey("2031-03-04");
  const disk = storage({ [dayKey]: { [DAY]: { a: "Yes", base: null } }, [nightKey]: { [SLEEP]: "No" } });
  const reopened = new CheckinDraftStore(() => disk);
  const current = page("2031-03-06");
  reopened.prepare(current);
  assert.equal(reopened.recovery().length, 2);
  assert.equal(savePlan(reopened, current).changeCount, 0);
  assert.equal(reopened.recover(dayKey, current), false, "day draft cannot move to the currently selected day");
  assert.equal(reopened.recover(nightKey, current), true);
  assert.deepEqual(savePlan(reopened, current).nightPatches, [{ date: "2031-03-04", changes: { [SLEEP]: "No" } }]);
  assert.deepEqual(savePlan(reopened, current).dayPatch, {});

  const originalDay = page("2031-03-06", "2031-03-05");
  reopened.prepare(originalDay);
  assert.equal(reopened.recover(dayKey, originalDay), true);
  assert.deepEqual(savePlan(reopened, originalDay).dayPatch, { [DAY]: "Yes" });
  assert.equal(disk.entries.has(dayDraftKey("2031-03-06")), false);
  assert.equal(disk.entries.has(nightDraftKey("2031-03-06")), false);
});

test("review is constrained to the original date, scope, offered questions and finished nights", () => {
  const current = page();
  const entry = (date, night, name) => ({ key: night ? nightDraftKey(date) : dayDraftKey(date), date, night, draft: { [name]: { a: "Yes" } } });
  assert.equal(recoveryTarget(entry("2031-03-04", false, DAY), current), null);
  assert.equal(recoveryTarget(entry("2031-03-05", true, SLEEP), current), null);
  assert.equal(recoveryTarget(entry("2031-03-05", false, SLEEP), current), null);
  assert.equal(recoveryTarget(entry("2031-03-04", true, DAY), current), null);
  assert.equal(recoveryTarget(entry("2031-03-04", true, "Retired synthetic question"), current), null);
  assert.equal(recoveryTarget(entry("2031-03-04", true, SLEEP), null), null);
  // Even a malformed payload that offers tonight cannot authorize sleep recovery onto tonight.
  current.nights.push({ date: current.today, answers: {}, suggestions: {}, usualKit: {} });
  assert.equal(recoveryTarget(entry(current.today, true, SLEEP), current), null);
});

test("newer taps survive a successful request and are rebased to the acknowledged answer", async () => {
  const disk = storage();
  const store = new CheckinDraftStore(() => disk);
  const initial = page();
  const key = dayDraftKey(initial.date);
  store.prepare(initial);
  store.write(key, { [DAY]: "Yes" }, {});
  const result = await saveSequence(store, initial, async () => {
    store.write(key, { [DAY]: "No", [SECOND]: "Yes" }, {});
    return { ok: true };
  });
  assert.deepEqual(store.read(key), { [DAY]: { a: "No", base: "Yes" }, [SECOND]: { a: "Yes", base: null } });
  store.prepare(result.current);
  assert.equal(store.needsReview(key), false);
  assert.deepEqual(savePlan(store, result.current).dayPatch, { [DAY]: "No", [SECOND]: "Yes" });
});

test("a newer day tap after day success survives a later night failure", async () => {
  const disk = storage();
  const store = new CheckinDraftStore(() => disk);
  const initial = page();
  const dayKey = dayDraftKey(initial.date);
  const nightKey = nightDraftKey("2031-03-04");
  store.prepare(initial);
  store.write(dayKey, { [DAY]: "Yes" }, {});
  store.write(nightKey, { [SLEEP]: "No" }, {});
  const result = await saveSequence(store, initial, async (index) => {
    if (index === 0) return { ok: true };
    store.write(dayKey, { [DAY]: "No" }, { [DAY]: "Yes" });
    return { ok: false };
  });
  assert.deepEqual(store.read(dayKey), { [DAY]: { a: "No", base: "Yes" } });
  assert.deepEqual(savePlan(store, result.current), {
    dayPatch: { [DAY]: "No" },
    nightPatches: [{ date: "2031-03-04", changes: { [SLEEP]: "No" } }],
    changeCount: 2,
  });
});

test("clear and same-value retaps made while saving retain their newer draft identity", () => {
  const disk = storage();
  const store = new CheckinDraftStore(() => disk);
  const current = page();
  const key = dayDraftKey(current.date);
  store.prepare(current);
  store.write(key, { [DAY]: "Yes", [SECOND]: "Yes" }, {});
  const sent = store.read(key);
  store.write(key, { [DAY]: null, [SECOND]: "No" }, {});
  store.write(key, { [SECOND]: "Yes" }, {});
  store.settle(key, { [DAY]: "Yes", [SECOND]: "Yes" }, sent);
  assert.deepEqual(store.read(key), { [DAY]: { a: null, base: "Yes" }, [SECOND]: { a: "Yes", base: "Yes" } });
  current.answers = { [DAY]: "Yes", [SECOND]: "Yes" };
  store.prepare(current);
  assert.deepEqual(savePlan(store, current).dayPatch, { [DAY]: null }, "same-value newer intent is preserved but is not redundantly posted");
});

test("baseline conflicts are held until review, which adopts the latest baseline without redating", () => {
  const disk = storage();
  const store = new CheckinDraftStore(() => disk);
  const current = page();
  const key = dayDraftKey(current.date);
  store.prepare(current);
  store.write(key, { [DAY]: "Yes" }, {});
  current.answers = { [DAY]: "No" };
  store.prepare(current);
  assert.equal(store.needsReview(key), true);
  assert.deepEqual(savePlan(store, current).dayPatch, {});
  assert.equal(store.write(key, { [SECOND]: "Yes" }, current.answers), false, "fresh taps cannot overwrite an unreviewed draft");
  assert.equal(store.recover(key, current), true);
  assert.deepEqual(store.read(key), { [DAY]: { a: "Yes", base: "No" } });
  assert.deepEqual(savePlan(store, current).dayPatch, { [DAY]: "Yes" });
});

test("reopening a day or night draft equal to confirmed saved answers does not block fresh taps", () => {
  for (const isNight of [false, true]) {
    const disk = storage();
    const current = page();
    const key = isNight ? nightDraftKey(current.nights[0].date) : dayDraftKey(current.date);
    const name = isNight ? SLEEP : DAY;
    const answers = { [name]: "Yes" };
    if (isNight) current.nights[0].answers = answers;
    else current.answers = answers;
    const first = new CheckinDraftStore(() => disk);
    first.prepare(current);
    first.write(key, { [name]: "No" }, answers);
    first.write(key, { [name]: "Yes" }, answers);

    const reopened = new CheckinDraftStore(() => disk);
    reopened.prepare(current);
    assert.deepEqual(reopened.recovery(), []);
    assert.deepEqual(reopened.read(key), {});
    assert.equal(disk.entries.has(key), false);
    assert.equal(reopened.write(key, { [name]: "No" }, answers), true);
    assert.equal(reopened.needsReview(key), false);
  }
});

test("a same-as-baseline newer tap survives an opposite in-flight save", () => {
  const disk = storage();
  const current = page();
  current.answers = { [DAY]: "Yes" };
  const key = dayDraftKey(current.date);
  const store = new CheckinDraftStore(() => disk);
  store.prepare(current);
  store.write(key, { [DAY]: "No" }, current.answers);
  const sent = store.read(key);
  store.write(key, { [DAY]: "Yes" }, current.answers);
  store.settle(key, { [DAY]: "No" }, sent);
  current.answers = { [DAY]: "No" };
  store.prepare(current);
  assert.deepEqual(store.read(key), { [DAY]: { a: "Yes", base: "No" } });
  assert.deepEqual(savePlan(store, current).dayPatch, { [DAY]: "Yes" });
});

test("pruning an already-saved answer retains a null that suppresses a suggestion", () => {
  const current = page();
  const key = dayDraftKey(current.date);
  current.answers = { [DAY]: "Yes" };
  current.suggestions = { [SECOND]: { answer: "Yes", source: "synthetic" } };
  const disk = storage({ [key]: { [DAY]: { a: "Yes", base: "Yes" }, [SECOND]: { a: null, base: null } } });
  const store = new CheckinDraftStore(() => disk);
  store.prepare(current);
  assert.deepEqual(store.read(key), { [SECOND]: { a: null, base: null } });
  assert.equal(store.needsReview(key), true);
  assert.equal(store.recover(key, current), true);
  store.write(key, { [DAY]: "No" }, current.answers);
  assert.deepEqual(savePlan(store, current).dayPatch, { [DAY]: "No" }, "the suppressed suggestion must not ride along with the new tap");
});

test("explicit discard removes only that draft and leaves the other original date intact", () => {
  const dayKey = dayDraftKey("2031-03-05");
  const nightKey = nightDraftKey("2031-03-04");
  const disk = storage({ [dayKey]: { [DAY]: "Yes" }, [nightKey]: { [SLEEP]: "No" } });
  const store = new CheckinDraftStore(() => disk);
  store.prepare(page());
  store.discard(dayKey, store.recovery().find((entry) => entry.key === dayKey).draft);
  assert.deepEqual(store.read(dayKey), {});
  assert.equal(disk.entries.has(dayKey), false);
  assert.equal(store.read(nightKey)[SLEEP].a, "No");
  assert.deepEqual(store.recovery().map((entry) => entry.key), [nightKey]);
  assert.equal(store.hasPending(), true);
});

test("discard removes only reviewed entries, preserving another tab's new or changed answers", () => {
  for (const changeReviewed of [false, true]) {
    const current = page();
    const key = dayDraftKey(current.date);
    const disk = storage({ [key]: { [DAY]: { a: "Yes", base: null } } });
    const first = new CheckinDraftStore(() => disk);
    first.prepare(current);
    const reviewed = first.recovery()[0].draft;
    const second = new CheckinDraftStore(() => disk);
    second.prepare(current);
    second.recover(key, current);
    second.write(key, { ...(changeReviewed ? { [DAY]: "No" } : {}), [SECOND]: "Yes" }, {});

    first.discard(key, reviewed);
    const expected = { ...(changeReviewed ? { [DAY]: { a: "No", base: null } } : {}), [SECOND]: { a: "Yes", base: null } };
    assert.deepEqual(first.read(key), expected);
    assert.deepEqual(JSON.parse(disk.entries.get(key)), expected);
    assert.equal(first.needsReview(key), true, "unseen retained answers still need their own explicit review");
  }
});

test("discard preserves a newer local tap even when it returns to the reviewed value", () => {
  const current = page();
  const key = dayDraftKey(current.date);
  const disk = storage({ [key]: { [DAY]: { a: "Yes", base: null } } });
  const store = new CheckinDraftStore(() => disk);
  store.prepare(current);
  const reviewed = store.recovery()[0].draft;
  store.recover(key, current);
  store.write(key, { [DAY]: "No" }, {});
  store.write(key, { [DAY]: "Yes" }, {});
  store.discard(key, reviewed);
  assert.deepEqual(store.read(key), { [DAY]: { a: "Yes", base: null } });
  assert.equal(store.needsReview(key), true);
});

test("blank today to yesterday to today navigation does not quarantine fresh taps", () => {
  const disk = storage();
  const store = new CheckinDraftStore(() => disk);
  const today = page();
  const key = dayDraftKey(today.date);
  store.prepare(today);
  store.prepare(page(today.today, "2031-03-04"));
  store.prepare(today);
  assert.equal(store.write(key, { [DAY]: "Yes" }, {}), true);
  assert.equal(store.needsReview(key), false, "an empty draft from another tab selection is not pending recovery");
  assert.equal(store.write(key, { [SECOND]: "No" }, {}), true);
  assert.deepEqual(savePlan(store, today).dayPatch, { [DAY]: "Yes", [SECOND]: "No" });
  assert.deepEqual(store.recovery(), []);
});

test("a successfully settled empty day stays editable after a later night goes stale", async () => {
  const disk = storage();
  const store = new CheckinDraftStore(() => disk);
  const initial = page();
  const key = dayDraftKey(initial.date);
  store.prepare(initial);
  store.write(key, { [DAY]: "Yes" }, {});
  store.write(nightDraftKey("2031-03-04"), { [SLEEP]: "No" }, {});
  const result = await saveSequence(store, initial, async (index) => index === 0 ? { ok: true } : { ok: false, stale: true });
  assert.deepEqual(store.read(key), {});
  const refreshed = page("2031-03-06", initial.date);
  refreshed.answers = result.current.answers;
  store.prepare(refreshed);
  assert.equal(store.write(key, { [DAY]: "No" }, refreshed.answers), true);
  assert.equal(store.needsReview(key), false);
  assert.equal(store.write(key, { [SECOND]: "Yes" }, refreshed.answers), true);
  assert.deepEqual(savePlan(store, refreshed).dayPatch, { [DAY]: "No", [SECOND]: "Yes" });
});

test("two open pages preserve distinct pending questions in their shared dated storage key", () => {
  const disk = storage();
  const first = new CheckinDraftStore(() => disk);
  const second = new CheckinDraftStore(() => disk);
  const current = page();
  const key = dayDraftKey(current.date);
  first.prepare(current);
  second.prepare(current);
  first.write(key, { [DAY]: "Yes" }, {});
  second.write(key, { [SECOND]: "No" }, {});
  const expected = { [DAY]: { a: "Yes", base: null }, [SECOND]: { a: "No", base: null } };
  assert.deepEqual(JSON.parse(disk.entries.get(key)), expected);
  assert.deepEqual(first.read(key), expected);
  assert.deepEqual(second.read(key), expected);
});

test("settling one page's save preserves the other page's newer answer and additional question", () => {
  const disk = storage();
  const first = new CheckinDraftStore(() => disk);
  const second = new CheckinDraftStore(() => disk);
  const current = page();
  const key = dayDraftKey(current.date);
  first.prepare(current);
  second.prepare(current);
  first.write(key, { [DAY]: "Yes" }, {});
  const sent = first.read(key);
  second.write(key, { [DAY]: "No", [SECOND]: "Yes" }, {});
  first.settle(key, { [DAY]: "Yes" }, sent);
  const expected = { [DAY]: { a: "No", base: "Yes" }, [SECOND]: { a: "Yes", base: null } };
  assert.deepEqual(first.read(key), expected);
  assert.deepEqual(JSON.parse(disk.entries.get(key)), expected);
  current.answers = { [DAY]: "Yes" };
  first.prepare(current);
  assert.deepEqual(savePlan(first, current).dayPatch, { [DAY]: "No", [SECOND]: "Yes" });
});

test("storage getter failure retains memory across refresh and dated review", () => {
  const store = new CheckinDraftStore(() => { throw new Error("synthetic storage disabled"); });
  const current = page();
  const key = dayDraftKey(current.date);
  store.prepare(current);
  assert.equal(store.write(key, { [DAY]: "Yes" }, {}), true);
  store.write(key, { [SECOND]: "No" }, {});
  store.prepare(current);
  assert.deepEqual(savePlan(store, current).dayPatch, { [DAY]: "Yes", [SECOND]: "No" });
  store.holdAll();
  store.prepare(page("2031-03-06", "2031-03-05"));
  assert.equal(store.recovery()[0].date, "2031-03-05");
  assert.equal(store.recover(key, page("2031-03-06", "2031-03-05")), true);
  assert.equal(store.read(key)[DAY].a, "Yes");
  assert.equal(store.storageFailed, true);
});

test("individual storage failures never erase known pending drafts during refresh", () => {
  for (const method of ["getItem", "setItem", "length", "key"]) {
    const disk = storage();
    const store = new CheckinDraftStore(() => disk);
    const current = page();
    const key = dayDraftKey(current.date);
    store.prepare(current);
    store.write(key, { [DAY]: "Yes" }, {});
    disk.fail.add(method);
    if (method === "getItem") store.read(dayDraftKey("2031-03-01"));
    store.write(key, { [SECOND]: "No" }, {});
    store.prepare(current);
    assert.deepEqual(savePlan(store, current).dayPatch, { [DAY]: "Yes", [SECOND]: "No" }, method);
    assert.equal(store.storageFailed, true, method);
  }
});

test("a failed initial read never overwrites or removes previously unread stored information", () => {
  const key = dayDraftKey("2031-03-05");
  for (const unread of [JSON.stringify({ [SECOND]: "No" }), "{malformed-but-preserved"]) {
    const disk = storage();
    disk.entries.set(key, unread);
    if (unread.startsWith('{"')) disk.fail.add("getItem");
    const store = new CheckinDraftStore(() => disk);
    store.prepare(page());
    disk.fail.clear();
    assert.equal(store.write(key, { [DAY]: "Yes" }, {}), true, "new taps still work in memory");
    assert.deepEqual(store.read(key), { [DAY]: { a: "Yes", base: null } });
    assert.equal(disk.entries.get(key), unread, "a working write cannot overwrite the unread record");
    store.discard(key, store.read(key));
    assert.deepEqual(store.read(key), {});
    assert.equal(disk.entries.get(key), unread, "discard of the new in-memory draft cannot delete unread information");
    assert.equal(store.storageFailed, true);
  }
});

test("failed removal cannot resurrect acknowledged or explicitly discarded drafts in memory", () => {
  for (const action of ["settle", "discard"]) {
    const disk = storage();
    const store = new CheckinDraftStore(() => disk);
    const current = page();
    const key = dayDraftKey(current.date);
    store.prepare(current);
    store.write(key, { [DAY]: "Yes" }, {});
    const sent = store.read(key);
    disk.fail.add("removeItem");
    if (action === "settle") {
      store.settle(key, { [DAY]: "Yes" }, sent);
      current.answers = { [DAY]: "Yes" };
    } else store.discard(key, sent);
    store.prepare(current);
    assert.equal(disk.entries.has(key), true, "the fake disk still contains the stale value");
    assert.deepEqual(store.read(key), {}, action);
    assert.equal(store.hasPending(), false, action);
    assert.equal(savePlan(store, current).changeCount, 0, action);
    assert.equal(store.storageFailed, true, action);
  }
});

test("drafts older than the selectable window remain discoverable and cannot be recovered onto a newer date", () => {
  const oldDay = dayDraftKey("2030-01-02");
  const oldNight = nightDraftKey("2030-01-01");
  const disk = storage({ [oldDay]: { [DAY]: { a: "Yes", base: null } }, [oldNight]: { [SLEEP]: { a: null, base: "No" } }, unrelated: { [DAY]: "No" } });
  const store = new CheckinDraftStore(() => disk);
  const current = page();
  store.prepare(current);
  assert.deepEqual(store.recovery().map(({ date, night }) => ({ date, night })), [
    { date: "2030-01-02", night: false }, { date: "2030-01-01", night: true },
  ]);
  for (const key of [oldDay, oldNight]) {
    assert.equal(store.recover(key, current), false);
    assert.ok(Object.keys(store.read(key)).length > 0);
    assert.ok(disk.entries.has(key));
  }
  assert.equal(savePlan(store, current).changeCount, 0);
  assert.deepEqual([...disk.entries.keys()].sort(), [oldDay, oldNight, "unrelated"].sort());
});
