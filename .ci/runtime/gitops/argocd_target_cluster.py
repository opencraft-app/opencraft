"""Register Git-tracked Argo target cluster definitions with the live control plane."""

from __future__ import annotations

import argparse
import sys
import urllib.error
from pathlib import Path
from typing import Any, Mapping

import yaml

from gitops.argocd import api_request, login, resolve_settings

ALLOWED_PROJECT_POLICY_RESOURCES = {
    "applications",
    "applicationsets",
    "repositories",
    "exec",
    "logs",
    "clusters",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Upsert an Argo CD target cluster and its AppProject from Git-tracked definitions."
    )
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--cluster-manifest", required=True)
    parser.add_argument("--kubeconfig")
    parser.add_argument("--argocd-base-url")
    parser.add_argument("--argocd-username")
    parser.add_argument("--argocd-password")
    parser.add_argument("--argocd-insecure-skip-verify", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--skip-project", action="store_true")
    return parser.parse_args()


def load_yaml_mapping(path: Path) -> dict[str, Any]:
    payload = yaml.safe_load(path.read_text()) or {}
    if not isinstance(payload, dict):
        raise ValueError(f"{path} must contain a YAML mapping")
    return payload


def load_cluster_manifest(repo_root: Path, path: Path) -> dict[str, Any]:
    manifest_path = path if path.is_absolute() else repo_root / path
    manifest = load_yaml_mapping(manifest_path)
    if manifest.get("kind") != "ArgoTargetCluster":
        raise ValueError(f"{manifest_path} kind must be ArgoTargetCluster")
    metadata = manifest.get("metadata")
    spec = manifest.get("spec")
    if not isinstance(metadata, dict) or not metadata.get("name"):
        raise ValueError(f"{manifest_path} metadata.name is required")
    if not isinstance(spec, dict):
        raise ValueError(f"{manifest_path} spec is required")
    if not spec.get("server"):
        raise ValueError(f"{manifest_path} spec.server is required")
    if not spec.get("projectPath"):
        raise ValueError(f"{manifest_path} spec.projectPath is required")
    return manifest


def resolve_kubeconfig_path(repo_root: Path, manifest: Mapping[str, Any], cli_path: str | None) -> Path:
    if cli_path:
        path = Path(cli_path)
    else:
        hint = str(manifest.get("spec", {}).get("kubeconfigHint", "")).strip()
        if not hint:
            raise ValueError("--kubeconfig is required when spec.kubeconfigHint is empty")
        path = Path(hint)
    path = path if path.is_absolute() else repo_root / path
    if not path.is_file():
        raise FileNotFoundError(f"missing kubeconfig: {path}")
    return path


def _named_entry(entries: list[Any], name: str, key: str) -> dict[str, Any]:
    for entry in entries:
        if isinstance(entry, dict) and entry.get("name") == name and isinstance(entry.get(key), dict):
            return entry[key]
    raise ValueError(f"kubeconfig entry {name!r} with key {key!r} not found")


def cluster_payload_from_kubeconfig(kubeconfig_path: Path, cluster_name: str, expected_server: str) -> dict[str, Any]:
    kubeconfig = load_yaml_mapping(kubeconfig_path)
    current_context = str(kubeconfig.get("current-context", "")).strip()
    contexts = kubeconfig.get("contexts") or []
    if current_context:
        context = _named_entry(contexts, current_context, "context")
    elif len(contexts) == 1 and isinstance(contexts[0], dict) and isinstance(contexts[0].get("context"), dict):
        context = contexts[0]["context"]
    else:
        raise ValueError("kubeconfig must set current-context or contain exactly one context")

    cluster_ref = str(context.get("cluster", "")).strip()
    user_ref = str(context.get("user", "")).strip()
    cluster = _named_entry(kubeconfig.get("clusters") or [], cluster_ref, "cluster")
    user = _named_entry(kubeconfig.get("users") or [], user_ref, "user")

    server = str(cluster.get("server", "")).strip()
    if server != expected_server:
        raise ValueError(f"kubeconfig server mismatch for {cluster_name}: expected {expected_server}, got {server}")

    tls_config: dict[str, Any] = {"insecure": False}
    if cluster.get("certificate-authority-data"):
        tls_config["caData"] = str(cluster["certificate-authority-data"]).strip()
    if user.get("client-certificate-data"):
        tls_config["certData"] = str(user["client-certificate-data"]).strip()
    if user.get("client-key-data"):
        tls_config["keyData"] = str(user["client-key-data"]).strip()

    config: dict[str, Any] = {"tlsClientConfig": tls_config}
    if user.get("token"):
        config["bearerToken"] = str(user["token"]).strip()

    if not (config.get("bearerToken") or {"certData", "keyData"}.issubset(tls_config)):
        raise ValueError("kubeconfig user must provide token or client certificate/key data")

    return {
        "server": server,
        "name": cluster_name,
        "config": config,
    }


def iter_role_policies(project: Mapping[str, Any]) -> list[tuple[str, str]]:
    policies: list[tuple[str, str]] = []
    spec = project.get("spec", {})
    roles = spec.get("roles", []) if isinstance(spec, dict) else []
    for role in roles:
        if not isinstance(role, dict):
            continue
        role_name = str(role.get("name", ""))
        for policy in role.get("policies", []) or []:
            policies.append((role_name, str(policy)))
    return policies


def validate_project_manifest(project: Mapping[str, Any], path: Path) -> None:
    if project.get("kind") != "AppProject":
        raise ValueError(f"{path} kind must be AppProject")
    for role_name, policy in iter_role_policies(project):
        parts = [part.strip() for part in policy.split(",")]
        if len(parts) < 6 or parts[0] != "p":
            continue
        resource = parts[2]
        if resource not in ALLOWED_PROJECT_POLICY_RESOURCES:
            allowed = ", ".join(sorted(ALLOWED_PROJECT_POLICY_RESOURCES))
            raise ValueError(
                f"{path} role {role_name!r} has unsupported Argo project RBAC resource {resource!r}; "
                f"allowed resources: {allowed}"
            )


def api_request_with_context(method: str, url: str, ssl_context: Any, token: str, payload: Mapping[str, Any]) -> Any:
    try:
        return api_request(method, url, ssl_context, token, payload)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")
        raise RuntimeError(f"Argo API request failed: method={method} url={url} http={exc.code} body={body[:500]}") from exc


def main() -> int:
    args = parse_args()
    repo_root = Path(args.repo_root).resolve()
    cluster_manifest_path = Path(args.cluster_manifest)
    manifest = load_cluster_manifest(repo_root, cluster_manifest_path)
    spec = manifest["spec"]
    cluster_name = str(manifest["metadata"]["name"]).strip()
    expected_server = str(spec["server"]).strip()
    kubeconfig_path = resolve_kubeconfig_path(repo_root, manifest, args.kubeconfig)
    cluster_payload = cluster_payload_from_kubeconfig(kubeconfig_path, cluster_name, expected_server)

    project_path = repo_root / str(spec["projectPath"])
    project = load_yaml_mapping(project_path)
    validate_project_manifest(project, project_path)

    print("Argo 目标集群接入定义")
    print(f"- cluster: {cluster_name}")
    print(f"- server: {expected_server}")
    print(f"- project: {project_path.relative_to(repo_root)}")
    print(f"- kubeconfig: {kubeconfig_path}")
    print(f"- credential: {'token' if cluster_payload['config'].get('bearerToken') else 'client-certificate'}")

    if args.dry_run:
        print("dry-run: skip Argo API upsert")
        return 0

    base_url, username, password, ssl_context = resolve_settings(args)
    token = login(base_url, username, password, ssl_context)
    api_request_with_context(
        "POST",
        f"{base_url}/api/v1/clusters?upsert=true",
        ssl_context,
        token,
        cluster_payload,
    )
    print(f"已 upsert Argo cluster: {cluster_name}")

    if not args.skip_project:
        api_request_with_context(
            "POST",
            f"{base_url}/api/v1/projects?upsert=true",
            ssl_context,
            token,
            {"project": project, "upsert": True},
        )
        print(f"已 upsert Argo AppProject: {project.get('metadata', {}).get('name', cluster_name)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

