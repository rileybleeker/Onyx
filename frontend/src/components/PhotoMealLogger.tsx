"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, Plus, X } from "lucide-react";
import InfoHint from "@/components/InfoHint";
import { getDeliveryItemsForDays, type DeliveryDish } from "@/lib/queries";
import { formatClock } from "@/lib/delivery-leftovers";
import {
  MAX_IMAGE_BASE64,
  behavioralDate,
  exifCaptureTime,
  localClock,
  mealTotals,
  nearbyDeliveries,
  parsePhotoMealBody,
  type Confidence,
  type PhotoMealItem,
  type TimeSource,
} from "@/lib/photo-meal";

// Food by photo: take or pick a plate photo -> Claude estimates the foods (POST /api/nutrition/photo-meals/estimate)
// -> Riley checks and edits names, amounts, kcal and macros and the time -> Save (POST /api/nutrition/photo-meals).
// Nothing is saved before Save. The photo is downscaled in the browser (long edge <= 1568 px, the most the
// model uses) and never stored. The meal time comes from the photo's EXIF capture time when the file has one,
// else the moment it was picked; both can be changed.

type Row = { key: number; name: string; portion: string; kcal: string; protein_g: string; carbs_g: string; fat_g: string };
type Phase = "idle" | "estimating" | "review" | "saving";

let rowSeq = 0;
const blankRow = (): Row => ({ key: ++rowSeq, name: "", portion: "", kcal: "", protein_g: "", carbs_g: "", fat_g: "" });
const toRow = (i: PhotoMealItem): Row => ({
  key: ++rowSeq,
  name: i.name,
  portion: i.portion ?? "",
  kcal: String(i.kcal),
  protein_g: String(i.protein_g),
  carbs_g: String(i.carbs_g),
  fat_g: String(i.fat_g),
});
/** An input's number: empty = 0, anything unreadable = NaN (the save validator names the food). */
const numOf = (s: string) => (s.trim() === "" ? 0 : Number(s));

function newKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function decode(file: File): Promise<{ src: CanvasImageSource; w: number; h: number; done: () => void }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bm = await createImageBitmap(file);
      return { src: bm, w: bm.width, h: bm.height, done: () => bm.close() };
    } catch {
      // fall through to <img> (some formats decode only there)
    }
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("decode"));
      img.src = url;
    });
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  return { src: img, w: img.naturalWidth, h: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
}

/** The photo as a JPEG, base64 without the data: prefix, small enough for the estimate route. */
async function toJpegBase64(file: File): Promise<string> {
  const pic = await decode(file);
  try {
    for (const [edge, quality] of [[1568, 0.85], [1280, 0.75], [1024, 0.7]] as const) {
      const scale = Math.min(1, edge / Math.max(pic.w, pic.h));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(pic.w * scale));
      canvas.height = Math.max(1, Math.round(pic.h * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no canvas");
      ctx.drawImage(pic.src, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL("image/jpeg", quality);
      const b64 = url.slice(url.indexOf(",") + 1);
      if (b64.length <= MAX_IMAGE_BASE64) return b64;
    }
    throw new Error("photo too large");
  } finally {
    pic.done();
  }
}

const inputCls =
  "min-h-11 px-2 text-[16px] md:text-[13px] bg-black/30 border border-border-subtle rounded-control text-text-primary focus:border-accent/40 outline-none disabled:opacity-40";

export default function PhotoMealLogger({
  onSaved,
  first = false,
}: {
  /** After a meal is saved (refresh the meals list and the macro charts). */
  onSaved: (meal: { meal_id: number; eaten_date: string; kcal: number }) => void;
  /** Opened from Log > Meal photo (/nutrition?log=photo): scroll here on load. */
  first?: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [preview, setPreview] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [confidence, setConfidence] = useState<Confidence | null>(null);
  const [estKcal, setEstKcal] = useState<number | null>(null);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [timeSource, setTimeSource] = useState<TimeSource>("now");
  const [clientKey, setClientKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dishes, setDishes] = useState<DeliveryDish[]>([]);

  useEffect(() => {
    if (first) boxRef.current?.scrollIntoView({ block: "start" });
  }, [first]);
  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  const day = date && time ? behavioralDate(date, time) : "";
  // Uber Eats dishes of that day, to warn before a delivered meal is photographed into the day twice.
  useEffect(() => {
    if (phase !== "review" || !day) return;
    let alive = true;
    getDeliveryItemsForDays([day])
      .then((d) => { if (alive) setDishes(d); })
      .catch(() => { if (alive) setDishes([]); });
    return () => { alive = false; };
  }, [phase, day]);
  const nearby = useMemo(
    () => (date && time ? nearbyDeliveries(dishes, new Date(`${date}T${time}:00`).getTime()) : []),
    [dishes, date, time],
  );

  const items = rows.map((r) => ({
    name: r.name,
    portion: r.portion || null,
    kcal: numOf(r.kcal),
    protein_g: numOf(r.protein_g),
    carbs_g: numOf(r.carbs_g),
    fat_g: numOf(r.fat_g),
  }));
  const totals = mealTotals(items.map((i) => ({
    kcal: Number.isFinite(i.kcal) ? i.kcal : 0,
    protein_g: Number.isFinite(i.protein_g) ? i.protein_g : 0,
    carbs_g: Number.isFinite(i.carbs_g) ? i.carbs_g : 0,
    fat_g: Number.isFinite(i.fat_g) ? i.fat_g : 0,
  })));

  function reset() {
    setPhase("idle");
    setPreview(null);
    setRows([]);
    setConfidence(null);
    setEstKcal(null);
    setDishes([]);
    imageRef.current = null;
  }

  async function estimate() {
    const image = imageRef.current;
    if (!image) return;
    setPhase("estimating");
    setError(null);
    try {
      const res = await fetch("/api/nutrition/photo-meals/estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_base64: image, media_type: "image/jpeg" }),
      });
      if (!res.ok) {
        setError("Couldn't estimate this photo. Try again.");
        setPhase("idle");
        return;
      }
      const j = (await res.json()) as { is_food: boolean; items: PhotoMealItem[]; confidence: Confidence; totals: { kcal: number } };
      if (!j.is_food || j.items.length === 0) {
        setError("No food found in the photo. Add the foods by hand or try another photo.");
        setRows([blankRow()]);
        setConfidence(null);
        setEstKcal(null);
      } else {
        setRows(j.items.map(toRow));
        setConfidence(j.confidence);
        setEstKcal(j.totals.kcal);
      }
      setPhase("review");
    } catch {
      setError("Network error: the photo was not estimated.");
      setPhase("idle");
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // the same photo can be picked again
    if (!file) return;
    setError(null);
    setNotice(null);
    let exif: { date: string; time: string } | null = null;
    try {
      exif = exifCaptureTime(new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer()));
    } catch {
      exif = null;
    }
    const when = exif ?? localClock(new Date());
    setDate(when.date);
    setTime(when.time);
    setTimeSource(exif ? "photo" : "now");
    setClientKey(newKey());
    setPreview(URL.createObjectURL(file));
    setPhase("estimating");
    try {
      imageRef.current = await toJpegBase64(file);
    } catch {
      setError("Couldn't read this photo. Try a JPEG or PNG.");
      reset();
      return;
    }
    await estimate();
  }

  function byHand() {
    setError(null);
    setNotice(null);
    const now = localClock(new Date());
    setDate(now.date);
    setTime(now.time);
    setTimeSource("now");
    setClientKey(newKey());
    setRows([blankRow()]);
    setConfidence(null);
    setEstKcal(null);
    setPhase("review");
  }

  async function save() {
    const parsed = parsePhotoMealBody({
      client_key: clientKey,
      eaten_date: day,
      eaten_time: time,
      time_source: timeSource,
      items: items.filter((i) => i.name.trim() !== "" || i.kcal !== 0),
      est_kcal: estKcal,
      confidence,
    });
    if (!parsed.ok) {
      setError(parsed.error.charAt(0).toUpperCase() + parsed.error.slice(1) + ".");
      return;
    }
    setPhase("saving");
    setError(null);
    try {
      const res = await fetch("/api/nutrition/photo-meals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.value),
      });
      if (!res.ok) {
        setError("Couldn't save the meal. Try again.");
        setPhase("review");
        return;
      }
      const meal = (await res.json()) as { meal_id: number; eaten_date: string; kcal: number };
      setNotice(`Saved · ${Math.round(meal.kcal)} kcal`);
      reset();
      onSaved(meal);
    } catch {
      setError("Network error: the meal was not saved.");
      setPhase("review");
    }
  }

  const setRow = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const busy = phase === "estimating" || phase === "saving";

  return (
    <div ref={boxRef} id="log-photo" className="scroll-mt-24 bg-surface-card border border-border-subtle rounded-control p-4 mb-4">
      <div className="flex items-center gap-2 mb-3">
        <h3 className="text-[13px] font-medium text-text-primary">Log a meal by photo</h3>
        <InfoHint label="Meal photos">
          Claude estimates each food with kcal and macros from the photo. Check and fix the list before saving: nothing is saved
          until you tap Save, and the photo is not kept. The time comes from the photo when it carries one, else the moment you
          picked it. On days with a Cronometer log only Cronometer counts; on other days photo meals add to the Uber Eats
          estimate, so skip photos of delivered meals.
        </InfoHint>
      </div>

      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFile} aria-label="Meal photo" />

      {phase === "idle" && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-2 px-4 min-h-11 text-[13px] text-on-accent font-semibold bg-accent hover:bg-accent/90 border border-accent rounded-full transition-colors"
          >
            <Camera className="w-4 h-4" strokeWidth={1.75} />
            Take or choose photo
          </button>
          <button onClick={byHand} className="px-3 min-h-11 text-[12px] text-text-tertiary hover:text-text-primary underline underline-offset-2">
            Enter by hand
          </button>
          {imageRef.current && (
            <button onClick={estimate} className="px-3 min-h-11 text-[12px] text-text-tertiary hover:text-text-primary underline underline-offset-2">
              Try again
            </button>
          )}
        </div>
      )}

      {phase === "estimating" && (
        <div className="flex items-center gap-3">
          {preview && <img src={preview} alt="Selected meal photo, ready to log" className="w-16 h-16 object-cover rounded-control border border-border-subtle" />}
          <p className="text-[12px] font-mono text-text-tertiary" role="status">Estimating…</p>
        </div>
      )}

      {(phase === "review" || phase === "saving") && (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            {preview && <img src={preview} alt="Selected meal photo, ready to log" className="w-16 h-16 object-cover rounded-control border border-border-subtle" />}
            <div className="text-[12px] text-text-tertiary">
              <div className="text-[15px] font-mono text-text-primary">{totals.kcal} kcal</div>
              <div className="font-mono">
                P {totals.protein_g} g · C {totals.carbs_g} g · F {totals.fat_g} g
              </div>
              {confidence && <div>Estimate · {confidence} confidence</div>}
            </div>
          </div>

          <div className="divide-y divide-border-subtle border border-border-subtle rounded-control">
            {rows.map((r) => (
              <div key={r.key} className="p-2.5 space-y-2">
                <div className="flex items-center gap-2">
                  <input
                    value={r.name}
                    onChange={(e) => setRow(r.key, { name: e.target.value })}
                    placeholder="Food"
                    aria-label="Food name"
                    disabled={busy}
                    className={`${inputCls} flex-1 min-w-0`}
                  />
                  <button
                    onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                    disabled={busy}
                    aria-label={`Remove ${r.name || "food"}`}
                    className="w-11 h-11 shrink-0 flex items-center justify-center text-text-tertiary hover:text-text-primary disabled:opacity-40"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="grid grid-cols-4 sm:grid-cols-5 gap-1.5 items-end">
                  <input
                    value={r.portion}
                    onChange={(e) => setRow(r.key, { portion: e.target.value })}
                    placeholder="Amount"
                    aria-label="Amount"
                    disabled={busy}
                    className={`${inputCls} col-span-4 sm:col-span-1`}
                  />
                  {(
                    [
                      ["kcal", "kcal"],
                      ["protein_g", "P g"],
                      ["carbs_g", "C g"],
                      ["fat_g", "F g"],
                    ] as const
                  ).map(([k, label]) => (
                    <label key={k} className="flex flex-col text-[10px] font-mono uppercase text-text-tertiary">
                      {label}
                      <input
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step="any"
                        value={r[k]}
                        onChange={(e) => setRow(r.key, { [k]: e.target.value } as Partial<Row>)}
                        disabled={busy}
                        className={`${inputCls} w-full font-mono normal-case`}
                      />
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <button
            onClick={() => setRows((rs) => [...rs, blankRow()])}
            disabled={busy}
            className="flex items-center gap-1.5 min-h-11 text-[12px] text-text-tertiary hover:text-text-primary disabled:opacity-40"
          >
            <Plus className="w-4 h-4" /> Add food
          </button>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide text-text-tertiary font-mono">When</span>
            <input
              type="date"
              value={date}
              onChange={(e) => { setDate(e.target.value); setTimeSource("manual"); }}
              disabled={busy}
              aria-label="Date eaten"
              className={`${inputCls} font-mono`}
            />
            <input
              type="time"
              value={time}
              onChange={(e) => { setTime(e.target.value); setTimeSource("manual"); }}
              disabled={busy}
              aria-label="Time eaten"
              className={`${inputCls} font-mono`}
            />
            <span className="text-[10px] font-mono text-text-tertiary">
              {timeSource === "photo" ? "from photo" : timeSource === "now" ? "now" : ""}
            </span>
            {day && day !== date && time && (
              <span className="text-[10px] font-mono text-text-tertiary">counts toward {day} (before 6 AM)</span>
            )}
          </div>

          {nearby.length > 0 && (
            <p className="text-[12px] text-amber-400/90">
              Already counted from Uber Eats:{" "}
              {nearby
                .map((n) => `${n.store_name} at ${formatClock(localClock(new Date(n.completed_at)).time)}`)
                .join(", ")}
              . Save only if this is a different meal.
            </p>
          )}

          <div className="flex gap-2">
            <button
              onClick={save}
              disabled={busy || rows.length === 0}
              className="flex-1 px-4 py-3 text-[13px] text-on-accent font-semibold bg-accent hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed border border-accent rounded-full transition-colors"
            >
              {phase === "saving" ? "Saving…" : "Save meal"}
            </button>
            <button
              onClick={() => { setError(null); reset(); }}
              disabled={busy}
              className="px-4 py-3 text-[13px] text-text-secondary border border-border-subtle rounded-full hover:border-border-hover disabled:opacity-40"
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-[12px] text-red-400 mt-2" role="alert">{error}</p>}
      {notice && phase === "idle" && <p className="text-[12px] text-green-400 mt-2" role="status">{notice}</p>}
    </div>
  );
}
