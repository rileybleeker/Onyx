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
import { after, NextRequest } from "next/server";
import { searchTracks, createPlaylist, CreatePlaylistResult } from "@/lib/spotify-server";
import {
  AttemptTimeoutError,
  attemptTimeoutMs,
  callWithCountedRetries,
  chooseModel,
  effortConfig,
  isRetryableModelError,
  logPilotObservation,
  MODEL_CALL_RETRIES,
  pilotFromEnv,
  pilotObservation,
  PLAYLIST_CALL_TIMEOUT_MS,
  PLAYLIST_CREATE_GRACE_MS,
  PLAYLIST_CREATE_HARD_MS,
  PLAYLIST_REQUEST_BUDGET_MS,
  retryAfterMs,
} from "@/lib/model-routing";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "pds" } }
);

// Model + effort come from lib/model-routing.ts (baseline, or the bounded pilot when it is on).
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
  // One arm per request (every call of the tool loop uses it).
  const now = Date.now();
  const pilot = pilotFromEnv(now);
  const choice = chooseModel("playlist", crypto.randomUUID(), pilot, now);
  const usage: Anthropic.Usage[] = [];
  const started = Date.now();
  // Provider attempts (counted before each one, retries included, so an attempt that throws still
  // counts) and a flag so each request is observed exactly once, even when sending the last event
  // throws.
  let attempts = 0;
  let observed = false;
  let finalResult: CreatePlaylistResult | null = null;
  // Set when any tool call fails. The model's closing text may quote the raw error, so it is then
  // replaced by a fixed sentence.
  let toolErrored = false;
  let unresolved = false;
  const observe = () => {
    if (observed) return;
    observed = true;
    logPilotObservation(
      pilotObservation("playlist", choice, pilot, {
        usage,
        latencyMs: Date.now() - started,
        ok: finalResult != null,
        unresolved,
        calls: attempts,
      }),
    );
  };

  // Ends the tool loop when the request budget runs out: the call in flight is aborted (body read
  // included) and no further call starts, so the request still ends in the catch below and is
  // observed. A client that disconnects does not stop the loop (a playlist asked for is still
  // made, as before); `send` swallows the closed stream and the request is observed at the end.
  const requestAt = started + PLAYLIST_REQUEST_BUDGET_MS;
  const stop = new AbortController();
  const budget = AbortSignal.timeout(PLAYLIST_REQUEST_BUDGET_MS);
  budget.addEventListener("abort", () => stop.abort(budget.reason), { once: true });

  // Every model call of the tool loop. The SDK's own retries are off (they would hide attempts
  // from the count) and the route retries the same errors the SDK would, at most
  // MODEL_CALL_RETRIES times, counting each attempt and waiting as long as the provider's
  // Retry-After asks, but never past the request budget. Each attempt has its own deadline that
  // also covers reading the response body (the SDK's `timeout` stops at the headers): a stalled
  // attempt ends there and is retried like the SDK's own timeout, while an abort by the request
  // budget is not.
  const callModel = (messages: Anthropic.MessageParam[]) =>
    callWithCountedRetries(
      async () => {
        const attemptMs = Math.min(PLAYLIST_CALL_TIMEOUT_MS, attemptTimeoutMs(requestAt, Date.now()));
        const attempt = AbortSignal.timeout(attemptMs);
        try {
          return await anthropic.messages.create(
            {
              model: choice.model,
              max_tokens: 1024,
              system: systemPrompt,
              tools,
              messages,
              ...(choice.effort ? { output_config: effortConfig(choice) } : {}),
            },
            {
              timeout: attemptMs,
              maxRetries: 0,
              signal: AbortSignal.any([stop.signal, attempt]),
            },
          );
        } catch (e) {
          if (attempt.aborted && !stop.signal.aborted) throw new AttemptTimeoutError();
          throw e;
        }
      },
      {
        retries: MODEL_CALL_RETRIES,
        isRetryable: (e) =>
          e instanceof AttemptTimeoutError ||
          isRetryableModelError(e, (x) => x instanceof Anthropic.APIConnectionError),
        retryAfterMs: (e) => retryAfterMs(e, Date.now()),
        deadlineMs: requestAt,
        signal: stop.signal,
        onAttempt: () => {
          attempts++;
        },
      },
    );

  // Read-only tool operations (Spotify search, database) race the same request budget, and no tool
  // starts after it has run out, so a hung one cannot keep the request open past its terminal
  // observation. Playlist creation is a write and goes through `createOnce` below instead.
  const withinBudget = <T,>(work: Promise<T>): Promise<T> => {
    if (stop.signal.aborted) {
      work.catch(() => undefined);
      return Promise.reject(new Error("Request time budget exceeded"));
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new Error("Request time budget exceeded"));
      stop.signal.addEventListener("abort", onAbort, { once: true });
      work.then(resolve, reject).finally(() => stop.signal.removeEventListener("abort", onAbort));
    });
  };

  // Playlist creation, at most one per request. A creation is never abandoned: once started on
  // Spotify it is tracked, its result is recorded whenever it lands, and a second
  // create_spotify_playlist call of the same request (the model retrying after an error) reuses it
  // instead of writing a second playlist. It is waited for past the request budget, up to
  // PLAYLIST_CREATE_GRACE_MS; when it is still running then, the outcome is unknown, the client is
  // told so, and the request is observed once the creation settles (`after` keeps the function
  // alive for it) instead of being logged as not created while it may still land.
  let creation: Promise<CreatePlaylistResult> | null = null;
  let creationPending = false;
  // A creation that failed after its Spotify write started. With no confirmed playlist id the
  // outcome is ambiguous (Spotify may have made the playlist before the connection failed): the
  // request is observed as unresolved and the client is told to check before generating again.
  // With a confirmed id the playlist exists but is incomplete, and the client is given its link.
  let creationAmbiguous = false;
  let leftPlaylist: { playlist_id: string; spotify_url: string } | null = null;
  const graceAt = requestAt + PLAYLIST_CREATE_GRACE_MS;
  const createOnce = (args: Parameters<typeof createPlaylist>[0]): Promise<CreatePlaylistResult> => {
    if (!creation) {
      if (stop.signal.aborted) return Promise.reject(new Error("Request time budget exceeded"));
      creationPending = true;
      let writeStarted = false;
      const write = createPlaylist({
        ...args,
        onWriteStart: () => (writeStarted = true),
        onCreated: (p) => (leftPlaylist = p),
      });
      creation = write;
      write
        .then(
          (r) => {
            finalResult = r;
          },
          () => {
            // A failure before any Spotify write (empty tracks, token refresh) left nothing to
            // protect: a corrected call may try again. A started write stays deduplicated, and
            // without a confirmed playlist its outcome is unknown.
            if (!writeStarted) {
              if (creation === write) creation = null;
            } else if (!leftPlaylist) {
              creationAmbiguous = true;
              unresolved = true;
            }
          },
        )
        .finally(() => {
          creationPending = false;
        });
    }
    const work = creation;
    return new Promise<CreatePlaylistResult>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Playlist creation is still running on Spotify")),
        Math.max(0, graceAt - Date.now()),
      );
      // The handlers above run first (registered first), so the flags are set here. The model is
      // told a playlist may already exist, so it does not ask for another.
      work
        .then(resolve, (e) => {
          if (leftPlaylist) {
            reject(new Error("The playlist was created on Spotify but is incomplete. Do not create another."));
          } else if (creationAmbiguous) {
            reject(new Error("Playlist creation failed after Spotify started it; a playlist may exist. Do not create another."));
          } else {
            reject(e);
          }
        })
        .finally(() => clearTimeout(timer));
    });
  };
  // Resolved when the request is fully done (its creation settled and the request observed), so
  // the function stays alive for a creation still running after the response closed.
  let finished: () => void = () => undefined;
  const requestDone = new Promise<void>((resolve) => {
    finished = resolve;
  });
  after(() => requestDone);

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
      const closeStream = () => {
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      // The last event: the playlist when one was created (also after a later failure, so the
      // client does not ask for it again), the playlist left incomplete by a failed creation, the
      // unknown outcome when a creation is still running or failed after its write started, else
      // the failure.
      const sendOutcome = (failure: string) => {
        if (finalResult) {
          send({ type: "done", result: finalResult });
        } else if (leftPlaylist) {
          send({
            type: "error",
            message: `The playlist was created on Spotify but is incomplete: ${leftPlaylist.spotify_url}. Check it before generating again.`,
          });
        } else if (creationAmbiguous) {
          send({
            type: "error",
            message:
              "Playlist creation failed after Spotify started it, so a playlist may exist. Check your playlists before generating again.",
          });
        } else if (creationPending) {
          send({
            type: "error",
            message:
              "Playlist creation did not finish in time and may still appear in Spotify. Check your playlists before generating again.",
          });
        } else {
          send({ type: "error", message: failure });
        }
      };

      try {
        send({ type: "status", message: "Planning…" });

        const messages: Anthropic.MessageParam[] = [
          { role: "user", content: "Generate the playlist now per the constraints in the system prompt." },
        ];

        let response = await callModel(messages);
        usage.push(response.usage);

        let iter = 0;

        while (response.stop_reason === "tool_use" && iter < MAX_ITERATIONS) {
          iter++;
          const assistantContent = response.content;
          messages.push({ role: "assistant", content: assistantContent });

          const toolResults: Anthropic.ToolResultBlockParam[] = [];

          for (const block of assistantContent) {
            if (block.type !== "tool_use") continue;

            if (stop.signal.aborted) throw new Error("Request time budget exceeded");
            send({ type: "tool_use", tool: block.name, input: block.input });

            let resultStr: string;
            let summary = "";

            try {
              if (block.name === "search_spotify_catalog") {
                const inp = block.input as { query: string; limit?: number };
                const tracks = await withinBudget(searchTracks(inp.query, inp.limit ?? 20));
                resultStr = JSON.stringify(tracks);
                summary = `Catalog search "${inp.query}" → ${tracks.length} tracks`;
              } else if (block.name === "query_spotify_tracks_by_features") {
                const rows = await withinBudget(runFeatureQuery(block.input as Record<string, unknown>));
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
                const reused = creation != null;
                const result = await createOnce({
                  name: inp.name,
                  description: inp.description,
                  trackIds: inp.track_ids,
                  isPublic: false,
                  createdVia: "builder",
                  prompt: body.prompt,
                });
                resultStr = JSON.stringify(result);
                summary = reused
                  ? `Already created "${result.name}" · ${result.track_count} tracks`
                  : `Created "${result.name}" · ${result.track_count} tracks`;
                finalResult = result;
              } else {
                resultStr = JSON.stringify({ error: `Unknown tool: ${block.name}` });
                summary = "Unknown tool";
              }
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              console.error(`spotify/generate-playlist tool ${block.name} failed:`, msg);
              toolErrored = true;
              resultStr = JSON.stringify({ error: msg });
              // The summary is shown in the browser's live log, so it stays a fixed phrase.
              summary = "Tool error";
            }

            send({ type: "tool_result", tool: block.name, summary });
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: resultStr,
            });
          }

          messages.push({ role: "user", content: toolResults });

          response = await callModel(messages);
          usage.push(response.usage);
        }

        const finalText = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text.trim())
          .filter(Boolean)
          .join("\n");
        if (toolErrored) {
          // The model's text may quote the raw tool error, so only a fixed sentence is sent.
          send({
            type: "message",
            text: "Something went wrong while building this playlist, so the details above may be incomplete. Try again.",
          });
        } else if (finalText) {
          send({ type: "message", text: finalText });
        }

        sendOutcome(
          iter >= MAX_ITERATIONS
            ? "Reached iteration cap without creating a playlist. Try a more specific prompt."
            : "Agent ended without creating a playlist.",
        );
      } catch (e) {
        // A playlist already created counts as accepted even if a later call failed.
        // The detail (which may name database or provider internals) stays in server logs.
        console.error("spotify/generate-playlist failed:", e);
        sendOutcome("Couldn't build the playlist. Try again.");
      } finally {
        if (creationPending) {
          // Outcome unknown: the response ends now and the creation is waited for (the function
          // is kept alive by `after`), so the request is observed with its real outcome.
          closeStream();
          // Bounded: past the hard end the request is observed as unresolved (cost and outcome
          // unknown) instead of being lost when the function is terminated.
          let hardTimer: ReturnType<typeof setTimeout> | undefined;
          const hard = new Promise<"hard">((r) => {
            hardTimer = setTimeout(() => r("hard"), Math.max(0, started + PLAYLIST_CREATE_HARD_MS - Date.now()));
          });
          const settled = await Promise.race([(creation ?? Promise.resolve()).then(() => "ok" as const, () => "ok" as const), hard]);
          clearTimeout(hardTimer);
          if (settled === "hard" && creationPending) unresolved = true;
        }
        // Every path observes once (the flag makes repeats no-ops), including a request whose
        // client disconnected or whose last event could not be sent.
        observe();
        closeStream();
        finished();
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
