/**
 * Generate-playlist endpoint — SSE.
 *
 * Drives a focused Claude agentic loop with three tools (search_spotify_catalog,
 * query_spotify_tracks_by_features, create_spotify_playlist). The user supplies
 * a free-text prompt plus structured constraints (vibes, source pool, era,
 * genres); we encode those into the system prompt and gate the available tools
 * by source_pool so 'history' / 'discovery' modes can't drift.
 *
 * Streams progress events so the modal can show step-by-step status during the
 * 10–30s generation window:
 *   - status      ad-hoc status line
 *   - tool_use    agent decided to call a tool
 *   - tool_result tool returned (with summary)
 *   - message     final assistant narrative
 *   - done        playlist created (carries CreatePlaylistResult)
 *   - error       fatal error
 */

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { searchTracks, createPlaylist, CreatePlaylistResult } from "@/lib/spotify-server";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "pds" } }
);

const MODEL = "claude-sonnet-4-20250514";
const MAX_ITERATIONS = 8;

interface GenerateRequest {
  prompt: string;
  vibes?: string[];
  source_pool?: "history" | "discovery" | "mix";
  era?: string | null;
  genres?: string[];
}

const SEARCH_TOOL: Anthropic.Tool = {
  name: "search_spotify_catalog",
  description:
    "Search Spotify's full catalog for tracks. Returns track ID, name, artists, album, duration, and popularity. Supports field filters like 'genre:ambient', 'year:2020-2024', 'artist:Tycho'.",
  input_schema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "Spotify search query (supports field filters)" },
      limit: { type: "number", description: "Max tracks to return (default 20, max 50)" },
    },
    required: ["query"],
  },
};

const FEATURES_TOOL: Anthropic.Tool = {
  name: "query_spotify_tracks_by_features",
  description:
    "Query the user's listening-history library by audio feature ranges (valence/energy/danceability normalized 0–1, tempo in BPM). Only returns tracks with audio features attached.",
  input_schema: {
    type: "object" as const,
    properties: {
      min_valence: { type: "number" },
      max_valence: { type: "number" },
      min_energy: { type: "number" },
      max_energy: { type: "number" },
      min_danceability: { type: "number" },
      max_danceability: { type: "number" },
      min_tempo: { type: "number" },
      max_tempo: { type: "number" },
      limit: { type: "number", description: "Max tracks (default 50, max 200)" },
    },
    required: [],
  },
};

const CREATE_TOOL: Anthropic.Tool = {
  name: "create_spotify_playlist",
  description:
    "Create a private Spotify playlist with the given tracks. Returns the playlist's Spotify URL.",
  input_schema: {
    type: "object" as const,
    properties: {
      name: { type: "string", description: "Evocative playlist name (not generic)" },
      description: { type: "string", description: "Short description capturing the curator's intent" },
      track_ids: { type: "array", items: { type: "string" }, description: "Ordered Spotify track IDs (no URI prefix)" },
    },
    required: ["name", "track_ids"],
  },
};

function eraYearFilter(era: string | null | undefined): string | null {
  if (!era || era === "Any") return null;
  const map: Record<string, string> = {
    "2020s": "year:2020-2029",
    "2010s": "year:2010-2019",
    "2000s": "year:2000-2009",
    "1990s": "year:1990-1999",
    "1980s": "year:1980-1989",
  };
  return map[era] ?? null;
}

function buildSystemPrompt(req: GenerateRequest): string {
  const lines: string[] = [
    "You are a Spotify playlist curator for the Onyx personal data app.",
    "",
    `User's request: "${req.prompt?.trim() || "(no free-text prompt — rely on the structured constraints)"}"`,
  ];

  if (req.vibes?.length) lines.push(`Mood/vibe tags: ${req.vibes.join(", ")}`);
  if (req.era && req.era !== "Any") {
    const yearFilter = eraYearFilter(req.era);
    lines.push(`Era: ${req.era}${yearFilter ? ` (use "${yearFilter}" when searching the catalog)` : ""}`);
  }
  if (req.genres?.length) lines.push(`Preferred genres (bias toward these but stay coherent): ${req.genres.join(", ")}`);

  const pool = req.source_pool ?? "mix";
  lines.push("");
  if (pool === "history") {
    lines.push(
      "SOURCE CONSTRAINT — HISTORY ONLY: You may ONLY call query_spotify_tracks_by_features (then create_spotify_playlist). Do NOT attempt to search the Spotify catalog — that tool is not available in this mode."
    );
  } else if (pool === "discovery") {
    lines.push(
      "SOURCE CONSTRAINT — DISCOVERY ONLY: You may ONLY call search_spotify_catalog (then create_spotify_playlist). Do NOT query the user's history — that tool is not available in this mode."
    );
  } else {
    lines.push(
      "SOURCE MIX: Use both query_spotify_tracks_by_features and search_spotify_catalog. Aim for roughly a 50/50 blend of familiar (history) and new (catalog discovery) tracks."
    );
  }

  lines.push("");
  lines.push("Workflow:");
  lines.push("1. Assemble 25–35 candidate tracks via the available tool(s). Make multiple parallel tool calls when useful (e.g. one search per genre).");
  lines.push("2. For catalog searches, use Spotify field filters aggressively: 'genre:ambient year:2020-2029', 'artist:Tycho', etc.");
  lines.push("3. For history queries, pick valence/energy/danceability/tempo ranges that fit the vibe (low valence + low energy = melancholic; high energy + high tempo = workout).");
  lines.push("4. Avoid stacking >2 tracks from a single artist — keep variety high.");
  lines.push("5. Call create_spotify_playlist ONCE with an evocative, specific name (avoid 'Onyx Playlist' / 'Generated Playlist') and a one-sentence description that captures the intent.");
  lines.push("6. After creation, respond with one short sentence about the picks. Do NOT ask for confirmation before creating.");

  return lines.join("\n");
}

async function runFeatureQuery(input: Record<string, unknown>): Promise<unknown> {
  const limit = Math.min((input.limit as number) ?? 50, 200);
  let q = supabase
    .from("spotify_tracks")
    .select("track_id,name,artists,album,valence,energy,danceability,tempo,duration_ms")
    .not("features_source", "is", null)
    .limit(limit);

  const pairs: Array<[number | undefined, "gte" | "lte", string]> = [
    [input.min_valence as number | undefined, "gte", "valence"],
    [input.max_valence as number | undefined, "lte", "valence"],
    [input.min_energy as number | undefined, "gte", "energy"],
    [input.max_energy as number | undefined, "lte", "energy"],
    [input.min_danceability as number | undefined, "gte", "danceability"],
    [input.max_danceability as number | undefined, "lte", "danceability"],
    [input.min_tempo as number | undefined, "gte", "tempo"],
    [input.max_tempo as number | undefined, "lte", "tempo"],
  ];
  for (const [val, op, col] of pairs) {
    if (typeof val !== "number") continue;
    q = op === "gte" ? q.gte(col, val) : q.lte(col, val);
  }

  const { data, error } = await q;
  if (error) return { error: error.message };
  return (data ?? []).map((r) => ({
    track_id: r.track_id,
    name: r.name,
    artists: Array.isArray(r.artists)
      ? r.artists.map((a: { name?: string }) => a?.name).filter(Boolean).join(", ")
      : null,
    album: (r.album as { name?: string } | null)?.name ?? null,
    valence: r.valence,
    energy: r.energy,
    danceability: r.danceability,
    tempo: r.tempo,
    duration_ms: r.duration_ms,
  }));
}

export async function POST(req: NextRequest) {
  let body: GenerateRequest;
  try {
    body = (await req.json()) as GenerateRequest;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!body.prompt?.trim() && !body.vibes?.length && !body.genres?.length) {
    return Response.json(
      { error: "Provide at least a prompt, vibe, or genre to generate from." },
      { status: 400 }
    );
  }

  const pool = body.source_pool ?? "mix";
  const tools: Anthropic.Tool[] =
    pool === "history"
      ? [FEATURES_TOOL, CREATE_TOOL]
      : pool === "discovery"
      ? [SEARCH_TOOL, CREATE_TOOL]
      : [SEARCH_TOOL, FEATURES_TOOL, CREATE_TOOL];

  const systemPrompt = buildSystemPrompt(body);

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (evt: Record<string, unknown>) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(evt)}\n\n`));
        } catch {
          // Controller closed early (client disconnected) — swallow.
        }
      };

      try {
        send({ type: "status", message: "Planning…" });

        const messages: Anthropic.MessageParam[] = [
          { role: "user", content: "Generate the playlist now per the constraints in the system prompt." },
        ];

        let response = await anthropic.messages.create({
          model: MODEL,
          max_tokens: 1024,
          system: systemPrompt,
          tools,
          messages,
        });

        let iter = 0;
        let finalResult: CreatePlaylistResult | null = null;

        while (response.stop_reason === "tool_use" && iter < MAX_ITERATIONS) {
          iter++;
          const assistantContent = response.content;
          messages.push({ role: "assistant", content: assistantContent });

          const toolResults: Anthropic.ToolResultBlockParam[] = [];

          for (const block of assistantContent) {
            if (block.type !== "tool_use") continue;

            send({ type: "tool_use", tool: block.name, input: block.input });

            let resultStr: string;
            let summary = "";

            try {
              if (block.name === "search_spotify_catalog") {
                const inp = block.input as { query: string; limit?: number };
                const tracks = await searchTracks(inp.query, inp.limit ?? 20);
                resultStr = JSON.stringify(tracks);
                summary = `Catalog search "${inp.query}" → ${tracks.length} tracks`;
              } else if (block.name === "query_spotify_tracks_by_features") {
                const rows = await runFeatureQuery(block.input as Record<string, unknown>);
                resultStr = JSON.stringify(rows);
                summary = Array.isArray(rows)
                  ? `Filtered history → ${rows.length} tracks`
                  : "History query error";
              } else if (block.name === "create_spotify_playlist") {
                const inp = block.input as {
                  name: string;
                  description?: string;
                  track_ids: string[];
                };
                send({
                  type: "status",
                  message: `Creating "${inp.name}" with ${inp.track_ids.length} tracks…`,
                });
                const result = await createPlaylist({
                  name: inp.name,
                  description: inp.description,
                  trackIds: inp.track_ids,
                  isPublic: false,
                  createdVia: "builder",
                  prompt: body.prompt,
                });
                resultStr = JSON.stringify(result);
                summary = `Created "${result.name}" · ${result.track_count} tracks`;
                finalResult = result;
              } else {
                resultStr = JSON.stringify({ error: `Unknown tool: ${block.name}` });
                summary = "Unknown tool";
              }
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              resultStr = JSON.stringify({ error: msg });
              summary = `Tool error: ${msg.slice(0, 120)}`;
            }

            send({ type: "tool_result", tool: block.name, summary });
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: resultStr,
            });
          }

          messages.push({ role: "user", content: toolResults });

          response = await anthropic.messages.create({
            model: MODEL,
            max_tokens: 1024,
            system: systemPrompt,
            tools,
            messages,
          });
        }

        const finalText = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text.trim())
          .filter(Boolean)
          .join("\n");
        if (finalText) {
          send({ type: "message", text: finalText });
        }

        if (finalResult) {
          send({ type: "done", result: finalResult });
        } else {
          send({
            type: "error",
            message:
              iter >= MAX_ITERATIONS
                ? "Reached iteration cap without creating a playlist. Try a more specific prompt."
                : "Agent ended without creating a playlist.",
          });
        }
      } catch (e) {
        send({
          type: "error",
          message: e instanceof Error ? e.message : String(e),
        });
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
