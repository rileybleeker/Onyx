"use client";

/**
 * The apartment-reset store (one per page, shared by Today's card and anything else that wants it). Reads
 * GET /api/home-reset and keeps every tap that is not saved yet as an OP in localStorage (`onyx.homeReset.ops`), so a
 * tap survives navigation, a reload, the continuous scroll evicting the page and an offline save failure. Ops are
 * sent in order; every tap carries its own receipt id, so a retry (or a second tab) can never complete twice.
 * Rules: lib/home-reset.ts. Opening or scrolling past the card writes nothing; only a tap does.
 */

import { useSyncExternalStore } from "react";
import { activeItem, easternDay, overlayOps, upkeepOffer, type HomeItem, type HomeMinutes, type HomeOp, type HomeUpkeep } from "@/lib/home-reset";

const OPS_KEY = "onyx.homeReset.ops";
const HIDE_KEY = "onyx.homeReset.hideUntil";
const MAX_OPS = 40;

export interface HomeResetSnapshot {
  load: "loading" | "ready" | "error";
  server: HomeItem[];
  ops: HomeOp[];
  /** Why the oldest unsaved op is not saved: null = fine / still trying. */
  saveError: string | null;
  /** Set while a flush is on its way. */
  saving: boolean;
  /** Epoch ms of the "Not now" on an empty plan (the starter picker stays away until the next day). */
  hiddenDay: string | null;
  items: HomeItem[];
}

let state: Omit<HomeResetSnapshot, "items"> = { load: "loading", server: [], ops: [], saveError: null, saving: false, hiddenDay: null };
let snapshot: HomeResetSnapshot = derive();
const listeners = new Set<() => void>();
let started = false;
let flushing = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function derive(): HomeResetSnapshot {
  return { ...state, items: overlayOps(state.server, state.ops, new Date()) };
}
function emit(patch: Partial<typeof state>) {
  state = { ...state, ...patch };
  snapshot = derive();
  listeners.forEach((l) => l());
}

function readOps(): HomeOp[] {
  try {
    const raw = JSON.parse(localStorage.getItem(OPS_KEY) || "[]");
    return Array.isArray(raw) ? (raw.slice(0, MAX_OPS) as HomeOp[]) : [];
  } catch {
    return [];
  }
}
function writeOps(ops: HomeOp[]) {
  try {
    if (ops.length) localStorage.setItem(OPS_KEY, JSON.stringify(ops));
    else localStorage.removeItem(OPS_KEY);
  } catch {
    /* storage full or blocked: the op still lives in memory for this page */
  }
}

async function json(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { ...init, cache: "no-store", credentials: "same-origin" });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* no body */ }
  return { status: res.status, body };
}

export async function loadHomeReset(): Promise<void> {
  try {
    const { status, body } = await json("/api/home-reset");
    const items = status === 200 && body && typeof body === "object" ? (body as { items?: unknown }).items : null;
    if (!Array.isArray(items)) throw new Error("bad answer");
    emit({ load: "ready", server: items.map(rowItem).filter((i): i is HomeItem => i !== null) });
  } catch {
    emit({ load: state.server.length || state.load === "ready" ? "ready" : "error" });
  }
}

function request(op: HomeOp): Promise<{ status: number; body: unknown }> {
  const post = (url: string, method: string, data: unknown) => json(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  if (op.kind === "create") return post("/api/home-reset/items", "POST", op.item);
  if (op.kind === "tap") {
    const t = op.tap;
    return post("/api/home-reset/act", "POST", { receipt_id: t.receiptId, item_id: t.itemId, action: t.action, ...(t.remaining ? { remaining: t.remaining } : {}), ...(t.snoozeUntil ? { snooze_until: t.snoozeUntil } : {}) });
  }
  return post(`/api/home-reset/items/${op.id}`, "PATCH", {
    ...(op.patch.upkeep ? { upkeep: op.patch.upkeep } : {}),
    ...(op.patch.upkeepPaused !== undefined ? { upkeep_paused: op.patch.upkeepPaused } : {}),
    ...(op.patch.removed ? { removed: true } : {}),
  });
}

/** Fold the server's answer for one saved op into the server list, so the card does not flicker back before the re-read. */
function mergeServer(server: HomeItem[], op: HomeOp, body: unknown): HomeItem[] {
  if (op.kind === "patch" && op.patch.removed) return server.filter((i) => i.id !== op.id);
  const item = body && typeof body === "object" ? rowItem((body as { item?: unknown }).item) : null;
  if (!item) return server;
  return server.some((i) => i.id === item.id) ? server.map((i) => (i.id === item.id ? item : i)) : [...server, item];
}
function rowItem(v: unknown): HomeItem | null {
  return v && typeof v === "object" && "snoozedUntil" in (v as object) ? (v as HomeItem) : null;
}

/** Send the unsaved ops in order. A 4xx drops the op (and says why); anything else keeps it and retries later. */
export async function flushHomeReset(): Promise<void> {
  if (flushing) return;
  flushing = true;
  emit({ saving: state.ops.length > 0 });
  try {
    while (state.ops.length) {
      const op = state.ops[0];
      let res: { status: number; body: unknown };
      try {
        res = await request(op);
      } catch {
        emit({ saveError: "Not saved yet. You appear to be offline." });
        scheduleRetry();
        return;
      }
      if (res.status >= 500 || res.status === 401 || res.status === 403 || res.status === 0) {
        emit({ saveError: "Not saved yet. Onyx could not reach the server." });
        scheduleRetry();
        return;
      }
      const rest = state.ops.slice(1);
      writeOps(rest);
      if (res.status >= 400 && res.status !== 404) {
        emit({ ops: rest, saveError: "That change was refused and was not saved." });
      } else {
        emit({ ops: rest, saveError: null, server: mergeServer(state.server, op, res.body) });
      }
    }
    await loadHomeReset();
  } finally {
    flushing = false;
    emit({ saving: false });
  }
}

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = null; void flushHomeReset(); }, 15000);
}

/** Queue one op: shown at once, saved right away (or when the connection is back). */
export function queueHomeOp(op: HomeOp) {
  const ops = [...state.ops, op].slice(-MAX_OPS);
  writeOps(ops);
  emit({ ops, saveError: null });
  void flushHomeReset();
}

export function newId(): string {
  return crypto.randomUUID();
}

export function createHomeItem(area: string, action: string, minutes: HomeMinutes) {
  queueHomeOp({ kind: "create", item: { id: newId(), area, action, minutes } });
}
export function tapHome(itemId: string, action: "done" | "partly" | "snooze", extra: { remaining?: string | null; snoozeHours?: number } = {}) {
  queueHomeOp({ kind: "tap", tap: {
    receiptId: newId(), itemId, action, remaining: extra.remaining ?? null,
    snoozeUntil: action === "snooze" ? new Date(Date.now() + (extra.snoozeHours ?? 24) * 3600000).toISOString() : null,
  } });
}
export function patchHome(id: string, patch: { upkeep?: HomeUpkeep; upkeepPaused?: boolean; removed?: true }) {
  queueHomeOp({ kind: "patch", id, patch });
}
export function hideStarterToday() {
  try { localStorage.setItem(HIDE_KEY, easternDay(new Date())); } catch { /* ignore */ }
  emit({ hiddenDay: easternDay(new Date()) });
}

function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  let hidden: string | null = null;
  try { hidden = localStorage.getItem(HIDE_KEY); } catch { /* ignore */ }
  const ops = readOps();
  emit({ ops, hiddenDay: hidden });
  // These listeners outlive Today. They re-read the plan only while a card is mounted or a save is waiting; before,
  // they also read it on /log and every other page once Today had been opened in the session.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && (state.ops.length || listeners.size)) void flushHomeReset();
  });
  window.addEventListener("online", () => { if (state.ops.length || listeners.size) void flushHomeReset(); });
}

function subscribe(l: () => void) {
  const firstOnScreen = listeners.size === 0;
  listeners.add(l);
  start();
  // The first card on screen reads the plan once. flushHomeReset sends any saved-later ops first and ends with the read.
  if (firstOnScreen) void flushHomeReset();
  return () => { listeners.delete(l); };
}
const server: HomeResetSnapshot = { load: "loading", server: [], ops: [], saveError: null, saving: false, hiddenDay: null, items: [] };

export function useHomeReset(): HomeResetSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => server);
}

export interface HomeResetView {
  snap: HomeResetSnapshot;
  active: HomeItem | null;
  offer: HomeItem | null;
  /** The plan is empty and Riley has not said "not now" today: show the starter picker. */
  starter: boolean;
  /** Anything to draw on Today. */
  show: boolean;
}

export function homeResetView(snap: HomeResetSnapshot, now: Date): HomeResetView {
  const ready = snap.load === "ready";
  const active = ready ? activeItem(snap.items, now) : null;
  const offer = ready && !active ? upkeepOffer(snap.items) : null;
  const starter = ready && snap.items.length === 0 && snap.hiddenDay !== easternDay(now);
  const paused = ready && snap.items.some((i) => i.upkeepPaused && i.lastDoneOn);
  const show = !!active || !!offer || starter || paused || (snap.ops.length > 0 && !!snap.saveError);
  return { snap, active, offer, starter, show };
}

export function useHomeResetToday(): HomeResetView {
  const snap = useHomeReset();
  return homeResetView(snap, new Date());
}
