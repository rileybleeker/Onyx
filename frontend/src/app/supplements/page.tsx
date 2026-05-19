"use client";

import { useCallback, useEffect, useState } from "react";
import StatCard from "@/components/StatCard";
import ChartCard from "@/components/ChartCard";
import BarcodeScannerModal from "@/components/BarcodeScannerModal";

interface Product {
  product_id: string;
  dsld_id: number | null;
  brand_name: string | null;
  full_name: string | null;
  upc_sku: string | null;
  serving_size: number | null;
  serving_unit: string | null;
  physical_state: string | null;
  ingredient_count: number;
  categories: string[];
}

interface Intake {
  intake_id: number;
  intake_date: string;
  intake_time: string | null;
  product_id: string;
  doses: number;
  notes: string | null;
  brand_name: string | null;
  full_name: string | null;
}

interface CompoundRow {
  compound_key: string;
  ingredient_group: string | null;
  ingredient_name: string | null;
  unii_code: string | null;
  category: string | null;
  unit: string | null;
  total_amount: number;
  total_doses: number;
  source_product_count: number;
}

interface DsldHit {
  id: string;
  brand_name: string | null;
  full_name: string | null;
  upc_sku: string | null;
  physical_state: string | null;
}

const CATEGORY_COLORS: Record<string, string> = {
  vitamin: "text-amber-400",
  mineral: "text-cyan-400",
  botanical: "text-emerald-400",
  amino_acid: "text-purple-400",
  "amino acid": "text-purple-400",
  other: "text-text-tertiary",
};

function categoryColor(c: string | null): string {
  if (!c) return "text-text-tertiary";
  return CATEGORY_COLORS[c.toLowerCase()] ?? "text-text-tertiary";
}

function formatDoseTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export default function SupplementsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [intakes, setIntakes] = useState<Intake[]>([]);
  const [compounds, setCompounds] = useState<CompoundRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyProductId, setBusyProductId] = useState<string | null>(null);

  // Add product flow
  const [addOpen, setAddOpen] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchHits, setSearchHits] = useState<DsldHit[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [seedingId, setSeedingId] = useState<string | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [pRes, tRes] = await Promise.all([
        fetch("/api/supplements/products").then((r) => r.json()),
        fetch("/api/supplements/today").then((r) => r.json()),
      ]);
      setProducts(pRes.products ?? []);
      setIntakes(tRes.intakes ?? []);
      setCompounds(tRes.compounds ?? []);
    } catch (e) {
      console.error("Supplements load:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  async function logIntake(product_id: string) {
    setBusyProductId(product_id);
    try {
      const res = await fetch("/api/supplements/log-intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product_id, intake_time: new Date().toISOString() }),
      });
      if (!res.ok) throw new Error(await res.text());
      await loadAll();
    } catch (e) {
      console.error("Log intake:", e);
    } finally {
      setBusyProductId(null);
    }
  }

  async function undoIntake(intake_id: number) {
    setBusyProductId(`undo-${intake_id}`);
    try {
      await fetch(`/api/supplements/log-intake?intake_id=${intake_id}`, { method: "DELETE" });
      await loadAll();
    } finally {
      setBusyProductId(null);
    }
  }

  async function runSearch(q: string) {
    if (!q.trim()) return;
    setSearching(true);
    setSearchError(null);
    setSearchHits([]);
    try {
      const res = await fetch(`/api/supplements/search?q=${encodeURIComponent(q)}&size=15`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Search failed");
      setSearchHits(json.hits ?? []);
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  }

  async function seedProduct(dsld_id: number) {
    setSeedingId(String(dsld_id));
    try {
      const res = await fetch("/api/supplements/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dsld_id }),
      });
      if (!res.ok) throw new Error(await res.text());
      await loadAll();
      setAddOpen(false);
      setSearchQ("");
      setSearchHits([]);
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : String(e));
    } finally {
      setSeedingId(null);
    }
  }

  // Barcode scanner → DSLD search → if 1 hit, auto-seed; else show candidates.
  const handleBarcodeDetected = useCallback(
    async (code: string) => {
      setScannerOpen(false);
      setAddOpen(true);
      setSearchQ(code);
      await runSearch(code);
    },
    [],
  );

  const intakeCount = intakes.length;
  const distinctCompounds = compounds.length;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-medium text-text-primary tracking-tight">Supplements</h1>
          <p className="text-[12px] text-text-tertiary mt-0.5">
            DSLD-backed library · ingredient-level intake tracking with UNII rollups
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setScannerOpen(true)}
            className="px-3 py-1.5 text-[11px] font-mono tracking-wide text-text-primary bg-[#1DB954]/15 hover:bg-[#1DB954]/25 border border-[#1DB954]/30 rounded-[4px] transition-colors"
          >
            Scan barcode
          </button>
          <button
            onClick={() => setAddOpen(true)}
            className="px-3 py-1.5 text-[11px] font-mono tracking-wide text-text-primary bg-black/30 hover:bg-white/5 border border-border-subtle rounded-[4px] transition-colors"
          >
            + Add product
          </button>
        </div>
      </header>

      {/* KPI Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Library" value={products.length} sublabel="products" />
        <StatCard label="Logged Today" value={intakeCount} sublabel="intake events" />
        <StatCard label="Distinct Compounds" value={distinctCompounds} sublabel="today" />
        <StatCard
          label="Total Doses Today"
          value={intakes.reduce((s, i) => s + Number(i.doses), 0)}
          sublabel="servings consumed"
        />
      </div>

      {loading && (
        <p className="text-[12px] text-text-tertiary font-mono">Loading…</p>
      )}

      {!loading && (
        <>
          {/* Log intake — product picker */}
          <ChartCard
            title="Log intake today"
            subtitle="Tap a product to add one dose. Each click writes a fresh intake event with a timestamp."
            source="DSLD"
          >
            {products.length === 0 ? (
              <p className="text-[11px] text-text-tertiary font-mono py-6 text-center">
                Library is empty. Add a product to get started.
              </p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {products.map((p) => (
                  <button
                    key={p.product_id}
                    onClick={() => logIntake(p.product_id)}
                    disabled={busyProductId === p.product_id}
                    className="flex items-center justify-between gap-3 px-3 py-2 text-left bg-black/30 hover:bg-white/[0.03] border border-border-subtle hover:border-border-hover rounded-[4px] transition-colors disabled:opacity-50"
                  >
                    <div className="min-w-0">
                      <p className="text-[12px] text-text-primary truncate">{p.full_name ?? "—"}</p>
                      <p className="text-[10px] text-text-tertiary font-mono truncate">
                        {p.brand_name ?? "—"} · {p.ingredient_count} ingredients
                        {p.serving_size && p.serving_unit
                          ? ` · ${p.serving_size} ${p.serving_unit}`
                          : ""}
                      </p>
                    </div>
                    <span className="text-[16px] text-[#1DB954]/80 font-mono shrink-0">+</span>
                  </button>
                ))}
              </div>
            )}
          </ChartCard>

          {/* Today's intakes */}
          {intakes.length > 0 && (
            <ChartCard
              title="Today's intakes"
              subtitle={`${intakes.length} events · newest first`}
              source="DSLD"
            >
              <div className="space-y-1.5">
                {intakes.map((i) => (
                  <div
                    key={i.intake_id}
                    className="flex items-center justify-between gap-3 py-1.5 border-b border-border-subtle/40 last:border-b-0 text-[12px] font-mono"
                  >
                    <div className="flex items-baseline gap-2 min-w-0">
                      <span className="text-text-tertiary tabular-nums shrink-0 w-[68px]">
                        {formatDoseTime(i.intake_time)}
                      </span>
                      <span className="text-text-primary truncate">{i.full_name ?? "—"}</span>
                      <span className="text-text-tertiary truncate">· {i.brand_name ?? "—"}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-text-secondary tabular-nums">
                        {i.doses}× dose
                      </span>
                      <button
                        onClick={() => undoIntake(i.intake_id)}
                        disabled={busyProductId === `undo-${i.intake_id}`}
                        className="text-[10px] text-text-tertiary hover:text-red-400 transition-colors disabled:opacity-40"
                      >
                        undo
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </ChartCard>
          )}

          {/* Today's compound totals — rolled up by UNII */}
          <ChartCard
            title="Today's compound totals"
            subtitle="Cross-product rollup by UNII code — Vitamin C from a multivitamin and a standalone Vitamin C tablet sum here."
            source="DSLD"
            info="Each row is one compound. total_amount sums every intake event today × that product's dose. source_product_count tells you how many different products in your library contribute to that compound."
          >
            {compounds.length === 0 ? (
              <p className="text-[11px] text-text-tertiary font-mono py-6 text-center">
                No intakes logged today yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[12px] font-mono">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wide text-text-tertiary border-b border-border-subtle">
                      <th className="text-left py-2 px-1 font-normal w-[80px]">Category</th>
                      <th className="text-left py-2 px-1 font-normal">Compound</th>
                      <th className="text-right py-2 px-1 font-normal w-[100px]">Amount</th>
                      <th className="text-right py-2 px-1 font-normal w-[60px]">Sources</th>
                    </tr>
                  </thead>
                  <tbody>
                    {compounds.map((c) => (
                      <tr
                        key={c.compound_key}
                        className="border-b border-border-subtle/50 hover:bg-white/[0.02]"
                      >
                        <td className={`py-1.5 px-1 ${categoryColor(c.category)} uppercase text-[10px] tracking-wide`}>
                          {c.category ?? "—"}
                        </td>
                        <td className="py-1.5 px-1 text-text-primary">
                          {c.ingredient_group ?? c.ingredient_name ?? c.compound_key}
                        </td>
                        <td className="py-1.5 px-1 text-right text-text-secondary tabular-nums">
                          {Number(c.total_amount).toLocaleString(undefined, { maximumFractionDigits: 2 })}{" "}
                          <span className="text-text-tertiary">{c.unit}</span>
                        </td>
                        <td className="py-1.5 px-1 text-right text-text-tertiary tabular-nums">
                          {c.source_product_count}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </ChartCard>
        </>
      )}

      {/* Add Product modal */}
      {addOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto"
          onClick={() => setAddOpen(false)}
        >
          <div
            className="bg-surface-card border border-border-subtle rounded-[6px] shadow-card p-5 w-full max-w-lg mt-12"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[14px] font-medium text-text-primary">Add a product to your library</h2>
              <button
                onClick={() => setAddOpen(false)}
                className="text-[11px] text-text-tertiary hover:text-text-secondary font-mono"
              >
                Close
              </button>
            </div>
            <p className="text-[11px] text-text-tertiary mb-3 leading-relaxed">
              Search the NIH Dietary Supplement Label Database by brand, product name, or UPC. Tap a hit to seed it into your library with the full ingredient list.
            </p>
            <div className="flex gap-2 mb-3">
              <input
                type="text"
                placeholder="e.g. centrum, lion's mane, 300054470607"
                value={searchQ}
                onChange={(e) => setSearchQ(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && runSearch(searchQ)}
                className="flex-1 px-3 py-2 text-[13px] bg-black/30 border border-border-subtle rounded-[4px] text-text-primary focus:border-[#1DB954]/40 outline-none"
              />
              <button
                onClick={() => runSearch(searchQ)}
                disabled={searching || !searchQ.trim()}
                className="px-3 py-2 text-[11px] font-mono text-text-primary bg-[#1DB954]/20 hover:bg-[#1DB954]/30 disabled:opacity-40 border border-[#1DB954]/40 rounded-[4px] transition-colors"
              >
                {searching ? "…" : "Search"}
              </button>
              <button
                onClick={() => {
                  setAddOpen(false);
                  setScannerOpen(true);
                }}
                className="px-3 py-2 text-[11px] font-mono text-text-secondary hover:text-text-primary bg-black/30 hover:bg-white/[0.05] border border-border-subtle rounded-[4px] transition-colors"
                title="Scan a barcode"
              >
                📷
              </button>
            </div>

            {searchError && (
              <p className="text-[11px] font-mono text-red-400 mb-2 break-words">{searchError}</p>
            )}

            <div className="space-y-1.5 max-h-[50vh] overflow-y-auto">
              {searchHits.map((h) => (
                <button
                  key={h.id}
                  onClick={() => seedProduct(Number(h.id))}
                  disabled={seedingId === h.id}
                  className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left bg-black/30 hover:bg-white/[0.04] border border-border-subtle hover:border-border-hover rounded-[4px] transition-colors disabled:opacity-50"
                >
                  <div className="min-w-0">
                    <p className="text-[12px] text-text-primary truncate">{h.full_name ?? "—"}</p>
                    <p className="text-[10px] text-text-tertiary font-mono truncate">
                      {h.brand_name ?? "—"}
                      {h.upc_sku ? ` · UPC ${h.upc_sku}` : ""}
                      {h.physical_state ? ` · ${h.physical_state}` : ""}
                    </p>
                  </div>
                  <span className="text-[10px] text-text-tertiary font-mono shrink-0">
                    {seedingId === h.id ? "seeding…" : "+ add"}
                  </span>
                </button>
              ))}
              {!searching && searchHits.length === 0 && searchQ && !searchError && (
                <p className="text-[11px] text-text-tertiary font-mono py-3 text-center">
                  No matches. Try a different brand or product name.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      <BarcodeScannerModal
        open={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onDetected={handleBarcodeDetected}
      />
    </div>
  );
}
