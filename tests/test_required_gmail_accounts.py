"""The flights and delivery ETLs read their required Gmail mailboxes from repo secrets, not from code.

Synthetic addresses only. No network: these tests call the pure helpers, never IMAP.
"""

import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import delivery_email_etl as d  # noqa: E402
import flights_email_etl as f  # noqa: E402


@pytest.mark.parametrize("module, env_name", [
    (f, "FLIGHTS_REQUIRED_GMAIL_ACCOUNTS"),
    (d, "DELIVERY_REQUIRED_GMAIL_ACCOUNTS"),
])
def test_env_list_is_parsed_in_order(monkeypatch, module, env_name):
    monkeypatch.setenv(env_name, " first@example.com , ,second@example.com,")
    assert module._required_accounts() == ("first@example.com", "second@example.com")


@pytest.mark.parametrize("module, env_name", [
    (f, "FLIGHTS_REQUIRED_GMAIL_ACCOUNTS"),
    (d, "DELIVERY_REQUIRED_GMAIL_ACCOUNTS"),
])
def test_unset_env_reports_the_named_error(monkeypatch, module, env_name):
    monkeypatch.delenv(env_name, raising=False)
    assert module._required_accounts() == ()
    assert module._account_gap_notes((), set()) == [f"{env_name} is not set"]
