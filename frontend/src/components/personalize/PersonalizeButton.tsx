"use client";

import { useSyncExternalStore } from "react";
import { Settings2 } from "lucide-react";
import { currentEditingKey, currentTarget, subscribeTargets } from "@/lib/personalize-registry";

const none = () => null;

/**
 * "Personalize" in the sidebar footer and the phone's More drawer (BC: Settings ⚙ → Personalize). Shown only on
 * a page that has personalizable parts. Hover / focus starts loading the editor so the banner opens at once.
 */
export default function PersonalizeButton({ className, onStart }: { className?: string; onStart?: () => void }) {
  const target = useSyncExternalStore(subscribeTargets, currentTarget, none);
  const editing = useSyncExternalStore(subscribeTargets, currentEditingKey, none);
  if (!target) return null;
  const active = editing === target.key;
  return (
    <button
      type="button"
      onClick={() => {
        onStart?.();
        target.start();
      }}
      onPointerEnter={target.preload}
      onFocus={target.preload}
      disabled={active}
      aria-pressed={active}
      title={active ? "Personalizing this page" : "Move, hide, resize and collapse the parts of this page"}
      className={className}
    >
      <Settings2 className="w-[17px] h-[17px] shrink-0" strokeWidth={1.75} aria-hidden />
      {active ? "Personalizing…" : "Personalize"}
    </button>
  );
}
