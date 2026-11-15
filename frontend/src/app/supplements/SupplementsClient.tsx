"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import StatCard from "@/components/StatCard";
import ChartCard from "@/components/ChartCard";
import RangeFilter from "@/components/RangeFilter";
// @zxing/browser is ~120 kB of route JS but only needed once the user taps
// "Scan barcode" — load it lazily on first open instead of on page load.
const BarcodeScannerModal = dynamic(() => import("@/components/BarcodeScannerModal"), { ssr: false });
import EditIntakeModal, { type EditableIntake } from "@/components/EditIntakeModal";
import StackEditorModal, { type EditableStack } from "@/components/StackEditorModal";
import CustomSupplementFlow from "@/components/CustomSupplementFlow";
import { rangeDays, rangeLabel, type Range } from "@/lib/queries";
import { Check, X } from "lucide-react";
import {
  batchUndoResult, claimedIds, findSavedCopy, newWrite, receiptText, updateWrite,
  type SupplementWrite,
} from "@/lib/supplement-writes";

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

interface StackItem {
  product_id: string;
  doses: number;
  full_name: string | null;
  brand_name: string | null;
  serving_size: number | null;
  serving_unit: string | null;
  ingredient_count: number;
  product_active: boolean;
}

interface Stack {
  stack_id: number;
  name: string;
  description: string | null;
  remind_time: string | null;
  items: StackItem[];
  item_count: number;
  total_doses: number;
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

/** GET JSON; a non-OK answer throws, so a failed read never replaces a list with "nothing". */
async function getJson(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

export default function SupplementsPage({ headingTestId = "page-heading" }: { headingTestId?: string } = {}) {
  // headingTestId: "feed-page-heading" when shown inside the continuous scroll (components/ContinuousScroll.tsx).
  const [products, setProducts] = useState<Product[]>([]);
  const [intakes, setIntakes] = useState<Intake[]>([]);
  const [compounds, setCompounds] = useState<CompoundRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyProductId, setBusyProductId] = useState<string | null>(null);

  // Supplement stacks (BOM-style recurring lists). Editor holds the stack being
  // created/edited; null = closed.
  const [stacks, setStacks] = useState<Stack[]>([]);
  const [busyStackId, setBusyStackId] = useState<number | null>(null);
  const [editingStack, setEditingStack] = useState<EditableStack | null>(null);
  // Most-recent stack-log batch, for one-click "undo all". `ids` = the intakes not yet confirmed deleted.
  const [lastBatch, setLastBatch] = useState<{ name: string; ids: number[]; status: "ready" | "undoing" | "failed" } | null>(null);
  // Every write this page started (lib/supplement-writes.ts): saving rows show in Today's intakes, failed ones
  // stay in the Not saved bar with Retry. Saved ones are kept (capped) so a Retry never adopts their rows.
  const [writes, setWrites] = useState<SupplementWrite[]>([]);
  const writesRef = useRef<SupplementWrite[]>([]);
  writesRef.current = writes;
  const writeSeq = useRef(0);
  // Single-row deletes the server refused: the row is back on the list, listed here with Retry.
  const [failedDeletes, setFailedDeletes] = useState<{ intake_id: number; label: string }[]>([]);
  // The behavioral day /api/supplements/today answered for (its rows are "Today's intakes").
  const [listDate, setListDate] = useState<string | null>(null);

  // History (older intakes, paginated). Window driven by the global range filter.
  const [history, setHistory] = useState<Intake[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [range, setRange] = useState<Range>("30d");
  const historyDays = rangeDays(range);

  // Edit-intake modal
  const [editing, setEditing] = useState<EditableIntake | null>(null);

  // Center-screen receipt toast. "Saved" only after the server answered OK (quick-tap, stack, seed+log,
  // custom-product log); "Not saved" when it did not (the failure also stays in the Not saved bar below with
  // Retry). pointer-events-none so it never blocks rapid tapping; the timer resets on each fire so a burst of
  // taps keeps it on screen until shortly after the last answer.
  const [toast, setToast] = useState<{ msg: string; ok: boolean; id: number } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastSeq = useRef(0);
  const showToast = useCallback((msg = "Saved", ok = true) => {
    toastSeq.current += 1;
    setToast({ msg, ok, id: toastSeq.current });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), ok ? 1500 : 2500);
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
      const [pRes, tRes] = await Promise.all([getJson("/api/supplements/products"), getJson("/api/supplements/today")]);
      setProducts(pRes.products ?? []);
      // Only server-confirmed rows live in `intakes`; rows still saving are drawn from `writes`.
      setIntakes(tRes.intakes ?? []);
      setCompounds(tRes.compounds ?? []);
      if (typeof tRes.date === "string") setListDate(tRes.date);
    } catch (e) {
      // A failed read keeps what is on screen (never an empty "nothing logged").
      console.error("Supplements load:", e);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const loadHistory = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!silent) setHistoryLoading(true);
    try {
      const json = await getJson(`/api/supplements/history?days=${historyDays}&perPage=100`);
      const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      // Exclude today's rows (already shown in "Today's intakes" above).
      setHistory((json.rows ?? []).filter((r: Intake) => r.intake_date !== todayStr));
    } catch (e) {
      console.error("Supplements history:", e);
    } finally {
      if (!silent) setHistoryLoading(false);
    }
  }, [historyDays]);

  const loadStacks = useCallback(async () => {
    try {
      const json = await getJson("/api/supplements/stacks");
      setStacks(json.stacks ?? []);
    } catch (e) {
      console.error("Stacks load:", e);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    loadStacks();
  }, [loadStacks]);

  // After any mutation (edit, archive, seed, stack change) refresh all panes
  // silently so the page stays in sync without flashing "Loading…".
  const refreshAll = useCallback(async () => {
    await Promise.all([loadAll({ silent: true }), loadHistory({ silent: true }), loadStacks()]);
  }, [loadAll, loadHistory, loadStacks]);

  // Debounced silent refresh of /today only — used after rapid log taps so
  // the compounds-rollup table catches up without re-fetching on every click.
  const todayRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleSilentTodayRefresh = useCallback(() => {
    if (todayRefreshTimer.current) clearTimeout(todayRefreshTimer.current);
    todayRefreshTimer.current = setTimeout(async () => {
      try {
        const tRes = await getJson("/api/supplements/today");
        setIntakes(tRes.intakes ?? []);
        setCompounds(tRes.compounds ?? []);
        if (typeof tRes.date === "string") setListDate(tRes.date);
      } catch (e) {
        console.error("Silent today refresh:", e);
      }
    }, 400);
  }, []);
  useEffect(() => () => {
    if (todayRefreshTimer.current) clearTimeout(todayRefreshTimer.current);
  }, []);

  // The day "Today's intakes" shows (behavioral today from the server; the ET date until it answered).
  const todayList = listDate ?? today;
  const visibleIds = () => [...intakes, ...history].map((i) => i.intake_id);

  // Send one write and record what the server said. Only an OK answer is "Saved".
  async function sendWrite(w: SupplementWrite) {
    const url = w.kind === "intake" ? "/api/supplements/log-intake" : "/api/supplements/stacks/log";
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(w.body) });
    } catch {
      failWrite(w, "no answer from Onyx");
      return;
    }
    if (!res.ok) {
      failWrite(w, `refused (${res.status})`);
      return;
    }
    const saved = (await res.json().catch(() => ({}))) as { intake_id?: number; intake_ids?: number[] };
    const ids = w.kind === "intake" ? (typeof saved.intake_id === "number" ? [saved.intake_id] : []) : (saved.intake_ids ?? []);
    savedWrite(w, ids);
  }

  function failWrite(w: SupplementWrite, error: string) {
    setWrites((l) => updateWrite(l, w.id, { status: "failed", error }));
    showToast(`Not saved: ${w.label}`, false);
  }

  function savedWrite(w: SupplementWrite, ids: number[]) {
    setWrites((l) => updateWrite(l, w.id, { status: "saved", savedIds: ids, error: null }));
    showToast(w.kind === "stack" ? `Saved ${w.label}` : "Saved");
    if (w.kind === "stack") setLastBatch({ name: w.label, ids, status: "ready" });
    if (w.kind === "intake" && w.date === todayList && ids.length === 1 && w.productId) {
      // Show the confirmed row at once; the debounced refresh brings the compound totals.
      const product = products.find((p) => p.product_id === w.productId);
      const row: Intake = {
        intake_id: ids[0], intake_date: w.date, intake_time: w.time, product_id: w.productId,
        doses: Number(w.body.doses ?? 1), notes: null,
        brand_name: product?.brand_name ?? null, full_name: product?.full_name ?? w.label,
      };
      setIntakes((prev) => (prev.some((i) => i.intake_id === row.intake_id) ? prev : [row, ...prev]));
    }
    if (w.date === todayList) scheduleSilentTodayRefresh();
    else void loadHistory({ silent: true });
  }

  // Retry a failed write. Its answer may simply have been lost, so look for its row first (findSavedCopy).
  async function retryWrite(w: SupplementWrite) {
    setWrites((l) => updateWrite(l, w.id, { status: "saving", error: null }));
    if (w.time && w.date === todayList) {
      try {
        const tRes = await getJson("/api/supplements/today");
        const rows: Intake[] = tRes.intakes ?? [];
        const copy = findSavedCopy(w, rows, claimedIds(writesRef.current, w.id));
        if (copy.length > 0) {
          setIntakes(rows);
          setCompounds(tRes.compounds ?? []);
          savedWrite(w, copy);
          return;
        }
      } catch {
        // Could not look: send it again (the read failing usually means the write would fail too).
      }
    }
    await sendWrite(w);
  }

  function dismissWrite(id: string) {
    setWrites((l) => l.filter((w) => w.id !== id));
  }

  function startWrite(args: Parameters<typeof newWrite>[0]): SupplementWrite {
    const w = newWrite(args);
    // Saved writes are kept so a later Retry never adopts their rows; cap the list.
    setWrites((l) => [w, ...l].slice(0, 60));
    return w;
  }

  async function logIntake(product_id: string) {
    const product = products.find((p) => p.product_id === product_id);
    if (!product) return;

    const logDateIsToday = logDate === today;
    // Backdated logs get NO timestamp unless the user set one explicitly:
    // stamping "now" on a past intake_date produced retro-log artifacts the
    // caffeine timing layer had to quarantine (timestamp attributing to a
    // different behavioral day than claimed). NULL = "took it that day, time
    // unspecified" — mg totals still count, timing aggregates stay clean.
    const stampIso = logTimeIso() ?? (logDateIsToday ? new Date().toISOString() : null);
    // The row shows as "Saving…" in Today's intakes until the server answers; no "Saved" before that.
    const w = startWrite({
      id: `w${++writeSeq.current}`,
      kind: "intake",
      label: product.full_name ?? product_id,
      date: logDate,
      time: stampIso,
      productId: product_id,
      body: { product_id, intake_date: logDate, intake_time: stampIso },
      knownIds: visibleIds(),
    });
    await sendWrite(w);
  }

  async function undoIntake(intake_id: number) {
    // Optimistic remove — keep refs so we can re-insert on failure.
    const removedToday = intakes.find((i) => i.intake_id === intake_id);
    const removedHistory = history.find((i) => i.intake_id === intake_id);
    const label = (removedToday ?? removedHistory)?.full_name ?? "intake";
    setFailedDeletes((l) => l.filter((d) => d.intake_id !== intake_id));
    setIntakes((prev) => prev.filter((i) => i.intake_id !== intake_id));
    setHistory((prev) => prev.filter((i) => i.intake_id !== intake_id));
    try {
      const res = await fetch(`/api/supplements/log-intake?intake_id=${intake_id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`refused (${res.status})`);
      scheduleSilentTodayRefresh();
    } catch (e) {
      // The row comes back, and the failure stays listed with Retry.
      if (removedToday) setIntakes((prev) => (prev.some((i) => i.intake_id === intake_id) ? prev : [removedToday, ...prev]));
      if (removedHistory) setHistory((prev) => (prev.some((i) => i.intake_id === intake_id) ? prev : [removedHistory, ...prev]));
      setFailedDeletes((l) => [...l.filter((d) => d.intake_id !== intake_id), { intake_id, label }]);
      showToast(`Not deleted: ${label}`, false);
      console.error("Undo intake:", e);
    }
  }

  // Log an entire stack — writes one intake per item server-side, honoring the
  // page's logDate / logTime overrides (so a pre-bed stack can attribute to
  // yesterday). Records the batch for one-click undo once the server confirmed it.
  async function logStack(stack: Stack) {
    setBusyStackId(stack.stack_id);
    // Same backdate rule as addIntake: no explicit time + past date → null
    // timestamp (the server passes null through; it no longer coerces to now).
    const stampIso = logTimeIso() ?? (isLoggingForToday ? new Date().toISOString() : null);
    const w = startWrite({
      id: `w${++writeSeq.current}`,
      kind: "stack",
      label: stack.name,
      date: logDate,
      time: stampIso,
      stackName: stack.name,
      body: { stack_id: stack.stack_id, intake_date: logDate, intake_time: stampIso },
      knownIds: visibleIds(),
    });
    try {
      await sendWrite(w);
    } finally {
      setBusyStackId(null);
    }
  }

  // Undo the most-recent stack-log batch by deleting every intake it wrote. The bar stays until every delete
  // is confirmed; whatever the server did not confirm stays listed for another try.
  async function undoLastBatch() {
    if (!lastBatch || lastBatch.status === "undoing") return;
    const { name, ids } = lastBatch;
    setLastBatch({ name, ids, status: "undoing" });
    const ok = await Promise.all(
      ids.map((id) =>
        fetch(`/api/supplements/log-intake?intake_id=${id}`, { method: "DELETE" }).then((r) => r.ok, () => false),
      ),
    );
    const { failed } = batchUndoResult(ids, ok);
    if (failed.length === 0) {
      setLastBatch(null);
      showToast(`Removed ${name}`);
    } else {
      setLastBatch({ name, ids: failed, status: "failed" });
      showToast(`Not removed: ${failed.length} of ${ids.length}`, false);
    }
    await Promise.all([loadAll({ silent: true }), loadHistory({ silent: true })]);
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
            // Same backdate rule as addIntake/logStack: past date + no
            // explicit time → null timestamp, never a misleading "now".
            intake_time: logTimeIso() ?? (logDate === today ? new Date().toISOString() : null),
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
  const savingToday = writes.filter((w) => w.kind === "intake" && w.status === "saving" && w.date === todayList);
  const failedWrites = writes.filter((w) => w.status === "failed");

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 data-testid={headingTestId} className="text-[20px] font-medium text-text-primary tracking-tight">Supplements</h1>
          <p className="text-[12px] text-text-tertiary mt-0.5">
            DSLD-backed library · ingredient-level intake tracking — {rangeLabel(range)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RangeFilter value={range} onChange={setRange} />
          <button
            onClick={() => setScannerOpen(true)}
            className="px-3 py-1.5 text-[11px] font-mono tracking-wide text-on-accent font-semibold bg-accent hover:bg-accent/90 border border-accent rounded-full transition-colors"
          >
            Scan barcode
          </button>
          <button
            onClick={() => setAddOpen(true)}
            className="px-3 py-1.5 text-[11px] font-mono tracking-wide text-text-primary bg-black/30 hover:bg-white/5 border border-border-subtle rounded-control transition-colors"
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
          {/* Stacks — recurring supplement lists (BOM). One tap logs the whole list. */}
          <ChartCard
            title="Stacks"
            subtitle="Reusable supplement lists — tap Log to record every product in the list at once."
            source="Onyx"
            info="A stack is a saved list of products + per-product doses, like a bill of materials. Logging a stack writes one ordinary intake event per product (with the stack's doses), attributed to the date/time selected below. Editing a stack never changes anything you've already logged."
          >
            <div className="flex items-center justify-end mb-2">
              <button
                onClick={() =>
                  setEditingStack({ stack_id: null, name: "", description: null, remind_time: null, items: [] })
                }
                className="px-3 py-1.5 text-[11px] font-mono tracking-wide text-on-accent font-semibold bg-accent hover:bg-accent/90 border border-accent rounded-full transition-colors"
              >
                + New stack
              </button>
            </div>

            {lastBatch && (
              <div
                role="status"
                className={`flex items-center justify-between gap-2 mb-2 px-3 py-1.5 border rounded-control text-[11px] font-mono ${
                  lastBatch.status === "failed" ? "bg-down/10 border-down/30" : "bg-surface-raised border-border-subtle"
                }`}
              >
                <span className="truncate">
                  {lastBatch.status === "undoing" ? (
                    <span className="text-text-secondary">Removing {lastBatch.name}…</span>
                  ) : lastBatch.status === "failed" ? (
                    <span className="text-down">
                      Not removed: {lastBatch.ids.length} intake{lastBatch.ids.length === 1 ? "" : "s"} from {lastBatch.name}
                    </span>
                  ) : (
                    <span className="text-text-secondary inline-flex items-center gap-1.5">
                      <Check aria-hidden="true" className="w-3.5 h-3.5 text-up" />
                      <span className="text-up">Saved</span> {lastBatch.name} · {lastBatch.ids.length} products
                    </span>
                  )}
                </span>
                <button
                  onClick={undoLastBatch}
                  disabled={lastBatch.status === "undoing"}
                  className="min-h-11 px-2 text-text-tertiary hover:text-text-primary underline underline-offset-2 shrink-0 disabled:opacity-50"
                >
                  {lastBatch.status === "failed" ? "retry undo" : "undo all"}
                </button>
              </div>
            )}

            {stacks.length === 0 ? (
              <p className="text-[11px] text-text-tertiary font-mono py-6 text-center">
                No stacks yet. Create one to log your recurring supplements in a single tap.
              </p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {stacks.map((s) => (
                  <div
                    key={s.stack_id}
                    className="flex items-center gap-2 bg-black/30 border border-border-subtle rounded-control"
                  >
                    <button
                      onClick={() => logStack(s)}
                      disabled={busyStackId === s.stack_id || s.item_count === 0}
                      className="flex-1 flex items-center justify-between gap-3 px-3 py-2 text-left hover:bg-white/[0.03] active:bg-white/[0.06] disabled:opacity-50 rounded-l-control transition-colors"
                    >
                      <div className="min-w-0">
                        <p className="text-[12px] text-text-primary truncate">{s.name}</p>
                        <p className="text-[10px] text-text-tertiary font-mono truncate">
                          {s.item_count} product{s.item_count === 1 ? "" : "s"} · {s.total_doses} dose
                          {s.total_doses === 1 ? "" : "s"}
                          {s.description ? ` · ${s.description}` : ""}
                          {s.remind_time ? ` · remind ${s.remind_time}` : ""}
                        </p>
                      </div>
                      <span className="text-[11px] text-accent/90 font-mono shrink-0">
                        {busyStackId === s.stack_id ? "…" : "Log"}
                      </span>
                    </button>
                    <button
                      onClick={() =>
                        setEditingStack({
                          stack_id: s.stack_id,
                          name: s.name,
                          description: s.description,
                          remind_time: s.remind_time,
                          items: s.items.map((i) => ({
                            product_id: i.product_id,
                            doses: Number(i.doses),
                            full_name: i.full_name,
                            brand_name: i.brand_name,
                          })),
                        })
                      }
                      className="px-2 py-2 text-[10px] font-mono text-text-tertiary hover:text-text-primary transition-colors"
                      title="Edit stack"
                    >
                      edit
                    </button>
                  </div>
                ))}
              </div>
            )}
          </ChartCard>

          {/* Log intake — product picker */}
          <ChartCard
            title={isLoggingForToday ? "Log intake today" : `Log intake for ${formatShortDate(logDate)}`}
            subtitle="Tap a product to add one dose. Each click writes a fresh intake event with the current clock timestamp."
            source="DSLD"
          >
            {/* Manual date override — defaults to today; lets the user
                attribute a post-midnight pre-bed intake to the day that
                just ended (behavioral-day convention; see AGENTS.md). */}
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <label className="text-[10px] uppercase tracking-wide text-text-tertiary font-mono">
                Intake date
              </label>
              <input
                type="date"
                value={logDate}
                max={today}
                onChange={(e) => setLogDate(e.target.value || today)}
                className="px-2 py-1 text-[12px] font-mono bg-black/30 border border-border-subtle rounded-control text-text-primary focus:border-accent/40 outline-none"
              />
              {!isLoggingForToday && (
                <>
                  <span className="text-[10px] font-mono text-amber-400/90">
                    logging to {formatShortDate(logDate)} — not today
                    {!logTimeLocal && " · no clock time will be stored (set one below if you know it)"}
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
                    className="px-2 py-1 text-[12px] font-mono bg-black/30 border border-border-subtle rounded-control text-text-primary focus:border-accent/40 outline-none"
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
                    className="flex items-center gap-2 bg-black/30 hover:bg-white/[0.03] border border-border-subtle hover:border-border-hover rounded-control transition-colors"
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
                      <span className="text-[16px] text-accent/80 font-mono shrink-0">+</span>
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

          {/* Today's intakes: rows still saving first (no edit/delete until the server has them), then saved rows */}
          {(intakes.length > 0 || savingToday.length > 0) && (
            <ChartCard
              title="Today's intakes"
              subtitle={`${intakes.length} saved${savingToday.length ? ` · ${savingToday.length} saving` : ""} · newest first`}
              source="DSLD"
            >
              <div className="space-y-1.5">
                {savingToday.map((w) => (
                  <div
                    key={w.id}
                    className="flex items-center justify-between gap-3 py-1.5 border-b border-border-subtle/40 last:border-b-0 text-[12px] font-mono"
                  >
                    <div className="flex items-baseline gap-2 min-w-0">
                      <span className="text-text-tertiary tabular-nums shrink-0 w-[68px]">{formatDoseTime(w.time)}</span>
                      <span className="text-text-secondary truncate">{w.label}</span>
                    </div>
                    <span className="text-[10px] text-text-tertiary shrink-0">Saving…</span>
                  </div>
                ))}
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

      {/* Stack editor (create / edit) */}
      <StackEditorModal
        open={editingStack !== null}
        stack={editingStack}
        products={products}
        onClose={() => setEditingStack(null)}
        onSaved={async () => {
          setEditingStack(null);
          await loadStacks();
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
            className="bg-surface-card border border-border-subtle rounded-card shadow-card p-5 w-full max-w-lg mt-12"
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
                className="flex-1 px-3 py-2 text-[13px] bg-black/30 border border-border-subtle rounded-control text-text-primary focus:border-accent/40 outline-none"
              />
              <button
                onClick={() => runSearch(searchQ)}
                disabled={searching || !searchQ.trim()}
                className="px-3 py-2 text-[11px] font-mono text-on-accent font-semibold bg-accent hover:bg-accent/90 disabled:opacity-40 border border-accent rounded-full transition-colors"
              >
                {searching ? "…" : "Search"}
              </button>
              <button
                onClick={() => {
                  setAddOpen(false);
                  setScannerOpen(true);
                }}
                className="px-3 py-2 text-[11px] font-mono text-text-secondary hover:text-text-primary bg-black/30 hover:bg-white/[0.05] border border-border-subtle rounded-control transition-colors"
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
                  className="w-full px-3 py-2 text-[11px] font-mono text-text-secondary hover:text-text-primary bg-black/20 hover:bg-white/[0.04] border border-dashed border-border-subtle hover:border-border-hover rounded-control transition-colors text-left"
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
                    className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left bg-black/30 hover:bg-white/[0.04] border border-border-subtle hover:border-border-hover rounded-control transition-colors"
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
              <div className="bg-black/40 border border-accent/30 rounded-control p-4">
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
                  className="w-full mb-3 px-3 py-2 text-[14px] bg-black/40 border border-border-subtle rounded-control text-text-primary focus:border-accent/50 outline-none"
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
                    className="px-4 py-2 text-[12px] text-on-accent font-semibold bg-accent hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed border border-accent rounded-full transition-colors"
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

      {/* Conditional render so the @zxing chunk is only fetched when the
          scanner is actually opened (the component self-handles open=true
          on mount). */}
      {scannerOpen && (
        <BarcodeScannerModal
          open={scannerOpen}
          onClose={() => setScannerOpen(false)}
          onDetected={handleBarcodeDetected}
        />
      )}

      {/* Writes the server did not confirm. Fixed above the mobile tab bar so a failure is seen wherever the
          tap was made; each one keeps its request for Retry (which first checks it wasn't saved after all). */}
      {(failedWrites.length > 0 || failedDeletes.length > 0) && (
        <div
          role="region"
          aria-label="Not saved"
          className="fixed left-1/2 z-40 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 rounded-card border border-down/30 bg-surface-raised shadow-elevated px-3 py-2 bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] md:bottom-6"
        >
          <ul className="divide-y divide-border-subtle">
            {failedWrites.slice(0, 4).map((w) => (
              <li key={w.id} className="flex items-center gap-2 py-1">
                <span className="min-w-0 flex-1 text-[12px]">
                  <span className="block truncate text-down">{receiptText(w, todayList, formatShortDate)}</span>
                  {w.error && <span className="block truncate text-[11px] text-text-tertiary">{w.error}</span>}
                </span>
                <button onClick={() => void retryWrite(w)} className="min-h-11 px-3 text-[13px] font-medium text-accent shrink-0">
                  Retry
                </button>
                <button onClick={() => dismissWrite(w.id)} aria-label={`Dismiss: ${w.label}`} className="min-h-11 min-w-11 inline-flex items-center justify-center text-text-tertiary hover:text-text-primary shrink-0">
                  <X aria-hidden="true" className="w-4 h-4" />
                </button>
              </li>
            ))}
            {failedDeletes.slice(0, 3).map((d) => (
              <li key={`del${d.intake_id}`} className="flex items-center gap-2 py-1">
                <span className="min-w-0 flex-1 truncate text-[12px] text-down">Not deleted: {d.label} (still logged)</span>
                <button onClick={() => void undoIntake(d.intake_id)} className="min-h-11 px-3 text-[13px] font-medium text-accent shrink-0">
                  Retry
                </button>
                <button
                  onClick={() => setFailedDeletes((l) => l.filter((x) => x.intake_id !== d.intake_id))}
                  aria-label={`Dismiss: ${d.label}`}
                  className="min-h-11 min-w-11 inline-flex items-center justify-center text-text-tertiary hover:text-text-primary shrink-0"
                >
                  <X aria-hidden="true" className="w-4 h-4" />
                </button>
              </li>
            ))}
          </ul>
          {failedWrites.length > 4 && <p className="text-[11px] text-text-tertiary pb-1">And {failedWrites.length - 4} more not saved.</p>}
        </div>
      )}

      {/* Center-screen receipt: "Saved" only after the server answered OK, "Not saved" otherwise. z above the
          add-product modal (z-50) so seed+log / custom-product logs flash over it; pointer-events-none so
          it never intercepts taps. Keyed by id to re-run the fade on every fire. */}
      {toast && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center pointer-events-none" role="status" aria-live="polite">
          <div
            key={toast.id}
            className={`animate-fade-in flex items-center gap-2 px-6 py-4 rounded-card bg-surface-raised/95 border shadow-floating backdrop-blur-sm ${
              toast.ok ? "border-up/40" : "border-down/40"
            }`}
          >
            {toast.ok ? <Check aria-hidden="true" className="w-4 h-4 text-up" /> : <X aria-hidden="true" className="w-4 h-4 text-down" />}
            <span className={`text-[15px] font-medium tracking-tight ${toast.ok ? "text-text-primary" : "text-down"}`}>
              {toast.msg}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
