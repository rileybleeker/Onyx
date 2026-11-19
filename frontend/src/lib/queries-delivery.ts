import { supabase } from "./supabase";
import { dishKcal, shiftYmd } from "./delivery-portion";
import { LEFTOVER_WINDOW_DAYS, type LeftoverRow } from "./delivery-leftovers";
import type { UberEatsCheck } from "./log-ubereats";

// Split out of queries.ts (PERF-PHONE-01): /log and /nutrition's dish lists import only these reads, and queries.ts is
// ~60 kB of unrelated reads that otherwise rode in /log's first scripts. queries.ts re-exports everything here.

export interface DeliveryDish {
  item_id: number;
  order_uuid: string;
  /** Behavioral day of the order (onyx_behavioral_date). */
  behavioral_date: string;
  store_name: string;
  title: string;
  quantity: number;
  completed_at: string | null;
  est_key: string;
  multi_consumer: boolean;
  /** NULL = all of it (the default); 0.25 = a quarter eaten. Set on /nutrition or /check-in. */
  eaten_fraction: number | null;
  /** Estimate for ONE unit (pds.delivery_item_nutrition.kcal); null until estimated. */
  unit_kcal: number | null;
  /** food | drink | alcohol | non_food; the day total counts food + drink, like delivery_nutrition_daily. */
  est_kind: string | null;
  /** unit_kcal x quantity x eaten_fraction (NULL fraction = 1). */
  est_kcal: number | null;
}

/**
 * Uber Eats cart lines for the given behavioral days with the per-dish estimate
 * (one unit × quantity × eaten_fraction). Restaurant orders only, cancelled orders excluded —
 * same scope as pds.delivery_nutrition_daily. Feeds "Today's Meals" on /nutrition and the
 * Uber Eats portion section on /check-in (which also asks about earlier days' unset dishes).
 */
export async function getDeliveryItemsForDays(dates: string[]): Promise<DeliveryDish[]> {
  if (dates.length === 0) return [];
  const { data, error } = await supabase
    .from("delivery_order_items")
    // Explicit columns (no customizations jsonb): eaten_fraction is applied in production
    // (sql/delivery_item_eaten_fraction.sql).
    .select(
      "item_id, order_uuid, onyx_behavioral_date, store_name, merchant_kind, title, quantity, completed_at, est_key, multi_consumer, eaten_fraction",
    )
    .in("onyx_behavioral_date", dates)
    .eq("is_cancelled", false)
    .eq("merchant_kind", "restaurant")
    .order("onyx_behavioral_date", { ascending: true })
    .order("completed_at", { ascending: true })
    .order("item_id", { ascending: true });
  if (error) throw error;
  const items = data ?? [];
  const keys = Array.from(new Set(items.map((i) => i.est_key).filter(Boolean)));
  const estByKey = new Map<string, { kcal: number | null; kind: string | null }>();
  if (keys.length) {
    const { data: est, error: estErr } = await supabase
      .from("delivery_item_nutrition")
      .select("est_key, kcal, kind")
      .in("est_key", keys);
    if (estErr) throw estErr;
    for (const e of est ?? []) {
      estByKey.set(e.est_key, { kcal: e.kcal == null ? null : Number(e.kcal), kind: e.kind ?? null });
    }
  }
  return items.map((i) => {
    const est = estByKey.get(i.est_key);
    const fraction = i.eaten_fraction == null ? null : Number(i.eaten_fraction);
    const unit = est?.kcal ?? null;
    return {
      item_id: Number(i.item_id),
      order_uuid: i.order_uuid,
      behavioral_date: i.onyx_behavioral_date,
      store_name: i.store_name,
      title: i.title,
      quantity: Number(i.quantity ?? 1),
      completed_at: i.completed_at ?? null,
      est_key: i.est_key,
      multi_consumer: !!i.multi_consumer,
      eaten_fraction: fraction,
      unit_kcal: unit,
      est_kind: est?.kind ?? null,
      est_kcal: dishKcal(unit, i.quantity, fraction),
    };
  });
}

/**
 * Leftover rows (pds.delivery_item_leftovers) of the given Uber Eats cart lines: the share of each
 * dish eaten on a later behavioral day. Feeds the "Leftovers" questions on /check-in and /nutrition.
 */
export async function getDeliveryLeftovers(itemIds: number[]): Promise<LeftoverRow[]> {
  if (itemIds.length === 0) return [];
  const { data, error } = await supabase
    .from("delivery_item_leftovers")
    .select("item_id, eaten_date, fraction, threw_out, eaten_time")
    .in("item_id", itemIds)
    .order("item_id", { ascending: true })
    .order("eaten_date", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r) => ({
    item_id: Number(r.item_id),
    eaten_date: String(r.eaten_date),
    fraction: Number(r.fraction),
    threw_out: !!r.threw_out,
    eaten_time: r.eaten_time == null ? null : String(r.eaten_time).slice(0, 5),
  }));
}

/** The dish lists' window: the restaurant cart lines of `days` and their leftover rows. */
export interface DeliveryWindow {
  rows: DeliveryDish[];
  stored: LeftoverRow[];
}

/**
 * One window for useDeliveryDishes (/nutrition, /check-in, /log). The leftover rows are read in parallel with the
 * dishes, by eaten day: a leftover of a dish delivered on day D is always dated D+1..D+LEFTOVER_WINDOW_DAYS (the
 * guard trigger of pds.delivery_item_leftovers), so the rows of these dishes all fall inside that range; rows of
 * other dishes are dropped. Same answer as getDeliveryLeftovers(ids), one round trip fewer.
 */
export async function getDeliveryWindow(days: string[]): Promise<DeliveryWindow> {
  if (days.length === 0) return { rows: [], stored: [] };
  const sorted = [...days].sort();
  const from = shiftYmd(sorted[0], 1);
  const to = shiftYmd(sorted[sorted.length - 1], LEFTOVER_WINDOW_DAYS);
  const [rows, leftovers] = await Promise.all([
    getDeliveryItemsForDays(days),
    supabase
      .from("delivery_item_leftovers")
      .select("item_id, eaten_date, fraction, threw_out, eaten_time")
      .gte("eaten_date", from)
      .lte("eaten_date", to)
      .order("item_id", { ascending: true })
      .order("eaten_date", { ascending: true }),
  ]);
  if (leftovers.error) throw leftovers.error;
  const ids = new Set(rows.map((r) => r.item_id));
  const stored: LeftoverRow[] = (leftovers.data ?? [])
    .filter((r) => ids.has(Number(r.item_id)))
    .map((r) => ({
      item_id: Number(r.item_id),
      eaten_date: String(r.eaten_date),
      fraction: Number(r.fraction),
      threw_out: !!r.threw_out,
      eaten_time: r.eaten_time == null ? null : String(r.eaten_time).slice(0, 5),
    }));
  return { rows, stored };
}

/**
 * When the PC harvester last read the Uber Eats order history: the newest ubereats|items heartbeat
 * (time + status only; sync_log is owner-readable). Shown on /log as "Uber Eats checked N min ago".
 */
export async function getUberEatsCheck(): Promise<UberEatsCheck> {
  const { data, error } = await supabase
    .from("sync_log")
    .select("sync_start, status")
    .eq("source", "ubereats")
    .eq("data_type", "items")
    .order("sync_start", { ascending: false })
    .limit(1);
  if (error) throw error;
  const row = data?.[0];
  return { at: row?.sync_start ? String(row.sync_start) : null, status: row?.status ? String(row.status) : null };
}

