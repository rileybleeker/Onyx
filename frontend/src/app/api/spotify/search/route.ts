import { NextRequest, NextResponse } from "next/server";
import { searchTracks } from "@/lib/spotify-server";

export async function GET(req: NextRequest) {
  try {
    const q = req.nextUrl.searchParams.get("q");
    const limit = parseInt(req.nextUrl.searchParams.get("limit") ?? "20", 10);
    if (!q?.trim()) {
      return NextResponse.json({ error: "q (query) is required" }, { status: 400 });
    }
    const tracks = await searchTracks(q, Number.isFinite(limit) ? limit : 20);
    return NextResponse.json({ tracks });
  } catch (err) {
    console.error("Spotify search route error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 }
    );
  }
}
