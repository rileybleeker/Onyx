// Test helper (not a test): runs a real client component from src/ with a tiny hook scheduler, no DOM.
// Same approach as tests/checkin-client.test.cjs, made reusable: useState / useRef / useMemo / useCallback /
// useEffect are shimmed, function components are expanded into a plain element tree, and `flush()` re-renders
// and runs effects until the tree settles, draining pending microtasks in between. Callers stub every module
// the component imports that needs a browser (next/navigation, lucide-react, heavy children).
// The first argument is a src path (its default export is mounted) or a factory `(load, hooks) => Component`, for a
// small probe component around a real hook: `load(rel)` loads src modules with the same stubs and one module cache
// as the rest of the mount, so the probe and the code it drives share every class and singleton.
// `cache` (a Map, see load-ts.cjs) may arrive pre-seeded: a module registered under its src file (e.g. "lib/autosave.ts")
// is what EVERY import of that file gets, whether written "@/lib/autosave" or "./autosave".
const assert = require("node:assert/strict");
const { loadTs } = require("./load-ts.cjs");

function mountClient(relPath, { props = {}, stubs = {}, cache = new Map() } = {}) {
  let ids = 0;
  let live = true;
  let dirty = true;
  let frame;
  let effects = [];
  let tree;
  const frames = new Map();
  const equal = (a, b) => a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const slot = () => [frame.slots, frame.index++];
  const hooks = {
    useId() { const [slots, i] = slot(); return slots[i] ??= `:synthetic${ids++}:`; },
    useState(initialValue) {
      const [slots, i] = slot();
      if (!(i in slots)) slots[i] = typeof initialValue === "function" ? initialValue() : initialValue;
      // After unmount a state update does nothing, as in React (a late answer cannot render the form again).
      return [slots[i], (value) => { if (!live) return; const next = typeof value === "function" ? value(slots[i]) : value; if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; } }];
    },
    useRef(value) { const [slots, i] = slot(); return slots[i] ??= { current: value }; },
    useMemo(create, deps) {
      const [slots, i] = slot();
      if (!slots[i] || !equal(slots[i].deps, deps)) slots[i] = { deps, value: create() };
      return slots[i].value;
    },
    useCallback(callback, deps) { return hooks.useMemo(() => callback, deps); },
    useEffect(effect, deps) {
      const [slots, i] = slot();
      if (!slots[i] || deps === undefined || !equal(slots[i].deps, deps)) {
        const old = slots[i];
        slots[i] = { deps, effect: true };
        effects.push(() => { old?.cleanup?.(); slots[i].cleanup = effect(); });
      }
    },
  };
  const load = (rel) => loadTs(rel, { react: hooks, ...stubs }, { cache });
  const Component = typeof relPath === "function" ? relPath(load, hooks) : load(relPath).default;
  function expand(node, id = "root") {
    if (node == null || typeof node === "boolean") return null;
    if (Array.isArray(node)) return node.map((child, i) => expand(child, `${id}/${child?.key ?? i}`));
    if (typeof node !== "object") return node;
    if (typeof node.type === "function") {
      const key = `${id}:${node.type.name}`;
      if (!frames.has(key)) frames.set(key, { slots: [], index: 0 });
      frame = frames.get(key);
      frame.index = 0;
      return expand(node.type(node.props), key);
    }
    return { type: node.type, props: { ...node.props, children: expand(node.props?.children, id) } };
  }
  async function flush(turns = 16) {
    for (let i = 0; i < turns; i++) {
      if (dirty) {
        dirty = false;
        effects = [];
        tree = expand({ type: Component, props });
        for (const effect of effects) effect();
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(dirty, false, "the synthetic hook scheduler settled");
  }
  function nodes(node = tree) {
    if (Array.isArray(node)) return node.flatMap((n) => nodes(n));
    if (!node || typeof node !== "object") return [];
    return [node, ...nodes(node.props.children)];
  }
  const text = (node = tree) => Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" ? text(node.props.children) : node == null ? "" : String(node);
  const buttons = (label) => nodes().filter((n) => n.type === "button" && (n.props["aria-label"] === label || text(n).trim() === label));
  function button(label, index = 0) {
    const found = buttons(label)[index];
    assert.ok(found, `button exists: ${label}`);
    return found;
  }
  const click = (label, index = 0) => {
    const node = button(label, index);
    assert.ok(!node.props.disabled, `button enabled: ${label}`);
    return node.props.onClick?.();
  };
  // Run every effect cleanup (timers, listeners) once, as React does on unmount; nothing renders afterwards. A second
  // call (a test's own unmount, then the mount's t.after) does nothing.
  function unmount() {
    if (!live) return;
    live = false;
    dirty = false;
    for (const f of frames.values()) {
      for (const s of f.slots) {
        if (!s || typeof s !== "object" || !s.effect || typeof s.cleanup !== "function") continue;
        const cleanup = s.cleanup;
        s.cleanup = undefined;
        cleanup();
      }
    }
  }
  // Render again with the (mutated) props object, as a parent passing new props would; `flush()` does the work.
  const rerender = () => { dirty = true; };
  return { flush, rerender, text, nodes, button, buttons, click, unmount, find: (pred) => nodes().filter(pred) };
}

/** A fetch Response stand-in. */
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(body), text: async () => JSON.stringify(body) });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

/** Replace globals for one test (restored by t.after). */
function withGlobals(t, values) {
  for (const [name, value] of Object.entries(values)) {
    const prior = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => (prior ? Object.defineProperty(globalThis, name, prior) : delete globalThis[name]));
  }
}

module.exports = { mountClient, response, deferred, withGlobals };
