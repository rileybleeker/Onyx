"use client";

import { useEffect, useMemo, useState } from "react";

/** A product from the /supplements library picker (subset of the page's Product). */
export interface StackPickerProduct {
  product_id: string;
  brand_name: string | null;
  full_name: string | null;
  serving_size: number | null;
  serving_unit: string | null;
  ingredient_count: number;
}

export interface StackItemDraft {
  product_id: string;
  doses: number;
  full_name?: string | null;
  brand_name?: string | null;
}

/** Stack being edited. stack_id null = creating a new stack. */
export interface EditableStack {
  stack_id: number | null;
  name: string;
  description: string | null;
  items: StackItemDraft[];
}

interface Props {
  open: boolean;
  stack: EditableStack | null; // null while closed; {stack_id:null,...} for a new stack
  products: StackPickerProduct[];
  onClose: () => void;
  onSaved: () => void;
}

export default function StackEditorModal({ open, stack, products, onClose, onSaved }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [items, setItems] = useState<StackItemDraft[]>([]);
  const [addProductId, setAddProductId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!stack) return;
    setName(stack.name);
    setDescription(stack.description ?? "");
    setItems(stack.items.map((i) => ({ ...i })));
    setAddProductId("");
    setError(null);
  }, [stack]);

  const isNew = !stack?.stack_id;

  // Products not already in the stack, for the "add" dropdown.
  const available = useMemo(() => {
    const chosen = new Set(items.map((i) => i.product_id));
    return products.filter((p) => !chosen.has(p.product_id));
  }, [products, items]);

  const productById = useMemo(
    () => Object.fromEntries(products.map((p) => [p.product_id, p])),
    [products],
  );

  if (!open || !stack) return null;

  function addItem(product_id: string) {
    if (!product_id) return;
    const p = productById[product_id];
    setItems((prev) => [
      ...prev,
      { product_id, doses: 1, full_name: p?.full_name ?? null, brand_name: p?.brand_name ?? null },
    ]);
    setAddProductId("");
  }

  function setDoses(product_id: string, value: string) {
    const n = Number(value);
    setItems((prev) =>
      prev.map((i) => (i.product_id === product_id ? { ...i, doses: Number.isFinite(n) ? n : i.doses } : i)),
    );
  }

  function removeItem(product_id: string) {
    setItems((prev) => prev.filter((i) => i.product_id !== product_id));
  }

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Give the stack a name.");
      return;
    }
    const cleanItems = items
      .filter((i) => i.product_id)
      .map((i) => ({ product_id: i.product_id, doses: i.doses > 0 ? i.doses : 1 }));
    if (cleanItems.length === 0) {
      setError("Add at least one product.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/supplements/stacks", {
        method: isNew ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(isNew ? {} : { stack_id: stack!.stack_id }),
          name: trimmed,
          description: description.trim() || null,
          items: cleanItems,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function archive() {
    if (isNew) return;
    if (!confirm(`Delete the "${name}" stack?\n\nYour logged intake history is kept — only the saved template is removed.`)) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/supplements/stacks?stack_id=${stack!.stack_id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const totalDoses = items.reduce((s, i) => s + (i.doses > 0 ? i.doses : 0), 0);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-surface-card border border-border-subtle rounded-[6px] shadow-card p-5 w-full max-w-lg mt-12"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[14px] font-medium text-text-primary">
            {isNew ? "New stack" : "Edit stack"}
          </h2>
          <button
            onClick={onClose}
            disabled={saving}
            className="text-[11px] text-text-tertiary hover:text-text-secondary font-mono disabled:opacity-40"
          >
            Close
          </button>
        </div>

        <label className="block text-[10px] font-mono uppercase tracking-wide text-text-tertiary mb-1">
          Name
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={saving}
          placeholder="e.g. Morning stack"
          className="w-full mb-3 px-3 py-2 text-[14px] bg-black/40 border border-border-subtle rounded-[4px] text-text-primary focus:border-[#1DB954]/50 outline-none disabled:opacity-50"
        />

        <label className="block text-[10px] font-mono uppercase tracking-wide text-text-tertiary mb-1">
          Description (optional)
        </label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={saving}
          placeholder="e.g. taken right after waking"
          className="w-full mb-4 px-3 py-2 text-[13px] bg-black/40 border border-border-subtle rounded-[4px] text-text-primary focus:border-[#1DB954]/50 outline-none disabled:opacity-50"
        />

        <div className="flex items-center justify-between mb-1">
          <label className="block text-[10px] font-mono uppercase tracking-wide text-text-tertiary">
            Products ({items.length}) · {totalDoses} doses
          </label>
        </div>

        {items.length === 0 ? (
          <p className="text-[11px] text-text-tertiary font-mono py-3 text-center border border-dashed border-border-subtle rounded-[4px] mb-3">
            No products yet — add one below.
          </p>
        ) : (
          <div className="space-y-1.5 mb-3">
            {items.map((it) => {
              const p = productById[it.product_id];
              return (
                <div
                  key={it.product_id}
                  className="flex items-center gap-2 bg-black/30 border border-border-subtle rounded-[4px] px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-[12px] text-text-primary truncate">
                      {p?.full_name ?? it.full_name ?? it.product_id}
                    </p>
                    <p className="text-[10px] text-text-tertiary font-mono truncate">
                      {p?.brand_name ?? it.brand_name ?? "—"}
                      {p?.serving_size && p?.serving_unit ? ` · ${p.serving_size} ${p.serving_unit}` : ""}
                    </p>
                  </div>
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.5"
                    value={it.doses}
                    onChange={(e) => setDoses(it.product_id, e.target.value)}
                    disabled={saving}
                    className="w-[64px] px-2 py-1 text-[13px] tabular-nums bg-black/40 border border-border-subtle rounded-[4px] text-text-primary focus:border-[#1DB954]/50 outline-none disabled:opacity-50"
                    title="Doses logged for this product"
                  />
                  <span className="text-[10px] text-text-tertiary font-mono shrink-0">dose</span>
                  <button
                    onClick={() => removeItem(it.product_id)}
                    disabled={saving}
                    className="px-1 text-[14px] text-text-tertiary/60 hover:text-red-400 disabled:opacity-40 transition-colors"
                    aria-label="Remove product"
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Add-product picker driven by the already-loaded library. */}
        <div className="flex gap-2 mb-4">
          <select
            value={addProductId}
            onChange={(e) => addItem(e.target.value)}
            disabled={saving || available.length === 0}
            className="flex-1 px-3 py-2 text-[12px] bg-black/40 border border-border-subtle rounded-[4px] text-text-primary focus:border-[#1DB954]/50 outline-none disabled:opacity-50"
          >
            <option value="">
              {available.length === 0 ? "All library products added" : "+ Add a product…"}
            </option>
            {available.map((p) => (
              <option key={p.product_id} value={p.product_id}>
                {(p.full_name ?? p.product_id) + (p.brand_name ? ` — ${p.brand_name}` : "")}
              </option>
            ))}
          </select>
        </div>

        {error && <p className="text-[11px] font-mono text-red-400 mb-3 break-words">{error}</p>}

        <div className="flex justify-between gap-2">
          {!isNew ? (
            <button
              onClick={archive}
              disabled={saving}
              className="px-3 py-2 text-[12px] text-red-400/80 hover:text-red-400 disabled:opacity-40 transition-colors"
            >
              Delete stack
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              onClick={onClose}
              disabled={saving}
              className="px-3 py-2 text-[12px] text-text-secondary hover:text-text-primary disabled:opacity-40 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="px-4 py-2 text-[12px] font-medium text-text-primary bg-[#1DB954]/20 hover:bg-[#1DB954]/30 disabled:opacity-40 disabled:cursor-not-allowed border border-[#1DB954]/40 rounded-[4px] transition-colors"
            >
              {saving ? "Saving…" : isNew ? "Create stack" : "Save changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
