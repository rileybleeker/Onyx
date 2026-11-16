/**
 * Keyboard focus around the "Personalizing …" banner (PersonalizeEditor's Banner). Dependency-free so a node test
 * can load it on its own.
 *
 * - The banner is drawn in a host that is the FIRST child of <body>, so it comes first in the Tab order (it is fixed
 *   at the top of the screen; a host appended to <body> put Cancel and Done after every control of the page and of
 *   the continuous scroll).
 * - When the banner opens it takes focus if focus was lost (the side panel's Personalize button turns disabled,
 *   which dropped focus on <body>: the next Tab then landed on Sign out; the command palette closes). A control that
 *   still holds focus keeps it (Today's overview "Personalize" stays enabled, and its cards' handles come next).
 *   While a modal dialog the banner is not part of is open, focus stays inside it: the side-panel session started
 *   from the phone drawer keeps the drawer open.
 * - When it closes (Cancel, Done, Clear) focus goes back to the control that started it, or else to the control
 *   that had focus when the banner opened (on a phone: the More tab, as the drawer holding Personalize is closed),
 *   or else, when it was started from inside a dialog that has closed since (the command palette, which hands focus
 *   back to nothing), to the Search control that opens the palette.
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

/** An open modal dialog (the phone's navigation drawer while it is open, the command palette). */
export const MODAL_DIALOG = '[role="dialog"][aria-modal="true"]';

/** Attribute on the phone drawer's side-panel arranger (NavArranger's DrawerArranger). */
export const ARRANGER_ATTR = "data-pz-arranger";

/** The parts of `document` read here (a Document in the app, a stub in tests). */
export interface FocusDoc {
  querySelector: (selector: string) => unknown;
  activeElement: unknown;
  body: unknown;
}

interface Container {
  contains: (node: unknown) => boolean;
  querySelector: (selector: string) => unknown;
}

/**
 * Where focus goes when the banner opens (null: leave it where it is). The banner itself when focus was lost (on
 * <body>, or on a control that can no longer take it, like the disabled Personalize button); a control that still
 * holds focus keeps it. While a modal dialog the banner is not part of is open, focus must not leave that dialog
 * (the banner sits under its backdrop, and a screen reader would follow focus out of the modal): a control inside it
 * that has focus keeps it, otherwise (the disabled Personalize button dropped focus) the arranger's first control,
 * else the dialog's first control.
 */
export function openingFocusTarget(doc: FocusDoc, banner: unknown): Focusable | null {
  const modal = doc.querySelector(MODAL_DIALOG) as Partial<Container> | null;
  if (!modal || typeof modal.contains !== "function" || typeof modal.querySelector !== "function" || modal.contains(banner)) {
    // Focus not lost (an opener that stays enabled, like Today's overview "Personalize"): left where it is.
    const active = doc.activeElement;
    if (active && active !== doc.body && canTakeFocus(active)) return null;
    return canTakeFocus(banner) ? banner : null;
  }
  const active = doc.activeElement;
  if (active && active !== doc.body && modal.contains(active) && canTakeFocus(active)) return null;
  return returnFocusTarget([
    modal.querySelector(`[${ARRANGER_ATTR}] button:not([disabled])`),
    modal.querySelector("button:not([disabled]), a[href]"),
  ]);
}

/** Attribute on the visible controls that open the command palette (the side panel's Search, the phone's top bar). */
export const PALETTE_TRIGGER_ATTR = "data-palette-trigger";

/**
 * Where focus may go when the banner closes, in order (returnFocusTarget takes the first that can take it): the
 * control that started Personalize, what had focus when the banner opened, and, when Personalize was started from
 * inside a modal dialog (the command palette, which unmounts with its input and gives focus back to nothing), the
 * palette's Search controls; only the shown one can take focus.
 */
export function closingFocusCandidates(
  doc: { querySelectorAll: (selector: string) => ArrayLike<unknown> },
  opener: unknown,
  openerInModal: boolean,
  before: unknown,
): unknown[] {
  const list: unknown[] = [opener, before];
  if (openerInModal) list.push(...Array.from(doc.querySelectorAll(`[${PALETTE_TRIGGER_ATTR}]`)));
  return list;
}
