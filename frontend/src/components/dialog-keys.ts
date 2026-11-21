/** What can take focus inside a modal dialog (same list as MobileNav's overlays). */
export const DIALOG_FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex="0"]';

/**
 * Treat an open dialog as a modal: Escape from anywhere calls `onEscape` (once per press), and Tab / Shift+Tab wrap
 * between the dialog's first and last visible focusable elements, so focus never lands on the page behind it. Focus
 * outside the dialog is brought to its first element. Returns the cleanup that removes the listener.
 */
export function trapDialogKeys(doc: Document, dialog: HTMLElement, onEscape: () => void): () => void {
  const focusable = () =>
    Array.from(dialog.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE)).filter((element) => element.getClientRects().length > 0);
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onEscape();
      return;
    }
    if (e.key !== "Tab") return;
    const elements = focusable();
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (!first || !last) {
      e.preventDefault();
      return;
    }
    const inside = dialog.contains(doc.activeElement);
    if (e.shiftKey && (doc.activeElement === first || !inside)) {
      e.preventDefault();
      (inside ? last : first).focus();
    } else if (!e.shiftKey && (doc.activeElement === last || !inside)) {
      e.preventDefault();
      first.focus();
    }
  }
  doc.addEventListener("keydown", onKey);
  return () => doc.removeEventListener("keydown", onKey);
}
