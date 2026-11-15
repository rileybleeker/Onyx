import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { fallbackBehavioralToday } from "@/lib/checkin";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "pds" } },
);

// One day's intakes (product names embedded: one round trip), its compound rollup and the day's stack reminders
// (pds.supplement_stack_reminder: which stacks got a Log it / Skip card in /agents and how it was answered; /log
// offers Skip only for a card still open).
function readDay(today: string) {
  return Promise.all([
    supabase
      .from("supplement_intake")
      .select("intake_id,intake_date,intake_time,product_id,doses,notes,stack_id,supplement_products(brand_name,full_name)")
      .eq("intake_date", today)
      .order("intake_time", { ascending: false, nullsFirst: false }),
    supabase
      .from("supplement_intake_by_compound")
      .select("compound_key,ingredient_group,ingredient_names,unii_code,categories,unit_class,unit,source_units,total_amount,total_doses,source_product_count")
      .eq("calendar_date", today)
      .order("ingredient_group"),
    supabase
      .from("supplement_stack_reminder")
      .select("stack_id,status")
      .eq("behavioral_date", today),
  ]);
}

/**
 * GET /api/supplements/today
 *
 * Returns today's intakes + the compound-level rollup for today. The
 * compound rollup comes straight from the supplement_intake_by_compound
 * view so cross-product summation (e.g. Vitamin C from multivitamin +
 * standalone Vitamin C) just works.
 *
 * "Today" = pds.behavioral_today_now() — the awake-tail-aware,
 * TZ-aware behavioral day. At 1 AM ET this returns YESTERDAY (your
 * day hasn't ended pre-bed yet), matching the convention the
 * /supplements page uses for its log defaults. Using ET-clock-today
 * here would cause a silent display gap during the awake-tail: a
 * just-logged pre-bed intake would be hidden until midnight ticked
 * past the behavioral cutoff.
 */
export async function GET() {
  // Speed (2026-11-15): the day's reads start with the Eastern-rule guess while behavioral_today_now() answers
  // (they are kept only when the RPC agrees, as in /api/habits/checkin), and the product names ride along in the
  // intake query, so a load is one round of parallel reads instead of three in a row.
  const guess = fallbackBehavioralToday(new Date());
  const speculative = readDay(guess);
  speculative.catch(() => {});
  const { data: behavioralToday, error: btErr } = await supabase.rpc("behavioral_today_now");
  if (btErr) {
    console.error("behavioral_today_now RPC failed, falling back to ET clock:", btErr);
  }
  const today = (behavioralToday as string | null)
    ?? new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  const [intakesRes, compoundsRes, remindersRes] = today === guess ? await speculative : await readDay(today);

  if (intakesRes.error) return NextResponse.json({ error: intakesRes.error.message }, { status: 500 });
  if (compoundsRes.error) return NextResponse.json({ error: compoundsRes.error.message }, { status: 500 });

  type Embedded = { brand_name: string | null; full_name: string | null } | { brand_name: string | null; full_name: string | null }[] | null;
  const decoratedIntakes = (intakesRes.data ?? []).map((row) => {
    const { supplement_products: embedded, ...i } = row as typeof row & { supplement_products: Embedded };
    const p = Array.isArray(embedded) ? embedded[0] : embedded;
    return { ...i, brand_name: p?.brand_name ?? null, full_name: p?.full_name ?? null };
  });

  // The view returns ingredient_names/categories as arrays (multiple source
  // ingredients can map to one UNII). Collapse to the singular scalars the UI
  // renders, while passing the arrays through for any future multi-value use.
  const compounds = (compoundsRes.data ?? []).map((c) => ({
    ...c,
    category: Array.isArray(c.categories) ? (c.categories[0] ?? null) : (c.categories ?? null),
    ingredient_name: Array.isArray(c.ingredient_names) ? (c.ingredient_names[0] ?? null) : (c.ingredient_names ?? null),
  }));

  // A failed reminder read never fails the page: null = "not known" (no Skip offered), [] = no card today.
  if (remindersRes.error) console.error("supplement reminders read failed:", remindersRes.error.code);
  const reminders = remindersRes.error
    ? null
    : (remindersRes.data ?? []).map((r) => ({ stack_id: Number(r.stack_id), status: String(r.status) }));

  return NextResponse.json({
    date: today,
    intakes: decoratedIntakes,
    compounds,
    reminders,
  });
}
