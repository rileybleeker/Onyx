"""Offline tests for tools/screentime_ios/ci/focus_signing_check.py (Focus signed-build gates)."""
import datetime
import importlib.util
import io
import os
import pathlib
import plistlib
import tempfile
import unittest
from contextlib import redirect_stdout

spec = importlib.util.spec_from_file_location(
    "focus_signing_check", pathlib.Path(__file__).parents[1] / "tools/screentime_ios/ci/focus_signing_check.py")
fsc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fsc)

TEAM = "ABCDE12345"
UDID = "00008110-001A2B3C4D5E6F70"
NOW = datetime.datetime(2026, 11, 11, tzinfo=datetime.timezone.utc)
# minimal stand-in for a DER certificate: issuer OU G3, subject OU = team ID
CERT = (b"\x30\x00" + b"\x06\x03\x55\x04\x0b\x0c\x02G3" + b"\x06\x03\x55\x04\x0b\x0c\x0a" + TEAM.encode())


def profile(kind, **over):
    bundle = fsc.TARGETS[kind]["bundle"]
    ents = {
        "application-identifier": f"{TEAM}.{bundle}",
        "get-task-allow": True,
        fsc.FC: True,
        fsc.GROUPS_KEY: [fsc.GROUP],
        fsc.TEAM_KEY: TEAM,
    }
    if kind == "main":
        ents[fsc.FC_USAGE] = True
    p = {
        "UUID": f"uuid-{kind}",
        "Name": f"Onyx {kind} dev",
        "TeamIdentifier": [TEAM],
        "Entitlements": ents,
        "DeveloperCertificates": [CERT],
        "ProvisionedDevices": [UDID.lower().replace("-", "")],
        "ExpirationDate": datetime.datetime(2027, 6, 1),
    }
    p.update(over)
    return p


def signed(kind):
    ents = dict(profile(kind)["Entitlements"])
    return ents


class ProfileChecks(unittest.TestCase):
    def check(self, kind, prof, udid=UDID):
        return fsc.check_profile(kind, prof, cert_der=CERT, udid=udid, now=NOW)

    def test_good_profiles_pass(self):
        for kind in ("main", "monitor"):
            self.assertEqual(self.check(kind, profile(kind)), ([], []))
        self.assertEqual(fsc.check_pair(profile("main"), profile("monitor"), cert_der=CERT), [])

    def test_main_missing_app_group_names_portal_step(self):
        p = profile("main")
        p["Entitlements"][fsc.GROUPS_KEY] = []
        problems, _ = self.check("main", p)
        self.assertEqual(len(problems), 1)
        self.assertIn("main app profile lacks the App Group", problems[0])
        self.assertIn("tick App Groups on com.rileybleeker.onyxscreentime ", problems[0])
        self.assertIn("IOS_PROFILE_B64", problems[0])

    def test_main_regenerated_without_usage_entitlement(self):
        p = profile("main")
        del p["Entitlements"][fsc.FC_USAGE]
        problems, _ = self.check("main", p)
        self.assertTrue(any("App And Website Usage" in m for m in problems))

    def test_monitor_without_family_controls(self):
        p = profile("monitor")
        p["Entitlements"][fsc.FC] = False
        problems, _ = self.check("monitor", p)
        self.assertTrue(any("Family Controls (Development) on com.rileybleeker.onyxscreentime.focusmonitor" in m
                            for m in problems))
        self.assertTrue(all("IOS_FOCUS_MONITOR_PROFILE_B64" in m for m in problems))

    def test_monitor_secret_holds_main_profile(self):
        problems, _ = self.check("monitor", profile("main"))
        self.assertEqual(len(problems), 1)
        self.assertIn("register the identifier com.rileybleeker.onyxscreentime.focusmonitor", problems[0])

    def test_device_missing_and_udid_never_printed(self):
        problems, _ = self.check("main", profile("main", ProvisionedDevices=["OTHERDEVICE"]))
        self.assertEqual(len(problems), 1)
        self.assertIn("not in the main app profile", problems[0])
        self.assertNotIn(fsc.norm_udid(UDID), problems[0])

    def test_udid_normalisation(self):
        self.assertEqual(self.check("main", profile("main"), udid=" " + UDID.lower() + "\n"), ([], []))

    def test_wrong_certificate(self):
        problems, _ = self.check("main", profile("main", DeveloperCertificates=[b"other"]))
        self.assertTrue(any("IOS_DEV_CERT_B64" in m for m in problems))

    def test_expiry(self):
        problems, _ = self.check("monitor", profile("monitor", ExpirationDate=datetime.datetime(2026, 11, 11, 12)))
        self.assertTrue(any("expires 2026-11-11T12:00:00Z" in m for m in problems))
        problems, warnings = self.check("monitor", profile("monitor", ExpirationDate=datetime.datetime(2026, 11, 20)))
        self.assertEqual(problems, [])
        self.assertEqual(len(warnings), 1)

    def test_not_development(self):
        p = profile("main")
        p["Entitlements"]["get-task-allow"] = False
        problems, _ = self.check("main", p)
        self.assertTrue(any("not a development profile" in m for m in problems))

    def test_pair_team_cert_and_name(self):
        other = profile("monitor", TeamIdentifier=["ZZZZZ99999"])
        self.assertTrue(any("different teams" in m for m in fsc.check_pair(profile("main"), other, cert_der=CERT)))
        problems = fsc.check_pair(profile("main"), profile("monitor"), cert_der=b"\x06\x03\x55\x04\x0b\x0c\x0aQQQQQ11111")
        self.assertTrue(any("certificate in IOS_DEV_CERT_B64 is for team QQQQQ11111" in m for m in problems))
        same = profile("monitor", Name="Onyx main dev")
        self.assertTrue(any("different name" in m for m in fsc.check_pair(profile("main"), same, cert_der=CERT)))

    def test_cert_team_ids_skips_issuer_ou(self):
        self.assertEqual(fsc.cert_team_ids(CERT), [TEAM])


class SignedChecks(unittest.TestCase):
    def test_good_signatures_pass(self):
        for kind in ("main", "monitor"):
            self.assertEqual(fsc.check_signed(kind, signed(kind), team=TEAM), [])

    def test_app_group_must_be_exact(self):
        ents = signed("monitor")
        ents[fsc.GROUPS_KEY] = [fsc.GROUP, "group.other"]
        problems = fsc.check_signed("monitor", ents, team=TEAM)
        self.assertEqual(len(problems), 1)
        self.assertIn(".appex", problems[0])

    def test_missing_entitlement_and_team(self):
        ents = signed("main")
        del ents[fsc.FC_USAGE]
        ents[fsc.TEAM_KEY] = "ZZZZZ99999"
        problems = fsc.check_signed("main", ents, team=TEAM)
        self.assertEqual(len(problems), 2)


class Cli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.env_file = os.path.join(self.tmp.name, "github_env")
        self.old_env = dict(os.environ)
        self.addCleanup(lambda: (os.environ.clear(), os.environ.update(self.old_env)))
        os.environ["IPHONE_UDID"] = UDID
        os.environ["GITHUB_ENV"] = self.env_file

    def write(self, name, obj):
        path = os.path.join(self.tmp.name, name)
        with open(path, "wb") as fh:
            if isinstance(obj, bytes):
                fh.write(obj)
            else:
                plistlib.dump(obj, fh)
        return path

    def run_cli(self, argv):
        out = io.StringIO()
        with redirect_stdout(out):
            rc = fsc.main(argv)
        return rc, out.getvalue()

    def profiles_argv(self, main, monitor, not_after="notAfter=Nov 10 12:00:00 2099 GMT"):
        return ["profiles", "--main-profile", self.write("m.plist", main),
                "--monitor-profile", self.write("x.plist", monitor),
                "--cert", self.write("c.cer", CERT), "--cert-not-after", not_after]

    def test_profiles_ok_writes_env(self):
        rc, out = self.run_cli(self.profiles_argv(profile("main"), profile("monitor")))
        self.assertEqual(rc, 0, out)
        with open(self.env_file, encoding="utf-8") as fh:
            env = fh.read()
        self.assertIn("MAIN_PROFILE_UUID=uuid-main", env)
        self.assertIn("MONITOR_PROFILE_NAME=Onyx monitor dev", env)
        self.assertIn(f"TEAM_ID={TEAM}", env)
        self.assertIn("PROFILE_EXPIRES=2027-06-01T00:00:00Z", env)
        self.assertNotIn(fsc.norm_udid(UDID), out)

    def test_profiles_reports_every_problem(self):
        main = profile("main")
        main["Entitlements"][fsc.GROUPS_KEY] = []
        monitor = profile("monitor", ProvisionedDevices=["X"])
        rc, out = self.run_cli(self.profiles_argv(main, monitor, "notAfter=Jan  1 00:00:00 2020 GMT"))
        self.assertEqual(rc, 1)
        self.assertEqual(out.count("::error "), 3, out)
        self.assertFalse(os.path.exists(self.env_file))

    def test_missing_udid_fails(self):
        os.environ["IPHONE_UDID"] = ""
        rc, out = self.run_cli(self.profiles_argv(profile("main"), profile("monitor")))
        self.assertEqual(rc, 1)
        self.assertIn("IPHONE_UDID", out)

    def test_signed_mode_checks_uuid(self):
        argv = ["signed",
                "--main-ents", self.write("me.plist", signed("main")),
                "--main-profile", self.write("mp.plist", profile("main")),
                "--monitor-ents", self.write("xe.plist", signed("monitor")),
                "--monitor-profile", self.write("xp.plist", profile("monitor")),
                "--cert", self.write("c.cer", CERT), "--team", TEAM,
                "--main-uuid", "uuid-main", "--monitor-uuid", "uuid-monitor"]
        self.assertEqual(self.run_cli(argv)[0], 0)
        argv[-1] = "uuid-other"
        rc, out = self.run_cli(argv)
        self.assertEqual(rc, 1)
        self.assertIn("focus monitor profile embedded in the build", out)


if __name__ == "__main__":
    unittest.main()
