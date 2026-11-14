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
def fake_supabase(stored_text: str | None, as_list: bool = True):
    """A stand-in for the supabase client: records upserts, serves one ci_tokens row
    (as the list a plain select returns, or as the dict .single() returns)."""
    sb = MagicMock()
    table = sb.schema.return_value.table.return_value
    row = {"token_data": stored_text}
    data = ([row] if stored_text is not None else []) if as_list else (row if stored_text is not None else None)
    table.select.return_value.eq.return_value.execute.return_value = MagicMock(data=data)
    table.select.return_value.eq.return_value.single.return_value.execute.return_value = MagicMock(data=row)
    return sb, table


def run_upload(local_text: str, stored_text: str | None, download_first: bool = False, as_list: bool = True):
    """Runs `upload spotify` against a fake stored row. With download_first, the helper's
    own `download spotify` runs first (writing the baseline) and local_text then replaces
    the token file, as the ETL's refresh would."""
    with tempfile.TemporaryDirectory() as tmp:
        token_file = Path(tmp) / "tokens.json"
        sb, table = fake_supabase(stored_text, as_list)
        exit_code = 0
        with patch.object(helper, "SPOTIFY_TOKEN_FILE", str(token_file)), \
             patch.object(helper, "get_supabase", return_value=sb):
            if download_first:
                helper.download_spotify()
            token_file.write_text(local_text, encoding="utf-8")
            try:
                helper.upload_spotify()
            except SystemExit as e:
                exit_code = e.code
        return table.upsert, exit_code


def test_upload_wiring() -> None:
    print("upload_spotify")
    reconnected = blob("new-refresh", REAUTH, REAUTH)
    old_refreshed = blob("old-refresh", REAUTH + 30, T0)

    for as_list in (True, False):
        upsert, code = run_upload(old_refreshed, reconnected, as_list=as_list)
        check(f"refreshed old sign-in vs a stored new sign-in: nothing written, exit 0 (row as {'list' if as_list else 'dict'})",
              upsert.call_count == 0 and code == 0, f"calls={upsert.call_count} exit={code}")

    # Same race with the real download step first: the file differs from the baseline
    # (it was refreshed), so only the newer-wins rule stands between it and the row.
    with tempfile.TemporaryDirectory() as tmp:
        token_file = Path(tmp) / "tokens.json"
        sb, table = fake_supabase(blob("old-refresh", REAUTH - 3600, T0))
        with patch.object(helper, "SPOTIFY_TOKEN_FILE", str(token_file)), \
             patch.object(helper, "get_supabase", return_value=sb):
            helper.download_spotify()                                   # the run downloads the old sign-in
            token_file.write_text(old_refreshed, encoding="utf-8")       # ...and refreshes it
            table.select.return_value.eq.return_value.execute.return_value = MagicMock(
                data=[{"token_data": reconnected}])                      # meanwhile: Reconnect stored a new one
            helper.upload_spotify()
        check("download -> refresh -> reconnect lands -> upload: the new sign-in is kept", table.upsert.call_count == 0)

    stored = blob("r", T1, T0)
    refreshed = blob("r", T2, T0, access="access-synthetic-2")
    upsert, code = run_upload(refreshed, stored, download_first=True)
    check("refreshed run: exactly one upsert, exit 0", upsert.call_count == 1 and code == 0)
    row = upsert.call_args[0][0] if upsert.call_count else {}
    check("the upsert is {service, token_data, updated_at} with the file's exact text",
          set(row) == {"service", "token_data", "updated_at"} and row.get("service") == "spotify"
          and row.get("token_data") == refreshed)

    upsert, code = run_upload(stored, stored, download_first=True)
    check("unrefreshed run: nothing written, exit 0 (the download baseline)", upsert.call_count == 0 and code == 0)

    upsert, code = run_upload("not json", stored)
    check("a broken token file is never stored, exit 1", upsert.call_count == 0 and code == 1)

    for as_list in (True, False):
        upsert, code = run_upload(refreshed, None, as_list=as_list)
        check(f"no stored row: uploaded (row as {'list' if as_list else 'dict'})", upsert.call_count == 1 and code == 0)

    # If the stored row cannot be read, fail without writing.
    with tempfile.TemporaryDirectory() as tmp:
        token_file = Path(tmp) / "tokens.json"
        token_file.write_text(refreshed, encoding="utf-8")
        sb, table = fake_supabase(stored)
        table.select.return_value.eq.return_value.execute.side_effect = RuntimeError("read failed")
        raised = False
        with patch.object(helper, "SPOTIFY_TOKEN_FILE", str(token_file)), \
             patch.object(helper, "get_supabase", return_value=sb):
            try:
                helper.upload_spotify()
            except RuntimeError:
                raised = True
        check("a failed read of the stored row raises and writes nothing", raised and table.upsert.call_count == 0)


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


def test_workflow_uploads_through_the_helper() -> None:
    print("spotify-etl.yml")
    wf = (ROOT / ".github" / "workflows" / "spotify-etl.yml").read_text(encoding="utf-8")
    check("the workflow uploads through the helper (where the guards live)",
          "run: python ci_token_helper.py upload spotify" in wf)
    check("nothing in the workflow writes ci_tokens directly", "ci_tokens" not in wf)


if __name__ == "__main__":
    test_decision()
    test_upload_wiring()
    test_refresh_keeps_authorized_at()
    test_status_wording()
    test_workflow_uploads_through_the_helper()
    if failures:
        print(f"\nFAILED ({len(failures)}): " + "; ".join(failures))
        sys.exit(1)
    print("\nAll Spotify token guard tests passed.")
