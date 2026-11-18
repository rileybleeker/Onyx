"use client";

import { useEffect, useRef, useState } from "react";
import { AutosaveStatus } from "@/components/AutosaveStatus";
import { messageOf, saveRequest } from "@/lib/autosave";
import { useAutosave } from "@/lib/use-autosave";

/**
 * Editable intake row. Mirror of the SourceIntake shape used by /supplements,
 * kept loose so this component is reusable from any caller.
 */
export interface EditableIntake {
  intake_id: number;
  intake_date: string;
  intake_time: string | null;
  doses: number;
  notes: string | null;
  brand_name: string | null;
  full_name: string | null;
}

interface Props {
  intake: EditableIntake | null;
  onClose: () => void;
  /** Called on close when at least one change was saved (the caller re-reads the day). */
  onSaved: () => void;
}

/**
 * Convert an ISO timestamp (e.g. "2026-05-19T02:53:14.538+00:00") into a
 * string accepted by <input type="datetime-local"> ("YYYY-MM-DDTHH:MM"),
 * rendered in the user's local timezone. Returns "" for null inputs so the
 * field shows up as empty rather than "Invalid Date".
 */
function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Reverse: datetime-local string → ISO. Empty input → null (clear the time). */
function localInputToIso(input: string): string | null {
  if (!input) return null;
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The form as typed. Saved through PATCH /api/supplements/log-intake. */
type IntakeForm = { intake_id: number; doses: string; intake_date: string; intake_time: string; notes: string };

function notReady(f: IntakeForm): string | null {
  const n = Number(f.doses);
  if (f.doses.trim() === "" || !Number.isFinite(n) || n < 0) return "Doses must be 0 or higher.";
  if (!f.intake_date) return "Pick a date.";
  return null;
}

const formOf = (i: EditableIntake): IntakeForm => ({
  intake_id: i.intake_id,
  doses: String(i.doses),
  intake_date: i.intake_date,
  intake_time: isoToLocalInput(i.intake_time),
  notes: i.notes ?? "",
});

/**
 * Edits autosave (Riley 2026-11-15, lib/autosave.ts): each change is sent on its own after a short pause and when a
 * typed field is left, through the same PATCH as before. Done (or a tap outside) sends what is still waiting and
 * closes; a failed save keeps the editor open with its message. Delete is unchanged.
 */
export default function EditIntakeModal({ intake, onClose, onSaved }: Props) {
  const [form, setForm] = useState<IntakeForm | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savedAny = useRef(false);

  const autosave = useAutosave<IntakeForm>("edit-intake", {
    delayMs: 1000,
    ready: notReady,
    // The intake route's own validation sentences (e.g. "doses must be a non-negative number") are shown as the reason.
    describeError: messageOf,
    save: async (f, { keepalive }) => {
      await saveRequest("/api/supplements/log-intake", {
        method: "PATCH",
        keepalive,
        body: {
          intake_id: f.intake_id,
          doses: Number(f.doses),
          intake_date: f.intake_date,
          intake_time: localInputToIso(f.intake_time),
          notes: f.notes.trim() === "" ? null : f.notes.trim(),
        },
      });
      savedAny.current = true;
    },
  });
  const { reset: resetAutosave } = autosave;

  useEffect(() => {
    if (!intake) {
      setForm(null);
      return;
    }
    const f = formOf(intake);
    setForm(f);
    resetAutosave(f);
    savedAny.current = false;
    setError(null);
  }, [intake, resetAutosave]);

  if (!intake || !form) return null;

  const edit = (patch: Partial<IntakeForm>) => {
    const next = { ...form, ...patch };
    setForm(next);
    autosave.change(next);
  };

  async function done() {
    if (form && notReady(form)) return; // the status line says why; nothing is lost by staying open
    if (!(await autosave.flush())) return; // not saved: the status line has Retry
    if (savedAny.current) onSaved();
    else onClose();
  }

  async function remove() {
    if (!intake) return;
    if (!confirm("Delete this intake entry? This can't be undone from the UI.")) return;
    autosave.reset();
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/supplements/log-intake?intake_id=${intake.intake_id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("delete failed");
      onSaved();
    } catch {
      setError("Couldn't delete this entry. Try again.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto"
      onClick={() => void done()}
    >
      <div
        className="bg-surface-card border border-border-subtle rounded-card shadow-card p-5 w-full max-w-md mt-12"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[14px] font-medium text-text-primary">Edit intake</h2>
          <button
            onClick={() => void done()}
            disabled={deleting}
            className="text-[11px] text-text-tertiary hover:text-text-secondary font-mono disabled:opacity-40"
          >
            Close
          </button>
        </div>
        <p className="text-[12px] text-text-primary mb-0.5">{intake.full_name ?? "—"}</p>
        <p className="text-[11px] text-text-tertiary font-mono mb-4">{intake.brand_name ?? "—"}</p>

        <label className="block text-[10px] font-mono uppercase tracking-wide text-text-tertiary mb-1">
          Doses
        </label>
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step="0.5"
          value={form.doses}
          onChange={(e) => edit({ doses: e.target.value })}
          onBlur={() => void autosave.flush()}
          disabled={deleting}
          className="w-full mb-3 px-3 py-2 text-[14px] bg-black/40 border border-border-subtle rounded-control text-text-primary focus:border-accent/50 outline-none disabled:opacity-50"
        />

        <label className="block text-[10px] font-mono uppercase tracking-wide text-text-tertiary mb-1">
          Date
        </label>
        <input
          type="date"
          value={form.intake_date}
          onChange={(e) => edit({ intake_date: e.target.value })}
          disabled={deleting}
          className="w-full mb-3 px-3 py-2 text-[13px] font-mono bg-black/40 border border-border-subtle rounded-control text-text-primary focus:border-accent/50 outline-none disabled:opacity-50"
        />

        <label className="block text-[10px] font-mono uppercase tracking-wide text-text-tertiary mb-1">
          Time (optional)
        </label>
        <div className="flex gap-2 mb-3">
          <input
            type="datetime-local"
            value={form.intake_time}
            onChange={(e) => edit({ intake_time: e.target.value })}
            disabled={deleting}
            className="flex-1 px-3 py-2 text-[13px] font-mono bg-black/40 border border-border-subtle rounded-control text-text-primary focus:border-accent/50 outline-none disabled:opacity-50"
          />
          {form.intake_time && (
            <button
              onClick={() => edit({ intake_time: "" })}
              disabled={deleting}
              className="px-2 text-[11px] font-mono text-text-tertiary hover:text-text-secondary disabled:opacity-40"
              title="Clear time"
            >
              clear
            </button>
          )}
        </div>

        <label className="block text-[10px] font-mono uppercase tracking-wide text-text-tertiary mb-1">
          Notes
        </label>
        <textarea
          value={form.notes}
          onChange={(e) => edit({ notes: e.target.value })}
          onBlur={() => void autosave.flush()}
          disabled={deleting}
          rows={2}
          placeholder="e.g. took with food, half-dose, etc."
          className="w-full mb-3 px-3 py-2 text-[13px] bg-black/40 border border-border-subtle rounded-control text-text-primary focus:border-accent/50 outline-none resize-none disabled:opacity-50"
        />

        {error && (
          <p className="text-[11px] font-mono text-red-400 mb-3 break-words">{error}</p>
        )}

        <div className="flex items-center justify-between gap-2">
          <button
            onClick={remove}
            disabled={deleting}
            className="px-3 py-2 text-[12px] text-red-400/80 hover:text-red-400 disabled:opacity-40 transition-colors"
          >
            Delete
          </button>
          <div className="flex items-center gap-3">
            <AutosaveStatus state={autosave.state} onRetry={() => void autosave.retry()} showIncomplete />
            <button
              onClick={() => void done()}
              disabled={deleting}
              className="px-4 py-2 text-[12px] font-medium text-on-accent font-semibold bg-accent hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed border border-accent rounded-full transition-colors"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
