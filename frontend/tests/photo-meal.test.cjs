// Run: node --test tests/photo-meal.test.cjs
// Food by photo (pds.photo_meals, sql/photo_meals.sql): the estimate normalizer, the request validators,
// the EXIF capture-time reader, the behavioral-day rule, the Uber Eats double-count warning, how photo
// meals join the daily macros (getNutrition), the source labels, and the two route handlers with fake
// Supabase / Anthropic clients. SYNTHETIC DATA ONLY: invented foods and numbers; no network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

const M = loadTs("lib/photo-meal.ts");
const P = loadTs("lib/delivery-portion.ts");

// ─── the model's answer ──────────────────────────────────────────────────────

test("normalizeEstimate clamps, rounds and drops unnamed items", () => {
  const e = M.normalizeEstimate({
    is_food: true,
    confidence: "medium",
    items: [
      { name: "  Test rice  ", portion: "1 cup", kcal: 205.6, protein_g: 4.26, carbs_g: 44.51, fat_g: 0.44 },
      { name: "", portion: "x", kcal: 100, protein_g: 1, carbs_g: 1, fat_g: 1 },
      { name: "Test oil", portion: "", kcal: -40, protein_g: "3", carbs_g: NaN, fat_g: 99999 },
      null,
    ],
  });
  assert.equal(e.is_food, true);
  assert.equal(e.confidence, "medium");
  assert.deepEqual(e.items, [
    { name: "Test rice", portion: "1 cup", kcal: 206, protein_g: 4.3, carbs_g: 44.5, fat_g: 0.4 },
    { name: "Test oil", portion: null, kcal: 0, protein_g: 3, carbs_g: 0, fat_g: M.MAX_ITEM_GRAMS },
  ]);
});

test("normalizeEstimate: not food means no items; bad shapes are null; unknown confidence is low", () => {
  assert.deepEqual(M.normalizeEstimate({ is_food: false, confidence: "high", items: [{ name: "Cup", kcal: 1, protein_g: 0, carbs_g: 0, fat_g: 0 }] }).items, []);
  assert.equal(M.normalizeEstimate({ is_food: true, confidence: "high", items: [] }).is_food, false);
  assert.equal(M.normalizeEstimate({ items: [{ name: "Test bread", kcal: 80, protein_g: 3, carbs_g: 15, fat_g: 1 }] }).confidence, "low");
  for (const bad of [null, "x", [], { items: "no" }, {}]) assert.equal(M.normalizeEstimate(bad), null);
  const many = Array.from({ length: 50 }, (_, i) => ({ name: `Item ${i}`, kcal: 1, protein_g: 0, carbs_g: 0, fat_g: 0 }));
  assert.equal(M.normalizeEstimate({ is_food: true, confidence: "low", items: many }).items.length, M.MAX_ITEMS);
});

test("mealTotals sums the items", () => {
  assert.deepEqual(
    M.mealTotals([
      { kcal: 206, protein_g: 4.3, carbs_g: 44.5, fat_g: 0.4 },
      { kcal: 120, protein_g: 0, carbs_g: 0, fat_g: 13.6 },
    ]),
    { kcal: 326, protein_g: 4.3, carbs_g: 44.5, fat_g: 14 },
  );
  assert.deepEqual(M.mealTotals([]), { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });
});

// ─── request bodies ──────────────────────────────────────────────────────────

test("parseEstimateBody wants plain base64 of a supported image type", () => {
  assert.equal(M.parseEstimateBody({ image_base64: "QUJD", media_type: "image/jpeg" }).ok, true);
  for (const b of [
    null,
    [],
    {},
    { image_base64: "QUJD" },
    { image_base64: "QUJD", media_type: "image/heic" },
    { image_base64: "", media_type: "image/jpeg" },
    { image_base64: "data:image/jpeg;base64,QUJD", media_type: "image/jpeg" },
    { image_base64: "QUJ", media_type: "image/jpeg" },
    { image_base64: "QUJD", media_type: "image/jpeg", extra: 1 },
    { image_base64: "A".repeat(M.MAX_IMAGE_BASE64 + 4), media_type: "image/jpeg" },
  ]) {
    assert.equal(M.parseEstimateBody(b).ok, false, JSON.stringify(b)?.slice(0, 80));
  }
});

const KEY = "0b5c3f0e-8a1d-4e2b-9c7a-1234567890ab";
const goodMeal = () => ({
  client_key: KEY,
  eaten_date: "2030-01-05",
  eaten_time: "19:30",
  time_source: "photo",
  items: [
    { name: "Test pasta", portion: "2 cups", kcal: 520, protein_g: 18, carbs_g: 80, fat_g: 14 },
    { name: "Test salad", portion: null, kcal: 90, protein_g: 2, carbs_g: 6, fat_g: 7 },
  ],
  est_kcal: 640,
  confidence: "medium",
});

test("parsePhotoMealBody accepts a confirmed meal", () => {
  const r = M.parsePhotoMealBody(goodMeal());
  assert.equal(r.ok, true);
  assert.equal(r.value.items.length, 2);
  assert.equal(r.value.est_kcal, 640);
  const manual = M.parsePhotoMealBody({ ...goodMeal(), est_kcal: null, confidence: null, time_source: "manual" });
  assert.equal(manual.ok, true);
  assert.equal(manual.value.confidence, null);
});

test("parsePhotoMealBody refuses bad fields instead of clamping them", () => {
  const cases = [
    { ...goodMeal(), client_key: "not-a-uuid" },
    { ...goodMeal(), eaten_date: "2030-02-30" },
    { ...goodMeal(), eaten_time: "24:00" },
    { ...goodMeal(), eaten_time: "7:30" },
    { ...goodMeal(), time_source: "exif" },
    { ...goodMeal(), items: [] },
    { ...goodMeal(), items: [{ name: "", kcal: 1, protein_g: 0, carbs_g: 0, fat_g: 0 }] },
    { ...goodMeal(), items: [{ name: "Test", kcal: -1, protein_g: 0, carbs_g: 0, fat_g: 0 }] },
    { ...goodMeal(), items: [{ name: "Test", kcal: "100", protein_g: 0, carbs_g: 0, fat_g: 0 }] },
    { ...goodMeal(), items: [{ name: "Test", kcal: 100, protein_g: NaN, carbs_g: 0, fat_g: 0 }] },
    { ...goodMeal(), items: [{ name: "Test", kcal: M.MAX_ITEM_KCAL + 1, protein_g: 0, carbs_g: 0, fat_g: 0 }] },
    { ...goodMeal(), items: [{ name: "x".repeat(M.MAX_NAME + 1), kcal: 1, protein_g: 0, carbs_g: 0, fat_g: 0 }] },
    { ...goodMeal(), items: Array.from({ length: M.MAX_ITEMS + 1 }, () => ({ name: "T", kcal: 1, protein_g: 0, carbs_g: 0, fat_g: 0 })) },
    { ...goodMeal(), confidence: "sure" },
    { ...goodMeal(), est_kcal: "640" },
    { ...goodMeal(), kcal: 610 }, // totals are the server's to compute
    null,
    [],
  ];
  for (const b of cases) assert.equal(M.parsePhotoMealBody(b).ok, false, JSON.stringify(b)?.slice(0, 120));
});

test("parseDeleteBody wants exactly {meal_id: positive integer}", () => {
  assert.equal(M.parseDeleteBody({ meal_id: 12 }), 12);
  for (const b of [{}, { meal_id: 0 }, { meal_id: -1 }, { meal_id: 1.5 }, { meal_id: "12" }, { meal_id: 1, x: 1 }, null]) {
    assert.equal(M.parseDeleteBody(b), null, JSON.stringify(b));
  }
});

test("photoMealErrorMessage maps the missing table, the future-time guard and range checks", () => {
  assert.equal(M.photoMealErrorMessage("PGRST205").status, 503);
  assert.equal(M.photoMealErrorMessage("42P01").status, 503);
  assert.equal(M.photoMealErrorMessage("OXP01").status, 409);
  assert.equal(M.photoMealErrorMessage("23514").status, 400);
  assert.equal(M.photoMealErrorMessage("XX000"), null);
});

test("checkPortionRequest takes a per-route size cap", () => {
  const H = (o) => ({ get: (k) => o[k.toLowerCase()] ?? null });
  const h = { origin: "https://onyx.example.test", host: "onyx.example.test", "content-type": "application/json", "content-length": "5000" };
  assert.equal(P.checkPortionRequest(H(h), "https://onyx.example.test").status, 413);
  assert.equal(P.checkPortionRequest(H(h), "https://onyx.example.test", M.MAX_SAVE_BODY_BYTES), null);
});

// ─── when it was eaten ───────────────────────────────────────────────────────

test("behavioralDate: before 06:00 belongs to the day before; clockDate undoes it", () => {
  assert.equal(M.behavioralDate("2030-01-06", "01:30"), "2030-01-05");
  assert.equal(M.behavioralDate("2030-01-06", "05:59"), "2030-01-05");
  assert.equal(M.behavioralDate("2030-01-06", "06:00"), "2030-01-06");
  assert.equal(M.behavioralDate("2030-03-01", "00:10"), "2030-02-28");
  assert.equal(M.clockDate("2030-01-05", "01:30"), "2030-01-06");
  assert.equal(M.clockDate("2030-01-05", "19:30"), "2030-01-05");
});

// A minimal JPEG: SOI, optional APP0, APP1 "Exif" with a TIFF block, then SOS.
function tiffBlock(little, { dateTime, original }) {
  const n0 = (dateTime ? 1 : 0) + (original ? 1 : 0);
  const ifd0 = 8;
  const exifIfd = ifd0 + 2 + 12 * n0 + 4;
  let strings = exifIfd + (original ? 2 + 12 + 4 : 0);
  const buf = new ArrayBuffer(strings + 40);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  u8[0] = u8[1] = little ? 0x49 : 0x4d;
  dv.setUint16(2, 42, little);
  dv.setUint32(4, ifd0, little);
  dv.setUint16(ifd0, n0, little);
  const putStr = (s) => {
    const off = strings;
    for (let i = 0; i < s.length; i++) u8[off + i] = s.charCodeAt(i);
    strings += 20;
    return off;
  };
  let e = ifd0 + 2;
  if (dateTime) {
    dv.setUint16(e, 0x0132, little); dv.setUint16(e + 2, 2, little); dv.setUint32(e + 4, 20, little); dv.setUint32(e + 8, putStr(dateTime), little);
    e += 12;
  }
  if (original) {
    dv.setUint16(e, 0x8769, little); dv.setUint16(e + 2, 4, little); dv.setUint32(e + 4, 1, little); dv.setUint32(e + 8, exifIfd, little);
    e += 12;
  }
  dv.setUint32(e, 0, little);
  if (original) {
    const x = exifIfd + 2;
    dv.setUint16(exifIfd, 1, little);
    dv.setUint16(x, 0x9003, little); dv.setUint16(x + 2, 2, little); dv.setUint32(x + 4, 20, little); dv.setUint32(x + 8, putStr(original), little);
    dv.setUint32(x + 12, 0, little);
  }
  return [...u8];
}
function jpeg(tiff, { app0 = true } = {}) {
  const bytes = [0xff, 0xd8];
  if (app0) bytes.push(0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0));
  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const len = payload.length + 2;
  bytes.push(0xff, 0xe1, len >> 8, len & 0xff, ...payload, 0xff, 0xda, 0x00, 0x02);
  return Uint8Array.from(bytes);
}

test("exifCaptureTime reads DateTimeOriginal, little- and big-endian, ahead of DateTime", () => {
  const both = jpeg(tiffBlock(true, { dateTime: "2030:01:05 21:00:00", original: "2030:01:05 19:32:07" }));
  assert.deepEqual(M.exifCaptureTime(both), { date: "2030-01-05", time: "19:32" });
  const big = jpeg(tiffBlock(false, { original: "2030:12:31 23:59:59" }), { app0: false });
  assert.deepEqual(M.exifCaptureTime(big), { date: "2030-12-31", time: "23:59" });
  const onlyDt = jpeg(tiffBlock(true, { dateTime: "2030:06:01 07:05:00" }));
  assert.deepEqual(M.exifCaptureTime(onlyDt), { date: "2030-06-01", time: "07:05" });
});

test("exifCaptureTime: null for non-JPEG, no EXIF, zeroed dates and junk; never throws", () => {
  assert.equal(M.exifCaptureTime(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])), null);
  assert.equal(M.exifCaptureTime(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 2])), null);
  assert.equal(M.exifCaptureTime(jpeg(tiffBlock(true, { original: "0000:00:00 00:00:00" }))), null);
  assert.equal(M.exifCaptureTime(new Uint8Array(0)), null);
  const full = jpeg(tiffBlock(true, { original: "2030:01:05 19:32:07" }));
  for (let cut = 0; cut < full.length; cut += 7) M.exifCaptureTime(full.subarray(0, cut));
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) % 256;
  for (let i = 0; i < 300; i++) {
    const junk = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, ...Array.from({ length: 80 }, rnd)]);
    M.exifCaptureTime(junk);
  }
});

// ─── not counting a meal twice ───────────────────────────────────────────────

test("nearbyDeliveries: orders within 2 h of the meal, one per order", () => {
  const at = Date.parse("2030-01-06T00:30:00Z");
  const dishes = [
    { order_uuid: "o1", store_name: "Example Thai", completed_at: "2030-01-06T00:10:00Z" },
    { order_uuid: "o1", store_name: "Example Thai", completed_at: "2030-01-06T00:10:00Z" },
    { order_uuid: "o2", store_name: "Example Bagels", completed_at: "2030-01-05T14:00:00Z" },
    { order_uuid: "o3", store_name: "Example Untimed", completed_at: null },
  ];
  assert.deepEqual(M.nearbyDeliveries(dishes, at).map((d) => d.order_uuid), ["o1"]);
  assert.deepEqual(M.nearbyDeliveries(dishes, NaN), []);
});

const day = (behavioral_date, est_kcal) => ({ behavioral_date, est_kcal, est_protein_g: 10, est_carbs_g: 20, est_fat_g: 5 });

test("combineEstimateDays adds Uber Eats and photo meals per day and tags the source", () => {
  const rows = M.combineEstimateDays([day("2030-01-01", 900), day("2030-01-02", 700), day("2030-01-04", 0)], [day("2030-01-02", 500), day("2030-01-03", 400), day("2030-01-05", -1)]);
  assert.deepEqual(
    rows.map((r) => [r.behavioral_date, r.est_kcal, r.est_protein_g, r.nutrition_source]),
    [
      ["2030-01-01", 900, 10, "uber_eats"],
      ["2030-01-02", 1200, 20, "uber_eats+photo"],
      ["2030-01-03", 400, 10, "photo"],
    ],
  );
});

test("a Cronometer day still wins over both estimates", () => {
  const logged = [{ calendar_date: "2030-01-02", calories: 2100, nutrition_source: "cronometer" }];
  const merged = P.mergeDeliveryEstimates(logged, M.combineEstimateDays([day("2030-01-02", 700)], [day("2030-01-02", 500), day("2030-01-03", 400)]));
  assert.deepEqual(merged.map((r) => [r.calendar_date, r.calories, r.nutrition_source]), [
    ["2030-01-02", 2100, "cronometer"],
    ["2030-01-03", 400, "photo"],
  ]);
});

test("source labels", () => {
  assert.equal(M.daySourceLabel("cronometer"), "CRONOMETER");
  assert.equal(M.daySourceLabel("uber_eats"), "UBER EATS EST.");
  assert.equal(M.daySourceLabel("photo"), "PHOTO EST.");
  assert.equal(M.daySourceLabel("uber_eats+photo"), "UBER EATS + PHOTO EST.");
  assert.equal(M.rangeSourceLabel([]), "CRONOMETER");
  assert.equal(M.rangeSourceLabel(["cronometer", "mfp"]), "CRONOMETER");
  assert.equal(M.rangeSourceLabel(["uber_eats", "uber_eats"]), "UBER EATS EST.");
  assert.equal(M.rangeSourceLabel(["cronometer", "photo"]), "CRONOMETER + PHOTO EST.");
  assert.equal(M.rangeSourceLabel(["uber_eats", "photo"]), "UBER EATS + PHOTO EST.");
});

// ─── getNutrition ────────────────────────────────────────────────────────────

function fakeTables(answers) {
  const calls = [];
  const client = {
    from(table) {
      const st = { table, ops: [] };
      calls.push(st);
      const b = new Proxy(
        {},
        {
          get(_, prop) {
            if (prop === "then") {
              const a = answers[table] ?? { data: [], error: null };
              return (res, rej) => Promise.resolve(a).then(res, rej);
            }
            return (...args) => {
              st.ops.push([prop, ...args]);
              return b;
            };
          },
        },
      );
      return b;
    },
  };
  return { client, calls };
}

test("getNutrition adds photo meals to non-Cronometer days", async () => {
  const db = fakeTables({
    daily_health_matrix_behavioral_mat: { data: [{ calendar_date: "2030-01-01", calories: 1500, nutrition_source: "cronometer" }], error: null },
    delivery_nutrition_daily: { data: [day("2030-01-02", 800)], error: null },
    photo_meal_daily: { data: [day("2030-01-01", 300), day("2030-01-02", 450), day("2030-01-03", 600)], error: null },
  });
  const Q = loadTs("lib/queries.ts", { "./supabase": { supabase: db.client } });
  const rows = await Q.getNutrition(30);
  assert.deepEqual(rows.map((r) => [r.calendar_date, r.calories, r.nutrition_source]), [
    ["2030-01-01", 1500, "cronometer"],
    ["2030-01-02", 1250, "uber_eats+photo"],
    ["2030-01-03", 600, "photo"],
  ]);
  const photo = db.calls.find((c) => c.table === "photo_meal_daily");
  assert.ok(photo.ops.some((o) => o[0] === "gt" && o[1] === "est_kcal" && o[2] === 0));
});

test("getNutrition still works before sql/photo_meals.sql is applied (missing view)", async () => {
  const db = fakeTables({
    daily_health_matrix_behavioral_mat: { data: [{ calendar_date: "2030-01-01", calories: 1500, nutrition_source: "cronometer" }], error: null },
    delivery_nutrition_daily: { data: [day("2030-01-02", 800)], error: null },
    photo_meal_daily: { data: null, error: { code: "PGRST205", message: "Could not find the table" } },
    photo_meals: { data: null, error: { code: "42P01", message: "relation does not exist" } },
  });
  const Q = loadTs("lib/queries.ts", { "./supabase": { supabase: db.client } });
  const rows = await Q.getNutrition(30);
  assert.deepEqual(rows.map((r) => r.nutrition_source), ["cronometer", "uber_eats"]);
  const none = await Q.getPhotoMealsForDays(["2030-01-02"]);
  assert.deepEqual(none, []);
});

// ─── route handlers ──────────────────────────────────────────────────────────

class FakeResponse {
  constructor(body, status) { this.body = body; this.status = status; }
  static json(body, init) { return new FakeResponse(body, (init && init.status) || 200); }
}
const ORIGIN = "https://onyx.example.test";
const headers = { origin: ORIGIN, host: "onyx.example.test", "content-type": "application/json" };
const H = (o) => ({ get: (k) => (Object.prototype.hasOwnProperty.call(o, k.toLowerCase()) ? o[k.toLowerCase()] : null) });
const req = (body, h = headers) => ({ headers: H(h), nextUrl: { origin: ORIGIN }, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });

function fakeWriteDb({ existing = [], failWith = null } = {}) {
  const calls = [];
  const rows = [...existing];
  let seq = 100;
  const client = {
    from(table) {
      const st = { table, op: null, payload: null, opts: null, filters: [] };
      const b = {
        upsert(p, o) { st.op = "upsert"; st.payload = p; st.opts = o; return b; },
        delete() { st.op = "delete"; return b; },
        select() { if (!st.op) st.op = "select"; return b; },
        eq(c, v) { st.filters.push([c, v]); return b; },
        limit() { return b; },
        then(res, rej) {
          calls.push(st);
          if (failWith) return Promise.resolve({ data: null, error: failWith }).then(res, rej);
          let data = [];
          if (st.op === "upsert") {
            if (!rows.some((r) => r.client_key === st.payload.client_key)) {
              const row = { meal_id: ++seq, ...st.payload, eaten_at: "2030-01-06T00:30:00Z" };
              rows.push(row);
              data = [row];
            }
          } else if (st.op === "delete") {
            data = rows.filter((r) => st.filters.every(([c, v]) => r[c] === v));
            for (const d of data) rows.splice(rows.indexOf(d), 1);
          } else {
            data = rows.filter((r) => st.filters.every(([c, v]) => r[c] === v));
          }
          return Promise.resolve({ data, error: null }).then(res, rej);
        },
      };
      return b;
    },
  };
  return { client, calls, rows };
}

function loadSave(db, revalidated = []) {
  return loadTs("app/api/nutrition/photo-meals/route.ts", {
    "next/server": { NextResponse: FakeResponse },
    "next/cache": { revalidatePath: (p) => revalidated.push(p) },
    "@supabase/supabase-js": { createClient: () => db.client },
  });
}

test("POST saves server-summed totals, upserts on client_key, and a double tap saves once", async () => {
  const db = fakeWriteDb();
  const revalidated = [];
  const route = loadSave(db, revalidated);
  const first = await route.POST(req(goodMeal()));
  assert.equal(first.status, 200);
  assert.equal(first.body.kcal, 610);
  const up = db.calls.find((c) => c.op === "upsert");
  assert.equal(up.table, "photo_meals");
  assert.deepEqual(up.opts, { onConflict: "client_key", ignoreDuplicates: true });
  assert.equal(up.payload.kcal, 610);
  assert.equal(up.payload.protein_g, 20);
  assert.equal(up.payload.model, M.PHOTO_MEAL_MODEL);
  assert.ok(!("eaten_at" in up.payload), "eaten_at is the trigger's to compute");
  const again = await route.POST(req(goodMeal()));
  assert.equal(again.status, 200);
  assert.equal(again.body.meal_id, first.body.meal_id);
  assert.equal(db.rows.length, 1);
  assert.deepEqual(revalidated, ["/nutrition", "/nutrition"]);
});

test("POST refusals never reach the database; database errors map to clear answers", async () => {
  for (const [r, status] of [
    [req(goodMeal(), { ...headers, origin: "https://evil.example.test" }), 403],
    [req(goodMeal(), { ...headers, "content-type": "text/plain" }), 415],
    [req("not json"), 400],
    [req({ ...goodMeal(), items: [] }), 400],
    [req(" ".repeat(M.MAX_SAVE_BODY_BYTES + 1)), 413],
  ]) {
    const db = fakeWriteDb();
    const res = await loadSave(db).POST(r);
    assert.equal(res.status, status);
    assert.equal(db.calls.length, 0);
  }
  const pending = await loadSave(fakeWriteDb({ failWith: { code: "PGRST205", message: "x" } })).POST(req(goodMeal()));
  assert.equal(pending.status, 503);
  const future = await loadSave(fakeWriteDb({ failWith: { code: "OXP01", message: "x" } })).POST(req(goodMeal()));
  assert.equal(future.status, 409);
  const broken = await loadSave(fakeWriteDb({ failWith: { code: "XX000", message: "secret detail" } })).POST(req(goodMeal()));
  assert.equal(broken.status, 500);
  assert.ok(!JSON.stringify(broken.body).includes("secret detail"));
});

test("DELETE removes one meal by id; unknown id is 404", async () => {
  const db = fakeWriteDb({ existing: [{ meal_id: 5, client_key: KEY }] });
  const route = loadSave(db);
  assert.equal((await route.DELETE(req({ meal_id: 9 }))).status, 404);
  const ok = await route.DELETE(req({ meal_id: 5 }));
  assert.equal(ok.status, 200);
  assert.equal(db.rows.length, 0);
  assert.equal((await route.DELETE(req({ meal_id: "5" }))).status, 400);
});

function loadEstimate(create) {
  const sent = [];
  const route = loadTs("app/api/nutrition/photo-meals/estimate/route.ts", {
    "next/server": { NextResponse: FakeResponse },
    "@anthropic-ai/sdk": {
      __esModule: true,
      default: class {
        constructor() {
          this.messages = { create: async (p) => { sent.push(p); return create(p); } };
        }
      },
    },
  });
  return { route, sent };
}
const photo = { image_base64: "QUJD", media_type: "image/jpeg" };

test("estimate: sends the photo to the chat model with a JSON schema and returns the normalized list", async () => {
  const answer = { is_food: true, confidence: "high", items: [{ name: "Test yogurt", portion: "1 cup", kcal: 149.6, protein_g: 8.5, carbs_g: 11.4, fat_g: 8 }] };
  const { route, sent } = loadEstimate(() => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(answer) }] }));
  const res = await route.POST(req(photo));
  assert.equal(res.status, 200);
  assert.equal(res.body.items[0].kcal, 150);
  assert.equal(res.body.totals.kcal, 150);
  assert.equal(sent[0].model, M.PHOTO_MEAL_MODEL);
  assert.equal(sent[0].output_config.format.type, "json_schema");
  assert.equal(sent[0].messages[0].content[0].type, "image");
  assert.equal(sent[0].messages[0].content[0].source.data, "QUJD");
});

test("estimate: bad requests never call Claude; refusals and junk answers are clear errors", async () => {
  const { route, sent } = loadEstimate(() => { throw new Error("should not be called"); });
  assert.equal((await route.POST(req({ image_base64: "QUJD", media_type: "image/heic" }))).status, 400);
  assert.equal((await route.POST(req(photo, { ...headers, origin: "https://evil.example.test" }))).status, 403);
  assert.equal(sent.length, 0);
  const refused = loadEstimate(() => ({ stop_reason: "refusal", content: [] }));
  assert.equal((await refused.route.POST(req(photo))).status, 422);
  const junk = loadEstimate(() => ({ stop_reason: "end_turn", content: [{ type: "text", text: "not json" }] }));
  assert.equal((await junk.route.POST(req(photo))).status, 502);
  const down = loadEstimate(() => { throw new Error("upstream 529"); });
  const r = await down.route.POST(req(photo));
  assert.equal(r.status, 502);
  assert.ok(!JSON.stringify(r.body).includes("529"));
});

test("middleware: the photo-meal routes are session-only (not in isCiRoute)", () => {
  const src = fs.readFileSync(path.join(SRC, "middleware.ts"), "utf8");
  const m = /function isCiRoute\(pathname: string\): boolean \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(m, "isCiRoute not found");
  const isCiRoute = new Function("pathname", m[1]);
  for (const p of ["/api/nutrition/photo-meals", "/api/nutrition/photo-meals/estimate"]) assert.equal(isCiRoute(p), false, p);
});
