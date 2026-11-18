import "server-only";
import { createClient } from "@supabase/supabase-js";
import { BUILD_VARIANTS } from "@/lib/install-builds";
import {
  installTarget, isInstallUrl, needsTrustStep, parseReportedVersion, updateStatus,
  type AppBuildId, type UpdateStatus,
} from "@/lib/iphone-update";

export interface InstallBuild extends AppBuildId {
  installUrl: string | null;
  /** First build signed with the current certificate (latest.json signing_since_build); null when unknown. */
  signingSince: string | null;
}

function client() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

type Sb = NonNullable<ReturnType<typeof client>>;

async function readLatest(sb: Sb, path: string): Promise<InstallBuild | null> {
  const f = await sb.storage.from("ios-builds").download(path);
  if (f.error || !f.data) return null;
  try {
    const j = JSON.parse(await f.data.text());
    const id = { version: String(j.version ?? ""), build: String(j.build ?? "") };
    if (!parseReportedVersion(`${id.version} (${id.build})`)) return null;
    const since = typeof j.signing_since_build === "string" || typeof j.signing_since_build === "number"
      ? String(j.signing_since_build) : null;
    return { ...id, installUrl: isInstallUrl(j.link_a) ? j.link_a : null, signingSince: since };
  } catch { return null; }
}

/** The one build to install (Focus build when published, else the Screen Time build), with its install link. */
export async function loadInstallBuild(sb: Sb): Promise<InstallBuild | null> {
  const [d, f] = await Promise.all([readLatest(sb, BUILD_VARIANTS.default.path), readLatest(sb, BUILD_VARIANTS.focus.path)]);
  return installTarget(d, f);
}

/**
 * Server read for Today's "Update everything" button: the app version the phone last reported (service role: the
 * newer of pds.iphone_app_installs, written by the app's hello on every open, and pds.phone_usage_sync_runs) against
 * the build to install in the private `ios-builds` bucket. Read-only; logs a code only. Null = could not be determined.
 */
export async function loadUpdateStatus(now: Date = new Date()): Promise<UpdateStatus | null> {
  const sb = client();
  if (!sb) return null;
  try {
    const [run, hello, target] = await Promise.all([
      sb.schema("pds").from("phone_usage_sync_runs").select("app_version,checked_at").not("app_version", "is", null)
        .order("checked_at", { ascending: false }).limit(1),
      sb.schema("pds").from("iphone_app_installs").select("app_version,build,reported_at")
        .order("reported_at", { ascending: false }).limit(1),
      loadInstallBuild(sb),
    ]);
    if (run.error) {
      console.error("[iphone-update] run read failed", run.error.code ?? "unexpected");
      return null;
    }
    // A missing hello table (SQL not applied yet) is not an error: the usage runs still answer.
    const h = hello.error ? undefined : (hello.data?.[0] as { app_version: string; build: string; reported_at: string } | undefined);
    const r = run.data?.[0] as { app_version: string | null; checked_at: string | null } | undefined;
    let reported = r?.app_version ?? null;
    let at = r?.checked_at ?? null;
    if (h && (!at || Date.parse(h.reported_at) >= Date.parse(at))) {
      reported = `${h.app_version} (${h.build})`;
      at = h.reported_at;
    }
    const s = updateStatus(reported, at, target ? { version: target.version, build: target.build } : null, now);
    return {
      ...s,
      installUrl: target?.installUrl ?? null,
      needsTrust: needsTrustStep(parseReportedVersion(reported), target?.signingSince ?? null),
    };
  } catch {
    console.error("[iphone-update] unexpected failure");
    return null;
  }
}

/** Records the app's hello (installed version) and returns the build to install. */
export async function recordHello(h: { variant: "default" | "focus"; app_version: string; build: string }): Promise<InstallBuild | null | "error"> {
  const sb = client();
  if (!sb) return "error";
  const up = await sb.schema("pds").from("iphone_app_installs")
    .upsert({ ...h, reported_at: new Date().toISOString() }, { onConflict: "variant,app_version,build" });
  if (up.error) console.error("[iphone-update] hello write failed", up.error.code ?? "unexpected");
  return loadInstallBuild(sb);
}
