"""
Shared retry helper for ETL HTTP clients.

Why hand-rolled instead of tenacity: keeps the dep footprint flat (no new
package in every CI job's pip install) and the retry policy is narrow enough
that ~50 lines suffice.

Policy:
  - Network errors (httpx.RequestError) and 5xx / 429 are retried.
  - 429 with Retry-After honors the header (parsed as seconds; HTTP-date form
    not handled — Spotify / Notion / Voyage all use the seconds form).
  - Other transient failures use exponential backoff with jitter, capped at
    max_wait.
  - Other HTTP errors (4xx other than 429) are re-raised on the first attempt.
  - Final attempt's exception propagates.

Usage:
    resp = retry_http(
        lambda: client.get(url, params=params),
        max_attempts=3, log=logger,
    )
"""

import logging
import random
import time
from typing import Callable, Optional

import httpx

log = logging.getLogger(__name__)


def _retry_after_seconds(exc: httpx.HTTPStatusError) -> Optional[float]:
    """Return seconds-to-wait from a 429 Retry-After header, or None if absent."""
    header = exc.response.headers.get("Retry-After")
    if not header:
        return None
    try:
        return float(header)
    except (TypeError, ValueError):
        return None


def retry_http(
    call: Callable[[], httpx.Response],
    *,
    max_attempts: int = 3,
    max_wait: float = 30.0,
    base_wait: float = 1.0,
    log: logging.Logger = log,
) -> httpx.Response:
    """Invoke `call` up to `max_attempts` times, retrying on transient HTTP errors.

    Calls .raise_for_status() on each response so HTTPStatusError can be caught
    and inspected. Non-retryable (4xx other than 429) errors propagate immediately.
    """
    last_exc: BaseException | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            resp = call()
            resp.raise_for_status()
            return resp
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            last_exc = exc
            if status == 429:
                wait = _retry_after_seconds(exc)
                if wait is None:
                    wait = min(max_wait, base_wait * (2 ** (attempt - 1)))
                wait = max(0.0, min(wait, max_wait))
                if attempt < max_attempts:
                    log.warning(
                        f"HTTP 429 on attempt {attempt}/{max_attempts}; "
                        f"sleeping {wait:.1f}s before retry."
                    )
                    time.sleep(wait)
                    continue
                raise
            if 500 <= status < 600:
                if attempt < max_attempts:
                    wait = min(max_wait, base_wait * (2 ** (attempt - 1)))
                    wait += random.uniform(0, base_wait)  # jitter
                    log.warning(
                        f"HTTP {status} on attempt {attempt}/{max_attempts}; "
                        f"sleeping {wait:.1f}s before retry."
                    )
                    time.sleep(wait)
                    continue
                raise
            # non-retryable 4xx — re-raise immediately
            raise
        except httpx.RequestError as exc:
            last_exc = exc
            if attempt < max_attempts:
                wait = min(max_wait, base_wait * (2 ** (attempt - 1)))
                wait += random.uniform(0, base_wait)
                log.warning(
                    f"Network error on attempt {attempt}/{max_attempts}: "
                    f"{type(exc).__name__}: {exc}; sleeping {wait:.1f}s."
                )
                time.sleep(wait)
                continue
            raise
    # unreachable but defensive
    if last_exc:
        raise last_exc
    raise RuntimeError("retry_http exhausted without raising")
