"""Synthetic tests for the MusicBrainz name-normalization fallback in spotify_etl.py.

No network access: the HTTP client is mocked. All names are synthetic — no real
artists or real MusicBrainz payloads.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from spotify_etl import (  # noqa: E402
    MUSICBRAINZ_USER_AGENT,
    fetch_musicbrainz_tags,
    normalize_artist_name,
)


class FakeResponse:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload or {}

    def json(self):
        return self._payload


class FakeClient:
    """Mocked httpx-like client: canned responses per query, records every call."""

    def __init__(self, responses):
        # responses: {query_string: FakeResponse}; unmatched queries -> empty
        self.responses = responses
        self.calls = []  # (url, params, headers)

    def __call__(self, url, params=None, headers=None, timeout=None):
        self.calls.append({"url": url, "params": params, "headers": headers})
        return self.responses.get((params or {}).get("query"), FakeResponse())


def no_sleep(_):
    pass


class TestNormalizeArtistName(unittest.TestCase):
    def test_plain_name_lowercased_and_collapsed(self):
        self.assertEqual(normalize_artist_name("  Demo Artist  "), "demo artist")

    def test_diacritic_stripped(self):
        # NFKD + combining-mark removal: an accented letter becomes its base letter
        self.assertEqual(normalize_artist_name("Demö Artist"), "demo artist")
        # the diacritic-variant rap-name case: accented capital -> plain ascii
        self.assertEqual(normalize_artist_name("JAŸ-Z"), "jayz")

    def test_punctuation_and_symbols_removed(self):
        self.assertEqual(normalize_artist_name("Demo-Artist!"), "demoartist")
        self.assertEqual(normalize_artist_name("Demo (feat. X)"), "demo feat x")
        # hyphen removed joins the two halves, like the original lookup behavior
        self.assertEqual(normalize_artist_name("JAY-Z"), "jayz")

    def test_symbol_only_name_becomes_empty(self):
        self.assertEqual(normalize_artist_name("¥$"), "")

    def test_fullwidth_normalized_by_nfkd(self):
        self.assertEqual(normalize_artist_name("Ｄｅｍｏ"), "demo")

    def test_empty_and_whitespace_only(self):
        self.assertEqual(normalize_artist_name(""), "")
        self.assertEqual(normalize_artist_name("   "), "")


class TestFetchMusicbrainzTags(unittest.TestCase):
    def _client_with(self, **responses):
        return FakeClient({q: FakeResponse(payload=p) for q, p in responses.items()})

    def test_direct_match_returns_tags(self):
        client = self._client(**{
            "Demo Artist": {"artists": [
                {"name": "Demo Artist", "score": 100,
                 "tags": [{"name": "synthetic-pop", "count": 3},
                          {"name": "test-tag", "count": 5}]},
            ]},
        })
        tags = fetch_musicbrainz_tags("Demo Artist", get=client, sleep=no_sleep)
        self.assertEqual(tags, ["test-tag", "synthetic-pop"])  # count order
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(client.calls[0]["headers"], {"User-Agent": MUSICBRAINZ_USER_AGENT})

    def test_retry_with_normalized_name_after_no_match(self):
        # raw diacritic variant finds nothing; the normalized query hits
        client = self._client(**{
            "demo artist": {"artists": [
                {"name": "Demo Artist", "score": 87,
                 "tags": [{"name": "synthetic-pop", "count": 2}]},
            ]},
        })
        tags = fetch_musicbrainz_tags("Demö Artist", get=client, sleep=no_sleep)
        self.assertEqual(tags, ["synthetic-pop"])
        self.assertEqual([c["params"]["query"] for c in client.calls],
                         ["Demö Artist", "demo artist"])

    def test_retry_result_rejected_when_name_and_score_disagree(self):
        # normalized query returns an unrelated artist with a low score
        client = self._client(**{
            "demo artist": {"artists": [
                {"name": "Other Artist", "score": 80,
                 "tags": [{"name": "wrong-tag", "count": 1}]},
            ]},
        })
        tags = fetch_musicbrainz_tags("Demö Artist", get=client, sleep=no_sleep)
        self.assertEqual(tags, [])
        self.assertEqual(len(client.calls), 2)

    def test_retry_accepted_on_high_score_even_with_different_name(self):
        client = self._client(**{
            "demo artist": {"artists": [
                {"name": "Totally Different Name", "score": 97,
                 "tags": [{"name": "synthetic-pop", "count": 1}]},
            ]},
        })
        tags = fetch_musicbrainz_tags("Demö Artist", get=client, sleep=no_sleep)
        self.assertEqual(tags, ["synthetic-pop"])

    def test_retry_accepted_when_normalized_names_equal(self):
        client = self._client(**{
            "demoartist": {"artists": [
                {"name": "DEMO-ARTIST", "score": 40,
                 "tags": [{"name": "synthetic-pop", "count": 1}]},
            ]},
        })
        tags = fetch_musicbrainz_tags("Demo-Artist!", get=client, sleep=no_sleep)
        self.assertEqual(tags, ["synthetic-pop"])

    def test_no_retry_when_name_only_differs_by_case(self):
        # plain case difference: the fallback query would be the same lookup
        client = self._client(**{
            "Demo Artist": {"artists": []},
        })
        tags = fetch_musicbrainz_tags("Demo Artist", get=client, sleep=no_sleep)
        self.assertEqual(tags, [])
        self.assertEqual(len(client.calls), 1)

    def test_no_retry_when_normalized_name_is_empty(self):
        client = FakeClient({})
        tags = fetch_musicbrainz_tags("¥$", get=client, sleep=no_sleep)
        self.assertEqual(tags, [])
        self.assertEqual(len(client.calls), 1)  # raw attempt only

    def test_high_score_direct_match_accepted_without_retry(self):
        client = self._client(**{
            "Symbol Name": {"artists": [
                {"name": "Something Else", "score": 99,
                 "tags": [{"name": "synthetic-pop", "count": 1}]},
            ]},
        })
        tags = fetch_musicbrainz_tags("Symbol Name", get=client, sleep=no_sleep)
        self.assertEqual(tags, ["synthetic-pop"])
        self.assertEqual(len(client.calls), 1)

    def test_http_error_returns_empty_and_no_retry(self):
        client = FakeClient({})
        client.responses = {"Demo Artist": FakeResponse(status_code=503)}
        tags = fetch_musicbrainz_tags("Demö Artist", get=client, sleep=no_sleep)
        self.assertEqual(tags, [])

    def test_retry_sleeps_to_respect_rate_limit(self):
        sleeps = []
        client = self._client(**{
            "demo artist": {"artists": [
                {"name": "Demo Artist", "score": 100,
                 "tags": [{"name": "synthetic-pop", "count": 1}]},
            ]},
        })
        tags = fetch_musicbrainz_tags("Demö Artist", get=client,
                                      sleep=sleeps.append)
        self.assertEqual(tags, ["synthetic-pop"])
        self.assertEqual(sleeps, [1.05])  # 1 req/sec ceiling between attempts

    def test_empty_name_short_circuits(self):
        client = FakeClient({})
        self.assertEqual(fetch_musicbrainz_tags("", get=client, sleep=no_sleep), [])
        self.assertEqual(client.calls, [])


if __name__ == "__main__":
    unittest.main()
