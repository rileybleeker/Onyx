// Food by photo (pds.photo_meals, sql/photo_meals.sql, 2026-11-14). Riley photographs a plate, Claude
// estimates the foods with kcal and macros, Riley confirms or edits the list, and the meal is saved with
// the time it was eaten (the photo's capture time when the file carries one). Nothing is saved before the
// confirm tap, and the photo itself is never stored.
//
// Pure helpers only: no Supabase, no React, no Node built-ins. The estimate and save routes, the browser
// logger (components/PhotoMealLogger.tsx), getNutrition and tests/photo-meal.test.cjs all import this file.

import { shiftYmd, type DeliveryEstimateDay } from "./delivery-portion";

/** Same model as Onyx Chat (api/chat/route.ts). */
export const PHOTO_MEAL_MODEL = "claude-sonnet-5-5";

export type Confidence = "high" | "medium" | "low";
export const CONFIDENCES: ReadonlyArray<Confidence> = ["high", "medium", "low"];

/** photo = the file's EXIF capture time, now = the moment the photo was picked, manual = Riley changed it. */
export type TimeSource = "photo" | "now" | "manual";
export const TIME_SOURCES: ReadonlyArray<TimeSource> = ["photo", "now", "manual"];

export interface PhotoMealItem {
  name: string;
  /** "1 cup", "about 150 g"; null when not given. */
  portion: string | null;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

export interface PhotoEstimate {
  is_food: boolean;
  items: PhotoMealItem[];
  confidence: Confidence;
}

export const MAX_ITEMS = 30;
export const MAX_ITEM_KCAL = 5000;
export const MAX_ITEM_GRAMS = 500;
export const MAX_NAME = 120;
export const MAX_PORTION = 80;
/** The browser sends a downscaled JPEG (long edge <= 1568 px, usually 150-600 KB). Vercel caps a body at 4.5 MB. */
export const MAX_IMAGE_BASE64 = 3_000_000;
export const MAX_ESTIMATE_BODY_BYTES = MAX_IMAGE_BASE64 + 200;
export const MAX_SAVE_BODY_BYTES = 16_384;

export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

/** PostgREST / Postgres codes for "that table or view does not exist" (sql/photo_meals.sql not applied yet). */
export const MISSING_RELATION_CODES: ReadonlyArray<string> = ["PGRST205", "42P01"];
export function isMissingRelation(code: string | null | undefined): boolean {
  return !!code && MISSING_RELATION_CODES.includes(code);
}

const roundG = (x: number) => Math.round(x * 10) / 10;

function clampNum(v: unknown, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, max);
}

function cleanText(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

// ─── The model's answer ──────────────────────────────────────────────────────

/**
 * Claude's structured answer -> what the review screen shows. Defensive even though the API enforces the
 * schema: numbers clamped to 0..max and rounded (kcal whole, grams to 0.1), unnamed items dropped, at most
 * MAX_ITEMS. Returns null when the answer is not an object with an items array.
 */
export function normalizeEstimate(raw: unknown): PhotoEstimate | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as { is_food?: unknown; items?: unknown; confidence?: unknown };
  if (!Array.isArray(r.items)) return null;
  const items: PhotoMealItem[] = [];
  for (const it of r.items) {
    if (items.length >= MAX_ITEMS) break;
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const name = cleanText(o.name, MAX_NAME);
    if (!name) continue;
    items.push({
      name,
      portion: cleanText(o.portion, MAX_PORTION) || null,
      kcal: Math.round(clampNum(o.kcal, MAX_ITEM_KCAL)),
      protein_g: roundG(clampNum(o.protein_g, MAX_ITEM_GRAMS)),
      carbs_g: roundG(clampNum(o.carbs_g, MAX_ITEM_GRAMS)),
      fat_g: roundG(clampNum(o.fat_g, MAX_ITEM_GRAMS)),
    });
  }
  const confidence = CONFIDENCES.includes(r.confidence as Confidence) ? (r.confidence as Confidence) : "low";
  const isFood = typeof r.is_food === "boolean" ? r.is_food : items.length > 0;
  return { is_food: isFood && items.length > 0, items: isFood ? items : [], confidence };
}

export interface MealTotals {
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

/** Meal total from its items (the save route stores this, never a total sent by the browser). */
export function mealTotals(items: ReadonlyArray<Pick<PhotoMealItem, "kcal" | "protein_g" | "carbs_g" | "fat_g">>): MealTotals {
  let kcal = 0, p = 0, c = 0, f = 0;
  for (const i of items) {
    kcal += Number(i.kcal) || 0;
    p += Number(i.protein_g) || 0;
    c += Number(i.carbs_g) || 0;
    f += Number(i.fat_g) || 0;
  }
  return { kcal: Math.round(kcal), protein_g: roundG(p), carbs_g: roundG(c), fat_g: roundG(f) };
}

// ─── Request bodies ──────────────────────────────────────────────────────────

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** POST /api/nutrition/photo-meals/estimate: exactly {image_base64, media_type}. */
export function parseEstimateBody(body: unknown): Parsed<{ image_base64: string; media_type: ImageType }> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be a JSON object" };
  const keys = Object.keys(body).sort().join(",");
  if (keys !== "image_base64,media_type") return { ok: false, error: "body must be exactly {image_base64, media_type}" };
  const { image_base64, media_type } = body as { image_base64: unknown; media_type: unknown };
  if (!IMAGE_TYPES.includes(media_type as ImageType)) {
    return { ok: false, error: `media_type must be one of ${IMAGE_TYPES.join(", ")}` };
  }
  if (typeof image_base64 !== "string" || image_base64.length === 0) return { ok: false, error: "image_base64 is required" };
  if (image_base64.length > MAX_IMAGE_BASE64) return { ok: false, error: "photo too large" };
  if (image_base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image_base64)) {
    return { ok: false, error: "image_base64 must be plain base64 (no data: prefix)" };
  }
  return { ok: true, value: { image_base64, media_type: media_type as ImageType } };
}

export interface PhotoMealSave {
  /** Browser-made UUID: a second tap on Save (or a retry) does not add the meal twice. */
  client_key: string;
  /** Behavioral day (a time before 06:00 belongs to the day before). */
  eaten_date: string;
  /** Local wall clock, "HH:MM". */
  eaten_time: string;
  time_source: TimeSource;
  items: PhotoMealItem[];
  /** Claude's total before Riley's edits (null when no estimate was made). */
  est_kcal: number | null;
  confidence: Confidence | null;
}

const SAVE_KEYS = new Set(["client_key", "eaten_date", "eaten_time", "time_source", "items", "est_kcal", "confidence"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isYmd(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function isHhmm(s: unknown): s is string {
  return typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

function strictNum(v: unknown, max: number): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > max) return null;
  return v;
}

/** POST /api/nutrition/photo-meals: the confirmed (possibly edited) meal. Refuses rather than clamps. */
export function parsePhotoMealBody(body: unknown): Parsed<PhotoMealSave> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).find((k) => !SAVE_KEYS.has(k));
  if (extra) return { ok: false, error: `unknown field ${extra}` };
  if (typeof b.client_key !== "string" || !UUID.test(b.client_key)) return { ok: false, error: "client_key must be a UUID" };
  if (!isYmd(b.eaten_date)) return { ok: false, error: "eaten_date must be YYYY-MM-DD" };
  if (!isHhmm(b.eaten_time)) return { ok: false, error: "eaten_time must be HH:MM" };
  if (!TIME_SOURCES.includes(b.time_source as TimeSource)) return { ok: false, error: "time_source must be photo, now or manual" };
  if (!Array.isArray(b.items) || b.items.length === 0) return { ok: false, error: "add at least one food" };
  if (b.items.length > MAX_ITEMS) return { ok: false, error: `at most ${MAX_ITEMS} foods` };
  const items: PhotoMealItem[] = [];
  for (const [n, it] of b.items.entries()) {
    if (!it || typeof it !== "object" || Array.isArray(it)) return { ok: false, error: `food ${n + 1} is not an object` };
    const o = it as Record<string, unknown>;
    const name = cleanText(o.name, MAX_NAME + 1);
    if (!name) return { ok: false, error: `food ${n + 1} needs a name` };
    if (name.length > MAX_NAME) return { ok: false, error: `food ${n + 1}: name is too long` };
    if (o.portion != null && typeof o.portion !== "string") return { ok: false, error: `food ${n + 1}: portion must be text` };
    const portion = cleanText(o.portion, MAX_PORTION) || null;
    const kcal = strictNum(o.kcal, MAX_ITEM_KCAL);
    if (kcal == null) return { ok: false, error: `${name}: kcal must be a number from 0 to ${MAX_ITEM_KCAL}` };
    const grams: number[] = [];
    for (const k of ["protein_g", "carbs_g", "fat_g"] as const) {
      const g = strictNum(o[k], MAX_ITEM_GRAMS);
      if (g == null) return { ok: false, error: `${name}: ${k.replace("_g", "")} must be grams from 0 to ${MAX_ITEM_GRAMS}` };
      grams.push(roundG(g));
    }
    items.push({ name, portion, kcal: Math.round(kcal), protein_g: grams[0], carbs_g: grams[1], fat_g: grams[2] });
  }
  let est: number | null = null;
  if (b.est_kcal != null) {
    est = strictNum(b.est_kcal, MAX_ITEM_KCAL * MAX_ITEMS);
    if (est == null) return { ok: false, error: "est_kcal must be a number or null" };
    est = Math.round(est);
  }
  if (b.confidence != null && !CONFIDENCES.includes(b.confidence as Confidence)) {
    return { ok: false, error: "confidence must be high, medium, low or null" };
  }
  return {
    ok: true,
    value: {
      client_key: b.client_key.toLowerCase(),
      eaten_date: b.eaten_date,
      eaten_time: b.eaten_time,
      time_source: b.time_source as TimeSource,
      items,
      est_kcal: est,
      confidence: (b.confidence as Confidence | null | undefined) ?? null,
    },
  };
}

/** Body of DELETE /api/nutrition/photo-meals: exactly {meal_id}. */
export function parseDeleteBody(body: unknown): number | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "meal_id") return null;
  const id = (body as { meal_id: unknown }).meal_id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** API answer for a database error code (null = not one of ours: answer 500). */
export function photoMealErrorMessage(code: string | null | undefined): { status: number; error: string } | null {
  if (isMissingRelation(code)) return { status: 503, error: "Photo meals are not set up yet: the database migration is pending." };
  if (code === "OXP01") return { status: 409, error: "That time has not happened yet." };
  if (code === "23514") return { status: 400, error: "A number is out of range." };
  return null;
}

// ─── When it was eaten ───────────────────────────────────────────────────────

/** Behavioral day of a clock date + time: before 06:00 is the small hours that close the day before. */
export function behavioralDate(clockDate: string, time: string): string {
  return time < "06:00" ? shiftYmd(clockDate, -1) : clockDate;
}

/** Inverse of behavioralDate, for showing the clock date: 01:30 on behavioral day D is the next calendar day. */
export function clockDate(behavioral: string, time: string): string {
  return time < "06:00" ? shiftYmd(behavioral, 1) : behavioral;
}

/** Local clock date + time of a Date ("YYYY-MM-DD", "HH:MM") in the browser's own zone. */
export function localClock(d: Date): { date: string; time: string } {
  const p = (n: number) => String(n).padStart(2, "0");
  return { date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, time: `${p(d.getHours())}:${p(d.getMinutes())}` };
}

/**
 * When the photo was taken, from a JPEG's EXIF block: DateTimeOriginal (0x9003) in the Exif sub-IFD, else
 * DateTime (0x0132) in IFD0. EXIF holds the camera's local wall clock ("2026:11:14 19:32:05"), which is what
 * the save body wants. Null for anything else (PNG, HEIC, no EXIF, a stripped or malformed block).
 */
export function exifCaptureTime(bytes: Uint8Array): { date: string; time: string } | null {
  const n = bytes.length;
  if (n < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let pos = 2;
  while (pos + 4 <= n) {
    if (bytes[pos] !== 0xff) return null;
    const marker = bytes[pos + 1];
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / start of scan: no EXIF before the pixels
    const len = (bytes[pos + 2] << 8) | bytes[pos + 3];
    if (len < 2 || pos + 2 + len > n) return null;
    if (marker === 0xe1 && len >= 16) {
      const s = pos + 4;
      const isExif = bytes[s] === 0x45 && bytes[s + 1] === 0x78 && bytes[s + 2] === 0x69 && bytes[s + 3] === 0x66 && bytes[s + 4] === 0 && bytes[s + 5] === 0;
      if (isExif) return readTiffDate(bytes, s + 6, pos + 2 + len);
    }
    pos += 2 + len;
  }
  return null;
}

function readTiffDate(b: Uint8Array, tiff: number, end: number): { date: string; time: string } | null {
  if (tiff + 8 > end) return null;
  const little = b[tiff] === 0x49 && b[tiff + 1] === 0x49;
  const big = b[tiff] === 0x4d && b[tiff + 1] === 0x4d;
  if (!little && !big) return null;
  const u16 = (o: number) => (o + 2 > end ? -1 : little ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
  const u32 = (o: number) =>
    o + 4 > end ? -1 : little ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000 : b[o] * 0x1000000 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
  if (u16(tiff + 2) !== 42) return null;

  // One IFD: the ASCII value of `want`, and the Exif sub-IFD pointer (0x8769).
  const scan = (ifdOff: number, want: number): { value: string | null; exifPtr: number } => {
    const at = tiff + ifdOff;
    const count = u16(at);
    let value: string | null = null;
    let exifPtr = -1;
    if (count < 0 || count > 500) return { value, exifPtr };
    for (let i = 0; i < count; i++) {
      const e = at + 2 + i * 12;
      if (e + 12 > end) break;
      const tag = u16(e);
      if (tag === 0x8769) exifPtr = u32(e + 8);
      if (tag === want && u16(e + 2) === 2) {
        const len = u32(e + 4);
        const off = len <= 4 ? e + 8 : tiff + u32(e + 8);
        if (len >= 19 && off >= 0 && off + 19 <= end) value = String.fromCharCode(...b.subarray(off, off + 19));
      }
    }
    return { value, exifPtr };
  };

  const ifd0 = u32(tiff + 4);
  if (ifd0 < 8) return null;
  const top = scan(ifd0, 0x0132);
  let raw: string | null = null;
  if (top.exifPtr >= 8) raw = scan(top.exifPtr, 0x9003).value;
  raw = raw ?? top.value;
  const m = raw?.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):\d{2}$/);
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  const time = `${m[4]}:${m[5]}`;
  return isYmd(date) && isHhmm(time) ? { date, time } : null;
}

// ─── Not counting a meal twice ───────────────────────────────────────────────

/**
 * Uber Eats orders delivered within `windowMin` of the meal time. A delivered meal is already counted from
 * its cart, so the review screen warns before a photo of it is saved too. One entry per order.
 */
export function nearbyDeliveries<T extends { order_uuid: string; store_name: string; completed_at: string | null }>(
  dishes: ReadonlyArray<T>,
  mealAtMs: number,
  windowMin = 120,
): Array<{ order_uuid: string; store_name: string; completed_at: string }> {
  const out = new Map<string, { order_uuid: string; store_name: string; completed_at: string }>();
  if (!Number.isFinite(mealAtMs)) return [];
  for (const d of dishes) {
    if (!d.completed_at || out.has(d.order_uuid)) continue;
    const t = new Date(d.completed_at).getTime();
    if (Number.isFinite(t) && Math.abs(t - mealAtMs) <= windowMin * 60_000) {
      out.set(d.order_uuid, { order_uuid: d.order_uuid, store_name: d.store_name, completed_at: d.completed_at });
    }
  }
  return [...out.values()];
}

export type EstimateSource = "uber_eats" | "photo" | "uber_eats+photo";

/**
 * Per-day estimates for days with no Cronometer/MFP log: Uber Eats dishes and photo-logged meals ADD UP
 * (they are different meals; the review screen warns when a photo is close to a delivery). A Cronometer
 * day still wins over both in mergeDeliveryEstimates, because the diary usually already holds those meals.
 * Days whose total is 0 kcal or less carry no food signal and are left out.
 */
export function combineEstimateDays(
  delivery: ReadonlyArray<DeliveryEstimateDay>,
  photo: ReadonlyArray<DeliveryEstimateDay>,
): DeliveryEstimateDay[] {
  type Acc = { kcal: number; p: number; c: number; f: number; uber: boolean; photo: boolean };
  const byDay = new Map<string, Acc>();
  const add = (rows: ReadonlyArray<DeliveryEstimateDay>, which: "uber" | "photo") => {
    for (const r of rows) {
      const kcal = Number(r.est_kcal);
      if (!Number.isFinite(kcal) || kcal <= 0) continue;
      const a = byDay.get(r.behavioral_date) ?? { kcal: 0, p: 0, c: 0, f: 0, uber: false, photo: false };
      a.kcal += kcal;
      a.p += Number(r.est_protein_g) || 0;
      a.c += Number(r.est_carbs_g) || 0;
      a.f += Number(r.est_fat_g) || 0;
      a[which] = true;
      byDay.set(r.behavioral_date, a);
    }
  };
  add(delivery, "uber");
  add(photo, "photo");
  return [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([day, a]) => ({
      behavioral_date: day,
      est_kcal: Math.round(a.kcal),
      est_protein_g: roundG(a.p),
      est_carbs_g: roundG(a.c),
      est_fat_g: roundG(a.f),
      nutrition_source: (a.uber && a.photo ? "uber_eats+photo" : a.photo ? "photo" : "uber_eats") as EstimateSource,
    }));
}

export function isEstimateSource(s: unknown): s is EstimateSource {
  return s === "uber_eats" || s === "photo" || s === "uber_eats+photo";
}

export type EstimateTag = "UBER EATS EST." | "PHOTO EST." | "UBER EATS + PHOTO EST.";

function estimateTag(hasUber: boolean, hasPhoto: boolean): EstimateTag {
  return hasUber && hasPhoto ? "UBER EATS + PHOTO EST." : hasPhoto ? "PHOTO EST." : "UBER EATS EST.";
}

/** Chart source tag of one day's row (StatCard `source`). */
export function daySourceLabel(source: unknown): "CRONOMETER" | EstimateTag {
  if (!isEstimateSource(source)) return "CRONOMETER";
  return estimateTag(source !== "photo", source !== "uber_eats");
}

/** Chart source tag of a range of rows: the logged source, the estimate kinds present, or both. */
export function rangeSourceLabel(sources: ReadonlyArray<unknown>): string {
  let logged = false, uber = false, photo = false;
  for (const s of sources) {
    if (!isEstimateSource(s)) logged = true;
    else {
      if (s !== "photo") uber = true;
      if (s !== "uber_eats") photo = true;
    }
  }
  if (!uber && !photo) return "CRONOMETER";
  return logged ? `CRONOMETER + ${estimateTag(uber, photo)}` : estimateTag(uber, photo);
}
