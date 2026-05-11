"""Shared Git helpers for GitOps runtime scripts."""

from __future__ import annotations

import subprocess
from pathlib import Path


def output(repo_root: str | Path, *args: str, strip: bool = False) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=repo_root,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip() if strip else result.stdout


def lines(repo_root: str | Path, *args: str) -> list[str]:
    return [line.strip() for line in output(repo_root, *args).splitlines() if line.strip()]


def run(repo_root: str | Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=repo_root, check=True)


def show_text(repo_root: str | Path, ref: str, repo_path: str) -> str:
    return output(repo_root, "show", f"{ref}:{repo_path}")


def list_files(repo_root: str | Path, ref: str, repo_path: str | None = None) -> list[str]:
    args = ["ls-tree", "-r", "--name-only", ref]
    if repo_path:
        args.extend(["--", repo_path])
    return lines(repo_root, *args)
