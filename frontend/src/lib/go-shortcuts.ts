/**
 * "Go to" keyboard shortcuts, the Gmail / Linear / GitHub way: press G, then a page's letter within 1.5 s.
 * Letters are the `shortcut` of each item in lib/nav.ts (unique; tests/go-shortcuts.test.cjs checks it).
 * Ignored while typing (input, textarea, select, contenteditable) and while a modifier key is held, so
 * Ctrl / Cmd + K stays the command palette's.
 *
 * Import-free: unit-tested in plain node. components/GoShortcuts.tsx listens and navigates.
 */

export const GO_PREFIX = "g";
export const GO_WINDOW_MS = 1500;

/** The hint shown next to a page, e.g. "G H". */
export function goHint(shortcut: string): string {
  return shortcut ? `G ${shortcut.toUpperCase()}` : "";
}

export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
  target?: unknown;
}

interface TargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
  closest?: (selector: string) => unknown;
}

/** True when the key goes into a text field (or anything editable), where a letter is typing, not a command. */
export function isTypingTarget(target: unknown): boolean {
  const t = target as TargetLike | null;
  if (!t || typeof t !== "object") return false;
  const tag = (t.tagName ?? "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (t.isContentEditable) return true;
  const role = t.getAttribute?.("role");
  if (role === "textbox" || role === "combobox" || role === "searchbox") return true;
  try { if (t.closest?.('[contenteditable=""],[contenteditable="true"]')) return true; } catch { /* not an element */ }
  return false;
}

export function hasModifier(e: KeyLike): boolean {
  return !!(e.ctrlKey || e.metaKey || e.altKey || e.shiftKey);
}

export interface GoItem { href: string; shortcut: string }

/**
 * The G-then-letter state machine. `onKey` returns the href to open (and the caller prevents the default),
 * or null. A lone G arms it for GO_WINDOW_MS; any other key, a modifier, typing or the time running out disarms.
 */
export function createGoShortcuts(items: GoItem[], now: () => number = () => Date.now()) {
  const byKey = new Map(items.filter((i) => i.shortcut).map((i) => [i.shortcut.toLowerCase(), i.href]));
  let armedAt: number | null = null;
  return {
    get armed() { return armedAt !== null && now() - armedAt <= GO_WINDOW_MS; },
    onKey(e: KeyLike): string | null {
      if (e.defaultPrevented || e.isComposing || hasModifier(e) || isTypingTarget(e.target)) { armedAt = null; return null; }
      if (e.repeat) return null;
      const key = e.key.length === 1 ? e.key.toLowerCase() : "";
      if (!key) { armedAt = null; return null; }
      const live = armedAt !== null && now() - armedAt <= GO_WINDOW_MS;
      if (live) {
        armedAt = null;
        return byKey.get(key) ?? null;
      }
      if (key === GO_PREFIX) { armedAt = now(); return null; }
      armedAt = null;
      return null;
    },
    reset() { armedAt = null; },
  };
}
