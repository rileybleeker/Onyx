/**
 * Onyx as a desktop app (2026-11-14): the site installed from Edge or Chrome as a PWA
 * (own window, Start menu + taskbar entry, jump list, Windows notifications).
 * Pure helpers, no browser globals, so they can be tested offline (tests/desktop-app.test.cjs).
 */

/** Must equal manifest.json `start_url` (and `id`): changing it would make the browser treat it as a new app. */
export const START_URL = "/";

/**
 * Where an app launch should take the window that is already open (manifest `launch_handler`
 * `focus-existing`: the browser focuses the open window and hands it the launch URL).
 * - A plain launch (Start menu, desktop icon) carries START_URL: stay on the page Riley had open → null.
 * - A jump-list shortcut carries its own URL → that in-app path.
 * - Same page already open, a bad URL or another origin → null.
 */
export function launchTarget(targetURL: string | null | undefined, origin: string, current: string): string | null {
  if (!targetURL) return null;
  let url: URL;
  try {
    url = new URL(targetURL);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  if (url.pathname === START_URL && !url.search && !url.hash) return null;
  const path = url.pathname + url.search + url.hash;
  return path === current ? null : path;
}

/** Keyboard hint for the command palette: ⌘K on Apple devices, Ctrl K everywhere else. */
export function paletteShortcutLabel(platform: string, userAgent: string): string {
  return /Mac|iPhone|iPad|iPod/i.test(platform || userAgent) ? "⌘K" : "Ctrl K";
}

/** Keyboard hint for reloading the window: ⌘R on Apple devices, Ctrl R everywhere else. */
export function reloadShortcutLabel(platform: string, userAgent: string): string {
  return paletteShortcutLabel(platform, userAgent) === "⌘K" ? "⌘R" : "Ctrl R";
}

/**
 * Display modes in which Onyx runs in its own window with no browser toolbar, so no reload
 * button: the installed app (`standalone`, or `window-controls-overlay` when the title bar is
 * hidden). `minimal-ui` keeps the browser's own back/reload buttons, a normal tab has them too.
 */
export const INSTALLED_DISPLAY_MODES = ["standalone", "window-controls-overlay"] as const;

/** True inside the installed app window. `matches` is `(q) => matchMedia(q).matches`. */
export function isInstalledWindow(matches: (query: string) => boolean): boolean {
  return INSTALLED_DISPLAY_MODES.some((mode) => matches(`(display-mode: ${mode})`));
}
