import "server-only";
import { createClient } from "@supabase/supabase-js";
import {
  DOC_COLUMNS,
  LAB_COLUMNS,
  MAX_DOCUMENTS,
  MAX_LAB_RESULTS,
  MEDICAL_BUCKET,
  VIEW_URL_SECONDS,
  rowToDocument,
  rowToLab,
  type LabResult,
  type MedicalDocument,
} from "@/lib/medical-records";

/**
 * Server-side access to pds.medical_documents, pds.lab_results and the private storage bucket
 * "medical-records". SERVICE ROLE ONLY: the tables have RLS on, no policies and no grants to
 * anon / authenticated; storage.objects has no policy for the bucket. "server-only" keeps this
 * module out of client bundles. Callers (app/health/records/page.tsx, /api/medical/*) sit behind
 * the owner-only middleware; none of those paths is in the CI-token carve-out.
 *
 * Privacy: errors log a Postgres / PostgREST / Storage code only. Record text (titles, test
 * names, values, notes) is never logged, never written to sync_log, never put in an error
 * message and never sent to a model.
 */

export function medicalDb() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    db: { schema: "pds" },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type Section<T> = { state: "ready"; items: T[] } | { state: "error" };

const PAGE = 1000; // PostgREST's row cap per request

/** Every live row of a table, paged so the 1000-row cap never cuts the list short. */
async function readAll(
  table: "medical_documents" | "lab_results",
  columns: string,
  orderBy: string,
  cap: number,
  readyOnly: boolean,
): Promise<unknown[] | null> {
  const db = medicalDb();
  const rows: unknown[] = [];
  for (let from = 0; from < cap + PAGE; from += PAGE) {
    let query = db.from(table).select(columns).is("removed_at", null);
    if (readyOnly) query = query.eq("status", "ready");
    const { data, error } = await query
      .order(orderBy, { ascending: false })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      console.error(`${table} read failed:`, error.code || "unknown");
      return null;
    }
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return rows;
  }
  return rows;
}

/** Documents whose file is confirmed in the bucket and that have not been removed. */
export async function loadDocuments(): Promise<Section<MedicalDocument>> {
  const rows = await readAll("medical_documents", DOC_COLUMNS, "doc_date", MAX_DOCUMENTS, true);
  if (!rows) return { state: "error" };
  return { state: "ready", items: rows.map(rowToDocument).filter((d): d is MedicalDocument => d !== null) };
}

export async function loadLabs(): Promise<Section<LabResult>> {
  const rows = await readAll("lab_results", LAB_COLUMNS, "collected_on", MAX_LAB_RESULTS, false);
  if (!rows) return { state: "error" };
  return { state: "ready", items: rows.map(rowToLab).filter((r): r is LabResult => r !== null) };
}

/** How many live rows a table has; null when the count could not be read. */
export async function liveCount(table: "medical_documents" | "lab_results"): Promise<number | null> {
  const { count, error } = await medicalDb().from(table).select("id", { count: "exact", head: true }).is("removed_at", null);
  if (error || count === null) {
    console.error(`${table} count failed:`, error?.code || "unknown");
    return null;
  }
  return count;
}

/**
 * The ids among `ids` that are documents the browser may link a result to (file confirmed, not
 * removed). Null when the lookup failed.
 */
export async function linkableDocumentIds(ids: string[]): Promise<Set<string> | null> {
  if (!ids.length) return new Set();
  const { data, error } = await medicalDb().from("medical_documents").select("id")
    .in("id", ids).eq("status", "ready").is("removed_at", null);
  if (error) {
    console.error("document lookup failed:", error.code || "unknown");
    return null;
  }
  return new Set((data ?? []).map((r: { id: string }) => r.id));
}

/** A one-time upload URL for exactly this path (no overwrite). Null when Storage refused. */
export async function signedUpload(path: string): Promise<{ path: string; token: string } | null> {
  const { data, error } = await medicalDb().storage.from(MEDICAL_BUCKET).createSignedUploadUrl(path);
  if (error || !data) {
    console.error("signed upload failed:", (error as { statusCode?: string } | null)?.statusCode || "unknown");
    return null;
  }
  return { path: data.path, token: data.token };
}

/** Size and type of the file at `path`; null when there is no file (or Storage could not say). */
export async function storedFile(path: string): Promise<{ size: number; type: string } | null> {
  const { data, error } = await medicalDb().storage.from(MEDICAL_BUCKET).info(path);
  if (error || !data) return null;
  // /object/info answers size + content_type at the top level; older servers keep them in metadata.
  const meta = (data.metadata ?? {}) as { size?: unknown; mimetype?: unknown };
  const size = Number(data.size ?? meta.size);
  const type = String(data.contentType ?? meta.mimetype ?? "");
  return Number.isFinite(size) ? { size, type } : null;
}

/** A short-lived link to the file; `download` = save under that name instead of opening it. */
export async function signedView(path: string, download: string | null): Promise<string | null> {
  const { data, error } = await medicalDb().storage.from(MEDICAL_BUCKET)
    .createSignedUrl(path, VIEW_URL_SECONDS, download ? { download } : undefined);
  if (error || !data?.signedUrl) {
    console.error("signed view failed:", (error as { statusCode?: string } | null)?.statusCode || "unknown");
    return null;
  }
  return data.signedUrl;
}
