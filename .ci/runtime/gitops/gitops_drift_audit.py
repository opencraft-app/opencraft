"""
Audit whether live Argo CD apps match the GitOps inventory.
"""

from __future__ import annotations

import argparse
import json
import os
import ssl
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Sequence

import yaml

from gitops.argocd import api_request as argocd_api_request
from gitops.argocd import login as login_argocd
from gitops.argocd import resolve_settings as resolve_argocd_settings
from gitops.argocd import resolve_string_setting
from gitops.git import list_files as git_list_files
from gitops.git import output as git_output
from gitops.git import show_text as git_show_text


CATALOG_DIRS = {
    "beijing-sandbox": "argocd/catalogs/sandbox/beijing-sandbox",
    "beijing-sandbox-2": "argocd/catalogs/sandbox/beijing-sandbox-2",
}
DIRECT_APP_DIRS = {
    "shprod": "argocd/apps/shprod",
}
DEFAULT_REPO_URL = "git@git.woa.com:wisp/mono2.git"
DEFAULT_TARGET_REVISION = "gitops"


@dataclass(frozen=True)
class ExpectedApp:
    app_name: str
    service: str
    env: str
    project: str
    destination_name: str
    namespace: str
    source_path: str
    expected_images: tuple[str, ...]


@dataclass(frozen=True)
class Drift:
    app_name: str
    field: str
    expected: str
    live: str

    def summary(self) -> str:
        return f"{self.app_name} {self.field}: expected={self.expected} live={self.live}"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path("."))
    parser.add_argument("--env", default="beijing-sandbox")
    parser.add_argument("--gitops-ref", default="origin/gitops")
    parser.add_argument("--repo-url", default=DEFAULT_REPO_URL)
    parser.add_argument("--target-revision", default=DEFAULT_TARGET_REVISION)
    parser.add_argument("--argocd-base-url")
    parser.add_argument("--argocd-username")
    parser.add_argument("--argocd-password")
    parser.add_argument("--argocd-insecure-skip-verify", action="store_true")
    parser.add_argument("--wework-webhook")
    return parser.parse_args()


def gitops_commit(repo_root: Path, gitops_ref: str) -> str:
    return git_output(repo_root, "rev-parse", gitops_ref, strip=True)


def parse_yaml_text(text: str, source: str) -> dict[str, Any]:
    payload = yaml.safe_load(text) or {}
    if not isinstance(payload, dict):
        raise ValueError(f"{source} must contain a YAML mapping")
    return payload


def expected_images_from_gitops(repo_root: Path, gitops_ref: str, service: str, env: str) -> tuple[str, ...]:
    service_dir = f"argocd/services/{service}/{env}"
    env_files = sorted(
        path
        for path in git_list_files(repo_root, gitops_ref, service_dir)
        if Path(path).name.endswith("-platform.env")
    )
    images: list[str] = []
    for env_file in env_files:
        for raw_line in git_show_text(repo_root, gitops_ref, env_file).splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            if key.endswith("_IMAGE") and value.strip():
                images.append(value.strip())
    return tuple(sorted(set(images)))


def load_expected_apps(repo_root: Path, env: str, gitops_ref: str) -> list[ExpectedApp]:
    if env in DIRECT_APP_DIRS:
        return load_expected_direct_apps(repo_root, env, gitops_ref)

    catalog_dir = CATALOG_DIRS.get(env)
    if not catalog_dir:
        raise RuntimeError(f"unsupported env for drift audit: {env}")

    catalog_files = sorted(git_list_files(repo_root, gitops_ref, catalog_dir))
    if not catalog_files:
        raise RuntimeError(f"no catalog files found under {catalog_dir} at {gitops_ref}")

    expected: list[ExpectedApp] = []
    for catalog_file in catalog_files:
        data = parse_yaml_text(git_show_text(repo_root, gitops_ref, catalog_file), catalog_file)
        service = str(data.get("service", "")).strip()
        catalog_env = str(data.get("env", "")).strip()
        source_path = str(data.get("sourcePath", "")).strip()
        if not service or catalog_env != env or not source_path:
            raise RuntimeError(f"{catalog_file}: missing service/env/sourcePath for {env}")
        expected.append(
            ExpectedApp(
                app_name=f"{service}-{env}",
                service=service,
                env=env,
                project=str(data.get("project", "")).strip(),
                destination_name=str(data.get("destinationName", "")).strip(),
                namespace=str(data.get("namespace", "")).strip(),
                source_path=source_path,
                expected_images=expected_images_from_gitops(repo_root, gitops_ref, service, env),
            )
        )
    return expected


def load_expected_direct_apps(repo_root: Path, env: str, gitops_ref: str) -> list[ExpectedApp]:
    apps_dir = DIRECT_APP_DIRS[env]
    app_files = sorted(path for path in git_list_files(repo_root, gitops_ref, apps_dir) if path.endswith(".yaml"))
    if not app_files:
        raise RuntimeError(f"no Application files found under {apps_dir} at {gitops_ref}")

    expected: list[ExpectedApp] = []
    for app_file in app_files:
        data = parse_yaml_text(git_show_text(repo_root, gitops_ref, app_file), app_file)
        if data.get("kind") != "Application":
            raise RuntimeError(f"{app_file}: kind must be Application")
        metadata = data.get("metadata") or {}
        spec = data.get("spec") or {}
        source = spec.get("source") or {}
        destination = spec.get("destination") or {}
        source_path = str(source.get("path", "")).strip()
        source_parts = source_path.split("/")
        if len(source_parts) < 4 or source_parts[:2] != ["argocd", "services"] or source_parts[3] != env:
            raise RuntimeError(f"{app_file}: spec.source.path must point at argocd/services/<service>/{env}")
        service = source_parts[2]
        app_name = str(metadata.get("name", "")).strip() or f"{service}-{env}"
        expected.append(
            ExpectedApp(
                app_name=app_name,
                service=service,
                env=env,
                project=str(spec.get("project", "")).strip(),
                destination_name=str(destination.get("name", "")).strip(),
                namespace=str(destination.get("namespace", "")).strip(),
                source_path=source_path,
                expected_images=expected_images_from_gitops(repo_root, gitops_ref, service, env),
            )
        )
    return expected


def list_argocd_apps(base_url: str, ssl_context: ssl.SSLContext, token: str) -> list[dict[str, Any]]:
    try:
        payload = argocd_api_request("GET", f"{base_url}/api/v1/applications", ssl_context, token)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")
        raise RuntimeError(f"argo applications list request failed: http={exc.code} body={body[:500]}") from exc
    items = payload.get("items", [])
    if not isinstance(items, list):
        raise RuntimeError("argo applications list response does not contain an items list")
    return items


def nested_get(payload: dict[str, Any], path: Sequence[str], default: Any = "") -> Any:
    current: Any = payload
    for key in path:
        if not isinstance(current, dict):
            return default
        current = current.get(key, default)
    return current


def check_equal(drifts: list[Drift], app_name: str, field: str, expected: str, live: str) -> None:
    if expected != live:
        drifts.append(Drift(app_name, field, expected or "-", live or "-"))


def evaluate_drift(
    expected_apps: Sequence[ExpectedApp],
    live_apps: Sequence[dict[str, Any]],
    gitops_commit_sha: str,
    repo_url: str,
    target_revision: str,
    env: str,
) -> list[Drift]:
    drifts: list[Drift] = []
    live_by_name = {
        str(nested_get(app, ("metadata", "name"))): app
        for app in live_apps
        if nested_get(app, ("metadata", "name"))
    }
    expected_by_name = {app.app_name: app for app in expected_apps}

    for expected in expected_apps:
        live = live_by_name.get(expected.app_name)
        if not live:
            drifts.append(Drift(expected.app_name, "app", "present", "missing"))
            continue

        check_equal(
            drifts,
            expected.app_name,
            "spec.project",
            expected.project,
            str(nested_get(live, ("spec", "project"))),
        )
        check_equal(
            drifts,
            expected.app_name,
            "spec.source.repoURL",
            repo_url,
            str(nested_get(live, ("spec", "source", "repoURL"))),
        )
        check_equal(
            drifts,
            expected.app_name,
            "spec.source.targetRevision",
            target_revision,
            str(nested_get(live, ("spec", "source", "targetRevision"))),
        )
        check_equal(
            drifts,
            expected.app_name,
            "spec.source.path",
            expected.source_path,
            str(nested_get(live, ("spec", "source", "path"))),
        )
        check_equal(
            drifts,
            expected.app_name,
            "spec.destination.name",
            expected.destination_name,
            str(nested_get(live, ("spec", "destination", "name"))),
        )
        check_equal(
            drifts,
            expected.app_name,
            "spec.destination.namespace",
            expected.namespace,
            str(nested_get(live, ("spec", "destination", "namespace"))),
        )
        check_equal(
            drifts,
            expected.app_name,
            "status.sync.revision",
            gitops_commit_sha,
            str(nested_get(live, ("status", "sync", "revision"))),
        )
        check_equal(
            drifts,
            expected.app_name,
            "status.sync.status",
            "Synced",
            str(nested_get(live, ("status", "sync", "status"))),
        )
        check_equal(
            drifts,
            expected.app_name,
            "status.health.status",
            "Healthy",
            str(nested_get(live, ("status", "health", "status"))),
        )

        live_images = set(nested_get(live, ("status", "summary", "images"), []) or [])
        for image in expected.expected_images:
            if image not in live_images:
                drifts.append(
                    Drift(
                        expected.app_name,
                        "status.summary.images",
                        image,
                        ",".join(sorted(live_images)) or "-",
                    )
                )

    for app_name, live in sorted(live_by_name.items()):
        labels = nested_get(live, ("metadata", "labels"), {}) or {}
        if labels.get("lightclaw.dev/environment-name") == env and app_name not in expected_by_name:
            drifts.append(Drift(app_name, "orphan", "absent from live", "present in live"))

    return drifts


def format_drift_table(drifts: Sequence[Drift]) -> str:
    if not drifts:
        return "No GitOps drift detected."
    lines = [
        "| App | Field | Expected | Live |",
        "| --- | --- | --- | --- |",
    ]
    for drift in drifts:
        lines.append(f"| `{drift.app_name}` | `{drift.field}` | `{drift.expected}` | `{drift.live}` |")
    return "\n".join(lines)


def build_alert_content(
    env: str,
    gitops_ref: str,
    gitops_commit_sha: str,
    drifts: Sequence[Drift],
    error: str | None = None,
) -> str:
    lines = [
        "GitOps drift audit failed",
        f"env: {env}",
        f"gitops_ref: {gitops_ref}",
        f"gitops_commit: {gitops_commit_sha or '-'}",
    ]
    if error:
        lines.append(f"error: {error}")
    lines.append(f"drift_count: {len(drifts)}")
    for drift in drifts[:10]:
        lines.append(f"- {drift.summary()}")
    build_url = first_env_value("BK_CI_BUILD_URL", "CI_BUILD_URL", "BUILD_URL", "BK_CI_PIPELINE_URL")
    if build_url:
        lines.append(f"build_url: {build_url}")
    return "\n".join(lines)


def first_env_value(*names: str) -> str:
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return ""


def resolve_wework_webhook(args: argparse.Namespace) -> str:
    return resolve_string_setting(
        args.wework_webhook,
        "WEWORK_DRIFT_AUDIT_WEBHOOK",
        "/etc/lightclaw-ci/wework_drift_audit_webhook",
        os.environ.get("WEWORK_DRIFT_AUDIT_WEBHOOK_FALLBACK", ""),
    )


def send_wework_alert(
    webhook_url: str,
    content: str,
    urlopen: Callable[..., Any] = urllib.request.urlopen,
) -> bool:
    if not webhook_url:
        print("skip wework alert: webhook is not configured", file=sys.stderr)
        return False
    payload = {
        "msgtype": "text",
        "text": {
            "content": content,
        },
    }
    req = urllib.request.Request(
        webhook_url,
        data=json.dumps(payload, ensure_ascii=False).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(req, timeout=10) as resp:
        resp.read()
    return True


def notify_if_needed(
    webhook_url: str,
    env: str,
    gitops_ref: str,
    gitops_commit_sha: str,
    drifts: Sequence[Drift],
    error: str | None = None,
    urlopen: Callable[..., Any] = urllib.request.urlopen,
) -> bool:
    if not drifts and not error:
        return False
    content = build_alert_content(env, gitops_ref, gitops_commit_sha, drifts, error)
    try:
        return send_wework_alert(webhook_url, content, urlopen=urlopen)
    except Exception as exc:  # noqa: BLE001
        print(f"failed to send wework drift audit alert: {exc}", file=sys.stderr)
        return False


def run_audit(args: argparse.Namespace) -> tuple[str, list[Drift], int]:
    repo_root = args.repo_root.resolve()
    gitops_commit_sha = gitops_commit(repo_root, args.gitops_ref)
    print(f"gitops drift audit: env={args.env} gitops_ref={args.gitops_ref} gitops_commit={gitops_commit_sha}")

    expected_apps = load_expected_apps(repo_root, args.env, args.gitops_ref)
    print(f"expected apps: {len(expected_apps)}")

    argocd_base_url, argocd_username, argocd_password, ssl_context = resolve_argocd_settings(args)
    argocd_token = login_argocd(argocd_base_url, argocd_username, argocd_password, ssl_context)
    live_apps = list_argocd_apps(argocd_base_url, ssl_context, argocd_token)
    print(f"live apps visible: {len(live_apps)}")

    drifts = evaluate_drift(
        expected_apps=expected_apps,
        live_apps=live_apps,
        gitops_commit_sha=gitops_commit_sha,
        repo_url=args.repo_url,
        target_revision=args.target_revision,
        env=args.env,
    )
    print(format_drift_table(drifts))
    return gitops_commit_sha, drifts, 1 if drifts else 0


def main() -> int:
    args = parse_args()
    webhook_url = resolve_wework_webhook(args)
    gitops_commit_sha = ""
    try:
        gitops_commit_sha, drifts, exit_code = run_audit(args)
        if drifts:
            notify_if_needed(webhook_url, args.env, args.gitops_ref, gitops_commit_sha, drifts)
        return exit_code
    except Exception as exc:  # noqa: BLE001
        notify_if_needed(webhook_url, args.env, args.gitops_ref, gitops_commit_sha, [], error=str(exc))
        raise
