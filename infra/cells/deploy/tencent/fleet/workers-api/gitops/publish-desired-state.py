#!/usr/bin/env python3
"""CAS-publish the admitted Hub Workers API tree to management desired Git."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import urllib.parse
from typing import Any


REVISION = re.compile(r"^[0-9a-f]{40}([0-9a-f]{24})?$")
BRANCH = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,126}[A-Za-z0-9])?$")
TARGET = pathlib.Path("management/workers-api")
EXPECTED_FILE_SETS = {
    frozenset({
        "evidence.json", "kustomization.yaml", "private-endpoint.yaml",
        "workers-api-render.json", "workers-api.yaml",
    }),
    frozenset({
        "evidence.json", "kustomization.yaml", "private-endpoint.yaml",
        "private-object-router-endpoint.yaml", "workers-api-render.json", "workers-api.yaml",
    }),
}


def run(*args: str, cwd: pathlib.Path | None = None, env: dict[str, str] | None = None) -> str:
    return subprocess.run(args, cwd=cwd, env=env, check=True, capture_output=True, text=True).stdout.strip()


def digest(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def inventory(root: pathlib.Path) -> dict[str, str]:
    result: dict[str, str] = {}
    for item in sorted(root.rglob("*")):
        if item.is_symlink():
            raise ValueError("desired-state trees must not contain symbolic links")
        if item.is_file():
            result[item.relative_to(root).as_posix()] = digest(item.read_bytes())
        elif not item.is_dir():
            raise ValueError("desired-state trees may contain only directories and regular files")
    return result


def validate_url(value: str, allow_local: bool) -> str:
    parsed = urllib.parse.urlsplit(value)
    if parsed.password or parsed.query or parsed.fragment or not parsed.path:
        raise ValueError("desired repository URL is unsafe")
    if parsed.scheme == "https" and parsed.hostname and not parsed.username:
        return value
    if parsed.scheme == "ssh" and parsed.hostname:
        return value
    if parsed.scheme == "http" and parsed.hostname and not parsed.username and (
        parsed.hostname.endswith(".svc.cluster.local") or (allow_local and parsed.hostname in {"127.0.0.1", "localhost"})
    ):
        return value
    if allow_local and parsed.scheme == "file" and parsed.path.startswith("/"):
        return value
    raise ValueError("desired repository must be credential-free HTTPS/SSH or cluster-local HTTP")


def publish(
    desired_root: pathlib.Path,
    render_receipt_path: pathlib.Path,
    repository_url: str,
    read_url: str,
    branch: str,
    expected_revision: str,
    receipt_path: pathlib.Path,
    allow_local: bool = False,
) -> dict[str, Any]:
    repository_url, read_url = validate_url(repository_url, allow_local), validate_url(read_url, allow_local)
    automatic_base = expected_revision == "auto"
    if not automatic_base and not REVISION.fullmatch(expected_revision):
        raise ValueError("expected Git revision is invalid")
    if not BRANCH.fullmatch(branch) or ".." in branch or "//" in branch or branch.endswith(".lock"):
        raise ValueError("desired repository branch is invalid")
    render_receipt = json.loads(render_receipt_path.read_text())
    if (render_receipt.get("schema"), render_receipt.get("verdict")) != (
        "actor-management-workers-api-desired-render/v1", "passed",
    ):
        raise ValueError("desired-state render receipt did not pass")
    files = inventory(desired_root)
    if frozenset(files) not in EXPECTED_FILE_SETS:
        raise ValueError("desired-state tree has an unexpected file inventory")
    if files != render_receipt.get("files"):
        raise ValueError("desired-state tree differs from its render receipt")
    if not receipt_path.is_absolute() or receipt_path.exists() or not receipt_path.parent.is_dir():
        raise ValueError("publication receipt must be a new absolute path")

    with tempfile.TemporaryDirectory(prefix="actor-management-workers-api-publish.", dir="/data/tmp") as temporary:
        worktree = pathlib.Path(temporary) / "repository"
        run("git", "clone", "--quiet", "--single-branch", "--branch", branch, repository_url, str(worktree))
        observed_revision = run("git", "rev-parse", "HEAD", cwd=worktree)
        if automatic_base:
            expected_revision = observed_revision
        if run("git", "status", "--porcelain=v1", cwd=worktree):
            raise ValueError("desired repository checkout is dirty")
        target = worktree / TARGET
        resumed = observed_revision != expected_revision
        if resumed:
            ancestor = subprocess.run(
                ("git", "merge-base", "--is-ancestor", expected_revision, observed_revision), cwd=worktree
            ).returncode == 0
            if not ancestor or not target.is_dir() or inventory(target) != files:
                raise ValueError("desired repository differs from the reviewed CAS base")
            revision = observed_revision
        else:
            if target.exists() and not target.is_dir():
                raise ValueError("desired repository target is not a directory")
            if target.exists() and inventory(target) != files:
                shutil.rmtree(target)
            if not target.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copytree(desired_root, target)
                run("git", "add", "--", TARGET.as_posix(), cwd=worktree)
                commit_env = dict(
                    os.environ,
                    GIT_AUTHOR_NAME="actor-management-publisher",
                    GIT_AUTHOR_EMAIL="management-publisher@actor.invalid",
                    GIT_COMMITTER_NAME="actor-management-publisher",
                    GIT_COMMITTER_EMAIL="management-publisher@actor.invalid",
                )
                run("git", "commit", "--quiet", "-m", "Update management Workers API desired state", cwd=worktree, env=commit_env)
            revision = run("git", "rev-parse", "HEAD", cwd=worktree)
            run("git", "push", "--quiet", "origin", f"HEAD:refs/heads/{branch}", cwd=worktree)
        if inventory(target) != files or not REVISION.fullmatch(revision):
            raise ValueError("committed desired state differs from the rendered tree")
        remote_revision = run("git", "ls-remote", "--refs", "origin", f"refs/heads/{branch}", cwd=worktree).split()[0]
        if remote_revision != revision:
            raise ValueError("remote desired repository did not publish the exact commit")

    result = {
        "schema": "actor-management-workers-api-desired-publication/v1",
        "verdict": "passed",
        "repository": {"url": read_url, "branch": branch, "path": TARGET.as_posix()},
        "baseRevision": expected_revision,
        "baseSelection": "observed-head" if automatic_base else "explicit",
        "observedRevision": observed_revision,
        "gitRevision": revision,
        "resumedAfterPublication": resumed,
        "renderReceiptSha256": digest(render_receipt_path.read_bytes()),
        "files": files,
    }
    descriptor, staged = tempfile.mkstemp(prefix=f".{receipt_path.name}.", dir=receipt_path.parent)
    try:
        os.fchmod(descriptor, 0o644)
        with os.fdopen(descriptor, "w") as stream:
            json.dump(result, stream, indent=2, sort_keys=True)
            stream.write("\n"); stream.flush(); os.fsync(stream.fileno())
        os.link(staged, receipt_path)
    finally:
        try: os.unlink(staged)
        except FileNotFoundError: pass
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--desired-root", required=True, type=pathlib.Path)
    parser.add_argument("--render-receipt", required=True, type=pathlib.Path)
    parser.add_argument("--repository-url", required=True)
    parser.add_argument("--read-url", required=True)
    parser.add_argument("--branch", default="main")
    parser.add_argument("--expected-revision", required=True)
    parser.add_argument("--receipt", required=True, type=pathlib.Path)
    parser.add_argument("--allow-local-repository", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    result = publish(
        args.desired_root, args.render_receipt, args.repository_url, args.read_url,
        args.branch, args.expected_revision, args.receipt, args.allow_local_repository,
    )
    print(json.dumps({"managementWorkersApiPublication": "passed", "revision": result["gitRevision"]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
