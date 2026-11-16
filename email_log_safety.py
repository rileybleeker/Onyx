"""
Counts-and-codes diagnostics for the email ETLs
================================================
flights_email_etl.py, delivery_email_etl.py, orders_email_etl.py and
urgent_email_etl.py read private mail, and their CI logs and pds.sync_log
heartbeats are effectively public (the repository is public). Their logs and
heartbeat notes therefore carry only:

    * stable stage / event codes          ("account_failed", "body_fetch")
    * counts                              ("3 message(s)")
    * an allowlisted error CATEGORY        ("imap_auth", "timeout", "db_error")
    * the account fingerprint             (short hash, never the address)

Never a subject, sender, address, body text, parsed value, or the text / repr /
traceback of an exception: an IMAP error can echo the command it failed on, a
PostgREST error can echo the failing row ("Failing row contains (...)"), and a
traceback prints the source line and the local values it was handling.

error_code() maps an exception to a category by its TYPE (and, for two cases,
an internal look at a status code that is never emitted). An unknown type is
"unexpected_error": a third-party class name can itself be descriptive.

quiet_dependency_loggers() keeps HTTP client request lines out of the log.
httpx logs every request at INFO ("HTTP Request: GET https://.../rest/v1/
inbox_emails?account=eq.<address>"), and PostgREST filters put the filtered
values in the URL. Only INFO/DEBUG chatter is dropped: WARNING and above still
show, and every failure still reaches the ETL's own handler as an exception.
"""

from __future__ import annotations

import email.errors
import imaplib
import logging
import socket
import ssl
from typing import Mapping, Optional

GENERIC = "unexpected_error"

# HTTP / database client loggers that log request URLs (with filter values) at INFO or DEBUG.
DEPENDENCY_LOGGERS = ("httpx", "httpcore", "hpack", "h2", "urllib3", "postgrest", "supabase",
                      "gotrue", "supabase_auth", "storage3", "realtime")

# PostgREST / Postgres codes for "relation does not exist".
_MISSING_TABLE_CODES = frozenset({"PGRST205", "42P01"})


def quiet_dependency_loggers() -> None:
    """Raise HTTP/DB client loggers to WARNING and keep imaplib's wire trace off."""
    for name in DEPENDENCY_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)
    # imaplib prints every command and response (credentials and message data included)
    # when its debug level is raised. Nothing in these ETLs raises it; pin it anyway.
    imaplib.Debug = 0


def is_missing_table(exc: BaseException) -> bool:
    """A PostgREST 'table not found' error, judged by its status code only."""
    code = getattr(exc, "code", None)
    return isinstance(code, str) and code in _MISSING_TABLE_CODES


def _imap_auth_failure(exc: BaseException) -> bool:
    # Internal classification only: the text is inspected, never emitted.
    first = exc.args[0] if exc.args else b""
    if isinstance(first, str):
        first = first.encode("utf-8", "replace")
    if not isinstance(first, bytes):
        return False
    low = first.lower()
    return b"authenticationfailed" in low or b"invalid credentials" in low or b"authenticate failed" in low


def error_code(exc: BaseException, extra: Optional[Mapping[type, str]] = None) -> str:
    """An allowlisted category for an exception. Never its text."""
    if extra:
        for cls, code in extra.items():
            if isinstance(exc, cls):
                return code
    if is_missing_table(exc):
        return "db_table_missing"
    if isinstance(exc, imaplib.IMAP4.readonly):     # a subclass of abort: check it first
        return "imap_readonly"
    if isinstance(exc, imaplib.IMAP4.abort):
        return "imap_abort"
    if isinstance(exc, imaplib.IMAP4.error):
        return "imap_auth" if _imap_auth_failure(exc) else "imap_error"
    if isinstance(exc, (socket.timeout, TimeoutError)):
        return "timeout"
    if isinstance(exc, ssl.SSLError):
        return "tls_error"
    if isinstance(exc, socket.gaierror):
        return "dns_error"
    if isinstance(exc, ConnectionError):
        return "connection_error"
    if isinstance(exc, OSError):
        return "os_error"
    if isinstance(exc, ImportError):
        return "dependency_missing"
    if isinstance(exc, UnicodeError):
        return "decode_error"
    if isinstance(exc, KeyError):
        return "missing_key"
    if isinstance(exc, LookupError):
        return "lookup_error"
    if isinstance(exc, ValueError):
        return "value_error"
    if isinstance(exc, (TypeError, AttributeError)):
        return "program_error"
    if isinstance(exc, email.errors.MessageError):
        return "message_format"
    module = type(exc).__module__ or ""
    if module.startswith("postgrest"):
        return "db_error"
    if module.startswith(("httpx", "httpcore")):
        return "http_error"
    if isinstance(exc, RuntimeError):
        return "runtime_error"
    return GENERIC


def failure(stage: str, exc: BaseException, extra: Optional[Mapping[type, str]] = None) -> str:
    """'<stage>:<category>', e.g. 'account_failed:imap_auth'. Safe for logs, heartbeats and DB notes."""
    return f"{stage}:{error_code(exc, extra)}"


def log_failure(logger: logging.Logger, stage: str, exc: BaseException, *, fp: Optional[str] = None,
                level: int = logging.WARNING, extra: Optional[Mapping[type, str]] = None) -> str:
    """Log one failure as a code (no exc_info, no traceback, no text) and return the code."""
    code = failure(stage, exc, extra)
    prefix = f"[fp={fp}] " if fp else ""
    logger.log(level, f"{prefix}{code}")
    return code
