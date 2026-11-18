import "server-only";
import { createClient } from "@supabase/supabase-js";
import { BUILD_VARIANTS } from "@/lib/install-builds";
import { newestBuild, updateStatus, type AppBuildId, type UpdateStatus } from "@/lib/iphone-update";

/**
 * Server read for the Today "iPhone app update" card: the app version the phone last reported (service role,
 * pds.phone_usage_sync_runs: app_version + checked_at only) against the newest signed build in the private
 * `ios-builds` bucket. Read-only; logs a code only, never a value. Null = could not be determined.
 */
export async function loadUpdateStatus(now: Date = new Date()): Promise<UpdateStatus | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const [run, ...files] = await Promise.all([
      sb.schema("pds").from("phone_usage_sync_runs").select("app_version,checked_at").not("app_version", "is", null)
        .order("checked_at", { ascending: false }).limit(1),
      ...Object.values(BUILD_VARIANTS).map((v) => sb.storage.from("ios-builds").download(v.path)),
    ]);
    if (run.error) {
      console.error("[iphone-update] run read failed", run.error.code ?? "unexpected");
      return null;
    }
    const builds: Array<(AppBuildId & { built_at?: string | null }) | null> = [];
    for (const f of files) {
      if (f.error || !f.data) { builds.push(null); continue; }
      try {
        const j = JSON.parse(await f.data.text());
        builds.push({ version: String(j.version ?? ""), build: String(j.build ?? ""), built_at: j.built_at ?? null });
      } catch { builds.push(null); }
    }
    const row = run.data?.[0] as { app_version: string | null; checked_at: string | null } | undefined;
    return updateStatus(row?.app_version ?? null, row?.checked_at ?? null, newestBuild(builds), now);
  } catch {
    console.error("[iphone-update] unexpected failure");
    return null;
  }
}
