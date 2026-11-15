"""Newer-wins guard for `python ci_token_helper.py upload spotify`, the authorized_at
round trip through a Spotify token refresh, and the wording that drives the /status
Reconnect control.

Why: Spotify expires a refresh token 180 days after the sign-in. The fix is a new
sign-in, normally through Reconnect on the /status Spotify card, which stores a new
token in pds.ci_tokens. tests/test_spotify_fail_loud.py already covers "a run that
never refreshed does not upload" (the download baseline). This file covers what that
leaves open: a run that downloaded the OLD sign-in's token and did refresh it, while
the new sign-in was stored meanwhile, must not put the old token back.

Offline: no network, no database, synthetic token values only.

Run: python tests/test_ci_token_spotify_guard.py
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub")
os.environ.setdefault("SPOTIFY_CLIENT_ID", "stub")
os.environ.setdefault("SPOTIFY_CLIENT_SECRET", "stub")

import ci_token_helper as helper  # noqa: E402
import spotify_etl  # noqa: E402


def blob(refresh: str, obtained_at: int, authorized_at: int | None = None, access: str = "access-synthetic") -> str:
    """A synthetic token blob in the exact stored format (json.dump indent=2)."""
    data = {
        "access_token": access,
        "token_type": "Bearer",
        "expires_in": 3600,
        "refresh_token": refresh,
        "scope": "playlist-modify-private user-read-recently-played",
        "obtained_at": obtained_at,
    }
    if authorized_at is not None:
        data["authorized_at"] = authorized_at
    return json.dumps(data, indent=2)


T0 = 1_700_000_000          # a sign-in (in the past)
T1 = T0 + 3600              # a refresh one hour later
T2 = T0 + 7200              # a refresh two hours later
REAUTH = T0 + 180 * 86400   # a new sign-in 180 days later

failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    print(f"  {'ok  ' if cond else 'FAIL'} {name}" + (f"  [{detail}]" if detail and not cond else ""))
    if not cond:
        failures.append(name)


# ------------------------------------------------------------------ pure decision
def test_decision() -> None:
    print("spotify_upload_decision")
    d = helper.spotify_upload_decision
    reconnected = blob("new-refresh", REAUTH, REAUTH)

    # The race this guard exists for: the run refreshed the old sign-in's token (so the
    # file differs from the download and has the LATER obtained_at), but a new sign-in
    # was stored while the run was in flight.
    old_refreshed = blob("old-refresh", REAUTH + 30, T0)
    action, reason = d(old_refreshed, reconnected)
    check("a refreshed token of the OLD sign-in never replaces the new sign-in", action == "skip", reason)
    check("...and the reason says so", "newer sign-in" in reason, reason)
    legacy_refreshed = blob("old-refresh", REAUTH + 30)            # no authorized_at at all
    check("a token without authorized_at loses to one that has it", d(legacy_refreshed, reconnected)[0] == "skip")
    check("the dead token itself never replaces the new sign-in", d(blob("dead-refresh", T1), reconnected)[0] == "skip")

    # The normal hourly run: same sign-in, refreshed -> later obtained_at -> upload.
    stored = blob("r", T1, T0)
    refreshed = blob("r", T2, T0, access="access-synthetic-2")
    check("a refreshed token (same sign-in, later refresh) is uploaded", d(refreshed, stored)[0] == "upload")
    legacy_stored = blob("r", T1)
    check("legacy blobs without authorized_at still upload on a later refresh",
          d(blob("r", T2, access="a2"), legacy_stored)[0] == "upload")

    # The site refreshed its copy after this run downloaded: the stored row is fresher.
    site = blob("r", T2 + 5, T0, access="site-access")
    check("a blob refreshed earlier than the stored one is not uploaded", d(refreshed, site)[0] == "skip")
    check("equal timestamps are not 'newer'",
          d(blob("r", T2, T0, access="x"), blob("r", T2, T0, access="y"))[0] == "skip")

    # A new sign-in made here (--auth, --exchange-code) beats the stored row.
    local_auth = blob("local-refresh", REAUTH, REAUTH)
    check("a newer local sign-in is uploaded", d(local_auth, stored)[0] == "upload")
    check("...also over a legacy stored row", d(local_auth, legacy_stored)[0] == "upload")
    no_obtained = json.dumps({"access_token": "a", "refresh_token": "fresh", "authorized_at": REAUTH})
    check("...also when it carries no obtained_at", d(no_obtained, legacy_stored)[0] == "upload")

    # Missing or unreadable stored row: upload as before.
    check("no stored row -> upload", d(refreshed, None)[0] == "upload")
    check("unreadable stored row -> upload", d(refreshed, "not json")[0] == "upload")
    check("stored row without a refresh token -> upload", d(refreshed, "{}")[0] == "upload")
    check("identical to the stored row -> skip", d(stored, stored)[0] == "skip")

    # A broken local file is never stored.
    check("unparsable local file -> invalid", d("not json", stored)[0] == "invalid")
    check("local file without a refresh token -> invalid", d(json.dumps({"access_token": "a"}), stored)[0] == "invalid")
    check("local JSON that is not an object -> invalid", d("[1, 2]", stored)[0] == "invalid")

    # Odd timestamp values count as unknown (0), never as newer.
    weird = json.dumps({"refresh_token": "r", "obtained_at": "2099", "authorized_at": True})
    check("text / boolean timestamps are not 'newer'", d(weird, stored)[0] == "skip")


# ------------------------------------------------------------------ upload_spotify wiring
def model_outcome(candidate_text, stored_text) -> str:
    """The outcome code pds.save_spotify_token answers, from the offline model
    (spotify_upload_decision mirrors pds.spotify_token_decision; without a loaded refresh
    token the rotated rule never applies, as in upload_spotify)."""
    action, reason = helper.spotify_upload_decision(candidate_text, stored_text)
    if action == "upload":
        return "written"
    if action == "invalid":
        return "invalid"
    return {helper.SPOTIFY_SAVE_OUTCOMES["same"]: "same",
            helper.SPOTIFY_SAVE_OUTCOMES["older_signin"]: "older_signin"}.get(reason, "older_refresh")


class FakeTokenStore:
    """A stand-in for the supabase client with ONE pds.ci_tokens spotify row.

    `download spotify` reads it through the table API. `upload spotify` must write it ONLY
    through the save_spotify_token RPC, applied here atomically with the offline model.
    `before_commit`, when set, runs at the last moment before the uploader's write: inside the
    RPC right before its compare-and-write (what another writer commits then is what the atomic
    call compares against; in the database that is the row lock), or, for a direct table upsert,
    after whatever read preceded it. A read-then-upsert uploader therefore reproduces the race
    of Codex review #168 here: the reconnect lands between its read and its write."""

    def __init__(self, stored: str | None):
        self.stored = stored
        self.rpcs: list[dict] = []
        self.upserts: list[dict] = []
        self.reads = 0
        self.before_commit = None
        self.rpc_error: Exception | None = None
        self.answer = None                 # force an RPC answer (e.g. an unexpected value)

    def schema(self, name):
        assert name == "pds", name
        return self

    def table(self, name):
        assert name == "ci_tokens", name
        store = self

        class Query:
            def select(self, *_a, **_k): return self
            def eq(self, *_a, **_k): return self
            def single(self):
                self._single = True
                return self
            def upsert(self, row):
                store.upserts.append(row)
                if store.before_commit:
                    store.before_commit(store)
                store.stored = row.get("token_data")
                return self
            def execute(self):
                store.reads += 1
                row = {"token_data": store.stored} if store.stored is not None else None
                return MagicMock(data=row if getattr(self, "_single", False) else ([row] if row else []))
        return Query()

    def rpc(self, name, params):
        store = self

        class Call:
            def execute(self):
                assert name == "save_spotify_token", name
                assert set(params) == {"p_token_data", "p_loaded_refresh_token"}, params
                store.rpcs.append(params)
                if store.rpc_error:
                    raise store.rpc_error
                if store.before_commit:
                    store.before_commit(store)
                code = model_outcome(params["p_token_data"], store.stored)
                if code == "written":
                    store.stored = params["p_token_data"]
                return MagicMock(data=store.answer if store.answer is not None else code)
        return Call()


def run_upload(local_text: str, stored_text: str | None, download_first: bool = False, before_commit=None):
    """Runs `upload spotify` against a fake stored row. With download_first, the helper's
    own `download spotify` runs first (writing the baseline) and local_text then replaces
    the token file, as the ETL's refresh would. Returns (store, exit code)."""
    with tempfile.TemporaryDirectory() as tmp:
        token_file = Path(tmp) / "tokens.json"
        store = FakeTokenStore(stored_text)
        exit_code = 0
        with patch.object(helper, "SPOTIFY_TOKEN_FILE", str(token_file)), \
             patch.object(helper, "get_supabase", return_value=store):
            if download_first:
                helper.download_spotify()
            token_file.write_text(local_text, encoding="utf-8")
            store.before_commit = before_commit
            reads_before = store.reads
            try:
                helper.upload_spotify()
            except SystemExit as e:
                exit_code = e.code
            store.upload_reads = store.reads - reads_before
        return store, exit_code


def test_upload_wiring() -> None:
    print("upload_spotify")
    reconnected = blob("new-refresh", REAUTH, REAUTH)
    old_refreshed = blob("old-refresh", REAUTH + 30, T0)

    store, code = run_upload(old_refreshed, reconnected)
    check("refreshed old sign-in vs a stored new sign-in: not written, exit 0",
          store.stored == reconnected and code == 0, f"exit={code}")

    stored = blob("r", T1, T0)
    refreshed = blob("r", T2, T0, access="access-synthetic-2")
    store, code = run_upload(refreshed, stored, download_first=True)
    check("refreshed run: one save_spotify_token call with the file's exact text, exit 0",
          len(store.rpcs) == 1 and store.rpcs[0] == {"p_token_data": refreshed, "p_loaded_refresh_token": None}
          and store.stored == refreshed and code == 0)
    check("...and no direct read or upsert of ci_tokens: the compare is inside the atomic call",
          store.upload_reads == 0 and store.upserts == [], f"reads={store.upload_reads} upserts={len(store.upserts)}")

    store, code = run_upload(stored, stored, download_first=True)
    check("unrefreshed run: nothing sent, exit 0 (the download baseline)", store.rpcs == [] and code == 0)

    store, code = run_upload("not json", stored)
    check("a broken token file is never sent, exit 1", store.rpcs == [] and store.stored == stored and code == 1)

    store, code = run_upload(refreshed, None)
    check("no stored row: written", store.stored == refreshed and code == 0)

    # An RPC that fails or answers something unexpected: nothing was written, the command fails.
    with tempfile.TemporaryDirectory() as tmp:
        token_file = Path(tmp) / "tokens.json"
        token_file.write_text(refreshed, encoding="utf-8")
        store = FakeTokenStore(stored)
        store.rpc_error = RuntimeError("database unavailable")
        raised = False
        with patch.object(helper, "SPOTIFY_TOKEN_FILE", str(token_file)), \
             patch.object(helper, "get_supabase", return_value=store):
            try:
                helper.upload_spotify()
            except RuntimeError:
                raised = True
        check("a failed save call raises and the stored row is untouched", raised and store.stored == stored)
    store = FakeTokenStore(stored)
    store.answer = {"token_data": "x"}
    with tempfile.TemporaryDirectory() as tmp:
        token_file = Path(tmp) / "tokens.json"
        token_file.write_text(refreshed, encoding="utf-8")
        code = 0
        with patch.object(helper, "SPOTIFY_TOKEN_FILE", str(token_file)), \
             patch.object(helper, "get_supabase", return_value=store):
            try:
                helper.upload_spotify()
            except SystemExit as e:
                code = e.code
        check("an unexpected answer from the save call exits 1", code == 1)


def test_upload_interleaving() -> None:
    """The race Codex review #168 found: the old upload read the row, compared, then upserted.
    A reconnect committed between that read and the upsert was overwritten. Now the compare
    and the write are one atomic call, so whatever lands before it is compared against and
    whatever lands after it simply follows it."""
    print("upload_spotify interleaving")
    reconnected = blob("new-refresh", REAUTH, REAUTH)
    old_signin = blob("old-refresh", REAUTH - 3600, T0)
    old_refreshed = blob("old-refresh", REAUTH + 30, T0)

    def reconnect_lands(store):
        store.stored = reconnected            # Reconnect's plain write, committed just before the lock

    # download the OLD sign-in -> the ETL refreshes it -> Reconnect lands -> upload
    store, code = run_upload(old_refreshed, old_signin, download_first=True, before_commit=reconnect_lands)
    check("reconnect committed while the upload was in flight: the new sign-in is kept",
          store.stored == reconnected and code == 0 and len(store.rpcs) == 1, store.stored[:40])
    check("...the upload never read the row itself (no read-then-write window)",
          store.upload_reads == 0 and store.upserts == [])

    # the other order: the upload's atomic write commits first, then Reconnect writes over it
    store, code = run_upload(old_refreshed, old_signin, download_first=True)
    check("upload first: the refreshed old sign-in is written", store.stored == old_refreshed)
    store.stored = reconnected                 # Reconnect afterwards (a plain write)
    check("...and Reconnect afterwards still ends with the new sign-in", store.stored == reconnected)

    # the site refreshed the same sign-in while the run was in flight: its later refresh wins
    site = blob("r", T2 + 60, T0, access="site-access")
    store, code = run_upload(blob("r", T2, T0, access="run-access"), blob("r", T1, T0), download_first=True,
                             before_commit=lambda s: setattr(s, "stored", site))
    check("a later site refresh landing meanwhile is kept over the run's earlier one", store.stored == site and code == 0)


# ------------------------------------------------------------------ spotify_etl.py
def test_refresh_keeps_authorized_at() -> None:
    print("spotify_etl refresh")
    with tempfile.TemporaryDirectory() as tmp:
        token_file = Path(tmp) / "tokens.json"
        tokens = json.loads(blob("r", T1, T0))
        ok = MagicMock(status_code=200)
        ok.json.return_value = {"access_token": "access-synthetic-new", "token_type": "Bearer", "expires_in": 3600,
                                "scope": "playlist-modify-private user-read-recently-played"}
        with patch.object(spotify_etl, "SPOTIFY_TOKEN_FILE", str(token_file)), \
             patch.object(spotify_etl.httpx, "post", return_value=ok):
            out = spotify_etl.refresh_access_token(tokens)
        saved = json.loads(token_file.read_text(encoding="utf-8"))
        check("authorized_at survives a refresh (returned and saved)",
              out.get("authorized_at") == T0 and saved.get("authorized_at") == T0)
        check("the refresh token is kept when Spotify sends none", saved.get("refresh_token") == "r")
        check("obtained_at moves forward, access token is replaced",
              saved.get("obtained_at", 0) > T1 and saved.get("access_token") == "access-synthetic-new")
        check("the saved file has exactly the stored keys",
              set(saved) == {"access_token", "token_type", "expires_in", "refresh_token", "scope",
                             "obtained_at", "authorized_at"}, str(sorted(saved)))
        # the web Reconnect writes the same text format the ETL does
        check("the token file is pretty JSON, indent 2 (the format the site writes too)",
              token_file.read_text(encoding="utf-8") == json.dumps(saved, indent=2))

    # A refused refresh saves nothing and raises the error whose text drives /status.
    with tempfile.TemporaryDirectory() as tmp:
        token_file = Path(tmp) / "tokens.json"
        original = blob("dead-refresh", T1, T0)
        token_file.write_text(original, encoding="utf-8")
        rejected = MagicMock(status_code=400)
        rejected.json.return_value = {"error": "invalid_grant", "error_description": "Refresh token expired"}
        message = ""
        with patch.object(spotify_etl, "SPOTIFY_TOKEN_FILE", str(token_file)), \
             patch.object(spotify_etl.httpx, "post", return_value=rejected):
            try:
                spotify_etl.refresh_access_token(json.loads(original))
            except spotify_etl.SpotifyAuthError as e:
                message = str(e)
        check("a refused refresh raises SpotifyAuthError", bool(message))
        check("...and leaves the token file byte-identical", token_file.read_text(encoding="utf-8") == original)
        check("the message keeps the phrase /status keys on", "Spotify refresh token rejected" in message, message)
        check("the message tells Riley to use Reconnect on /status",
              "/status" in message and "Reconnect on the Spotify card" in message, message)
        check("...before it names the other routes",
              message.index("Reconnect") < message.index("--auth"), message)
        check("the message carries no token", "dead-refresh" not in message and "access-synthetic" not in message)


def test_status_wording() -> None:
    """Every message that means "sign in again" must make /status show its Reconnect
    control. The matcher is in the frontend; its alternatives are checked against the
    real Python strings here (and the other way round in spotify-reconnect.test.cjs)."""
    print("wording shared with /status")
    import re

    ts = (ROOT / "frontend" / "src" / "lib" / "spotify-reconnect.ts").read_text(encoding="utf-8")
    m = re.search(r"export function needsSpotifyReconnect\(.*?return /(.+?)/i\.test\(errorMessage\);", ts, re.S)
    check("needsSpotifyReconnect's pattern is found in the frontend lib", bool(m))
    if not m:
        return
    pattern = re.compile(m.group(1), re.I)

    check("matches the refused-token heartbeat", bool(pattern.search(spotify_etl.REAUTH_INSTRUCTIONS)))
    check("matches the expiring-soon heartbeat",
          bool(pattern.search(spotify_etl.reauth_warning({"authorized_at": T0}, now=T0 + 170 * 86400) or "")))
    for text in ("No Spotify tokens at /x/tokens.json. ", "Spotify token file /x/tokens.json holds no refresh token. "):
        check(f"matches {text.strip()[:32]!r}", bool(pattern.search(text + spotify_etl.REAUTH_HOWTO)))
    check("the how-to alone does not trigger it (it is appended to every one of them)",
          not pattern.search(spotify_etl.REAUTH_HOWTO), spotify_etl.REAUTH_HOWTO)
    check("wrong app credentials are not a sign-in problem",
          not pattern.search("Spotify rejected the app credentials (HTTP 400 invalid_client). Check the "
                             "SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET secrets against the app at "
                             "developer.spotify.com/dashboard."))
    check("the 50-play cap is not a sign-in problem",
          not pattern.search("Hit Spotify 50-track recently-played cap — likely lost some plays"))
    check("the how-to names /status first", spotify_etl.REAUTH_HOWTO.startswith("Sign in again: open the Onyx /status page"))
    check("the ETL and the site agree on the lifetime", "REFRESH_TOKEN_LIFETIME_DAYS = 180" in ts
          and spotify_etl.REFRESH_TOKEN_LIFETIME_DAYS == 180)


def test_signin_blob_shape() -> None:
    """Every sign-in route stores the same token blob: `--auth` and the workflow's
    auth_code input (token_blob_from_response here) and Reconnect on /status
    (buildTokenBlob in the frontend lib). Same keys, same order, authorized_at set."""
    print("sign-in blob shape shared with /status Reconnect")
    import re
    from datetime import datetime, timezone

    ts = (ROOT / "frontend" / "src" / "lib" / "spotify-reconnect.ts").read_text(encoding="utf-8")
    m = re.search(r"export function buildTokenBlob\(.*?return \{(.*?)\};", ts, re.S)
    check("buildTokenBlob's returned object is found in the frontend lib", bool(m))
    site_keys = re.findall(r"^\s*(\w+):", m.group(1), re.M) if m else []

    # Spotify's own key order, plus a key the blob must not carry over.
    answer = {"access_token": "access-synthetic", "token_type": "Bearer", "scope": spotify_etl.SPOTIFY_SCOPES,
              "expires_in": 3600, "refresh_token": "refresh-synthetic", "extra": "x"}
    built = spotify_etl.token_blob_from_response(answer, T0 + 0.7)
    check("the Python blob has the site's keys in the site's order", built is not None and list(built) == site_keys,
          f"{list(built or {})} vs {site_keys}")
    check("authorized_at and obtained_at are the sign-in time (whole seconds)",
          built is not None and built["authorized_at"] == built["obtained_at"] == T0)
    check("no access or no refresh token: nothing to store",
          spotify_etl.token_blob_from_response({"access_token": "a"}, T0) is None
          and spotify_etl.token_blob_from_response({"refresh_token": "r"}, T0) is None
          and spotify_etl.token_blob_from_response(None, T0) is None)
    check("same defaults as the site", spotify_etl.token_blob_from_response(
        {"access_token": "a", "refresh_token": "r"}, T0) == {
        "access_token": "a", "token_type": "Bearer", "expires_in": 3600, "refresh_token": "r",
        "scope": "", "obtained_at": T0, "authorized_at": T0})
    check("scope check: both granted, any order",
          spotify_etl.has_required_scopes("playlist-modify-private user-read-recently-played"))
    check("scope check: one missing is refused", not spotify_etl.has_required_scopes("user-read-recently-played")
          and not spotify_etl.has_required_scopes(None))
    check("the site checks scopes too", "hasRequiredScopes(" in ts)

    # The heartbeat names the same reconnect-by day as the card (reconnectByDate): the ET
    # day before the ET expiry day, by calendar, also across the autumn clock change.
    at = int(datetime(2027, 5, 12, 4, 30, tzinfo=timezone.utc).timestamp())   # expires 2027-11-07 23:30 EST
    text = spotify_etl.reauth_warning({"authorized_at": at}, now=at + 175 * 86400) or ""
    check("heartbeat: reconnect by the ET calendar day before expiry", "reconnect by 2027-11-06" in text, text)
    late = spotify_etl.reauth_warning({"authorized_at": at}, now=at + 179.8 * 86400) or ""
    check("heartbeat: after that day it says reconnect now", "reconnect now" in late and "2027-11-06" not in late, late)


def test_workflow_uploads_through_the_helper() -> None:
    print("spotify-etl.yml")
    wf = (ROOT / ".github" / "workflows" / "spotify-etl.yml").read_text(encoding="utf-8")
    check("the workflow uploads through the helper (where the guards live)",
          "run: python ci_token_helper.py upload spotify" in wf)
    check("nothing in the workflow writes ci_tokens directly", "ci_tokens" not in wf)


if __name__ == "__main__":
    test_decision()
    test_upload_wiring()
    test_upload_interleaving()
    test_refresh_keeps_authorized_at()
    test_status_wording()
    test_signin_blob_shape()
    test_workflow_uploads_through_the_helper()
    if failures:
        print(f"\nFAILED ({len(failures)}): " + "; ".join(failures))
        sys.exit(1)
    print("\nAll Spotify token guard tests passed.")
