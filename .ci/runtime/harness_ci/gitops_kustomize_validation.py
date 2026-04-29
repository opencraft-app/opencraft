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


CATALOG_DIR_REL = "argocd/catalogs/sandbox/beijing-sandbox"
PLACEHOLDER_RE = re.compile(r"\bREPLACE_[A-Z0-9_]+\b")


@dataclass(frozen=True)
class KustomizeTarget:
    app_name: str
    source_path: str


def load_yaml(path: Path) -> dict[str, Any]:
    payload = yaml.safe_load(path.read_text()) or {}
    if not isinstance(payload, dict):
        raise ValueError(f"{path} must contain a YAML mapping")
    return payload


def load_targets(repo_root: Path, env: str) -> list[KustomizeTarget]:
    if env != "beijing-sandbox":
        raise ValueError(f"unsupported env for strict kustomize validation: {env}")

    catalog_dir = repo_root / CATALOG_DIR_REL
    if not catalog_dir.is_dir():
        raise ValueError(f"missing catalog directory: {CATALOG_DIR_REL}")

    targets: list[KustomizeTarget] = []
    for catalog_file in sorted(catalog_dir.glob("*.yaml")):
        data = load_yaml(catalog_file)
        service = str(data.get("service", "")).strip()
        catalog_env = str(data.get("env", "")).strip()
        source_path = str(data.get("sourcePath", "")).strip()
        if not service or catalog_env != env or not source_path:
            raise ValueError(f"{catalog_file}: missing service/env/sourcePath for {env}")
        if not (repo_root / source_path / "kustomization.yaml").is_file():
            raise ValueError(f"{catalog_file}: missing kustomization.yaml under {source_path}")
        targets.append(KustomizeTarget(app_name=f"{service}-{env}", source_path=source_path))
    if not targets:
        raise ValueError(f"no catalog files found under {CATALOG_DIR_REL}")
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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path("."))
    parser.add_argument("--env", default="beijing-sandbox")
    parser.add_argument("--kustomize-bin", default="kustomize")
    parser.add_argument("--timeout-seconds", type=int, default=120)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    repo_root = args.repo_root.resolve()
    kustomize_bin = shutil.which(args.kustomize_bin)
    if not kustomize_bin:
        print(f"ERROR: missing kustomize command: {args.kustomize_bin}", file=sys.stderr)
        return 1

    try:
        targets = load_targets(repo_root, args.env)
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
