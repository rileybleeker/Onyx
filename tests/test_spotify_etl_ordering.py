"""Regression test for spotify_etl.run_etl upsert ordering.

Production regression on 2026-05-27: run_etl upserted plays before tracks,
and pds.spotify_plays.track_id has a NOT NULL FK to pds.spotify_tracks(track_id)
(added in commit 855e6cf, DEFERRABLE INITIALLY DEFERRED). supabase-py upserts
are individual PostgREST HTTP calls — each its own transaction — so the
DEFERRABLE keyword bought nothing across calls. Any never-before-seen track_id
crashed the plays upsert before the parent track row was ever written.

This test exercises run_etl with synthetic recently-played items and asserts:
  1. upsert_tracks is called BEFORE upsert_plays.
  2. Every track_id in the rows passed to upsert_plays is either pre-existing
     in spotify_tracks OR in the rows passed to upsert_tracks this run.
  3. If client.track(tid) raises, that play is skipped (not handed to
     upsert_plays) — would FK-violate otherwise.

A future reorder regression that re-introduces the production bug will fail.

Run: python tests/test_spotify_etl_ordering.py
"""
from __future__ import annotations
import os
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
os.environ.setdefault("SPOTIFY_CLIENT_ID", "stub")
os.environ.setdefault("SPOTIFY_CLIENT_SECRET", "stub")

import spotify_etl  # noqa: E402


def _make_play(track_id: str, artist_id: str, played_at: str) -> dict:
    """Synthesize one /me/player/recently-played item shape."""
    return {
        "played_at": played_at,
        "track": {
            "id": track_id,
            "name": f"Track {track_id}",
            "duration_ms": 180000,
            "artists": [{"id": artist_id, "name": f"Artist {artist_id}"}],
            "album": {
                "id": "alb1", "name": "Album",
                "release_date": "2026-01-01", "images": [],
            },
            "popularity": 50,
            "explicit": False,
            "external_ids": {"isrc": "ZZ0000000000"},
        },
        "context": None,
    }


def _track_obj(tid: str, artist_id: str = "ART") -> dict:
    return {
        "id": tid,
        "name": f"Track {tid}",
        "duration_ms": 180000,
        "artists": [{"id": artist_id, "name": f"Artist {artist_id}"}],
        "album": {
            "id": "alb1", "name": "Album",
            "release_date": "2026-01-01", "images": [],
        },
        "popularity": 50,
        "explicit": False,
        "external_ids": {"isrc": "ZZ0000000000"},
    }


def _run_etl_with_mocks(
    items: list[dict],
    existing_tracks: set[str],
    track_side_effect,
) -> dict:
    """Drive run_etl with a fully-mocked surface; return captured invocation order
    + the track_id lists handed to upsert_tracks and upsert_plays."""
    captured: dict = {
        "call_order": [],
        "tracks_upserted": None,
        "plays_upserted": None,
    }

    def _existing_tracks(_sb, _ids):
        captured["call_order"].append("existing_track_ids")
        return set(existing_tracks)

    def _existing_artists(_sb, _ids):
        captured["call_order"].append("existing_artist_ids")
        return set()

    def _upsert_tracks(_sb, tracks, _features):
        captured["call_order"].append("upsert_tracks")
        captured["tracks_upserted"] = [t.get("id") for t in tracks if t and t.get("id")]
        return len(tracks)

    def _upsert_artists(_sb, artists):
        captured["call_order"].append("upsert_artists")
        return len(artists)

    def _upsert_plays(_sb, items_):
        captured["call_order"].append("upsert_plays")
        captured["plays_upserted"] = [
            (i.get("track") or {}).get("id") for i in items_
        ]
        return len(items_)

    fake_client = MagicMock()
    fake_client.recently_played.return_value = items
    fake_client.track.side_effect = track_side_effect
    # Returns one artist obj per requested id; shape is irrelevant for ordering.
    fake_client.artists.side_effect = lambda ids: [
        {"id": aid, "name": f"Artist {aid}", "genres": [],
         "popularity": 50, "followers": {"total": 100}, "images": []}
        for aid in ids
    ]

    patches = [
        patch.object(spotify_etl, "get_supabase", return_value=MagicMock()),
        patch.object(spotify_etl, "load_tokens",
                     return_value={"access_token": "a", "refresh_token": "r"}),
        patch.object(spotify_etl, "refresh_access_token", side_effect=lambda t: t),
        patch.object(spotify_etl, "SpotifyClient", return_value=fake_client),
        patch.object(spotify_etl, "get_high_water_mark", return_value=None),
        patch.object(spotify_etl, "existing_track_ids", side_effect=_existing_tracks),
        patch.object(spotify_etl, "existing_artist_ids", side_effect=_existing_artists),
        patch.object(spotify_etl, "fetch_audio_features_reccobeats", return_value={}),
        patch.object(spotify_etl, "enrich_genres_via_musicbrainz", return_value=0),
        patch.object(spotify_etl, "upsert_tracks", side_effect=_upsert_tracks),
        patch.object(spotify_etl, "upsert_artists", side_effect=_upsert_artists),
        patch.object(spotify_etl, "upsert_plays", side_effect=_upsert_plays),
        patch.object(spotify_etl, "log_sync"),
        patch.object(spotify_etl, "log_sync_entry"),
    ]
    for p in patches:
        p.start()
    try:
        spotify_etl.run_etl(refeaturize=False)
    finally:
        for p in patches:
            p.stop()
    return captured


def test_tracks_upsert_before_plays_and_fk_invariant() -> None:
    """run_etl must upsert tracks before plays; every play's track_id must be
    in either the pre-existing set or the rows passed to upsert_tracks."""
    new_tid = "NEW_TRACK_001"
    existing_tid = "EXISTING_TRACK_001"
    items = [
        _make_play(new_tid, "ART_NEW", "2026-05-27T15:00:00.000Z"),
        _make_play(existing_tid, "ART_EX", "2026-05-27T15:05:00.000Z"),
    ]
    captured = _run_etl_with_mocks(
        items=items,
        existing_tracks={existing_tid},
        track_side_effect=lambda tid: _track_obj(tid),
    )

    order = captured["call_order"]
    assert "upsert_tracks" in order, f"upsert_tracks never called; order={order}"
    assert "upsert_plays" in order, f"upsert_plays never called; order={order}"
    tracks_idx = order.index("upsert_tracks")
    plays_idx = order.index("upsert_plays")
    assert tracks_idx < plays_idx, (
        f"upsert_tracks (idx {tracks_idx}) must precede upsert_plays "
        f"(idx {plays_idx}). Order: {order}"
    )

    landed = set(captured["tracks_upserted"]) | {existing_tid}
    played = set(captured["plays_upserted"])
    orphans = played - landed
    assert not orphans, (
        f"FK invariant violated: play track_ids {orphans} are not in "
        f"spotify_tracks. landed={landed}, played={played}"
    )

    assert new_tid in captured["tracks_upserted"], (
        f"new track {new_tid} should have been upserted; "
        f"got {captured['tracks_upserted']}"
    )
    assert existing_tid not in captured["tracks_upserted"], (
        f"existing track {existing_tid} should have been filtered out by "
        f"existing_track_ids; got {captured['tracks_upserted']}"
    )


def test_play_with_unfetchable_track_is_skipped() -> None:
    """If client.track(tid) raises, that play must NOT be passed to upsert_plays
    (would FK-violate). The good play in the same batch still goes through."""
    import httpx
    bad_tid = "BAD_TRACK"
    good_tid = "GOOD_TRACK"
    items = [
        _make_play(bad_tid, "ART_A", "2026-05-27T15:00:00.000Z"),
        _make_play(good_tid, "ART_B", "2026-05-27T15:05:00.000Z"),
    ]

    def _track_side_effect(tid: str) -> dict:
        if tid == bad_tid:
            raise httpx.HTTPError(f"simulated network failure for {tid}")
        return _track_obj(tid)

    captured = _run_etl_with_mocks(
        items=items,
        existing_tracks=set(),
        track_side_effect=_track_side_effect,
    )

    played = set(captured["plays_upserted"])
    assert bad_tid not in played, (
        f"bad track {bad_tid} should have been skipped from plays; got {played}"
    )
    assert good_tid in played, (
        f"good track {good_tid} should have been kept; got {played}"
    )
    landed = set(captured["tracks_upserted"])
    assert good_tid in landed and bad_tid not in landed, (
        f"only good_tid should have landed in tracks; got {landed}"
    )


if __name__ == "__main__":
    test_tracks_upsert_before_plays_and_fk_invariant()
    print("PASS: test_tracks_upsert_before_plays_and_fk_invariant")
    test_play_with_unfetchable_track_is_skipped()
    print("PASS: test_play_with_unfetchable_track_is_skipped")
    print("All tests passed.")
