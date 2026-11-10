#!/usr/bin/env python3
"""Publish a signed development .ipa so the iPhone can install it over the air.

Python 3 standard library only.

This repository is PUBLIC, so workflow logs and artifacts are world-readable.
Nothing sensitive is printed here and nothing is uploaded as an artifact: the
build goes to a PRIVATE Supabase Storage bucket and the install links are
written to <private bucket>/screentime/latest.json, which the Onyx page
/install reads behind the normal login.

Two links come out of one build, because the evidence on whether iOS accepts a
query string on the manifest URL is mixed:
  link_a  manifest behind a signed URL (query string, percent-encoded in the link)
  link_b  the same manifest at an unguessable path in a public bucket that holds
          nothing else (no query string on the manifest URL)
Either way the .ipa itself is only reachable through a signed URL, and it only
runs on the one iPhone in its provisioning profile.

Environment:
  SUPABASE_URL, SUPABASE_KEY      project URL + service-role (or sb_secret_) key
  IPA_PATH                        the exported .ipa
  EXPECT_BUNDLE_ID                refuse to publish anything else
  PRIVATE_BUCKET, PUBLIC_BUCKET   default ios-builds / ios-builds-public
  EXPIRES_IN                      signed-URL lifetime in seconds (default 30 days)
  PROFILE_EXPIRES                 optional, recorded for the /install page
  GITHUB_RUN_NUMBER, GITHUB_SHA   used for the storage path
"""
import datetime
import json
import os
import plistlib
import re
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile

USER_AGENT = "onyx-ci/1.0"


def log(msg):
    print(msg, flush=True)


def die(msg):
    print(f"::error title=Publish::{msg}", flush=True)
    sys.exit(1)


class Storage:
    def __init__(self, supabase_url, key):
        self.base = supabase_url.rstrip("/") + "/storage/v1"
        self.key = key

    def call(self, method, route, body=None, headers=None, ok_statuses=(200, 201)):
        """Returns (status, bytes). Raises RuntimeError with Supabase's own message otherwise."""
        req = urllib.request.Request(self.base + route, data=body, method=method)
        req.add_header("apikey", self.key)
        req.add_header("Authorization", "Bearer " + self.key)
        req.add_header("User-Agent", USER_AGENT)
        for name, value in (headers or {}).items():
            req.add_header(name, value)
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                status, raw = resp.status, resp.read()
        except urllib.error.HTTPError as err:
            status, raw = err.code, err.read()
        except (urllib.error.URLError, TimeoutError, ConnectionError) as err:
            raise RuntimeError(f"{method} {route}: no response from Supabase ({err})") from None
        if status not in ok_statuses:
            raise RuntimeError(f"{method} {route} -> HTTP {status}: {raw[:400].decode('utf-8', 'replace')}")
        return status, raw

    def ensure_bucket(self, bucket, public):
        try:
            _, raw = self.call("GET", f"/bucket/{bucket}")
            is_public = bool(json.loads(raw).get("public"))
            if is_public != public:
                die(f"bucket {bucket} exists but is {'public' if is_public else 'private'}; "
                    f"expected {'public' if public else 'private'}. Fix it in the Supabase dashboard.")
            return
        except RuntimeError:
            pass  # Storage answers 400 with a 404 code in the body for a missing bucket
        log(f"creating {'public' if public else 'private'} bucket {bucket}")
        self.call("POST", "/bucket", json.dumps({"id": bucket, "name": bucket, "public": public}).encode(),
                  {"Content-Type": "application/json"})

    def upload(self, bucket, path, data, content_type):
        self.call("POST", f"/object/{bucket}/{urllib.parse.quote(path)}", data,
                  {"Content-Type": content_type, "x-upsert": "true"})

    def sign(self, bucket, path, expires_in):
        _, raw = self.call("POST", f"/object/sign/{bucket}/{urllib.parse.quote(path)}",
                           json.dumps({"expiresIn": expires_in}).encode(), {"Content-Type": "application/json"})
        signed = json.loads(raw).get("signedURL")
        if not signed:
            raise RuntimeError(f"sign {bucket}/{path}: no signedURL in the answer")
        return self.base + signed

    def public_url(self, bucket, path):
        return f"{self.base}/object/public/{bucket}/{urllib.parse.quote(path)}"


def ipa_info(ipa_path):
    """Info.plist of the one top-level app in the .ipa."""
    with zipfile.ZipFile(ipa_path) as z:
        names = [n for n in z.namelist() if re.fullmatch(r"Payload/[^/]+\.app/Info\.plist", n)]
        if len(names) != 1:
            die(f"expected exactly one Payload/*.app/Info.plist in the .ipa, found {len(names)}")
        return plistlib.loads(z.read(names[0]))


def build_manifest(info, ipa_url):
    return plistlib.dumps({"items": [{
        "assets": [{"kind": "software-package", "url": ipa_url}],
        "metadata": {
            "bundle-identifier": info["CFBundleIdentifier"],
            "bundle-version": str(info.get("CFBundleShortVersionString", "1.0")),
            "kind": "software",
            "title": info.get("CFBundleDisplayName") or info.get("CFBundleName") or "App",
        },
    }]})


def install_link(manifest_url):
    return "itms-services://?action=download-manifest&url=" + urllib.parse.quote(manifest_url, safe="")


def fetch_like_the_phone(label, url, want_type, method="GET", fatal=True):
    """iOS fetches the manifest and the .ipa with no cookies and no auth headers."""
    req = urllib.request.Request(url, method=method, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            status, ctype = resp.status, resp.headers.get("Content-Type", "")
            if method == "GET":
                resp.read(1)
    except urllib.error.HTTPError as err:
        status, ctype = err.code, err.headers.get("Content-Type", "")
    except (urllib.error.URLError, TimeoutError, ConnectionError) as err:
        status, ctype = 0, f"no response ({type(err).__name__})"
    ok = status == 200 and ctype.startswith(want_type)
    log(f"{label}: HTTP {status} {ctype}{'' if ok else '  <-- expected 200 ' + want_type}")
    if not ok and fatal:
        die(f"{label} is not served the way the iPhone needs it (HTTP {status}, {ctype}).")
    if not ok:
        print(f"::warning title=Publish::{label} answered HTTP {status} {ctype}", flush=True)


def main():
    env = os.environ
    for name in ("SUPABASE_URL", "SUPABASE_KEY", "IPA_PATH", "EXPECT_BUNDLE_ID"):
        if not env.get(name):
            die(f"{name} is not set")
    storage = Storage(env["SUPABASE_URL"], env["SUPABASE_KEY"])
    private_bucket = env.get("PRIVATE_BUCKET", "ios-builds")
    public_bucket = env.get("PUBLIC_BUCKET", "ios-builds-public")
    expires_in = int(env.get("EXPIRES_IN", str(30 * 86400)))
    ipa_path = env["IPA_PATH"]

    info = ipa_info(ipa_path)
    if info.get("CFBundleIdentifier") != env["EXPECT_BUNDLE_ID"]:
        die(f"the .ipa is for {info.get('CFBundleIdentifier')}, expected {env['EXPECT_BUNDLE_ID']}")
    with open(ipa_path, "rb") as fh:
        ipa_bytes = fh.read()

    run = env.get("GITHUB_RUN_NUMBER", "0")
    sha = env.get("GITHUB_SHA", "local")[:7]
    prefix = f"screentime/{run}-{sha}"
    now = datetime.datetime.now(datetime.timezone.utc)

    try:
        storage.ensure_bucket(private_bucket, False)
        storage.ensure_bucket(public_bucket, True)

        storage.upload(private_bucket, f"{prefix}/OnyxScreenTime.ipa", ipa_bytes, "application/octet-stream")
        ipa_url = storage.sign(private_bucket, f"{prefix}/OnyxScreenTime.ipa", expires_in)
        manifest = build_manifest(info, ipa_url)

        storage.upload(private_bucket, f"{prefix}/manifest.plist", manifest, "text/xml")
        manifest_a = storage.sign(private_bucket, f"{prefix}/manifest.plist", expires_in)

        slug = secrets.token_hex(16)
        storage.upload(public_bucket, f"screentime/{slug}/manifest.plist", manifest, "text/xml")
        manifest_b = storage.public_url(public_bucket, f"screentime/{slug}/manifest.plist")

        fetch_like_the_phone("manifest A (signed URL)", manifest_a, "text/xml")
        fetch_like_the_phone("manifest B (public path)", manifest_b, "text/xml")
        fetch_like_the_phone("ipa HEAD", ipa_url, "application/octet-stream", method="HEAD", fatal=False)
        fetch_like_the_phone("ipa GET", ipa_url, "application/octet-stream")

        latest = {
            "run_number": int(run) if run.isdigit() else run,
            "sha": sha,
            "built_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "links_expire_at": (now + datetime.timedelta(seconds=expires_in)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "profile_expires": env.get("PROFILE_EXPIRES") or None,
            "bundle_id": info["CFBundleIdentifier"],
            "version": str(info.get("CFBundleShortVersionString", "")),
            "build": str(info.get("CFBundleVersion", "")),
            "ipa_bytes": len(ipa_bytes),
            "link_a": install_link(manifest_a),
            "link_b": install_link(manifest_b),
            "ipa_url": ipa_url,
        }
        storage.upload(private_bucket, "screentime/latest.json", json.dumps(latest, indent=2).encode(),
                       "application/json")
    except RuntimeError as err:
        die(str(err))

    log(f"published build {run}-{sha} ({len(ipa_bytes)} bytes); install links are on the Onyx /install page")


if __name__ == "__main__":
    main()
