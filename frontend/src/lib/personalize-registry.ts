/**
 * Which page on screen can be personalized: the one piece of Personalize the shared shell (Sidebar, MobileNav,
 * CommandPalette) loads, so the "Personalize" entry costs every page a few hundred bytes. The page's <PartGrid>
 * registers itself here; the entry calls its start(). Import-free.
 */

export interface PersonalizeTarget {
  /** Layout key, e.g. "layout.analytics.hrv". */
  key: string;
  page: string;
  title: string;
  start(): void;
  /** Start loading the editor code (hover / focus on the entry). */
  preload(): void;
}

let targets: PersonalizeTarget[] = [];
let editingKey: string | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const fn of Array.from(listeners)) {
    try { fn(); } catch { /* a listener never breaks another */ }
  }
}

export function subscribeTargets(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function registerTarget(t: PersonalizeTarget): () => void {
  targets = [...targets.filter((x) => x.key !== t.key), t];
  emit();
  return () => {
    const before = targets.length;
    targets = targets.filter((x) => x !== t);
    if (targets.length !== before) emit();
  };
}

/** The page that registered last (the one on screen), or null when the page has nothing to personalize. */
export function currentTarget(): PersonalizeTarget | null {
  return targets.length ? targets[targets.length - 1] : null;
}

export function setEditingKey(key: string | null) {
  if (editingKey === key) return;
  editingKey = key;
  emit();
}

/** The page being personalized right now, or null. */
export function currentEditingKey(): string | null {
  return editingKey;
}

/** Fired by the command palette / menu entries; same as clicking "Personalize". */
export function startPersonalize(): boolean {
  const t = currentTarget();
  if (!t) return false;
  t.start();
  return true;
}
