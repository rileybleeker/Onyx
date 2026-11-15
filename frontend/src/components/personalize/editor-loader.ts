import { editorSnapshot, setEditorModule } from "@/lib/personalize-store";
import { logFailure } from "./start";

/**
 * The Personalize editor (banner, part frames, drag and drop, menus, column chooser) is a separate chunk,
 * loaded only when Personalize mode starts, or on hover / focus of the entry that starts it.
 */
export type EditorModule = typeof import("./PersonalizeEditor");

let loading: Promise<EditorModule> | null = null;

export function loadEditor(): Promise<EditorModule> {
  if (!loading) {
    loading = import("./PersonalizeEditor").then(
      (mod) => {
        setEditorModule(mod);
        return mod;
      },
      (error) => {
        loading = null; // a failed chunk load (offline) can be retried
        throw error;
      },
    );
  }
  return loading;
}

export function preloadEditor() {
  void loadEditor().catch((e: unknown) => logFailure("editor load", e));
}

export function loadedEditor(): EditorModule | null {
  return (editorSnapshot() as EditorModule | null) ?? null;
}
