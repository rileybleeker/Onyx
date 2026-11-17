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


import orders_email_etl as o  # noqa: E402
import urgent_email_etl as u  # noqa: E402

UNSET_NOTE = "FLIGHTS_REQUIRED_GMAIL_ACCOUNTS is not set"


@pytest.mark.parametrize("module", [o, u])
def test_unset_required_list_is_a_gap_not_a_pass(monkeypatch, module):
    # Env unset -> empty required list. The run must carry a note (so status is 'partial'), never a clean pass.
    monkeypatch.setattr(module, "REQUIRED_ACCOUNTS", ())
    assert module.account_gap_notes([("first@example.com", "pw")]) == [UNSET_NOTE]


@pytest.mark.parametrize("module", [o, u])
def test_all_required_accounts_configured_is_no_gap(monkeypatch, module):
    monkeypatch.setattr(module, "REQUIRED_ACCOUNTS", ("first@example.com", "second@example.com"))
    accounts = [("First@Example.com", "pw"), ("second@example.com", "pw")]
    assert module.account_gap_notes(accounts) == []


@pytest.mark.parametrize("module", [o, u])
def test_missing_required_account_is_named_by_count_not_address(monkeypatch, module):
    monkeypatch.setattr(module, "REQUIRED_ACCOUNTS", ("first@example.com", "second@example.com"))
    notes = module.account_gap_notes([("first@example.com", "pw")])
    assert notes == ["1 Gmail account(s) not configured (add IMAP_EMAIL_n/IMAP_APP_PASSWORD_n secrets)"]
    assert "second@example.com" not in notes[0]
