"use client";

import { useEffect, useId } from "react";
import { useFeedScope } from "@/lib/feed-scope";
import { unsavedWork } from "@/lib/unsaved-work";

/**
 * A form holding edits that are not saved yet: the automatic updater offers its button instead of reloading, and the
 * continuous scroll keeps the page it is drawn in mounted until the edits are saved or discarded.
 */
export function useUnsavedWork(dirty: boolean, name = "form"): void {
  const id = useId();
  const scope = useFeedScope();
  const key = `${name}:${id}`;
  useEffect(() => {
    unsavedWork.setDirty(key, dirty, scope);
    return () => unsavedWork.setDirty(key, false);
  }, [key, dirty, scope]);
}
