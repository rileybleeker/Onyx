"use client";

import { useSyncExternalStore } from "react";
import { currentEditingKey, editorRef, subscribeTargets } from "@/lib/personalize-registry";
import type { EditorModule } from "./editor-loader";

const none = () => null;

/**
 * Mounted once by AppShell: while Personalize is on (any page), draws the "Personalizing …" banner from the editor
 * chunk. Costs nothing otherwise (the editor code loads only when Personalize starts).
 */
export default function PersonalizeHost() {
  const editing = useSyncExternalStore(subscribeTargets, currentEditingKey, none);
  const editor = useSyncExternalStore(subscribeTargets, editorRef, none) as EditorModule | null;
  if (!editing || !editor) return null;
  return <editor.Banner />;
}
