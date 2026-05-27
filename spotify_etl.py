"""
Personal Data Scientist — Spotify ETL Pipeline
================================================
Syncs Spotify recently-played history to Supabase (Postgres 17, pds schema).

Two tables:
  - pds.spotify_plays   (append-only log, one row per played track)
  - pds.spotify_tracks  (dim table, one row per unique track + audio features)

Spotify's /v1/me/player/recently-played endpoint returns the last 50 plays.
The ETL runs every 2h (via GitHub Actions) and uses the high-water mark of
MAX(played_at) to fetch only new plays since the last run.

Audio features: Spotify deprecated /v1/audio-features for apps registered
after 2024-11-27. This app is post-cutoff, so we use ReccoBeats (accepts
Spotify track IDs) as the features source. `features_source` records provenance.

Usage:
    python spotify_etl.py --auth        # One-time OAuth bootstrap (local only)
    python spotify_etl.py               # Normal run: pull recent plays + featurize new tracks
    python spotify_etl.py --backfill 50 # No-op past 50 (Spotify's hard ceiling)
    python spotify_etl.py --refeaturize # Re-fetch features for tracks with NULL valence
"""

import os
import sys
import json
import time
import base64
import argparse
import logging
import secrets
import urllib.parse
import webbrowser
from datetime import datetime, timezone
from http.server import HTTPServer, BaseHTTPRequestHandler

import httpx
from dotenv import load_dotenv
from postgrest.exceptions import APIError as PostgrestAPIError
from supabase import create_client, Client

from sync_log_helper import log_sync as _shared_log_sync

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
load_dotenv()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

SPOTIFY_CLIENT_ID = os.environ.get("SPOTIFY_CLIENT_ID", "")
SPOTIFY_CLIENT_SECRET = os.environ.get("SPOTIFY_CLIENT_SECRET", "")
SPOTIFY_REDIRECT_URI = os.environ.get("SPOTIFY_REDIRECT_URI", "http://127.0.0.1:8888/callback")
SPOTIFY_TOKEN_FILE = os.path.expanduser("~/.spotify_tokens.json")

SPOTIFY_SCOPES = "user-read-recently-played playlist-modify-private"
SPOTIFY_AUTH_URL = "https://accounts.spotify.com/authorize"
SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token"
SPOTIFY_API = "https://api.spotify.com/v1"

RECCOBEATS_API = "https://api.reccobeats.com/v1"

# MusicBrainz — used for genre tags because Spotify's Dev Mode strips `genres`,
# `popularity`, and `followers` from artist responses post-Feb 2026.
MUSICBRAINZ_API = "https://musicbrainz.org/ws/2"
MUSICBRAINZ_USER_AGENT = "Onyx-PersonalDataScientist/1.0 (https://github.com/rileybleeker/Onyx)"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("spotify_etl")


# ---------------------------------------------------------------------------
# Token storage (~/.spotify_tokens.json — same pattern as WHOOP)
# ---------------------------------------------------------------------------

def load_tokens() -> dict:
    if not os.path.exists(SPOTIFY_TOKEN_FILE):
        log.error(
            f"No Spotify tokens at {SPOTIFY_TOKEN_FILE}. "
            "Run `python spotify_etl.py --auth` locally, then "
            "`python ci_token_helper.py upload spotify`."
        )
        sys.exit(1)
    with open(SPOTIFY_TOKEN_FILE, "r") as f:
        return json.load(f)


def save_tokens(tokens: dict):
    with open(SPOTIFY_TOKEN_FILE, "w") as f:
        json.dump(tokens, f, indent=2)
    log.info(f"Spotify tokens saved to {SPOTIFY_TOKEN_FILE}")


# ---------------------------------------------------------------------------
# OAuth — one-time bootstrap (run locally)
# ---------------------------------------------------------------------------

class _CallbackHandler(BaseHTTPRequestHandler):
    """Single-use handler that captures Spotify's ?code= and ?state= params."""
    auth_code: str | None = None
    auth_state: str | None = None

    def do_GET(self):  # noqa: N802 (BaseHTTPRequestHandler API)
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        _CallbackHandler.auth_code = (params.get("code") or [None])[0]
        _CallbackHandler.auth_state = (params.get("state") or [None])[0]
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        msg = "Spotify authorized. You can close this tab."
        self.wfile.write(f"<html><body><h2>{msg}</h2></body></html>".encode())

    def log_message(self, format, *args):  # silence default logging
        return


def run_auth_flow():
    """Open browser → Spotify consent → capture code → exchange for tokens."""
    if not SPOTIFY_CLIENT_ID or not SPOTIFY_CLIENT_SECRET:
        log.error("SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set in .env")
        sys.exit(1)

    state = secrets.token_urlsafe(16)
    params = {
        "client_id": SPOTIFY_CLIENT_ID,
        "response_type": "code",
        "redirect_uri": SPOTIFY_REDIRECT_URI,
        "scope": SPOTIFY_SCOPES,
        "state": state,
    }
    auth_url = f"{SPOTIFY_AUTH_URL}?{urllib.parse.urlencode(params)}"

    parsed_redirect = urllib.parse.urlparse(SPOTIFY_REDIRECT_URI)
    host = parsed_redirect.hostname or "127.0.0.1"
    port = parsed_redirect.port or 8888

    server = HTTPServer((host, port), _CallbackHandler)
    log.info(f"Listening for callback on {host}:{port}")
    log.info(f"Opening browser to: {auth_url}")
    webbrowser.open(auth_url)

    # Serve until we have a code
    while _CallbackHandler.auth_code is None:
        server.handle_request()

    if _CallbackHandler.auth_state != state:
        log.error("State mismatch — possible CSRF; aborting.")
        sys.exit(1)

    code = _CallbackHandler.auth_code
    log.info("Captured authorization code; exchanging for tokens...")

    basic = base64.b64encode(f"{SPOTIFY_CLIENT_ID}:{SPOTIFY_CLIENT_SECRET}".encode()).decode()
    resp = httpx.post(
        SPOTIFY_TOKEN_URL,
        headers={"Authorization": f"Basic {basic}"},
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": SPOTIFY_REDIRECT_URI,
        },
        timeout=30,
    )
    resp.raise_for_status()
    tokens = resp.json()
    tokens["obtained_at"] = int(time.time())
    save_tokens(tokens)
    log.info("OAuth bootstrap complete. Run `python ci_token_helper.py upload spotify` next.")


# ---------------------------------------------------------------------------
# Token refresh
# ---------------------------------------------------------------------------

class SpotifyAuthError(Exception):
    """Raised when Spotify refuses the stored refresh token (expired/revoked).

    Distinct from transient HTTP errors so the ETL can write an actionable
    sync_log entry and exit 0 (no retry) instead of looping the cron on a
    permanently-broken token.
    """


REAUTH_INSTRUCTIONS = (
    "Spotify refresh token rejected. Re-run `python spotify_etl.py --auth` "
    "locally then `python ci_token_helper.py upload spotify`."
)


def refresh_access_token(tokens: dict) -> dict:
    """Exchange refresh_token for a fresh access_token. Returns updated tokens dict.

    Raises SpotifyAuthError on a 400/401 from /api/token — the documented
    invalid_grant response when the refresh token has expired or been revoked
    (Spotify rotates these occasionally; see CLAUDE.md).
    """
    basic = base64.b64encode(f"{SPOTIFY_CLIENT_ID}:{SPOTIFY_CLIENT_SECRET}".encode()).decode()
    resp = httpx.post(
        SPOTIFY_TOKEN_URL,
        headers={"Authorization": f"Basic {basic}"},
        data={
            "grant_type": "refresh_token",
            "refresh_token": tokens["refresh_token"],
        },
        timeout=30,
    )
    if resp.status_code in (400, 401):
        raise SpotifyAuthError(f"{REAUTH_INSTRUCTIONS} (HTTP {resp.status_code}: {resp.text})")
    resp.raise_for_status()
    new = resp.json()
    tokens["access_token"] = new["access_token"]
    tokens["expires_in"] = new.get("expires_in", 3600)
    tokens["obtained_at"] = int(time.time())
    # Spotify rotates refresh tokens occasionally
    if "refresh_token" in new:
        tokens["refresh_token"] = new["refresh_token"]
        log.info("Refresh token rotated; saving new value.")
    save_tokens(tokens)
    return tokens


# ---------------------------------------------------------------------------
# Spotify API client
# ---------------------------------------------------------------------------

class SpotifyClient:
    def __init__(self, tokens: dict):
        self.tokens = tokens
        self.http = httpx.Client(timeout=30)

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.tokens['access_token']}"}

    def _request(self, method: str, url: str, **kwargs):
        resp = self.http.request(method, url, headers=self._headers(), **kwargs)
        if resp.status_code == 401:
            log.info("Access token expired; refreshing.")
            self.tokens = refresh_access_token(self.tokens)
            resp = self.http.request(method, url, headers=self._headers(), **kwargs)
        resp.raise_for_status()
        return resp

    def recently_played(self, after_ms: int | None = None, limit: int = 50) -> list[dict]:
        """GET /me/player/recently-played. `after_ms` is a Unix ms timestamp."""
        params = {"limit": limit}
        if after_ms is not None:
            params["after"] = after_ms
        resp = self._request("GET", f"{SPOTIFY_API}/me/player/recently-played", params=params)
        return resp.json().get("items", [])

    def track(self, track_id: str) -> dict:
        resp = self._request("GET", f"{SPOTIFY_API}/tracks/{track_id}")
        return resp.json()

    def artists(self, artist_ids: list[str]) -> list[dict]:
        """
        Fetch artist objects one at a time.

        Spotify's Feb 2026 migration removed the batch GET /v1/artists?ids=...
        endpoint for Development Mode apps (bare 403 Forbidden, no scope hint —
        matching the playlist-endpoint symptom documented in CLAUDE.md). The
        replacement is per-id GET /v1/artists/{id}. Rate limits are generous
        for this endpoint; a tiny sleep keeps us polite without slowing things.
        """
        out: list[dict] = []
        for aid in artist_ids:
            try:
                resp = self._request("GET", f"{SPOTIFY_API}/artists/{aid}")
                out.append(resp.json())
            except httpx.HTTPStatusError as e:
                if e.response.status_code == 404:
                    log.warning(f"Artist {aid} returned 404 — skipping.")
                    continue
                raise
            time.sleep(0.05)
        return out


# ---------------------------------------------------------------------------
# Audio features (ReccoBeats — Spotify endpoint is dead for post-Nov-2024 apps)
# ---------------------------------------------------------------------------

def fetch_audio_features_reccobeats(track_ids: list[str]) -> dict[str, dict]:
    """
    ReccoBeats accepts a comma-separated list of Spotify track IDs and returns
    audio features. API shape: GET /track?ids=id1,id2,... — see reccobeats.com docs.
    Returns {track_id: {valence, energy, tempo, ...}}.
    """
    if not track_ids:
        return {}

    out: dict[str, dict] = {}
    # ReccoBeats accepts up to ~40 ids per request — chunk to be safe
    CHUNK = 40
    with httpx.Client(timeout=30) as client:
        for i in range(0, len(track_ids), CHUNK):
            batch = track_ids[i:i + CHUNK]
            try:
                # ReccoBeats endpoint: returns track metadata for resolved Spotify IDs
                resp = client.get(f"{RECCOBEATS_API}/track", params={"ids": ",".join(batch)})
                if resp.status_code != 200:
                    log.warning(
                        f"ReccoBeats /track returned {resp.status_code} for batch of {len(batch)}; skipping batch."
                    )
                    continue
                content = resp.json().get("content", [])
                # Each item in content has an internal ReccoBeats id; fetch features for each
                for item in content:
                    rb_id = item.get("id")
                    spotify_id = None
                    href = item.get("href", "")
                    if "spotify.com/track/" in href:
                        spotify_id = href.rsplit("/", 1)[-1].split("?")[0]
                    if not (rb_id and spotify_id):
                        continue
                    feat_resp = client.get(f"{RECCOBEATS_API}/track/{rb_id}/audio-features")
                    if feat_resp.status_code != 200:
                        log.warning(f"ReccoBeats audio-features {feat_resp.status_code} for {spotify_id}")
                        continue
                    out[spotify_id] = feat_resp.json()
                    time.sleep(0.05)  # be polite — 20 req/s ceiling
            except (httpx.HTTPError, KeyError, ValueError) as e:
                log.warning(f"ReccoBeats batch failed: {e}")
                continue

    log.info(f"ReccoBeats: resolved features for {len(out)}/{len(track_ids)} tracks")
    return out


# ---------------------------------------------------------------------------
# Supabase upserts
# ---------------------------------------------------------------------------

def get_supabase() -> Client:
    return create_client(SUPABASE_URL, SUPABASE_KEY)


def get_high_water_mark(sb: Client) -> int | None:
    """Return MAX(played_at) as Unix ms, or None if table is empty."""
    row = (
        sb.schema("pds")
        .table("spotify_plays")
        .select("played_at")
        .order("played_at", desc=True)
        .limit(1)
        .execute()
    )
    if not row.data:
        return None
    iso = row.data[0]["played_at"]
    # Postgres returns "2026-05-16T14:32:01+00:00"
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return int(dt.timestamp() * 1000)


def upsert_plays(sb: Client, items: list[dict]) -> int:
    """Upsert recently-played items into pds.spotify_plays. Returns count inserted/updated."""
    if not items:
        return 0
    rows = []
    for it in items:
        track = it.get("track") or {}
        artists = track.get("artists") or [{}]
        album = track.get("album") or {}
        ctx = it.get("context") or {}
        rows.append({
            "played_at": it["played_at"],
            "track_id": track.get("id"),
            "track_name": track.get("name"),
            "artist_id": artists[0].get("id"),
            "artist_name": artists[0].get("name"),
            "album_id": album.get("id"),
            "album_name": album.get("name"),
            "duration_ms": track.get("duration_ms"),
            "context_type": ctx.get("type"),
            "context_uri": ctx.get("uri"),
            "raw_json": it,
            "synced_at": datetime.now(timezone.utc).isoformat(),
        })
    # Filter out rows missing the PK components (defensive)
    rows = [r for r in rows if r["played_at"] and r["track_id"]]
    if not rows:
        return 0
    sb.schema("pds").table("spotify_plays").upsert(
        rows, on_conflict="played_at,track_id"
    ).execute()
    return len(rows)


def upsert_tracks(sb: Client, tracks: list[dict], features_by_id: dict[str, dict]) -> int:
    """Upsert track metadata + (optional) audio features into pds.spotify_tracks."""
    if not tracks:
        return 0
    now = datetime.now(timezone.utc).isoformat()
    rows = []
    for t in tracks:
        tid = t.get("id")
        if not tid:
            continue
        feat = features_by_id.get(tid) or {}
        external = t.get("external_ids") or {}
        rows.append({
            "track_id": tid,
            "name": t.get("name"),
            "artists": [{"id": a.get("id"), "name": a.get("name")} for a in (t.get("artists") or [])],
            "album": {
                "id": (t.get("album") or {}).get("id"),
                "name": (t.get("album") or {}).get("name"),
                "release_date": (t.get("album") or {}).get("release_date"),
                "images": (t.get("album") or {}).get("images"),
            },
            "duration_ms": t.get("duration_ms"),
            "popularity": t.get("popularity"),
            "explicit": t.get("explicit"),
            "isrc": external.get("isrc"),
            "valence": feat.get("valence"),
            "energy": feat.get("energy"),
            "tempo": feat.get("tempo"),
            "danceability": feat.get("danceability"),
            "acousticness": feat.get("acousticness"),
            "instrumentalness": feat.get("instrumentalness"),
            "liveness": feat.get("liveness"),
            "speechiness": feat.get("speechiness"),
            "loudness": feat.get("loudness"),
            "key": feat.get("key"),
            "mode": feat.get("mode"),
            "time_signature": feat.get("timeSignature") or feat.get("time_signature"),
            "features_source": "reccobeats" if feat else None,
            "features_fetched_at": now if feat else None,
            "raw_json": t,
            "synced_at": now,
        })
    sb.schema("pds").table("spotify_tracks").upsert(
        rows, on_conflict="track_id"
    ).execute()
    return len(rows)


def fetch_musicbrainz_tags(artist_name: str) -> list[str]:
    """
    Look up an artist by name on MusicBrainz, take the top-scored match, return its
    top tags (highest user-applied counts first) as a list of strings.

    Why MusicBrainz: Spotify's Dev Mode strips `genres` from the artist endpoint
    post-Feb 2026, so we use MusicBrainz's crowdsourced tag data as the genre
    source. No API key required — just a polite User-Agent.

    Returns [] if no match, no tags, or any error. Caller is responsible for the
    1-req/sec rate limit between calls.
    """
    if not artist_name:
        return []
    try:
        resp = httpx.get(
            f"{MUSICBRAINZ_API}/artist",
            params={"query": artist_name, "fmt": "json", "limit": 1},
            headers={"User-Agent": MUSICBRAINZ_USER_AGENT},
            timeout=15,
        )
        if resp.status_code != 200:
            log.warning(f"MusicBrainz returned {resp.status_code} for {artist_name!r}")
            return []
        results = resp.json().get("artists") or []
        if not results:
            return []
        tags = results[0].get("tags") or []
        tags.sort(key=lambda t: t.get("count", 0), reverse=True)
        return [t["name"] for t in tags[:8] if t.get("name")]
    except (httpx.HTTPError, KeyError, ValueError) as e:
        log.warning(f"MusicBrainz lookup failed for {artist_name!r}: {e}")
        return []


def enrich_genres_via_musicbrainz(sb: Client, pairs: list[dict]) -> int:
    """
    For each {artist_id, name} pair, fetch MusicBrainz tags and UPDATE the
    spotify_artists row in place. Respects MusicBrainz's 1 req/sec ceiling.
    Returns count of rows actually updated (matches found with non-empty tags).
    """
    updated = 0
    now = datetime.now(timezone.utc).isoformat()
    for p in pairs:
        aid = p.get("artist_id")
        name = p.get("name")
        if not (aid and name):
            continue
        tags = fetch_musicbrainz_tags(name)
        if tags:
            sb.schema("pds").table("spotify_artists").update({
                "genres": tags,
                "synced_at": now,
            }).eq("artist_id", aid).execute()
            updated += 1
        time.sleep(1.05)  # 1 req/sec ceiling, small margin
    return updated


def upsert_artists(sb: Client, artists: list[dict]) -> int:
    """Upsert artist enrichment (genres, popularity, followers) into pds.spotify_artists."""
    if not artists:
        return 0
    now = datetime.now(timezone.utc).isoformat()
    rows = []
    for a in artists:
        if not a:  # Spotify returns nulls in the array for unknown ids
            continue
        aid = a.get("id")
        if not aid:
            continue
        images = a.get("images") or []
        rows.append({
            "artist_id": aid,
            "name": a.get("name"),
            "genres": a.get("genres") or [],
            "popularity": a.get("popularity"),
            "followers": (a.get("followers") or {}).get("total"),
            "image_url": images[0].get("url") if images else None,
            "raw_json": a,
            "fetched_at": now,
            "synced_at": now,
        })
    if not rows:
        return 0
    sb.schema("pds").table("spotify_artists").upsert(
        rows, on_conflict="artist_id"
    ).execute()
    return len(rows)


def existing_artist_ids(sb: Client, artist_ids: list[str]) -> set[str]:
    """Return the subset of artist_ids already in pds.spotify_artists."""
    if not artist_ids:
        return set()
    out: set[str] = set()
    CHUNK = 100
    for i in range(0, len(artist_ids), CHUNK):
        batch = artist_ids[i:i + CHUNK]
        row = (
            sb.schema("pds")
            .table("spotify_artists")
            .select("artist_id")
            .in_("artist_id", batch)
            .execute()
        )
        out.update(r["artist_id"] for r in (row.data or []))
    return out


def existing_track_ids(sb: Client, track_ids: list[str]) -> set[str]:
    """Return the subset of track_ids already in pds.spotify_tracks."""
    if not track_ids:
        return set()
    out: set[str] = set()
    # Chunk to avoid URL-length limits on .in_()
    CHUNK = 100
    for i in range(0, len(track_ids), CHUNK):
        batch = track_ids[i:i + CHUNK]
        row = (
            sb.schema("pds")
            .table("spotify_tracks")
            .select("track_id")
            .in_("track_id", batch)
            .execute()
        )
        out.update(r["track_id"] for r in (row.data or []))
    return out


def log_sync(sb: Client, status: str, records: int, started_at: float, error: str | None = None):
    log_sync_entry(sb, source="spotify", data_type="plays",
                   status=status, records=records, started_at=started_at, error=error)


def log_sync_entry(
    sb: Client,
    source: str,
    data_type: str,
    status: str,
    records: int,
    started_at: float,
    error: str | None = None,
):
    """Generic sync_log insert for ETL subsystems (Spotify, ReccoBeats, MusicBrainz, ...)."""
    _shared_log_sync(sb, source=source, data_type=data_type, status=status,
                     records=records, started_at=started_at, error=error)


# ---------------------------------------------------------------------------
# Main flows
# ---------------------------------------------------------------------------

def run_backfill_artists():
    """One-shot: enrich every distinct artist in spotify_plays not already in spotify_artists."""
    started = time.time()
    sb = get_supabase()

    tokens = load_tokens()
    try:
        tokens = refresh_access_token(tokens)
    except SpotifyAuthError as e:
        log.error(str(e))
        log_sync_entry(sb, source="spotify", data_type="artist_backfill",
                       status="failed", records=0, started_at=started, error=str(e))
        sys.exit(0)
    client = SpotifyClient(tokens)

    # Pull distinct artist_ids from spotify_plays in pages (Supabase row limit is 1000/req)
    all_ids: set[str] = set()
    page_size = 1000
    offset = 0
    while True:
        resp = (
            sb.schema("pds").table("spotify_plays")
            .select("artist_id")
            .not_.is_("artist_id", "null")
            .range(offset, offset + page_size - 1)
            .execute()
        )
        rows = resp.data or []
        if not rows:
            break
        all_ids.update(r["artist_id"] for r in rows if r.get("artist_id"))
        if len(rows) < page_size:
            break
        offset += page_size

    log.info(f"Found {len(all_ids)} distinct artists in spotify_plays")

    already = existing_artist_ids(sb, list(all_ids))
    to_fetch = [aid for aid in all_ids if aid not in already]
    log.info(f"Need to enrich {len(to_fetch)} artists (skipping {len(already)} already in dim)")

    if not to_fetch:
        log.info("Nothing to backfill — exiting.")
        return

    artists = client.artists(to_fetch)
    count = upsert_artists(sb, artists)
    log.info(f"Backfilled {count} artists in {int(time.time() - started)}s")


def run_refresh_genres():
    """Re-fetch MusicBrainz tags for every spotify_artists row whose genres are empty/null."""
    started = time.time()
    sb = get_supabase()
    resp = (
        sb.schema("pds").table("spotify_artists")
        .select("artist_id,name,genres")
        .execute()
    )
    rows = resp.data or []
    needs = [
        {"artist_id": r["artist_id"], "name": r["name"]}
        for r in rows
        if not r.get("genres") or len(r["genres"]) == 0
    ]
    log.info(f"Refreshing genres for {len(needs)} artists with empty genres")
    if not needs:
        log.info("Nothing to refresh — exiting.")
        return
    count = enrich_genres_via_musicbrainz(sb, needs)
    log.info(f"Updated {count}/{len(needs)} artists with MusicBrainz tags in {int(time.time()-started)}s")


def run_etl(refeaturize: bool = False):
    started = time.time()
    sb = get_supabase()

    tokens = load_tokens()
    try:
        tokens = refresh_access_token(tokens)
    except SpotifyAuthError as e:
        log.error(str(e))
        log_sync(sb, status="failed", records=0, started_at=started, error=str(e))
        sys.exit(0)
    client = SpotifyClient(tokens)

    try:
        hwm_ms = get_high_water_mark(sb)
        log.info(f"High-water mark: {hwm_ms} ({datetime.fromtimestamp(hwm_ms/1000, tz=timezone.utc) if hwm_ms else 'none'})")

        items = client.recently_played(after_ms=hwm_ms, limit=50)
        log.info(f"Spotify returned {len(items)} recently-played items")

        # Cap-hit detection: Spotify's /me/player/recently-played stores at most
        # the last 50 plays server-side, regardless of pagination params. If we
        # got exactly 50, plays older than the oldest item in this batch were
        # already discarded by Spotify before we polled — gap in history. Cron
        # is hourly to minimize this, but log a warning so the gap is visible.
        cap_hit = len(items) >= 50
        if cap_hit:
            log.warning(
                "Spotify recently-played returned exactly 50 items — likely "
                "hit the rolling 50-track cap. Some plays between the prior "
                "high-water mark and the oldest item in this batch may have "
                "been lost server-side."
            )

        plays_count = upsert_plays(sb, items)
        log.info(f"Upserted {plays_count} plays")

        # Resolve new tracks (not yet in spotify_tracks) and featurize them
        new_track_ids = list({(it.get("track") or {}).get("id") for it in items if (it.get("track") or {}).get("id")})
        already = existing_track_ids(sb, new_track_ids)
        to_fetch = [tid for tid in new_track_ids if tid not in already]
        log.info(f"New tracks to enrich: {len(to_fetch)} (skipping {len(already)} already in dim)")

        track_objs: list[dict] = []
        for tid in to_fetch:
            try:
                track_objs.append(client.track(tid))
            except httpx.HTTPError as e:
                log.warning(f"Failed to fetch track {tid}: {e}")

        reccobeats_started = time.time()
        features = fetch_audio_features_reccobeats(to_fetch) if to_fetch else {}
        tracks_count = upsert_tracks(sb, track_objs, features)
        log.info(f"Upserted {tracks_count} tracks")
        # Heartbeat for ReccoBeats — log even when no items were attempted so the
        # status page sees a fresh entry every run. Status='partial' only if we
        # tried to enrich items but ReccoBeats resolved none.
        rb_status = "success" if (not to_fetch or features) else "partial"
        log_sync_entry(
            sb, source="reccobeats", data_type="audio_features",
            status=rb_status, records=len(features), started_at=reccobeats_started,
        )

        # Resolve new artists (not yet in spotify_artists) and enrich them.
        # Audit P1 fix: previously only the primary artist (artists[0]) was
        # enqueued for enrichment, so collaborator artists on multi-artist
        # tracks never got an artist-images / MusicBrainz-genres row. Iterate
        # every artist on every play. spotify_plays.artist_id intentionally
        # remains the primary artist (artists[0]) — see upsert_plays — since
        # that's a single-FK column; the collaborators live in
        # spotify_tracks.artists JSONB and now in spotify_artists too.
        new_artist_ids = list({
            a.get("id")
            for it in items
            for a in ((it.get("track") or {}).get("artists") or [])
            if a.get("id")
        })
        already_artists = existing_artist_ids(sb, new_artist_ids)
        artists_to_fetch = [aid for aid in new_artist_ids if aid not in already_artists]
        mb_started = time.time()
        mb_matched = 0
        mb_attempted = 0
        mb_error: str | None = None
        if artists_to_fetch:
            try:
                artist_objs = client.artists(artists_to_fetch)
                artists_count = upsert_artists(sb, artist_objs)
                log.info(f"Upserted {artists_count} artists (Spotify: name + images)")
                # Genres come from MusicBrainz — Spotify's Dev Mode strips them.
                pairs = [
                    {"artist_id": a.get("id"), "name": a.get("name")}
                    for a in artist_objs if a and a.get("id")
                ]
                if pairs:
                    mb_attempted = len(pairs)
                    mb_matched = enrich_genres_via_musicbrainz(sb, pairs)
                    log.info(f"Resolved genres via MusicBrainz for {mb_matched}/{mb_attempted} artists")
            except (httpx.HTTPError, PostgrestAPIError) as e:
                # PostgrestAPIError catches Supabase-side failures (RLS denial,
                # schema drift, constraint violation) — without this, plays got
                # written, but the script crashed before the sync_log heartbeat
                # for either musicbrainz or the main spotify run could fire.
                log.warning(f"Artist enrichment failed (non-fatal): {e}")
                mb_error = str(e)
        # Heartbeat for MusicBrainz — log every run so /status sees us alive.
        # Status='partial' only if we attempted lookups and zero matched.
        mb_status = "failed" if mb_error else ("partial" if (mb_attempted > 0 and mb_matched == 0) else "success")
        log_sync_entry(
            sb, source="musicbrainz", data_type="artist_tags",
            status=mb_status, records=mb_matched, started_at=mb_started, error=mb_error,
        )

        # Optional: backfill features for previously-stored tracks that lack them
        if refeaturize:
            unfeat = (
                sb.schema("pds").table("spotify_tracks")
                .select("track_id")
                .is_("features_source", "null")
                .limit(200)
                .execute()
            )
            unfeat_ids = [r["track_id"] for r in (unfeat.data or [])]
            log.info(f"Refeaturize: {len(unfeat_ids)} tracks need features")
            if unfeat_ids:
                refeat = fetch_audio_features_reccobeats(unfeat_ids)
                if refeat:
                    # Update only the features columns; preserve other metadata
                    now = datetime.now(timezone.utc).isoformat()
                    for tid, feat in refeat.items():
                        sb.schema("pds").table("spotify_tracks").update({
                            "valence": feat.get("valence"),
                            "energy": feat.get("energy"),
                            "tempo": feat.get("tempo"),
                            "danceability": feat.get("danceability"),
                            "acousticness": feat.get("acousticness"),
                            "instrumentalness": feat.get("instrumentalness"),
                            "liveness": feat.get("liveness"),
                            "speechiness": feat.get("speechiness"),
                            "loudness": feat.get("loudness"),
                            "key": feat.get("key"),
                            "mode": feat.get("mode"),
                            "time_signature": feat.get("timeSignature") or feat.get("time_signature"),
                            "features_source": "reccobeats",
                            "features_fetched_at": now,
                        }).eq("track_id", tid).execute()

        final_status = "partial" if cap_hit else "success"
        final_error = (
            "Hit Spotify 50-track recently-played cap — likely lost some plays"
            if cap_hit else None
        )
        log_sync(sb, status=final_status, records=plays_count, started_at=started,
                 error=final_error)
        log.info(f"Spotify ETL complete: {plays_count} plays, {tracks_count} tracks in {int(time.time()-started)}s")

    except SpotifyAuthError as e:
        # Refresh token died mid-run (rare: access-token refresh inside _request).
        # Same actionable message + exit 0 as the pre-flight catch above.
        log.error(str(e))
        log_sync(sb, status="failed", records=0, started_at=started, error=str(e))
        sys.exit(0)
    except Exception as e:
        log.exception("Spotify ETL failed")
        log_sync(sb, status="failed", records=0, started_at=started, error=str(e))
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="Spotify ETL Pipeline")
    parser.add_argument("--auth", action="store_true", help="One-time OAuth bootstrap (run locally)")
    parser.add_argument("--refeaturize", action="store_true", help="Backfill audio features for tracks with NULL valence")
    parser.add_argument("--backfill-artists", action="store_true", help="Enrich every distinct artist in spotify_plays not yet in spotify_artists")
    parser.add_argument("--refresh-genres", action="store_true", help="Re-fetch MusicBrainz tags for spotify_artists rows with empty genres")
    parser.add_argument("--backfill", type=int, help="(no-op past 50 — Spotify hard ceiling)")
    args = parser.parse_args()

    if args.auth:
        run_auth_flow()
        return

    if args.backfill_artists:
        run_backfill_artists()
        return

    if args.refresh_genres:
        run_refresh_genres()
        return

    if args.backfill and args.backfill > 50:
        log.warning("Spotify recently-played returns at most 50 items; ignoring --backfill > 50")

    run_etl(refeaturize=args.refeaturize)


if __name__ == "__main__":
    main()
