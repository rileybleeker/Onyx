"""Offline test: publish_build.py PUBLISH_PREFIX keeps the Focus build away from screentime/latest.json,
while its manifest still lands where /api/screen-time/manifest/<slug> reads (screentime/manifests/)."""
import importlib.util
import io
import os
import pathlib
import plistlib
import tempfile
import unittest
import zipfile
from contextlib import redirect_stdout
from unittest import mock

spec = importlib.util.spec_from_file_location(
    "publish_build", pathlib.Path(__file__).parents[1] / "tools/screentime_ios/ci/publish_build.py")
pb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pb)

BUNDLE = "com.rileybleeker.onyxscreentime"


class FakeStorage:
    def __init__(self, *_):
        self.uploads = []

    def ensure_bucket(self, bucket, public):
        pass

    def upload(self, bucket, path, data, content_type):
        self.uploads.append((bucket, path))

    def sign(self, bucket, path, expires_in):
        return f"https://example.invalid/sign/{bucket}/{path}?token=t"

    def public_url(self, bucket, path):
        return f"https://example.invalid/public/{bucket}/{path}"


class PublishPrefix(unittest.TestCase):
    def publish(self, prefix):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        ipa = os.path.join(tmp.name, "a.ipa")
        with zipfile.ZipFile(ipa, "w") as z:
            z.writestr("Payload/OnyxScreenTime.app/Info.plist",
                       plistlib.dumps({"CFBundleIdentifier": BUNDLE, "CFBundleShortVersionString": "0.1.0"}))
        env = {"SUPABASE_URL": "https://x.invalid", "SUPABASE_KEY": "k", "IPA_PATH": ipa,
               "EXPECT_BUNDLE_ID": BUNDLE, "GITHUB_RUN_NUMBER": "7", "GITHUB_SHA": "abcdef0123"}
        if prefix is not None:
            env["PUBLISH_PREFIX"] = prefix
        fake = FakeStorage()
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch.object(pb, "Storage", lambda *a: fake), \
                mock.patch.object(pb, "fetch_like_the_phone", lambda *a, **k: None), \
                redirect_stdout(io.StringIO()):
            pb.main()
        return fake.uploads

    def test_default_unchanged(self):
        paths = [p for _, p in self.publish(None)]
        self.assertIn("screentime/latest.json", paths)
        self.assertIn("screentime/7-abcdef0/OnyxScreenTime.ipa", paths)

    def test_focus_prefix_never_touches_default_latest(self):
        uploads = self.publish("screentime-focus")
        paths = [p for _, p in uploads]
        self.assertIn("screentime-focus/latest.json", paths)
        self.assertNotIn("screentime/latest.json", paths)
        self.assertIn("screentime-focus/7-abcdef0/OnyxScreenTime.ipa", paths)
        private_manifests = [p for b, p in uploads if b == "ios-builds" and p.startswith("screentime/manifests/")]
        self.assertEqual(len(private_manifests), 1)
        self.assertRegex(private_manifests[0], r"^screentime/manifests/[0-9a-f]{32}\.plist$")

    def test_bad_prefix_refused(self):
        with self.assertRaises(SystemExit):
            self.publish("../screentime")

    def test_log_redacts_any_slug(self):
        storage = pb.Storage("https://x.invalid", "k")
        with mock.patch.object(pb.urllib.request, "urlopen", side_effect=pb.urllib.error.URLError("down")):
            with self.assertRaises(RuntimeError) as ctx:
                storage.call("POST", "/object/ios-builds/screentime/manifests/" + "a" * 32 + ".plist")
        self.assertNotIn("a" * 32, str(ctx.exception))
        self.assertIn("<slug>", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
