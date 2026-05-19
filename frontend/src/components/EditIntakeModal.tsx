"use client";

import { useEffect, useState } from "react";

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

export default function EditIntakeModal({ intake, onClose, onSaved }: Props) {
  const [doses, setDoses] = useState("1");
  const [intakeDate, setIntakeDate] = useState("");
  const [intakeTime, setIntakeTime] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!intake) return;
    setDoses(String(intake.doses));
    setIntakeDate(intake.intake_date);
    setIntakeTime(isoToLocalInput(intake.intake_time));
    setNotes(intake.notes ?? "");
    setError(null);
  }, [intake]);

  if (!intake) return null;

  async function save() {
    if (!intake) return;
    const dosesNum = Number(doses);
    if (!Number.isFinite(dosesNum) || dosesNum < 0) {
      setError("Doses must be 0 or higher.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/supplements/log-intake", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intake_id: intake.intake_id,
          doses: dosesNum,
          intake_date: intakeDate,
          intake_time: localInputToIso(intakeTime),
          notes: notes.trim() === "" ? null : notes.trim(),
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

  async function remove() {
    if (!intake) return;
    if (!confirm("Delete this intake entry? This can't be undone from the UI.")) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/supplements/log-intake?intake_id=${intake.intake_id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(await res.text());
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-surface-card border border-border-subtle rounded-[6px] shadow-card p-5 w-full max-w-md mt-12"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[14px] font-medium text-text-primary">Edit intake</h2>
          <button
            onClick={onClose}
            disabled={saving}
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
          value={doses}
          onChange={(e) => setDoses(e.target.value)}
          disabled={saving}
          className="w-full mb-3 px-3 py-2 text-[14px] bg-black/40 border border-border-subtle rounded-[4px] text-text-primary focus:border-[#1DB954]/50 outline-none disabled:opacity-50"
        />

        <label className="block text-[10px] font-mono uppercase tracking-wide text-text-tertiary mb-1">
          Date
        </label>
        <input
          type="date"
          value={intakeDate}
          onChange={(e) => setIntakeDate(e.target.value)}
          disabled={saving}
          className="w-full mb-3 px-3 py-2 text-[13px] font-mono bg-black/40 border border-border-subtle rounded-[4px] text-text-primary focus:border-[#1DB954]/50 outline-none disabled:opacity-50"
        />

        <label className="block text-[10px] font-mono uppercase tracking-wide text-text-tertiary mb-1">
          Time (optional)
        </label>
        <div className="flex gap-2 mb-3">
          <input
            type="datetime-local"
            value={intakeTime}
            onChange={(e) => setIntakeTime(e.target.value)}
            disabled={saving}
            className="flex-1 px-3 py-2 text-[13px] font-mono bg-black/40 border border-border-subtle rounded-[4px] text-text-primary focus:border-[#1DB954]/50 outline-none disabled:opacity-50"
          />
          {intakeTime && (
            <button
              onClick={() => setIntakeTime("")}
              disabled={saving}
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
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          disabled={saving}
          rows={2}
          placeholder="e.g. took with food, half-dose, etc."
          className="w-full mb-3 px-3 py-2 text-[13px] bg-black/40 border border-border-subtle rounded-[4px] text-text-primary focus:border-[#1DB954]/50 outline-none resize-none disabled:opacity-50"
        />

        {error && (
          <p className="text-[11px] font-mono text-red-400 mb-3 break-words">{error}</p>
        )}

        <div className="flex justify-between gap-2">
          <button
            onClick={remove}
            disabled={saving}
            className="px-3 py-2 text-[12px] text-red-400/80 hover:text-red-400 disabled:opacity-40 transition-colors"
          >
            Delete
          </button>
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
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
