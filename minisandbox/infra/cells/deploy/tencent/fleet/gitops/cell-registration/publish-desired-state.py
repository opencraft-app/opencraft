#!/usr/bin/env python3
"""Publish one verified create-first Cell tree to the central desired-state Git repository."""

from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import tempfile
import urllib.parse
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
BRANCH = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$")
REVISION = re.compile(r"^[0-9a-f]{40}([0-9a-f]{24})?$")


def load_handoff_module():
    path = ROOT / "verify-handoff.py"
    spec = importlib.util.spec_from_file_location("cell_publication_handoff", path)
    if spec is None or spec.loader is None:
        raise ValueError("handoff verifier is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(*arguments: str, cwd: Path | None = None, env: dict[str, str] | None = None) -> str:
    result = subprocess.run(
        arguments,
        cwd=cwd,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def digest(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def validate_repository_url(value: str, allow_local: bool = False) -> str:
    if not value or any(character.isspace() for character in value):
        raise ValueError("desired-state repository URL is invalid")
    if re.fullmatch(r"git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+", value):
        return value
    parsed = urllib.parse.urlsplit(value)
    if parsed.query or parsed.fragment or parsed.password:
        raise ValueError("desired-state repository URL must not embed credentials")
    if parsed.scheme == "ssh" and parsed.hostname and parsed.path and (
        parsed.username is None or re.fullmatch(r"[A-Za-z0-9._-]+", parsed.username)
    ):
        return value
    if parsed.scheme == "https" and parsed.hostname and parsed.path and parsed.username is None:
        return value
    if (
        parsed.scheme == "http" and parsed.hostname and parsed.path and parsed.username is None
        and parsed.hostname.endswith(".svc.cluster.local")
    ):
        return value
    if (
        allow_local and parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost"}
        and parsed.path and parsed.username is None
    ):
        return value
    if allow_local and parsed.scheme == "file" and parsed.path.startswith("/"):
        return value
    if allow_local and parsed.scheme == "git" and parsed.hostname and parsed.path and parsed.username is None:
        return value
    raise ValueError("desired-state repository URL must use credential-free ssh or https")


def validate_branch(value: str) -> str:
    if not BRANCH.fullmatch(value) or ".." in value or value.endswith(("/", ".lock")):
        raise ValueError("desired-state branch is invalid")
    return value


def file_inventory(root: Path) -> dict[str, str]:
    return {
        path.relative_to(root).as_posix(): digest(path.read_bytes())
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def stable_cell_identity(inventory: dict[str, Any]) -> dict[str, Any]:
    """Return identity that cannot change during a reviewed Cell update."""

    result = copy.deepcopy(inventory)
    result.get("fleet", {}).pop("profileDigest", None)
    # datacenterName is an Engine-local routing attribute, not Cell identity.
    # New inventories validate it as exactly "default". Excluding it here lets
    # a legacy pre-validation inventory be repaired without replacing the Cell;
    # every other Terraform-owned cloud and Fleet identity remains immutable.
    result.get("fleet", {}).pop("datacenterName", None)
    # Native NodePools are replaceable Terraform-owned capacity, not Cell
    # identity. Every publication still binds the new pool through the full
    # inventory/handoff digest and live convergence check; excluding only this
    # generated ID permits a reviewed pool repair without pretending the TKE
    # cluster, VPC or durable Cell was replaced.
    result.get("kubernetes", {}).pop("statelessNodePoolId", None)
    return result


def publish(
    inventory_path: Path,
    handoff_path: Path,
    desired_root: Path,
    repository_url: str,
    branch: str,
    receipt_path: Path,
    allow_local_repository: bool = False,
    read_url: str | None = None,
    allow_update: bool = False,
    expected_revision: str | None = None,
) -> dict[str, Any]:
    repository_url = validate_repository_url(repository_url, allow_local_repository)
    read_url = validate_repository_url(read_url or repository_url, allow_local_repository)
    branch = validate_branch(branch)
    if allow_update != bool(expected_revision):
        raise ValueError("Cell update requires both allow_update and expected_revision")
    if expected_revision and not REVISION.fullmatch(expected_revision):
        raise ValueError("expected desired-state revision is invalid")
    handoff = load_handoff_module().verify(inventory_path, handoff_path, desired_root)
    raw_handoff = json.loads(handoff_path.read_text())
    expected_files = dict(raw_handoff["files"])
    expected_files["handoff-receipt.json"] = digest(handoff_path.read_bytes())
    actual_files = file_inventory(desired_root)
    if actual_files != expected_files:
        raise ValueError("desired-state tree contains files outside the verified handoff")
    if not receipt_path.is_absolute() or receipt_path.exists() or not receipt_path.parent.is_dir():
        raise ValueError("publication receipt must be a new absolute path with an existing parent")

    with tempfile.TemporaryDirectory(prefix="actor-cell-publish.", dir="/data/tmp") as temporary_name:
        worktree = Path(temporary_name) / "repository"
        run("git", "clone", "--quiet", "--single-branch", "--branch", branch, repository_url, str(worktree))
        if run("git", "status", "--porcelain=v1", cwd=worktree):
            raise ValueError("fresh desired-state repository clone is not clean")
        base_revision = run("git", "rev-parse", "HEAD", cwd=worktree)
        if expected_revision and base_revision != expected_revision:
            raise ValueError("desired-state repository moved since the reviewed update")
        target_relative = Path("cells") / handoff["cellId"]
        target = worktree / target_relative
        if target.exists():
            if not target.is_dir():
                raise ValueError("desired-state repository already contains another Cell payload")
            if file_inventory(target) != expected_files:
                if not allow_update:
                    raise ValueError("desired-state repository already contains another Cell payload")
                old_inventory_path = target / "inventory.json"
                if not old_inventory_path.is_file():
                    raise ValueError("existing Cell has no Terraform identity inventory")
                old_inventory = json.loads(old_inventory_path.read_text())
                new_inventory = json.loads(inventory_path.read_text())
                if stable_cell_identity(old_inventory) != stable_cell_identity(new_inventory):
                    raise ValueError("Cell update changes immutable Terraform-owned identity")
                shutil.rmtree(target)
                shutil.copytree(desired_root, target)
                run("git", "add", "--", target_relative.as_posix(), cwd=worktree)
                commit_env = dict(
                    os.environ,
                    GIT_AUTHOR_NAME="actor-cell-publisher",
                    GIT_AUTHOR_EMAIL="cell-publisher@actor.invalid",
                    GIT_COMMITTER_NAME="actor-cell-publisher",
                    GIT_COMMITTER_EMAIL="cell-publisher@actor.invalid",
                )
                run(
                    "git", "commit", "--quiet", "-m",
                    f"Update desired state for {handoff['cellId']}",
                    cwd=worktree, env=commit_env,
                )
        else:
            if allow_update:
                raise ValueError("reviewed Cell update target does not exist")
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(desired_root, target)
            run("git", "add", "--", target_relative.as_posix(), cwd=worktree)
            commit_env = dict(
                os.environ,
                GIT_AUTHOR_NAME="actor-cell-publisher",
                GIT_AUTHOR_EMAIL="cell-publisher@actor.invalid",
                GIT_COMMITTER_NAME="actor-cell-publisher",
                GIT_COMMITTER_EMAIL="cell-publisher@actor.invalid",
            )
            run(
                "git", "commit", "--quiet", "-m", f"Add desired state for {handoff['cellId']}",
                cwd=worktree, env=commit_env,
            )
        revision = run("git", "rev-parse", "HEAD", cwd=worktree)
        if not REVISION.fullmatch(revision):
            raise ValueError("Git produced a non-immutable revision")
        committed_files: dict[str, str] = {}
        for relative in sorted(expected_files):
            git_path = (target_relative / relative).as_posix()
            content = subprocess.run(
                ("git", "show", f"{revision}:{git_path}"),
                cwd=worktree,
                check=True,
                capture_output=True,
            ).stdout
            committed_files[relative] = digest(content)
        if committed_files != expected_files:
            raise ValueError("Git commit does not contain the exact verified handoff")
        run("git", "push", "--quiet", "origin", f"HEAD:refs/heads/{branch}", cwd=worktree)
        remote_revision = run("git", "ls-remote", "--refs", "origin", f"refs/heads/{branch}", cwd=worktree).split()[0]
        if remote_revision != revision:
            raise ValueError("remote desired-state branch did not publish the exact commit")

    result = {
        "schema": "actor-cell-desired-state-publication/v1",
        "verdict": "passed",
        "cellId": handoff["cellId"],
        "repository": {"url": read_url, "branch": branch, "path": f"cells/{handoff['cellId']}"},
        "gitRevision": revision,
        "terraformInventoryDigest": handoff["terraformInventoryDigest"],
        "handoffReceiptDigest": handoff["handoffReceiptDigest"],
        "imageInventoryDigest": handoff["imageInventoryDigest"],
        "profileDigest": handoff["profileDigest"],
        "files": expected_files,
    }
    descriptor, staged_name = tempfile.mkstemp(prefix=f".{receipt_path.name}.", dir=receipt_path.parent)
    staged = Path(staged_name)
    try:
        os.fchmod(descriptor, 0o644)
        with os.fdopen(descriptor, "w") as stream:
            json.dump(result, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.link(staged, receipt_path)
    finally:
        # Tencent bootstrap nodes intentionally carry Python 3.7; missing_ok
        # was added to pathlib.Path.unlink only in Python 3.8.
        try:
            staged.unlink()
        except FileNotFoundError:
            pass
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--inventory", required=True, type=Path)
    parser.add_argument("--handoff-receipt", required=True, type=Path)
    parser.add_argument("--desired-root", required=True, type=Path)
    parser.add_argument("--repository-url", required=True)
    parser.add_argument("--read-url", help="credential-free Argo repository URL when it differs from the push transport")
    parser.add_argument("--branch", default="main")
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument("--allow-local-repository", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--allow-update", action="store_true")
    parser.add_argument("--expected-revision")
    args = parser.parse_args()
    result = publish(
        args.inventory,
        args.handoff_receipt,
        args.desired_root,
        args.repository_url,
        args.branch,
        args.receipt,
        args.allow_local_repository,
        args.read_url,
        args.allow_update,
        args.expected_revision,
    )
    print(json.dumps({"cellPublication": "passed", "cell": result["cellId"], "revision": result["gitRevision"], "receipt": str(args.receipt)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
