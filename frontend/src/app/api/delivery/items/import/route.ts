import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { buildOrderItemRows, customizationsText, type HarvestOrder, type ItemCustomization, type ItemProvider } from "@/lib/delivery";
import { estimateQuality } from "@/lib/delivery-estimate-quality";
import {
  attemptTimeoutMs,
  callWithCountedRetries,
  chooseModel,
  isRetryableModelError,
  logPilotObservation,
  MODEL_CALL_RETRIES,
  pilotFromEnv,
  pilotObservation,
  retryAfterMs,
  routeDeadline,
  selectEstimateBatch,
  type Arm,
  type RouteDeadline,
} from "@/lib/model-routing";

// Uber Eats item harvester endpoint (tools/ubereats_harvest/harvest.mjs on the collector PC).
// Auth: the middleware CI carve-out (x-onyx-ci-token) or a Supabase session.
//
// One POST does one of three things, chosen by the body:
//   { orders: [...] }      upsert cart lines into pds.delivery_order_items
//   { estimate: true }     estimate nutrition for up to BATCH not-yet-estimated dishes
//                          (one Claude call) → pds.delivery_item_nutrition; returns `remaining`
//   { done: true, ... }    write the ubereats|items heartbeat for the run (gopuff|items when provider is 'gopuff')
//   { error: "..." }       harvester-side failure (signed out, blocked) → failed heartbeat
// The harvester calls `estimate` in a loop until remaining is 0, so no single
// request has to outlive the function time limit.

export const maxDuration = 60;

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

// Model + effort come from lib/model-routing.ts (baseline, or the bounded pilot when it is on).
const BATCH = 25;

interface Body {
  /** Which harvester is posting: 'gopuff' (tools/gopuff_harvest) or, when absent, Uber Eats. Chooses the provider of the rows and the heartbeat source. */
  provider?: string;
  /** Retry only the dishes of this arm (named in a failed batch's answer); offset then counts within it. */
  arm?: Arm;
  orders?: HarvestOrder[];
  estimate?: boolean;
  /** estimate only: dishes per call (1..BATCH) and how many queue rows to step past. */
  limit?: number;
  offset?: number;
  /** Dishes already failed per arm; each arm's first N queued dishes are stepped past (full batches). */
  skips?: { baseline?: number; pilot?: number };
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
  // The function budget counts from here, so the queue read before the model call is inside it.
  const deadline = routeDeadline(startedAt.getTime(), Date.now());
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (body.provider !== undefined && body.provider !== "gopuff" && body.provider !== "uber_eats") {
    return NextResponse.json({ error: "unknown provider" }, { status: 400 });
  }
  const provider: ItemProvider = body.provider === "gopuff" ? "gopuff" : "uber_eats";

  if (body.error) {
    await heartbeat(provider, startedAt, "failed", 0, String(body.error).slice(0, 500));
    return NextResponse.json({ heartbeat: "failed", error: body.error });
  }

  try {
    if (body.orders) {
      if (!Array.isArray(body.orders)) return NextResponse.json({ error: "orders must be an array" }, { status: 400 });
      return NextResponse.json(await importOrders(body.orders, provider));
    }
    if (body.estimate) {
      const only = body.arm === "baseline" || body.arm === "pilot" ? body.arm : undefined;
      return NextResponse.json(await estimateBatch(deadline, body.limit, body.offset, only, body.skips));
    }
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
        provider,
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
    // A failed estimate batch names its arm and where that arm's dishes start, so the harvester's
    // one-dish retries stay inside the failed batch's arm.
    const extra = e instanceof EstimateError ? { arm: e.arm, arm_offset: e.armOffset } : {};
    // arm first: the harvester reads it from the start of a message it cuts at 300 characters.
    return NextResponse.json({ ...extra, error: msg }, { status: 500 });
  }
}

class EstimateError extends Error {
  constructor(
    message: string,
    readonly arm: Arm,
    readonly armOffset: number,
  ) {
    super(message);
  }
}

async function importOrders(orders: HarvestOrder[], provider: ItemProvider) {
  // eaten_fraction is deliberately absent from these rows (see buildOrderItemRows), so the upsert
  // never resets a portion Riley set on /nutrition or /check-in.
  const rows = buildOrderItemRows(orders, provider);
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase
      .from("delivery_order_items")
      .upsert(rows.slice(i, i + 500), { onConflict: "provider,order_uuid,item_key" });
    if (error) throw new Error(`delivery_order_items upsert: ${error.message}`);
  }
  return { orders: orders.length, items: rows.length };
}

function clampSkip(v: unknown): number {
  return Math.min(500, Math.max(0, Math.floor(Number(v)) || 0));
}

async function estimateBatch(deadline: RouteDeadline, limit?: number, offset?: number, only?: Arm, skips?: Body["skips"]) {
  // `offset` lets the harvester step past a dish that cannot be estimated (it retries a failed
  // batch one dish at a time), so one bad dish cannot block the queue forever.
  const n = Math.min(BATCH, Math.max(1, Math.floor(Number(limit)) || BATCH));
  const from = Math.min(500, Math.max(0, Math.floor(Number(offset)) || 0));
  // Each dish has its own arm (by its est_key), and one call uses one model, so a batch holds only
  // the dishes of the first dish's arm; the others stay queued for a later call. A dish therefore
  // gets the same model in a full batch and in the harvester's one-dish retry, and a failed batch
  // is counted against the arm that ran it. A retry passes `only` (the failed batch's arm) so it
  // never calls the model for the other arm's dishes. Without a pilot every dish is baseline.
  const pickedAt = Date.now();
  const pilot = pilotFromEnv(pickedAt);
  const armOf = (r: { est_key: unknown }): Arm => chooseModel("delivery_estimate", String(r.est_key), pilot, pickedAt).arm;
  // Dishes that failed alone are stepped past per arm, so a failure in one arm never moves the
  // other arm's queue. Their positions count in the arm's offset so a later retry stays aligned.
  const skipN = { baseline: clampSkip(skips?.baseline), pilot: clampSkip(skips?.pilot) };
  // Rows to read: with a pilot (or a retry inside one arm) the arms interleave, so a long queue is
  // read to find n dishes of one arm; without one every dish is baseline and the read stops at the
  // dishes stepped past plus one batch. The batch itself is always at most n (selectEstimateBatch).
  // Capped at 1000 rows, PostgREST's default max-rows (a larger read would be cut there anyway).
  const readN = only || pilot?.tasks.has("delivery_estimate") ? 1000 : Math.min(1000, from + skipN.baseline + skipN.pilot + n);
  const { data, error, count } = await supabase
    .from("delivery_items_unestimated")
    .select("est_key,store_name,merchant_kind,title,customizations,price,currency", { count: "exact" })
    .order("est_key")
    .limit(readN)
    .abortSignal(deadline.signal);
  if (error) throw new Error(`delivery_items_unestimated: ${error.message}`);

  let queue = data ?? [];
  if (!only && (skipN.baseline || skipN.pilot)) {
    const seen = { baseline: 0, pilot: 0 };
    queue = queue.filter((r) => {
      const a = armOf(r);
      return seen[a]++ >= skipN[a];
    });
  }
  const picked0 = selectEstimateBatch(queue, from, n, armOf, only);
  const picked = picked0 && !only ? { ...picked0, armOffset: picked0.armOffset + skipN[picked0.arm] } : picked0;
  // Nothing at this offset: the dishes stepped past are still in the queue, so report them. On a
  // retry inside one arm (`only`) this means that arm has no dish left at the offset: the
  // harvester then leaves its one-dish retries instead of counting a skipped dish.
  if (!picked) return { estimated: 0, remaining: count ?? 0, ...(only ? { arm_exhausted: true } : {}) };
  const { todo } = picked;
  const choice = chooseModel("delivery_estimate", String(todo[0].est_key), pilot, pickedAt);

  const input = todo.map((r, id) => ({
    id,
    store: r.store_name as string,
    item: r.title as string,
    customizations: customizationsText(r.customizations as ItemCustomization[] | null) || undefined,
    price: r.price != null ? `${r.price} ${r.currency ?? ""}`.trim() : undefined,
  }));

  const started = Date.now();
  let res: Anthropic.Message | null = null;
  // Provider attempts, counted before each one (retries included), so an attempt that threw counts.
  let attempts = 0;
  // One observation per request, written once the outcome is known: after the estimates are
  // stored, or with 0 accepted when the call, the reply or the save failed.
  const observe = (accepted: number, unresolved = false) =>
    logPilotObservation(
      pilotObservation("delivery_estimate", choice, pilot, {
        usage: res ? [res.usage] : [],
        latencyMs: Date.now() - started,
        ok: accepted === todo.length,
        units: todo.length,
        accepted,
        unresolved,
        calls: attempts,
      }),
    );
  let parsed: { items: Estimate[] };
  try {
    // The SDK's default timeout and retries outlast the 60 s function limit, which would kill the
    // request before it could write its observation. So the route retries the errors the SDK
    // would (MODEL_CALL_RETRIES, honouring Retry-After, counting each attempt) only while the
    // model deadline allows, and `modelSignal` ends the call, body read included, inside it.
    res = await callWithCountedRetries(
      () =>
        anthropic.messages.create(
          {
            model: choice.model,
            max_tokens: 16000,
            system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
            output_config: { effort: choice.effort ?? "low", format: { type: "json_schema", schema: SCHEMA } },
            messages: [{ role: "user", content: JSON.stringify({ items: input }) }],
          },
          { timeout: attemptTimeoutMs(deadline.modelAt, Date.now()), maxRetries: 0, signal: deadline.modelSignal },
        ),
      {
        retries: MODEL_CALL_RETRIES,
        isRetryable: (e) => isRetryableModelError(e, (x) => x instanceof Anthropic.APIConnectionError),
        retryAfterMs: (e) => retryAfterMs(e, Date.now()),
        deadlineMs: deadline.modelAt,
        signal: deadline.modelSignal,
        onAttempt: () => {
          attempts++;
        },
      },
    );
    if (res.stop_reason !== "end_turn") {
      throw new Error(`estimator stopped with ${res.stop_reason}`);
    }
    const text = res.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
    if (!text) throw new Error("estimator returned no text block");
    parsed = JSON.parse(text) as { items: Estimate[] };
  } catch (e) {
    observe(0);
    throw new EstimateError(e instanceof Error ? e.message : String(e), picked.arm, picked.armOffset);
  }

  const rows = [];
  const used = new Set<number>();
  for (const e of Array.isArray(parsed.items) ? parsed.items : []) {
    const src = todo[e.id];
    if (!src || used.has(e.id)) continue; // id out of range, or returned twice
    used.add(e.id);
    // Quality gate (lib/delivery-estimate-quality.ts): an estimate that fails a rule is never
    // stored, and is not counted as accepted, so the pilot's cost gate sees it like any other
    // failed result (the harvester retries the dish one at a time, as with a model failure).
    const quality = estimateQuality(e);
    if (!quality.usable) continue;
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
      model: choice.model,
    });
  }
  if (rows.length) {
    // ignoreDuplicates: a row someone hand-corrected is never overwritten by a re-estimate
    const { error: upErr } = await supabase
      .from("delivery_item_nutrition")
      .upsert(rows, { onConflict: "est_key", ignoreDuplicates: true })
      .abortSignal(deadline.signal);
    if (upErr) {
      // An aborted or failed request may still have committed on the server: the stored result is
      // unknown, so the observation is unresolved (blocks cost promotion) rather than a clean failure.
      observe(0, true);
      throw new EstimateError(`delivery_item_nutrition upsert: ${upErr.message}`, picked.arm, picked.armOffset);
    }
  }
  observe(rows.length);
  return { estimated: rows.length, remaining: Math.max(0, (count ?? todo.length) - rows.length) };
}

async function heartbeat(provider: ItemProvider, startedAt: Date, status: "success" | "partial" | "failed", records: number, error: string | null) {
  const end = new Date();
  const { error: e } = await supabase.from("sync_log").insert({
    source: provider === "gopuff" ? "gopuff" : "ubereats",
    data_type: "items",
    status,
    records_synced: records,
    sync_start: startedAt.toISOString(),
    sync_end: end.toISOString(),
    duration_seconds: Math.max(0, Math.round((end.getTime() - startedAt.getTime()) / 1000)),
    error_message: error,
  });
  if (e) console.error(`${provider} heartbeat failed:`, e.message);
}
