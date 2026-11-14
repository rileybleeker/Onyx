"""Select the dependency-free frontend guard only for proven frontend-only PRs."""
from __future__ import annotations

import os
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


def select_scope(event: str, base: str, head: str, root: Path = ROOT) -> str:
    if event != "pull_request" or not all(re.fullmatch(r"[0-9a-f]{40}", s) for s in (base, head)):
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
