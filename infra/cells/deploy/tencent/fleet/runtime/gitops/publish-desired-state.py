#!/usr/bin/env python3
"""CAS-publish one Cell's stateless runtime tree to management Git."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import urllib.parse
from pathlib import Path


EXPECTED = {
    "evidence.json", "kustomization.yaml", "stateless-executor.yaml",
    "stateless-private-endpoint.yaml",
}
REVISION = re.compile(r"^[0-9a-f]{40}([0-9a-f]{24})?$")
CELL = re.compile(r"^actor-[a-z0-9]+-[a-z][0-9]{2}$")


def run(*args: str, cwd: Path | None = None, env: dict[str, str] | None = None) -> str:
    return subprocess.run(args, cwd=cwd, env=env, check=True, capture_output=True, text=True).stdout.strip()


def digest(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def inventory(root: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError("desired tree contains a symlink")
        if path.is_file():
            result[path.relative_to(root).as_posix()] = digest(path.read_bytes())
        elif not path.is_dir():
            raise ValueError("desired tree contains a special file")
    return result


def safe_url(value: str, allow_local: bool = False) -> str:
    parsed = urllib.parse.urlsplit(value)
    if parsed.password or parsed.query or parsed.fragment or not parsed.path:
        raise ValueError("unsafe Git URL")
    if parsed.scheme == "http" and parsed.hostname and not parsed.username and (
        parsed.hostname.endswith(".svc.cluster.local")
        or (allow_local and parsed.hostname in {"127.0.0.1", "localhost"})
    ):
        return value
    if parsed.scheme in {"https", "ssh"} and parsed.hostname and not parsed.username:
        return value
    if allow_local and parsed.scheme == "file" and parsed.path.startswith("/"):
        return value
    raise ValueError("Git URL must be credential-free")


def write_new(path: Path, value: dict) -> None:
    descriptor, staged_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    staged = Path(staged_name)
    try:
        os.fchmod(descriptor, 0o644)
        with os.fdopen(descriptor, "w") as stream:
            json.dump(value, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.link(staged, path)
    finally:
        try:
            staged.unlink()
        except FileNotFoundError:
            pass


def publish(
    root: Path,
    render_path: Path,
    write_url: str,
    read_url: str,
    expected_revision: str,
    receipt: Path,
    allow_local: bool = False,
) -> dict:
    write_url = safe_url(write_url, allow_local)
    read_url = safe_url(read_url, allow_local)
    if not REVISION.fullmatch(expected_revision):
        raise ValueError("invalid expected revision")
    if not root.is_dir() or root.is_symlink():
        raise ValueError("desired root must be a real directory")
    rendered = json.loads(render_path.read_text())
    files = inventory(root)
    cell = rendered.get("cell")
    if (
        (rendered.get("schema"), rendered.get("verdict"))
        != ("actor-stateless-runtime-desired-render/v1", "passed")
        or not isinstance(cell, str)
        or not CELL.fullmatch(cell)
        or files != rendered.get("files")
        or set(files) != EXPECTED
    ):
        raise ValueError("desired tree differs from its stateless runtime rendering")
    if not receipt.is_absolute() or receipt.exists() or not receipt.parent.is_dir():
        raise ValueError("receipt must be a new absolute path")
    target_relative = Path("runtime-cells") / cell
    with tempfile.TemporaryDirectory(prefix="actor-stateless-runtime-publish.", dir="/data/tmp") as temporary:
        repository = Path(temporary) / "repository"
        run("git", "clone", "--quiet", "--single-branch", "--branch", "main", write_url, str(repository))
        observed = run("git", "rev-parse", "HEAD", cwd=repository)
        target = repository / target_relative
        if observed != expected_revision:
            ancestor = subprocess.run(
                ("git", "merge-base", "--is-ancestor", expected_revision, observed),
                cwd=repository,
            ).returncode == 0
            if not ancestor or not target.is_dir() or inventory(target) != files:
                raise ValueError("Git CAS base differs")
            revision = observed
            resumed = True
        else:
            resumed = False
            if target.exists() and inventory(target) != files:
                shutil.rmtree(target)
            if not target.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copytree(root, target)
                run("git", "add", "--", target_relative.as_posix(), cwd=repository)
                environment = dict(
                    os.environ,
                    GIT_AUTHOR_NAME="actor-runtime-publisher",
                    GIT_AUTHOR_EMAIL="runtime-publisher@actor.invalid",
                    GIT_COMMITTER_NAME="actor-runtime-publisher",
                    GIT_COMMITTER_EMAIL="runtime-publisher@actor.invalid",
                )
                run(
                    "git", "commit", "--quiet", "-m",
                    f"Update stateless runtime desired state for {cell}",
                    cwd=repository, env=environment,
                )
            revision = run("git", "rev-parse", "HEAD", cwd=repository)
            run("git", "push", "--quiet", "origin", "HEAD:refs/heads/main", cwd=repository)
        remote = run("git", "ls-remote", "--refs", "origin", "refs/heads/main", cwd=repository).split()[0]
        if inventory(target) != files or remote != revision:
            raise ValueError("published stateless runtime Git state differs")
    result = {
        "schema": "actor-stateless-runtime-desired-publication/v1",
        "verdict": "passed",
        "cell": cell,
        "repository": {"url": read_url, "branch": "main", "path": target_relative.as_posix()},
        "baseRevision": expected_revision,
        "observedRevision": observed,
        "gitRevision": revision,
        "resumedAfterPublication": resumed,
        "renderReceiptSha256": digest(render_path.read_bytes()),
        "files": files,
    }
    write_new(receipt, result)
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--desired-root", type=Path, required=True)
    parser.add_argument("--render-receipt", type=Path, required=True)
    parser.add_argument("--repository-url", required=True)
    parser.add_argument("--read-url", required=True)
    parser.add_argument("--expected-revision", required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--allow-local-repository", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    try:
        value = publish(
            args.desired_root, args.render_receipt, args.repository_url, args.read_url,
            args.expected_revision, args.receipt, args.allow_local_repository,
        )
    except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError, subprocess.CalledProcessError) as error:
        print(str(error), file=os.sys.stderr)
        return 2
    print(json.dumps({"verdict": "passed", "cell": value["cell"], "revision": value["gitRevision"]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
