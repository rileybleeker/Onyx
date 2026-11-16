import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { checkPortionRequest, shiftYmd } from "@/lib/delivery-portion";
import { DRINK_PRODUCTS, drinkProduct } from "@/lib/drink-products";
import {
  DRINK_COLUMNS,
  DRINK_DAYS_BACK,
  MAX_DRINK_BODY_BYTES,
  asSnapshot,
  drinkRowValues,
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
//                          drink (Cronometer servings, supplement intakes, Uber Eats dishes) + behavioral today.
// POST   {client_key, product_id, servings, time, overlap}                     create (idempotent on client_key)
// PATCH  {client_key, expected_revision, product_id, servings, time, overlap}  revision-checked edit
// DELETE {client_key, expected_revision}                                       Undo / Remove: tombstone, never a delete
//
// Identity: client_key is the browser's stable UUID for one drink (lib/drink-capture.ts itemKey / newUuid). The
// table's UNIQUE(client_key) decides. The same key with the same normalized capture answers the stored row (a retry,
// a double tap, a lost answer); the same key with anything else is 409 `changed` with the stored row (the browser
// then edits it with its revision), never a second drink and never a silently ignored change. A removed key is
// 410 `removed` for every later POST / PATCH, so a late retry cannot bring it back. Only drink rows are read or
// written here (capture_kind = 'drink'); the photo routes pin capture_kind = 'photo'.
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

function dbError(code: string | undefined, what: string) {
  if (code && MISSING.has(code)) {
    return NextResponse.json({ error: "Drinks are not set up yet: the database migration is pending.", code: "unavailable" }, { status: 503, headers: NO_STORE });
  }
  if (code === "OXD00") return NextResponse.json({ error: "Drink capture is turned off.", code: "unavailable" }, { status: 503, headers: NO_STORE });
  if (code === "OXP01") return NextResponse.json({ error: "That time has not happened yet." }, { status: 409, headers: NO_STORE });
  if (code === "OXD01" || code === "22023") return NextResponse.json({ error: "That time does not fit its day or time zone." }, { status: 400, headers: NO_STORE });
  if (code === "OXD03") return NextResponse.json({ error: "This drink was removed.", code: "removed" }, { status: 410, headers: NO_STORE });
  if (code === "23514") return NextResponse.json({ error: "A number is out of range." }, { status: 400, headers: NO_STORE });
  console.error(`[drinks] ${what} failed:`, code);
  return NextResponse.json({ error: "Could not save the drink." }, { status: 500, headers: NO_STORE });
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
  // Eastern clock minus 6 h (travel zones are the database's job when it answers).
  return new Date(Date.now() - 6 * 3_600_000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
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

const answer = (rec: DrinkRecord, status = 200, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ record: rec, ...extra }, { status, headers: NO_STORE });

/** 409 / 410 for a key that is not (or no longer) a live drink of this capture. */
function stateConflict(row: Row): NextResponse | null {
  if (row.capture_kind !== "drink") return NextResponse.json({ error: "That key belongs to another entry.", code: "other_kind" }, { status: 409, headers: NO_STORE });
  if (row.deleted_at != null) return NextResponse.json({ error: "This drink was removed.", code: "removed" }, { status: 410, headers: NO_STORE });
  return null;
}

async function resolve(save: DrinkSave) {
  const today = await behavioralToday();
  return { today, t: resolveDrinkTime(save.time, Date.now(), today) };
}

// ---- GET ------------------------------------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const today = await behavioralToday();
  const dayParam = req.nextUrl.searchParams.get("day");
  const day = dayParam ?? today;
  if (!isYmd(day) || day > shiftYmd(today, 1) || day < shiftYmd(today, -DRINK_DAYS_BACK)) {
    return NextResponse.json({ error: `day must be YYYY-MM-DD from ${DRINK_DAYS_BACK} days ago to today` }, { status: 400 });
  }

  const [drinks, servings, intakes, dishes] = await Promise.all([
    supabase
      .from("photo_meals")
      .select(DRINK_COLUMNS)
      .eq("capture_kind", "drink")
      .is("deleted_at", null)
      .eq("eaten_date", day)
      .order("eaten_at", { ascending: true })
      .order("meal_id", { ascending: true }),
    supabase.from("cronometer_servings").select("food_name, event_time").eq("onyx_behavioral_date", day).limit(200),
    supabase.from("supplement_intake").select("product_id, intake_time").eq("intake_date", day).limit(200),
    supabase.from("delivery_order_items").select("title, completed_at").eq("onyx_behavioral_date", day).eq("is_cancelled", false).limit(200),
  ]);
  if (drinks.error) return dbError(drinks.error.code, "read");

  // What is already logged that might be the same drink (a prompt in the editor, never an automatic change).
  // A source that fails to load is named, so the editor never treats "could not check" as "nothing there".
  const unavailable: string[] = [];
  const clock = (iso: unknown) => {
    if (typeof iso !== "string") return null;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? new Date(ms).toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : null;
  };
  const candidates: OverlapCandidate[] = [];
  const brandish = (name: string) => DRINK_PRODUCTS.some((p) => likelySameDrink(p, name));
  if (servings.error) unavailable.push("cronometer");
  else for (const s of servings.data ?? []) if (typeof s.food_name === "string" && brandish(s.food_name)) candidates.push({ source: "cronometer", name: s.food_name, time: clock(s.event_time) });
  if (dishes.error) unavailable.push("delivery");
  else for (const d of dishes.data ?? []) if (typeof d.title === "string" && brandish(d.title)) candidates.push({ source: "delivery", name: d.title, time: clock(d.completed_at) });
  if (intakes.error) unavailable.push("supplements");
  else {
    const ids = Array.from(new Set((intakes.data ?? []).map((i) => i.product_id).filter((x): x is string => typeof x === "string")));
    if (ids.length) {
      const { data: products, error } = await supabase.from("supplement_products").select("product_id, brand_name, full_name").in("product_id", ids);
      if (error) unavailable.push("supplements");
      else {
        const names = new Map((products ?? []).map((p) => [p.product_id, [p.brand_name, p.full_name].filter(Boolean).join(" ")]));
        for (const i of intakes.data ?? []) {
          const name = names.get(i.product_id) ?? "";
          if (name && brandish(name)) candidates.push({ source: "supplement", name, time: clock(i.intake_time) });
        }
      }
    }
  }

  return NextResponse.json(
    {
      today,
      day,
      drinks: ((drinks.data ?? []) as unknown as Row[]).map(toDrinkRecord),
      overlaps: candidates,
      unavailable,
    },
    { headers: NO_STORE },
  );
}

// ---- POST: create ----------------------------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const read = await readJson(req);
  if (!read.ok) return read.res;
  const parsed = parseDrinkCreate(read.body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const save = parsed.value;
  const product = drinkProduct(save.product_id)!;
  const { t } = await resolve(save);
  if (!t.ok) return NextResponse.json({ error: t.error, code: t.problem, choices: t.choices ?? null }, { status: t.problem === "ambiguous" ? 409 : 400 });

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

  // The key exists already: a retry of this same drink, or something else under the same key.
  const again = await rowByKey(save.client_key);
  if (again.code) return dbError(again.code, "re-read");
  if (!again.row) return NextResponse.json({ error: "Could not save the drink." }, { status: 500 });
  const conflict = stateConflict(again.row);
  if (conflict) return conflict;
  const rec = toDrinkRecord(again.row);
  if (sameCapture(rec, save, t)) return answer(rec, 200, { replay: true });
  return NextResponse.json({ error: "This drink was saved with other details.", code: "changed", record: rec }, { status: 409, headers: NO_STORE });
}

// ---- PATCH: revision-checked edit -----------------------------------------------------------------------------

export async function PATCH(req: NextRequest) {
  const read = await readJson(req);
  if (!read.ok) return read.res;
  const parsed = parseDrinkEdit(read.body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const edit = parsed.value;

  const cur = await rowByKey(edit.client_key);
  if (cur.code) return dbError(cur.code, "read");
  if (!cur.row) return NextResponse.json({ error: "drink not found" }, { status: 404 });
  const conflict = stateConflict(cur.row);
  if (conflict) return conflict;
  const rec = toDrinkRecord(cur.row);

  // A "now" drink keeps its captured instant through edits of the amount or overlap, however long ago it was
  // (the 48 h retry window applies to new captures only).
  const keptNow: ResolvedTime | null =
    edit.time.mode === "now" && rec.time_source === "now" && Date.parse(edit.time.at) === Date.parse(rec.eaten_at) && edit.time.zone === rec.time_zone
      ? { ok: true, eaten_at: new Date(Date.parse(rec.eaten_at)).toISOString(), eaten_ms: Date.parse(rec.eaten_at), eaten_date: rec.eaten_date, eaten_time: rec.eaten_time, time_source: "now", time_zone: rec.time_zone }
      : null;
  const t = keptNow ?? (await resolve(edit)).t;
  if (!t.ok) return NextResponse.json({ error: t.error, code: t.problem, choices: t.choices ?? null }, { status: t.problem === "ambiguous" ? 409 : 400 });
  // Already this way (an edit whose answer was lost, sent again): the stored row.
  if (sameCapture(rec, edit, t)) return answer(rec, 200, { replay: true });
  if (rec.revision !== edit.expected_revision) {
    return NextResponse.json({ error: "This drink changed since you opened it.", code: "stale", record: rec }, { status: 409, headers: NO_STORE });
  }

  // The label stays the one captured with the drink unless the product itself changes.
  const stored = asSnapshot(cur.row.drink_label);
  const product = drinkProduct(edit.product_id)!;
  const snapshot = stored && stored.product_id === edit.product_id ? stored : snapshotOf(product);
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
    if (now.row) {
      const c = stateConflict(now.row);
      if (c) return c;
      return NextResponse.json({ error: "This drink changed since you opened it.", code: "stale", record: toDrinkRecord(now.row) }, { status: 409, headers: NO_STORE });
    }
    return NextResponse.json({ error: "drink not found" }, { status: 404 });
  }
  changed();
  return answer(toDrinkRecord(data[0] as unknown as Row));
}

// ---- DELETE: Undo / Remove (tombstone) ------------------------------------------------------------------------

export async function DELETE(req: NextRequest) {
  const read = await readJson(req);
  if (!read.ok) return read.res;
  const parsed = parseDrinkRemove(read.body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { client_key, expected_revision } = parsed.value;

  const cur = await rowByKey(client_key);
  if (cur.code) return dbError(cur.code, "read");
  if (!cur.row || cur.row.capture_kind !== "drink") return NextResponse.json({ error: "drink not found" }, { status: 404 });
  // Removed already (a repeated Undo): done.
  if (cur.row.deleted_at != null) return NextResponse.json({ removed: client_key }, { headers: NO_STORE });
  const rec = toDrinkRecord(cur.row);
  if (rec.revision !== expected_revision) {
    return NextResponse.json({ error: "This drink changed since you opened it.", code: "stale", record: rec }, { status: 409, headers: NO_STORE });
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
    if (now.row?.deleted_at != null) return NextResponse.json({ removed: client_key }, { headers: NO_STORE });
    if (now.row) return NextResponse.json({ error: "This drink changed since you opened it.", code: "stale", record: toDrinkRecord(now.row) }, { status: 409, headers: NO_STORE });
    return NextResponse.json({ error: "drink not found" }, { status: 404 });
  }
  changed();
  return NextResponse.json({ removed: client_key }, { headers: NO_STORE });
}
