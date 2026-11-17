import { NextResponse } from "next/server";

// The build this deployment serves. The installed app compares it with the build it is running
// (NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA, baked in at build time) and reloads when they differ (lib/app-update.ts).
// `deployment` is this deployment's own generated host (VERCEL_URL, the address GitHub's deployment record
// carries), so the post-merge smoke test can prove which immutable deployment the production alias served
// before and after its run (DEL-02, e2e/provenance.ts). Owner session only, like every /api route.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    {
      version: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      deployment: process.env.VERCEL_URL ?? null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
