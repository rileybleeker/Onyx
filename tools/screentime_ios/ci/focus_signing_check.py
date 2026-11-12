#!/usr/bin/env python3
"""Signing checks for the Onyx Focus build (.github/workflows/focus-ios-signed.yml).

Python 3 standard library only. Two modes:

  profiles  BEFORE the build: the two downloaded profiles (main app + focus
            monitor extension) against the signing certificate and the iPhone.
  signed    AFTER the export: the signed .app and its embedded .appex, i.e. the
            entitlements in each code signature and each embedded profile.

Every problem is reported (not just the first) as a GitHub error annotation in
plain English, naming the developer-portal step that is missing. Exit 1 if any.

THE REPOSITORY IS PUBLIC: this never prints the device UDID (read from the
IPHONE_UDID environment variable), certificates or links. Team ID, bundle IDs,
profile names and dates are not secret and do appear.

Inputs are plists already decoded on the runner:
  profile:      security cms -D -i <x>.mobileprovision -o <x>.plist
  entitlements: codesign -d --entitlements - --xml <bundle> | plutil -convert xml1 -o <x>.plist -
"""
import argparse
import datetime
import os
import plistlib
import re
import sys

MAIN_ID = "com.rileybleeker.onyxscreentime"
MONITOR_ID = "com.rileybleeker.onyxscreentime.focusmonitor"
GROUP = "group.com.rileybleeker.onyxscreentime.focus"
FC = "com.apple.developer.family-controls"
FC_USAGE = "com.apple.developer.family-controls.app-and-website-usage"
GROUPS_KEY = "com.apple.security.application-groups"
TEAM_KEY = "com.apple.developer.team-identifier"

TARGETS = {
    "main": {
        "bundle": MAIN_ID,
        "secret": "IOS_PROFILE_B64",
        "label": "main app profile",
        "signed_label": "signed main app",
        "entitlements": (FC, FC_USAGE),
    },
    "monitor": {
        "bundle": MONITOR_ID,
        "secret": "IOS_FOCUS_MONITOR_PROFILE_B64",
        "label": "focus monitor profile",
        "signed_label": "signed focus monitor extension (.appex)",
        "entitlements": (FC,),
    },
}

WARN_DAYS = 14


def norm_udid(value):
    """Same normalisation as ci/asc_signing.py norm_udid(): ignore case, hyphens and whitespace."""
    return re.sub(r"[\s-]", "", value or "").upper()


def regen(kind):
    t = TARGETS[kind]
    return (f"then delete and re-create the iOS App Development profile for {t['bundle']}, "
            f"download it and set {t['secret']} again")


def cert_team_ids(der):
    """Team-ID-shaped OU values of a DER certificate (the subject OU of an Apple Development cert)."""
    found, oid, i = [], b"\x06\x03\x55\x04\x0b", 0  # OID 2.5.4.11 organizationalUnitName
    while True:
        i = der.find(oid, i)
        if i == -1:
            return found
        j = i + len(oid)
        if j + 2 <= len(der) and der[j] in (0x0C, 0x13, 0x16) and der[j + 1] < 0x80:
            value = der[j + 2:j + 2 + der[j + 1]].decode("utf-8", "replace")
            if re.fullmatch(r"[A-Z0-9]{10}", value):
                found.append(value)
        i = j


def as_utc(value):
    """plistlib returns naive datetimes that are UTC."""
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=datetime.timezone.utc)


def profile_team(profile):
    teams = profile.get("TeamIdentifier") or []
    return teams[0] if teams else ""


def check_profile(kind, profile, *, cert_der, udid, now, expect_uuid=None):
    """Problems and warnings for one decoded .mobileprovision."""
    t = TARGETS[kind]
    problems, warnings = [], []
    ents = profile.get("Entitlements") or {}
    team = profile_team(profile)
    app_id = ents.get("application-identifier", "")

    if expect_uuid and profile.get("UUID") != expect_uuid:
        problems.append(f"The {t['label']} embedded in the build is not the one from {t['secret']} "
                        f"(the export picked another profile). This is a workflow problem, not a portal step.")
    if app_id != f"{team}.{t['bundle']}":
        if kind == "monitor":
            fix = (f"register the identifier {MONITOR_ID} (Identifiers -> + -> App IDs, with Family Controls "
                   f"(Development) and App Groups ticked), create an iOS App Development profile for it")
        else:
            fix = f"create the iOS App Development profile for the App ID {MAIN_ID}"
        problems.append(f"{t['secret']} holds a profile for {app_id or 'an unknown App ID'}, "
                        f"not {t['bundle']}: {fix}, download it and set {t['secret']} again.")
        return problems, warnings  # the remaining checks would only repeat this
    if ents.get("get-task-allow") is not True:
        problems.append(f"The {t['label']} is not a development profile: Family Controls (Development) needs an "
                        f"'iOS App Development' profile. Create that type for {t['bundle']} and set {t['secret']} again.")
    if ents.get(FC) is not True:
        problems.append(f"The {t['label']} lacks Family Controls: tick Family Controls (Development) on "
                        f"{t['bundle']}, {regen(kind)}.")
    if kind == "main" and ents.get(FC_USAGE) is not True:
        problems.append(f"The {t['label']} lost Family Controls App And Website Usage (the Screen Time export "
                        f"needs it): keep it ticked on {MAIN_ID} next to App Groups, {regen(kind)}.")
    if GROUP not in (ents.get(GROUPS_KEY) or []):
        problems.append(f"The {t['label']} lacks the App Group: register {GROUP} (Identifiers -> App Groups) if "
                        f"it does not exist, tick App Groups on {t['bundle']} and assign that group, {regen(kind)}.")

    if cert_der is not None:
        certs = [bytes(c) for c in profile.get("DeveloperCertificates") or []]
        if cert_der not in certs:
            problems.append(f"The {t['label']} was created without the Apple Development certificate in "
                            f"IOS_DEV_CERT_B64: re-create the profile with that certificate ticked, "
                            f"download it and set {t['secret']} again.")

    devices = {norm_udid(d) for d in profile.get("ProvisionedDevices") or []}
    if not devices:
        problems.append(f"The {t['label']} lists no devices: it must be an iOS App Development profile with "
                        f"the registered iPhone ticked. Re-create it and set {t['secret']} again.")
    elif norm_udid(udid) not in devices:
        problems.append(f"The iPhone (IPHONE_UDID) is not in the {t['label']}: register the iPhone under "
                        f"Devices if needed, re-create the profile with it ticked, and set {t['secret']} again.")

    expires = as_utc(profile.get("ExpirationDate"))
    if expires is None:
        problems.append(f"The {t['label']} has no expiration date (not a valid .mobileprovision?).")
    else:
        days = (expires - now).total_seconds() / 86400
        stamp = expires.strftime("%Y-%m-%dT%H:%M:%SZ")
        if days < 1:
            problems.append(f"The {t['label']} expires {stamp} (expired or within a day): {regen(kind)}.")
        elif days < WARN_DAYS:
            warnings.append(f"The {t['label']} expires in {int(days)} days ({stamp}).")
    return problems, warnings


def check_pair(main, monitor, *, cert_der):
    """Cross-profile checks: one team, which is the certificate's team; distinct names."""
    problems = []
    team_main, team_mon = profile_team(main), profile_team(monitor)
    if team_main != team_mon:
        problems.append(f"The two profiles belong to different teams ({team_main or '?'} and {team_mon or '?'}): "
                        f"create both in the same developer account.")
    if cert_der is not None:
        cert_teams = cert_team_ids(cert_der)
        if team_main not in cert_teams:
            problems.append(f"The certificate in IOS_DEV_CERT_B64 is for team {', '.join(cert_teams) or '?'}, "
                            f"the profiles for {team_main or '?'}: use one developer account for both.")
    if main.get("Name") and main.get("Name") == monitor.get("Name"):
        problems.append(f"Both profiles are named '{main['Name']}': Xcode picks profiles by name, so give the "
                        f"focus monitor profile a different name, re-create it and set IOS_FOCUS_MONITOR_PROFILE_B64 again.")
    return problems


def check_signed(kind, ents, *, team):
    """Entitlements claimed in a code signature (the .app or the .appex)."""
    t = TARGETS[kind]
    problems = []
    if ents.get("application-identifier") != f"{team}.{t['bundle']}":
        problems.append(f"The {t['signed_label']} is signed as {ents.get('application-identifier') or '?'}, "
                        f"expected {team}.{t['bundle']}.")
    if ents.get(TEAM_KEY) != team:
        problems.append(f"The {t['signed_label']} is signed for team {ents.get(TEAM_KEY) or '?'}, expected {team}.")
    if ents.get("get-task-allow") is not True:
        problems.append(f"The {t['signed_label']} is not development-signed (get-task-allow is not true).")
    for ent in t["entitlements"]:
        if ents.get(ent) is not True:
            problems.append(f"The {t['signed_label']} does not claim {ent}. Its profile passed the earlier check, "
                            f"so the project spec is not writing it: a code problem, not a portal step.")
    groups = ents.get(GROUPS_KEY)
    if groups != [GROUP]:
        problems.append(f"The {t['signed_label']} claims App Groups {groups!r}, expected exactly [{GROUP!r}]. "
                        f"Its profile passed the earlier check, so this is a project-spec problem, not a portal step.")
    return problems


def annotate(kind, title, msg):
    msg = msg.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
    print(f"::{kind} title={title}::{msg}", flush=True)


def finish(title, problems, warnings):
    for w in warnings:
        annotate("warning", title, w)
    for p in problems:
        annotate("error", title, p)
    if problems:
        print(f"{len(problems)} signing problem(s); nothing was published.", flush=True)
        return 1
    print("all signing checks passed", flush=True)
    return 0


def load_plist(path):
    with open(path, "rb") as fh:
        return plistlib.load(fh)


def parse_cert_end(text):
    """openssl x509 -enddate output: 'notAfter=Nov 11 12:00:00 2027 GMT' (or without the prefix)."""
    text = " ".join(text.replace("notAfter=", "").split())
    return datetime.datetime.strptime(text, "%b %d %H:%M:%S %Y %Z").replace(tzinfo=datetime.timezone.utc)


def write_env(values):
    path = os.environ.get("GITHUB_ENV")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as fh:
        for key, value in values.items():
            fh.write(f"{key}={value}\n")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="mode", required=True)
    pre = sub.add_parser("profiles")
    pre.add_argument("--main-profile", required=True)
    pre.add_argument("--monitor-profile", required=True)
    pre.add_argument("--cert", required=True, help="DER certificate")
    pre.add_argument("--cert-not-after", required=True, help="openssl x509 -enddate output")
    post = sub.add_parser("signed")
    for name in ("main-ents", "main-profile", "monitor-ents", "monitor-profile", "cert",
                 "team", "main-uuid", "monitor-uuid"):
        post.add_argument("--" + name, required=True)
    args = ap.parse_args(argv)

    udid = os.environ.get("IPHONE_UDID", "")
    if not norm_udid(udid):
        annotate("error", "IPHONE_UDID", "The IPHONE_UDID secret is not set: run `gh secret set IPHONE_UDID` "
                 "with the iPhone's UDID (README.md, step 2) so the job can confirm the phone is in both profiles.")
        return 1
    now = datetime.datetime.now(datetime.timezone.utc)
    with open(args.cert, "rb") as fh:
        cert_der = fh.read()

    if args.mode == "profiles":
        main_p, mon_p = load_plist(args.main_profile), load_plist(args.monitor_profile)
        problems, warnings = [], []
        for kind, prof in (("main", main_p), ("monitor", mon_p)):
            p, w = check_profile(kind, prof, cert_der=cert_der, udid=udid, now=now)
            problems += p
            warnings += w
        problems += check_pair(main_p, mon_p, cert_der=cert_der)
        cert_end = parse_cert_end(args.cert_not_after)
        if (cert_end - now).total_seconds() < 86400:
            problems.append("The Apple Development certificate in IOS_DEV_CERT_B64 has expired (or expires within "
                            "a day): create a new one from ~/.onyx-ios-signing/onyx_dev.certSigningRequest, "
                            "re-create both profiles with it, and set IOS_DEV_CERT_B64, IOS_PROFILE_B64 and "
                            "IOS_FOCUS_MONITOR_PROFILE_B64 again.")
        rc = finish("Focus signing (profiles)", problems, warnings)
        if rc == 0:
            # the app stops opening at the EARLIEST of the certificate and the two profiles
            stops = min([cert_end, as_utc(main_p["ExpirationDate"]), as_utc(mon_p["ExpirationDate"])])
            print(f"main profile: {main_p.get('Name')}; focus monitor profile: {mon_p.get('Name')}; "
                  f"build stops opening: {stops:%Y-%m-%dT%H:%M:%SZ}", flush=True)
            write_env({
                "TEAM_ID": profile_team(main_p),
                "MAIN_PROFILE_UUID": main_p["UUID"],
                "MAIN_PROFILE_NAME": main_p["Name"],
                "MONITOR_PROFILE_UUID": mon_p["UUID"],
                "MONITOR_PROFILE_NAME": mon_p["Name"],
                "PROFILE_EXPIRES": f"{stops:%Y-%m-%dT%H:%M:%SZ}",
            })
        return rc

    problems, warnings = [], []
    for kind, ents_path, prof_path, uuid in (
        ("main", args.main_ents, args.main_profile, args.main_uuid),
        ("monitor", args.monitor_ents, args.monitor_profile, args.monitor_uuid),
    ):
        p, w = check_profile(kind, load_plist(prof_path), cert_der=cert_der, udid=udid, now=now, expect_uuid=uuid)
        problems += p
        warnings += w
        problems += check_signed(kind, load_plist(ents_path), team=args.team)
    return finish("Focus signing (signed build)", problems, warnings)


if __name__ == "__main__":
    sys.exit(main())
