"""Config release gate execution against a temporary GitOps worktree."""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
from pathlib import Path

import yaml

from contracts.bundles import load_manifest
from support.logging import print_section
from support.process import run_logged, validate_command


def validate_activation_inputs(repo_root: Path, bundle_manifest: Path, pin_targets: str, env: str) -> None:
    if not bundle_manifest.is_file() and not (bundle_manifest.parent / "bundles").is_dir():
        return
    bundles = load_manifest(bundle_manifest).get("bundles") or {}
    for service in (item.strip() for item in pin_targets.split(",") if item.strip()):
        contract = (bundles.get(service) or {}).get("config_contract") or {}
        if not isinstance(contract, dict):
            continue
        required_files = contract.get("required_files") or []
        if not isinstance(required_files, list) or not all(isinstance(path, str) for path in required_files):
            raise ValueError("config_contract.required_files must be a list of repository paths")
        platform = contract.get("platform_env") or {}
        if not isinstance(platform, dict):
            raise ValueError("config_contract.platform_env must be a mapping")
        platform_path = str(platform.get("path") or "")
        catalog = contract.get("active_catalog") or {}
        if not isinstance(catalog, dict):
            raise ValueError("config_contract.active_catalog must be a mapping")
        catalog_path = str(catalog.get("path") or "")
        for template in [*required_files, *([platform_path] if platform_path else []),
                         *([catalog_path] if catalog_path else [])]:
            path = Path(template.format(env=env))
            if path.is_absolute() or ".." in path.parts:
                raise ValueError("activation inputs must stay within the repository")
            if not (repo_root / path).is_file():
                raise FileNotFoundError(f"missing required activation input: {path}")
        if catalog_path:
            descriptor = yaml.safe_load((repo_root / catalog_path.format(env=env)).read_text()) or {}
            expected_source = str(catalog.get("source_path") or "").format(env=env)
            if not expected_source or not isinstance(descriptor, dict) or descriptor.get("sourcePath") != expected_source:
                raise ValueError("runtime catalog sourcePath does not match the release target")
        if not platform_path:
            continue
        values = {}
        for raw in (repo_root / platform_path.format(env=env)).read_text().splitlines():
            if raw.strip() and not raw.lstrip().startswith("#") and "=" in raw:
                key, value = raw.split("=", 1)
                values[key.strip()] = value.strip()
        for rule in ("required_keys", "positive_int_keys"):
            keys = platform.get(rule) or []
            if not isinstance(keys, list) or not all(isinstance(key, str) for key in keys):
                raise ValueError(f"config_contract.platform_env.{rule} must be a list of keys")
            for key in keys:
                value = values.get(key, "")
                if not value or "REPLACE_" in value or (rule == "positive_int_keys" and (
                    not re.fullmatch(r"[0-9]+", value) or int(value) <= 0
                )):
                    raise ValueError(f"invalid platform input: {key}")


def run_config_gate(
    *,
    repo_root: Path,
    worktree: Path,
    runtime_dir: Path,
    runtime_repo_root: Path,
    runtime_command_dir: Path,
    remote_name: str,
    gitops_branch: str,
    bundle_service: str,
    pin_targets: str,
    env: str,
    image: str,
    source_ref: str,
    deployed_at: str,
    bootstrap_files: list[str],
) -> str:
    prepare_worktree(
        repo_root=repo_root,
        worktree=worktree,
        runtime_dir=runtime_dir,
        remote_name=remote_name,
        gitops_branch=gitops_branch,
        bootstrap_files=bootstrap_files,
    )
    project_and_pin(
        repo_root=worktree,
        runtime_command_dir=worktree / ".ci/runtime/commands",
        bundle_service=bundle_service,
        pin_targets=pin_targets,
        env=env,
        image=image,
        source_ref=source_ref,
        deployed_at=deployed_at,
    )
    validate_config(
        repo_root=worktree,
        init_repo_root=runtime_repo_root,
        runtime_command_dir=runtime_command_dir,
        bundle_manifest=worktree / ".ci/runtime/release-bundles.manifest",
        pin_targets=pin_targets,
        env=env,
    )
    return "passed"


def prepare_worktree(
    *,
    repo_root: Path,
    worktree: Path,
    runtime_dir: Path,
    remote_name: str,
    gitops_branch: str,
    bootstrap_files: list[str],
) -> None:
    if worktree.exists():
        shutil.rmtree(worktree)
    run_quiet(
        ["git", "-C", str(repo_root), "worktree", "add", "--detach", str(worktree), f"{remote_name}/{gitops_branch}"],
        check=True,
        stdout=subprocess.DEVNULL,
    )
    for bootstrap_file in bootstrap_files:
        destination = worktree / bootstrap_file
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(repo_root / bootstrap_file, destination)
    runtime_destination = worktree / ".ci/runtime"
    runtime_destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(runtime_dir, runtime_destination, dirs_exist_ok=True)
    run_quiet(
        [
            "python3",
            str(runtime_destination / "commands/generate_release_bundle_manifest.py"),
            "--output",
            str(runtime_destination / "release-bundles.manifest"),
        ],
        cwd=worktree,
        stdout=subprocess.DEVNULL,
        check=True,
    )


def run_quiet(command: list[str], **kwargs: object) -> None:
    validate_command(command)
    subprocess.run(command, **kwargs)  # nosemgrep: dangerous-subprocess-use-audit


def project_and_pin(
    *,
    repo_root: Path,
    runtime_command_dir: Path,
    bundle_service: str,
    pin_targets: str,
    env: str,
    image: str,
    source_ref: str,
    deployed_at: str,
) -> None:
    run_logged(
        [
            "python3",
            str(runtime_command_dir / "project_release_bundle.py"),
            "--repo-root",
            str(repo_root),
            "--service",
            bundle_service,
            "--env",
            env,
            "--source-ref",
            source_ref,
        ],
        cwd=repo_root,
    )
    for service in [item.strip() for item in pin_targets.split(",") if item.strip()]:
        print(f"GitOps 发布进度：预校验 {service}/{env} 的镜像 pin", file=sys.stderr)
        run_logged(
            [
                "python3",
                str(runtime_command_dir / "update_image_pin.py"),
                "--repo-root",
                str(repo_root),
                "--service",
                service,
                "--env",
                env,
                "--image",
                image,
                "--deployed-at",
                deployed_at,
            ],
            cwd=repo_root,
        )


def validate_config(
    *,
    repo_root: Path,
    init_repo_root: Path,
    runtime_command_dir: Path,
    bundle_manifest: Path,
    pin_targets: str,
    env: str,
) -> None:
    validate_activation_inputs(repo_root, bundle_manifest, pin_targets, env)
    print_section(
        "GitOps 发布门禁：校验配置契约",
        [
            f"目标环境：{env}",
            f"目标服务：{pin_targets}",
            "检查内容：GitOps 静态结构、服务级 Kustomize 渲染、未替换占位符",
            "说明：配置和镜像 pin 同属 desired state；配置契约失败时不会创建 promote MR。",
        ],
    )

    script = (
        "set -euo pipefail\n"
        'source "$1/.ci/init.sh"\n'
        'ci_require_gitops_validation_tools\n'
        'ci_prepare_sops_age_key\n'
        'trap ci_cleanup_sops_age_key EXIT\n'
        'python3 "$2/validate_gitops_static.py" --repo-root "$3" --env "$4" --bundle-manifest "$5"\n'
    )
    run_logged(
        ["bash", "-c", script, "bash", str(init_repo_root), str(runtime_command_dir), str(repo_root), env, str(bundle_manifest)],
        cwd=repo_root,
    )
    for service in [item.strip() for item in pin_targets.split(",") if item.strip()]:
        source_path = f"argocd/services/{service}/{env}"
        if not (repo_root / source_path / "kustomization.yaml").is_file():
            raise FileNotFoundError(f"配置契约失败：缺少 {source_path}/kustomization.yaml")
        kustomize_script = (
            "set -euo pipefail\n"
            'source "$1/.ci/init.sh"\n'
            'ci_require_gitops_validation_tools\n'
            'ci_prepare_sops_age_key\n'
            'trap ci_cleanup_sops_age_key EXIT\n'
            'python3 "$2/validate_gitops_kustomize.py" --repo-root "$3" --env "$4" --source-path "$5"\n'
        )
        run_logged(
            [
                "bash",
                "-c",
                kustomize_script,
                "bash",
                str(init_repo_root),
                str(runtime_command_dir),
                str(repo_root),
                env,
                source_path,
            ],
            cwd=repo_root,
        )

    print_section("GitOps 发布门禁：配置契约校验通过")
