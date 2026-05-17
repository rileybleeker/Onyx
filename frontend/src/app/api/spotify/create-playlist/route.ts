import { NextRequest, NextResponse } from "next/server";
import { createPlaylist } from "@/lib/spotify-server";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { name, description, track_ids, public: isPublic, created_via, prompt } = body ?? {};

    if (typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    if (!Array.isArray(track_ids) || track_ids.length === 0) {
      return NextResponse.json({ error: "track_ids must be a non-empty array" }, { status: 400 });
    }

    const result = await createPlaylist({
      name,
      description: typeof description === "string" ? description : undefined,
      trackIds: track_ids,
      isPublic: typeof isPublic === "boolean" ? isPublic : false,
      createdVia: created_via === "chat" ? "chat" : "button",
      prompt: typeof prompt === "string" ? prompt : undefined,
    });

    return NextResponse.json(result);
  } catch (err) {
    console.error("Spotify create-playlist route error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 }
    );
  }
}
