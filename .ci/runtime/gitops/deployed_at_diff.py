"""Detect GitOps promote diffs that only refresh deploy timestamps."""

from __future__ import annotations

import argparse
import re
import subprocess
from pathlib import Path


DEPLOYED_AT_ENV_LINE = re.compile(r"^[+-][A-Z0-9_]+_DEPLOYED_AT=.*$")
IGNORED_DIFF_PREFIXES = (
    "diff --git ",
    "index ",
    "--- ",
    "+++ ",
    "@@ ",
    r"\ No newline at end of file",
)


def staged_diff_is_deployed_at_only(repo_root: Path) -> bool:
    """Return true when the staged diff only changes *_DEPLOYED_AT env lines."""
    result = subprocess.run(
        ["git", "-C", str(repo_root), "diff", "--cached", "--unified=0", "--no-ext-diff", "--"],
        check=True,
        capture_output=True,
        text=True,
    )
    saw_changed_line = False
    for line in result.stdout.splitlines():
        if line.startswith(IGNORED_DIFF_PREFIXES):
            continue
        if line.startswith(("+", "-")):
            saw_changed_line = True
            if not DEPLOYED_AT_ENV_LINE.match(line):
                return False
            continue
        if line:
            return False
    return saw_changed_line


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    args = parser.parse_args()

    print("true" if staged_diff_is_deployed_at_only(args.repo_root) else "false")
    return 0
