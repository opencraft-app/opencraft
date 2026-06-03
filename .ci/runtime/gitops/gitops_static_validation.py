"""
Static GitOps invariants for sandbox ApplicationSet and direct Application models.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

RUNTIME_DIR = Path(__file__).resolve().parents[1]
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from contracts.bundles import load_bundle, load_manifest, playground_catalog_root  # noqa: E402
from support.yaml import load_mapping  # noqa: E402


APPSET_REL = "argocd/apps/beijing-sandbox/sandbox-family-appset.yaml"
APPS_DIR_REL = "argocd/apps/beijing-sandbox"
CATALOG_DIR_TEMPLATE = "argocd/catalogs/sandbox/{env}"
SUPPORTED_SANDBOX_ENVS = {"beijing-sandbox", "beijing-sandbox-2"}
SUPPORTED_DIRECT_APP_ENVS = {"shprod", "sgprod", "tkexgz", "tkexsg", "devcloud-dep"}
ALLOWED_BEIJING_APP_FILES = {"argocd-runtime.yaml", "sandbox-family-appset.yaml"}
REQUIRED_CATALOG_FIELDS = {
    "service",
    "env",
    "project",
    "destinationName",
    "namespace",
    "sourcePath",
}


@dataclass(frozen=True)
class CatalogEntry:
    file: Path
    rel_file: str
    service: str
    env: str
    source_path: str
    data: dict[str, Any]

    @property
    def app_name(self) -> str:
        return f"{self.service}-{self.env}"


def repo_rel(path: Path, repo_root: Path) -> str:
    return path.relative_to(repo_root).as_posix()


def path_is_covered(candidate: str, patterns: Iterable[str]) -> bool:
    candidate = candidate.strip("/")
    for raw_pattern in patterns:
        pattern = raw_pattern.strip("/")
        if pattern.endswith("/**"):
            prefix = pattern[:-3].rstrip("/")
            if candidate == prefix or candidate.startswith(prefix + "/"):
                return True
        elif candidate == pattern:
            return True
    return False


def catalog_dir_rel(env: str) -> str:
    if is_playground_env(env):
        return f"{playground_catalog_root(env)}/{env}"
    return CATALOG_DIR_TEMPLATE.format(env=env)


def is_playground_env(env: str) -> bool:
    return re.fullmatch(r"sandbox-(bj|kr)-\d+", env) is not None


def load_catalogs(repo_root: Path, env: str) -> tuple[list[CatalogEntry], list[str]]:
    errors: list[str] = []
    catalog_rel = catalog_dir_rel(env)
    catalog_dir = repo_root / catalog_rel
    entries: list[CatalogEntry] = []
    if not catalog_dir.is_dir():
        return entries, [f"missing catalog directory: {catalog_rel}"]

    for catalog_file in sorted(catalog_dir.glob("*.yaml")):
        rel_file = repo_rel(catalog_file, repo_root)
        try:
            data = load_mapping(catalog_file)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{rel_file}: failed to parse YAML: {exc}")
            continue

        missing = sorted(REQUIRED_CATALOG_FIELDS - set(data))
        if missing:
            errors.append(f"{rel_file}: missing required fields: {', '.join(missing)}")
            continue
        if "path" in data:
            errors.append(f"{rel_file}: catalog must use sourcePath, not path")
        if str(data["env"]) != env:
            errors.append(f"{rel_file}: env is {data['env']!r}, expected {env!r}")

        service = str(data["service"])
        source_path = str(data["sourcePath"])
        if source_path.startswith("argocd/services/") is False:
            errors.append(f"{rel_file}: sourcePath must start with argocd/services/: {source_path}")
        if source_path.startswith("argocd/services/") and not (repo_root / source_path).is_dir():
            errors.append(f"{rel_file}: sourcePath does not exist: {source_path}")

        entries.append(
            CatalogEntry(
                file=catalog_file,
                rel_file=rel_file,
                service=service,
                env=str(data["env"]),
                source_path=source_path,
                data=data,
            )
        )

    if not entries:
        errors.append(f"no catalog files found under {catalog_rel}")
    return entries, errors


def validate_appset(repo_root: Path) -> list[str]:
    appset = repo_root / APPSET_REL
    if not appset.is_file():
        return [f"missing ApplicationSet: {APPSET_REL}"]

    errors: list[str] = []
    text = appset.read_text()
    if "path: '{{ .sourcePath }}'" not in text and 'path: "{{ .sourcePath }}"' not in text:
        errors.append(f"{APPSET_REL}: template source.path must use {{ .sourcePath }}")
    if "{{ .path }}" in text:
        errors.append(f"{APPSET_REL}: template must not use reserved git generator field {{ .path }}")

    try:
        data = load_mapping(appset)
    except Exception as exc:  # noqa: BLE001
        return [f"{APPSET_REL}: failed to parse YAML: {exc}"]
    if data.get("kind") != "ApplicationSet":
        errors.append(f"{APPSET_REL}: kind must be ApplicationSet")
    generators = (data.get("spec") or {}).get("generators") or []
    file_paths = {
        str(item.get("path", ""))
        for generator in generators
        if isinstance(generator, dict)
        for item in (generator.get("git", {}).get("files", []) or [])
        if isinstance(item, dict)
    }
    if "argocd/catalogs/sandbox/*/*.yaml" not in file_paths:
        errors.append(f"{APPSET_REL}: git generator must read argocd/catalogs/sandbox/*/*.yaml")
    if "argocd/catalogs/playground/beijing-playground/*/*.yaml" not in file_paths:
        errors.append(f"{APPSET_REL}: git generator must read argocd/catalogs/playground/beijing-playground/*/*.yaml")
    return errors


def validate_beijing_apps_dir(repo_root: Path) -> list[str]:
    apps_dir = repo_root / APPS_DIR_REL
    if not apps_dir.is_dir():
        return [f"missing apps directory: {APPS_DIR_REL}"]

    errors: list[str] = []
    for app_file in sorted(apps_dir.glob("*.yaml")):
        if app_file.name not in ALLOWED_BEIJING_APP_FILES:
            errors.append(
                f"{repo_rel(app_file, repo_root)}: Beijing AppSet model forbids business hand-written leaf apps"
            )
    return errors


def paths_from_kustomization(kustomization: Path, repo_root: Path, seen: set[Path] | None = None) -> list[str]:
    if not kustomization.is_file():
        return []
    seen = seen or set()
    kustomization = kustomization.resolve()
    if kustomization in seen:
        return []
    seen.add(kustomization)

    data = load_mapping(kustomization)
    references: list[str] = []
    for field in ("resources", "components"):
        for item in data.get(field) or []:
            item_text = str(item)
            if item_text.startswith(("http://", "https://")):
                continue
            resolved = (kustomization.parent / item_text).resolve()
            try:
                references.append(resolved.relative_to(repo_root.resolve()).as_posix())
            except ValueError:
                continue
            if resolved.is_dir():
                references.extend(paths_from_kustomization(resolved / "kustomization.yaml", repo_root, seen))
    for item in data.get("generators") or []:
        item_text = str(item)
        resolved = (kustomization.parent / item_text).resolve()
        try:
            generator_rel = resolved.relative_to(repo_root.resolve()).as_posix()
        except ValueError:
            continue
        references.append(generator_rel)
        if resolved.is_file():
            generator = load_mapping(resolved)
            for secret_file in generator.get("files") or []:
                secret_resolved = (resolved.parent / str(secret_file)).resolve()
                try:
                    references.append(secret_resolved.relative_to(repo_root.resolve()).as_posix())
                except ValueError:
                    continue
    return references


def env_publish_paths(manifest: dict[str, Any], env: str) -> dict[str, list[str]]:
    paths_by_bundle: dict[str, list[str]] = {}
    for bundle_name, bundle_data in sorted((manifest.get("bundles") or {}).items()):
        if env not in (bundle_data.get("publish_paths_by_env") or {}):
            continue
        publish_paths = load_bundle(manifest, bundle_name, env).publish_paths
        if publish_paths:
            paths_by_bundle[bundle_name] = publish_paths
    return paths_by_bundle


def env_catalog_exemptions(manifest: dict[str, Any], env: str) -> dict[str, str]:
    raw_by_env = manifest.get("catalog_publish_exemptions_by_env") or {}
    raw_exemptions = raw_by_env.get(env) or {}
    if not isinstance(raw_exemptions, dict):
        raise ValueError(f"catalog_publish_exemptions_by_env.{env} must be a YAML mapping")

    exemptions: dict[str, str] = {}
    for raw_path, raw_reason in raw_exemptions.items():
        catalog_path = str(raw_path).strip().strip("/")
        reason = str(raw_reason).strip()
        if not catalog_path or not reason:
            raise ValueError(f"catalog publish exemption for {env} must define catalog path and reason")
        exemptions[catalog_path] = reason
    return exemptions


def validate_publish_closure(
    repo_root: Path,
    manifest_path: Path,
    catalogs: list[CatalogEntry],
    env: str,
) -> list[str]:
    errors: list[str] = []
    if not manifest_path.is_file():
        return [f"missing release bundle manifest: {manifest_path}"]

    manifest = load_manifest(manifest_path)
    paths_by_bundle = env_publish_paths(manifest, env)
    try:
        catalog_exemptions = env_catalog_exemptions(manifest, env)
    except ValueError as exc:
        return [str(exc)]

    catalog_by_rel = {entry.rel_file: entry for entry in catalogs}
    expected_catalogs = {
        path
        for paths in paths_by_bundle.values()
        for path in paths
        if path.startswith(f"{catalog_dir_rel(env)}/") and path.endswith(".yaml")
    }
    exempt_catalogs = set(catalog_exemptions)

    actual_catalogs = set(catalog_by_rel)
    for missing in sorted(expected_catalogs - actual_catalogs):
        errors.append(f"release bundle references missing catalog: {missing}")
    for missing_exemption in sorted(exempt_catalogs - actual_catalogs):
        errors.append(f"catalog publish exemption references missing catalog: {missing_exemption}")
    for extra in sorted(actual_catalogs - expected_catalogs - exempt_catalogs):
        errors.append(f"{extra}: catalog is not covered by any {env} release bundle publish_paths_by_env")

    for bundle_name, paths in paths_by_bundle.items():
        if not path_is_covered(APPSET_REL, paths):
            errors.append(f"bundle {bundle_name}: missing {APPSET_REL}")
        for catalog_rel in sorted(path for path in expected_catalogs if path in paths):
            entry = catalog_by_rel.get(catalog_rel)
            if not entry:
                continue
            if not path_is_covered(catalog_rel, paths):
                errors.append(f"bundle {bundle_name}: missing catalog path {catalog_rel}")
            if not path_is_covered(f"{entry.source_path}/kustomization.yaml", paths):
                errors.append(f"bundle {bundle_name}: missing sourcePath publish closure {entry.source_path}/**")

            kustomization = repo_root / entry.source_path / "kustomization.yaml"
            try:
                referenced_paths = paths_from_kustomization(kustomization, repo_root)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{entry.source_path}/kustomization.yaml: failed to inspect references: {exc}")
                continue

            for reference in referenced_paths:
                if not path_is_covered(reference, paths):
                    errors.append(f"bundle {bundle_name}: {entry.source_path} references {reference}, not in publish_paths")

    return errors


def validate(repo_root: Path, env: str, bundle_manifest: Path) -> list[str]:
    if env in SUPPORTED_DIRECT_APP_ENVS:
        return validate_direct_apps(repo_root, env)

    if env not in SUPPORTED_SANDBOX_ENVS and not is_playground_env(env):
        return [f"unsupported env for AppSet static validation: {env}"]

    catalogs, catalog_errors = load_catalogs(repo_root, env)
    errors: list[str] = []
    errors.extend(validate_appset(repo_root))
    errors.extend(catalog_errors)
    errors.extend(validate_beijing_apps_dir(repo_root))
    if env in SUPPORTED_SANDBOX_ENVS:
        errors.extend(validate_publish_closure(repo_root, bundle_manifest, catalogs, env))
    return errors


def validate_direct_apps(repo_root: Path, env: str) -> list[str]:
    apps_dir_rel = f"argocd/apps/{env}"
    apps_dir = repo_root / apps_dir_rel
    if not apps_dir.is_dir():
        return [f"missing apps directory: {apps_dir_rel}"]

    errors: list[str] = []
    app_files = sorted(apps_dir.glob("*.yaml"))
    if not app_files:
        return [f"no Application files found under {apps_dir_rel}"]

    for app_file in app_files:
        rel_file = repo_rel(app_file, repo_root)
        try:
            data = load_mapping(app_file)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{rel_file}: failed to parse YAML: {exc}")
            continue
        if data.get("kind") != "Application":
            errors.append(f"{rel_file}: kind must be Application")
        spec = data.get("spec") or {}
        source = spec.get("source") or {}
        destination = spec.get("destination") or {}
        source_path = str(source.get("path") or "").strip()
        if source.get("repoURL") != "git@git.woa.com:wisp/mono2.git":
            errors.append(f"{rel_file}: spec.source.repoURL must point at git@git.woa.com:wisp/mono2.git")
        if source.get("targetRevision") != "gitops":
            errors.append(f"{rel_file}: spec.source.targetRevision must be gitops")
        if not source_path.startswith(f"argocd/services/") or f"/{env}" not in source_path:
            errors.append(f"{rel_file}: spec.source.path must point at argocd/services/<service>/{env}")
        elif not (repo_root / source_path / "kustomization.yaml").is_file():
            errors.append(f"{rel_file}: missing kustomization.yaml under {source_path}")
        if destination.get("name") != env:
            errors.append(f"{rel_file}: spec.destination.name must be {env}")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path("."))
    parser.add_argument("--env", default="beijing-sandbox")
    parser.add_argument(
        "--bundle-manifest",
        type=Path,
        default=None,
        help="Release bundle manifest. Defaults to <repo-root>/.ci/runtime/release-bundles.manifest.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    repo_root = args.repo_root.resolve()
    bundle_manifest = (args.bundle_manifest or repo_root / ".ci/runtime/release-bundles.manifest").resolve()
    errors = validate(repo_root, args.env, bundle_manifest)
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1

    catalogs, _ = load_catalogs(repo_root, args.env)
    print(
        f"gitops static validation passed: env={args.env} catalogs={len(catalogs)} "
        f"bundle_manifest={bundle_manifest}"
    )
    return 0
