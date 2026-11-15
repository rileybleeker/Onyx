import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { checkPortionRequest } from "@/lib/delivery-portion";
import {
  MAX_ESTIMATE_BODY_BYTES,
  PHOTO_MEAL_MODEL,
  mealTotals,
  normalizeEstimate,
  parseEstimateBody,
} from "@/lib/photo-meal";

// POST /api/nutrition/photo-meals/estimate   body {image_base64, media_type}
// One plate photo -> Claude vision -> the foods it sees with kcal and macros, for Riley to confirm or edit
// on /nutrition. Saves NOTHING (the confirmed meal goes to POST /api/nutrition/photo-meals) and the photo is
// not kept: it lives only for this call. Owner session only (middleware; not in isCiRoute) plus the same
// same-origin / JSON / size checks as the Uber Eats portion routes. The API key stays on the server.

export const maxDuration = 60;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const SYSTEM = `You estimate the food in one photo for one person's private food log. The person will check and correct your list before it is saved.

Rules:
- List each distinct food or drink you can see as its own item, with a short plain name ("grilled chicken thigh", "white rice", "side salad with vinaigrette"). At most 12 items; group tiny garnishes into the dish they sit on.
- portion: the amount in plain words with a unit ("1 cup", "about 150 g", "2 slices").
- kcal, protein_g, carbs_g, fat_g: for that portion as it appears, not per 100 g. Count visible oil, butter, dressing and sauce in the item they are on.
- Size portions from what is in the photo: plate and utensil size, packaging, labels, a menu.
- confidence: "high" for packaged or labelled food and standard servings, "medium" for a clearly visible plate, "low" when foods are hidden or mixed (stews, burritos, casseroles) or the amount is hard to judge.
- is_food: false when the photo shows no food or drink; then return an empty items list.
- Numbers only, no ranges. No micronutrients.`;

const SCHEMA = {
  type: "object",
  properties: {
    is_food: { type: "boolean" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          portion: { type: "string" },
          kcal: { type: "number" },
          protein_g: { type: "number" },
          carbs_g: { type: "number" },
          fat_g: { type: "number" },
        },
        required: ["name", "portion", "kcal", "protein_g", "carbs_g", "fat_g"],
        additionalProperties: false,
      },
    },
  },
  required: ["is_food", "confidence", "items"],
  additionalProperties: false,
};

export async function POST(req: NextRequest) {
  const refused = checkPortionRequest(req.headers, req.nextUrl.origin, MAX_ESTIMATE_BODY_BYTES);
  if (refused) return NextResponse.json({ error: refused.error }, { status: refused.status });

  let text: string;
  try {
    text = await req.text();
  } catch {
    return NextResponse.json({ error: "could not read body" }, { status: 400 });
  }
  if (text.length > MAX_ESTIMATE_BODY_BYTES) return NextResponse.json({ error: "photo too large" }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const parsed = parseEstimateBody(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  let res: Anthropic.Message;
  try {
    res = await anthropic.messages.create({
      model: PHOTO_MEAL_MODEL,
      max_tokens: 8000,
      system: SYSTEM,
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: parsed.value.media_type, data: parsed.value.image_base64 } },
            { type: "text", text: "Estimate this meal." },
          ],
        },
      ],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("photo meal estimate failed:", msg);
    return NextResponse.json({ error: "The estimate failed. Try again." }, { status: 502 });
  }

  if (res.stop_reason === "refusal") {
    return NextResponse.json({ error: "Claude could not estimate this photo." }, { status: 422 });
  }
  if (res.stop_reason !== "end_turn") {
    console.error("photo meal estimate stopped with", res.stop_reason);
    return NextResponse.json({ error: "The estimate was cut off. Try again." }, { status: 502 });
  }
  const out = res.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
  let estimate = null;
  try {
    estimate = out ? normalizeEstimate(JSON.parse(out)) : null;
  } catch {
    estimate = null;
  }
  if (!estimate) return NextResponse.json({ error: "The estimate came back unreadable. Try again." }, { status: 502 });

  return NextResponse.json({
    ...estimate,
    totals: mealTotals(estimate.items),
    model: PHOTO_MEAL_MODEL,
  });
}
