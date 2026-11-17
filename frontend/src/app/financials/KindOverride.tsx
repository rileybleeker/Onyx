"use client";

import { useEffect, useRef } from "react";
import { AutosaveStatus } from "@/components/AutosaveStatus";
import { saveRequest } from "@/lib/autosave";
import { useAutosave } from "@/lib/use-autosave";

/**
 * One-tap asset/liability label for one unclassified balance (/financials, "Unclassified" group).
 * The tap IS the action, so it saves at once (autosave); after a save the page is re-read so the
 * account moves into the Assets or Liabilities group. Clear removes the override, so the source's
 * own label (or its absence) applies again.
 */
export default function KindOverride({ accountId, onSaved }: { accountId: string; onSaved?: () => void }) {
  const { state, change, retry } = useAutosave<{ kind: "asset" | "liability" | null }>(
    `finance-kind:${accountId}`,
    {
      save: async (value) => {
        await saveRequest("/api/finance/account-kind", { method: "PUT", body: { account_id: accountId, kind: value.kind } });
      },
      // A tap saves at once; the value only ever changes by a tap, so there is nothing to debounce.
      delayMs: 0,
    },
    { kind: null },
  );
  const savedAt = state.savedAt;
  const lastSavedAt = useRef<number | null>(null);
  useEffect(() => {
    if (savedAt !== null && savedAt !== lastSavedAt.current) {
      lastSavedAt.current = savedAt;
      if (onSaved) onSaved();
      else window.location.reload();
    }
  }, [savedAt, onSaved]);

  const btn = "rounded-control border border-border-subtle px-2 py-0.5 text-[11px] disabled:opacity-50";
  return (
    <span className="mt-1 flex items-center gap-1">
      <button className={btn} disabled={state.status === "saving"} onClick={() => change({ kind: "asset" })}>
        Asset
      </button>
      <button className={btn} disabled={state.status === "saving"} onClick={() => change({ kind: "liability" })}>
        Liability
      </button>
      <button className={btn} disabled={state.status === "saving"} onClick={() => change({ kind: null })}>
        Clear
      </button>
      <AutosaveStatus state={state} onRetry={retry} />
    </span>
  );
}
