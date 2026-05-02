"""
Release bundle metadata shared by CI and GitOps promotion commands.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


RUNTIME_DIR = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST_PATH = RUNTIME_DIR / "release-bundles.manifest"


@dataclass(frozen=True)
class ImageTarget:
    name: str
    image_key: str | None
    dockerfile: str
    build_context: str
    image_repo: str


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
    image_targets: list[ImageTarget]
    config_contract: dict[str, Any]
    db_contract: dict[str, Any]


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
        image_targets=_resolve_image_targets(bundle, env),
        config_contract=_resolve_config_contract(bundle),
        db_contract=_resolve_db_contract(bundle),
    )


def require_build_metadata(bundle: ReleaseBundle) -> ReleaseBundle:
    if bundle.image_targets:
        return bundle
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


def _resolve_image_targets(bundle: dict[str, Any], env: str) -> list[ImageTarget]:
    raw_targets = bundle.get("image_targets") or []
    targets: list[ImageTarget] = []
    for raw in raw_targets:
        if not isinstance(raw, dict):
            raise ValueError("image_targets entries must be YAML mappings")

        raw_image_repo = raw.get("image_repo") or {}
        if not isinstance(raw_image_repo, dict):
            raise ValueError("image target image_repo must be a YAML mapping")
        if env not in raw_image_repo:
            continue

        name = str(raw.get("name") or raw.get("image_key") or raw.get("dockerfile") or "")
        image_key = _optional_str(raw.get("image_key"))
        image_repo = _optional_str(raw_image_repo.get(env))
        dockerfile = _optional_str(raw.get("dockerfile"))
        build_context = _optional_str(raw.get("build_context"))
        if not image_repo or not dockerfile or not build_context or not image_key:
            raise ValueError(
                f"image target {name or '<unnamed>'} does not define image_key, dockerfile, "
                f"build_context, and image_repo for env {env}"
            )
        targets.append(
            ImageTarget(
                name=name,
                image_key=image_key,
                dockerfile=dockerfile,
                build_context=build_context,
                image_repo=image_repo,
            )
        )
    return targets


def _resolve_db_contract(bundle: dict[str, Any]) -> dict[str, Any]:
    raw = bundle.get("db_contract")
    if raw is None:
        return {"mode": "none"}
    if isinstance(raw, str):
        return {"mode": raw}
    if not isinstance(raw, dict):
        raise ValueError("db_contract must be a string or YAML mapping")
    contract = dict(raw)
    contract["mode"] = str(contract.get("mode") or "none")
    return contract


def _resolve_config_contract(bundle: dict[str, Any]) -> dict[str, Any]:
    raw = bundle.get("config_contract")
    if raw is None:
        return {
            "mode": "gitops",
            "static_validation": True,
            "kustomize": True,
            "placeholder_scan": True,
            "requires_mr": True,
        }
    if isinstance(raw, str):
        return {"mode": raw}
    if not isinstance(raw, dict):
        raise ValueError("config_contract must be a string or YAML mapping")
    contract = dict(raw)
    contract["mode"] = str(contract.get("mode") or "gitops")
    contract.setdefault("static_validation", True)
    contract.setdefault("kustomize", True)
    contract.setdefault("placeholder_scan", True)
    contract.setdefault("requires_mr", True)
    return contract
