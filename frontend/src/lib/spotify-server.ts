/**
 * Spotify server-side client.
 *
 * Token storage mirrors the Python ETL (spotify_etl.py): refresh tokens live
 * in pds.ci_tokens (service='spotify'). On every call we fetch the stored
 * token blob, exchange the refresh_token for a fresh access_token, and if
 * Spotify rotates the refresh_token we write the new blob back to ci_tokens
 * so the Python ETL also picks it up.
 *
 * Server-only — uses SUPABASE_SERVICE_ROLE_KEY. Never import into client code.
 */

import { createClient } from "@supabase/supabase-js";

const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_API = "https://api.spotify.com/v1";

interface SpotifyTokenBlob {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  obtained_at: number;
  token_type?: string;
  scope?: string;
}

function supabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { db: { schema: "pds" } }
  );
}

function basicAuthHeader(): string {
  const id = process.env.SPOTIFY_CLIENT_ID!;
  const secret = process.env.SPOTIFY_CLIENT_SECRET!;
  return "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
}

async function loadTokens(): Promise<SpotifyTokenBlob> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("ci_tokens")
    .select("token_data")
    .eq("service", "spotify")
    .single();
  if (error || !data) {
    throw new Error("Spotify tokens not found in pds.ci_tokens — run `python spotify_etl.py --auth` then upload");
  }
  return JSON.parse(data.token_data as string) as SpotifyTokenBlob;
}

async function saveTokens(tokens: SpotifyTokenBlob): Promise<void> {
  const sb = supabaseAdmin();
  const { error } = await sb
    .from("ci_tokens")
    .upsert({
      service: "spotify",
      token_data: JSON.stringify(tokens, null, 2),
      updated_at: new Date().toISOString(),
    });
  if (error) {
    console.error("Failed to save rotated Spotify refresh token:", error);
    // Non-fatal — Spotify rotations are rare and the next refresh will use the old token until it stops working.
  }
}

/**
 * Returns a valid access token, refreshing if necessary. Persists any rotated
 * refresh token back to ci_tokens so the Python ETL stays in sync.
 */
export async function getSpotifyAccessToken(): Promise<string> {
  const tokens = await loadTokens();
  const resp = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Spotify token refresh failed (${resp.status}): ${body}`);
  }
  const fresh = await resp.json();
  tokens.access_token = fresh.access_token;
  tokens.expires_in = fresh.expires_in ?? 3600;
  tokens.obtained_at = Math.floor(Date.now() / 1000);
  if (fresh.refresh_token) {
    tokens.refresh_token = fresh.refresh_token;
  }
  await saveTokens(tokens);
  return tokens.access_token;
}

async function spotifyFetch(
  path: string,
  init: RequestInit & { accessToken: string }
): Promise<Response> {
  const { accessToken, ...rest } = init;
  return fetch(`${SPOTIFY_API}${path}`, {
    ...rest,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(rest.headers ?? {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SearchTrackResult {
  id: string;
  name: string;
  artists: string;
  album: string;
  duration_ms: number;
  popularity: number;
  preview_url: string | null;
  spotify_url: string;
}

/**
 * Search Spotify's catalog. Returns simplified track records ready for Claude
 * to reason about; raw payloads are dropped to keep token usage tight.
 */
export async function searchTracks(query: string, limit: number = 20): Promise<SearchTrackResult[]> {
  const accessToken = await getSpotifyAccessToken();
  const params = new URLSearchParams({ q: query, type: "track", limit: String(Math.min(limit, 50)) });
  const resp = await spotifyFetch(`/search?${params}`, { accessToken });
  if (!resp.ok) {
    throw new Error(`Spotify search failed (${resp.status}): ${await resp.text()}`);
  }
  const data = await resp.json();
  const items = (data.tracks?.items ?? []) as Array<{
    id: string;
    name: string;
    artists: Array<{ name: string }>;
    album: { name: string };
    duration_ms: number;
    popularity: number;
    preview_url: string | null;
    external_urls: { spotify: string };
  }>;
  return items.map((t) => ({
    id: t.id,
    name: t.name,
    artists: t.artists.map((a) => a.name).join(", "),
    album: t.album.name,
    duration_ms: t.duration_ms,
    popularity: t.popularity,
    preview_url: t.preview_url,
    spotify_url: t.external_urls.spotify,
  }));
}

export interface CreatePlaylistArgs {
  name: string;
  description?: string;
  trackIds: string[];
  isPublic?: boolean;
  createdVia: "chat" | "button" | "builder";
  prompt?: string;
}

export interface CreatePlaylistResult {
  playlist_id: string;
  spotify_url: string;
  name: string;
  track_count: number;
}

/**
 * Create a private playlist and add tracks. Tracks are added in chunks of
 * 100 (Spotify's per-request cap). Records the playlist in
 * pds.spotify_playlists for audit/history.
 */
export async function createPlaylist(args: CreatePlaylistArgs): Promise<CreatePlaylistResult> {
  const { name, description, trackIds, isPublic = false, createdVia, prompt } = args;

  if (!name?.trim()) throw new Error("Playlist name is required");
  if (!Array.isArray(trackIds) || trackIds.length === 0) {
    throw new Error("track_ids must be a non-empty array");
  }

  const accessToken = await getSpotifyAccessToken();

  // 1. Create the playlist for the current user.
  //    Spotify's Feb 2026 migration removed POST /users/{user_id}/playlists;
  //    use POST /me/playlists instead (creates under the authorized user).
  const createResp = await spotifyFetch(`/me/playlists`, {
    accessToken,
    method: "POST",
    body: JSON.stringify({
      name,
      description: description ?? "",
      public: isPublic,
    }),
  });
  if (!createResp.ok) {
    throw new Error(`Spotify playlist create failed (${createResp.status}): ${await createResp.text()}`);
  }
  const playlist = await createResp.json();
  const playlistId = playlist.id as string;
  const spotifyUrl = (playlist.external_urls?.spotify as string) ?? `https://open.spotify.com/playlist/${playlistId}`;

  // 1a. Enforce visibility via PUT /playlists/{id}.
  //     Spotify's POST /me/playlists silently ignores the `public` field and
  //     creates the playlist as public regardless; a follow-up PUT is the only
  //     way to actually set the flag. Belt-and-suspenders.
  const visResp = await spotifyFetch(`/playlists/${playlistId}`, {
    accessToken,
    method: "PUT",
    body: JSON.stringify({ public: isPublic }),
  });
  if (!visResp.ok) {
    console.error(
      `Spotify visibility PUT failed (${visResp.status}) for ${playlistId}: ${await visResp.text()} ` +
        `(playlist exists but may be public)`
    );
  }

  // 2. Add tracks in chunks of 100.
  //    Feb 2026 migration: /playlists/{id}/tracks → /playlists/{id}/items
  const uris = trackIds.map((id) => `spotify:track:${id}`);
  for (let i = 0; i < uris.length; i += 100) {
    const batch = uris.slice(i, i + 100);
    const addResp = await spotifyFetch(`/playlists/${playlistId}/items`, {
      accessToken,
      method: "POST",
      body: JSON.stringify({ uris: batch }),
    });
    if (!addResp.ok) {
      // Playlist is already created — surface partial-failure but don't try to undo
      throw new Error(
        `Spotify add-tracks failed (${addResp.status}) at offset ${i}: ${await addResp.text()} ` +
          `(playlist ${playlistId} was created but is incomplete)`
      );
    }
  }

  // 4. Persist to Supabase audit table
  const sb = supabaseAdmin();
  const { error: insertErr } = await sb.from("spotify_playlists").insert({
    playlist_id: playlistId,
    name,
    description: description ?? null,
    is_public: isPublic,
    track_count: trackIds.length,
    track_ids: trackIds,
    spotify_url: spotifyUrl,
    created_via: createdVia,
    prompt: prompt ?? null,
    raw_json: playlist,
  });
  if (insertErr) {
    console.error("Failed to log playlist to pds.spotify_playlists:", insertErr);
    // Non-fatal: the playlist exists in Spotify; logging is for our records.
  }

  return {
    playlist_id: playlistId,
    spotify_url: spotifyUrl,
    name,
    track_count: trackIds.length,
  };
}
