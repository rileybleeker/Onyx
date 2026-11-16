/**
 * Keyboard focus around the "Personalizing …" banner (PersonalizeEditor's Banner). Dependency-free so a node test
 * can load it on its own.
 *
 * - The banner is drawn in a host that is the FIRST child of <body>, so it comes first in the Tab order (it is fixed
 *   at the top of the screen; a host appended to <body> put Cancel and Done after every control of the page and of
 *   the continuous scroll).
 * - When the banner opens it takes focus (the Personalize button that started it turns disabled, which dropped
 *   focus on <body>: the next Tab then landed on Sign out).
 * - When it closes (Cancel, Done, Clear) focus goes back to the control that started it, or else to the control
 *   that had focus when the banner opened (on a phone: the More tab, as the drawer holding Personalize is closed).
 */

/** The minimal element surface used here (an HTMLElement in the app, a stub in tests). */
export interface Focusable {
  isConnected: boolean;
  disabled?: boolean;
  focus: (options?: FocusOptions) => void;
  closest: (selector: string) => unknown;
  getClientRects: () => { length: number };
}

/** Attribute on the banner's host element (the first child of <body>). */
export const BANNER_HOST_ATTR = "data-pz-banner-host";

/** Whether focus can be given to `el`: still in the page, shown, enabled, and not in an inert or hidden subtree. */
export function canTakeFocus(el: unknown): el is Focusable {
  if (!el || typeof el !== "object") return false;
  const f = el as Partial<Focusable>;
  if (typeof f.focus !== "function" || typeof f.closest !== "function" || typeof f.getClientRects !== "function") return false;
  if (!f.isConnected) return false;
  if (f.disabled === true) return false;
  if (f.closest("[inert],[aria-hidden='true'],[hidden]")) return false;
  return f.getClientRects().length > 0;
}

/** Where focus goes when the banner closes: the first candidate that can take it (null: leave focus alone). */
export function returnFocusTarget(candidates: readonly unknown[]): Focusable | null {
  for (const c of candidates) if (canTakeFocus(c)) return c;
  return null;
}

/** The banner's host: an element inserted as the first child of `body` (the caller removes it when done). */
export function createBannerHost(doc: Document): HTMLElement {
  const host = doc.createElement("div");
  host.setAttribute(BANNER_HOST_ATTR, "");
  doc.body.prepend(host);
  return host;
}
