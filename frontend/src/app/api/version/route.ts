import { NextResponse } from "next/server";

// The build this deployment serves. The installed app compares it with the build it is running
// (NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA, baked in at build time) and reloads when they differ (lib/app-update.ts).
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    { version: process.env.VERCEL_GIT_COMMIT_SHA ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
