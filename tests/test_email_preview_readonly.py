"""email_preview_readonly: the zero-write boundary of urgent_email_etl.py --preview-db.

Offline. The network is a recording httpx transport; every origin, key and row is synthetic. Under test:
    * only GET https://<project origin>/rest/v1/inbox_emails with Accept-Profile: pds is delegated;
      every other method, path, RPC, origin, profile, body and redirect is refused BEFORE the inner
      transport is called, and the counters tell refused attempts apart from sent requests
    * open_preview_client installs the guard before the SDK client exists, turns session persistence
      and token refresh off, verifies the query builder uses the guarded client, and fails closed
      (no fallback) when the SDK does not accept or does not use it
    * with the real supabase SDK (when installed): a select goes through the guard and an accidental
      upsert / update / delete through the same client is never sent

Run: python tests/test_email_preview_readonly.py
"""
import importlib.util
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

HAVE_HTTPX = importlib.util.find_spec("httpx") is not None
_sb = importlib.util.find_spec("supabase")
# The repo's own supabase/ folder can shadow a missing supabase-py as a namespace package.
REAL_SUPABASE = _sb is not None and _sb.origin not in (None, "namespace")

if HAVE_HTTPX:
    import httpx
    import email_preview_readonly as p

ORIGIN = "https://project-ref.example.supabase.co"
TABLE_URL = ORIGIN + "/rest/v1/inbox_emails"
# JWT-shaped synthetic key (header.payload.signature); not a credential.
FAKE_KEY = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c3ludGhldGljLXNpZ25hdHVyZQ"
FIXED_CODES = {"preview_request_blocked", "preview_redirect_blocked", "preview_origin_invalid",
               "preview_client_unguarded", "preview_client_unsupported", "preview_schema_refused",
               "preview_table_refused"}


if HAVE_HTTPX:
    class RecordingTransport(httpx.BaseTransport):
        """The 'network': records what reached it and answers with a fixed status."""

        def __init__(self, status=200, headers=None, json=None):
            self.calls, self.status, self.headers = [], status, headers or {}
            self.json = [] if json is None else json
            self.closed = False

        def handle_request(self, request):
            self.calls.append((request.method, request.url.raw_path.split(b"?", 1)[0]))
            return httpx.Response(self.status, headers=self.headers, json=self.json, request=request)

        def close(self):
            self.closed = True


def req(method="GET", url=TABLE_URL + "?select=message_id", profile="pds", **kw):
    headers = dict(kw.pop("headers", {}))
    if profile is not None:
        headers["Accept-Profile"] = profile
    return httpx.Request(method, url, headers=headers, **kw)


@unittest.skipUnless(HAVE_HTTPX, "httpx not installed")
class TransportTests(unittest.TestCase):
    def setUp(self):
        self.inner = RecordingTransport()
        self.guard = p.ReadOnlyTransport(ORIGIN, self.inner)

    def assertBlocked(self, request):
        before = self.guard.counters()
        with self.assertRaises(p.PreviewRequestBlocked) as cm:
            self.guard.handle_request(request)
        self.assertIn(str(cm.exception), FIXED_CODES)
        self.assertNotIn("example", str(cm.exception), "no URL in the exception")
        after = self.guard.counters()
        self.assertEqual(after["blocked_requests"], before["blocked_requests"] + 1)
        self.assertEqual(after["allowed_reads"], before["allowed_reads"], "a refused request is not counted as sent")
        self.assertEqual(after["sent_writes"], 0)

    def test_valid_get_delegates(self):
        resp = self.guard.handle_request(req(headers={"Content-Profile": "pds"}))
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(self.inner.calls, [("GET", b"/rest/v1/inbox_emails")])
        self.assertEqual(self.guard.counters(), {"allowed_reads": 1, "blocked_requests": 0,
                                                 "blocked_redirects": 0, "sent_writes": 0})

    def test_mutating_and_other_methods_never_reach_the_network(self):
        for method in ("POST", "PATCH", "PUT", "DELETE", "HEAD", "OPTIONS"):
            with self.subTest(method=method):
                self.assertBlocked(req(method))
        self.assertBlocked(req("POST", content=b'[{"labeled": false}]', headers={"Content-Profile": "pds"}))
        self.assertEqual(self.inner.calls, [], "nothing was delegated")
        self.assertEqual(self.guard.counters()["blocked_requests"], 7)

    def test_other_paths_rpc_auth_storage_are_refused(self):
        for url in (ORIGIN + "/rest/v1/sync_log", ORIGIN + "/rest/v1/rpc/anything", ORIGIN + "/rest/v1/",
                    ORIGIN + "/rest/v1/inbox_emails/x", ORIGIN + "/rest/v1/inbox_emails2",
                    ORIGIN + "/rest/v1/Inbox_Emails", ORIGIN + "/auth/v1/token", ORIGIN + "/storage/v1/object/x", ORIGIN + "/functions/v1/x",
                    ORIGIN + "/"):
            with self.subTest(url=url):
                self.assertBlocked(req(url=url))
        self.assertEqual(self.inner.calls, [])

    def test_other_origin_scheme_port_and_userinfo_are_refused(self):
        for url in ("https://other-ref.example.supabase.co/rest/v1/inbox_emails",
                    "http://project-ref.example.supabase.co/rest/v1/inbox_emails",
                    "https://project-ref.example.supabase.co:8443/rest/v1/inbox_emails",
                    "https://user:pw@project-ref.example.supabase.co/rest/v1/inbox_emails",
                    "https://project-ref.example.supabase.co.evil.example/rest/v1/inbox_emails"):
            with self.subTest(url=url):
                self.assertBlocked(req(url=url))
        self.assertEqual(self.inner.calls, [])

    def test_profile_must_be_pds(self):
        for profile in (None, "public", "PDS", "auth"):
            with self.subTest(profile=profile):
                self.assertBlocked(req(profile=profile))
        self.assertBlocked(req(headers={"Content-Profile": "public"}))
        self.assertEqual(self.inner.calls, [])

    def test_get_with_a_body_is_refused(self):
        self.assertBlocked(req(content=b"x"))
        self.assertBlocked(req(content=b"x", headers={"Content-Length": "0"}))
        self.assertBlocked(req(content=iter([b"x"]), headers={"Content-Length": "0"}))
        self.assertEqual(self.inner.calls, [])

    def test_redirect_is_not_followed(self):
        for status in (301, 302, 303, 307, 308):
            with self.subTest(status=status):
                inner = RecordingTransport(status=status, headers={"Location": ORIGIN + "/rest/v1/rpc/x"})
                guard = p.ReadOnlyTransport(ORIGIN, inner)
                with self.assertRaises(p.PreviewRedirectBlocked):
                    guard.handle_request(req())
                self.assertEqual(len(inner.calls), 1, "only the original GET was sent")
                self.assertEqual(guard.counters(), {"allowed_reads": 1, "blocked_requests": 0,
                                                    "blocked_redirects": 1, "sent_writes": 0})

    def test_counters_are_integers_only(self):
        self.guard.handle_request(req())
        with self.assertRaises(p.PreviewRequestBlocked):
            self.guard.handle_request(req("POST"))
        self.assertTrue(all(type(v) is int for v in self.guard.counters().values()))

    def test_invalid_origin_is_refused_at_construction(self):
        for url in ("http://project-ref.example.supabase.co", ORIGIN + "/rest/v1", ORIGIN + "?x=1",
                    "https://user:pw@project-ref.example.supabase.co", "", "not a url"):
            with self.subTest(url=url):
                with self.assertRaises(p.PreviewClientError) as cm:
                    p.ReadOnlyTransport(url, RecordingTransport())
                self.assertEqual(str(cm.exception), "preview_origin_invalid")
        p.ReadOnlyTransport(ORIGIN + "/", RecordingTransport())   # a trailing slash is still the bare origin


@unittest.skipUnless(HAVE_HTTPX, "httpx not installed")
class GuardedClientTests(unittest.TestCase):
    def test_client_has_no_redirects_no_env_and_routes_through_the_guard(self):
        inner = RecordingTransport()
        client, guard = p.guarded_http_client(ORIGIN, inner)
        try:
            self.assertFalse(client.follow_redirects)
            self.assertFalse(client.trust_env)
            self.assertEqual(client.get(TABLE_URL, headers={"Accept-Profile": "pds"}).status_code, 200)
            # An accidental write through the very client the SDK is given is never sent.
            for call in (lambda: client.post(TABLE_URL, json=[{"labeled": False}], headers={"Accept-Profile": "pds"}),
                         lambda: client.patch(TABLE_URL, json={"labeled": False}, headers={"Accept-Profile": "pds"}),
                         lambda: client.delete(TABLE_URL, headers={"Accept-Profile": "pds"}),
                         lambda: client.get(ORIGIN + "/rest/v1/sync_log", headers={"Accept-Profile": "pds"})):
                with self.assertRaises(p.PreviewRequestBlocked):
                    call()
            self.assertEqual(inner.calls, [("GET", b"/rest/v1/inbox_emails")])
            self.assertEqual(guard.counters(), {"allowed_reads": 1, "blocked_requests": 4,
                                                "blocked_redirects": 0, "sent_writes": 0})
        finally:
            client.close()

    def test_client_does_not_follow_a_redirect_even_if_asked(self):
        inner = RecordingTransport(status=302, headers={"Location": ORIGIN + "/rest/v1/rpc/x"})
        client, guard = p.guarded_http_client(ORIGIN, inner)
        try:
            with self.assertRaises(p.PreviewRedirectBlocked):
                client.get(TABLE_URL, headers={"Accept-Profile": "pds"}, follow_redirects=True)
            self.assertEqual(len(inner.calls), 1)
        finally:
            client.close()


if HAVE_HTTPX:
    class FakeOptions:
        def __init__(self, schema, auto_refresh_token, persist_session, httpx_client):
            self.schema, self.auto_refresh_token, self.persist_session = schema, auto_refresh_token, persist_session
            self.httpx_client = httpx_client

    class OldOptions:
        """An SDK without httpx_client support."""

        def __init__(self, schema, auto_refresh_token, persist_session):
            pass

    class FakeBuilder:
        def __init__(self, session):
            self.session = session

    class FakeSdkClient:
        def __init__(self, session):
            self.session, self.schemas = session, []

        def schema(self, name):
            self.schemas.append(name)
            return self

        def table(self, name):
            return FakeBuilder(self.session)

        def rpc(self, *a, **k):
            raise AssertionError("never reachable through the preview client")


def fake_sdk(options_cls=None, ignore_http_client=False):
    made = SimpleNamespace(options=[], clients=[], other=None)

    def options(**kw):
        o = (options_cls or FakeOptions)(**kw)
        made.options.append(o)
        return o

    def create_client(url, key, options=None):
        if ignore_http_client:
            made.other = httpx.Client()               # an SDK that builds its own unguarded client
            session = made.other
        else:
            session = options.httpx_client
        c = FakeSdkClient(session)
        made.clients.append(c)
        return c

    return SimpleNamespace(ClientOptions=options, create_client=create_client), made


@unittest.skipUnless(HAVE_HTTPX, "httpx not installed")
class OpenPreviewClientTests(unittest.TestCase):
    def test_wiring_options_and_facade(self):
        sdk, made = fake_sdk()
        client = p.open_preview_client(ORIGIN, FAKE_KEY, inner=RecordingTransport(), sdk=sdk)
        [opts] = made.options
        self.assertIsInstance(opts.httpx_client, httpx.Client)
        self.assertEqual((opts.schema, opts.auto_refresh_token, opts.persist_session), ("pds", False, False))
        builder = client.schema("pds").table("inbox_emails")
        self.assertIs(builder.session, opts.httpx_client, "every query runs on the guarded client")
        self.assertIsInstance(opts.httpx_client._transport, p.ReadOnlyTransport)
        for bad in (lambda: client.schema("public"), lambda: client.schema("pds").table("sync_log")):
            with self.assertRaises(p.PreviewClientError):
                bad()
        for attr in ("rpc", "auth", "storage", "functions", "table", "postgrest"):
            self.assertFalse(hasattr(client, attr), f"the preview client exposes no {attr}")
        client.close()
        self.assertTrue(opts.httpx_client.is_closed)
        client.close()                                   # idempotent

    def test_sdk_that_ignores_the_guarded_client_fails_closed(self):
        sdk, made = fake_sdk(ignore_http_client=True)
        with self.assertRaises(p.PreviewClientError) as cm:
            p.open_preview_client(ORIGIN, FAKE_KEY, inner=RecordingTransport(), sdk=sdk)
        self.assertEqual(str(cm.exception), "preview_client_unguarded")
        self.assertTrue(made.options[0].httpx_client.is_closed, "the guarded client is closed; nothing falls back")
        made.other.close()

    def test_sdk_without_httpx_client_option_fails_before_a_client_exists(self):
        sdk, made = fake_sdk(options_cls=OldOptions)
        with self.assertRaises(p.PreviewClientError) as cm:
            p.open_preview_client(ORIGIN, FAKE_KEY, inner=RecordingTransport(), sdk=sdk)
        self.assertEqual(str(cm.exception), "preview_client_unsupported")
        self.assertEqual(made.clients, [], "create_client is never called without the guard")

    def test_invalid_origin_fails_before_the_sdk_is_touched(self):
        sdk, made = fake_sdk()
        with self.assertRaises(p.PreviewClientError):
            p.open_preview_client("http://project-ref.example.supabase.co", FAKE_KEY, sdk=sdk)
        self.assertEqual((made.options, made.clients), ([], []))


@unittest.skipUnless(HAVE_HTTPX and REAL_SUPABASE, "supabase-py not installed")
class RealSdkTests(unittest.TestCase):
    """The installed supabase-py really sends the preview's queries through the guard (validates the CI SDK)."""

    def setUp(self):
        self.inner = RecordingTransport(json=[])
        self.client = p.open_preview_client(ORIGIN, FAKE_KEY, inner=self.inner)

    def tearDown(self):
        self.client.close()

    def table(self):
        return self.client.schema("pds").table("inbox_emails")

    def test_select_is_sent_through_the_guard(self):
        res = (self.table().select("message_id,gmail_message_id").eq("account", "owner@example.com")
               .eq("labeled", True).order("message_id").range(0, 999).execute())
        self.assertEqual(res.data, [])
        self.assertEqual(self.inner.calls, [("GET", b"/rest/v1/inbox_emails")])
        self.assertEqual(self.client.counters()["allowed_reads"], 1)

    def test_accidental_mutations_are_never_sent(self):
        attempts = (lambda: self.table().upsert([{"account": "owner@example.com", "message_id": "m"}],
                                                on_conflict="account,message_id").execute(),
                    lambda: self.table().update({"labeled": False}).eq("message_id", "m").execute(),
                    lambda: self.table().delete().eq("message_id", "m").execute(),
                    lambda: self.table().insert({"account": "owner@example.com", "message_id": "m"}).execute())
        for n, attempt in enumerate(attempts, 1):
            with self.subTest(n=n):
                with self.assertRaises(Exception):
                    attempt()
        self.assertEqual(self.inner.calls, [], "no mutation reached the network")
        counters = self.client.counters()
        self.assertEqual((counters["blocked_requests"], counters["allowed_reads"], counters["sent_writes"]), (4, 0, 0))


if __name__ == "__main__":
    unittest.main(verbosity=2)
