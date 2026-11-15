"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cachedJson, clientCache } from "@/lib/client-cache";
import { kgToLb, lbToKg, sameJson } from "@/lib/format";
import { useLogDrafts } from "@/lib/log-drafts";
import { DraftMark, LogCard, LogSaveButton, SectionSkeleton } from "./ui";

/**
 * /log Weight. Shows the day's weight with its source (Tanita scale rollup or a manual entry) and takes one pounds
 * entry through POST /api/weight {log_date, weight_kg}, the same route and rules as the /nutrition quick-log:
 * one row per ET calendar day, no day after today, 0 to 1000 lb, and saving a day that already has a row replaces
 * it (a manual entry then owns that day, so the scale rollup stops touching it). Reads GET /api/weight?days=365
 * through the client cache: a year, so the last weigh-in still shows after a long gap (the table holds at most one
 * row per day). A Say it draft (WeightLogDraft) fills the form as a suggestion; nothing is written until Save.
 */

const WEIGHT_URL = "/api/weight?days=365";

interface WeightRow {
  log_date: string;
  weight_kg: number;
  notes: string | null;
  logged_at: string;
  source: "manual" | "tanita";
}
type WeightAnswer = { days: number; rows: WeightRow[] };

function asWeight(raw: unknown): WeightAnswer | null {
  const v = raw as WeightAnswer | undefined;
  return v && Array.isArray(v.rows) ? v : null;
}
function checkWeight(raw: unknown) {
  if (!asWeight(raw)) throw new Error("unexpected weight answer");
}

/** ET calendar today (the POST's own default for log_date). */
function etToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}
function shortDate(ymd: string): string {
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
}
const fmtLb = (kg: number) => `${(kgToLb(Number(kg)) ?? 0).toFixed(1)} lb`;
const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

function SourceTag({ source }: { source: WeightRow["source"] }) {
  return (
    <span className="font-mono text-[10px] uppercase tracking-wider text-text-tertiary border border-border-subtle rounded px-1.5 py-0.5">
      {source === "tanita" ? "Tanita" : "Manual"}
    </span>
  );
}

type Msg = { kind: "ok" | "err"; text: string } | null;

export default function WeightSection() {
  const [data, setData] = useState<WeightAnswer | null>(() => asWeight(clientCache.peek(WEIGHT_URL)));
  const [loadFailed, setLoadFailed] = useState(false);
  const [today, setToday] = useState(etToday);
  const [input, setInput] = useState("");
  const [date, setDate] = useState(today);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const alive = useRef(true);

  // Draft (Say it): fields filled from it, fields Riley changed since load.
  const { draft, clear } = useLogDrafts("weight");
  const [fromDraft, setFromDraft] = useState<{ id: number; lb: boolean; date: boolean } | null>(null);
  const touched = useRef({ lb: false, date: false });
  const seenDraft = useRef<number | null>(null);

  const show = useCallback((raw: unknown) => {
    const v = asWeight(raw);
    if (v && alive.current) setData((prev) => (sameJson(prev, v) ? prev : v));
  }, []);

  const load = useCallback(() => {
    setLoadFailed(false);
    cachedJson(WEIGHT_URL, { check: checkWeight })
      .then(show)
      .catch(() => { if (alive.current) setLoadFailed(true); });
  }, [show]);

  useEffect(() => {
    alive.current = true;
    if (!clientCache.peek(WEIGHT_URL)) void clientCache.read(WEIGHT_URL).then(show).catch(() => {});
    // Another screen's save (e.g. /nutrition in the scroll) updates this one; a removal (write invalidation) keeps
    // the shown rows until the refetch answers.
    const unsub = clientCache.subscribe(WEIGHT_URL, (v) => { if (v !== undefined) show(v); });
    load();
    return () => { alive.current = false; unsub(); };
  }, [load, show]);

  // The ET day rolls over while the screen stays open: move an untouched date along with it.
  const todayRef = useRef(today);
  useEffect(() => {
    const t = setInterval(() => {
      const now = etToday();
      const prev = todayRef.current;
      if (prev === now) return;
      todayRef.current = now;
      setToday(now);
      if (!touched.current.date) setDate((d) => (d === prev ? now : d));
    }, 60_000);
    return () => clearInterval(t);
  }, []);

  const applyDraft = useCallback((force: boolean) => {
    if (!draft) return;
    const v = draft.value;
    const useLb = Number.isFinite(v.lb) && (force || !touched.current.lb);
    const useDate = (force || !touched.current.date) && !!v.date && isYmd(v.date);
    if (useLb) setInput(String(Math.round(v.lb * 10) / 10));
    if (useDate) setDate(v.date!);
    else if ((force || !touched.current.date) && !v.date) setDate(today);
    if (force) touched.current = { lb: false, date: false };
    setFromDraft({ id: draft.id, lb: useLb, date: useDate });
    setMsg(null);
  }, [draft, today]);

  // Each new draft once: fill what Riley has not changed.
  useEffect(() => {
    if (!draft || seenDraft.current === draft.id) return;
    seenDraft.current = draft.id;
    applyDraft(false);
  }, [draft, applyDraft]);

  // Draft gone (cleared elsewhere or a newer one replaced it): the marks go.
  useEffect(() => {
    // Functional: runs after a new draft's own setFromDraft in the same commit and keeps it.
    setFromDraft((f) => (f && (!draft || draft.id !== f.id) ? null : f));
  }, [draft]);

  const dismissDraft = () => {
    if (fromDraft?.lb && !touched.current.lb) setInput("");
    if (fromDraft?.date && !touched.current.date) setDate(today);
    setFromDraft(null);
    clear(draft?.id);
  };

  const rows = data?.rows ?? [];
  const todayRow = rows.find((r) => r.log_date === today) ?? null;
  const latest = rows.length ? rows[rows.length - 1] : null;
  const day = date || today;
  const existing = rows.find((r) => r.log_date === day) ?? null;
  const lbValue = parseFloat(input);
  const draftUnused = !!draft && (!fromDraft || fromDraft.id !== draft.id || (!fromDraft.lb && !fromDraft.date));

  async function save() {
    if (saving) return;
    const lb = parseFloat(input);
    if (!Number.isFinite(lb) || lb <= 0 || lb > 1000) {
      setMsg({ kind: "err", text: "Enter a weight in pounds between 0 and 1000." });
      return;
    }
    const now = etToday();
    if (!isYmd(day) || day > now) {
      setMsg({ kind: "err", text: "Pick today or an earlier day." });
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch("/api/weight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ log_date: day, weight_kg: lbToKg(lb) }),
      });
      const json = (await res.json().catch(() => ({}))) as Partial<WeightRow> & { error?: string };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      if (!alive.current) return;
      if (json.log_date && typeof json.weight_kg === "number") {
        const row = json as WeightRow;
        setData((prev) => {
          const kept = (prev?.rows ?? []).filter((r) => r.log_date !== row.log_date);
          const next = [...kept, row].sort((a, b) => (a.log_date < b.log_date ? -1 : a.log_date > b.log_date ? 1 : 0));
          return { days: prev?.days ?? 365, rows: next };
        });
      }
      setInput("");
      touched.current = { lb: false, date: false };
      setDate(now);
      todayRef.current = now;
      setToday(now);
      setFromDraft(null);
      if (draft) clear(draft.id);
      setMsg({ kind: "ok", text: `Saved ${lb.toFixed(1)} lb for ${day === now ? "today" : shortDate(day)}` });
      void cachedJson(WEIGHT_URL, { check: checkWeight }).then(show).catch(() => {});
    } catch (e) {
      if (alive.current) setMsg({ kind: "err", text: `Couldn't save the weight: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      if (alive.current) setSaving(false);
    }
  }

  if (!data && !loadFailed) return <SectionSkeleton section="weight" />;

  return (
    <LogCard title="Weight" id="log-section-weight">
      {data ? (
        todayRow ? (
          <div className="mb-3 flex items-baseline gap-2">
            <span className="text-[22px] font-mono tabular-nums text-text-primary">{fmtLb(todayRow.weight_kg)}</span>
            <span className="text-[12px] text-text-tertiary">today</span>
            <SourceTag source={todayRow.source} />
          </div>
        ) : (
          <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-[14px] text-text-secondary">Not logged today</span>
            {latest && (
              <span className="flex items-baseline gap-2 text-[12px] text-text-tertiary">
                <span className="font-mono tabular-nums">Last {fmtLb(latest.weight_kg)} · {shortDate(latest.log_date)}</span>
                <SourceTag source={latest.source} />
              </span>
            )}
          </div>
        )
      ) : (
        <div className="mb-3 flex items-center gap-3">
          <p className="text-[13px] text-down">Couldn&apos;t load weight.</p>
          <button type="button" onClick={load} className="min-h-11 px-3 text-[13px] text-text-secondary hover:text-text-primary underline underline-offset-2">
            Retry
          </button>
        </div>
      )}

      {draftUnused && draft && (
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
          <DraftMark />
          <span className="font-mono text-text-secondary">
            {Number.isFinite(draft.value.lb) ? `${draft.value.lb} lb` : ""}
            {draft.value.date ? ` · ${shortDate(draft.value.date)}` : ""}
          </span>
          <button type="button" onClick={() => applyDraft(true)} className="min-h-11 px-1 text-accent underline underline-offset-2">Use</button>
          <button type="button" onClick={dismissDraft} className="min-h-11 px-1 text-text-tertiary hover:text-text-primary underline underline-offset-2">Dismiss</button>
        </div>
      )}

      <form
        noValidate
        onSubmit={(e) => { e.preventDefault(); void save(); }}
        className="flex items-center gap-2"
      >
        <label className="sr-only" htmlFor="log-weight-lb">Weight in pounds</label>
        <input
          id="log-weight-lb"
          type="number"
          step="0.1"
          min="0"
          inputMode="decimal"
          enterKeyHint="done"
          value={input}
          onChange={(e) => {
            touched.current.lb = true;
            setInput(e.target.value);
            setMsg(null);
            if (fromDraft?.lb) setFromDraft({ ...fromDraft, lb: false });
          }}
          placeholder={latest ? (kgToLb(Number(latest.weight_kg)) ?? 0).toFixed(1) : "lb"}
          disabled={saving}
          className="min-w-0 flex-1 min-h-11 px-3 text-[16px] font-mono tabular-nums bg-surface-sunken border border-border-subtle rounded-control text-text-primary placeholder:text-text-tertiary/60 focus:border-accent/60 outline-none disabled:opacity-40"
        />
        <span className="text-[13px] font-mono text-text-tertiary">lb</span>
        <LogSaveButton onClick={() => void save()} disabled={!input.trim()} saving={saving} />
      </form>

      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <label htmlFor="log-weight-day" className="text-[12px] text-text-tertiary">Day</label>
        <input
          id="log-weight-day"
          type="date"
          value={date}
          max={today}
          onChange={(e) => {
            touched.current.date = true;
            setDate(e.target.value || today);
            setMsg(null);
            if (fromDraft?.date) setFromDraft({ ...fromDraft, date: false });
          }}
          disabled={saving}
          className="min-h-11 px-2 text-[16px] font-mono bg-surface-sunken border border-border-subtle rounded-control text-text-primary focus:border-accent/60 outline-none disabled:opacity-40"
        />
        {day !== today && (
          <button
            type="button"
            onClick={() => { touched.current.date = false; setDate(today); }}
            className="min-h-11 px-1 text-[12px] text-text-tertiary hover:text-text-primary underline underline-offset-2"
          >
            Today
          </button>
        )}
        {fromDraft && (fromDraft.lb || fromDraft.date) && (
          <span className="flex items-center gap-2">
            <DraftMark />
            <button type="button" onClick={dismissDraft} className="min-h-11 px-1 text-[12px] text-text-tertiary hover:text-text-primary underline underline-offset-2">
              Dismiss
            </button>
          </span>
        )}
      </div>

      {input.trim() && Number.isFinite(lbValue) && lbValue > 0 && (
        <p className="mt-1 text-[12px] font-mono text-text-tertiary">= {lbToKg(lbValue).toFixed(2)} kg</p>
      )}
      {existing && input.trim() && (
        <p className="mt-1 text-[12px] text-text-secondary">
          Replaces {existing.source === "tanita" ? "the Tanita reading" : "the entry"} ({fmtLb(existing.weight_kg)}) for {day === today ? "today" : shortDate(day)}.
        </p>
      )}
      {msg && (
        <p role={msg.kind === "err" ? "alert" : "status"} className={`mt-2 text-[13px] ${msg.kind === "ok" ? "text-up" : "text-down"}`}>
          {msg.text}
        </p>
      )}
    </LogCard>
  );
}
