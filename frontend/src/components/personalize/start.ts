import { startPersonalize } from "@/lib/personalize-registry";

/**
 * "Personalize" from the sidebar, the phone drawer or the command palette, on any page: the page's own parts when
 * it has some, otherwise the app-wide arrangement (side panel order, which the continuous scroll follows). The
 * code for that loads only now.
 */
export function personalizeNow(): "page" | "app" {
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
