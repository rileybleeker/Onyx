"use client";

import { useCallback, useRef, useState } from "react";
import type { NormalizedIngredient } from "@/lib/dsld";

/**
 * Custom-product flow: photo → Claude vision extraction → editable review →
 * save to pds.supplement_products (and optionally log one intake).
 *
 * Rendered inside the existing "Add product" modal as a fallback for items
 * that aren't in the NIH DSLD. UNII alignment happens server-side against
 * the existing library, so cross-product compound rollup still works.
 */

interface Draft {
  brand_name: string;
  full_name: string;
  serving_size: string; // string to allow empty input
  serving_unit: string;
  servings_per_container: string;
  physical_state: string;
  ingredients: NormalizedIngredient[];
}

type Step = "upload" | "extracting" | "review";

const EMPTY_DRAFT: Draft = {
  brand_name: "",
  full_name: "",
  serving_size: "",
  serving_unit: "",
  servings_per_container: "",
  physical_state: "",
  ingredients: [],
};

const CATEGORY_OPTIONS = ["vitamin", "mineral", "botanical", "amino_acid", "other"];
const UNIT_OPTIONS = [
  "mg",
  "mcg",
  "g",
  "IU",
  "mcg DFE",
  "mcg RAE",
  "mg NE",
  "billion CFU",
  "mL",
  "%",
];

async function resizeToBase64Jpeg(file: File): Promise<{ data: string; media_type: "image/jpeg" }> {
  const dataUrl = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("Image failed to load"));
    i.src = dataUrl;
  });
  const maxEdge = 1600;
  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  ctx.drawImage(img, 0, 0, w, h);
  const blob = await new Promise<Blob>((res, rej) =>
    canvas.toBlob(
      (b) => (b ? res(b) : rej(new Error("Canvas toBlob returned null"))),
      "image/jpeg",
      0.85,
    ),
  );
  const base64 = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => {
      const url = r.result as string;
      res(url.slice(url.indexOf(",") + 1));
    };
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
  return { data: base64, media_type: "image/jpeg" };
}

function ingredientToDraftRow(i: Partial<NormalizedIngredient>): NormalizedIngredient {
  return {
    name: i.name ?? null,
    ingredient_group: i.ingredient_group ?? null,
    unii_code: i.unii_code ?? null,
    category: i.category ?? null,
    quantity: i.quantity ?? null,
    unit: i.unit ?? null,
    percent_dv: i.percent_dv ?? null,
    forms: i.forms ?? [],
    notes: i.notes ?? null,
  };
}

function todayEt(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

interface Props {
  /** Date that an optional immediate intake should be attributed to. */
  logDate: string;
  /** Called after a successful save (and optional intake log). */
  onSaved: () => Promise<void> | void;
  /** Called when an intake was actually logged (doses > 0) — drives the toast. */
  onLogged?: () => void;
  /** Called when the user cancels back to the DSLD search view. */
  onBack: () => void;
}

export default function CustomSupplementFlow({ logDate, onSaved, onLogged, onBack }: Props) {
  const [step, setStep] = useState<Step>("upload");
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const [photoName, setPhotoName] = useState<string | null>(null);
  const [extractionMeta, setExtractionMeta] = useState<Record<string, unknown> | null>(null);
  const [doses, setDoses] = useState<string>("1");
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const handlePhoto = useCallback(async (file: File) => {
    setError(null);
    setStep("extracting");
    setPhotoName(file.name);
    try {
      const { data, media_type } = await resizeToBase64Jpeg(file);
      const res = await fetch("/api/supplements/extract-from-photo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_base64: data, media_type }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Extraction failed");
      const p = json.product as {
        brand_name: string | null;
        full_name: string | null;
        serving_size: number | null;
        serving_unit: string | null;
        servings_per_container: number | null;
        physical_state: string | null;
        ingredients: NormalizedIngredient[];
      };
      setDraft({
        brand_name: p.brand_name ?? "",
        full_name: p.full_name ?? "",
        serving_size: p.serving_size != null ? String(p.serving_size) : "",
        serving_unit: p.serving_unit ?? "",
        servings_per_container: p.servings_per_container != null ? String(p.servings_per_container) : "",
        physical_state: p.physical_state ?? "",
        ingredients: (p.ingredients ?? []).map(ingredientToDraftRow),
      });
      setExtractionMeta({
        model: "claude-sonnet-4-20250514",
        usage: json.usage,
        reference_size: json.reference_size,
        stop_reason: json.stop_reason,
      });
      setStep("review");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("upload");
    }
  }, []);

  function updateIngredient(idx: number, patch: Partial<NormalizedIngredient>) {
    setDraft((d) => ({
      ...d,
      ingredients: d.ingredients.map((row, i) => (i === idx ? { ...row, ...patch } : row)),
    }));
  }

  function removeIngredient(idx: number) {
    setDraft((d) => ({
      ...d,
      ingredients: d.ingredients.filter((_, i) => i !== idx),
    }));
  }

  function addIngredient() {
    setDraft((d) => ({
      ...d,
      ingredients: [...d.ingredients, ingredientToDraftRow({})],
    }));
  }

  async function save() {
    setError(null);
    if (!draft.full_name.trim()) {
      setError("Product name is required.");
      return;
    }
    if (draft.ingredients.length === 0) {
      setError("Add at least one ingredient.");
      return;
    }
    // Filter out blank ingredients (no name).
    const validIngredients = draft.ingredients
      .filter((i) => (i.name ?? "").trim().length > 0)
      .map((i) => ({
        ...i,
        // Coerce quantity / percent_dv string-edited fields back to numbers.
        quantity: i.quantity == null || Number.isNaN(Number(i.quantity)) ? null : Number(i.quantity),
        percent_dv:
          i.percent_dv == null || Number.isNaN(Number(i.percent_dv)) ? null : Number(i.percent_dv),
      }));
    if (validIngredients.length === 0) {
      setError("Add at least one named ingredient.");
      return;
    }

    setSaving(true);
    try {
      const saveRes = await fetch("/api/supplements/custom-product", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brand_name: draft.brand_name.trim() || null,
          full_name: draft.full_name.trim(),
          serving_size: draft.serving_size ? Number(draft.serving_size) : null,
          serving_unit: draft.serving_unit.trim() || null,
          servings_per_container: draft.servings_per_container ? Number(draft.servings_per_container) : null,
          physical_state: draft.physical_state.trim() || null,
          ingredients: validIngredients,
          extraction_meta: extractionMeta,
        }),
      });
      const saveJson = await saveRes.json();
      if (!saveRes.ok) throw new Error(saveJson.error ?? "Save failed");

      const numDoses = Number(doses);
      if (Number.isFinite(numDoses) && numDoses > 0) {
        const logRes = await fetch("/api/supplements/log-intake", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            product_id: saveJson.product_id,
            doses: numDoses,
            intake_date: logDate || todayEt(),
            intake_time: new Date().toISOString(),
          }),
        });
        if (!logRes.ok) throw new Error(await logRes.text());
        onLogged?.();
      }

      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[11px] uppercase tracking-wide text-text-tertiary font-mono">
          Custom product · photo extraction
        </p>
        <button
          onClick={onBack}
          className="text-[10px] text-text-tertiary hover:text-text-secondary font-mono underline underline-offset-2"
        >
          ← back to DSLD search
        </button>
      </div>

      {step === "upload" && (
        <div className="space-y-3">
          <p className="text-[11px] text-text-tertiary leading-relaxed">
            Snap or upload a photo of the <span className="text-text-secondary">Supplement Facts panel</span>.
            Claude will read the ingredients and align them with the FDA UNII codes
            already in your library so totals roll up across products.
          </p>
          <div className="flex gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handlePhoto(file);
                // Reset so picking the same file twice still re-triggers.
                if (fileRef.current) fileRef.current.value = "";
              }}
            />
            <button
              onClick={() => fileRef.current?.click()}
              className="flex-1 px-3 py-2 text-[12px] font-mono text-text-primary bg-[#1DB954]/15 hover:bg-[#1DB954]/25 border border-[#1DB954]/30 rounded-[4px] transition-colors"
            >
              📷 Take or upload photo
            </button>
          </div>
          {error && (
            <p className="text-[11px] font-mono text-red-400 break-words">{error}</p>
          )}
          <p className="text-[10px] text-text-tertiary leading-relaxed">
            Photo is sent to Claude for OCR and then discarded — nothing is saved to storage.
          </p>
        </div>
      )}

      {step === "extracting" && (
        <div className="py-10 text-center space-y-2">
          <p className="text-[12px] text-text-primary font-mono">Reading the label…</p>
          <p className="text-[10px] text-text-tertiary">
            {photoName ?? "photo"} → Claude vision → aligned ingredients
          </p>
          <div className="inline-block w-6 h-6 border-2 border-[#1DB954]/30 border-t-[#1DB954] rounded-full animate-spin" />
        </div>
      )}

      {step === "review" && (
        <div className="space-y-3">
          <p className="text-[11px] text-text-tertiary leading-relaxed">
            Review the extracted label. Fix anything the vision pass got wrong — quantities and
            dosage units are the usual suspects. <span className="text-amber-400/80">UNII codes shown beside
            recognized compounds</span> mean this ingredient will sum across brands.
          </p>

          {/* Product header fields */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-text-tertiary font-mono mb-1">
                Brand
              </label>
              <input
                value={draft.brand_name}
                onChange={(e) => setDraft((d) => ({ ...d, brand_name: e.target.value }))}
                className="w-full px-2 py-1.5 text-[12px] bg-black/30 border border-border-subtle rounded-[4px] text-text-primary focus:border-[#1DB954]/40 outline-none"
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-text-tertiary font-mono mb-1">
                Product name *
              </label>
              <input
                value={draft.full_name}
                onChange={(e) => setDraft((d) => ({ ...d, full_name: e.target.value }))}
                className="w-full px-2 py-1.5 text-[12px] bg-black/30 border border-border-subtle rounded-[4px] text-text-primary focus:border-[#1DB954]/40 outline-none"
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-text-tertiary font-mono mb-1">
                Serving size
              </label>
              <input
                value={draft.serving_size}
                onChange={(e) => setDraft((d) => ({ ...d, serving_size: e.target.value }))}
                inputMode="decimal"
                className="w-full px-2 py-1.5 text-[12px] bg-black/30 border border-border-subtle rounded-[4px] text-text-primary focus:border-[#1DB954]/40 outline-none"
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-text-tertiary font-mono mb-1">
                Serving unit
              </label>
              <input
                value={draft.serving_unit}
                onChange={(e) => setDraft((d) => ({ ...d, serving_unit: e.target.value }))}
                placeholder="Tablet(s) / Capsule(s) / g"
                className="w-full px-2 py-1.5 text-[12px] bg-black/30 border border-border-subtle rounded-[4px] text-text-primary focus:border-[#1DB954]/40 outline-none"
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-text-tertiary font-mono mb-1">
                Servings / container
              </label>
              <input
                value={draft.servings_per_container}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, servings_per_container: e.target.value }))
                }
                inputMode="numeric"
                className="w-full px-2 py-1.5 text-[12px] bg-black/30 border border-border-subtle rounded-[4px] text-text-primary focus:border-[#1DB954]/40 outline-none"
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wide text-text-tertiary font-mono mb-1">
                Form
              </label>
              <input
                value={draft.physical_state}
                onChange={(e) => setDraft((d) => ({ ...d, physical_state: e.target.value }))}
                placeholder="Tablet / Capsule / Softgel / Powder"
                className="w-full px-2 py-1.5 text-[12px] bg-black/30 border border-border-subtle rounded-[4px] text-text-primary focus:border-[#1DB954]/40 outline-none"
              />
            </div>
          </div>

          {/* Ingredients editor */}
          <div className="pt-2">
            <div className="flex items-center justify-between mb-1">
              <p className="text-[11px] uppercase tracking-wide text-text-tertiary font-mono">
                Ingredients ({draft.ingredients.length})
              </p>
              <button
                onClick={addIngredient}
                className="text-[10px] text-text-tertiary hover:text-text-primary font-mono"
              >
                + add row
              </button>
            </div>
            <div className="space-y-2 max-h-[40vh] overflow-y-auto">
              {draft.ingredients.map((ing, idx) => (
                <div
                  key={idx}
                  className="bg-black/30 border border-border-subtle rounded-[4px] p-2 space-y-1.5"
                >
                  <div className="flex items-start gap-2">
                    <input
                      value={ing.name ?? ""}
                      onChange={(e) => updateIngredient(idx, { name: e.target.value })}
                      placeholder="Ingredient (as printed)"
                      className="flex-1 px-2 py-1 text-[12px] bg-black/30 border border-border-subtle rounded-[4px] text-text-primary focus:border-[#1DB954]/40 outline-none"
                    />
                    <button
                      onClick={() => removeIngredient(idx)}
                      className="px-2 py-1 text-[14px] text-text-tertiary/60 hover:text-red-400"
                      title="Remove ingredient"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    <input
                      value={ing.ingredient_group ?? ""}
                      onChange={(e) =>
                        updateIngredient(idx, { ingredient_group: e.target.value || null })
                      }
                      placeholder="Group (canonical)"
                      className="px-2 py-1 text-[11px] bg-black/30 border border-border-subtle rounded-[4px] text-text-primary focus:border-[#1DB954]/40 outline-none"
                    />
                    <input
                      value={ing.unii_code ?? ""}
                      onChange={(e) => updateIngredient(idx, { unii_code: e.target.value || null })}
                      placeholder="UNII"
                      title={ing.unii_code ? "Recognized — will roll up cross-brand" : "Leave blank if unknown"}
                      className={`px-2 py-1 text-[11px] font-mono bg-black/30 border rounded-[4px] focus:border-[#1DB954]/40 outline-none ${
                        ing.unii_code
                          ? "border-amber-400/40 text-amber-300"
                          : "border-border-subtle text-text-primary"
                      }`}
                    />
                    <select
                      value={ing.category ?? ""}
                      onChange={(e) => updateIngredient(idx, { category: e.target.value || null })}
                      className="px-2 py-1 text-[11px] font-mono bg-black/30 border border-border-subtle rounded-[4px] text-text-primary focus:border-[#1DB954]/40 outline-none"
                    >
                      <option value="">category…</option>
                      {CATEGORY_OPTIONS.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    <input
                      value={ing.quantity ?? ""}
                      onChange={(e) =>
                        updateIngredient(idx, {
                          quantity: e.target.value === "" ? null : Number(e.target.value),
                        })
                      }
                      placeholder="Quantity"
                      inputMode="decimal"
                      className="px-2 py-1 text-[11px] bg-black/30 border border-border-subtle rounded-[4px] text-text-primary focus:border-[#1DB954]/40 outline-none"
                    />
                    <input
                      list={`units-${idx}`}
                      value={ing.unit ?? ""}
                      onChange={(e) => updateIngredient(idx, { unit: e.target.value || null })}
                      placeholder="Unit"
                      className="px-2 py-1 text-[11px] bg-black/30 border border-border-subtle rounded-[4px] text-text-primary focus:border-[#1DB954]/40 outline-none"
                    />
                    <datalist id={`units-${idx}`}>
                      {UNIT_OPTIONS.map((u) => (
                        <option key={u} value={u} />
                      ))}
                    </datalist>
                    <input
                      value={ing.percent_dv ?? ""}
                      onChange={(e) =>
                        updateIngredient(idx, {
                          percent_dv: e.target.value === "" ? null : Number(e.target.value),
                        })
                      }
                      placeholder="% DV"
                      inputMode="decimal"
                      className="px-2 py-1 text-[11px] bg-black/30 border border-border-subtle rounded-[4px] text-text-primary focus:border-[#1DB954]/40 outline-none"
                    />
                  </div>
                </div>
              ))}
              {draft.ingredients.length === 0 && (
                <p className="text-[11px] text-text-tertiary font-mono text-center py-3">
                  No ingredients extracted — add manually below.
                </p>
              )}
            </div>
          </div>

          {/* Dose + Save */}
          <div className="pt-3 border-t border-border-subtle/40">
            <label className="block text-[10px] uppercase tracking-wide text-text-tertiary font-mono mb-1">
              Log doses now?
            </label>
            <input
              value={doses}
              onChange={(e) => setDoses(e.target.value)}
              type="number"
              min="0"
              step="0.5"
              className="w-full mb-2 px-2 py-1.5 text-[13px] bg-black/30 border border-border-subtle rounded-[4px] text-text-primary focus:border-[#1DB954]/40 outline-none"
            />
            <p className="text-[10px] text-text-tertiary mb-3">
              Set to <span className="text-text-secondary">0</span> to save the product without logging an intake yet.
            </p>

            {error && (
              <p className="text-[11px] font-mono text-red-400 mb-2 break-words">{error}</p>
            )}

            <div className="flex gap-2 justify-end">
              <button
                onClick={() => {
                  setStep("upload");
                  setDraft(EMPTY_DRAFT);
                  setExtractionMeta(null);
                }}
                disabled={saving}
                className="px-3 py-2 text-[12px] text-text-secondary hover:text-text-primary disabled:opacity-40 transition-colors"
              >
                Re-shoot
              </button>
              <button
                onClick={save}
                disabled={saving}
                className="px-4 py-2 text-[12px] font-medium text-text-primary bg-[#1DB954]/20 hover:bg-[#1DB954]/30 disabled:opacity-40 disabled:cursor-not-allowed border border-[#1DB954]/40 rounded-[4px] transition-colors"
              >
                {saving
                  ? "Saving…"
                  : Number(doses) > 0
                  ? `Save + log ${doses} dose${Number(doses) === 1 ? "" : "s"}`
                  : "Save to library"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
