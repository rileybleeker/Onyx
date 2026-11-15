"use client";

import { useSyncExternalStore } from "react";
import { Settings2 } from "lucide-react";
import { currentEditingKey, subscribeTargets } from "@/lib/personalize-registry";
import { personalizeNow, preloadPersonalize } from "./start";

const none = () => null;

/**
 * "Personalize" in the sidebar footer and the phone's More drawer (BC: Settings ⚙ → Personalize), on every page.
 * A page with parts personalizes its parts (and the side panel); any other page opens the side panel arrangement.
 * Hover / focus starts loading the editor so the banner opens at once.
 */
export default function PersonalizeButton({ className, onStart }: { className?: string; onStart?: (kind: "page" | "app") => void }) {
  const editing = useSyncExternalStore(subscribeTargets, currentEditingKey, none);
  const active = editing !== null;
  return (
    <button
      type="button"
      onClick={() => {
        // Start first, then tell the caller. (`onStart?.(personalizeNow())` skipped personalizeNow() whenever no
        // onStart was passed, which is the desktop sidebar: optional chaining does not evaluate the arguments.)
        const kind = personalizeNow();
        if (onStart) onStart(kind);
      }}
      onPointerEnter={preloadPersonalize}
      onFocus={preloadPersonalize}
      disabled={active}
      aria-pressed={active}
      title={active ? "Personalizing" : "Move, hide, resize and collapse the parts of this page, and rearrange the side panel"}
      className={className}
    >
      <Settings2 className="w-[17px] h-[17px] shrink-0" strokeWidth={1.75} aria-hidden />
      {active ? "Personalizing…" : "Personalize"}
    </button>
  );
}
