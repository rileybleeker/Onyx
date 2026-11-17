"""Offline tests for the Health Planet refresh_token persistence rules.

The `refresh_token` grant is undocumented (healthplanet.jp has no spec for it)
and rotation behavior is unconfirmed upstream, so the refresh path in
tanita_etl.py must be robust BOTH ways. The decision is the pure
tanita_etl.merge_refresh_response:
  1. rotated   — a returned refresh_token that is present AND different
                 replaces the stored one and is persisted;
  2. unchanged — a response echoing the stored refresh_token keeps it;
  3. missing   — a response that omits refresh_token (or answers None / an
                 empty string) keeps the stored one: an empty value NEVER
                 overwrites the stored token;
  4. rejected  — HTTP 400/401, or an `error` body -> TanitaAuthError whose
                 message names the recovery steps (and never quotes the
                 response body or a token); run_etl then writes a failed
                 `tanita|weight` heartbeat with that message and exits 1
                 (red on Actions), and the token file is untouched.

Everything here is faked: no network, no database, no credentials, synthetic
token strings only.

Run: python tests/test_tanita_token_refresh.py
     python tests/run_offline_tests.py tests/test_tanita_token_refresh.py
"""
from __future__ import annotations

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

import tanita_etl as te  # noqa: E402

STORED = {"access_token": "old-access", "refresh_token": "stored-refresh",
           "expires_in": 100, "obtained_at": 1}
ROTATED = {"access_token": "new-access", "refresh_token": "rotated-refresh",
           "expires_in": 2592000}


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

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
        # refresh_access_token calls this after its own 400/401 check (#464).
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class FakeSupabase:
    """sync_log sink only — a rejected refresh writes exactly one row."""

    def __init__(self):
        self.sync_logs: list[dict] = []

    def schema(self, _name):
        return self

    def table(self, name):
        assert name == "sync_log", name
        return self

    def insert(self, row):
        self._row = row
        return self

    def execute(self):
        self.sync_logs.append(self._row)
        return SimpleNamespace(data=None)


# ---------------------------------------------------------------------------
# 1-3: the pure decision (merge_refresh_response)
# ---------------------------------------------------------------------------

def test_rotated_response_replaces_the_stored_refresh_token() -> None:
    out, rotation = te.merge_refresh_response(STORED, dict(ROTATED))
    assert rotation == "rotated", rotation
    assert out["refresh_token"] == "rotated-refresh"
    assert out["access_token"] == "new-access"
    assert out["expires_in"] == 2592000
    assert out.get("obtained_at") == STORED["obtained_at"], "the pure merge stamps no clock (refresh_access_token does)"
    assert STORED["refresh_token"] == "stored-refresh", "the input dict is never mutated"


def test_unchanged_response_keeps_the_stored_value() -> None:
    out, rotation = te.merge_refresh_response(STORED, dict(ROTATED, refresh_token="stored-refresh"))
    assert rotation == "unchanged", rotation
    assert out["refresh_token"] == "stored-refresh"
    assert out["access_token"] == "new-access"


def test_missing_or_empty_response_keeps_the_stored_token() -> None:
    for missing in ({"access_token": "new-access", "expires_in": 2592000},          # key absent
                    dict(ROTATED, refresh_token=None),                              # null
                    dict(ROTATED, refresh_token=""),                                # empty string
                    dict(ROTATED, refresh_token=123)):                              # not a string
        out, rotation = te.merge_refresh_response(STORED, missing)
        assert rotation == "missing", missing
        assert out["refresh_token"] == "stored-refresh", f"an empty/absent value overwrote: {missing}"


def test_unusable_response_is_a_rejection_with_recovery_steps() -> None:
    for body in ({"error": "invalid_grant", "error_description": "stored-refresh leaked by a body"},
                 {"error": "invalid_request"},
                 {"access_token": "", "refresh_token": "rotated-refresh"},
                 {"refresh_token": "rotated-refresh"},   # no access_token
                 ["not", "an", "object"]):
        try:
            te.merge_refresh_response(STORED, body)
        except te.TanitaAuthError as e:
            msg = str(e)
            assert "tanita_etl.py --auth" in msg and "ci_token_helper.py upload tanita" in msg, msg
            assert "leaked" not in msg, msg
            assert "stored-refresh" not in msg and "rotated-refresh" not in msg, msg
        else:
            raise AssertionError(f"response {body} must be a rejection")


def test_default_expires_in_when_omitted() -> None:
    out, _ = te.merge_refresh_response(STORED, {"access_token": "new-access"})
    assert out["expires_in"] == 2592000


# ---------------------------------------------------------------------------
# The refresh path persists through the token file
# ---------------------------------------------------------------------------

def _run_refresh(tokens: dict, response: FakeResponse):
    """Drive refresh_access_token against a mocked token endpoint + temp file.
    Returns (result dict, saved file content, the httpx.post mock)."""
    with tempfile.TemporaryDirectory() as tmp:
        token_file = os.path.join(tmp, "tanita_tokens.json")
        Path(token_file).write_text(json.dumps(tokens))
        with patch.object(te, "TANITA_TOKEN_FILE", token_file), \
             patch.object(te.httpx, "post", return_value=response) as post:
            result = te.refresh_access_token(tokens)
        saved = json.loads(Path(token_file).read_text())
        return result, saved, post


def test_refresh_persists_a_rotated_token_to_the_file() -> None:
    result, saved, post = _run_refresh(dict(STORED), FakeResponse(200, dict(ROTATED)))
    assert saved["refresh_token"] == "rotated-refresh", saved
    assert saved["access_token"] == "new-access"
    assert saved["obtained_at"] >= 1 and "expires_in" in saved
    assert result["refresh_token"] == "rotated-refresh"
    sent = post.call_args.kwargs["data"]
    assert sent["grant_type"] == "refresh_token" and sent["refresh_token"] == "stored-refresh"


def test_refresh_without_a_refresh_token_saves_the_old_one() -> None:
    _, saved, _ = _run_refresh(dict(STORED), FakeResponse(200, {"access_token": "new-access"}))
    assert saved["refresh_token"] == "stored-refresh", "an omitted refresh_token must keep the old one"


def test_refresh_never_overwrites_with_an_empty_refresh_token() -> None:
    _, saved, _ = _run_refresh(dict(STORED), FakeResponse(200, dict(ROTATED, refresh_token="")))
    assert saved["refresh_token"] == "stored-refresh", "an empty value must never overwrite the stored token"


def test_rejected_refresh_raises_and_leaves_the_file_untouched() -> None:
    for rejected in (FakeResponse(400, {"error": "invalid_grant", "error_description": "stored-refresh in a body"}),
                     FakeResponse(401, {"error": "unauthorized"}),
                     FakeResponse(200, {"error": "invalid_request"})):
        with tempfile.TemporaryDirectory() as tmp:
            token_file = os.path.join(tmp, "tanita_tokens.json")
            Path(token_file).write_text(json.dumps(STORED))
            before = Path(token_file).read_text()
            with patch.object(te, "TANITA_TOKEN_FILE", token_file), \
                 patch.object(te.httpx, "post", return_value=rejected):
                try:
                    te.refresh_access_token(dict(STORED))
                except te.TanitaAuthError as e:
                    msg = str(e)
                    assert "tanita_etl.py --auth" in msg and "ci_token_helper.py upload tanita" in msg, msg
                    assert "leaked" not in msg, "the response body is never echoed"
                    assert "stored-refresh" not in msg, "no token in an error message"
                else:
                    raise AssertionError(f"{rejected.status_code} response must reject")
                assert Path(token_file).read_text() == before, "a rejected refresh must not rewrite the token file"


# ---------------------------------------------------------------------------
# 4: run_etl on a rejected refresh — failed heartbeat + exit 1
# ---------------------------------------------------------------------------

def test_run_etl_on_rejection_writes_failed_heartbeat_and_exits_1() -> None:
    """The pre-flight refresh is refused: one failed heartbeat naming the
    recovery steps, exit 1 (red run), token file untouched."""
    sb = FakeSupabase()
    with tempfile.TemporaryDirectory() as tmp:
        token_file = os.path.join(tmp, "tanita_tokens.json")
        # obtained_at=1 -> long expired -> the pre-flight refresh runs.
        Path(token_file).write_text(json.dumps(STORED))
        before = Path(token_file).read_text()
        refused = FakeResponse(400, {"error": "invalid_grant", "error_description": "stored-refresh in a body"})
        with patch.object(te, "TANITA_TOKEN_FILE", token_file), \
             patch.object(te.httpx, "post", return_value=refused), \
             patch.object(te, "get_supabase", return_value=sb):
            code = 0
            try:
                te.run_etl(days=14)
            except SystemExit as e:
                code = e.code
        assert code == 1, "a rejected refresh token must exit 1 (red run, fixed not retried)"
        assert len(sb.sync_logs) == 1, sb.sync_logs
        hb = sb.sync_logs[0]
        assert hb["source"] == "tanita" and hb["data_type"] == "weight", hb
        assert hb["status"] == "failed" and hb["records_synced"] == 0, hb
        msg = hb["error_message"]
        assert "tanita_etl.py --auth" in msg and "ci_token_helper.py upload tanita" in msg, msg
        assert "stored-refresh" not in msg and "leaked" not in msg, "no token, no response body in a heartbeat"
        assert Path(token_file).read_text() == before, "a rejected refresh must not rewrite the token file"


def test_run_etl_on_midrun_rejection_also_fails_loud() -> None:
    """Fresh stored tokens skip the pre-flight refresh; a 401 on the data call
    triggers the reactive refresh inside TanitaClient._request, which is
    refused the same way: failed heartbeat + exit 1."""
    sb = FakeSupabase()

    class _RefusedClient:
        def __init__(self, tokens):
            self.tokens = tokens

        def innerscan(self, *_a):
            # access_token refused on the data call -> reactive refresh -> refused
            raise te.TanitaAuthError(f"{te.REAUTH_INSTRUCTIONS} (HTTP 401)")

    with tempfile.TemporaryDirectory() as tmp:
        token_file = os.path.join(tmp, "tanita_tokens.json")
        fresh = dict(STORED, expires_in=2592000, obtained_at=int(time.time()))
        Path(token_file).write_text(json.dumps(fresh))
        with patch.object(te, "TANITA_TOKEN_FILE", token_file), \
             patch.object(te, "get_supabase", return_value=sb), \
             patch.object(te, "TanitaClient", _RefusedClient):
            code = 0
            try:
                te.run_etl(days=14)
            except SystemExit as e:
                code = e.code
        assert code == 1, code
        assert len(sb.sync_logs) == 1 and sb.sync_logs[0]["status"] == "failed", sb.sync_logs
        assert "tanita_etl.py --auth" in sb.sync_logs[0]["error_message"]


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"ok   {name}")
            except Exception as exc:  # noqa: BLE001
                failures += 1
                print(f"FAIL {name}: {exc!r}")
    if failures:
        print(f"{failures} failure(s)")
        sys.exit(1)
    print("OK - tanita token refresh tests passed.")