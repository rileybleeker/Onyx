import { careDb, careJson } from "@/lib/care-items-server";
import { HOME_COLUMNS, MAX_HOME_ITEMS, rowToHomeItem, type HomeItem } from "@/lib/home-reset";

export const dynamic = "force-dynamic";

// GET /api/home-reset -> {items}: Riley's apartment-reset plan (pds.home_reset_items, service role only).
// Owner session only (middleware; not in the CI-token carve-out). Read-only: opening Today completes, snoozes and
// changes nothing. Errors never carry item text; logs carry a database code only.
export async function GET() {
  const { data, error } = await careDb().from("home_reset_items").select(HOME_COLUMNS)
    .is("removed_at", null).order("created_at", { ascending: true }).order("id", { ascending: true }).limit(MAX_HOME_ITEMS + 10);
  if (error) {
    console.error("home reset read failed:", error.code || "unknown");
    return careJson({ error: "home reset unavailable" }, 500);
  }
  const items = (data ?? []).map(rowToHomeItem).filter((i): i is HomeItem => i !== null);
  return careJson({ items });
}
