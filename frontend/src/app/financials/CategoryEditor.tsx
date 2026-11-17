"use client";

import { useState } from "react";
import { STANDARD_CATEGORIES } from "@/lib/finance-categories";

/**
 * Change one transaction's category, or every transaction from its merchant (a rule). Writes through
 * PUT /api/finance/categories (owner session); the bank data itself is not changed.
 */
export default function CategoryEditor({
  txnKey,
  merchantKey,
  category,
  onSaved,
}: {
  txnKey: string;
  merchantKey: string;
  category: string | null;
  /** Re-read the data after a save (the scroll section); without it the page reloads. */
  onSaved?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(category ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/finance/categories", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      // The server's error text is never shown: a failed response gets the fixed copy below.
      if (!res.ok) {
        setError("Not saved. Try again.");
        return;
      }
      setOpen(false);
      // A full reload (not router.refresh) so this also works where the app router is not mounted.
      if (onSaved) onSaved();
      else window.location.reload();
    } catch {
      setError("Not saved. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };
  if (!open) {
    return (
      <button className="text-left hover:text-text-primary hover:underline" onClick={() => setOpen(true)} title="Change category">
        {category?.trim() || "Uncategorized"}
      </button>
    );
  }
  const options = [...new Set([...(category ? [category] : []), ...STANDARD_CATEGORIES])];
  return (
    <span className="flex flex-wrap items-center gap-1">
      <select className="rounded-control border border-border-subtle bg-transparent px-1 py-0.5 text-[12px]" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Category">
        <option value="">(category)</option>
        {options.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <button className="rounded-control border border-border-subtle px-2 py-0.5 text-[11px] disabled:opacity-50" disabled={busy || !value} onClick={() => save({ txnKey, category: value })}>
        This one
      </button>
      {merchantKey && (
        <button className="rounded-control border border-border-subtle px-2 py-0.5 text-[11px] disabled:opacity-50" disabled={busy || !value} onClick={() => save({ merchantKey, category: value })}>
          All from this merchant
        </button>
      )}
      <button className="text-[11px] text-text-tertiary" onClick={() => setOpen(false)}>
        cancel
      </button>
      {error && <span className="text-[11px] text-down">{error}</span>}
    </span>
  );
}
