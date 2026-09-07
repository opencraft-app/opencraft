"""Classify whether a staged VelaGW promote changes only its image pin."""

from __future__ import annotations

import argparse
import re
import subprocess
from pathlib import Path


IGNORED_DIFF_PREFIXES = (
    "diff --git ",
    "index ",
    "--- ",
    "+++ ",
    "@@ ",
    r"\ No newline at end of file",
)


def staged_velagw_diff_is_pin_only(repo_root: Path, env: str) -> tuple[bool, str]:
    allowed_path = f"argocd/services/velagw/{env}/velagw-platform.env"
    names = subprocess.run(
        ["git", "-C", str(repo_root), "diff", "--cached", "--name-only", "--"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    unexpected_paths = sorted(path for path in names if path != allowed_path)
    if unexpected_paths:
        return False, "unexpected paths: " + ", ".join(unexpected_paths)

    result = subprocess.run(
        [
            "git",
            "-C",
            str(repo_root),
            "diff",
            "--cached",
            "--unified=0",
            "--no-ext-diff",
            "--",
            allowed_path,
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    allowed_line = re.compile(r"^[+-]VELAGW_(IMAGE|DEPLOYED_AT)=")
    saw_changed_line = False
    for line in result.stdout.splitlines():
        if line.startswith(IGNORED_DIFF_PREFIXES):
            continue
        if line.startswith(("+", "-")):
            saw_changed_line = True
            if not allowed_line.match(line):
                key = line[1:].split("=", 1)[0]
                return False, f"unexpected key in {allowed_path}: {key}"
            continue
        if line:
            return False, f"unexpected diff content in {allowed_path}"
    if not saw_changed_line:
        return False, "no VelaGW image pin change"
    return True, "pin-only"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--env", required=True)
    args = parser.parse_args()

    pin_only, reason = staged_velagw_diff_is_pin_only(args.repo_root, args.env)
    print("true" if pin_only else "false")
    print(reason)
    return 0
