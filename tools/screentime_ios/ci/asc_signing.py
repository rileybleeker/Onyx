#!/usr/bin/env python3
"""Manual development signing through the App Store Connect API.

Python 3 standard library + the `openssl` command line only (no pip installs).

Makes sure these exist, creating what is missing:
  1. the App ID (bundle ID)
  2. the registered iPhone
  3. an "Apple Development" certificate that matches the private key we hold
     (reused until 30 days before it expires, then a new one is created)
  4. a fresh iOS App Development provisioning profile (deleted and recreated
     every run so it always reflects the App ID's current capabilities and
     the current device list)

Environment:
  ASC_KEY_ID, ASC_ISSUER_ID     Team API key identifiers
  ASC_KEY_P8                    contents of AuthKey_XXXX.p8 (or ASC_KEY_P8_PATH)
  DEV_KEY_PEM_PATH              development private key (PEM, RSA 2048)
  BUNDLE_ID                     e.g. com.rileybleeker.onyxscreentime
  BUNDLE_NAME                   App ID description (used only when creating)
  DEVICE_UDID, DEVICE_NAME      the iPhone
  PROFILE_NAME                  e.g. "Onyx Screen Time Dev CI"
  REQUIRED_ENTITLEMENTS         comma-separated keys the profile must allow
  OUT_DIR                       where the .cer / .mobileprovision / signing.json go
  OPENSSL_BIN                   optional: path of the openssl binary to use
  ASC_REVOKE_UNMATCHED_DEV_CERTS=1   opt-in (not wired into the workflow): revoke
                                development certificates that do not match our key
                                when the limit blocks creation
"""
import base64
import datetime
import hashlib
import json
import os
import plistlib
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

API = os.environ.get("ASC_API_BASE", "https://api.appstoreconnect.apple.com")
OPENSSL = os.environ.get("OPENSSL_BIN", "openssl")


def log(msg):
    print(msg, flush=True)


def die(msg):
    print(f"::error::{msg}", flush=True)
    sys.exit(1)


# ---------------------------------------------------------------- JWT (ES256)

def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def der_sig_to_raw(der: bytes, size: int = 32) -> bytes:
    """ASN.1 DER ECDSA-Sig-Value (what openssl emits) -> raw r||s (what JWS wants)."""
    if der[0] != 0x30:
        raise ValueError("not a DER SEQUENCE")
    i = 2 if der[1] < 0x80 else 2 + (der[1] & 0x7F)
    out = b""
    for _ in range(2):
        if der[i] != 0x02:
            raise ValueError("not a DER INTEGER")
        n = der[i + 1]
        i += 2
        out += der[i:i + n].lstrip(b"\x00").rjust(size, b"\x00")
        i += n
    return out


class Token:
    """One signed JWT, reused until it is close to expiry."""

    LIFETIME = 600      # seconds after "now"; Apple rejects exp - iat > 1200
    BACKDATE = 60       # iat is set slightly in the past to absorb clock skew

    def __init__(self, key_id, issuer_id, p8_path):
        self.key_id, self.issuer_id, self.p8_path = key_id, issuer_id, p8_path
        self.text, self.minted = None, 0

    def get(self, force=False):
        now = int(time.time())
        if force or not self.text or now - self.minted > self.LIFETIME - 120:
            header = {"alg": "ES256", "kid": self.key_id, "typ": "JWT"}
            payload = {
                "iss": self.issuer_id,
                "iat": now - self.BACKDATE,
                "exp": now + self.LIFETIME,
                "aud": "appstoreconnect-v1",
            }
            signing_input = (
                b64url(json.dumps(header, separators=(",", ":")).encode())
                + "."
                + b64url(json.dumps(payload, separators=(",", ":")).encode())
            )
            der = subprocess.run(
                [OPENSSL, "dgst", "-sha256", "-sign", self.p8_path],
                input=signing_input.encode("ascii"),
                stdout=subprocess.PIPE,
                check=True,
            ).stdout
            self.text = signing_input + "." + b64url(der_sig_to_raw(der))
            self.minted = now
        return self.text


# ---------------------------------------------------------------- HTTP

class ApiError(Exception):
    def __init__(self, status, errors, raw):
        self.status, self.errors, self.raw = status, errors, raw
        lines = [
            " - ".join(str(x) for x in (e.get("code"), e.get("title"), e.get("detail"),
                                        (e.get("source") or {}).get("pointer")
                                        or (e.get("source") or {}).get("parameter")) if x)
            for e in errors
        ] or [raw[:500]]
        super().__init__(f"HTTP {status}: " + " | ".join(lines))

    def has_code(self, prefix):
        return any(str(e.get("code", "")).startswith(prefix) for e in self.errors)

    def detail_contains(self, needle):
        return any(needle.lower() in (str(e.get("detail", "")) + str(e.get("title", ""))).lower()
                   for e in self.errors)


class Client:
    MAX_TRIES = 5

    def __init__(self, token: Token):
        self.token = token

    def request(self, method, path_or_url, params=None, body=None):
        url = path_or_url if path_or_url.startswith("http") else API + path_or_url
        if params:
            url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
        data = json.dumps(body).encode() if body is not None else None
        idempotent = method in ("GET", "DELETE")
        refreshed = False
        tries = 0
        while True:
            tries += 1
            req = urllib.request.Request(url, data=data, method=method)
            req.add_header("Authorization", "Bearer " + self.token.get())
            req.add_header("Accept", "application/json")
            if data is not None:
                req.add_header("Content-Type", "application/json")
            try:
                with urllib.request.urlopen(req, timeout=60) as resp:
                    raw = resp.read().decode("utf-8")
                    return json.loads(raw) if raw.strip() else None
            except urllib.error.HTTPError as err:
                raw = err.read().decode("utf-8", "replace")
                try:
                    errors = json.loads(raw).get("errors", [])
                except (ValueError, AttributeError):
                    errors = []
                if err.code == 401 and not refreshed:
                    refreshed = True            # expired token or clock skew: mint a new one, once
                    self.token.get(force=True)
                    tries -= 1                  # the refresh does not use up a retry
                    continue
                if err.code == 429 and tries < self.MAX_TRIES:
                    log(f"rate limited (X-Rate-Limit: {err.headers.get('X-Rate-Limit')}); sleeping 60s")
                    time.sleep(60)
                    continue
                if err.code >= 500 and idempotent and tries < self.MAX_TRIES:
                    time.sleep(2 ** tries)      # never blind-retry a POST: it may have succeeded
                    continue
                raise ApiError(err.code, errors, raw)
            except (urllib.error.URLError, TimeoutError, ConnectionError) as err:
                # No HTTP answer at all (DNS, TLS, reset, timeout).
                if idempotent and tries < self.MAX_TRIES:
                    time.sleep(2 ** tries)
                    continue
                raise ApiError(0, [], f"{method} {url.split('?')[0]}: no response from Apple ({err})")

    def get_all(self, path, params=None):
        """GET a collection, following links.next."""
        items, page = [], self.request("GET", path, params)
        while True:
            items += page.get("data", [])
            nxt = (page.get("links") or {}).get("next")
            if not nxt:
                return items
            page = self.request("GET", nxt)


# ---------------------------------------------------------------- crypto helpers

def openssl(*args, stdin=None):
    return subprocess.run([OPENSSL, *args], input=stdin, stdout=subprocess.PIPE, check=True).stdout


def spki_sha256_of_key(key_pem_path):
    """SHA-256 of the DER SubjectPublicKeyInfo that belongs to a private key."""
    return hashlib.sha256(openssl("pkey", "-in", key_pem_path, "-pubout", "-outform", "DER")).hexdigest()


def spki_sha256_of_cert(cert_der):
    pub_pem = openssl("x509", "-inform", "DER", "-noout", "-pubkey", stdin=cert_der)
    return hashlib.sha256(openssl("pkey", "-pubin", "-outform", "DER", stdin=pub_pem)).hexdigest()


def new_csr_pem(key_pem_path):
    # Apple replaces the subject; only the public key and signature matter.
    return openssl("req", "-new", "-sha256", "-key", key_pem_path, "-subj", "/CN=PEM").decode("ascii")


def parse_time(text):
    return datetime.datetime.fromisoformat(text.replace("Z", "+00:00"))


def norm_udid(udid):
    """Apple treats a UDID with other casing or without the hyphen as the same device."""
    return (udid or "").replace("-", "").strip().upper()


def profile_plist(mobileprovision: bytes) -> dict:
    """The property list inside the profile's CMS wrapper."""
    if shutil.which("security"):                # macOS: Apple's documented way (TN3125)
        with tempfile.NamedTemporaryFile(suffix=".mobileprovision", delete=False) as fh:
            fh.write(mobileprovision)
        try:
            done = subprocess.run(["security", "cms", "-D", "-i", fh.name], stdout=subprocess.PIPE)
            if done.returncode == 0 and done.stdout.strip():
                return plistlib.loads(done.stdout)
        finally:
            os.unlink(fh.name)
    start, end = mobileprovision.find(b"<?xml"), mobileprovision.find(b"</plist>")
    if start < 0 or end < 0:
        raise ValueError("no property list found in profile")
    return plistlib.loads(mobileprovision[start:end + len(b"</plist>")])


# ---------------------------------------------------------------- steps

def ensure_bundle_id(c, identifier, name):
    # filter[identifier] is a "contains"-style match, so pick the exact one ourselves
    for b in c.get_all("/v1/bundleIds", {"filter[identifier]": identifier, "limit": 200}):
        if b["attributes"]["identifier"] == identifier:
            log(f"App ID exists: {identifier} (id {b['id']}, seedId {b['attributes'].get('seedId')})")
            return b
    log(f"registering App ID {identifier}")
    return c.request("POST", "/v1/bundleIds", body={
        "data": {
            "type": "bundleIds",
            "attributes": {"identifier": identifier, "name": name, "platform": "IOS"},
        }
    })["data"]


def find_device(c, udid):
    want = norm_udid(udid)

    def pick(devices):
        return next((d for d in devices if norm_udid(d["attributes"].get("udid")) == want), None)

    found = pick(c.get_all("/v1/devices", {"filter[udid]": udid, "limit": 200}))
    if not found:
        # The filter may miss a device registered with other casing or without the hyphen.
        found = pick(c.get_all("/v1/devices", {"limit": 200}))
    return found


def ensure_device(c, udid, name):
    device = find_device(c, udid)
    if not device:
        log(f"registering device {name}")
        try:
            device = c.request("POST", "/v1/devices", body={
                "data": {"type": "devices", "attributes": {"name": name, "udid": udid, "platform": "IOS"}}
            })["data"]
        except ApiError as err:
            # 409 "A device with number '...' already exists on this team."
            if err.status != 409:
                raise
            device = find_device(c, udid)
            if not device:
                raise
    status = device["attributes"].get("status")
    if status == "DISABLED":
        log("device is DISABLED; re-enabling")
        device = c.request("PATCH", f"/v1/devices/{device['id']}", body={
            "data": {"type": "devices", "id": device["id"], "attributes": {"status": "ENABLED"}}
        })["data"]
        status = device["attributes"].get("status")
    log(f"device {device['attributes'].get('name')} id {device['id']} status {status}")
    if status != "ENABLED":
        # PROCESSING / INELIGIBLE are not in Apple's schema but the API does return PROCESSING.
        log(f"::warning::device status is {status}; Apple leaves the device out of profiles until "
            "processing ends - re-run this job later")
    return device


LIMIT_PHRASES = ("already have a current", "maximum number of certificates")


def ensure_certificate(c, key_pem_path):
    want = spki_sha256_of_key(key_pem_path)
    now = datetime.datetime.now(datetime.timezone.utc)
    certs = c.get_all("/v1/certificates",
                      {"filter[certificateType]": "DEVELOPMENT,IOS_DEVELOPMENT", "limit": 200})
    unmatched, expiring = [], []
    for cert in certs:
        a = cert["attributes"]
        content = a.get("certificateContent")
        if content:
            der = base64.b64decode(content)
            if spki_sha256_of_cert(der) == want:
                if parse_time(a["expirationDate"]) > now + datetime.timedelta(days=30):
                    log(f"reusing certificate {cert['id']} ({a.get('name')}, serial {a.get('serialNumber')}, "
                        f"expires {a['expirationDate']})")
                    return cert, der
                expiring.append((cert, der))    # ours, inside its last 30 days: not "unmatched", never revoked
                continue
        unmatched.append(cert)

    def create():
        return c.request("POST", "/v1/certificates", body={
            "data": {
                "type": "certificates",
                "attributes": {"certificateType": "DEVELOPMENT", "csrContent": new_csr_pem(key_pem_path)},
            }
        })["data"]

    try:
        cert = create()
    except ApiError as err:
        if not (err.status == 409 and any(err.detail_contains(p) for p in LIMIT_PHRASES)):
            raise
        listing = "; ".join(f"{x['id']} {x['attributes'].get('name')} serial {x['attributes'].get('serialNumber')} "
                            f"expires {x['attributes'].get('expirationDate')}" for x in unmatched) or "(none listed)"
        if os.environ.get("ASC_REVOKE_UNMATCHED_DEV_CERTS") != "1":
            usable = [x for x in expiring
                      if parse_time(x[0]["attributes"]["expirationDate"]) > now + datetime.timedelta(days=2)]
            if usable:      # still valid: build with it instead of failing, as before the 30-day rule
                cert, der = max(usable, key=lambda x: parse_time(x[0]["attributes"]["expirationDate"]))
                log(f"::warning::Apple refused a new development certificate ({err}); reusing {cert['id']}, which "
                    f"expires {cert['attributes']['expirationDate']}. Revoke an unused development certificate in "
                    "the developer portal and re-run before that date.")
                return cert, der
            ours = "; ".join(f"{c['id']} expires {c['attributes'].get('expirationDate')}" for c, _ in expiring) or "(none)"
            die(f"Apple refused a new development certificate ({err}). Certificates that do not match our private "
                f"key: {listing}. Our own, about to expire: {ours}. Revoke one in the developer portal, then re-run.")
        for x in unmatched:
            log(f"revoking certificate {x['id']} ({x['attributes'].get('name')})")
            c.request("DELETE", f"/v1/certificates/{x['id']}")
        cert = create()
    a = cert["attributes"]
    der = base64.b64decode(a["certificateContent"])
    if spki_sha256_of_cert(der) != want:
        die("the certificate Apple returned does not match our private key")
    log(f"created certificate {cert['id']} ({a.get('name')}, serial {a.get('serialNumber')}, "
        f"expires {a.get('expirationDate')})")
    return cert, der


def recreate_profile(c, name, bundle, cert, device):
    # /v1/profiles hides expired profiles; the bundle ID's own list shows them too.
    stale = [p for p in c.get_all(f"/v1/bundleIds/{bundle['id']}/profiles", {"limit": 200})
             if p["attributes"].get("name") == name]
    stale += [p for p in c.get_all("/v1/profiles", {"filter[name]": name, "limit": 200})
              if p["attributes"].get("name") == name and p["id"] not in {s["id"] for s in stale}]
    for p in stale:
        log(f"deleting old profile {p['id']} ({p['attributes'].get('profileState')})")
        try:
            c.request("DELETE", f"/v1/profiles/{p['id']}")
        except ApiError as err:
            if err.status != 404:
                raise
    profile = c.request("POST", "/v1/profiles", body={
        "data": {
            "type": "profiles",
            "attributes": {"name": name, "profileType": "IOS_APP_DEVELOPMENT"},
            "relationships": {
                "bundleId": {"data": {"type": "bundleIds", "id": bundle["id"]}},
                "certificates": {"data": [{"type": "certificates", "id": cert["id"]}]},
                "devices": {"data": [{"type": "devices", "id": device["id"]}]},
            },
        }
    })["data"]
    a = profile["attributes"]
    log(f"created profile {profile['id']} name '{a.get('name')}' uuid {a.get('uuid')} "
        f"state {a.get('profileState')} expires {a.get('expirationDate')}")
    return profile


def main():
    env = os.environ
    out_dir = env.get("OUT_DIR", ".")
    os.makedirs(out_dir, exist_ok=True)

    p8_path = env.get("ASC_KEY_P8_PATH")
    tmp = None
    if not p8_path:
        p8 = env["ASC_KEY_P8"].strip()
        if "\\n" in p8 and "\n" not in p8:      # secret pasted with literal \n
            p8 = p8.replace("\\n", "\n")
        tmp = tempfile.NamedTemporaryFile("w", suffix=".p8", delete=False)
        tmp.write(p8 + "\n")
        tmp.close()
        os.chmod(tmp.name, 0o600)
        p8_path = tmp.name
    try:
        c = Client(Token(env["ASC_KEY_ID"], env["ASC_ISSUER_ID"], p8_path))
        udid = env["DEVICE_UDID"].strip()

        bundle = ensure_bundle_id(c, env["BUNDLE_ID"], env.get("BUNDLE_NAME", "Onyx Screen Time"))
        caps = c.get_all(f"/v1/bundleIds/{bundle['id']}/bundleIdCapabilities", {"limit": 200})
        log("App ID capabilities seen by the API: "
            + (", ".join(sorted(str(x["attributes"].get("capabilityType")) for x in caps)) or "(none)"))
        device = ensure_device(c, udid, env.get("DEVICE_NAME", "iPhone"))
        cert, cert_der = ensure_certificate(c, env["DEV_KEY_PEM_PATH"])
        profile = recreate_profile(c, env["PROFILE_NAME"], bundle, cert, device)
    finally:
        if tmp:
            os.unlink(tmp.name)

    blob = base64.b64decode(profile["attributes"]["profileContent"])
    plist = profile_plist(blob)
    cert_path = os.path.join(out_dir, "development.cer")
    profile_path = os.path.join(out_dir, f"{plist['UUID']}.mobileprovision")
    with open(cert_path, "wb") as fh:
        fh.write(cert_der)
    with open(profile_path, "wb") as fh:
        fh.write(blob)

    problems = []
    entitlements = plist.get("Entitlements", {})
    for key in [k.strip() for k in env.get("REQUIRED_ENTITLEMENTS", "").split(",") if k.strip()]:
        if key not in entitlements:
            problems.append(f"profile does not allow entitlement {key} - tick Family Controls (Development) "
                            "and, if listed, Family Controls App And Website Usage on the App ID in the "
                            "developer portal, then re-run. If they are already ticked, or the second one "
                            "is not listed, re-running will not help: check the current Apple instructions "
                            "for this entitlement")
    if norm_udid(udid) not in [norm_udid(d) for d in plist.get("ProvisionedDevices", [])]:
        problems.append(f"profile does not include device {udid} (device status: "
                        f"{device['attributes'].get('status')})")
    if cert_der not in [bytes(x) for x in plist.get("DeveloperCertificates", [])]:
        problems.append("profile does not include our certificate")

    team_id = (plist.get("TeamIdentifier") or [bundle["attributes"].get("seedId")])[0]
    summary = {
        "team_id": team_id,
        "bundle_id": env["BUNDLE_ID"],
        "certificate_id": cert["id"],
        "certificate_serial": cert["attributes"].get("serialNumber"),
        "certificate_sha1": hashlib.sha1(cert_der).hexdigest().upper(),
        "certificate_path": cert_path,
        "profile_id": profile["id"],
        "profile_uuid": plist["UUID"],
        "profile_name": plist["Name"],
        "profile_expires": plist["ExpirationDate"].isoformat(),
        "profile_path": profile_path,
        "profile_entitlements": sorted(entitlements.keys()),
    }
    with open(os.path.join(out_dir, "signing.json"), "w") as fh:
        json.dump(summary, fh, indent=2)
    log(json.dumps(summary, indent=2))
    if env.get("GITHUB_OUTPUT"):
        with open(env["GITHUB_OUTPUT"], "a") as fh:
            for key in ("team_id", "profile_uuid", "profile_name", "profile_path",
                        "certificate_path", "certificate_sha1"):
                fh.write(f"{key}={summary[key]}\n")
    if problems:
        die(" / ".join(problems))


if __name__ == "__main__":
    try:
        main()
    except ApiError as err:
        die(str(err))
