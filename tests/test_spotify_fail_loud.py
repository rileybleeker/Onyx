"""The Spotify ETL must fail loudly, and a failed run must not damage the stored token.

Incident 2026-11-13: Spotify refused the refresh token (`invalid_grant`, "Refresh token
expired": refresh tokens now die 180 days after the sign-in). run_etl wrote one failed
sync_log row and exited 0, so the hourly GitHub Actions run stayed green for a day while
nothing synced, and the workflow's `if: always()` upload step put the dead token back
into pds.ci_tokens every hour.

What is pinned here, offline, with a fake Spotify and a fake Supabase (synthetic values
only, no network, no credentials):
  1. refresh token refused        -> failed heartbeats for spotify, reccobeats and
                                     musicbrainz, exit 1, token file untouched
  2. wrong app credentials        -> same, with a message that names the secrets
  3. no / unusable token file     -> failed heartbeats, exit 1 (used to exit with no row)
  4. recently-played fetch fails  -> failed heartbeats, exit 1
  5. auth dies mid-run            -> a subsystem that already reported is not reported twice
  6. normal, zero-play and 50-cap runs return normally (exit 0): success / success / partial
  7. the sign-in expiry warning turns the heartbeat partial 14 days ahead, run stays green
  8. --exchange-code: accepts a code or the callback URL, records authorized_at, and
     saves nothing when Spotify refuses the code
  9. ci_token_helper upload spotify: skips a file the ETL never refreshed, refuses an
     empty one, uploads a refreshed one

Run: python tests/test_spotify_fail_loud.py
"""
from __future__ import annotations

import contextlib
import json
import os
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
os.environ.setdefault("SPOTIFY_CLIENT_ID", "stub-client-id")
os.environ.setdefault("SPOTIFY_CLIENT_SECRET", "stub-client-secret")

import httpx  # noqa: E402

import ci_token_helper  # noqa: E402
import spotify_etl  # noqa: E402

STORED = {"access_token": "old-access", "refresh_token": "stored-refresh", "expires_in": 3600,
          "obtained_at": 1_700_000_000}


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class FakeSupabase:
    """Records inserts / upserts; answers the one select ci_token_helper makes."""

    def __init__(self, stored_token_data: str | None = None):
        self.writes: list[tuple[str, str, dict]] = []   # (table, op, row)
        self.stored_token_data = stored_token_data

    def schema(self, _name):
        return self

    def table(self, name):
        return _FakeTable(self, name)

    # helpers for assertions
    def heartbeats(self) -> list[tuple[str, str]]:
        return [(f"{r['source']}|{r['data_type']}", r["status"])
                for t, op, r in self.writes if t == "sync_log"]

    def heartbeat(self, key: str) -> dict:
        rows = [r for t, op, r in self.writes
                if t == "sync_log" and f"{r['source']}|{r['data_type']}" == key]
        assert len(rows) == 1, f"expected exactly one {key} heartbeat, got {len(rows)}"
        return rows[0]

    def token_uploads(self) -> list[dict]:
        return [r for t, op, r in self.writes if t == "ci_tokens"]


class _FakeTable:
    def __init__(self, sb: FakeSupabase, name: str):
        self.sb, self.name, self._data = sb, name, None

    def insert(self, row):
        self.sb.writes.append((self.name, "insert", row))
        return self

    def upsert(self, row):
        self.sb.writes.append((self.name, "upsert", row))
        return self

    def select(self, *_a, **_k):
        if self.name == "ci_tokens" and self.sb.stored_token_data is not None:
            self._data = {"token_data": self.sb.stored_token_data}
        return self

    def eq(self, *_a, **_k):
        return self

    def single(self):
        return self

    def execute(self):
        return SimpleNamespace(data=self._data)


class FakeResponse:
    def __init__(self, status_code: int, body):
        self.status_code, self._body = status_code, body

    def json(self):
        if isinstance(self._body, (dict, list)):
            return self._body
        raise ValueError("not json")

    @property
    def text(self):
        return json.dumps(self._body) if isinstance(self._body, (dict, list)) else str(self._body)

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("boom", request=None, response=self)


REFRESH_OK = FakeResponse(200, {"access_token": "new-access", "expires_in": 3600})
EXPIRED = FakeResponse(400, {"error": "invalid_grant", "error_description": "Refresh token expired"})
BAD_CLIENT = FakeResponse(400, {"error": "invalid_client", "error_description": "Invalid client"})


class FakeClient:
    """Stands in for SpotifyClient: no HTTP."""

    def __init__(self, tokens, items, recently_played_error=None, artists_error=None):
        self.tokens = tokens
        self._items = items
        self._rp_error = recently_played_error
        self._artists_error = artists_error

    def recently_played(self, after_ms=None, limit=50):
        if self._rp_error:
            raise self._rp_error
        return list(self._items)

    def track(self, tid):
        return {"id": tid}

    def artists(self, ids):
        if self._artists_error:
            raise self._artists_error
        return [{"id": a, "name": f"Artist {a}"} for a in ids]


def _play(n: int) -> dict:
    return {
        "played_at": f"2026-01-01T00:{n % 60:02d}:{n // 60:02d}.000Z",
        "track": {"id": f"T{n}", "artists": [{"id": f"A{n}", "name": f"Artist {n}"}]},
    }


def run(*, token_response=REFRESH_OK, stored=STORED, items=(), argv=None, **client_kw) -> SimpleNamespace:
    """Drive spotify_etl.main() (default: a plain ETL run) against the fakes.
    Returns the exit code (0 = returned normally), the fake Supabase and the token file's
    final content (None if absent)."""
    sb = FakeSupabase()
    posts: list[dict] = []

    def fake_post(url, **kw):
        posts.append({"url": url, **kw})
        return token_response

    with tempfile.TemporaryDirectory() as tmp:
        token_file = os.path.join(tmp, "spotify_tokens.json")
        if stored is not None:
            with open(token_file, "w") as f:
                f.write(stored if isinstance(stored, str) else json.dumps(stored))
        before = Path(token_file).read_text() if stored is not None else None

        patches = [
            patch.object(spotify_etl, "SPOTIFY_TOKEN_FILE", token_file),
            patch.object(spotify_etl, "get_supabase", return_value=sb),
            patch.object(spotify_etl.httpx, "post", side_effect=fake_post),
            patch.object(spotify_etl, "SpotifyClient",
                         side_effect=lambda tokens: FakeClient(tokens, items, **client_kw)),
            patch.object(spotify_etl, "get_high_water_mark", return_value=None),
            patch.object(spotify_etl, "existing_track_ids", side_effect=lambda _sb, ids: set(ids)),
            patch.object(spotify_etl, "existing_artist_ids", side_effect=lambda _sb, ids: set()),
            patch.object(spotify_etl, "fetch_audio_features_reccobeats", return_value={}),
            patch.object(spotify_etl, "enrich_genres_via_musicbrainz", return_value=1),
            patch.object(spotify_etl, "upsert_tracks", side_effect=lambda _sb, t, _f: len(t)),
            patch.object(spotify_etl, "upsert_artists", side_effect=lambda _sb, a: len(a)),
            patch.object(spotify_etl, "upsert_plays", side_effect=lambda _sb, i: len(i)),
            patch.object(sys, "argv", ["spotify_etl.py", *(argv or [])]),
        ]
        with contextlib.ExitStack() as stack:
            for p in patches:
                stack.enter_context(p)
            code = 0
            try:
                spotify_etl.main()
            except SystemExit as e:
                code = e.code
        after = Path(token_file).read_text() if os.path.exists(token_file) else None
    return SimpleNamespace(code=code, sb=sb, before=before, after=after, posts=posts)


ALL_FAILED = [("spotify|plays", "failed"), ("reccobeats|audio_features", "failed"),
              ("musicbrainz|artist_tags", "failed")]


# ---------------------------------------------------------------------------
# 1-5: outright failures are red and reported
# ---------------------------------------------------------------------------

def test_refused_refresh_token_fails_the_run_and_every_heartbeat() -> None:
    r = run(token_response=EXPIRED)
    assert r.code == 1, f"a refused refresh token must exit 1 (run goes red), got {r.code!r}"
    assert sorted(r.sb.heartbeats()) == sorted(ALL_FAILED), r.sb.heartbeats()
    msg = r.sb.heartbeat("spotify|plays")["error_message"]
    assert "HTTP 400 invalid_grant: Refresh token expired" in msg, msg
    assert "--auth" in msg and "AGENTS.md" in msg, msg
    assert "stored-refresh" not in msg and "stub-client-secret" not in msg, "no token in a heartbeat"
    enrich = r.sb.heartbeat("reccobeats|audio_features")["error_message"]
    assert enrich.startswith("Not run: the Spotify sync failed first."), enrich
    assert r.after == r.before, "a failed refresh must not rewrite the token file"


def test_wrong_app_credentials_name_the_secrets() -> None:
    r = run(token_response=BAD_CLIENT)
    assert r.code == 1
    assert sorted(r.sb.heartbeats()) == sorted(ALL_FAILED)
    msg = r.sb.heartbeat("spotify|plays")["error_message"]
    assert "invalid_client" in msg and "SPOTIFY_CLIENT_SECRET" in msg, msg
    assert "refresh token rejected" not in msg, "this is not a sign-in problem"


def test_error_text_never_quotes_the_raw_body() -> None:
    weird = FakeResponse(401, "<html>stored-refresh leaked by a proxy page</html>")
    r = run(token_response=weird)
    assert r.code == 1
    msg = r.sb.heartbeat("spotify|plays")["error_message"]
    assert "HTTP 401" in msg and "<html>" not in msg and "leaked" not in msg, msg


def test_missing_token_file_is_reported_not_silent() -> None:
    r = run(stored=None)
    assert r.code == 1
    assert sorted(r.sb.heartbeats()) == sorted(ALL_FAILED), r.sb.heartbeats()
    assert "No Spotify tokens" in r.sb.heartbeat("spotify|plays")["error_message"]
    assert r.posts == [], "nothing to send to Spotify without a token"


def test_unusable_token_file_is_reported() -> None:
    for content in ("", "not json", "{}", json.dumps({"access_token": "a", "refresh_token": ""})):
        r = run(stored=content)
        assert r.code == 1, content
        assert sorted(r.sb.heartbeats()) == sorted(ALL_FAILED), (content, r.sb.heartbeats())
        assert "no refresh token" in r.sb.heartbeat("spotify|plays")["error_message"]
        assert r.posts == []


def test_total_fetch_failure_fails_the_run() -> None:
    r = run(recently_played_error=httpx.ConnectError("connection refused"))
    assert r.code == 1
    assert sorted(r.sb.heartbeats()) == sorted(ALL_FAILED), r.sb.heartbeats()
    assert "connection refused" in r.sb.heartbeat("spotify|plays")["error_message"]
    assert json.loads(r.after)["access_token"] == "new-access", (
        "the refresh succeeded before the fetch failed: the refreshed file stays"
    )


def test_token_endpoint_outage_fails_the_run() -> None:
    r = run(token_response=FakeResponse(503, "Service Unavailable"))
    assert r.code == 1
    assert sorted(r.sb.heartbeats()) == sorted(ALL_FAILED), r.sb.heartbeats()
    assert "token refresh failed" in r.sb.heartbeat("spotify|plays")["error_message"]
    assert r.after == r.before


def test_auth_dying_mid_run_reports_each_subsystem_once() -> None:
    r = run(items=[_play(1)],
            artists_error=spotify_etl.SpotifyAuthError("Spotify refresh token rejected. (HTTP 400 invalid_grant)"))
    assert r.code == 1
    # ReccoBeats had already reported for this run; it must not get a second, failed row.
    assert sorted(r.sb.heartbeats()) == sorted([
        ("reccobeats|audio_features", "success"),
        ("musicbrainz|artist_tags", "failed"),
        ("spotify|plays", "failed"),
    ]), r.sb.heartbeats()


# ---------------------------------------------------------------------------
# 6-7: runs that synced stay green
# ---------------------------------------------------------------------------

def test_normal_run_is_green() -> None:
    r = run(items=[_play(1), _play(2)])
    assert r.code == 0
    assert sorted(r.sb.heartbeats()) == sorted([
        ("spotify|plays", "success"), ("reccobeats|audio_features", "success"),
        ("musicbrainz|artist_tags", "success"),
    ]), r.sb.heartbeats()
    hb = r.sb.heartbeat("spotify|plays")
    assert hb["records_synced"] == 2 and hb["error_message"] is None, hb
    assert json.loads(r.after)["refresh_token"] == "stored-refresh"


def test_zero_play_run_is_green() -> None:
    r = run(items=[])
    assert r.code == 0
    assert sorted(r.sb.heartbeats()) == sorted([
        ("spotify|plays", "success"), ("reccobeats|audio_features", "success"),
        ("musicbrainz|artist_tags", "success"),
    ]), r.sb.heartbeats()
    assert r.sb.heartbeat("spotify|plays")["records_synced"] == 0


def test_cap_hit_run_is_partial_but_green() -> None:
    r = run(items=[_play(n) for n in range(50)])
    assert r.code == 0, "a partial run must not turn the workflow red"
    hb = r.sb.heartbeat("spotify|plays")
    assert hb["status"] == "partial" and "50-track" in hb["error_message"], hb


def test_expiry_warning_turns_the_heartbeat_partial_and_stays_green() -> None:
    day = 86400
    soon = dict(STORED, authorized_at=int(time.time()) - 170 * day)      # 10 days left
    r = run(stored=soon, items=[_play(1)])
    assert r.code == 0
    hb = r.sb.heartbeat("spotify|plays")
    assert hb["status"] == "partial", hb
    assert "expires in" in hb["error_message"] and "--auth" in hb["error_message"], hb
    assert json.loads(r.after)["authorized_at"] == soon["authorized_at"], (
        "a refresh must keep authorized_at (a refresh does not extend the 180 days)"
    )

    fresh = dict(STORED, authorized_at=int(time.time()) - 100 * day)     # 80 days left
    assert run(stored=fresh, items=[_play(1)]).sb.heartbeat("spotify|plays")["status"] == "success"
    # A token from before authorized_at was recorded: age unknown, no warning.
    assert run(items=[_play(1)]).sb.heartbeat("spotify|plays")["status"] == "success"


def test_reauth_warning_window() -> None:
    day, t0 = 86400, 1_800_000_000
    w = spotify_etl.reauth_warning
    assert w({"authorized_at": t0}, now=t0 + 165 * day) is None            # 15 days left
    assert "in 14 days" in w({"authorized_at": t0}, now=t0 + 166 * day)
    assert "in 1 days" in w({"authorized_at": t0}, now=t0 + 179 * day)
    assert "today" in w({"authorized_at": t0}, now=t0 + 179.5 * day)
    assert "already" in w({"authorized_at": t0}, now=t0 + 181 * day)
    for bad in ({}, {"authorized_at": None}, {"authorized_at": "2026-05-17"}, {"authorized_at": True}):
        assert w(bad, now=t0) is None, bad


# ---------------------------------------------------------------------------
# 8: finishing a sign-in from a pasted code
# ---------------------------------------------------------------------------

def test_parse_auth_code_accepts_code_or_callback_url() -> None:
    p = spotify_etl.parse_auth_code
    assert p("AQD-synthetic_code") == "AQD-synthetic_code"
    assert p("  AQD-synthetic_code\n") == "AQD-synthetic_code"
    assert p("http://127.0.0.1:8888/callback?code=AQD-synthetic_code") == "AQD-synthetic_code"
    assert p("http://127.0.0.1:8888/callback?code=AQD-synthetic_code&state=xyz") == "AQD-synthetic_code"
    assert p("code=AQD-synthetic_code&state=xyz") == "AQD-synthetic_code"
    assert p("") == "" and p(None) == ""


def test_exchange_code_saves_tokens_with_authorized_at() -> None:
    issued = FakeResponse(200, {"access_token": "acc", "refresh_token": "fresh-refresh",
                                "expires_in": 3600, "scope": "user-read-recently-played"})
    t0 = int(time.time())
    r = run(token_response=issued, stored=None,
            argv=["--exchange-code", "http://127.0.0.1:8888/callback?code=AQD-synthetic_code"])
    assert r.code == 0
    saved = json.loads(r.after)
    assert saved["refresh_token"] == "fresh-refresh"
    assert t0 <= saved["authorized_at"] <= t0 + 60 and saved["obtained_at"] == saved["authorized_at"]
    assert len(r.posts) == 1
    sent = r.posts[0]["data"]
    assert sent == {"grant_type": "authorization_code", "code": "AQD-synthetic_code",
                    "redirect_uri": spotify_etl.SPOTIFY_REDIRECT_URI}, sent
    assert r.sb.writes == [], "the exchange itself writes nothing to Supabase"


def test_exchange_code_reads_the_workflow_input_from_the_event_file() -> None:
    issued = FakeResponse(200, {"access_token": "acc", "refresh_token": "fresh-refresh"})
    with tempfile.TemporaryDirectory() as tmp:
        event = os.path.join(tmp, "event.json")
        Path(event).write_text(json.dumps({"inputs": {"auth_code": "AQD-from-event"}}))
        with patch.dict(os.environ, {"GITHUB_EVENT_PATH": event}):
            r = run(token_response=issued, stored=None, argv=["--exchange-code"])
    assert r.code == 0 and r.posts[0]["data"]["code"] == "AQD-from-event"

    # A scheduled run's event has no inputs: nothing to exchange, nothing sent.
    with tempfile.TemporaryDirectory() as tmp:
        event = os.path.join(tmp, "event.json")
        Path(event).write_text(json.dumps({"schedule": "50 * * * *"}))
        with patch.dict(os.environ, {"GITHUB_EVENT_PATH": event}):
            r = run(token_response=issued, stored=None, argv=["--exchange-code"])
    assert r.code == 1 and r.posts == [] and r.after is None


def test_refused_code_saves_nothing_and_keeps_the_old_file() -> None:
    refused = FakeResponse(400, {"error": "invalid_grant", "error_description": "Invalid authorization code"})
    r = run(token_response=refused, argv=["--exchange-code", "AQD-used-twice"])
    assert r.code == 1
    assert r.after == r.before, "a refused code must not touch the existing token file"

    no_refresh = FakeResponse(200, {"access_token": "acc"})
    r = run(token_response=no_refresh, argv=["--exchange-code", "AQD-synthetic_code"])
    assert r.code == 1 and r.after == r.before


# ---------------------------------------------------------------------------
# 9: the workflow's `if: always()` upload cannot put a dead or empty token back
# ---------------------------------------------------------------------------

def _helper(tmp: str, sb: FakeSupabase):
    token_file = os.path.join(tmp, "spotify_tokens.json")
    stack = contextlib.ExitStack()
    stack.enter_context(patch.object(ci_token_helper, "SPOTIFY_TOKEN_FILE", token_file))
    stack.enter_context(patch.object(ci_token_helper, "get_supabase", return_value=sb))
    return token_file, stack


def _exit_code(fn) -> int:
    try:
        fn()
    except SystemExit as e:
        return e.code
    return 0


def test_upload_skips_a_token_the_run_never_refreshed() -> None:
    stored = json.dumps(STORED, indent=2)
    sb = FakeSupabase(stored_token_data=stored)
    with tempfile.TemporaryDirectory() as tmp:
        token_file, stack = _helper(tmp, sb)
        with stack:
            ci_token_helper.download_spotify()
            assert Path(token_file).read_text() == stored
            # ... the ETL fails before any refresh: the file is what was downloaded.
            assert _exit_code(ci_token_helper.upload_spotify) == 0
            assert sb.token_uploads() == [], "an unrefreshed token must not be uploaded again"


def test_upload_keeps_a_refreshed_token_even_after_a_failed_run() -> None:
    sb = FakeSupabase(stored_token_data=json.dumps(STORED, indent=2))
    with tempfile.TemporaryDirectory() as tmp:
        token_file, stack = _helper(tmp, sb)
        with stack:
            ci_token_helper.download_spotify()
            refreshed = dict(STORED, access_token="new-access", refresh_token="rotated-refresh",
                             obtained_at=STORED["obtained_at"] + 3600)
            with patch.object(spotify_etl, "SPOTIFY_TOKEN_FILE", token_file):
                spotify_etl.save_tokens(refreshed)      # what a successful refresh does
            assert _exit_code(ci_token_helper.upload_spotify) == 0
            ups = sb.token_uploads()
            assert len(ups) == 1 and ups[0]["service"] == "spotify"
            assert json.loads(ups[0]["token_data"])["refresh_token"] == "rotated-refresh"


def test_upload_refuses_an_empty_or_tokenless_file() -> None:
    for content in ("", "   ", "not json", "[]", "{}", json.dumps({"access_token": "a"}),
                    json.dumps({"refresh_token": ""})):
        sb = FakeSupabase()
        with tempfile.TemporaryDirectory() as tmp:
            token_file, stack = _helper(tmp, sb)
            with stack:
                Path(token_file).write_text(content)
                assert _exit_code(ci_token_helper.upload_spotify) == 1, repr(content)
                assert sb.token_uploads() == [], repr(content)

    sb = FakeSupabase()
    with tempfile.TemporaryDirectory() as tmp:
        _token_file, stack = _helper(tmp, sb)
        with stack:                                     # no file at all
            assert _exit_code(ci_token_helper.upload_spotify) == 1
            assert sb.token_uploads() == []


def test_upload_after_a_local_sign_in_has_no_baseline_and_uploads() -> None:
    sb = FakeSupabase()
    with tempfile.TemporaryDirectory() as tmp:
        token_file, stack = _helper(tmp, sb)
        with stack:
            Path(token_file).write_text(json.dumps(dict(STORED, authorized_at=1_800_000_000)))
            assert _exit_code(ci_token_helper.upload_spotify) == 0
            assert len(sb.token_uploads()) == 1


def test_fresh_sign_in_after_a_stale_download_is_uploaded() -> None:
    """Recovery on a machine that downloaded the dead token first: the new sign-in
    differs from the baseline, so it goes up."""
    sb = FakeSupabase(stored_token_data=json.dumps(STORED, indent=2))
    with tempfile.TemporaryDirectory() as tmp:
        token_file, stack = _helper(tmp, sb)
        with stack:
            ci_token_helper.download_spotify()
            Path(token_file).write_text(json.dumps({"access_token": "a", "refresh_token": "fresh-refresh",
                                                    "authorized_at": 1_800_000_000}))
            assert _exit_code(ci_token_helper.upload_spotify) == 0
            assert json.loads(sb.token_uploads()[0]["token_data"])["refresh_token"] == "fresh-refresh"


if __name__ == "__main__":
    for _name, _fn in list(globals().items()):
        if _name.startswith("test_") and callable(_fn):
            _fn()
            print(f"PASS: {_name}")
    print("All tests passed.")
