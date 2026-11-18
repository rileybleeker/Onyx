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
