/**
 * Which signed iPhone builds the /install page can show, and where each one's
 * latest.json lives in the PRIVATE storage bucket `ios-builds`. Written by
 * tools/screentime_ios/ci/publish_build.py (PUBLISH_PREFIX):
 *   default  .github/workflows/screentime-ios.yml    -> screentime/latest.json
 *   focus    .github/workflows/focus-ios-signed.yml  -> screentime-focus/latest.json
 * Both builds' install manifests sit in screentime/manifests/<random slug>.plist,
 * served by the existing /api/screen-time/manifest/<slug> route.
 *
 * Pure (no Supabase / Next imports) so tests/install-builds.test.cjs can compile it.
 */

export const BUILD_VARIANTS = {
  default: {
    path: "screentime/latest.json",
    title: "Onyx Screen Time",
    workflow: "Screen Time iOS app",
  },
  focus: {
    path: "screentime-focus/latest.json",
    title: "Onyx with Focus (development build)",
    workflow: "Focus iOS signed build",
  },
} as const;

export type BuildVariant = keyof typeof BUILD_VARIANTS;

/**
 * The `variant` query parameter of /api/screen-time/build.
 * Absent -> the default (Screen Time export) build; "focus" -> the Focus build;
 * anything else (including an empty value or "default") -> null, answered 400.
 */
export function resolveBuildVariant(param: string | null): BuildVariant | null {
  if (param === null) return "default";
  if (param === "focus") return "focus";
  return null;
}

/** /install's request URL for a variant (the default keeps the original URL). */
export function buildApiUrl(variant: BuildVariant): string {
  return variant === "default" ? "/api/screen-time/build" : `/api/screen-time/build?variant=${variant}`;
}
