"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import StatCard from "@/components/StatCard";
import ChartCard from "@/components/ChartCard";
import RangeFilter from "@/components/RangeFilter";
import BarcodeScannerModal from "@/components/BarcodeScannerModal";
import EditIntakeModal, { type EditableIntake } from "@/components/EditIntakeModal";
import CustomSupplementFlow from "@/components/CustomSupplementFlow";
import { rangeDays, rangeLabel, type Range } from "@/lib/queries";

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

/** Current ET date as YYYY-MM-DD — used as the default intake_date. */
function etTodayStr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/** Pretty-print a YYYY-MM-DD as "May 20" for inline labels. */
function formatShortDate(ymd: string): string {
  // Construct as midday UTC so timezone shifts can't bump the day.
  const d = new Date(`${ymd}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function SupplementsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [intakes, setIntakes] = useState<Intake[]>([]);
  const [compounds, setCompounds] = useState<CompoundRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyProductId, setBusyProductId] = useState<string | null>(null);

  // History (older intakes, paginated). Window driven by the global range filter.
  const [history, setHistory] = useState<Intake[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [range, setRange] = useState<Range>("30d");
  const historyDays = rangeDays(range);

  // Edit-intake modal
  const [editing, setEditing] = useState<EditableIntake | null>(null);

  // Center-screen "logged 👍" confirmation toast. Fires on every successful
  // intake write (quick-tap, seed+log, custom-product log). pointer-events-none
  // so it never blocks rapid tapping; the timer resets on each fire so a burst
  // of taps keeps it on screen until ~1.5s after the last one.
  const [toast, setToast] = useState<{ msg: string; id: number } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastSeq = useRef(0);
  const showToast = useCallback((msg = "logged 👍") => {
    toastSeq.current += 1;
    setToast({ msg, id: toastSeq.current });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 1500);
  }, []);
  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  // Date that quick-tap log buttons attribute the intake to. Default seeded
  // with ET-clock-today as a synchronous best-guess, then overridden on
  // mount via /api/behavioral-today which calls pds.behavioral_today_now()
  // — TZ-aware (travel) and awake-tail-aware (-6h rule). User can still
  // manually override via the date picker for retroactive entries.
  const [logDate, setLogDate] = useState<string>(etTodayStr());
  const today = etTodayStr();
  useEffect(() => {
    fetch("/api/behavioral-today")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j?.behavioral_today && j.behavioral_today !== logDate) {
          setLogDate(j.behavioral_today);
        }
      })
      .catch(() => {});
    // Run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const isLoggingForToday = logDate === today;

  // Time the quick-tap log buttons stamp on intake_time. Default is
  // empty = "use the current clock instant at the moment of tap" (the
  // pre-existing behavior). When set, every tap on a product writes
  // that fixed timestamp until cleared. Use this when you forgot to
  // log a supplement earlier — e.g. "I took my caffeine at 9 AM but
  // I'm tapping now at 11 AM." Stored as a datetime-local string
  // (YYYY-MM-DDTHH:MM); converted to ISO at send time.
  const [logTimeLocal, setLogTimeLocal] = useState<string>("");
  const [logTimeOpen, setLogTimeOpen] = useState<boolean>(false);

  // Convert "YYYY-MM-DDTHH:MM" (local clock) → ISO; empty/invalid → null.
  function logTimeIso(): string | null {
    if (!logTimeLocal) return null;
    const d = new Date(logTimeLocal);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  // Add product flow
  const [addOpen, setAddOpen] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchHits, setSearchHits] = useState<DsldHit[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [seedingId, setSeedingId] = useState<string | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  // After picking a hit, hold it here while the user enters a dose count.
  const [confirmHit, setConfirmHit] = useState<DsldHit | null>(null);
  const [confirmDoses, setConfirmDoses] = useState<string>("1");
  // Custom-product fallback (photo → vision extraction → save).
  const [customMode, setCustomMode] = useState(false);

  const loadAll = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!silent) setLoading(true);
    try {
      const [pRes, tRes] = await Promise.all([
        fetch("/api/supplements/products").then((r) => r.json()),
        fetch("/api/supplements/today").then((r) => r.json()),
      ]);
      setProducts(pRes.products ?? []);
      // Preserve any still-pending optimistic intake rows (negative intake_id)
      // so a silent refresh doesn't blow them away mid-POST.
      const serverIntakes: Intake[] = tRes.intakes ?? [];
      setIntakes((prev) => {
        const pending = prev.filter((i) => i.intake_id < 0);
        return pending.length === 0 ? serverIntakes : [...pending, ...serverIntakes];
      });
      setCompounds(tRes.compounds ?? []);
    } catch (e) {
      console.error("Supplements load:", e);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const loadHistory = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!silent) setHistoryLoading(true);
    try {
      const res = await fetch(
        `/api/supplements/history?days=${historyDays}&perPage=100`,
      );
      const json = await res.json();
      const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      // Exclude today's rows (already shown in "Today's intakes" above).
      setHistory((json.rows ?? []).filter((r: Intake) => r.intake_date !== todayStr));
    } catch (e) {
      console.error("Supplements history:", e);
    } finally {
      if (!silent) setHistoryLoading(false);
    }
  }, [historyDays]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // After any mutation (edit, archive, seed) refresh both panes silently
  // so the history section stays in sync without flashing "Loading…".
  const refreshAll = useCallback(async () => {
    await Promise.all([loadAll({ silent: true }), loadHistory({ silent: true })]);
  }, [loadAll, loadHistory]);

  // Debounced silent refresh of /today only — used after rapid log taps so
  // the compounds-rollup table catches up without re-fetching on every click.
  // Optimistic intake rows are kept alive by loadAll's pending-merge logic.
  const todayRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleSilentTodayRefresh = useCallback(() => {
    if (todayRefreshTimer.current) clearTimeout(todayRefreshTimer.current);
    todayRefreshTimer.current = setTimeout(async () => {
      try {
        const tRes = await fetch("/api/supplements/today").then((r) => r.json());
        const serverIntakes: Intake[] = tRes.intakes ?? [];
        setIntakes((prev) => {
          const pending = prev.filter((i) => i.intake_id < 0);
          return pending.length === 0 ? serverIntakes : [...pending, ...serverIntakes];
        });
        setCompounds(tRes.compounds ?? []);
      } catch (e) {
        console.error("Silent today refresh:", e);
      }
    }, 400);
  }, []);
  useEffect(() => () => {
    if (todayRefreshTimer.current) clearTimeout(todayRefreshTimer.current);
  }, []);

  async function logIntake(product_id: string) {
    const product = products.find((p) => p.product_id === product_id);
    if (!product) return;

    // Negative ID marks this row as optimistic / unconfirmed — replaced with
    // the real intake_id once POST resolves, or removed on error.
    const tempId = -(Date.now() + Math.floor(Math.random() * 10000));
    const stampIso = logTimeIso() ?? new Date().toISOString();
    const logDateIsToday = logDate === today;
    const optimistic: Intake = {
      intake_id: tempId,
      intake_date: logDate,
      intake_time: stampIso,
      product_id,
      doses: 1,
      notes: null,
      brand_name: product.brand_name,
      full_name: product.full_name,
    };
    if (logDateIsToday) {
      setIntakes((prev) => [optimistic, ...prev]);
    }
    // Optimistic confirmation — matches the optimistic row above. A failed POST
    // rolls the row back below; the brief toast is an acceptable cost.
    showToast();

    try {
      const res = await fetch("/api/supplements/log-intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          product_id,
          intake_date: logDate,
          intake_time: stampIso,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const saved = (await res.json()) as { intake_id: number };
      if (logDateIsToday) {
        setIntakes((prev) =>
          prev.map((i) => (i.intake_id === tempId ? { ...i, intake_id: saved.intake_id } : i)),
        );
        scheduleSilentTodayRefresh();
      } else {
        // Logged to a past date → row shows up in history, not today.
        void loadHistory({ silent: true });
      }
    } catch (e) {
      // Roll back the optimistic row so the UI matches the server.
      if (logDateIsToday) {
        setIntakes((prev) => prev.filter((i) => i.intake_id !== tempId));
      }
      console.error("Log intake:", e);
    }
  }

  async function undoIntake(intake_id: number) {
    // Optimistic remove — keep refs so we can re-insert on failure.
    const removedToday = intakes.find((i) => i.intake_id === intake_id);
    const removedHistory = history.find((i) => i.intake_id === intake_id);
    setIntakes((prev) => prev.filter((i) => i.intake_id !== intake_id));
    setHistory((prev) => prev.filter((i) => i.intake_id !== intake_id));
    try {
      const res = await fetch(`/api/supplements/log-intake?intake_id=${intake_id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
      scheduleSilentTodayRefresh();
    } catch (e) {
      if (removedToday) setIntakes((prev) => [removedToday, ...prev]);
      if (removedHistory) setHistory((prev) => [removedHistory, ...prev]);
      console.error("Undo intake:", e);
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

  /**
   * Seed a DSLD product into the library, optionally logging one intake event
   * at the same dose count. Both routes already exist; this just chains them
   * so the post-scan UX is "scan → pick → enter dose → done."
   */
  async function seedAndOptionallyLog(dsld_id: number, doses: number | null) {
    setSeedingId(String(dsld_id));
    try {
      const seedRes = await fetch("/api/supplements/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dsld_id }),
      });
      if (!seedRes.ok) throw new Error(await seedRes.text());
      const seeded = (await seedRes.json()) as { product_id: string };
      if (doses !== null && doses > 0) {
        const logRes = await fetch("/api/supplements/log-intake", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            product_id: seeded.product_id,
            doses,
            intake_date: logDate,
            intake_time: logTimeIso() ?? new Date().toISOString(),
          }),
        });
        if (!logRes.ok) throw new Error(await logRes.text());
        showToast();
      }
      await refreshAll();
      setAddOpen(false);
      setSearchQ("");
      setSearchHits([]);
      setConfirmHit(null);
      setConfirmDoses("1");
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : String(e));
    } finally {
      setSeedingId(null);
    }
  }

  async function archiveProduct(product_id: string, full_name: string | null) {
    if (!confirm(`Remove "${full_name ?? product_id}" from the picker?\n\nYour intake history for this product is kept; the product just stops showing up here. Re-add it later via search if you want it back.`)) {
      return;
    }
    setBusyProductId(product_id);
    try {
      await fetch("/api/supplements/products", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product_id, is_active: false }),
      });
      await refreshAll();
    } finally {
      setBusyProductId(null);
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
            DSLD-backed library · ingredient-level intake tracking — {rangeLabel(range)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RangeFilter value={range} onChange={setRange} />
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
            title={isLoggingForToday ? "Log intake today" : `Log intake for ${formatShortDate(logDate)}`}
            subtitle="Tap a product to add one dose. Each click writes a fresh intake event with the current clock timestamp."
            source="DSLD"
          >
            {/* Manual date override — defaults to today; lets the user
                attribute a post-midnight pre-bed intake to the day that
                just ended (behavioral-day convention; see CLAUDE.md). */}
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <label className="text-[10px] uppercase tracking-wide text-text-tertiary font-mono">
                Intake date
              </label>
              <input
                type="date"
                value={logDate}
                max={today}
                onChange={(e) => setLogDate(e.target.value || today)}
                className="px-2 py-1 text-[12px] font-mono bg-black/30 border border-border-subtle rounded-[4px] text-text-primary focus:border-[#1DB954]/40 outline-none"
              />
              {!isLoggingForToday && (
                <>
                  <span className="text-[10px] font-mono text-amber-400/90">
                    logging to {formatShortDate(logDate)} — not today
                  </span>
                  <button
                    onClick={() => setLogDate(today)}
                    className="text-[10px] font-mono text-text-tertiary hover:text-text-primary underline underline-offset-2"
                  >
                    reset to today
                  </button>
                </>
              )}
            </div>

            {/* Manual time override — defaults to "now at tap"; lets the
                user attribute an intake to an earlier clock time when
                they forgot to log right away. Critical for HRV timing
                analysis (e.g. caffeine at 8 AM, logged at 11 AM). */}
            <div className="flex flex-wrap items-center gap-2 mb-3 pb-3 border-b border-border-subtle/40">
              <label className="text-[10px] uppercase tracking-wide text-text-tertiary font-mono">
                Intake time
              </label>
              {!logTimeOpen ? (
                <>
                  <span className="text-[12px] font-mono text-text-secondary">now</span>
                  <button
                    onClick={() => {
                      // Pre-fill picker with current local clock so the
                      // user just nudges backwards instead of typing.
                      const now = new Date();
                      const pad = (n: number) => String(n).padStart(2, "0");
                      const local = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
                      setLogTimeLocal(local);
                      setLogTimeOpen(true);
                    }}
                    className="text-[10px] font-mono text-text-tertiary hover:text-text-primary underline underline-offset-2"
                  >
                    change time
                  </button>
                </>
              ) : (
                <>
                  <input
                    type="datetime-local"
                    value={logTimeLocal}
                    onChange={(e) => setLogTimeLocal(e.target.value)}
                    className="px-2 py-1 text-[12px] font-mono bg-black/30 border border-border-subtle rounded-[4px] text-text-primary focus:border-[#1DB954]/40 outline-none"
                  />
                  <span className="text-[10px] font-mono text-amber-400/90">
                    stamping at custom clock time
                  </span>
                  <button
                    onClick={() => {
                      setLogTimeOpen(false);
                      setLogTimeLocal("");
                    }}
                    className="text-[10px] font-mono text-text-tertiary hover:text-text-primary underline underline-offset-2"
                  >
                    reset to now
                  </button>
                </>
              )}
            </div>

            {products.length === 0 ? (
              <p className="text-[11px] text-text-tertiary font-mono py-6 text-center">
                Library is empty. Add a product to get started.
              </p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {products.map((p) => (
                  <div
                    key={p.product_id}
                    className="flex items-center gap-2 bg-black/30 hover:bg-white/[0.03] border border-border-subtle hover:border-border-hover rounded-[4px] transition-colors"
                  >
                    <button
                      onClick={() => logIntake(p.product_id)}
                      className="flex-1 flex items-center justify-between gap-3 px-3 py-2 text-left active:bg-white/[0.06] transition-colors"
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
                    <button
                      onClick={() => archiveProduct(p.product_id, p.full_name)}
                      disabled={busyProductId === p.product_id}
                      className="px-2 py-2 text-[14px] text-text-tertiary/60 hover:text-red-400 disabled:opacity-40 transition-colors"
                      title="Remove from picker (history is kept)"
                      aria-label="Remove product"
                    >
                      ✕
                    </button>
                  </div>
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
                        onClick={() => setEditing({
                          intake_id: i.intake_id,
                          intake_date: i.intake_date,
                          intake_time: i.intake_time,
                          doses: Number(i.doses),
                          notes: i.notes,
                          brand_name: i.brand_name,
                          full_name: i.full_name,
                        })}
                        className="text-[10px] text-text-tertiary hover:text-text-primary transition-colors"
                      >
                        edit
                      </button>
                      <button
                        onClick={() => undoIntake(i.intake_id)}
                        className="text-[10px] text-text-tertiary hover:text-red-400 transition-colors"
                      >
                        delete
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

          {/* Recent intakes (prior days) — edit/delete any row */}
          <ChartCard
            title="Recent intakes"
            subtitle={`prior days · ${rangeLabel(range)} · ${history.length} entries`}
            source="DSLD"
            info="Every intake before today, newest first. Tap edit on any row to change doses, time, date, or notes. Tap delete to remove an entry entirely. Edits propagate to the daily_supplement_matrix view automatically."
          >
            {historyLoading && history.length === 0 ? (
              <p className="text-[11px] text-text-tertiary font-mono py-4 text-center">Loading…</p>
            ) : history.length === 0 ? (
              <p className="text-[11px] text-text-tertiary font-mono py-4 text-center">
                No prior intakes in this window.
              </p>
            ) : (
              <div className="space-y-1">
                {history.map((i) => (
                  <div
                    key={i.intake_id}
                    className="flex items-center justify-between gap-3 py-1.5 border-b border-border-subtle/40 last:border-b-0 text-[12px] font-mono"
                  >
                    <div className="flex items-baseline gap-2 min-w-0">
                      <span className="text-text-tertiary tabular-nums shrink-0 w-[90px]">
                        {i.intake_date.slice(5)} {formatDoseTime(i.intake_time)}
                      </span>
                      <span className="text-text-primary truncate">{i.full_name ?? "—"}</span>
                      <span className="text-text-tertiary truncate">· {i.brand_name ?? "—"}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-text-secondary tabular-nums">
                        {i.doses}× dose
                      </span>
                      <button
                        onClick={() => setEditing({
                          intake_id: i.intake_id,
                          intake_date: i.intake_date,
                          intake_time: i.intake_time,
                          doses: Number(i.doses),
                          notes: i.notes,
                          brand_name: i.brand_name,
                          full_name: i.full_name,
                        })}
                        className="text-[10px] text-text-tertiary hover:text-text-primary transition-colors"
                      >
                        edit
                      </button>
                      <button
                        onClick={() => undoIntake(i.intake_id)}
                        className="text-[10px] text-text-tertiary hover:text-red-400 transition-colors"
                      >
                        delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </ChartCard>
        </>
      )}

      {/* Edit-intake modal */}
      <EditIntakeModal
        intake={editing}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          await refreshAll();
        }}
      />

      {/* Add Product modal */}
      {addOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto"
          onClick={() => {
            setAddOpen(false);
            setConfirmHit(null);
            setConfirmDoses("1");
            setCustomMode(false);
          }}
        >
          <div
            className="bg-surface-card border border-border-subtle rounded-[6px] shadow-card p-5 w-full max-w-lg mt-12"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[14px] font-medium text-text-primary">Add a product to your library</h2>
              <button
                onClick={() => {
                  setAddOpen(false);
                  setConfirmHit(null);
                  setConfirmDoses("1");
                  setCustomMode(false);
                }}
                className="text-[11px] text-text-tertiary hover:text-text-secondary font-mono"
              >
                Close
              </button>
            </div>

            {customMode ? (
              <CustomSupplementFlow
                logDate={logDate}
                onBack={() => setCustomMode(false)}
                onLogged={() => showToast()}
                onSaved={async () => {
                  await refreshAll();
                  setAddOpen(false);
                  setCustomMode(false);
                  setSearchQ("");
                  setSearchHits([]);
                }}
              />
            ) : (
              <>

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

            {!confirmHit && (
              <div className="mb-3 pb-3 border-b border-border-subtle/40">
                <button
                  onClick={() => setCustomMode(true)}
                  className="w-full px-3 py-2 text-[11px] font-mono text-text-secondary hover:text-text-primary bg-black/20 hover:bg-white/[0.04] border border-dashed border-border-subtle hover:border-border-hover rounded-[4px] transition-colors text-left"
                >
                  <span className="text-amber-400/80">Not in DSLD?</span>{" "}
                  <span className="text-text-tertiary">Photograph the supplement facts panel — Claude will read it.</span>{" "}
                  <span className="text-text-primary">Add custom →</span>
                </button>
              </div>
            )}

            {!confirmHit && (
              <div className="space-y-1.5 max-h-[50vh] overflow-y-auto">
                {searchHits.map((h) => (
                  <button
                    key={h.id}
                    onClick={() => {
                      setConfirmHit(h);
                      setConfirmDoses("1");
                    }}
                    className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left bg-black/30 hover:bg-white/[0.04] border border-border-subtle hover:border-border-hover rounded-[4px] transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="text-[12px] text-text-primary truncate">{h.full_name ?? "—"}</p>
                      <p className="text-[10px] text-text-tertiary font-mono truncate">
                        {h.brand_name ?? "—"}
                        {h.upc_sku ? ` · UPC ${h.upc_sku}` : ""}
                        {h.physical_state ? ` · ${h.physical_state}` : ""}
                      </p>
                    </div>
                    <span className="text-[10px] text-text-tertiary font-mono shrink-0">pick →</span>
                  </button>
                ))}
                {!searching && searchHits.length === 0 && searchQ && !searchError && (
                  <p className="text-[11px] text-text-tertiary font-mono py-3 text-center">
                    No matches. Try a different brand or product name.
                  </p>
                )}
              </div>
            )}

            {confirmHit && (
              <div className="bg-black/40 border border-[#1DB954]/30 rounded-[4px] p-4">
                <p className="text-[10px] uppercase tracking-wide text-text-tertiary font-mono mb-2">
                  Confirm + log
                </p>
                <p className="text-[13px] text-text-primary mb-0.5">{confirmHit.full_name ?? "—"}</p>
                <p className="text-[11px] text-text-tertiary font-mono mb-4">
                  {confirmHit.brand_name ?? "—"}
                  {confirmHit.upc_sku ? ` · UPC ${confirmHit.upc_sku}` : ""}
                  {confirmHit.physical_state ? ` · ${confirmHit.physical_state}` : ""}
                </p>

                <label className="block text-[10px] font-mono uppercase tracking-wide text-text-tertiary mb-1">
                  How many doses did you take?
                </label>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.5"
                  value={confirmDoses}
                  onChange={(e) => setConfirmDoses(e.target.value)}
                  className="w-full mb-3 px-3 py-2 text-[14px] bg-black/40 border border-border-subtle rounded-[4px] text-text-primary focus:border-[#1DB954]/50 outline-none"
                  autoFocus
                />
                <p className="text-[10px] text-text-tertiary mb-3 leading-relaxed">
                  One dose = one serving as the label defines it (typically 1 tablet/capsule).
                  Set to <span className="text-text-secondary">0</span> to add the product to your library without logging an intake right now.
                </p>

                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => {
                      setConfirmHit(null);
                      setConfirmDoses("1");
                    }}
                    disabled={seedingId !== null}
                    className="px-3 py-2 text-[12px] text-text-secondary hover:text-text-primary disabled:opacity-40 transition-colors"
                  >
                    Back
                  </button>
                  <button
                    onClick={() => {
                      const doses = Number(confirmDoses);
                      if (!Number.isFinite(doses) || doses < 0) return;
                      seedAndOptionallyLog(Number(confirmHit.id), doses > 0 ? doses : null);
                    }}
                    disabled={seedingId !== null}
                    className="px-4 py-2 text-[12px] font-medium text-text-primary bg-[#1DB954]/20 hover:bg-[#1DB954]/30 disabled:opacity-40 disabled:cursor-not-allowed border border-[#1DB954]/40 rounded-[4px] transition-colors"
                  >
                    {seedingId !== null
                      ? "Saving…"
                      : Number(confirmDoses) > 0
                      ? `Add + log ${confirmDoses} dose${Number(confirmDoses) === 1 ? "" : "s"}`
                      : "Add to library only"}
                  </button>
                </div>
              </div>
            )}
              </>
            )}
          </div>
        </div>
      )}

      <BarcodeScannerModal
        open={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onDetected={handleBarcodeDetected}
      />

      {/* Center-screen "logged" confirmation. z above the add-product modal (z-50)
          so seed+log / custom-product logs flash over it; pointer-events-none so
          it never intercepts taps. Keyed by id to re-run the fade on every fire. */}
      {toast && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center pointer-events-none">
          <div
            key={toast.id}
            className="animate-fade-in flex items-center gap-2 px-6 py-4 rounded-[10px] bg-surface-raised/95 border border-[#1DB954]/40 shadow-floating backdrop-blur-sm"
          >
            <span className="text-[15px] font-medium text-text-primary tracking-tight">
              {toast.msg}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
