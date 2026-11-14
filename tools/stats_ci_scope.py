"""Select the dependency-free frontend guard only for proven frontend-only PRs."""
from __future__ import annotations

import os
import hashlib
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parent.parent


def frontend_only(paths: list[str]) -> bool:
    # Unknown/mixed changes and even Python nested under src retain the full suite.
    return bool(paths) and all(
        p.startswith("frontend/src/") and not p.endswith(".py")
        and p != "frontend/src/lib/spotify-reconnect.ts"
        for p in paths
    )


def dependency_snapshot_matches(root: Path) -> bool:
    """Any new/changed Python dependency fails closed until explicitly re-audited.

    Hash tracked source via git, so virtualenvs and generated caches are irrelevant.
    This helper is excluded to avoid self-reference; editing it always triggers full CI.
    """
    try:
        paths = subprocess.run(["git", "ls-files", "-z", "--", "*.py"], cwd=root,
                               check=True, capture_output=True, timeout=30).stdout.decode("utf-8").split("\0")
        digest = hashlib.sha256()
        for name in sorted(p for p in paths if p and p != "tools/stats_ci_scope.py"):
            digest.update(name.encode("utf-8") + b"\0")
            digest.update((root / name).read_bytes().replace(b"\r\n", b"\n"))
            digest.update(b"\0")
        return digest.hexdigest() == (root / "tools/stats_ci_dependencies.sha256").read_text().strip()
    except (OSError, subprocess.SubprocessError, UnicodeError):
        return False


def select_scope(event: str, base: str, head: str, root: Path = ROOT) -> str:
    if event != "pull_request" or not all(re.fullmatch(r"[0-9a-f]{40}", s) for s in (base, head)):
        return "full"
    if not dependency_snapshot_matches(root):
        return "full"
    try:
        # Disable rename detection: moving Python into src must retain its old path.
        result = subprocess.run(
            ["git", "diff", "--no-renames", "--name-only", "-z", base, head, "--"],
            cwd=root, check=True, capture_output=True, timeout=30,
        )
        paths = result.stdout.decode("utf-8").rstrip("\0").split("\0")
        return "frontend" if frontend_only(paths) else "full"
    except (OSError, subprocess.SubprocessError, UnicodeError):
        return "full"


if __name__ == "__main__":
    scope = select_scope(os.getenv("GITHUB_EVENT_NAME", ""), os.getenv("PR_BASE_SHA", ""), os.getenv("PR_HEAD_SHA", ""))
    print(f"Stats test scope: {scope}")
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        output.write(f"scope={scope}\n")
