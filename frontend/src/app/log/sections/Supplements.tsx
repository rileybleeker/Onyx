"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Plus, X } from "lucide-react";
import { useInFeed } from "@/components/FeedContext";
import { cachedJson, clientCache, fetchJsonValue, GONE } from "@/lib/client-cache";
import { fallbackBehavioralToday } from "@/lib/checkin";
import { sameJson } from "@/lib/format";
import { useLogDrafts, type SupplementLogDraft } from "@/lib/log-drafts";
import { LOG_SUPPLEMENTS_PRODUCTS_URL, LOG_SUPPLEMENTS_STACKS_URL, LOG_SUPPLEMENTS_TODAY_URL, logEarlyGet } from "@/lib/log-early";
import { DraftMark, LogCard, LogSaveButton, SectionSkeleton } from "./ui";

/**
 * /log Supplements (AGENTS.md "Log screen"). Three parts, all through the existing supplement routes:
 *   - Stacks: one row per active stack (reminder time, logged or not on behavioral today). Log it = POST
 *     /api/supplements/stacks/log with only the stack id (the server stamps behavioral today + now, like the
 *     /agents card); Skip only for a reminder card still open (status "prompted" in pds.supplement_stack_reminder),
 *     through POST /api/supplements/reminders/respond. Undo deletes that stack's rows for the day.
 *   - Log a product: pick from the /supplements list, amount + unit, clock times, day. POST
 *     /api/supplements/log-product, which runs the chat tool's logSupplementIntake (lib/supplement-intake.ts), so
 *     amounts, times, the awake tail and the no-time rule are the same as "log 15 mg of X at 8:30" in chat.
 *   - Logged today: single products logged on behavioral today, each with Undo (DELETE /api/supplements/log-intake).
 * Say it drafts (useLogDrafts("supplements")) are listed marked "from what you said" and logged on their own 0.8 s
 * later (autosave; each row then has Undo); a failed one stays listed with Edit and Retry. "Log a product" keeps its
 * Log tap: logging a dose is the action itself, like a stack's Log it. Nothing is written on open or on scroll. Reads: the client cache first (same keys as
 * /supplements and the warm-up), then the server.
 */

const TODAY_URL = LOG_SUPPLEMENTS_TODAY_URL;
const STACKS_URL = LOG_SUPPLEMENTS_STACKS_URL;
const PRODUCTS_URL = LOG_SUPPLEMENTS_PRODUCTS_URL;

interface Intake {
  intake_id: number;
  intake_date: string;
  intake_time: string | null;
  product_id: string;
  doses: number;
  notes: string | null;
  stack_id?: number | null;
  brand_name: string | null;
  full_name: string | null;
}
interface TodayResp {
  date: string;
  intakes: Intake[];
  reminders?: { stack_id: number; status: string }[] | null;
}
interface Stack {
  stack_id: number;
  name: string;
  remind_time: string | null;
  item_count?: number;
}
interface Product {
  product_id: string;
  brand_name: string | null;
  full_name: string | null;
  serving_size: number | null;
  serving_unit: string | null;
}

/** A row of "Logged today" (from the server, or just written and not re-read yet). */
interface LoggedRow {
  intake_id: number;
  label: string;
  time: string | null; // display text
  doses: number;
}

type LoadState = "loading" | "ready" | "failed";

function checkToday(d: unknown) {
  const t = d as Partial<TodayResp> | null;
  if (!t || typeof t.date !== "string" || !Array.isArray(t.intakes)) throw new Error("bad supplements/today answer");
}
function checkStacks(d: unknown) {
  if (!d || !Array.isArray((d as { stacks?: unknown }).stacks)) throw new Error("bad supplements/stacks answer");
}
function checkProducts(d: unknown) {
  if (!d || !Array.isArray((d as { products?: unknown }).products)) throw new Error("bad supplements/products answer");
}

/** This device's memory copy of a read, if it passes `check` (the persisted copy is read after mount). */
function peekChecked<T>(url: string, check: (d: unknown) => void, ok: (v: T) => boolean = () => true): T | null {
  const v = clientCache.peek(url);
  if (v === undefined) return null;
  try {
    check(v);
  } catch {
    return null;
  }
  return ok(v as T) ? (v as T) : null;
}

const productLabel = (p: { brand_name: string | null; full_name: string | null }) =>
  p.full_name?.trim() || p.brand_name?.trim() || "Product";
const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9µ.]+/g, " ").trim();

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
/** "08:30" -> "8:30 AM". */
function clockLabel(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function timeOf(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
/** Instant of a local "HH:MM" on behavioral day `day` (before 06:00 = the small hours closing that day). */
function instantOn(day: string, hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const [y, mo, d] = day.split("-").map(Number);
  return new Date(y, mo - 1, d + (h < 6 ? 1 : 0), h, m).toISOString();
}
function nowHHMM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function dayLabel(date: string | null, today: string | null): string {
  if (!date || date === today) return "today";
  if (today && date === addDays(today, -1)) return "yesterday";
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}
/** The chat tool's errors end with a hint for the model ("Ask which one."); on screen the form is the answer. */
const screenError = (msg: string) => msg.replace(/\s*Ask (how many servings were taken|which one)\.?$/, "");

/** Matching active stack for a draft: its id, else its name (exact, then contained). */
function findStack(stacks: Stack[], d: { stack_id: number | null; name: string }): Stack | undefined {
  if (d.stack_id != null) return stacks.find((s) => s.stack_id === d.stack_id);
  const q = norm(d.name).replace(/\bstack\b/g, "").trim();
  if (!q) return undefined;
  const exact = stacks.filter((s) => norm(s.name) === norm(d.name) || norm(s.name).replace(/\bstack\b/g, "").trim() === q);
  if (exact.length === 1) return exact[0];
  const contains = stacks.filter((s) => norm(s.name).includes(q));
  return contains.length === 1 ? contains[0] : undefined;
}

/** Products whose brand + name contain every word of the query, best first. */
function searchProducts(products: Product[], query: string): Product[] {
  const tokens = norm(query).split(" ").filter(Boolean);
  if (tokens.length === 0) return [];
  const scored: { p: Product; s: number }[] = [];
  for (const p of products) {
    const name = norm(`${p.brand_name ?? ""} ${p.full_name ?? ""}`);
    if (!tokens.every((t) => name.includes(t))) continue;
    const full = norm(p.full_name);
    scored.push({ p, s: full === norm(query) ? 0 : full.startsWith(tokens[0]) ? 1 : 2 });
  }
  return scored.sort((a, b) => a.s - b.s || productLabel(a.p).localeCompare(productLabel(b.p))).map((x) => x.p);
}

/** Units the chat tool's dosesFor understands, for one product. "serving" = doses. */
function unitOptions(p: Product | null): { value: string; label: string }[] {
  const out = [{ value: "serving", label: p?.serving_unit ? `servings (${p.serving_size ?? 1} ${p.serving_unit})` : "servings" }];
  const count = (p?.serving_unit ?? "").toLowerCase().replace(/\([^)]*\)/g, "").trim();
  if (count && !/^(g|mg|mcg|µg|ug|iu|ml|serving)s?$/.test(count)) out.push({ value: p!.serving_unit!, label: p!.serving_unit!.toLowerCase() });
  for (const u of ["mg", "mcg", "g", "IU"]) out.push({ value: u, label: u });
  return out;
}

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, json };
}

type SuggestionState = "ready" | "saving" | "failed";
interface Suggestion {
  key: number;
  item: SupplementLogDraft;
  state: SuggestionState;
  error: string | null;
}

const btn =
  "min-h-11 px-3 rounded-control border border-border-subtle bg-white/[0.03] hover:bg-white/[0.06] text-[13px] text-text-secondary disabled:opacity-50 transition-colors";
const btnAccent =
  "min-h-11 px-4 rounded-full bg-accent text-on-accent text-[13px] font-semibold disabled:opacity-40 transition-opacity";
const input =
  "min-h-11 rounded-control border border-border-subtle bg-transparent px-3 text-[14px] text-text-primary placeholder:text-text-disabled focus:outline-none focus:border-border-emphasis";

export default function SupplementsSection() {
  // Painted from the memory cache on the first render (the warm-up and other screens fill it); same rules as the
  // seed below: today's copy only when it is for the current behavioral day.
  const [today, setToday] = useState<TodayResp | null>(() =>
    peekChecked<TodayResp>(TODAY_URL, checkToday, (t) => t.date === fallbackBehavioralToday(new Date())),
  );
  const [stacks, setStacks] = useState<Stack[] | null>(() => peekChecked<{ stacks: Stack[] }>(STACKS_URL, checkStacks)?.stacks ?? null);
  const [products, setProducts] = useState<Product[] | null>(() => peekChecked<{ products: Product[] }>(PRODUCTS_URL, checkProducts)?.products ?? null);
  const [todayState, setTodayState] = useState<LoadState>(() => (today ? "ready" : "loading"));
  const [stacksState, setStacksState] = useState<LoadState>(() => (stacks ? "ready" : "loading"));
  const [productsState, setProductsState] = useState<LoadState>(() => (products ? "ready" : "loading"));

  // Writes since load: rows just written (shown until the next read), rows being removed, stacks just logged.
  const [extraRows, setExtraRows] = useState<LoggedRow[]>([]);
  const [hidden, setHidden] = useState<Set<number>>(() => new Set());
  const [justLogged, setJustLogged] = useState<Map<number, { ids: number[]; time: string }>>(() => new Map());
  const [justSkipped, setJustSkipped] = useState<Set<number>>(() => new Set());
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});

  // A read started before a write is dropped (the write's own re-read follows it).
  const writeSeq = useRef(0);
  const loadSeq = useRef(0);
  const answered = useRef({ today: false, stacks: false, products: false });

  const applyToday = useCallback((t: TodayResp, fromServer: boolean) => {
    setToday((prev) => (sameJson(prev, t) ? prev : t));
    setTodayState("ready");
    if (fromServer) {
      setExtraRows((l) => (l.length ? [] : l));
      setJustLogged((m) => (m.size ? new Map() : m));
      setJustSkipped((s) => (s.size ? new Set() : s));
    }
  }, []);

  /** Re-read today's intakes (after a write, or when the screen comes back). Not shared with an older request. */
  const reloadToday = useCallback(async () => {
    const seq = ++loadSeq.current;
    const writes = writeSeq.current;
    try {
      const v = await fetchJsonValue(TODAY_URL);
      if (v === GONE) throw new Error("gone");
      checkToday(v);
      if (seq !== loadSeq.current || writes !== writeSeq.current) return;
      clientCache.put(TODAY_URL, v);
      answered.current.today = true;
      applyToday(v as TodayResp, true);
    } catch {
      if (seq === loadSeq.current && !answered.current.today) setTodayState((s) => (s === "ready" ? s : "failed"));
    }
  }, [applyToday]);

  // The routed page's first reads take the GETs its HTML already started (lib/log-early.ts), once each.
  const routed = !useInFeed();
  const loadAll = useCallback(() => {
    const seq = ++loadSeq.current;
    const writes = writeSeq.current;
    cachedJson<TodayResp>(TODAY_URL, { check: checkToday, get: logEarlyGet(TODAY_URL, routed) })
      .then((v) => {
        if (seq !== loadSeq.current || writes !== writeSeq.current) return;
        answered.current.today = true;
        applyToday(v, true);
      })
      .catch(() => setTodayState((s) => (s === "ready" ? s : "failed")));
    cachedJson<{ stacks: Stack[] }>(STACKS_URL, { check: checkStacks, get: logEarlyGet(STACKS_URL, routed) })
      .then((v) => {
        answered.current.stacks = true;
        setStacks((prev) => (sameJson(prev, v.stacks) ? prev : v.stacks));
        setStacksState("ready");
      })
      .catch(() => setStacksState((s) => (s === "ready" ? s : "failed")));
    cachedJson<{ products: Product[] }>(PRODUCTS_URL, { check: checkProducts, get: logEarlyGet(PRODUCTS_URL, routed) })
      .then((v) => {
        answered.current.products = true;
        setProducts((prev) => (sameJson(prev, v.products) ? prev : v.products));
        setProductsState("ready");
      })
      .catch(() => setProductsState((s) => (s === "ready" ? s : "failed")));
  }, [applyToday, routed]);

  // This device's copy at once (memory, else the persisted cache), then the server.
  useEffect(() => {
    let alive = true;
    const seedToday = (v: unknown) => {
      if (!alive || answered.current.today || v === undefined) return;
      try { checkToday(v); } catch { return; }
      if ((v as TodayResp).date !== fallbackBehavioralToday(new Date())) return;
      applyToday(v as TodayResp, false);
    };
    const seedStacks = (v: unknown) => {
      if (!alive || answered.current.stacks || v === undefined) return;
      try { checkStacks(v); } catch { return; }
      setStacks((v as { stacks: Stack[] }).stacks);
      setStacksState("ready");
    };
    const seedProducts = (v: unknown) => {
      if (!alive || answered.current.products || v === undefined) return;
      try { checkProducts(v); } catch { return; }
      setProducts((v as { products: Product[] }).products);
      setProductsState("ready");
    };
    const seed = (url: string, fn: (v: unknown) => void) => {
      const hit = clientCache.peek(url);
      if (hit !== undefined) fn(hit);
      else void clientCache.read(url).then(fn).catch(() => {});
    };
    seed(TODAY_URL, seedToday);
    seed(STACKS_URL, seedStacks);
    seed(PRODUCTS_URL, seedProducts);
    loadAll();
    return () => { alive = false; };
  }, [applyToday, loadAll]);

  // Back on screen after a minute: re-read today (the behavioral day may have rolled over).
  useEffect(() => {
    let hiddenAt = 0;
    const onVis = () => {
      if (document.visibilityState === "hidden") hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > 60_000) void reloadToday();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [reloadToday]);

  const day = today?.date ?? null;
  const reminderStatus = useMemo(() => {
    if (!today || !Array.isArray(today.reminders)) return null;
    return new Map(today.reminders.map((r) => [Number(r.stack_id), r.status]));
  }, [today]);

  const stackRows = useMemo(() => {
    const m = new Map<number, Intake[]>();
    for (const i of today?.intakes ?? []) {
      if (i.stack_id == null || hidden.has(i.intake_id)) continue;
      const list = m.get(Number(i.stack_id)) ?? [];
      list.push(i);
      m.set(Number(i.stack_id), list);
    }
    return m;
  }, [today, hidden]);

  const sortedStacks = useMemo(
    () => [...(stacks ?? [])].sort((a, b) => {
      if (a.remind_time && b.remind_time) return a.remind_time.localeCompare(b.remind_time);
      return a.remind_time ? -1 : b.remind_time ? 1 : 0;
    }),
    [stacks],
  );

  const loggedRows: LoggedRow[] = useMemo(() => {
    const fromServer = (today?.intakes ?? [])
      .filter((i) => i.stack_id == null && !hidden.has(i.intake_id))
      .map((i) => ({ intake_id: i.intake_id, label: productLabel(i), time: timeOf(i.intake_time), doses: Number(i.doses) }));
    const ids = new Set(fromServer.map((r) => r.intake_id));
    return [...extraRows.filter((r) => !ids.has(r.intake_id) && !hidden.has(r.intake_id)), ...fromServer];
  }, [today, extraRows, hidden]);

  const setBusyKey = (k: string, v: boolean) => setBusy((b) => ({ ...b, [k]: v }));
  const setErr = (k: string, msg: string | null) =>
    setRowError((e) => {
      const next = { ...e };
      if (msg) next[k] = msg;
      else delete next[k];
      return next;
    });

  // ---- stacks ----

  async function logStack(stack: Stack, body: Record<string, unknown> = { stack_id: stack.stack_id }): Promise<string | null> {
    writeSeq.current += 1;
    try {
      const r = await postJson("/api/supplements/stacks/log", body);
      if (!r.ok) return typeof r.json.error === "string" ? r.json.error : `Not saved (${r.status})`;
      const ids = Array.isArray(r.json.intake_ids) ? (r.json.intake_ids as number[]) : [];
      if (r.json.intake_date === day) {
        setJustLogged((m) => new Map(m).set(stack.stack_id, { ids, time: timeOf(typeof body.intake_time === "string" ? body.intake_time : new Date().toISOString()) ?? "" }));
      }
      return null;
    } catch {
      return "No answer from Onyx";
    } finally {
      void reloadToday();
    }
  }

  async function onLogStack(stack: Stack) {
    const k = `stack:${stack.stack_id}`;
    setBusyKey(k, true);
    setErr(k, null);
    const err = await logStack(stack);
    if (err) setErr(k, err);
    setBusyKey(k, false);
  }

  async function onSkipStack(stack: Stack) {
    if (!day) return;
    const k = `stack:${stack.stack_id}`;
    setBusyKey(k, true);
    setErr(k, null);
    writeSeq.current += 1;
    try {
      const r = await postJson("/api/supplements/reminders/respond", { stack_id: stack.stack_id, behavioral_date: day, action: "skip" });
      if (!r.ok) setErr(k, typeof r.json.error === "string" ? r.json.error : `Not skipped (${r.status})`);
      else if (r.json.status === "skipped") setJustSkipped((s) => new Set(s).add(stack.stack_id));
    } catch {
      setErr(k, "No answer from Onyx");
    } finally {
      setBusyKey(k, false);
      void reloadToday();
    }
  }

  async function deleteIntakes(ids: number[]): Promise<number[]> {
    const ok = await Promise.all(
      ids.map((id) => fetch(`/api/supplements/log-intake?intake_id=${id}`, { method: "DELETE" }).then((r) => r.ok, () => false)),
    );
    return ids.filter((_, i) => !ok[i]);
  }

  async function onUndoStack(stack: Stack) {
    const k = `stack:${stack.stack_id}`;
    const ids = [...(stackRows.get(stack.stack_id) ?? []).map((i) => i.intake_id), ...(justLogged.get(stack.stack_id)?.ids ?? [])];
    const unique = Array.from(new Set(ids));
    if (unique.length === 0) return;
    setBusyKey(k, true);
    setErr(k, null);
    writeSeq.current += 1;
    setHidden((h) => { const n = new Set(h); unique.forEach((id) => n.add(id)); return n; });
    setJustLogged((m) => { const n = new Map(m); n.delete(stack.stack_id); return n; });
    const failed = await deleteIntakes(unique);
    if (failed.length) {
      setHidden((h) => { const n = new Set(h); failed.forEach((id) => n.delete(id)); return n; });
      setErr(k, `Not removed: ${failed.length} of ${unique.length}`);
    }
    setBusyKey(k, false);
    void reloadToday();
  }

  async function onUndoRow(row: LoggedRow) {
    const k = `row:${row.intake_id}`;
    setBusyKey(k, true);
    setErr(k, null);
    writeSeq.current += 1;
    setHidden((h) => new Set(h).add(row.intake_id));
    const failed = await deleteIntakes([row.intake_id]);
    if (failed.length) {
      setHidden((h) => { const n = new Set(h); n.delete(row.intake_id); return n; });
      setErr(k, `Not removed: ${row.label}`);
    }
    setBusyKey(k, false);
    void reloadToday();
  }

  // ---- log a product ----

  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Product | null>(null);
  const [amount, setAmount] = useState("");
  const [unit, setUnit] = useState("serving");
  const [times, setTimes] = useState<string[]>([]);
  const [dayChoice, setDayChoice] = useState<string>("today"); // "today" | "yesterday" | YYYY-MM-DD
  const [formFromDraft, setFormFromDraft] = useState(false);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const receiptTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (receiptTimer.current) clearTimeout(receiptTimer.current); }, []);
  const showReceipt = (msg: string) => {
    setReceipt(msg);
    if (receiptTimer.current) clearTimeout(receiptTimer.current);
    receiptTimer.current = setTimeout(() => setReceipt(null), 4000);
  };

  const hits = useMemo(() => (picked || !products ? [] : searchProducts(products, query).slice(0, 6)), [products, query, picked]);
  const formDate = dayChoice === "today" ? null : dayChoice === "yesterday" ? (day ? addDays(day, -1) : null) : dayChoice;

  function resetForm() {
    setQuery("");
    setPicked(null);
    setAmount("");
    setUnit("serving");
    setTimes([]);
    setDayChoice("today");
    setFormFromDraft(false);
    setFormError(null);
  }

  /** One product write through the chat tool's rules. Returns an error message, or null when saved. */
  async function logProduct(args: {
    product_id: string | null; name: string; amount: number | null; unit: string | null; times: string[]; date: string | null;
  }): Promise<string | null> {
    if (args.date && day && args.date > day) return "That day has not started yet";
    writeSeq.current += 1;
    try {
      const r = await postJson("/api/supplements/log-product", {
        product_id: args.product_id ?? undefined,
        product: args.name,
        amount: args.amount,
        unit: args.amount == null ? null : args.unit,
        times: args.times,
        date: args.date,
      });
      if (!r.ok || r.json.ok !== true) {
        const msg = typeof r.json.error === "string" ? screenError(r.json.error) : `Not saved (${r.status})`;
        const cands = Array.isArray(r.json.candidates) && r.json.candidates.length > 1 && r.json.candidates.length <= 6
          ? ` (${(r.json.candidates as string[]).join(", ")})`
          : "";
        return msg + cands;
      }
      const logged = Array.isArray(r.json.logged) ? (r.json.logged as { intake_id: number; time: string | null }[]) : [];
      const label = typeof r.json.product === "string" ? r.json.product : args.name;
      const doses = Number(r.json.doses_each ?? 1);
      if (r.json.intake_date === day && logged.length) {
        setExtraRows((l) => [...logged.map((x) => ({ intake_id: x.intake_id, label, time: x.time, doses })), ...l]);
      }
      const skipped = Array.isArray(r.json.skipped_duplicates) ? r.json.skipped_duplicates.length : 0;
      const when = r.json.intake_date === day ? "" : `, ${dayLabel(String(r.json.intake_date), day)}`;
      showReceipt(
        `Saved ${label}${logged.length > 1 ? `, ${logged.length} times` : ""}${when}` +
          (skipped ? ` (${skipped} already logged)` : ""),
      );
      return null;
    } catch {
      return "No answer from Onyx";
    } finally {
      void reloadToday();
    }
  }

  async function onLogProduct() {
    if (!picked) return;
    const amt = amount.trim() === "" ? null : Number(amount);
    if (amt != null && (!Number.isFinite(amt) || amt <= 0)) {
      setFormError("Amount must be a positive number");
      return;
    }
    const clean = times.map((t) => t.slice(0, 5));
    if (clean.some((t) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t))) {
      setFormError("Fill in or remove the empty time");
      return;
    }
    setFormBusy(true);
    setFormError(null);
    const err = await logProduct({ product_id: picked.product_id, name: productLabel(picked), amount: amt, unit, times: clean, date: formDate });
    setFormBusy(false);
    if (err) setFormError(err);
    else resetForm();
  }

  // ---- Say it drafts ----

  const { draft, clear } = useLogDrafts("supplements");
  const [suggestions, setSuggestions] = useState<{ draftId: number; items: Suggestion[] } | null>(null);
  const [savingSuggestions, setSavingSuggestions] = useState(false);
  useEffect(() => {
    if (!draft) {
      setSuggestions(null);
      return;
    }
    setSuggestions((cur) =>
      cur && cur.draftId === draft.id
        ? cur
        : { draftId: draft.id, items: draft.value.map((item, i) => ({ key: i, item, state: "ready" as const, error: null })) },
    );
  }, [draft]);

  const openSuggestions = suggestions?.items ?? [];
  function dropSuggestion(key: number) {
    if (!suggestions) return;
    const left = suggestions.items.filter((s) => s.key !== key);
    if (left.length === 0) clear(suggestions.draftId);
    else setSuggestions({ ...suggestions, items: left });
  }

  /** Move a product suggestion into the form (only on Riley's tap, so it never replaces something typed). */
  function editSuggestion(s: Suggestion) {
    if (s.item.kind !== "product") return;
    const d = s.item;
    const match = d.product_id
      ? products?.find((p) => p.product_id === d.product_id) ?? null
      : (() => { const m = searchProducts(products ?? [], d.name); return m.length === 1 ? m[0] : null; })();
    setPicked(match);
    setQuery(match ? "" : d.name);
    setAmount(d.amount != null ? String(d.amount) : "");
    setUnit(d.amount != null && d.unit ? d.unit : "serving");
    setTimes(d.times);
    setDayChoice(!d.date || d.date === day ? "today" : day && d.date === addDays(day, -1) ? "yesterday" : d.date);
    setFormFromDraft(true);
    setFormError(null);
    dropSuggestion(s.key);
  }

  function stackAlreadyLogged(stackId: number, date: string | null): boolean {
    if (date && date !== day) return false;
    return (stackRows.get(stackId)?.length ?? 0) > 0 || justLogged.has(stackId);
  }

  async function saveSuggestions() {
    if (!suggestions || savingSuggestions) return;
    const { draftId } = suggestions;
    setSavingSuggestions(true);
    let items = suggestions.items.map((s) => (s.state === "saving" ? s : { ...s, state: "saving" as const, error: null }));
    setSuggestions({ draftId, items });
    const done: number[] = [];
    for (const s of items) {
      let err: string | null = null;
      if (s.item.kind === "product") {
        const d = s.item;
        err = await logProduct({ product_id: d.product_id, name: d.name, amount: d.amount, unit: d.unit, times: d.times, date: d.date });
      } else {
        const d = s.item;
        const stack = findStack(stacks ?? [], d);
        if (!stack) err = `No stack named "${d.name}"`;
        else if (stackAlreadyLogged(stack.stack_id, d.date)) err = `${stack.name} is already logged ${dayLabel(d.date, day)}`;
        else if (d.date && day && d.date > day) err = "That day has not started yet";
        else {
          const date = d.date ?? day;
          const body: Record<string, unknown> = { stack_id: stack.stack_id };
          if (d.time && date) {
            body.intake_date = date;
            body.intake_time = instantOn(date, d.time);
          } else if (d.date && d.date !== day) {
            body.intake_date = d.date;
            body.intake_time = null; // an earlier day without a time: no clock instant (same rule as /supplements)
          }
          err = await logStack(stack, body);
        }
      }
      if (err) items = items.map((x) => (x.key === s.key ? { ...x, state: "failed", error: err } : x));
      else {
        done.push(s.key);
        items = items.filter((x) => x.key !== s.key);
      }
      setSuggestions((cur) => (cur && cur.draftId === draftId ? { draftId, items } : cur));
    }
    setSavingSuggestions(false);
    if (items.length === 0) clear(draftId);
  }

  // Autosave (2026-11-15): what the Say it box filled from Riley's words is logged on its own, 0.8 s after it shows,
  // once the stack list is in (a stack is matched by name). Each logged row lands under "Logged today" / its stack
  // with Undo; a suggestion that fails stays listed with its reason, Edit and Retry.
  const saveSuggestionsRef = useRef(saveSuggestions);
  saveSuggestionsRef.current = saveSuggestions;
  const autoSaved = useRef<number | null>(null);
  const suggestionDraftId = suggestions?.draftId ?? null;
  useEffect(() => {
    if (suggestionDraftId == null || autoSaved.current === suggestionDraftId || !stacks || !day) return;
    const t = setTimeout(() => {
      autoSaved.current = suggestionDraftId;
      void saveSuggestionsRef.current();
    }, 800);
    return () => clearTimeout(t);
  }, [suggestionDraftId, stacks, day]);
  const suggestionsWaiting = suggestionDraftId != null && autoSaved.current !== suggestionDraftId;

  // ---- render ----

  const nothingYet = !today && !stacks;
  if (nothingYet && (todayState === "loading" || stacksState === "loading")) return <SectionSkeleton section="supplements" />;
  if (nothingYet) {
    return (
      <LogCard title="Supplements">
        <p className="text-[13px] text-text-secondary">Couldn&apos;t load supplements.</p>
        <button type="button" className={`${btn} mt-3`} onClick={() => { setTodayState("loading"); setStacksState("loading"); loadAll(); }}>
          Retry
        </button>
      </LogCard>
    );
  }

  return (
    <LogCard title="Supplements">
      {openSuggestions.length > 0 && (
        <div className="mb-4 rounded-control border border-border-emphasis bg-accent-muted p-3" aria-label="Suggested supplements">
          <div className="mb-2 flex items-center justify-between gap-2">
            <DraftMark />
            <button type="button" className="min-h-11 px-2 text-[13px] text-text-secondary hover:text-text-primary" disabled={savingSuggestions} onClick={() => clear(suggestions!.draftId)}>
              Dismiss
            </button>
          </div>
          <ul className="space-y-2">
            {openSuggestions.map((s) => {
              const it = s.item;
              const stack = it.kind === "stack" ? findStack(stacks ?? [], it) : undefined;
              const name = it.kind === "stack" ? stack?.name ?? it.name : it.name;
              const detail = it.kind === "product"
                ? [
                    it.amount != null ? `${it.amount} ${it.unit ?? "servings"}` : "1 serving",
                    it.times.length ? it.times.map(clockLabel).join(", ") : null,
                    dayLabel(it.date, day),
                  ].filter(Boolean).join(" · ")
                : [it.time ? clockLabel(it.time) : null, dayLabel(it.date, day)].filter(Boolean).join(" · ");
              return (
                <li key={s.key} className="flex items-start gap-2">
                  <div className="min-w-0 flex-1 py-1">
                    <div className="text-[14px] text-text-primary truncate">{name}{it.kind === "stack" ? " (stack)" : ""}</div>
                    <div className="text-[12px] font-mono text-text-tertiary">{detail}</div>
                    {s.error && <div role="alert" className="text-[12px] text-down">{s.error}</div>}
                  </div>
                  {it.kind === "product" && s.state === "failed" && (
                    <button type="button" className={btn} disabled={savingSuggestions} onClick={() => editSuggestion(s)}>Edit</button>
                  )}
                  <button type="button" aria-label={`Remove ${name}`} className={`${btn} px-2`} disabled={savingSuggestions} onClick={() => dropSuggestion(s.key)}>
                    <X className="w-4 h-4" aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="mt-3">
            {savingSuggestions || suggestionsWaiting ? (
              <span role="status" className="text-[12px] text-text-tertiary">Logging what you said…</span>
            ) : (
              <LogSaveButton onClick={() => void saveSuggestions()} saving={savingSuggestions} label="Retry" />
            )}
          </div>
        </div>
      )}

      {/* Stacks */}
      {stacks ? (
        sortedStacks.length > 0 ? (
          <ul className="rounded-control border border-border-subtle divide-y divide-border-subtle">
            {sortedStacks.map((s) => {
              const k = `stack:${s.stack_id}`;
              const rows = stackRows.get(s.stack_id) ?? [];
              const just = justLogged.get(s.stack_id);
              const logged = rows.length > 0 || !!just;
              const loggedAt = rows.length ? timeOf(rows.map((r) => r.intake_time).filter(Boolean).sort()[0] ?? null) : just?.time ?? null;
              const status = justSkipped.has(s.stack_id) ? "skipped" : reminderStatus?.get(s.stack_id) ?? null;
              const skipped = !logged && status === "skipped";
              return (
                <li key={s.stack_id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] text-text-primary truncate">{s.name}</div>
                    <div className="text-[12px] font-mono text-text-tertiary">
                      {s.remind_time ? clockLabel(s.remind_time) : "No reminder"}
                      {typeof s.item_count === "number" ? ` · ${s.item_count} item${s.item_count === 1 ? "" : "s"}` : ""}
                    </div>
                    {rowError[k] && <div role="alert" className="text-[12px] text-down">{rowError[k]}</div>}
                  </div>
                  {logged ? (
                    <>
                      <span className="inline-flex items-center gap-1 text-[13px] text-up">
                        <Check className="w-4 h-4" aria-hidden />
                        Logged{loggedAt ? ` ${loggedAt}` : ""}
                      </span>
                      <button type="button" className={btn} disabled={busy[k]} onClick={() => void onUndoStack(s)}>Undo</button>
                    </>
                  ) : (
                    <>
                      {skipped && <span className="text-[13px] text-text-tertiary">Skipped</span>}
                      {status === "prompted" && (
                        <button type="button" className={btn} disabled={busy[k] || !day} onClick={() => void onSkipStack(s)}>Skip</button>
                      )}
                      <button type="button" className={btnAccent} disabled={busy[k]} onClick={() => void onLogStack(s)}>
                        {busy[k] ? "Saving…" : "Log it"}
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-[13px] text-text-tertiary">No stacks yet</p>
        )
      ) : stacksState === "failed" ? (
        <p className="text-[13px] text-text-secondary">Couldn&apos;t load stacks.</p>
      ) : (
        <div className="space-y-2" aria-hidden>{[0, 1].map((i) => <div key={i} className="skeleton h-11 rounded-control" />)}</div>
      )}

      {/* Log a product */}
      <div className="mt-4">
        <div className="mb-2 flex items-center gap-2">
          <h3 className="text-[13px] font-medium text-text-secondary">Log a product</h3>
          {formFromDraft && <DraftMark />}
        </div>
        {!picked ? (
          <div>
            <input
              type="search"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setFormError(null); }}
              placeholder={productsState === "failed" ? "Couldn't load products" : "Search your supplements"}
              aria-label="Search your supplements"
              disabled={productsState === "failed" && !products}
              className={`${input} w-full`}
            />
            {query.trim() && products && (
              hits.length > 0 ? (
                <ul className="mt-2 rounded-control border border-border-subtle divide-y divide-border-subtle">
                  {hits.map((p) => (
                    <li key={p.product_id}>
                      <button
                        type="button"
                        className="w-full min-h-11 px-3 py-2 text-left hover:bg-white/[0.04]"
                        onClick={() => { setPicked(p); setUnit("serving"); setFormError(null); }}
                      >
                        <div className="text-[14px] text-text-primary truncate">{productLabel(p)}</div>
                        {p.brand_name && p.full_name && <div className="text-[12px] text-text-tertiary truncate">{p.brand_name}</div>}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-[13px] text-text-tertiary">No match in your supplements</p>
              )
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1 text-[14px] text-text-primary truncate">{productLabel(picked)}</div>
              <button type="button" className={btn} onClick={() => { setPicked(null); setFormError(null); }}>Change</button>
            </div>
            <div className="flex flex-wrap gap-2">
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="1"
                aria-label="Amount"
                className={`${input} w-24`}
              />
              <select value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="Unit" className={`${input} min-w-0 flex-1 bg-surface-card`}>
                {unitOptions(picked).map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
                {!unitOptions(picked).some((u) => u.value === unit) && <option value={unit}>{unit}</option>}
              </select>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {times.length === 0 && (
                <span className="text-[13px] text-text-tertiary">{formDate && formDate !== day ? "No time" : "Now"}</span>
              )}
              {times.map((t, i) => (
                <span key={i} className="inline-flex items-center gap-1">
                  <input
                    type="time"
                    value={t}
                    onChange={(e) => setTimes((l) => l.map((x, j) => (j === i ? e.target.value : x)))}
                    aria-label={`Time ${i + 1}`}
                    className={`${input} w-32`}
                  />
                  <button type="button" aria-label={`Remove time ${i + 1}`} className={`${btn} px-2`} onClick={() => setTimes((l) => l.filter((_, j) => j !== i))}>
                    <X className="w-4 h-4" aria-hidden />
                  </button>
                </span>
              ))}
              <button type="button" className={`${btn} inline-flex items-center gap-1`} disabled={times.length >= 12} onClick={() => setTimes((l) => [...l, nowHHMM()])}>
                <Plus className="w-4 h-4" aria-hidden />
                Time
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select value={dayChoice} onChange={(e) => setDayChoice(e.target.value)} aria-label="Day" className={`${input} bg-surface-card`}>
                <option value="today">Today</option>
                <option value="yesterday">Yesterday</option>
                {dayChoice !== "today" && dayChoice !== "yesterday" && <option value={dayChoice}>{dayLabel(dayChoice, day)}</option>}
              </select>
              <LogSaveButton onClick={() => void onLogProduct()} saving={formBusy} label="Log" />
              <button type="button" className="min-h-11 px-2 text-[13px] text-text-secondary hover:text-text-primary" onClick={resetForm}>Cancel</button>
            </div>
          </div>
        )}
        {formError && <p role="alert" className="mt-2 text-[13px] text-down">{formError}</p>}
        {receipt && <p role="status" className="mt-2 text-[13px] text-up">{receipt}</p>}
      </div>

      {/* Logged today (single products; a stack's rows are on its row above) */}
      <div className="mt-4">
        <h3 className="mb-2 text-[13px] font-medium text-text-secondary">Logged today</h3>
        {today ? (
          loggedRows.length > 0 ? (
            <ul className="rounded-control border border-border-subtle divide-y divide-border-subtle">
              {loggedRows.map((r) => {
                const k = `row:${r.intake_id}`;
                return (
                  <li key={r.intake_id} className="flex items-center gap-2 px-3 py-1.5">
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] text-text-primary truncate">{r.label}</div>
                      <div className="text-[12px] font-mono text-text-tertiary">
                        {[r.time ?? "No time", r.doses !== 1 ? `×${Math.round(r.doses * 100) / 100}` : null].filter(Boolean).join(" · ")}
                      </div>
                      {rowError[k] && <div role="alert" className="text-[12px] text-down">{rowError[k]}</div>}
                    </div>
                    <button type="button" className={btn} disabled={busy[k]} onClick={() => void onUndoRow(r)}>Undo</button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-[13px] text-text-tertiary">Nothing else logged today</p>
          )
        ) : todayState === "failed" ? (
          <p className="text-[13px] text-text-secondary">Couldn&apos;t load today&apos;s intakes.</p>
        ) : (
          <div className="skeleton h-11 rounded-control" aria-hidden />
        )}
      </div>
    </LogCard>
  );
}
