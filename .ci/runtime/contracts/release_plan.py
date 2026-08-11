"""
Plan DB-aware release gates for GitOps promotion.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

from contracts.bundles import DEFAULT_MANIFEST_PATH, is_playground_env, load_bundle, load_manifest


PREPROD_AUTO_SYNC_ENVS = {
    "beijing-sandbox",
    "beijing-sandbox-2",
    "devcloud-dep",
    "shanghai-workers",
    "beijing-llmgateway",
}
PROD_MANUAL_SYNC_ENVS = {"shprod", "sgprod"}
DEPENDENCY_CHANGE_IGNORED_BASENAMES = {".ci-trigger"}


@dataclass(frozen=True)
class GatePlan:
    service: str
    env: str
    pin_targets: list[str]
    source_sha: str
    db_mode: str
    migration_changed: bool
    requires_db_job: bool
    requires_db_readiness: bool
    readiness_supported: bool
    db_job_service: str
    db_job_operation: str
    db_job_image_override: str
    release_dependency_changed: bool
    release_dependencies: list[str]
    auto_merge_allowed: bool
    auto_sync_allowed: bool
    argo_sync: str
    db_status: str
    manual_actions: list[str]
    changed_files: list[str]

    def to_dict(self) -> dict[str, Any]:
        return {
            "service": self.service,
            "env": self.env,
            "pin_targets": self.pin_targets,
            "source_sha": self.source_sha,
            "db_mode": self.db_mode,
            "migration_changed": self.migration_changed,
            "requires_db_job": self.requires_db_job,
            "requires_db_readiness": self.requires_db_readiness,
            "readiness_supported": self.readiness_supported,
            "db_job_service": self.db_job_service,
            "db_job_operation": self.db_job_operation,
            "db_job_image_override": self.db_job_image_override,
            "release_dependency_changed": self.release_dependency_changed,
            "release_dependencies": self.release_dependencies,
            "auto_merge_allowed": self.auto_merge_allowed,
            "auto_sync_allowed": self.auto_sync_allowed,
            "argo_sync": self.argo_sync,
            "db_status": self.db_status,
            "manual_actions": self.manual_actions,
            "changed_files": self.changed_files,
        }


def changed_files_for_revision(repo_root: Path, source_sha: str) -> list[str]:
    if not source_sha:
        return []
    result = subprocess.run(
        ["git", "diff-tree", "--root", "--no-commit-id", "--name-only", "-r", source_sha],
        cwd=repo_root,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"failed to inspect changed files for {source_sha}: {result.stderr.strip()}")
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def path_matches_any(path: str, patterns: Sequence[str]) -> bool:
    return any(fnmatch.fnmatch(path, pattern) or path.startswith(pattern.removesuffix("/**")) for pattern in patterns)


def resolve_image_override(image: str, image_key: str) -> str:
    if not image_key:
        return image if not image.lstrip().startswith("{") else ""
    try:
        payload = json.loads(image)
    except json.JSONDecodeError:
        return ""
    images = payload.get("images") or {}
    return str(images.get(image_key) or "")


def dependency_changed(manifest: dict[str, Any], dependencies: Sequence[str], changed_files: Sequence[str]) -> bool:
    bundles = manifest.get("bundles") or {}
    prefixes: list[str] = []
    for dependency in dependencies:
        bundle = bundles.get(dependency) or {}
        for key in ("owner", "source"):
            prefix = str(bundle.get(key) or "").strip().strip("/")
            if prefix:
                prefixes.append(prefix + "/")
    if not prefixes:
        return False
    return any(
        path.startswith(tuple(prefixes)) and Path(path).name not in DEPENDENCY_CHANGE_IGNORED_BASENAMES
        for path in changed_files
    )


def release_dependencies_for_env(manifest: dict[str, Any], service: str, env: str) -> list[str]:
    bundle = (manifest.get("bundles") or {}).get(service, {})
    dependencies_by_env = bundle.get("release_dependencies_by_env") or {}
    if isinstance(dependencies_by_env, dict):
        override = _env_mapping_value(dependencies_by_env, env)
        if override is not None:
            return [str(item) for item in (override or [])]
    return [str(item) for item in (bundle.get("release_dependencies") or [])]


def _env_mapping_value(mapping: dict[str, Any], env: str) -> Any:
    if env in mapping:
        return mapping[env]
    for key, value in mapping.items():
        key_text = str(key)
        if key_text.endswith("*") and env.startswith(key_text[:-1]):
            return value
    return None


def plan_release_gates(
    *,
    repo_root: Path,
    bundle_manifest: Path,
    service: str,
    env: str,
    source_sha: str,
    image: str,
    pin_targets: str,
    db_status: str = "unknown",
) -> GatePlan:
    manifest = load_manifest(bundle_manifest)
    bundle = load_bundle(manifest, service, env)
    contract = bundle.db_contract
    db_mode = str(contract.get("mode") or "none")
    changed_files = changed_files_for_revision(repo_root, source_sha)
    migration_paths = [str(path) for path in (contract.get("migration_paths") or [])]
    migration_changed = db_mode == "migration" and any(path_matches_any(path, migration_paths) for path in changed_files)
    has_verifier = bool(contract.get("verifier"))
    readiness_declared_unsupported = contract.get("readiness_supported") is False
    readiness_supported = bool(contract.get("readiness_supported", True)) and has_verifier
    requires_db_job = db_mode == "migration" and bool(contract.get("migration_operation"))
    requires_db_readiness = db_mode == "migration" and (has_verifier or readiness_declared_unsupported)
    db_job_service = str(contract.get("db_job_service") or service)
    db_job_operation = str(contract.get("migration_operation") or "")
    db_job_image_override = resolve_image_override(image, str(contract.get("migration_image_key") or ""))
    dependencies = release_dependencies_for_env(manifest, service, env)
    release_dependency_changed = dependency_changed(manifest, dependencies, changed_files)

    argo_sync = "manual" if is_manual_sync_env(env) else "auto" if is_preprod_auto_sync_env(env) else "manual"
    db_gate_satisfied = not requires_db_readiness or (readiness_supported and db_status == "passed")
    dependency_gate_satisfied = not release_dependency_changed
    gate_satisfied = db_gate_satisfied and dependency_gate_satisfied
    auto_sync_allowed = argo_sync == "auto" and gate_satisfied
    auto_merge_allowed = gate_satisfied

    manual_actions: list[str] = []
    pin_target_list = [item.strip() for item in pin_targets.split(",") if item.strip()]
    if dependencies:
        manual_actions.append(
            f"确认依赖服务已发布并就绪后再同步当前服务：{', '.join(dependencies)}"
        )
    if release_dependency_changed:
        manual_actions.append(
            "检测到同批依赖服务变更；请等待依赖服务流水线完成并确认环境收敛后，再重试当前服务发布。"
        )
    if requires_db_job and db_status != "passed":
        command = (
            "python3 .ci/runtime/commands/run_gitops_db_job.py "
            f"--service {db_job_service} --operation {db_job_operation} --env {env} --revision {source_sha} --apply --wait"
        )
        if db_job_image_override:
            command += f" --image-override {db_job_image_override}"
        manual_actions.append(command)
    if requires_db_readiness and db_status != "passed":
        if readiness_supported:
            manual_actions.append(
                f"python3 .ci/runtime/commands/verify_db_contract.py --service {service} --env {env} --apply --wait"
            )
        else:
            manual_actions.append(f"manual DB readiness confirmation required for {service}/{env}")
    if is_manual_sync_env(env):
        manual_actions.append("manual Argo sync required after GitOps MR merge")
    if service == "sandbox" and requires_db_readiness and db_status != "passed":
        manual_actions.append(
            "sandbox default pools are operational data; run ENV=<env> bash sandbox/scripts/sync-default-pools.sh --base-image <img-id> if baseline check fails"
        )

    return GatePlan(
        service=service,
        env=env,
        pin_targets=pin_target_list,
        source_sha=source_sha,
        db_mode=db_mode,
        migration_changed=migration_changed,
        requires_db_job=requires_db_job,
        requires_db_readiness=requires_db_readiness,
        readiness_supported=readiness_supported,
        db_job_service=db_job_service,
        db_job_operation=db_job_operation,
        db_job_image_override=db_job_image_override,
        release_dependency_changed=release_dependency_changed,
        release_dependencies=dependencies,
        auto_merge_allowed=auto_merge_allowed,
        auto_sync_allowed=auto_sync_allowed,
        argo_sync=argo_sync,
        db_status=db_status,
        manual_actions=manual_actions,
        changed_files=changed_files,
    )


def is_preprod_auto_sync_env(env: str) -> bool:
    return env in PREPROD_AUTO_SYNC_ENVS or is_playground_env(env)


def is_manual_sync_env(env: str) -> bool:
    return env in PROD_MANUAL_SYNC_ENVS or re.fullmatch(r"sandbox-jp-\d+", env) is not None


def emit_dotenv(plan: GatePlan) -> str:
    payload = plan.to_dict()
    lines = []
    for key, value in payload.items():
        env_key = f"GATE_{key.upper()}"
        if isinstance(value, bool):
            encoded = "true" if value else "false"
        elif isinstance(value, (list, dict)):
            encoded = json.dumps(value, ensure_ascii=False)
        else:
            encoded = str(value)
        lines.append(f"{env_key}={shell_quote(encoded)}")
    return "\n".join(lines)


def shell_quote(value: str) -> str:
    return "'" + value.replace("'", "'\"'\"'") + "'"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Plan DB-aware GitOps release gates.")
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--bundle-manifest", default=str(DEFAULT_MANIFEST_PATH))
    parser.add_argument("--service", required=True)
    parser.add_argument("--env", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--pin-targets", required=True)
    parser.add_argument("--db-status", default="unknown", choices=("unknown", "passed", "failed", "not-required"))
    parser.add_argument("--format", choices=("json", "dotenv"), default="json")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    plan = plan_release_gates(
        repo_root=Path(args.repo_root).resolve(),
        bundle_manifest=Path(args.bundle_manifest).resolve(),
        service=args.service,
        env=args.env,
        source_sha=args.source_sha,
        image=args.image,
        pin_targets=args.pin_targets,
        db_status=args.db_status,
    )
    if args.format == "dotenv":
        print(emit_dotenv(plan))
    else:
        print(json.dumps(plan.to_dict(), ensure_ascii=False, indent=2))
    return 0
