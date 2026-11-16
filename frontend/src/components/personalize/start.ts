import { startPersonalize } from "@/lib/personalize-registry";
import { MODAL_DIALOG } from "./banner-focus";

/** The control that started the current Personalize session (focus goes back to it when the banner closes). */
let opener: HTMLElement | null = null;
/** Whether it was inside a modal dialog (the command palette, the phone drawer), which may have closed since. */
let openerInModal = false;

export function personalizeOpener(): HTMLElement | null {
  return opener;
}

export function personalizeOpenerInModal(): boolean {
  return openerInModal;
}

/** Forget the opener once the banner has closed (it is read once per session). */
export function clearPersonalizeOpener() {
  opener = null;
  openerInModal = false;
}

/**
 * "Personalize" from the sidebar, the phone drawer or the command palette, on any page: the page's own parts when
 * it has some, otherwise the app-wide arrangement (side panel order, which the continuous scroll follows). The
 * code for that loads only now.
 */
export function personalizeNow(): "page" | "app" {
  // Read before the session starts: the Personalize button turns disabled then, which takes focus off it.
  if (typeof document !== "undefined") {
    const active = document.activeElement;
    opener = active instanceof HTMLElement && active !== document.body ? active : null;
    openerInModal = opener?.closest(MODAL_DIALOG) != null;
  }
  if (startPersonalize()) return "page";
  void import("./app-session").then((m) => m.startAppSession()).catch((e: unknown) => logFailure("start", e));
  return "app";
}

/** Start loading the editor early (hover / focus on an entry). */
export function preloadPersonalize() {
  void import("./editor-loader").then((m) => m.preloadEditor()).catch((e: unknown) => logFailure("preload", e));
}

/** A failure is logged with a code (never page content), so it is not silent. */
export function logFailure(step: string, e: unknown) {
  const name = e && typeof e === "object" && "name" in e ? String((e as { name: unknown }).name) : "error";
  console.error(`[personalize] ${step} failed: ${name}`);
}
