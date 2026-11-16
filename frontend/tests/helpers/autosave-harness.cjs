// Test helper (not a test). Lets a form test run the REAL autosave scheduler and hook (lib/autosave.ts,
// lib/use-autosave.ts) on a manual clock, so it checks what reaches the network and what the status line says
// (saved once, refused and shown, retried after an outage, sent when the page is hidden or the form is left)
// instead of how the source is written. Synthetic data only; nothing here touches a real service.
const { loadTs } = require("./load-ts.cjs");
const { mountClient, response } = require("./hook-harness.cjs");

/** A clock only the autosave scheduler reads: nothing fires until the test advances it. */
function manualTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map();
  return {
    set: (fn, ms) => { const id = next++; pending.set(id, { at: now + ms, fn }); return id; },
    clear: (id) => { pending.delete(id); },
    /** The earliest timer due within `ms` (removed), and how much of `ms` is left after it; null when none. */
    due(ms) {
      const until = now + ms;
      const hit = [...pending.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!hit) { now = until; return null; }
      pending.delete(hit[0]);
      const left = until - hit[1].at;
      now = hit[1].at;
      return { fn: hit[1].fn, left };
    },
    count: () => pending.size,
  };
}

/**
 * lib/autosave.ts for a mount: the real module (so AutosaveRefused, saveRequest and messageOf are the ones every
 * importer sees) with an Autosaver that schedules on `timers`. The real lib/use-autosave.ts builds its saver from
 * this export, so the hook under test is the shipped one, page-hidden and unmount handling included. Register it
 * with clockCache, not as a stub of one import spec.
 */
function autosaveOnClock(timers) {
  const real = loadTs("lib/autosave.ts");
  class Autosaver extends real.Autosaver {
    constructor(opts, baseline) {
      super({ ...opts, timers }, baseline);
    }
  }
  return { ...real, __esModule: true, Autosaver };
}

/** Where load-ts.cjs keeps lib/autosave.ts in a module cache, whichever spec imported it. */
const AUTOSAVE_FILE = "lib/autosave.ts";
/**
 * A module cache (for loadTs or mountClient) that already holds the clock-backed lib/autosave.ts under its file, so
 * EVERY import of it, "@/lib/autosave" or a relative "./autosave", gets that one module: one AutosaveRefused class
 * and one clock. A stub of the "@/lib/autosave" spec alone would hand a relative import a second, real copy (its
 * own AutosaveRefused, real timers): a refusal retried on its own, saves fired on the real clock.
 */
const clockCache = (timers) => new Map([[AUTOSAVE_FILE, { exports: autosaveOnClock(timers) }]]);

/** Run every scheduler timer due within `ms`, in order, letting the page settle (`settle()`) after each one. */
async function advance(timers, settle, ms) {
  for (let left = ms; ;) {
    const hit = timers.due(left);
    if (!hit) break;
    left = hit.left;
    hit.fn();
    await settle();
  }
  await settle();
}

/** A minimal event target: every listener of a name runs on dispatch (several may listen to one event). */
function eventTarget() {
  const map = new Map();
  return {
    add: (name, fn) => { if (!map.has(name)) map.set(name, new Set()); map.get(name).add(fn); },
    remove: (name, fn) => { map.get(name)?.delete(fn); },
    count: (name) => map.get(name)?.size ?? 0,
    dispatch: (name, event = {}) => { for (const fn of [...(map.get(name) ?? [])]) fn(event); },
  };
}

/**
 * document / window stand-ins whose listeners the test can fire. `hide()` is what the browser does when the tab is
 * hidden (visibilityState "hidden" + visibilitychange): the autosave hook sends what is waiting, with keepalive.
 * `windowProps` adds fields to window (location, history).
 */
function pageEvents(windowProps = {}) {
  const doc = eventTarget();
  const win = eventTarget();
  const document = { visibilityState: "visible", addEventListener: doc.add, removeEventListener: doc.remove };
  const window = { ...windowProps, addEventListener: win.add, removeEventListener: win.remove };
  return {
    document,
    window,
    hide() { document.visibilityState = "hidden"; doc.dispatch("visibilitychange"); },
    /** Fire a window event (pageshow, pagehide, beforeunload); answers false when nothing listens to it. */
    fire(name, event = {}) { if (!win.count(name)) return false; win.dispatch(name, event); return true; },
    listening: (name) => win.count(name) > 0,
  };
}

const isElement = (v) => !!v && typeof v === "object" && "$$typeof" in v;
const holdsUi = (v) => isElement(v) || (Array.isArray(v) && v.some(holdsUi));
const specNodes = (s) => [s.node, ...(s.members ?? []).flatMap(specNodes)];
function forwardOnly(name, props, visual) {
  for (const [k, v] of Object.entries(props)) {
    if (k !== "children" && !visual.includes(k) && holdsUi(v)) throw new Error(`${name} stub: prop "${k}" holds UI that the real grid renders; forward it in tests/helpers/autosave-harness.cjs`);
  }
}

/**
 * "@/components/personalize/PartGrid" stub for a hook shim without React context. The real grid renders each
 * group's `header` above its parts and the `parts` specs' nodes, so the stub renders them too (the check-in's day
 * tabs live in a header: a stub that dropped it hid them). Any other prop that holds UI throws instead of quietly
 * disappearing from the test.
 */
function partGridPassThrough() {
  function PartGrid(props) { forwardOnly("PartGrid", props, ["parts"]); return [...(props.parts ?? []).flatMap(specNodes), props.children]; }
  function PartGroup(props) { forwardOnly("PartGroup", props, ["header"]); return [props.header, props.children]; }
  function Part(props) { forwardOnly("Part", props, []); return props.children; }
  return { __esModule: true, PartGrid, PartGroup, Part, usePartOrder: (_page, ids) => [...ids] };
}

/**
 * A fetch stand-in that records every call as { url, method, body (parsed JSON), keepalive } and answers with
 * `answer(call, n)` (n = 1 for the first call). Throw a TypeError from `answer` for "Onyx could not be reached".
 */
function recordingFetch(answer) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: String(init.method ?? "GET").toUpperCase(),
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
      keepalive: !!init.keepalive,
    };
    calls.push(call);
    return answer(call, calls.length);
  };
  return { fetch, calls, writes: () => calls.filter((c) => c.method !== "GET" && c.method !== "HEAD") };
}

/** Set globals for one mount; answers the function that puts them back. */
function replaceGlobals(values) {
  const priors = Object.entries(values).map(([name, value]) => {
    const prior = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    return [name, prior];
  });
  return () => {
    for (const [name, prior] of priors.reverse()) {
      if (prior) Object.defineProperty(globalThis, name, prior);
      else delete globalThis[name];
    }
  };
}

/**
 * Mount a src component (a path) or a probe factory (see hook-harness mountClient) with the real autosave on a
 * manual clock. Every fetch is recorded (h.net) and answered by `answer(call, n)`; h.tick(ms) advances the autosave
 * clock; h.page fires page events. The form is unmounted (its pending saves stopped) before the globals are restored.
 */
async function mountAutosaving(t, target, { props = {}, stubs = {}, answer = () => response({}) } = {}) {
  const timers = manualTimers();
  const page = pageEvents();
  const net = recordingFetch(answer);
  const restore = replaceGlobals({ fetch: net.fetch, document: page.document, window: page.window });
  let h = null;
  t.after(() => {
    try {
      h?.unmount();
    } finally {
      restore();
    }
  });
  h = mountClient(target, { props, cache: clockCache(timers), stubs: { "lucide-react": { Check: () => null }, ...stubs } });
  await h.flush();
  return Object.assign({}, h, { net, page, timers, tick: (ms) => advance(timers, () => h.flush(), ms) });
}

module.exports = { manualTimers, autosaveOnClock, clockCache, advance, eventTarget, pageEvents, partGridPassThrough, recordingFetch, replaceGlobals, mountAutosaving };
