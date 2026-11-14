/**
 * Spotify server-side client.
 *
 * Token storage mirrors the Python ETL (spotify_etl.py): refresh tokens live
 * in pds.ci_tokens (service='spotify'). On every call we fetch the stored
 * token blob, exchange the refresh_token for a fresh access_token and write
 * the blob back to ci_tokens so the Python ETL also picks it up.
 *
 * Spotify expires a refresh token 180 days after the authorization (enforced
 * since 2026-07-20). The recovery is the Reconnect control on the /status
 * Spotify card: exchangeAuthorizationCode + probeRecentlyPlayed +
 * storeSpotifyTokens below, driven by POST /api/spotify/exchange.
 *
 * Server-only — uses SUPABASE_SERVICE_ROLE_KEY. Never import into client code.
 */

import { createClient } from "@supabase/supabase-js";
import { SPOTIFY_REDIRECT_URI, isNewerBlob, shouldWriteBack, serializeTokenBlob, type SpotifyTokenBlob } from "@/lib/spotify-reconnect";

const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_API = "https://api.spotify.com/v1";

/** Shown wherever a Spotify call fails because the stored refresh token is dead. */
export const SPOTIFY_RECONNECT_HINT = "Spotify needs to be reconnected: open /status and use Reconnect on the Spotify card.";

function supabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { db: { schema: "pds" } }
  );
}

/** Basic auth for the token endpoint, or null when either Spotify env var is unset. */
function basicAuthHeader(): string | null {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) return null;
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
    throw new Error(`Spotify tokens not found in pds.ci_tokens. ${SPOTIFY_RECONNECT_HINT}`);
  }
  return JSON.parse(data.token_data as string) as SpotifyTokenBlob;
}

/**
 * Refresh path write-back. Newer-wins: the row is re-read first, and a blob that is not newer than
 * the stored one (an earlier authorization, or the same authorization with an older refresh) is
 * dropped. Without this, a call that loaded the old blob just before a reconnect would write the
 * old refresh token back over the new one.
 */
async function saveTokens(tokens: SpotifyTokenBlob, loadedRefreshToken: string): Promise<void> {
  const sb = supabaseAdmin();
  const { data: rows, error: readErr } = await sb.from("ci_tokens").select("token_data").eq("service", "spotify").limit(1);
  if (readErr) {
    console.error("Spotify token write-back skipped: could not read the stored row:", readErr.code);
    return;
  }
  const storedText = rows?.[0]?.token_data;
  if (typeof storedText === "string") {
    try {
      const stored = JSON.parse(storedText) as Partial<SpotifyTokenBlob> | null;
      if (stored && typeof stored === "object" && !shouldWriteBack(tokens, loadedRefreshToken, stored)) {
        if (isNewerBlob(tokens, stored)) {
          console.error("Spotify token write-back skipped: refresh token rotated elsewhere");
        }
        return;
      }
    } catch {
      // unreadable stored row: fall through and replace it
    }
  }
  const { error } = await sb
    .from("ci_tokens")
    .upsert({
      service: "spotify",
      token_data: serializeTokenBlob(tokens),
      updated_at: new Date().toISOString(),
    });
  if (error) {
    console.error("Failed to save refreshed Spotify tokens:", error.code);
    // Non-fatal: the refresh token is unchanged in the common case, so the next call refreshes again.
  }
}

// ---------------------------------------------------------------------------
// Reconnect (POST /api/spotify/exchange)
// ---------------------------------------------------------------------------

export type ExchangeResult =
  | { ok: true; token: unknown }
  | { ok: false; reason: "not_configured" | "code_rejected" | "spotify_unavailable" };

/**
 * Exchanges an authorization code for tokens. redirect_uri is the same constant the authorize link
 * used. Returns a reason only: Spotify's response body is never passed on or logged.
 */
export async function exchangeAuthorizationCode(code: string): Promise<ExchangeResult> {
  const auth = basicAuthHeader();
  if (!auth) return { ok: false, reason: "not_configured" };
  let resp: Response;
  try {
    resp = await fetch(SPOTIFY_TOKEN_URL, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: SPOTIFY_REDIRECT_URI }),
      cache: "no-store",
    });
  } catch {
    return { ok: false, reason: "spotify_unavailable" };
  }
  if (resp.status === 400 || resp.status === 401) {
    // 400 invalid_grant = the code expired, was used already or was issued for another redirect;
    // 400/401 invalid_client = the client id / secret pair is wrong.
    let kind = "";
    try {
      kind = String(((await resp.json()) as { error?: unknown }).error ?? "");
    } catch {
      kind = "";
    }
    console.error("Spotify code exchange refused:", resp.status, /^[a-z_]{1,40}$/.test(kind) ? kind : "unknown");
    return { ok: false, reason: kind === "invalid_client" ? "not_configured" : "code_rejected" };
  }
  if (!resp.ok) {
    console.error("Spotify code exchange failed:", resp.status);
    return { ok: false, reason: "spotify_unavailable" };
  }
  try {
    return { ok: true, token: await resp.json() };
  } catch {
    return { ok: false, reason: "spotify_unavailable" };
  }
}

/**
 * One recently-played call with a new access token: proves the token works for the read the ETL
 * makes every hour before anything is stored. "forbidden" = the account is not allowed on the app
 * (Development Mode allowlist) or the scope is missing.
 */
export async function probeRecentlyPlayed(accessToken: string): Promise<"ok" | "forbidden" | "unavailable"> {
  let resp: Response;
  try {
    resp = await fetch(`${SPOTIFY_API}/me/player/recently-played?limit=1`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
  } catch {
    return "unavailable";
  }
  if (resp.ok) return "ok";
  console.error("Spotify reconnect probe failed:", resp.status);
  return resp.status === 401 || resp.status === 403 ? "forbidden" : "unavailable";
}

/** Strict store for the reconnect: returns false when the row was not written (the caller answers 500). */
export async function storeSpotifyTokens(tokens: SpotifyTokenBlob): Promise<boolean> {
  const { error } = await supabaseAdmin()
    .from("ci_tokens")
    .upsert({
      service: "spotify",
      token_data: serializeTokenBlob(tokens),
      updated_at: new Date().toISOString(),
    });
  if (error) {
    console.error("Spotify reconnect: token store failed:", error.code);
    return false;
  }
  return true;
}

/**
 * Returns a valid access token, refreshing on every call. Writes the refreshed blob back to
 * ci_tokens (newer-wins) so the Python ETL stays in sync. Every key of the stored blob is kept,
 * including authorized_at.
 */
export async function getSpotifyAccessToken(): Promise<string> {
  const auth = basicAuthHeader();
  if (!auth) throw new Error("Spotify is not configured on the server (SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET)");
  const tokens = await loadTokens();
  const loadedRefreshToken = tokens.refresh_token;
  const resp = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    if (resp.status === 400 && body.includes("invalid_grant")) {
      // The refresh token expired (180 days after authorization) or was revoked.
      throw new Error(`Spotify refresh token rejected. ${SPOTIFY_RECONNECT_HINT}`);
    }
    throw new Error(`Spotify token refresh failed (${resp.status}): ${body}`);
  }
  const fresh = await resp.json();
  tokens.access_token = fresh.access_token;
  tokens.expires_in = fresh.expires_in ?? 3600;
  tokens.obtained_at = Math.floor(Date.now() / 1000);
  if (fresh.refresh_token) {
    tokens.refresh_token = fresh.refresh_token;
  }
  await saveTokens(tokens, loadedRefreshToken);
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

  // 1a. Enforce visibility via three layered attempts.
  //
  //     KNOWN ISSUE (audited 2026-05-25): on Spotify Development Mode apps
  //     (apps without Extended Quota approval) the `public` field on both
  //     POST /me/playlists and PUT /playlists/{id} is silently accepted but
  //     ignored — the playlist lands Public regardless. There's no clean
  //     code-only fix; the durable paths are (a) apply for Extended Quota
  //     in the Spotify dashboard, or (b) the playlist owner toggles the
  //     visibility manually in the Spotify app. This code tries every
  //     documented lever (PUT body + PUT /followers) and then VERIFIES the
  //     end-state via GET so we can surface an honest warning rather than
  //     pretending success.
  //
  //     PUT /playlists/{id} — documented visibility setter; silently
  //     ignored in Dev mode.
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

  //     PUT /playlists/{id}/followers — the OWNER auto-follows on create;
  //     the follow's `public` flag is a secondary lever some users report
  //     actually takes effect. Empirically untested in Dev mode; logged
  //     for diagnostic. Body is documented as the follow's visibility, not
  //     the playlist's, but we try regardless.
  const followResp = await spotifyFetch(`/playlists/${playlistId}/followers`, {
    accessToken,
    method: "PUT",
    body: JSON.stringify({ public: isPublic }),
  });
  if (!followResp.ok) {
    console.warn(
      `Spotify followers PUT (visibility plan B) failed (${followResp.status}) for ${playlistId}: ${await followResp.text()}`
    );
  }

  //     Verify end-state. GET /playlists/{id} after both write attempts
  //     and log whether `public` actually matches isPublic. Surfaces the
  //     silent-ignore bug instead of letting it pass unnoticed.
  if (!isPublic) {
    const verifyResp = await spotifyFetch(`/playlists/${playlistId}?fields=public,name`, { accessToken });
    if (verifyResp.ok) {
      const verifyJson = await verifyResp.json();
      if (verifyJson.public === true) {
        console.warn(
          `Spotify visibility BUG confirmed for ${playlistId} ("${verifyJson.name}"): ` +
            `requested public=false but playlist landed Public after both PUT attempts. ` +
            `Dev-mode limitation — toggle manually in Spotify app, or apply for Extended Quota.`
        );
      }
    }
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
