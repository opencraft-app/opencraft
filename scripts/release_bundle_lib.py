#!/usr/bin/env python3
"""
Helpers for release bundle metadata shared by CI and GitOps promotion scripts.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


DEFAULT_MANIFEST_PATH = Path("scripts/release-bundles.yaml")


@dataclass(frozen=True)
class ReleaseBundle:
    service: str
    env: str
    owner: str
    source: str
    reason: str
    allowed_paths: list[str]
    exit_condition: str
    dockerfile: str | None
    build_context: str | None
    image_repo: str | None
    publish_paths: list[str]


def parse_manifest_text(text: str) -> dict[str, Any]:
    return yaml.safe_load(text) or {}


def load_manifest(path: Path = DEFAULT_MANIFEST_PATH) -> dict[str, Any]:
    return parse_manifest_text(path.read_text())


def load_bundle(manifest: dict[str, Any], service: str, env: str) -> ReleaseBundle:
    bundles = manifest.get("bundles") or {}
    bundle = bundles.get(service)
    if not bundle:
        raise KeyError(f"unknown release bundle: {service}")

    return ReleaseBundle(
        service=service,
        env=env,
        owner=str(bundle.get("owner", "")),
        source=str(bundle.get("source", "")),
        reason=str(bundle.get("reason", "")),
        allowed_paths=[str(path) for path in (bundle.get("allowed_paths") or [])],
        exit_condition=str(bundle.get("exit_condition", "")),
        dockerfile=_optional_str(bundle.get("dockerfile")),
        build_context=_optional_str(bundle.get("build_context")),
        image_repo=_optional_str((bundle.get("image_repo") or {}).get(env)),
        publish_paths=_resolve_publish_paths(bundle, env),
    )


def require_build_metadata(bundle: ReleaseBundle) -> ReleaseBundle:
    if not bundle.dockerfile or not bundle.build_context or not bundle.image_repo:
        raise ValueError(f"bundle {bundle.service} does not define docker build inputs for env {bundle.env}")
    return bundle


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _resolve_publish_paths(bundle: dict[str, Any], env: str) -> list[str]:
    paths_by_env = bundle.get("publish_paths_by_env") or {}
    raw_paths = paths_by_env[env] if env in paths_by_env else bundle.get("publish_paths")

    resolved: list[str] = []
    seen: set[str] = set()
    for raw in raw_paths or []:
        path = str(raw).format(env=env)
        if path not in seen:
            seen.add(path)
            resolved.append(path)
    return resolved
