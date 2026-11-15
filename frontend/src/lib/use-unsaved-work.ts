"use client";

import { useEffect, useId } from "react";
import { unsavedWork } from "@/lib/unsaved-work";

/** A form holding edits that are not saved yet: the automatic updater offers its button instead of reloading. */
export function useUnsavedWork(dirty: boolean, name = "form"): void {
  const id = useId();
  const key = `${name}:${id}`;
  useEffect(() => {
    unsavedWork.setDirty(key, dirty);
    return () => unsavedWork.setDirty(key, false);
  }, [key, dirty]);
}
