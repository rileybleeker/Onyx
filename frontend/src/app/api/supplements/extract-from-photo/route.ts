import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import type { NormalizedIngredient, NormalizedProduct } from "@/lib/dsld";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "pds" } },
);

const MODEL = "claude-sonnet-4-20250514";

// Cap reference list at ~120 entries so the prompt stays small. The full DSLD
// universe is larger but the user's library is the realistic intersection.
const REFERENCE_LIMIT = 120;

type SupportedMedia = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

interface ExtractedShape {
  brand_name: string | null;
  full_name: string | null;
  serving_size: number | null;
  serving_unit: string | null;
  servings_per_container: number | null;
  physical_state: string | null;
  ingredients: Array<{
    name: string | null;
    ingredient_group: string | null;
    unii_code: string | null;
    category: string | null;
    quantity: number | null;
    unit: string | null;
    percent_dv: number | null;
    forms?: Array<{
      name: string | null;
      ingredient_group: string | null;
      unii_code: string | null;
      category: string | null;
      percent: number | null;
    }>;
    notes: string | null;
  }>;
}

interface RefEntry {
  ingredient_group: string;
  unii_code: string | null;
  category: string | null;
}

/**
 * Build a deduped reference table of ingredient_group → (unii_code, category)
 * from every ingredient row across pds.supplement_products. This is what we
 * already trust as DSLD-aligned, so it doubles as our personal canonical
 * vocabulary. Voted UNII per group: pick the most-common UNII observed for
 * that group across all products. Same for category.
 */
async function buildReferenceTable(): Promise<RefEntry[]> {
  const { data, error } = await supabase
    .from("supplement_products")
    .select("ingredients")
    .eq("is_active", true);
  if (error) throw new Error(`Reference fetch failed: ${error.message}`);

  type Tally = Map<string, number>;
  const uniiByGroup = new Map<string, Tally>();
  const catByGroup = new Map<string, Tally>();

  const bump = (map: Map<string, Tally>, group: string, val: string | null) => {
    if (!val) return;
    if (!map.has(group)) map.set(group, new Map());
    const t = map.get(group)!;
    t.set(val, (t.get(val) ?? 0) + 1);
  };

  for (const row of data ?? []) {
    const ings = (row.ingredients ?? []) as NormalizedIngredient[];
    for (const ing of ings) {
      const group = ing.ingredient_group;
      if (!group) continue;
      bump(uniiByGroup, group, ing.unii_code);
      bump(catByGroup, group, ing.category);
      for (const f of ing.forms ?? []) {
        if (!f.ingredient_group) continue;
        bump(uniiByGroup, f.ingredient_group, f.unii_code);
        bump(catByGroup, f.ingredient_group, f.category);
      }
    }
  }

  const winner = (tally: Tally | undefined): string | null => {
    if (!tally) return null;
    let best: [string, number] | null = null;
    for (const [k, v] of tally) {
      if (!best || v > best[1]) best = [k, v];
    }
    return best?.[0] ?? null;
  };

  const groups = new Set<string>([...uniiByGroup.keys(), ...catByGroup.keys()]);
  const entries: RefEntry[] = [...groups].map((g) => ({
    ingredient_group: g,
    unii_code: winner(uniiByGroup.get(g)),
    category: winner(catByGroup.get(g)),
  }));
  entries.sort((a, b) => a.ingredient_group.localeCompare(b.ingredient_group));
  return entries.slice(0, REFERENCE_LIMIT);
}

function buildPrompt(reference: RefEntry[]): string {
  const refText = reference
    .map((r) => `- ${r.ingredient_group}${r.unii_code ? ` (UNII ${r.unii_code})` : ""}${r.category ? ` [${r.category}]` : ""}`)
    .join("\n");

  return `You are reading a Supplement Facts label from a photo. Extract every ingredient row and the product header.

Return a single JSON object with this exact shape (no prose, no markdown fences):
{
  "brand_name": string|null,
  "full_name": string|null,                  // product name as printed
  "serving_size": number|null,               // numeric only — e.g. 1, 2, 1000
  "serving_unit": string|null,               // e.g. "Tablet(s)", "Capsule(s)", "Softgel(s)", "Scoop(s)", "g", "mL"
  "servings_per_container": number|null,
  "physical_state": string|null,             // "Tablet or Pill" | "Capsule" | "Softgel" | "Powder" | "Liquid" | "Gummy" | null
  "ingredients": [
    {
      "name": string,                        // as printed on the label
      "ingredient_group": string|null,       // canonical name (see reference table below)
      "unii_code": string|null,              // FDA UNII (10-char alphanumeric) — copy from reference table when group matches
      "category": "vitamin"|"mineral"|"botanical"|"amino_acid"|"other"|null,
      "quantity": number|null,
      "unit": string|null,                   // mg | mcg | g | IU | mcg DFE | mcg RAE | mg NE | billion CFU | etc.
      "percent_dv": number|null,
      "forms": [                             // optional — when label says e.g. "Vitamin D (as cholecalciferol)"
        { "name": string, "ingredient_group": string|null, "unii_code": string|null, "category": string|null, "percent": number|null }
      ],
      "notes": string|null                   // anything noteworthy that doesn't fit (e.g. "Proprietary Blend", "from organic mushroom mycelium")
    }
  ]
}

Rules:
1. Extract EVERY ingredient row — including "Other Ingredients" only if they appear in the Supplement Facts panel itself (not the inactive ingredients list below the panel).
2. For "Proprietary Blend" type entries with a total mg but no per-ingredient breakdown: emit one row for the blend with the total quantity, plus one row per listed sub-ingredient with quantity=null and notes describing the blend membership.
3. For ingredients with a form qualifier ("Vitamin D (as cholecalciferol)", "Magnesium (as magnesium glycinate)"), put the canonical compound in \`name\` + \`ingredient_group\`, and put the specific form in \`forms\`.
4. \`ingredient_group\` is the cross-brand canonical name. Prefer EXACT spellings from the reference table below when an ingredient maps to one. If the ingredient is not in the table, invent a sensible canonical name (e.g. "Lion's Mane Mushroom", "L-Theanine").
5. \`unii_code\` MUST be copied verbatim from the reference table when \`ingredient_group\` matches a table row. Do NOT invent UNII codes — leave null if not in the table.
6. Use \`category\` consistently with the reference table. Default to "other" if uncertain.
7. Output ONLY the JSON object. No commentary, no \`\`\`json fences.

Reference table (DSLD-aligned ingredient_groups already in this user's library):
${refText}
`;
}

function extractJson(raw: string): unknown {
  // Strip ```json fences if Claude included them despite the instruction.
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : raw;
  return JSON.parse(body.trim());
}

/**
 * Server-side post-pass: for any extracted ingredient where unii_code is null
 * but ingredient_group exactly matches our reference, backfill UNII + category
 * from the reference. Belt-and-suspenders on top of the prompt rule.
 */
function alignWithReference(
  extracted: ExtractedShape,
  reference: RefEntry[],
): ExtractedShape {
  const byGroup = new Map(reference.map((r) => [r.ingredient_group.toLowerCase(), r]));
  const align = (ing: ExtractedShape["ingredients"][number]) => {
    const key = ing.ingredient_group?.toLowerCase();
    if (!key) return ing;
    const ref = byGroup.get(key);
    if (!ref) return ing;
    return {
      ...ing,
      unii_code: ing.unii_code ?? ref.unii_code,
      category: ing.category ?? ref.category,
    };
  };
  return {
    ...extracted,
    ingredients: extracted.ingredients.map(align),
  };
}

function toNormalizedShape(extracted: ExtractedShape): Pick<
  NormalizedProduct,
  | "brand_name"
  | "full_name"
  | "serving_size"
  | "serving_unit"
  | "servings_per_container"
  | "physical_state"
  | "ingredients"
> {
  return {
    brand_name: extracted.brand_name,
    full_name: extracted.full_name,
    serving_size: extracted.serving_size,
    serving_unit: extracted.serving_unit,
    servings_per_container: extracted.servings_per_container,
    physical_state: extracted.physical_state,
    ingredients: extracted.ingredients.map((i) => ({
      name: i.name,
      ingredient_group: i.ingredient_group,
      unii_code: i.unii_code,
      category: i.category,
      quantity: i.quantity,
      unit: i.unit,
      percent_dv: i.percent_dv,
      forms: (i.forms ?? []).map((f) => ({
        name: f.name,
        ingredient_group: f.ingredient_group,
        unii_code: f.unii_code,
        category: f.category,
        percent: f.percent,
      })),
      notes: i.notes,
    })),
  };
}

export const maxDuration = 60;

/**
 * POST /api/supplements/extract-from-photo
 * Body: { image_base64: string (no data: prefix), media_type: "image/jpeg" | ... }
 *
 * Calls Claude vision to read a Supplement Facts panel and return a
 * normalized product shape ready for review + save to supplement_products.
 * UNII codes are aligned against the user's existing library so cross-product
 * compound rollup in supplement_intake_by_compound works without manual fixup.
 *
 * The photo is NOT persisted — it lives only for the duration of the
 * Anthropic call.
 */
export async function POST(req: NextRequest) {
  const { image_base64, media_type } = (await req.json()) as {
    image_base64?: string;
    media_type?: string;
  };
  if (!image_base64 || !media_type) {
    return NextResponse.json(
      { error: "image_base64 and media_type are required" },
      { status: 400 },
    );
  }
  const supported: SupportedMedia[] = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  if (!supported.includes(media_type as SupportedMedia)) {
    return NextResponse.json(
      { error: `media_type must be one of ${supported.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    const reference = await buildReferenceTable();
    const prompt = buildPrompt(reference);

    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: media_type as SupportedMedia,
                data: image_base64,
              },
            },
            { type: "text", text: prompt },
          ],
        },
      ],
    });

    const textBlock = resp.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return NextResponse.json(
        { error: "Claude returned no text content" },
        { status: 502 },
      );
    }

    let parsed: ExtractedShape;
    try {
      parsed = extractJson(textBlock.text) as ExtractedShape;
    } catch (e) {
      return NextResponse.json(
        {
          error: "Could not parse Claude response as JSON",
          detail: e instanceof Error ? e.message : String(e),
          raw: textBlock.text.slice(0, 500),
        },
        { status: 502 },
      );
    }

    const aligned = alignWithReference(parsed, reference);
    const product = toNormalizedShape(aligned);

    return NextResponse.json({
      product,
      reference_size: reference.length,
      stop_reason: resp.stop_reason,
      usage: resp.usage,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
