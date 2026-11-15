import { startPersonalize } from "@/lib/personalize-registry";

/**
 * "Personalize" from the sidebar, the phone drawer or the command palette, on any page: the page's own parts when
 * it has some, otherwise the app-wide arrangement (side panel order, which the continuous scroll follows). The
 * code for that loads only now.
 */
export function personalizeNow(): "page" | "app" {
  if (startPersonalize()) return "page";
  void import("./app-session").then((m) => m.startAppSession()).catch(() => {});
  return "app";
}

/** Start loading the editor early (hover / focus on an entry). */
export function preloadPersonalize() {
  void import("./editor-loader").then((m) => m.preloadEditor()).catch(() => {});
}
