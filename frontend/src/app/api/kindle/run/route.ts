import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { RUN_REQUEST_COLS, checkRunRequest, isRunId, parseRunBody, shouldReuse, type RunRequest } from "@/lib/kindle-run";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const answer = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });
// PostgREST / Postgres "table not there": sql/pc_run_requests.sql not applied.
const MISSING_TABLE_CODES = new Set(["PGRST205", "42P01"]);

function db() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { db: { schema: "pds" }, auth: { persistSession: false, autoRefreshToken: false } });
}

function failed(code: string | undefined, what: string) {
  console.error(`kindle run ${what} failed:`, code || "unknown");
  if (code && MISSING_TABLE_CODES.has(code)) return answer({ error: "Run now is not set up yet", setupPending: true }, 503);
  return answer({ error: `could not ${what}` }, 500);
}

/**
 * POST /api/kindle/run   body {}
 * Asks Riley's PC to run the Kindle harvester now. Owner session only (middleware; NOT in the CI
 * carve-out), same-origin JSON, at most 256 bytes. Writes one pds.pc_run_requests row, which
 * Supabase Realtime pushes to the idle listener on the PC; a press while the newest request is still
 * unanswered (< 2 min) or still running (< 25 min) returns that request instead of a second row.
 */
export async function POST(req: NextRequest) {
  const refused = checkRunRequest(req.headers, req.nextUrl.origin);
  if (refused) return answer({ error: refused.error }, refused.status);
  let text: string;
  try {
    text = await req.text();
  } catch {
    return answer({ error: "could not read body" }, 400);
  }
  const parsed = parseRunBody(text);
  if (!parsed.ok) return answer({ error: parsed.error }, parsed.error === "body too large" ? 413 : 400);

  const client = db();
  if (!client) return answer({ error: "Run now is not configured" }, 503);

  const latest = await client
    .from("pc_run_requests")
    .select(RUN_REQUEST_COLS)
    .eq("task", "kindle")
    .order("requested_at", { ascending: false })
    .limit(1);
  if (latest.error) return failed(latest.error.code, "check");
  const newest = (latest.data?.[0] as RunRequest | undefined) ?? null;
  if (shouldReuse(newest, Date.now())) return answer({ request: newest, reused: true });

  const inserted = await client.from("pc_run_requests").insert({ task: "kindle" }).select(RUN_REQUEST_COLS).single();
  if (inserted.error) return failed(inserted.error.code, "save");
  return answer({ request: inserted.data as RunRequest, reused: false }, 201);
}

/** GET /api/kindle/run?id=<uuid>   the request's state, as the PC wrote it. Owner session only. */
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!isRunId(id)) return answer({ error: "id must be a request id" }, 400);
  const client = db();
  if (!client) return answer({ error: "Run now is not configured" }, 503);
  const { data, error } = await client.from("pc_run_requests").select(RUN_REQUEST_COLS).eq("id", id).maybeSingle();
  if (error) return failed(error.code, "read");
  if (!data) return answer({ error: "not found" }, 404);
  return answer({ request: data as RunRequest });
}
