"""Subprocess helpers for CI runtime scripts."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def validate_command(command: list[str]) -> None:
    if not command:
        raise ValueError("command must not be empty")
    if any(not isinstance(part, str) or not part for part in command):
        raise ValueError("command arguments must be non-empty strings")


def run_logged(command: list[str], *, cwd: Path) -> None:
    validate_command(command)
    result = subprocess.run(  # nosemgrep: dangerous-subprocess-use-audit
        command,
        cwd=cwd,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.stdout:
        print(result.stdout, file=sys.stderr, end="")
    if result.stderr:
        print(result.stderr, file=sys.stderr, end="")
    if result.returncode != 0:
        raise subprocess.CalledProcessError(result.returncode, command, result.stdout, result.stderr)
