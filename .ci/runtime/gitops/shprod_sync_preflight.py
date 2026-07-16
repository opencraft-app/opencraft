"""
Run the post-approval production sync preflight checks.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path


def run_command(command: list[str], **kwargs):
    if not command:
        raise ValueError("command must not be empty")
    if any(not isinstance(part, str) or not part for part in command):
        raise ValueError("command arguments must be non-empty strings")
    return subprocess.run(command, **kwargs)  # nosemgrep: dangerous-subprocess-use-audit


def parse_trailers(message: str) -> dict[str, str]:
    trailers: dict[str, str] = {}
    for raw_line in message.splitlines():
        if ": " not in raw_line:
            continue
        key, value = raw_line.split(": ", 1)
        if key.startswith("Release-") or key == "Source-revision":
            trailers[key] = value.strip()
    return trailers


def git_commit_message(repo_root: Path) -> str:
    result = run_command(
        ["git", "log", "-1", "--format=%B"],
        cwd=repo_root,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"failed to read promote commit message: {result.stderr.strip()}")
    return result.stdout


def require_trailer(trailers: dict[str, str], key: str) -> str:
    value = trailers.get(key, "").strip()
    if not value:
        raise ValueError(f"missing required promote trailer: {key}")
    return value


def ensure_commit_available(repo_root: Path, revision: str) -> None:
    result = run_command(
        ["git", "cat-file", "-e", f"{revision}^{{commit}}"],
        cwd=repo_root,
        capture_output=True,
        text=True,
    )
    if result.returncode == 0:
        return
    fetch = run_command(
        ["git", "fetch", "origin", revision, "--depth=1"],
        cwd=repo_root,
        capture_output=True,
        text=True,
    )
    if fetch.returncode != 0:
        raise RuntimeError(f"failed to fetch source revision {revision}: {fetch.stderr.strip()}")


def export_source_tree(repo_root: Path, revision: str, output_dir: Path) -> None:
    ensure_commit_available(repo_root, revision)
    archive = subprocess.Popen(
        ["git", "archive", "--format=tar", revision],
        cwd=repo_root,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    extract = run_command(
        ["tar", "-xf", "-", "-C", str(output_dir)],
        stdin=archive.stdout,
        capture_output=True,
        text=False,
    )
    if archive.stdout is not None:
        archive.stdout.close()
    archive_stderr = archive.stderr.read() if archive.stderr is not None else b""
    archive_returncode = archive.wait()
    if archive_returncode != 0:
        raise RuntimeError(f"failed to archive source revision {revision}: {archive_stderr.decode().strip()}")
    if extract.returncode != 0:
        raise RuntimeError(f"failed to extract source revision {revision}: {extract.stderr.decode().strip()}")


def build_verify_command(
    *,
    runtime_dir: Path,
    repo_root: Path,
    bundle_manifest: Path,
    service: str,
    env: str,
    apply: bool,
    wait: bool,
    timeout_seconds: int,
) -> list[str]:
    command = [
        sys.executable,
        str(runtime_dir / "commands" / "verify_db_contract.py"),
        "--repo-root",
        str(repo_root),
        "--bundle-manifest",
        str(bundle_manifest),
        "--service",
        service,
        "--env",
        env,
        "--timeout-seconds",
        str(timeout_seconds),
    ]
    if apply:
        command.append("--apply")
    if wait:
        command.append("--wait")
    return command


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run production post-approval DB readiness preflight.")
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--bundle-manifest", default="")
    parser.add_argument("--source-branch", default="")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--wait", action="store_true")
    parser.add_argument("--timeout-seconds", type=int, default=900)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    repo_root = Path(args.repo_root).resolve()
    runtime_dir = Path(__file__).resolve().parents[1]
    bundle_manifest = Path(args.bundle_manifest).resolve() if args.bundle_manifest else runtime_dir / "release-bundles.manifest"

    if args.source_branch and not args.source_branch.startswith(("promote-shprod-", "promote-sgprod-")):
        print(f"skip production sync preflight for non-production branch {args.source_branch}")
        return 0

    trailers = parse_trailers(git_commit_message(repo_root))
    service = require_trailer(trailers, "Release-bundle")
    env = require_trailer(trailers, "Release-target-env")
    if env not in {"shprod", "sgprod"}:
        print(f"skip production sync preflight for env {env}")
        return 0

    argo_sync = require_trailer(trailers, "Release-gate-argo-sync")
    if argo_sync != "manual":
        raise ValueError(f"refuse production sync preflight because Argo sync policy is {argo_sync!r}, expected 'manual'")
    source_revision = require_trailer(trailers, "Source-revision")

    print("============================================================")
    print("生产同步前置校验：人工审批后执行 DB readiness 只读校验")
    print(f"promote 分支：{args.source_branch or '(unknown)'}")
    print(f"发布 bundle：{service}")
    print(f"目标环境：{env}")
    print(f"源码 revision：{source_revision}")
    print("说明：只创建只读 verifier Job；不执行 migration，不执行 Argo sync")
    print("============================================================")

    with tempfile.TemporaryDirectory(prefix=f"{env}-sync-source-") as source_dir:
        source_root = Path(source_dir)
        export_source_tree(repo_root, source_revision, source_root)
        command = build_verify_command(
            runtime_dir=runtime_dir,
            repo_root=source_root,
            bundle_manifest=bundle_manifest,
            service=service,
            env=env,
            apply=args.apply,
            wait=args.wait,
            timeout_seconds=args.timeout_seconds,
        )
        return run_command(command).returncode
