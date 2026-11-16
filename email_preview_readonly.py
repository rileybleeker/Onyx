"""
Guarded read-only database client for urgent_email_etl.py --preview-db
=======================================================================
The retention preview reads real pds.inbox_emails metadata so its would-clear /
retained counts are real, and must send nothing that can change data. The
boundary is an HTTPX transport, the one point every request of the dedicated
client passes before it reaches the network. It checks each request BEFORE
delegating and lets through only:

    * method GET (no HEAD, POST, PATCH, PUT, DELETE, ...), no request body
    * https, the exact configured project origin (scheme, host, port)
    * the exact path /rest/v1/inbox_emails (no other table, no /rpc/, no auth,
      storage or functions path); the raw path is compared, so an encoded
      variant is refused too
    * Accept-Profile: pds (and, if present, Content-Profile: pds)

Anything else raises PreviewRequestBlocked and is never sent. A 3xx answer is
closed and raises PreviewRedirectBlocked (the client also has redirects off).
The client has trust_env=False and no mounts, so no environment proxy or
per-scheme transport can route around the guard.

Counters are integers only (allowed reads, blocked requests, blocked redirects,
sent writes). No URL, query, header or body value is recorded, and every
exception has fixed text.

open_preview_client() installs the guard in the httpx client BEFORE the SDK
client exists, passes it through ClientOptions.httpx_client, turns session
persistence and token refresh off, and then verifies that the query builder for
pds.inbox_emails really uses the guarded client. If the SDK does not accept or
does not use it, construction fails: there is no fallback to an unguarded client.

What this is NOT: the service-role key stays a privileged credential. This is
not a read-only database role or a privilege revocation; it is an enforced
zero-write boundary for the reviewed preview code path, and it does not defend
against code that replaces this module.
"""

from __future__ import annotations

from typing import Any, Optional

import httpx

PROFILE = "pds"
TABLE = "inbox_emails"
TABLE_PATH = b"/rest/v1/" + TABLE.encode()


class PreviewGuardError(RuntimeError):
    """A preview boundary failure. The text is a fixed code; it never carries a URL, header or body."""


class PreviewRequestBlocked(PreviewGuardError):
    """A request the preview may not send. Raised before any network delegation."""


class PreviewRedirectBlocked(PreviewGuardError):
    """The server answered a read with a redirect; it is not followed."""


class PreviewClientError(PreviewGuardError):
    """The guarded client could not be built or the SDK did not use it. No fallback exists."""


def _origin(url: str) -> tuple[str, str, int]:
    """(scheme, host, port) of the configured project URL. Only a bare https origin is accepted."""
    try:
        parsed = httpx.URL(url)
    except Exception:
        raise PreviewClientError("preview_origin_invalid") from None
    if (parsed.scheme != "https" or not parsed.host or parsed.userinfo or parsed.query
            or parsed.fragment or parsed.path not in ("", "/")):
        raise PreviewClientError("preview_origin_invalid")
    return "https", parsed.host.lower(), parsed.port or 443


class ReadOnlyTransport(httpx.BaseTransport):
    """Refuses every request but a GET of pds.inbox_emails on the project origin, before delegating."""

    def __init__(self, origin_url: str, inner: Optional[httpx.BaseTransport] = None) -> None:
        self._scheme, self._host, self._port = _origin(origin_url)
        self._inner = inner if inner is not None else httpx.HTTPTransport(retries=0)
        self.allowed_reads = 0       # GETs delegated to the network
        self.blocked_requests = 0    # refused before delegation (never sent)
        self.blocked_redirects = 0   # a delegated GET answered 3xx; not followed
        self.sent_writes = 0         # delegated requests that were not GET; structurally always 0

    def _permitted(self, request: httpx.Request) -> bool:
        if request.method != "GET":
            return False
        url = request.url
        if url.scheme != self._scheme or (url.host or "").lower() != self._host:
            return False
        if (url.port or 443) != self._port or url.userinfo or url.fragment:
            return False
        if url.raw_path.split(b"?", 1)[0] != TABLE_PATH:
            return False
        headers = request.headers
        if headers.get_list("accept-profile") != [PROFILE]:
            return False
        content_profile = headers.get_list("content-profile")
        if content_profile and content_profile != [PROFILE]:
            return False
        if headers.get("content-length", "0") != "0" or "transfer-encoding" in headers:
            return False
        # A forged Content-Length: 0 must not disguise actual content. Unread streaming
        # bodies are refused rather than consumed (the preview only builds bodyless GETs).
        try:
            if request.content:
                return False
        except httpx.RequestNotRead:
            return False
        return True

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        if not self._permitted(request):
            self.blocked_requests += 1
            raise PreviewRequestBlocked("preview_request_blocked")
        self.allowed_reads += 1
        if request.method != "GET":   # unreachable: _permitted admits GET only
            self.sent_writes += 1
        response = self._inner.handle_request(request)
        if 300 <= response.status_code < 400:
            try:
                response.close()
            finally:
                self.blocked_redirects += 1
            raise PreviewRedirectBlocked("preview_redirect_blocked")
        return response

    def close(self) -> None:
        self._inner.close()

    def counters(self) -> dict[str, int]:
        return {"allowed_reads": self.allowed_reads, "blocked_requests": self.blocked_requests,
                "blocked_redirects": self.blocked_redirects, "sent_writes": self.sent_writes}


def guarded_http_client(origin_url: str, inner: Optional[httpx.BaseTransport] = None
                        ) -> tuple[httpx.Client, ReadOnlyTransport]:
    """An httpx client whose only route to the network is ReadOnlyTransport. Redirects off, env proxies off."""
    transport = ReadOnlyTransport(origin_url, inner)
    client = httpx.Client(transport=transport, follow_redirects=False, trust_env=False,
                          timeout=httpx.Timeout(30.0))
    return client, transport


class _PreviewSchema:
    def __init__(self, owner: "PreviewReadClient") -> None:
        self._owner = owner

    def table(self, name: str) -> Any:
        if name != TABLE:
            raise PreviewClientError("preview_table_refused")
        # ClientOptions already selected pds. Calling SDK.schema() clones PostgREST in
        # current SDK versions and can drop its custom HTTP client; retain the configured client.
        builder = self._owner._sdk.table(name)
        # Every query must run on the guarded httpx client. A builder carrying any other session
        # (an SDK version that ignores httpx_client, or rebuilds the client per schema) is refused.
        if getattr(builder, "session", None) is not self._owner._http:
            raise PreviewClientError("preview_client_unguarded")
        return builder


class PreviewReadClient:
    """The only database handle the preview gets: schema('pds').table('inbox_emails'), counters, close.

    No rpc(), auth, storage or functions attribute is exposed; queries come from the SDK's own
    builder (so production read code runs unchanged) and are sent through the guarded transport."""

    def __init__(self, sdk_client: Any, http: httpx.Client, guard: ReadOnlyTransport) -> None:
        self._sdk, self._http, self._guard = sdk_client, http, guard
        self.closed = False

    def schema(self, name: str) -> _PreviewSchema:
        if name != PROFILE:
            raise PreviewClientError("preview_schema_refused")
        return _PreviewSchema(self)

    def counters(self) -> dict[str, int]:
        return self._guard.counters()

    def close(self) -> None:
        if not self.closed:
            self.closed = True
            self._http.close()

    def __enter__(self) -> "PreviewReadClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


def open_preview_client(url: str, key: str, inner: Optional[httpx.BaseTransport] = None,
                        sdk: Any = None) -> PreviewReadClient:
    """Build the guarded preview client. Raises PreviewClientError (fixed text) rather than fall back.

    `inner` replaces the network transport (tests); `sdk` replaces the supabase module (tests)."""
    http, guard = guarded_http_client(url, inner)      # validates the origin before anything else
    try:
        if sdk is None:
            import supabase as sdk                       # noqa: PLC0415  (imported only for a preview)
        try:
            options = sdk.ClientOptions(schema=PROFILE, auto_refresh_token=False, persist_session=False,
                                        httpx_client=http)
        except TypeError:
            raise PreviewClientError("preview_client_unsupported") from None
        if getattr(options, "httpx_client", None) is not http:
            raise PreviewClientError("preview_client_unguarded")
        client = sdk.create_client(url, key, options=options)
        read = PreviewReadClient(client, http, guard)
        read.schema(PROFILE).table(TABLE)               # builds a query (sends nothing) to verify the wiring
        return read
    except BaseException:
        http.close()
        raise
