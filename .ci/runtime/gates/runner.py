"""Unified release gate runner."""

from __future__ import annotations

import argparse
import concurrent.futures
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from gates.config import run_config_gate
from gates.db import run_db_gate
from gates.image import run_image_gate
from gates.result import ReleaseGateResult


BOOTSTRAP_FILES = (".ci/gitops-promotion.yml",)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run image/config/db release gates.")
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--runtime-command-dir", required=True)
    parser.add_argument("--bundle-service", required=True)
    parser.add_argument("--pin-targets", required=True)
    parser.add_argument("--env", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--source-ref", required=True)
    parser.add_argument("--deployed-at", required=True)
    parser.add_argument("--remote-name", default="origin")
    parser.add_argument("--gitops-branch", default="gitops")
    parser.add_argument("--format", choices=("dotenv",), default="dotenv")
    return parser


class GateTempResources:
    def __init__(self, repo_root: Path) -> None:
        self.repo_root = repo_root
        self.temp_root: tempfile.TemporaryDirectory[str] | None = None
        self.worktree: Path | None = None

    def __enter__(self) -> "GateTempResources":
        self.temp_root = tempfile.TemporaryDirectory()
        self.worktree = Path(self.temp_root.name) / "gitops-config-gate"
        return self

    def __exit__(self, *_exc_info: object) -> None:
        if self.worktree is not None:
            subprocess.run(
                ["git", "-C", str(self.repo_root), "worktree", "remove", "--force", str(self.worktree)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
            if self.worktree.exists():
                shutil.rmtree(self.worktree, ignore_errors=True)
        if self.temp_root is not None:
            self.temp_root.cleanup()


def run(args: argparse.Namespace) -> ReleaseGateResult:
    repo_root = Path(args.repo_root).resolve()
    runtime_command_dir = Path(args.runtime_command_dir).resolve()
    runtime_dir = runtime_command_dir.parent
    bundle_manifest = runtime_dir / "release-bundles.manifest"

    image_gate = run_image_gate(
        repo_root=repo_root,
        runtime_command_dir=runtime_command_dir,
        env=args.env,
        image=args.image,
    )

    with GateTempResources(repo_root) as resources:
        assert resources.worktree is not None
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            config_future = executor.submit(
                run_config_gate,
                repo_root=repo_root,
                worktree=resources.worktree,
                runtime_dir=runtime_dir,
                runtime_command_dir=runtime_command_dir,
                remote_name=args.remote_name,
                gitops_branch=args.gitops_branch,
                bundle_service=args.bundle_service,
                pin_targets=args.pin_targets,
                env=args.env,
                image=image_gate.pin_payload,
                source_ref=args.source_ref,
                deployed_at=args.deployed_at,
                bootstrap_files=list(BOOTSTRAP_FILES),
            )
            db_future = executor.submit(
                run_db_gate,
                repo_root=repo_root,
                runtime_command_dir=runtime_command_dir,
                bundle_manifest=bundle_manifest,
                service=args.bundle_service,
                env=args.env,
                source_ref=args.source_ref,
                image=image_gate.pin_payload,
                pin_targets=args.pin_targets,
            )
            config_status = config_future.result()
            db_status, plan = db_future.result()

    return ReleaseGateResult(
        image_status=image_gate.status,
        image_pin_payload=image_gate.pin_payload,
        image_digests_json=image_gate.digests_json,
        config_status=config_status,
        db_status=db_status,
        requires_db_readiness=plan.requires_db_readiness,
        auto_merge_allowed=plan.auto_merge_allowed,
        auto_sync_allowed=plan.auto_sync_allowed,
        argo_sync=plan.argo_sync,
        release_dependency_changed=plan.release_dependency_changed,
        manual_actions=plan.manual_actions,
    )


def main() -> int:
    args = build_parser().parse_args()
    try:
        result = run(args)
    except Exception as exc:  # noqa: BLE001
        print(str(exc), file=sys.stderr)
        return 1

    print(result.to_dotenv())
    return 0
