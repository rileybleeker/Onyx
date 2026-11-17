"use client";

import { useEffect, useRef, useState } from "react";
import { Check, TriangleAlert, LoaderCircle, Play } from "lucide-react";
import { KINDLE_RUN_URL, runView, type RunRequest, type RunView } from "@/lib/kindle-run";

// "Run now" on the /status Kindle card (2026-11-16). The press writes one request row; Supabase
// Realtime pushes it to the idle listener on the collector PC, which starts the scheduled harvest task and
// writes back. This component only reads that row while it waits (every 2 s until the PC answers,
// then every 5 s until the run ends). It never writes on mount or on scroll: only the tap does.

const TONE: Record<RunView["tone"], string> = {
  neutral: "text-text-secondary",
  ok: "text-up",
  warn: "text-mid",
  error: "text-down",
};

export default function KindleRunNow({ onDone }: { onDone?: () => void }) {
  const [view, setView] = useState<RunView | null>(null);
  const [busy, setBusy] = useState(false);
  const pressedAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  function show(row: RunRequest | null) {
    const v = runView(row, Date.now() - pressedAt.current);
    setView(v);
    if (v.final) {
      setBusy(false);
      if (v.phase === "done") onDone?.();
      return;
    }
    if (row) timer.current = setTimeout(() => void poll(row.id), row.picked_up_at ? 5000 : 2000);
  }

  async function poll(id: string) {
    if (!alive.current) return;
    let row: RunRequest | null = null;
    try {
      const res = await fetch(`${KINDLE_RUN_URL}?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      if (res.ok) row = ((await res.json()) as { request: RunRequest }).request;
    } catch {
      // Offline for a moment: keep the last state and ask again.
    }
    if (!alive.current) return;
    show(row ?? { id, requested_at: new Date(pressedAt.current).toISOString(), picked_up_at: null, outcome: null, finished_at: null, exit_code: null, detail: null });
  }

  async function press() {
    if (busy) return;
    if (timer.current) clearTimeout(timer.current);
    setBusy(true);
    pressedAt.current = Date.now();
    setView(runView(null, 0));
    try {
      const res = await fetch(KINDLE_RUN_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const body = (await res.json().catch(() => ({}))) as { request?: RunRequest; error?: string };
      if (!alive.current) return;
      if (!res.ok || !body.request) {
        setBusy(false);
        setView({ phase: "failed", tone: "error", final: true, text: "Couldn't ask the PC. Try again." });
        return;
      }
      show(body.request);
    } catch {
      if (!alive.current) return;
      setBusy(false);
      setView({ phase: "failed", tone: "error", final: true, text: "Couldn't reach Onyx. Check the connection and try again." });
    }
  }

  const Icon = !view ? null : view.phase === "done" ? Check : view.final ? TriangleAlert : LoaderCircle;

  return (
    <div className="mt-3 flex flex-col gap-2" data-testid="kindle-run-now">
      <button
        type="button"
        onClick={press}
        disabled={busy}
        className="self-start inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] font-medium bg-white/5 text-text-primary border border-border-subtle rounded-control hover:bg-white/10 transition-colors disabled:opacity-50"
      >
        <Play size={13} aria-hidden="true" />
        {busy ? "Running…" : view?.final ? "Run again" : "Run now"}
      </button>
      {view && Icon && (
        <p className={`flex items-start gap-1.5 text-[12px] ${TONE[view.tone]}`} role="status" aria-live="polite">
          <Icon size={13} aria-hidden="true" className={`mt-0.5 shrink-0 ${view.final ? "" : "animate-spin"}`} />
          <span>{view.text}</span>
        </p>
      )}
    </div>
  );
}
