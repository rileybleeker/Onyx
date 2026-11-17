"use client";

/**
 * Reads the learning-pacing preference (lib/learning-pacing.ts) for a page. GET only: through the client cache
 * (a cached copy shows at once and is always revalidated). Never writes; the editor on /reading saves with its
 * own autosave and hands the server's answer back through `accept`.
 */

import { useCallback, useEffect, useState } from "react";
import { cachedJson, clientCache } from "@/lib/client-cache";
import { DEFAULT_PREFS, LEARNING_PREF_KEY, LEARNING_PREF_URL, parsePrefs, type LearningPrefs } from "@/lib/learning-pacing";
import { parseUiPref } from "@/lib/ui-preferences";

export interface LearningPrefsState {
  /** loading = nothing known yet; error = could not read (defaults shown, nothing claimed as saved). */
  load: "loading" | "ready" | "error";
  prefs: LearningPrefs;
  /** Riley saved settings (false = still on defaults: the weekly rhythm is not shown). */
  configured: boolean;
}

function fromRaw(raw: unknown): LearningPrefsState | null {
  try {
    const pref = parseUiPref(raw, LEARNING_PREF_KEY);
    const { prefs, configured } = parsePrefs(pref.value);
    return { load: "ready", prefs, configured };
  } catch {
    return null;
  }
}

export function useLearningPrefs(): LearningPrefsState & { accept: (raw: unknown) => void } {
  const [state, setState] = useState<LearningPrefsState>(
    () => fromRaw(clientCache.peek(LEARNING_PREF_URL)) ?? { load: "loading", prefs: { ...DEFAULT_PREFS }, configured: false },
  );
  useEffect(() => {
    let live = true;
    cachedJson(LEARNING_PREF_URL, { check: (d) => { parseUiPref(d, LEARNING_PREF_KEY); } })
      .then((raw) => { const next = fromRaw(raw); if (live && next) setState(next); })
      .catch(() => { if (live) setState((cur) => (cur.load === "ready" ? cur : { ...cur, load: "error" })); });
    return () => { live = false; };
  }, []);
  const accept = useCallback((raw: unknown) => {
    clientCache.put(LEARNING_PREF_URL, raw);
    const next = fromRaw(raw);
    if (next) setState(next);
  }, []);
  return { ...state, accept };
}
