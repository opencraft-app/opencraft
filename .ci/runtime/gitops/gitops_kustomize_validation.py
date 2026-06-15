"""
Strict Kustomize validation for GitOps service source paths.
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from contracts.bundles import playground_catalog_root
from support.yaml import load_mapping


CATALOG_DIR_TEMPLATE = "argocd/catalogs/sandbox/{env}"
SUPPORTED_SANDBOX_ENVS = {"beijing-sandbox", "beijing-sandbox-2"}
SUPPORTED_DIRECT_APP_ENVS = {"shprod", "sgprod", "tkexgz", "tkexsg", "devcloud-dep", "shanghai-workers"}
PLACEHOLDER_RE = re.compile(r"\bREPLACE_[A-Z0-9_]+\b")


@dataclass(frozen=True)
class KustomizeTarget:
    app_name: str
    source_path: str


def load_targets(repo_root: Path, env: str, changed_only: bool = False) -> list[KustomizeTarget]:
    changed_paths = changed_files(repo_root, env) if changed_only else []
    if env in SUPPORTED_DIRECT_APP_ENVS:
        changed_services = changed_direct_app_services_from_paths(changed_paths, env) if changed_only else None
        targets = load_direct_app_targets(repo_root, env, changed_services)
        if changed_only:
            targets = merge_targets(targets, shared_component_targets(repo_root, changed_paths))
        return targets

    if env not in SUPPORTED_SANDBOX_ENVS and not is_playground_env(env):
        raise ValueError(f"unsupported env for strict kustomize validation: {env}")

    changed_services = changed_catalog_services_from_paths(changed_paths, env) if changed_only else None
    targets = load_catalog_targets(repo_root, env, changed_services)
    if changed_only:
        targets = merge_targets(targets, shared_component_targets(repo_root, changed_paths))
    return targets


def load_catalog_targets(repo_root: Path, env: str, service_names: set[str] | None = None) -> list[KustomizeTarget]:
    catalog_dir_rel = catalog_dir_for_env(env)
    catalog_dir = repo_root / catalog_dir_rel
    if not catalog_dir.is_dir():
        raise ValueError(f"missing catalog directory: {catalog_dir_rel}")

    targets: list[KustomizeTarget] = []
    for catalog_file in sorted(catalog_dir.glob("*.yaml")):
        data = load_mapping(catalog_file)
        service = str(data.get("service", "")).strip()
        catalog_env = str(data.get("env", "")).strip()
        source_path = str(data.get("sourcePath", "")).strip()
        if not service or catalog_env != env or not source_path:
            raise ValueError(f"{catalog_file}: missing service/env/sourcePath for {env}")
        if service_names is not None and service not in service_names:
            continue
        if not (repo_root / source_path / "kustomization.yaml").is_file():
            raise ValueError(f"{catalog_file}: missing kustomization.yaml under {source_path}")
        targets.append(KustomizeTarget(app_name=f"{service}-{env}", source_path=source_path))
    if not targets and service_names is None:
        raise ValueError(f"no catalog files found under {catalog_dir_rel}")
    return targets


def is_playground_env(env: str) -> bool:
    return re.fullmatch(r"sandbox-(bj|kr)-\d+", env) is not None


def catalog_dir_for_env(env: str) -> str:
    if is_playground_env(env):
        return f"{playground_catalog_root(env)}/{env}"
    return CATALOG_DIR_TEMPLATE.format(env=env)


def changed_direct_app_services(repo_root: Path, env: str) -> set[str]:
    return changed_direct_app_services_from_paths(changed_files(repo_root, env), env)


def changed_direct_app_services_from_paths(paths: list[str], env: str) -> set[str]:
    services: set[str] = set()
    service_prefix = "argocd/services/"
    app_prefix = f"argocd/apps/{env}/"
    for path in paths:
        if path.startswith(service_prefix):
            parts = path.split("/")
            if len(parts) >= 4 and parts[3] == env:
                services.add(parts[2])
        elif path.startswith(app_prefix) and path.endswith(".yaml"):
            services.add(Path(path).stem)
    return services


def changed_catalog_services(repo_root: Path, env: str) -> set[str]:
    return changed_catalog_services_from_paths(changed_files(repo_root, env), env)


def changed_catalog_services_from_paths(paths: list[str], env: str) -> set[str]:
    services: set[str] = set()
    service_prefix = "argocd/services/"
    catalog_prefix = f"{catalog_dir_for_env(env)}/"
    for path in paths:
        if path.startswith(service_prefix):
            parts = path.split("/")
            if len(parts) >= 4 and (parts[3] == env or parts[3] in {"common", "profiles"}):
                services.add(parts[2])
        elif path.startswith(catalog_prefix) and path.endswith(".yaml"):
            services.add(Path(path).stem)
        else:
            source_service = source_service_for_path(path)
            if source_service:
                services.add(source_service)
    return services


def shared_component_services(paths: list[str]) -> set[str]:
    services: set[str] = set()
    prefix = "argocd/services/"
    for path in paths:
        if not path.startswith(prefix):
            continue
        parts = path.split("/")
        if len(parts) >= 4 and parts[3] in {"common", "profiles"}:
            services.add(parts[2])
    return services


def shared_component_targets(repo_root: Path, paths: list[str]) -> list[KustomizeTarget]:
    targets: list[KustomizeTarget] = []
    for service in sorted(shared_component_services(paths)):
        service_root = repo_root / "argocd" / "services" / service
        if not service_root.is_dir():
            continue
        for kustomization in sorted(service_root.glob("*/kustomization.yaml")):
            env_name = kustomization.parent.name
            if env_name in {"common", "profiles"}:
                continue
            source_path = kustomization.parent.relative_to(repo_root).as_posix()
            targets.append(KustomizeTarget(app_name=f"{service}-{env_name}", source_path=source_path))
    return targets


def merge_targets(primary: list[KustomizeTarget], extra: list[KustomizeTarget]) -> list[KustomizeTarget]:
    merged: dict[str, KustomizeTarget] = {}
    for target in [*primary, *extra]:
        merged[target.source_path] = target
    return [merged[source_path] for source_path in sorted(merged)]


def changed_files(repo_root: Path, env: str) -> list[str]:
    result = subprocess.run(
        ["git", "diff", "--name-only", "HEAD~1..HEAD"],
        cwd=repo_root,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        result = subprocess.run(
            ["git", "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            check=False,
        )
    if result.returncode != 0:
        raise ValueError(f"failed to inspect changed files for {env}: {stderr_summary(result.stderr)}")
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def source_service_for_path(path: str) -> str:
    if path.startswith("user/auth/"):
        return "lightclaw-auth"
    first = path.split("/", 1)[0]
    if first in {
        "admin-gateway",
        "ai-gateway",
        "ctl",
        "frontend",
        "gateway-dashboard",
        "nextgen-dashboard",
        "payment",
        "sandbox",
        "service-gateway",
        "session",
        "subscription",
        "trade",
        "workers",
    }:
        return first
    return ""


def load_direct_app_targets(repo_root: Path, env: str, service_names: set[str] | None = None) -> list[KustomizeTarget]:
    apps_dir_rel = f"argocd/apps/{env}"
    apps_dir = repo_root / apps_dir_rel
    if not apps_dir.is_dir():
        raise ValueError(f"missing apps directory: {apps_dir_rel}")

    targets: list[KustomizeTarget] = []
    for app_file in sorted(apps_dir.glob("*.yaml")):
        data = load_mapping(app_file)
        if data.get("kind") != "Application":
            raise ValueError(f"{app_file}: kind must be Application")
        metadata = data.get("metadata") or {}
        source = (data.get("spec") or {}).get("source") or {}
        source_path = str(source.get("path") or "").strip()
        source_parts = source_path.split("/")
        service_name = source_parts[2] if len(source_parts) >= 4 and source_parts[:2] == ["argocd", "services"] else ""
        if service_names is not None and service_name not in service_names:
            continue
        app_name = str(metadata.get("name") or app_file.stem).strip()
        if not source_path:
            raise ValueError(f"{app_file}: missing spec.source.path")
        if not (repo_root / source_path / "kustomization.yaml").is_file():
            raise ValueError(f"{app_file}: missing kustomization.yaml under {source_path}")
        targets.append(KustomizeTarget(app_name=app_name, source_path=source_path))
    if not targets and service_names is None:
        raise ValueError(f"no Application files found under {apps_dir_rel}")
    return targets


def find_placeholders(rendered: str) -> list[str]:
    return sorted(set(PLACEHOLDER_RE.findall(rendered)))


def stderr_summary(stderr: str, limit: int = 4000) -> str:
    stripped = stderr.strip()
    if len(stripped) <= limit:
        return stripped
    return stripped[-limit:]


def validate_target(repo_root: Path, target: KustomizeTarget, kustomize_bin: str, timeout_seconds: int) -> list[str]:
    command = [
        kustomize_bin,
        "build",
        target.source_path,
        "--enable-alpha-plugins",
        "--enable-exec",
    ]
    result = subprocess.run(
        command,
        cwd=repo_root,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
        check=False,
    )
    if result.returncode != 0:
        return [
            f"{target.app_name} ({target.source_path}) kustomize build failed "
            f"exit={result.returncode}: {stderr_summary(result.stderr)}"
        ]

    try:
        list(yaml.safe_load_all(result.stdout))
    except yaml.YAMLError as exc:
        return [f"{target.app_name} ({target.source_path}) rendered invalid YAML: {exc}"]

    placeholders = find_placeholders(result.stdout)
    if placeholders:
        return [
            f"{target.app_name} ({target.source_path}) rendered unresolved placeholders: "
            f"{', '.join(placeholders[:20])}"
        ]
    return []


def explicit_source_target(source_path: str) -> KustomizeTarget:
    parts = source_path.rstrip("/").split("/")
    app_name = parts[-2] if len(parts) >= 2 else source_path
    return KustomizeTarget(app_name=app_name, source_path=source_path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path("."))
    parser.add_argument("--env", default="beijing-sandbox")
    parser.add_argument(
        "--source-path",
        action="append",
        default=[],
        help="Validate an explicit GitOps source path. Can be passed multiple times.",
    )
    parser.add_argument("--kustomize-bin", default="kustomize")
    parser.add_argument("--timeout-seconds", type=int, default=120)
    parser.add_argument(
        "--changed-only",
        action="store_true",
        help="Validate only apps touched by the current HEAD commit for direct app and catalog environments.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    repo_root = args.repo_root.resolve()
    kustomize_bin = shutil.which(args.kustomize_bin)
    if not kustomize_bin:
        print(f"ERROR: missing kustomize command: {args.kustomize_bin}", file=sys.stderr)
        return 1

    try:
        if args.source_path:
            targets = [explicit_source_target(source_path) for source_path in args.source_path]
        else:
            targets = load_targets(repo_root, args.env, args.changed_only)
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    errors: list[str] = []
    print(f"strict kustomize validation: env={args.env} targets={len(targets)}")
    for target in targets:
        target_errors = validate_target(repo_root, target, kustomize_bin, args.timeout_seconds)
        if target_errors:
            errors.extend(target_errors)
        else:
            print(f"validated {target.app_name}: {target.source_path}")

    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print(f"strict kustomize validation passed: env={args.env} targets={len(targets)}")
    return 0
