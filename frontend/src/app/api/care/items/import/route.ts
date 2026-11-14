import { NextRequest } from "next/server";
import { MAX_CARE_ITEMS, MAX_IMPORT_BODY_BYTES, parseImportBody, toColumns } from "@/lib/care-items";
import { syncAfterWrite } from "@/lib/care-google-server";
import { careDb, careJson, liveCareCount, loadCareItems, readCareBody } from "@/lib/care-items-server";
import { upgradeLocalItem } from "@/lib/care-planner";

export const dynamic = "force-dynamic";

// POST /api/care/items/import: the one-time copy of a browser's saved planner into Onyx.
// Body {items: [the old six-field items], tz}. Owner session only (middleware; not in the
// CI-token carve-out), same-origin, JSON, capped body.
// Idempotent: each item is stored under import_key = the id it had in the browser, and an
// import_key that is already there is skipped, so pressing the button twice (or from a second
// tab) adds nothing. Sample items are refused. Answers {copied, skipped, items} where items is
// the full current list.

export async function POST(req: NextRequest) {
  const read = await readCareBody(req, req.nextUrl.origin, MAX_IMPORT_BODY_BYTES);
  if (!read.ok) return read.response;
  const parsed = parseImportBody(read.body);
  if (!parsed.ok) return careJson({ error: parsed.error }, 400);

  const live = await liveCareCount();
  if (live === null) return careJson({ error: "could not copy" }, 500);
  if (live + parsed.items.length > MAX_CARE_ITEMS) return careJson({ error: `limit of ${MAX_CARE_ITEMS} items reached` }, 409);

  const rows = parsed.items.map((local) => {
    // The stored id is a fresh UUID from the database; the browser id only serves as import_key.
    const { id: importKey, ...fields } = upgradeLocalItem(local, parsed.tz);
    return { ...toColumns(fields), import_key: importKey };
  });
  const { data, error } = await careDb().from("care_items")
    .upsert(rows, { onConflict: "import_key", ignoreDuplicates: true })
    .select("id");
  if (error) {
    console.error("care items import failed:", error.code || "unknown");
    return careJson({ error: "could not copy" }, 500);
  }
  const copied = data?.length ?? 0;
  if (copied > 0) syncAfterWrite();
  const current = await loadCareItems();
  if (current.state === "error") return careJson({ error: "copied, but the list could not be re-read" }, 500);
  return careJson({ copied, skipped: rows.length - copied, items: current.items });
}
