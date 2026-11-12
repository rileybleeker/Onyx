"""Offline test: publish_build.py sends the Supabase key in the form that key type accepts.

Legacy service-role keys are JWTs (apikey + Bearer). sb_secret_ keys are not JWTs, so a Bearer
header would be rejected; they go in apikey only."""
import importlib.util
import pathlib
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location(
    "publish_build", pathlib.Path(__file__).parents[1] / "tools/screentime_ios/ci/publish_build.py")
pb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pb)


class AuthHeaders(unittest.TestCase):
    def test_legacy_jwt_key_sends_apikey_and_bearer(self):
        key = "eyJhbGciOiJIUzI1NiJ9.payload.signature"
        self.assertEqual(pb.auth_headers(key), {"apikey": key, "Authorization": "Bearer " + key})

    def test_sb_secret_key_sends_apikey_only(self):
        key = "sb_secret_abc123"
        self.assertEqual(pb.auth_headers(key), {"apikey": key})

    def test_storage_call_uses_those_headers(self):
        for key, expect_bearer in (("eyJa.b.c", True), ("sb_secret_x", False)):
            seen = {}

            class Resp:
                status = 200

                def read(self):
                    return b"{}"

                def __enter__(self):
                    return self

                def __exit__(self, *a):
                    return False

            def fake_open(req, timeout=0):
                seen.update({k.lower(): v for k, v in req.header_items()})
                return Resp()

            with mock.patch.object(pb.urllib.request, "urlopen", fake_open):
                pb.Storage("https://example.invalid", key).call("GET", "/bucket/x")
            self.assertEqual(seen.get("apikey"), key)
            self.assertEqual("authorization" in seen, expect_bearer)


if __name__ == "__main__":
    unittest.main()
