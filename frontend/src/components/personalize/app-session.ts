import { AREAS_KEY } from "@/lib/nav-areas";
import { beginEdit } from "@/lib/personalize-store";
import { loadEditor } from "./editor-loader";
import { logFailure } from "./start";

/** Personalize on a page without parts of its own: arrange the side panel (the app's area order). */
export function startAppSession() {
  beginEdit(AREAS_KEY, "app", "the side panel");
  void loadEditor().catch((e: unknown) => logFailure("editor load", e));
}
