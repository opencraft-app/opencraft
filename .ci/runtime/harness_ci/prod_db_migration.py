"""
Run a production DB migration plan with an explicit source revision and GitOps deploy root.

The command is intentionally CI-facing: it first renders the one-off migration and
readiness jobs, and only applies them when the caller has passed the manual approval
stage and sets --apply.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
RUNTIME_COMMAND_DIR = REPO_ROOT / ".ci" / "runtime" / "commands"


def resolve_python_bin() -> str:
    candidates = [
        os.environ.get("PYTHON_BIN", "").strip(),
        sys.executable,
        shutil.which("python3") or "",
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
        "/usr/bin/python3",
    ]
    seen: set[str] = set()
    for candidate in candidates:
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        result = subprocess.run(
            [candidate, "-c", "import yaml"],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode == 0:
            return candidate
    return sys.executable


PYTHON_BIN = resolve_python_bin()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run production DB migration dry-run/apply flow.")
    parser.add_argument("--service", required=True)
    parser.add_argument("--env", required=True, choices=("shprod", "sgprod"))
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--timeout-seconds", type=int, default=1800)
    parser.add_argument("--apply", action="store_true")
    return parser.parse_args()


def run(command: list[str], *, cwd: Path = REPO_ROOT, capture: bool = False) -> str:
    printable = " ".join(shlex.quote(part) for part in command)
    print(f"+ {printable}", flush=True)
    result = subprocess.run(
        command,
        cwd=cwd,
        capture_output=capture,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        stdout = result.stdout if capture else ""
        stderr = result.stderr if capture else ""
        raise RuntimeError(f"command failed: {printable}\nstdout:\n{stdout}\nstderr:\n{stderr}")
    return result.stdout.strip() if capture else ""


def map_service(service: str) -> tuple[str, str]:
    if service in {"payment", "subscription", "ai-gateway", "ctl", "sandbox"}:
        return service, service
    if service in {"user-auth", "lightclaw-auth"}:
        return "user-auth", "lightclaw-auth"
    raise ValueError(
        "SERVICE must be one of: payment, subscription, user-auth, "
        f"lightclaw-auth, ai-gateway, ctl, sandbox; got: {service}"
    )


def resolve_source_sha(source_sha: str) -> str:
    if not source_sha.strip():
        raise ValueError("SOURCE_SHA is required. Use the commit SHA that produced the image you want to migrate.")
    run(["git", "fetch", "--no-tags", "origin", "master", "gitops"])
    return run(["git", "rev-parse", f"{source_sha}^{{commit}}"], capture=True)


def dotenv(command_output: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in command_output.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#") or "=" not in raw:
            continue
        key, value = raw.split("=", 1)
        values[key] = shlex.split(value)[0] if value else ""
    return values


def resolve_release_metadata(bundle_service: str, env: str, tag: str) -> dict[str, str]:
    output = run(
        [
            PYTHON_BIN,
            str(RUNTIME_COMMAND_DIR / "resolve_release_bundle.py"),
            "--service",
            bundle_service,
            "--env",
            env,
            "--tag",
            tag,
            "--format",
            "dotenv",
        ],
        capture=True,
    )
    return dotenv(output)


def resolve_image_override(bundle_service: str, metadata: dict[str, str]) -> str:
    if bundle_service != "sandbox":
        return metadata["BUILD_IMAGE"]
    return json.loads(metadata["BUILD_IMAGES_JSON"])["images"]["SANDBOX_MIGRATE_IMAGE"]


def add_worktree(path: Path, ref: str) -> None:
    run(["git", "worktree", "add", "--detach", str(path), ref])


def remove_worktree(path: Path) -> None:
    subprocess.run(["git", "worktree", "remove", "--force", str(path)], cwd=REPO_ROOT, check=False)


def project_gitops(bundle_service: str, env: str, source_sha: str, gitops_dir: Path) -> None:
    run(["git", "fetch", "--no-tags", "origin", "gitops:refs/remotes/origin/gitops"])
    add_worktree(gitops_dir, "origin/gitops")
    run(
        [
            PYTHON_BIN,
            str(RUNTIME_COMMAND_DIR / "project_release_bundle.py"),
            "--repo-root",
            str(gitops_dir),
            "--service",
            bundle_service,
            "--env",
            env,
            "--source-ref",
            source_sha,
        ]
    )


def print_plan(
    *,
    db_job_service: str,
    bundle_service: str,
    env: str,
    source_sha: str,
    tag: str,
    image: str,
    apply: bool,
) -> None:
    action = "APPLY: 将创建并等待一次性 migration Job，然后执行 readiness Job" if apply else "DRY-RUN: 只渲染将执行的 migration/readiness Job，不创建集群资源"
    print("=" * 60, flush=True)
    print("生产 DB migration 执行计划", flush=True)
    print(f"action={action}", flush=True)
    print(f"service={db_job_service}", flush=True)
    print(f"bundle={bundle_service}", flush=True)
    print(f"env={env}", flush=True)
    print(f"source_sha={source_sha}", flush=True)
    print(f"tag={tag}", flush=True)
    print(f"image={image}", flush=True)
    print("gitops_source=origin/gitops with SOURCE_SHA bundle projection", flush=True)
    print("说明：SOURCE_SHA 提供 migration 源码和镜像 tag；GitOps 投影后的 worktree 提供生产配置和密钥。", flush=True)
    print("=" * 60, flush=True)


def run_db_jobs(
    *,
    source_dir: Path,
    gitops_dir: Path,
    db_job_service: str,
    bundle_service: str,
    env: str,
    source_sha: str,
    image: str,
    timeout_seconds: int,
    apply: bool,
) -> None:
    db_job_args = [
        PYTHON_BIN,
        str(RUNTIME_COMMAND_DIR / "run_gitops_db_job.py"),
        "--repo-root",
        str(source_dir),
        "--deploy-root",
        str(gitops_dir),
        "--service",
        db_job_service,
        "--operation",
        "migration",
        "--env",
        env,
        "--revision",
        source_sha,
        "--bundle-service",
        bundle_service,
        "--bundle-manifest",
        str(REPO_ROOT / ".ci" / "runtime" / "release-bundles.manifest"),
        "--timeout-seconds",
        str(timeout_seconds),
        "--kubectl-retries",
        "2",
        "--output-json",
        "db-migration-job.json",
        "--image-override",
        image,
    ]
    verify_args = [
        PYTHON_BIN,
        str(RUNTIME_COMMAND_DIR / "verify_db_contract.py"),
        "--repo-root",
        str(source_dir),
        "--deploy-root",
        str(gitops_dir),
        "--service",
        bundle_service,
        "--env",
        env,
        "--bundle-manifest",
        str(REPO_ROOT / ".ci" / "runtime" / "release-bundles.manifest"),
        "--timeout-seconds",
        str(timeout_seconds),
        "--output-json",
        "db-readiness.json",
    ]
    if apply:
        db_job_args.extend(["--apply", "--wait"])
        verify_args.extend(["--apply", "--wait"])

    run(db_job_args)
    run(verify_args)
    for path in ("db-migration-job.json", "db-readiness.json"):
        print(f"{path}:")
        print(Path(path).read_text())


def main() -> int:
    args = parse_args()
    bundle_service, db_job_service = map_service(args.service)
    source_sha = resolve_source_sha(args.source_sha)
    short_sha = source_sha[:12]
    tag = f"{bundle_service}-{short_sha}"
    metadata = resolve_release_metadata(bundle_service, args.env, tag)
    image = resolve_image_override(bundle_service, metadata)

    with tempfile.TemporaryDirectory(prefix="prod-db-source-") as source_tmp, tempfile.TemporaryDirectory(
        prefix="prod-db-gitops-"
    ) as gitops_tmp:
        source_dir = Path(source_tmp)
        gitops_dir = Path(gitops_tmp)
        source_dir.rmdir()
        gitops_dir.rmdir()
        try:
            add_worktree(source_dir, source_sha)
            project_gitops(bundle_service, args.env, source_sha, gitops_dir)
            print_plan(
                db_job_service=db_job_service,
                bundle_service=bundle_service,
                env=args.env,
                source_sha=source_sha,
                tag=tag,
                image=image,
                apply=args.apply,
            )
            run_db_jobs(
                source_dir=source_dir,
                gitops_dir=gitops_dir,
                db_job_service=db_job_service,
                bundle_service=bundle_service,
                env=args.env,
                source_sha=source_sha,
                image=image,
                timeout_seconds=args.timeout_seconds,
                apply=args.apply,
            )
        finally:
            remove_worktree(source_dir)
            remove_worktree(gitops_dir)

    if args.apply:
        print("production DB migration completed; continue with GitOps promote/sync after review.")
    else:
        print("production DB migration dry-run completed; approve the next CI stage to execute.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
