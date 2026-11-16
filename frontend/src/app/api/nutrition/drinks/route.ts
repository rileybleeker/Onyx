import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { checkPortionRequest, shiftYmd } from "@/lib/delivery-portion";
import { DRINK_PRODUCTS, drinkProduct, type DrinkProduct } from "@/lib/drink-products";
import {
  DRINK_COLUMNS,
  DRINK_DAYS_BACK,
  MAX_DRINK_BODY_BYTES,
  asSnapshot,
  cronometerNutritionCoverage,
  drinkRowValues,
  fallbackBehavioralToday,
  isUuid,
  isYmd,
  likelySameDrink,
  parseDrinkCreate,
  parseDrinkEdit,
  parseDrinkRemove,
  resolveDrinkTime,
  sameCapture,
  snapshotOf,
  toDrinkRecord,
  type DrinkRecord,
  type DrinkSave,
  type OverlapCandidate,
  type ResolvedTime,
} from "@/lib/drink-capture";

// Direct drink capture (PROD-CAFF-01 slice; sql/direct_drink_capture.sql). ONE row per drink in pds.photo_meals
// with capture_kind = 'drink'; that row feeds Nutrition (pds.direct_drink_daily) and Caffeine (pds.caffeine_events).
// Never writes a supplement intake.
//
// GET    ?day=YYYY-MM-DD   that behavioral day's drinks (not removed) + entries already logged that look like the same
//                          drink (complete reads, or the source is named in `unavailable`) + behavioral today.
// GET    ?key=<uuid>       one stored drink by its key (read-only; the Log editor's recovery after a reload):
//                          {status: "found", record} | {status: "removed"} | {status: "none"}.
// POST   {client_key, product_id, servings, time, overlap}                     create (idempotent on client_key)
// PATCH  {client_key, expected_revision, product_id, servings, time, overlap}  revision-checked edit
// DELETE {client_key, expected_revision}                                       Undo / Remove: tombstone, never a delete
//
// Identity: client_key is the browser's stable UUID for one drink. The table's UNIQUE(client_key) decides. A stored
// drink under the key is compared FIRST, before any new-capture rule (catalogue, the 48 h / 6 day window): the same
// normalized capture answers the stored row (a retry, a double tap, a lost answer, days later too); anything else is
// 409 `changed` with the stored row. A removed key is 410 `removed` for every later POST / PATCH. Conflicts are the
// browser's to show; it never turns them into an edit with the returned revision.
//
// Overlap: `in_diary` (counted nowhere) is accepted only when a Cronometer serving on that behavioral day (the same
// COALESCE(onyx_behavioral_date, calendar_date) the caffeine view uses) names the drink's brand, carries caffeine,
// and has known nutrition values with explicit nutrition-day attribution. A supplement or an Uber Eats dish
// cannot stand in for both, so it is never accepted as "already counted".
//
// Authority: the browser names a product id and an amount; the label values come from lib/drink-products.ts (a
// frozen snapshot is stored on the row), never from the browser or the model. The time is resolved here
// (resolveDrinkTime) against the server clock and behavioral today; the table trigger checks it again.
//
// Auth: owner session only (middleware; NOT in isCiRoute). Same-origin JSON with a 4 KB cap; unknown fields refused.
// Nothing is stored about the words Riley said.

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
  auth: { persistSession: false, autoRefreshToken: false },
});

const NO_STORE = { "Cache-Control": "no-store" };

/** "Not set up yet": the table/view, or the drink columns, do not exist (migration not applied). */
const MISSING = new Set(["PGRST205", "42P01", "42703", "PGRST204"]);

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

function dbError(code: string | undefined, what: string) {
  if (code && MISSING.has(code)) return json({ error: "Drinks are not set up yet: the database migration is pending.", code: "unavailable" }, 503);
  if (code === "OXD00") return json({ error: "Drink capture is turned off.", code: "unavailable" }, 503);
  if (code === "OXP01") return json({ error: "That time has not happened yet." }, 409);
  if (code === "OXD01" || code === "22023") return json({ error: "That time does not fit its day or time zone." }, 400);
  if (code === "OXD03") return json({ error: "This drink was removed.", code: "removed" }, 410);
  if (code === "23514") return json({ error: "A number is out of range." }, 400);
  console.error(`[drinks] ${what} failed:`, code);
  return json({ error: "Could not save the drink." }, 500);
}

async function readJson(req: NextRequest): Promise<{ ok: true; body: unknown } | { ok: false; res: NextResponse }> {
  const refused = checkPortionRequest(req.headers, req.nextUrl.origin, MAX_DRINK_BODY_BYTES);
  if (refused) return { ok: false, res: NextResponse.json({ error: refused.error }, { status: refused.status }) };
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { ok: false, res: NextResponse.json({ error: "could not read body" }, { status: 400 }) };
  }
  if (Buffer.byteLength(text, "utf8") > MAX_DRINK_BODY_BYTES) return { ok: false, res: NextResponse.json({ error: "body too large" }, { status: 413 }) };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, res: NextResponse.json({ error: "body must be JSON" }, { status: 400 }) };
  }
}

async function behavioralToday(): Promise<string> {
  try {
    const { data } = await supabase.rpc("behavioral_today_now");
    if (typeof data === "string" && isYmd(data)) return data;
  } catch {
    /* fall through */
  }
  // Eastern WALL clock, then the 06:00 rule (correct across a DST change).
  return fallbackBehavioralToday(Date.now());
}

type Row = Record<string, unknown>;

/** The stored row for a key, whatever its kind or state (null = none). */
async function rowByKey(key: string): Promise<{ row: Row | null; code?: string }> {
  const { data, error } = await supabase.from("photo_meals").select(DRINK_COLUMNS).eq("client_key", key).limit(1);
  if (error) return { row: null, code: error.code };
  return { row: ((data ?? [])[0] as unknown as Row) ?? null };
}

function changed() {
  // What a drink write changes: Nutrition (ISR snapshot), Caffeine (ISR snapshot) and Today's cards.
  revalidatePath("/nutrition");
  revalidatePath("/caffeine");
  revalidatePath("/today");
}

const answer = (rec: DrinkRecord, status = 200, extra: Record<string, unknown> = {}) => json({ record: rec, ...extra }, status);

/** 409 / 410 for a key that is not (or no longer) a live drink. */
function stateConflict(row: Row): NextResponse | null {
  if (row.capture_kind !== "drink") return json({ error: "That key belongs to another entry.", code: "other_kind" }, 409);
  if (row.deleted_at != null) return json({ error: "This drink was removed.", code: "removed" }, 410);
  return null;
}

const timeError = (t: Extract<ResolvedTime, { ok: false }>) => json({ error: t.error, code: t.problem, choices: t.choices ?? null }, t.problem === "ambiguous" ? 409 : 400);

/**
 * Is the request the drink already stored under its key? The instant is resolved WITHOUT the new-capture window
 * (a replay days later is still the same drink); zone, DST choice and ISO syntax still apply. A changed payload is
 * never "the same", so it never escapes the window or the revision check.
 */
function sameAsStored(rec: DrinkRecord, save: DrinkSave, today: string): boolean {
  const t = resolveDrinkTime(save.time, Date.now(), today, { bounds: false });
  return t.ok && sameCapture(rec, save, t);
}

// ---- reading what is already logged, completely ------------------------------------------------------------------

const PAGE = 1000;
const MAX_ROWS = 5000;
type Page<T> = PromiseLike<{ data: T[] | null; error: { code?: string } | null }>;

/** Every row of a stable-ordered query, page by page; "truncated" past MAX_ROWS, "failed" on any error. */
async function readAll<T>(page: (from: number, to: number) => Page<T>): Promise<{ rows: T[]; state: "ok" | "truncated" | "failed" }> {
  const rows: T[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) return { rows, state: "failed" };
    const got = data ?? [];
    rows.push(...got);
    if (got.length < PAGE) return { rows, state: "ok" };
  }
  return { rows, state: "truncated" };
}

/** "%gorilla%mind%": the brand's words in order, for an ILIKE pre-filter (likelySameDrink decides after). */
const brandPattern = (p: DrinkProduct) => `%${p.brand.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join("%")}%`;
const patterns = () => Array.from(new Set(DRINK_PRODUCTS.map(brandPattern)));
/** The day a Cronometer serving counts on (pds.caffeine_events / the nutrition rollup). */
const cronometerDay = (day: string) => `onyx_behavioral_date.eq.${day},and(onyx_behavioral_date.is.null,calendar_date.eq.${day})`;

const etClock = (iso: unknown) => {
  if (typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : null;
};

async function overlapCandidates(day: string): Promise<{ candidates: OverlapCandidate[]; unavailable: string[] }> {
  const candidates: OverlapCandidate[] = [];
  const unavailable = new Set<string>();
  const brandish = (name: unknown): name is string => typeof name === "string" && DRINK_PRODUCTS.some((p) => likelySameDrink(p, name));
  for (const pattern of patterns()) {
    type Serving = { serving_id: number; food_name: string | null; event_time: string | null; caffeine_mg: number | string | null;
      onyx_behavioral_date: string | null; calories: number | string | null; protein_g: number | string | null;
      carbs_g: number | string | null; fat_g: number | string | null; sugars_g: number | string | null; sodium_mg: number | string | null };
    type Dish = { item_id: number; title: string | null; completed_at: string | null };
    type Product = { product_id: string; brand_name: string | null; full_name: string | null };
    const [servings, dishes, products] = await Promise.all([
      readAll<Serving>((from, to) =>
        supabase.from("cronometer_servings").select("serving_id, food_name, event_time, caffeine_mg, onyx_behavioral_date, calories, protein_g, carbs_g, fat_g, sugars_g, sodium_mg").or(cronometerDay(day)).ilike("food_name", pattern).order("serving_id", { ascending: true }).range(from, to),
      ),
      readAll<Dish>((from, to) =>
        supabase.from("delivery_order_items").select("item_id, title, completed_at").eq("onyx_behavioral_date", day).eq("is_cancelled", false).ilike("title", pattern).order("item_id", { ascending: true }).range(from, to),
      ),
      readAll<Product>((from, to) =>
        supabase.from("supplement_products").select("product_id, brand_name, full_name").or(`brand_name.ilike.${pattern},full_name.ilike.${pattern}`).order("product_id", { ascending: true }).range(from, to),
      ),
    ]);
    if (servings.state !== "ok") unavailable.add("cronometer");
    for (const s of servings.rows) {
      if (!brandish(s.food_name)) continue;
      const mg = s.caffeine_mg == null ? null : Number(s.caffeine_mg);
      candidates.push({ source: "cronometer", name: s.food_name, time: etClock(s.event_time), caffeine_mg: mg != null && Number.isFinite(mg) ? mg : null,
        counts_in_nutrition: cronometerNutritionCoverage(s, day) });
    }
    if (dishes.state !== "ok") unavailable.add("delivery");
    for (const d of dishes.rows) if (brandish(d.title)) candidates.push({ source: "delivery", name: d.title, time: etClock(d.completed_at), caffeine_mg: null });
    if (products.state !== "ok") unavailable.add("supplements");
    const names = new Map(products.rows.map((p) => [p.product_id, [p.brand_name, p.full_name].filter(Boolean).join(" ")]));
    const ids = Array.from(names.keys()).filter((id) => brandish(names.get(id)));
    if (ids.length) {
      type Intake = { intake_id: number; product_id: string; intake_time: string | null };
      const intakes = await readAll<Intake>((from, to) =>
        supabase.from("supplement_intake").select("intake_id, product_id, intake_time").eq("intake_date", day).in("product_id", ids).order("intake_id", { ascending: true }).range(from, to),
      );
      if (intakes.state !== "ok") unavailable.add("supplements");
      for (const i of intakes.rows) candidates.push({ source: "supplement", name: names.get(i.product_id) ?? i.product_id, time: etClock(i.intake_time), caffeine_mg: null });
    }
  }
  return { candidates, unavailable: Array.from(unavailable) };
}

/** `in_diary` requires independently observed nutrition attribution/values AND caffeine coverage. */
async function overlapVerified(day: string, product: DrinkProduct): Promise<boolean> {
  const { candidates, unavailable } = await overlapCandidates(day);
  if (unavailable.includes("cronometer")) return false;
  return candidates.some((o) => o.source === "cronometer" && o.counts_in_nutrition === true && (o.caffeine_mg ?? 0) > 0 && likelySameDrink(product, o.name));
}

const overlapRefused = () =>
  json({ error: "Already counted needs a Cronometer entry with known nutrition and caffeine on that day.", code: "overlap_unverified" }, 409);

// ---- GET ------------------------------------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key");
  if (key != null) {
    if (!isUuid(key)) return json({ error: "key must be a UUID" }, 400);
    const cur = await rowByKey(key.toLowerCase());
    if (cur.code) return dbError(cur.code, "read");
    if (!cur.row) return json({ status: "none" });
    if (cur.row.capture_kind !== "drink") return json({ error: "That key belongs to another entry.", code: "other_kind" }, 409);
    if (cur.row.deleted_at != null) return json({ status: "removed" });
    return json({ status: "found", record: toDrinkRecord(cur.row) });
  }

  const today = await behavioralToday();
  const dayParam = req.nextUrl.searchParams.get("day");
  const day = dayParam ?? today;
  if (!isYmd(day) || day > shiftYmd(today, 1) || day < shiftYmd(today, -DRINK_DAYS_BACK)) {
    return json({ error: `day must be YYYY-MM-DD from ${DRINK_DAYS_BACK} days ago to today` }, 400);
  }

  const [drinks, overlap] = await Promise.all([
    supabase
      .from("photo_meals")
      .select(DRINK_COLUMNS)
      .eq("capture_kind", "drink")
      .is("deleted_at", null)
      .eq("eaten_date", day)
      .order("eaten_at", { ascending: true })
      .order("meal_id", { ascending: true }),
    overlapCandidates(day),
  ]);
  if (drinks.error) return dbError(drinks.error.code, "read");

  return json({
    today,
    day,
    drinks: ((drinks.data ?? []) as unknown as Row[]).map(toDrinkRecord),
    overlaps: overlap.candidates,
    // Sources that could not be read completely: the editor never reads these as "nothing there".
    unavailable: overlap.unavailable,
  });
}

// ---- POST: create ----------------------------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const read = await readJson(req);
  if (!read.ok) return read.res;
  const parsed = parseDrinkCreate(read.body);
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const save = parsed.value;
  const today = await behavioralToday();

  // A drink already under this key is answered first, whatever its age or the catalogue now holds.
  const existing = await rowByKey(save.client_key);
  if (existing.code) return dbError(existing.code, "read");
  if (existing.row) return storedAnswer(existing.row, save, today);

  // A new drink: the current catalogue, the new-capture time window, a verified overlap.
  const product = drinkProduct(save.product_id);
  if (!product) return json({ error: "product_id is not a known drink" }, 400);
  const t = resolveDrinkTime(save.time, Date.now(), today);
  if (!t.ok) return timeError(t);
  if (save.overlap === "in_diary" && !(await overlapVerified(t.eaten_date, product))) return overlapRefused();

  const values = drinkRowValues(snapshotOf(product), save.servings, t, save.overlap);
  const { data, error } = await supabase
    .from("photo_meals")
    .insert({ client_key: save.client_key, capture_kind: "drink", revision: 1, ...values })
    .select(DRINK_COLUMNS);
  if (!error && data?.[0]) {
    changed();
    return answer(toDrinkRecord(data[0] as unknown as Row), 201);
  }
  if (error && error.code !== "23505") return dbError(error.code, "save");

  // Lost a race with a simultaneous create under the same key: compare with what won.
  const again = await rowByKey(save.client_key);
  if (again.code) return dbError(again.code, "re-read");
  if (!again.row) return json({ error: "Could not save the drink." }, 500);
  return storedAnswer(again.row, save, today);
}

function storedAnswer(row: Row, save: DrinkSave, today: string): NextResponse {
  const conflict = stateConflict(row);
  if (conflict) return conflict;
  const rec = toDrinkRecord(row);
  if (sameAsStored(rec, save, today)) return answer(rec, 200, { replay: true });
  return json({ error: "This drink was saved with other details.", code: "changed", record: rec }, 409);
}

// ---- PATCH: revision-checked edit -----------------------------------------------------------------------------

export async function PATCH(req: NextRequest) {
  const read = await readJson(req);
  if (!read.ok) return read.res;
  const parsed = parseDrinkEdit(read.body);
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const edit = parsed.value;
  const today = await behavioralToday();

  const cur = await rowByKey(edit.client_key);
  if (cur.code) return dbError(cur.code, "read");
  if (!cur.row) return json({ error: "drink not found" }, 404);
  const conflict = stateConflict(cur.row);
  if (conflict) return conflict;
  const rec = toDrinkRecord(cur.row);

  // Already this way (an edit whose answer was lost, sent again): the stored row, whatever its age.
  if (sameAsStored(rec, edit, today)) return answer(rec, 200, { replay: true });
  if (rec.revision !== edit.expected_revision) {
    return json({ error: "This drink changed since you opened it.", code: "stale", record: rec }, 409);
  }

  // The time Riley did not change keeps the stored instant (an amount edit of an older drink); a changed time must
  // pass the new-capture window. A changed product must be in the current catalogue.
  const unbounded = resolveDrinkTime(edit.time, Date.now(), today, { bounds: false });
  const keepsTime =
    unbounded.ok && Date.parse(rec.eaten_at) === unbounded.eaten_ms && rec.time_zone === unbounded.time_zone && rec.time_source === unbounded.time_source;
  const t: ResolvedTime = keepsTime
    ? { ok: true, eaten_at: new Date(Date.parse(rec.eaten_at)).toISOString(), eaten_ms: Date.parse(rec.eaten_at), eaten_date: rec.eaten_date, eaten_time: rec.eaten_time, time_source: rec.time_source, time_zone: rec.time_zone }
    : resolveDrinkTime(edit.time, Date.now(), today);
  if (!t.ok) return timeError(t);

  const stored = asSnapshot(cur.row.drink_label);
  const sameProduct = !!stored && stored.product_id === edit.product_id;
  const product = drinkProduct(edit.product_id);
  if (!sameProduct && !product) return json({ error: "product_id is not a known drink" }, 400);
  if (edit.overlap === "in_diary" && (rec.overlap !== "in_diary" || !keepsTime || !sameProduct)) {
    const p = product ?? drinkProduct(rec.product_id);
    if (!p || !(await overlapVerified(t.eaten_date, p))) return overlapRefused();
  }
  // The label stays the one captured with the drink unless the product itself changes.
  const snapshot = sameProduct ? stored! : snapshotOf(product!);
  const values = drinkRowValues(snapshot, edit.servings, t, edit.overlap);
  const { data, error } = await supabase
    .from("photo_meals")
    .update({ ...values, revision: edit.expected_revision + 1 })
    .eq("client_key", edit.client_key)
    .eq("capture_kind", "drink")
    .is("deleted_at", null)
    .eq("revision", edit.expected_revision)
    .select(DRINK_COLUMNS);
  if (error) return dbError(error.code, "edit");
  if (!data?.[0]) {
    // Lost a race with another edit or a removal between the read and the update.
    const now = await rowByKey(edit.client_key);
    if (now.code) return dbError(now.code, "re-read");
    if (now.row) {
      const c = stateConflict(now.row);
      if (c) return c;
      return json({ error: "This drink changed since you opened it.", code: "stale", record: toDrinkRecord(now.row) }, 409);
    }
    return json({ error: "drink not found" }, 404);
  }
  changed();
  return answer(toDrinkRecord(data[0] as unknown as Row));
}

// ---- DELETE: Undo / Remove (tombstone) ------------------------------------------------------------------------

export async function DELETE(req: NextRequest) {
  const read = await readJson(req);
  if (!read.ok) return read.res;
  const parsed = parseDrinkRemove(read.body);
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const { client_key, expected_revision } = parsed.value;

  const cur = await rowByKey(client_key);
  if (cur.code) return dbError(cur.code, "read");
  if (!cur.row || cur.row.capture_kind !== "drink") return json({ error: "drink not found" }, 404);
  // Removed already (a repeated Undo): done.
  if (cur.row.deleted_at != null) return json({ removed: client_key });
  const rec = toDrinkRecord(cur.row);
  if (rec.revision !== expected_revision) {
    // Changed since the browser saw it: never removed on its behalf (the newer version is shown there).
    return json({ error: "This drink changed since you opened it.", code: "stale", record: rec }, 409);
  }
  const { data, error } = await supabase
    .from("photo_meals")
    .update({ deleted_at: new Date().toISOString(), revision: expected_revision + 1 })
    .eq("client_key", client_key)
    .eq("capture_kind", "drink")
    .is("deleted_at", null)
    .eq("revision", expected_revision)
    .select("meal_id");
  if (error) return dbError(error.code, "remove");
  if (!data?.length) {
    const now = await rowByKey(client_key);
    if (now.code) return dbError(now.code, "re-read");
    if (now.row?.deleted_at != null) return json({ removed: client_key });
    if (now.row) return json({ error: "This drink changed since you opened it.", code: "stale", record: toDrinkRecord(now.row) }, 409);
    return json({ error: "drink not found" }, 404);
  }
  changed();
  return json({ removed: client_key });
}
