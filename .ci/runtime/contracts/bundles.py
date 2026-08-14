"""
Release bundle metadata shared by CI and GitOps promotion commands.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re
from typing import Any

import yaml


RUNTIME_DIR = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST_PATH = RUNTIME_DIR / "release-bundles.manifest"
PLAYGROUND_ENV_RE = re.compile(r"^sandbox-(?:bj|kr|jp)-\d+$")
PLAYGROUND_TEMPLATE_ENVS = ("beijing-sandbox-2", "beijing-sandbox")
PLAYGROUND_CATALOG_ROOTS = {
    "bj": "argocd/catalogs/playground/beijing-playground",
    "kr": "argocd/catalogs/playground/seoul-playground",
    "jp": "argocd/catalogs/playground/tokyo-playground",
}


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
    promotion_gitops_services: list[str]
    image_targets: list[ImageTarget]
    config_contract: dict[str, Any]
    db_contract: dict[str, Any]


def parse_manifest_text(text: str) -> dict[str, Any]:
    return yaml.safe_load(text) or {}


def load_manifest(path: Path = DEFAULT_MANIFEST_PATH) -> dict[str, Any]:
    if not path.exists() and (path.parent / "bundles").is_dir():
        from contracts.release_bundle_manifest import dump_manifest, merge_bundle_sources

        return parse_manifest_text(dump_manifest(merge_bundle_sources(path.parent / "bundles")))
    return parse_manifest_text(path.read_text())


def load_bundle(manifest: dict[str, Any], service: str, env: str) -> ReleaseBundle:
    bundles = manifest.get("bundles") or {}
    bundle = bundles.get(service)
    if not bundle:
        raise KeyError(f"unknown release bundle: {service}")

    publish_paths = _resolve_publish_paths(bundle, env)
    promotion_gitops_services = [
        str(item).strip()
        for item in (bundle.get("promotion_gitops_services") or [])
        if str(item).strip()
    ]
    _validate_promotion_gitops_services(
        service,
        publish_paths,
        promotion_gitops_services,
    )

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
        image_repo=_optional_str(_resolve_env_mapping_value(bundle.get("image_repo") or {}, env)),
        publish_paths=publish_paths,
        promotion_gitops_services=promotion_gitops_services,
        image_targets=_resolve_image_targets(bundle, env),
        config_contract=_resolve_config_contract(bundle),
        db_contract=_resolve_db_contract(bundle),
    )


def _validate_promotion_gitops_services(
    bundle_service: str,
    publish_paths: list[str],
    promotion_gitops_services: list[str],
) -> None:
    if not promotion_gitops_services:
        return

    allowed = set(promotion_gitops_services)
    prefix = "argocd/services/"
    for path in publish_paths:
        if not path.startswith(prefix):
            continue
        gitops_service = path[len(prefix):].split("/", 1)[0]
        if gitops_service not in allowed:
            raise ValueError(
                f"bundle {bundle_service} publish path targets unowned GitOps service "
                f"{gitops_service}: {path}"
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


def is_playground_env(env: str) -> bool:
    return bool(PLAYGROUND_ENV_RE.fullmatch(env))


def playground_region(env: str) -> str | None:
    match = re.fullmatch(r"sandbox-(bj|kr|jp)-\d+", env)
    if not match:
        return None
    return match.group(1)


def playground_catalog_root(env: str) -> str:
    region = playground_region(env)
    if region and region in PLAYGROUND_CATALOG_ROOTS:
        return PLAYGROUND_CATALOG_ROOTS[region]
    return PLAYGROUND_CATALOG_ROOTS["bj"]


def _resolve_env_mapping_value(mapping: dict[str, Any], env: str) -> Any:
    if env in mapping:
        return mapping[env]
    for key, value in mapping.items():
        key_text = str(key)
        if key_text.endswith("*") and env.startswith(key_text[:-1]):
            return value
    if is_playground_env(env):
        for template_env in PLAYGROUND_TEMPLATE_ENVS:
            if template_env in mapping:
                return mapping[template_env]
    return None


def _resolve_publish_paths(bundle: dict[str, Any], env: str) -> list[str]:
    paths_by_env = bundle.get("publish_paths_by_env") or {}
    source_env = env
    if env in paths_by_env:
        raw_paths = paths_by_env[env]
    elif is_playground_env(env):
        raw_paths = None
        for template_env in PLAYGROUND_TEMPLATE_ENVS:
            if template_env in paths_by_env and paths_by_env[template_env]:
                source_env = template_env
                raw_paths = paths_by_env[template_env]
                break
        if raw_paths is None:
            raw_paths = bundle.get("publish_paths")
    else:
        raw_paths = bundle.get("publish_paths")

    resolved: list[str] = []
    seen: set[str] = set()
    for raw in raw_paths or []:
        path = str(raw).format(env=env)
        if is_playground_env(env) and source_env != env:
            path = _rewrite_playground_publish_path(path, source_env, env)
        if is_playground_env(env) and _is_shared_playground_gitops_path(path):
            continue
        if path not in seen:
            seen.add(path)
            resolved.append(path)
    return resolved


def _is_shared_playground_gitops_path(path: str) -> bool:
    return path.startswith("argocd/apps/") and path.endswith("/sandbox-family-appset.yaml")


def _rewrite_playground_publish_path(path: str, source_env: str, env: str) -> str:
    path = path.replace(
        f"argocd/catalogs/sandbox/{source_env}/",
        f"{playground_catalog_root(env)}/{env}/",
    )
    if path.startswith("argocd/services/"):
        path = path.replace(f"/{source_env}/", f"/{env}/")
    path = path.replace(f"argocd/secrets/{source_env}/", f"argocd/secrets/{env}/")
    path = path.replace(f"/k8s/overlays/{source_env}/", f"/k8s/overlays/{env}/")
    return path


def _resolve_image_targets(bundle: dict[str, Any], env: str) -> list[ImageTarget]:
    raw_targets = bundle.get("image_targets") or []
    targets: list[ImageTarget] = []
    for raw in raw_targets:
        if not isinstance(raw, dict):
            raise ValueError("image_targets entries must be YAML mappings")

        raw_image_repo = raw.get("image_repo") or {}
        if not isinstance(raw_image_repo, dict):
            raise ValueError("image target image_repo must be a YAML mapping")
        image_repo = _optional_str(_resolve_env_mapping_value(raw_image_repo, env))
        if not image_repo:
            continue

        name = str(raw.get("name") or raw.get("image_key") or raw.get("dockerfile") or "")
        image_key = _optional_str(raw.get("image_key"))
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
