/**
 * "Is the Onyx iPhone app out of date?" (pure, import-free, so a test can compile it by name).
 *
 * The app reports `app_version` on every sync as "<CFBundleShortVersionString> (<CFBundleVersion>)", e.g. "1.4 (87)"
 * (SyncService.appVersion). The newest signed build is published as { version, build } (install-builds.ts). Builds are
 * compared as numbers, version first and then build; a string that cannot be read is "unknown", never "current".
 */

export interface AppBuildId {
  version: string;
  build: string;
}

export type UpdateVerdict = "update" | "current" | "check" | "unknown";

export interface UpdateStatus {
  verdict: UpdateVerdict;
  /** What the phone last reported ("1.4 (87)"), null when it never did. */
  installed: string | null;
  /** The newest signed build ("1.5 (90)"), null when none is published. */
  available: string | null;
  /** When the phone last reported (ISO), null when never. */
  reportedAt: string | null;
  /** Over-the-air install link (itms-services) of the build to install; null when none is published. */
  installUrl?: string | null;
  /** True only when the build is signed with a new certificate: iOS then needs a trust step in Settings. */
  needsTrust?: boolean;
}

/** A phone that has not synced for this long may have been updated (or broken) without Onyx knowing. */
export const STALE_REPORT_MS = 7 * 24 * 3600 * 1000;

/** "1.4 (87)" -> { version: "1.4", build: "87" }; null when it is not that shape. */
export function parseReportedVersion(text: string | null | undefined): AppBuildId | null {
  const m = /^\s*([0-9][0-9.]*)\s*\(\s*([0-9][0-9.]*)\s*\)\s*$/.exec(text ?? "");
  return m ? { version: m[1], build: m[2] } : null;
}

function cmpDotted(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number(n));
  const pb = b.split(".").map((n) => Number(n));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** -1 when a is older than b, 0 equal, 1 newer; version first, then build. */
export function compareBuilds(a: AppBuildId, b: AppBuildId): number {
  return cmpDotted(a.version, b.version) || cmpDotted(a.build, b.build);
}

export function label(id: AppBuildId): string {
  return `${id.version} (${id.build})`;
}

export function updateStatus(
  reported: string | null,
  reportedAt: string | null,
  latest: AppBuildId | null,
  now: Date,
): UpdateStatus {
  const installedId = parseReportedVersion(reported);
  const base = {
    installed: installedId ? label(installedId) : null,
    available: latest ? label(latest) : null,
    reportedAt,
  };
  if (!latest) return { ...base, verdict: "unknown" };
  if (!installedId) return { ...base, verdict: reported ? "unknown" : "check" };
  // An older build wins over a silent phone: it is the stronger, known fact.
  if (compareBuilds(installedId, latest) < 0) return { ...base, verdict: "update" };
  const at = reportedAt ? Date.parse(reportedAt) : NaN;
  if (!Number.isFinite(at) || now.getTime() - at > STALE_REPORT_MS) return { ...base, verdict: "check" };
  return { ...base, verdict: "current" };
}

/** Pick the newest of the published builds (the Focus build upgrades the same app in place). */
export function newestBuild(builds: Array<(AppBuildId & { built_at?: string | null }) | null>): AppBuildId | null {
  let best: (AppBuildId & { built_at?: string | null }) | null = null;
  for (const b of builds) {
    if (!b || !parseReportedVersion(`${b.version} (${b.build})`)) continue;
    if (!best || compareBuilds(best, b) < 0) best = b;
  }
  return best ? { version: best.version, build: best.build } : null;
}

/** Today shows the card for "update" and "check"; hidden when current or unknown. */
export function showUpdateCard(s: UpdateStatus | null): boolean {
  return !!s && (s.verdict === "update" || s.verdict === "check");
}

/**
 * The one build to install. The Focus build is a superset of the Screen Time build (same sources, same bundle id,
 * plus the Focus extension), so it wins whenever it is published; otherwise the Screen Time build.
 */
export function installTarget<T extends AppBuildId>(defaultBuild: T | null, focusBuild: T | null): T | null {
  return focusBuild ?? defaultBuild;
}

/** Only an over-the-air install link may be handed to the phone. */
export function isInstallUrl(u: unknown): u is string {
  return typeof u === "string" && u.length < 4096 && u.startsWith("itms-services://?action=download-manifest&url=");
}

export interface Hello {
  variant: "default" | "focus";
  app_version: string;
  build: string;
}

/** Validates the app's launch hello (POST /api/screen-time/latest-build); null = reject with 400. */
export function parseHello(body: unknown): Hello | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const ok = (v: unknown): v is string => typeof v === "string" && /^[0-9][0-9.]{0,31}$/.test(v);
  if (b.variant !== "default" && b.variant !== "focus") return null;
  if (!ok(b.app_version) || !ok(b.build)) return null;
  return { variant: b.variant, app_version: b.app_version, build: b.build };
}

/**
 * iOS asks for a trust step in Settings only when the new build is signed with a different certificate than the
 * installed one. publish_build.py records signing_since_build (the first build signed with the current certificate,
 * carried forward while the certificate stays the same). The installed build is older than that = a new certificate.
 * Unknown on either side = no extra step shown.
 */
export function needsTrustStep(installed: AppBuildId | null, signingSinceBuild: string | null): boolean {
  if (!installed || !signingSinceBuild || !/^[0-9][0-9.]*$/.test(signingSinceBuild)) return false;
  return compareBuilds({ version: "0", build: installed.build }, { version: "0", build: signingSinceBuild }) < 0;
}

/**
 * Where Today's "Update everything" button points. iOS blocks itms-services links inside the home-screen (standalone)
 * app, so there the button opens /install?auto=1 in Safari through the x-safari-https scheme; /install then starts
 * the install on its own. In Safari the direct install link is kept. Null = no link (caller falls back).
 */
export function updateHref(installUrl: string | null, standalone: boolean, origin: string): string | null {
  if (standalone) {
    const m = /^https:\/\/([^/]+)$/.exec(origin);
    return m ? `x-safari-https://${m[1]}/install?auto=1` : null;
  }
  return installUrl;
}
