import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { buildOrderItemRows, customizationsText, type HarvestOrder, type ItemCustomization } from "@/lib/delivery";

// Uber Eats item harvester endpoint (tools/ubereats_harvest/harvest.mjs on Riley's PC).
// Auth: the middleware CI carve-out (x-onyx-ci-token) or a Supabase session.
//
// One POST does one of three things, chosen by the body:
//   { orders: [...] }      upsert cart lines into pds.delivery_order_items
//   { estimate: true }     estimate nutrition for up to BATCH not-yet-estimated dishes
//                          (one Claude call) → pds.delivery_item_nutrition; returns `remaining`
//   { done: true, ... }    write the ubereats|items heartbeat for the run
//   { error: "..." }       harvester-side failure (signed out, blocked) → failed heartbeat
// The harvester calls `estimate` in a loop until remaining is 0, so no single
// request has to outlive the function time limit.

export const maxDuration = 60;

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const MODEL = "claude-opus-5-5";
const BATCH = 25;

interface Body {
  orders?: HarvestOrder[];
  estimate?: boolean;
  /** estimate only: dishes per call (1..BATCH) and how many queue rows to step past. */
  limit?: number;
  offset?: number;
  done?: boolean;
  error?: string;
  stats?: { orders?: number; items?: number; pages?: number; estimated?: number; estimateError?: string | null };
}

const SYSTEM = `You estimate nutrition for items ordered from restaurants and stores through a food-delivery app, for one person's private health log.

For each input item return an estimate for ONE unit exactly as sold (quantity 1), including the listed customizations (size, add-ons, sides, sauces). The price is a hint to portion size and to whether the item is a full entree, a side or an add-on.

Rules:
- kind: "food" for anything eaten, "drink" for non-alcoholic drinks, "alcohol" for alcoholic drinks, "non_food" for anything not consumed (utensils, bags, fees, household or pharmacy goods).
- kcal, protein_g, carbs_g, fat_g: the whole unit as served, not per 100 g. Use 0 for non_food.
- alcohol_g: grams of pure alcohol in the unit, 0 when none.
- basis: "published" when the item is from a chain whose own nutrition figures you know for this item; otherwise "typical" (your estimate for this dish type at a restaurant portion).
- confidence: "high" for published chain items, "medium" for a clearly described dish, "low" when the name is vague, a combo or platter of unknown size, or a family-size / shareable item.
- Restaurant portions are large and cooked with fat; do not estimate as if home-cooked.
- A multi-pack or a bottle (for example a 12-pack, a 750 ml bottle) is estimated as the WHOLE unit sold.
- Return one result per input item, with the same id. Numbers only, no ranges.`;

const SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          kind: { type: "string", enum: ["food", "drink", "alcohol", "non_food"] },
          kcal: { type: "number" },
          protein_g: { type: "number" },
          carbs_g: { type: "number" },
          fat_g: { type: "number" },
          alcohol_g: { type: "number" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          basis: { type: "string", enum: ["published", "typical"] },
        },
        required: ["id", "kind", "kcal", "protein_g", "carbs_g", "fat_g", "alcohol_g", "confidence", "basis"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

interface Estimate {
  id: number;
  kind: "food" | "drink" | "alcohol" | "non_food";
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  alcohol_g: number;
  confidence: "high" | "medium" | "low";
  basis: "published" | "typical";
}

export async function POST(req: NextRequest) {
  const startedAt = new Date();
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (body.error) {
    await heartbeat(startedAt, "failed", 0, String(body.error).slice(0, 500));
    return NextResponse.json({ heartbeat: "failed", error: body.error });
  }

  try {
    if (body.orders) {
      if (!Array.isArray(body.orders)) return NextResponse.json({ error: "orders must be an array" }, { status: 400 });
      return NextResponse.json(await importOrders(body.orders));
    }
    if (body.estimate) return NextResponse.json(await estimateBatch(body.limit, body.offset));
    if (body.done) {
      // Count the queue here instead of trusting a number from the harvester: a run whose
      // estimate calls all failed used to report 0 left and was recorded as a success.
      const s = body.stats ?? {};
      const { count, error } = await supabase
        .from("delivery_items_unestimated")
        .select("est_key", { count: "exact", head: true });
      if (error) throw new Error(`delivery_items_unestimated count: ${error.message}`);
      const left = count ?? 0;
      const why = s.estimateError ? `; last estimator error: ${String(s.estimateError).slice(0, 300)}` : "";
      const status = left > 0 ? "partial" : "success";
      await heartbeat(
        startedAt,
        status,
        Number.isFinite(Number(s.items)) ? Number(s.items) : 0,
        left > 0 ? `${left} dish(es) still without a nutrition estimate${why}` : null,
      );
      return NextResponse.json({ heartbeat: status, unestimated: left });
    }
    return NextResponse.json({ error: "nothing to do: send orders, estimate, done or error" }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("delivery items import failed:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

async function importOrders(orders: HarvestOrder[]) {
  // eaten_fraction is deliberately absent from these rows (see buildOrderItemRows), so the upsert
  // never resets a portion Riley set on /nutrition or /check-in.
  const rows = buildOrderItemRows(orders);
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase
      .from("delivery_order_items")
      .upsert(rows.slice(i, i + 500), { onConflict: "provider,order_uuid,item_key" });
    if (error) throw new Error(`delivery_order_items upsert: ${error.message}`);
  }
  return { orders: orders.length, items: rows.length };
}

async function estimateBatch(limit?: number, offset?: number) {
  // `offset` lets the harvester step past a dish that cannot be estimated (it retries a failed
  // batch one dish at a time), so one bad dish cannot block the queue forever.
  const n = Math.min(BATCH, Math.max(1, Math.floor(Number(limit)) || BATCH));
  const from = Math.min(500, Math.max(0, Math.floor(Number(offset)) || 0));
  const { data, error, count } = await supabase
    .from("delivery_items_unestimated")
    .select("est_key,store_name,merchant_kind,title,customizations,price,currency", { count: "exact" })
    .order("est_key")
    .limit(from + n);
  if (error) throw new Error(`delivery_items_unestimated: ${error.message}`);
  const todo = (data ?? []).slice(from);
  // Nothing at this offset: the dishes stepped past are still in the queue, so report them.
  if (todo.length === 0) return { estimated: 0, remaining: count ?? 0 };

  const input = todo.map((r, id) => ({
    id,
    store: r.store_name as string,
    item: r.title as string,
    customizations: customizationsText(r.customizations as ItemCustomization[] | null) || undefined,
    price: r.price != null ? `${r.price} ${r.currency ?? ""}`.trim() : undefined,
  }));

  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content: JSON.stringify({ items: input }) }],
  });
  if (res.stop_reason !== "end_turn") {
    throw new Error(`estimator stopped with ${res.stop_reason}`);
  }
  const text = res.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
  if (!text) throw new Error("estimator returned no text block");
  const parsed = JSON.parse(text) as { items: Estimate[] };

  const rows = [];
  const used = new Set<number>();
  for (const e of Array.isArray(parsed.items) ? parsed.items : []) {
    const src = todo[e.id];
    if (!src || used.has(e.id)) continue; // id out of range, or returned twice
    used.add(e.id);
    const zero = e.kind === "non_food";
    rows.push({
      est_key: src.est_key,
      store_name: src.store_name,
      title: src.title,
      customizations_text: customizationsText(src.customizations as ItemCustomization[] | null) || null,
      kind: e.kind,
      kcal: zero ? 0 : Math.max(0, e.kcal),
      protein_g: zero ? 0 : Math.max(0, e.protein_g),
      carbs_g: zero ? 0 : Math.max(0, e.carbs_g),
      fat_g: zero ? 0 : Math.max(0, e.fat_g),
      alcohol_g: zero ? 0 : Math.max(0, e.alcohol_g),
      confidence: e.confidence,
      basis: e.basis,
      model: MODEL,
    });
  }
  if (rows.length) {
    // ignoreDuplicates: a row someone hand-corrected is never overwritten by a re-estimate
    const { error: upErr } = await supabase
      .from("delivery_item_nutrition")
      .upsert(rows, { onConflict: "est_key", ignoreDuplicates: true });
    if (upErr) throw new Error(`delivery_item_nutrition upsert: ${upErr.message}`);
  }
  return { estimated: rows.length, remaining: Math.max(0, (count ?? todo.length) - rows.length) };
}

async function heartbeat(startedAt: Date, status: "success" | "partial" | "failed", records: number, error: string | null) {
  const end = new Date();
  const { error: e } = await supabase.from("sync_log").insert({
    source: "ubereats",
    data_type: "items",
    status,
    records_synced: records,
    sync_start: startedAt.toISOString(),
    sync_end: end.toISOString(),
    duration_seconds: Math.max(0, Math.round((end.getTime() - startedAt.getTime()) / 1000)),
    error_message: error,
  });
  if (e) console.error("ubereats heartbeat failed:", e.message);
}
