import "server-only";
import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { CARE_COLUMNS, MAX_CARE_ITEMS, checkCareRequest, rowToItem, utf8Bytes } from "@/lib/care-items";
import type { CareItem } from "@/lib/care-planner";

/**
 * Server-side access to pds.care_items. SERVICE ROLE ONLY: the table has RLS on, no policies and
 * no grants to anon / authenticated, so the browser never queries it, and "server-only" keeps
 * this module out of client bundles. Callers (app/health/page.tsx, /api/care/*) sit behind the
 * owner-only middleware; none of those paths is in the CI-token carve-out.
 *
 * Privacy: errors log a Postgres / PostgREST code only. Item text (labels, notes, dates) is never
 * logged, never written to sync_log and never put in an error message.
 */

export function careDb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    db: { schema: "pds" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type CareLoad = { state: "ready"; items: CareItem[] } | { state: "error" };

/** Every item that has not been removed (archived ones included), in a stable order. */
export async function loadCareItems(): Promise<CareLoad> {
  const { data, error } = await careDb()
    .from("care_items")
    .select(CARE_COLUMNS)
    .is("removed_at", null)
    .order("due_date", { ascending: true })
    .order("id", { ascending: true })
    .limit(MAX_CARE_ITEMS + 100);
  if (error) {
    console.error("care items read failed:", error.code || "unknown");
    return { state: "error" };
  }
  return { state: "ready", items: (data ?? []).map(rowToItem).filter((item): item is CareItem => item !== null) };
}

const NO_STORE = { "Cache-Control": "no-store" };

export function careJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

type BodyResult = { ok: true; body: unknown } | { ok: false; response: NextResponse };

/**
 * The checks every write goes through before its handler runs: same-origin Origin, and for a
 * request with a body a JSON content type, a size cap on the bytes actually received, and JSON
 * that parses. `maxBytes` null = the request has no body (DELETE).
 */
export async function readCareBody(req: Request, requestOrigin: string, maxBytes: number | null): Promise<BodyResult> {
  const refused = checkCareRequest(req.headers, requestOrigin, maxBytes === null ? null : { maxBytes });
  if (refused) return { ok: false, response: careJson({ error: refused.error }, refused.status) };
  if (maxBytes === null) return { ok: true, body: null };
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { ok: false, response: careJson({ error: "could not read body" }, 400) };
  }
  if (utf8Bytes(text) > maxBytes) return { ok: false, response: careJson({ error: "body too large" }, 413) };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, response: careJson({ error: "body must be JSON" }, 400) };
  }
}

/** How many items are live (not removed); null when the count could not be read. */
export async function liveCareCount(): Promise<number | null> {
  const { count, error } = await careDb().from("care_items").select("id", { count: "exact", head: true }).is("removed_at", null);
  if (error || count === null) {
    console.error("care items count failed:", error?.code || "unknown");
    return null;
  }
  return count;
}
