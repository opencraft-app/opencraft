"""Diagnostic and creation scaffold for playground GitOps environments."""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import secrets
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

import yaml

from gitops.argocd import api_request as argocd_api_request
from gitops.argocd import login as login_argocd
from gitops.argocd import resolve_settings as resolve_argocd_settings
from gitops.git import list_files as git_list_files
from gitops.git import run as git_run
from gitops.git import show_text as git_show_text

DEFAULT_APPSET_PATH = "argocd/apps/beijing-sandbox/sandbox-family-appset.yaml"
DEFAULT_PLAYGROUND_ROOT = "argocd/catalogs/playground/beijing-playground"
DEFAULT_ROOT_APP = "root-beijing-sandbox"
DEFAULT_FROM_ENV = "sandbox-bj-5"
DEFAULT_CLUSTER_NAME = "beijing-playground"
DEFAULT_PROJECT = "beijing-playground"
LIGHTCLAW_DOMAIN = "lightclaw.tech"
PLAYGROUND_RUNTIME_SECRET_NAME = "playground-runtime-secrets"
PLAYGROUND_RUNTIME_SECRET_FILE = f"{PLAYGROUND_RUNTIME_SECRET_NAME}.sops.yaml"
PLAYGROUND_RUNTIME_KSOPS_GENERATOR = "ksops-runtime-secrets-generator.yaml"
PLAYGROUND_PULL_SECRET_NAMES = ("tcr.bj8-lightclaw-secret", "tcr.ccr-clawhub-secret")
PLAYGROUND_DB_SERVICES: tuple[tuple[str, str], ...] = (
    ("payment", "migration"),
    ("lightclaw-auth", "migration"),
    ("lightclaw-auth", "seed"),
    ("ai-gateway", "migration"),
    ("subscription", "migration"),
    ("sandbox", "migration"),
    ("ctl", "migration"),
)
PLAYGROUND_REPO_BACKED_DB_JOBS: frozenset[tuple[str, str]] = frozenset({("ctl", "migration")})


@dataclass(frozen=True)
class CatalogApp:
    app_name: str
    service: str
    env: str
    project: str
    destination_name: str
    namespace: str
    source_path: str
    catalog_file: str


@dataclass(frozen=True)
class CheckResult:
    name: str
    status: str
    lines: tuple[str, ...] = ()
    actions: tuple[str, ...] = ()


@dataclass(frozen=True)
class CloneFile:
    source: Path
    target: Path


def validate_command(command: list[str]) -> list[str]:
    if not command or not all(isinstance(part, str) and part for part in command):
        raise ValueError("command must be a non-empty list of non-empty strings")
    return command


def run_command(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[Any]:
    return subprocess.run(validate_command(command), **kwargs)  # nosemgrep: dangerous-subprocess-use-audit


@dataclass(frozen=True)
class GeneratedFile:
    target: Path
    text: str


@dataclass(frozen=True)
class RenderedFile:
    target: Path
    data: bytes
    mode_source: Path | None = None


@dataclass(frozen=True)
class PlaygroundRuntimeSecretValues:
    mysql_root_password: str
    redis_password: str


@dataclass(frozen=True)
class PlaygroundClonePlan:
    repo_root: Path
    from_env: str
    to_env: str
    playground_root: str
    cluster_name: str
    project: str
    namespace: str
    api_host: str
    sandbox_host: str
    wildcard_host: str
    tls_secret_name: str
    files: tuple[CloneFile, ...]
    replacements: tuple[tuple[str, str], ...]


@dataclass(frozen=True)
class DatabaseGrant:
    database: str
    username: str | None
    password_secret: str | None
    password_key: str | None


@dataclass(frozen=True)
class PlaygroundBootstrapPlan:
    repo_root: Path
    runtime_root: Path
    env: str
    namespace: str
    kubeconfig: Path
    mysql_host: str
    revision: str
    runtime_revision: str
    grants: tuple[DatabaseGrant, ...]
    db_jobs: tuple[tuple[str, str], ...]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Diagnose whether a playground environment is wired through GitOps catalog, "
            "ApplicationSet, Argo live apps, and optionally Kubernetes pods."
        )
    )
    parser.add_argument("--repo-root", type=Path, default=Path("."))
    parser.add_argument("--env", default="sandbox-bj-3")
    parser.add_argument("--gitops-ref", default="origin/gitops")
    parser.add_argument("--source-ref", default="origin/master")
    parser.add_argument("--fetch", action="store_true", help="Fetch origin refs before reading source/gitops state.")
    parser.add_argument("--appset-path", default=DEFAULT_APPSET_PATH)
    parser.add_argument("--playground-root", default=DEFAULT_PLAYGROUND_ROOT)
    parser.add_argument("--root-app", default=DEFAULT_ROOT_APP)
    parser.add_argument("--argocd-base-url")
    parser.add_argument("--argocd-username")
    parser.add_argument("--argocd-password")
    parser.add_argument("--argocd-insecure-skip-verify", action="store_true")
    parser.add_argument("--refresh-argocd", action="store_true")
    parser.add_argument("--skip-argocd", action="store_true")
    parser.add_argument("--kubeconfig")
    parser.add_argument("--namespace")
    parser.add_argument("--skip-kubernetes", action="store_true")
    return parser.parse_args()


def parse_create_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Create a GitOps-only playground environment by cloning an existing playground render closure. "
            "Default mode is dry-run; pass --write to modify files."
        )
    )
    parser.add_argument("--repo-root", type=Path, default=Path("."))
    parser.add_argument("--from-env", default=DEFAULT_FROM_ENV)
    parser.add_argument("--to-env", required=True)
    parser.add_argument("--playground-root", default=DEFAULT_PLAYGROUND_ROOT)
    parser.add_argument("--cluster-name", default=DEFAULT_CLUSTER_NAME)
    parser.add_argument("--project", default=DEFAULT_PROJECT)
    parser.add_argument("--namespace")
    parser.add_argument("--api-host")
    parser.add_argument("--sandbox-host")
    parser.add_argument("--wildcard-host")
    parser.add_argument("--write", action="store_true", help="Write generated GitOps files. Default is dry-run.")
    parser.add_argument("--force", action="store_true", help="Overwrite existing target files.")
    return parser.parse_args(argv)


def parse_bootstrap_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Bootstrap a playground environment after GitOps creates it: create DBs/grants, "
            "run controlled DB jobs, restart workloads, and print a final diagnostic. "
            "Default mode is dry-run; pass --apply for live changes."
        )
    )
    parser.add_argument("--repo-root", type=Path, default=Path("."))
    parser.add_argument(
        "--runtime-root",
        type=Path,
        help="Checkout that contains .ci/runtime and repo-backed migration payloads. Defaults to --repo-root.",
    )
    parser.add_argument("--env", required=True, help="Playground env, e.g. sandbox-bj-4")
    parser.add_argument("--namespace")
    parser.add_argument("--kubeconfig", type=Path)
    parser.add_argument("--mysql-host", default="")
    parser.add_argument("--revision", default="")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--skip-db-bootstrap", action="store_true")
    parser.add_argument("--skip-db-job", action="append", default=[], help="Skip service/operation, e.g. ctl/migration")
    parser.add_argument("--skip-restart", action="store_true")
    parser.add_argument("--timeout-seconds", type=int, default=900)
    parser.add_argument("--kubectl-retries", type=int, default=3)
    return parser.parse_args(argv)


def parse_contract_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Check a playground environment contract before or after GitOps merge. "
            "Default checks are local/static and safe for CI. DNS/TLS/HTTP probes are opt-in."
        )
    )
    parser.add_argument("--repo-root", type=Path, default=Path("."))
    parser.add_argument("--env", required=True, help="Playground env, e.g. sandbox-bj-5")
    parser.add_argument("--playground-root", default=DEFAULT_PLAYGROUND_ROOT)
    parser.add_argument("--namespace")
    parser.add_argument("--cluster-name", default=DEFAULT_CLUSTER_NAME)
    parser.add_argument("--project", default=DEFAULT_PROJECT)
    parser.add_argument("--check-dns", action="store_true")
    parser.add_argument("--check-tls", action="store_true")
    parser.add_argument("--check-http", action="store_true")
    parser.add_argument("--timeout-seconds", type=float, default=8.0)
    return parser.parse_args(argv)


def fetch_origin_refs(repo_root: Path, refs: Sequence[str]) -> CheckResult:
    branches = sorted({ref.split("/", 1)[1] for ref in refs if ref.startswith("origin/") and "/" in ref})
    if not branches:
        return CheckResult("Git refs refresh", "warn", ("no origin/* refs found; skipped fetch",))
    try:
        git_run(repo_root, "fetch", "origin", *branches)
    except subprocess.CalledProcessError as exc:
        return CheckResult(
            "Git refs refresh",
            "warn",
            (f"git fetch origin {' '.join(branches)} failed: {exc}",),
            ("手动确认本地 refs 是否最新；旧 refs 会导致诊断结论过期。",),
        )
    return CheckResult("Git refs refresh", "ok", (f"fetched origin {' '.join(branches)}",))


def catalog_dir(playground_root: str, env: str) -> str:
    return f"{playground_root.rstrip('/')}/{env}"


def env_slug(env: str) -> str:
    return env.replace("-", "_")


def ctl_database_name(env: str) -> str:
    if re.fullmatch(r"sandbox-(bj|kr)-\d+", env):
        return f"ctl_{env_slug(env)}"
    return "ctl"


def playground_database_grants(env: str) -> tuple[DatabaseGrant, ...]:
    slug = env_slug(env)
    return (
        DatabaseGrant(f"ctl_{slug}", None, None, None),
        DatabaseGrant(f"lightclaw_auth_{slug}", "lightclaw_auth", "lightclaw-auth-secrets", "LIGHTCLAW_AUTH_DB_PASSWORD"),
        DatabaseGrant(f"lightclaw_payment_{slug}", "lightclaw_payment", "payment-runtime-secrets", "PAYMENT_DB_PASSWORD"),
        DatabaseGrant(f"ai_gateway_{slug}", "ai_gateway", "ai-gateway-runtime-secrets", "AI_GATEWAY_DB_PASSWORD"),
        DatabaseGrant(
            f"lightclaw_subscription_{slug}",
            "lightclaw_subscription",
            "subscription-runtime-secrets",
            "SUBSCRIPTION_DB_PASSWORD",
        ),
        DatabaseGrant(f"cvm_{slug}", None, "sandbox-runtime-secrets", "MYSQL_PASSWORD"),
    )


def default_namespace(env: str) -> str:
    return f"lightvela-playground-{env}"


def default_api_host(env: str) -> str:
    return f"api-{env}.{LIGHTCLAW_DOMAIN}"


def default_admin_host(env: str) -> str:
    return f"admin-{env}.{LIGHTCLAW_DOMAIN}"


def default_frontend_host(env: str) -> str:
    return f"frontend.{env}.{LIGHTCLAW_DOMAIN}"


def default_sandbox_host(env: str) -> str:
    return f"{env}.{LIGHTCLAW_DOMAIN}"


def default_wildcard_host(env: str) -> str:
    return f"*.{default_sandbox_host(env)}"


def local_mysql_host(namespace: str) -> str:
    return f"mysql.{namespace}.svc.cluster.local"


def local_redis_addr(namespace: str) -> str:
    return f"redis.{namespace}.svc.cluster.local:6379"


def runtime_secret_target(plan: PlaygroundClonePlan) -> Path:
    return plan.repo_root / "argocd/secrets" / plan.to_env / PLAYGROUND_RUNTIME_SECRET_FILE


def runtime_secret_generator_target(plan: PlaygroundClonePlan) -> Path:
    return plan.repo_root / "argocd/services/env-bootstrap" / plan.to_env / PLAYGROUND_RUNTIME_KSOPS_GENERATOR


def tls_secret_name_for_host(host: str) -> str:
    return f"{host.replace('*.', '').replace('.', '-')}-wildcard-tls"


def host_to_secret_stem(host: str) -> str:
    return host.replace("*.", "").replace(".", "-")


def legacy_playground_domain_aliases(env: str) -> tuple[str, ...]:
    """Return legacy short playground domains such as sandbox-bj83 for sandbox-bj-3."""

    match = re.fullmatch(r"sandbox-bj-(\d+)", env)
    if not match:
        return ()
    return (f"sandbox-bj8{match.group(1)}.{LIGHTCLAW_DOMAIN}",)


def legacy_playground_api_aliases(env: str) -> tuple[str, ...]:
    match = re.fullmatch(r"sandbox-bj-(\d+)", env)
    if not match:
        return ()
    return (f"api-bj8{match.group(1)}.{LIGHTCLAW_DOMAIN}",)


def legacy_playground_admin_aliases(env: str) -> tuple[str, ...]:
    match = re.fullmatch(r"sandbox-bj-(\d+)", env)
    if not match:
        return ()
    return (f"admin-bj8{match.group(1)}.{LIGHTCLAW_DOMAIN}",)


def legacy_playground_frontend_aliases(env: str) -> tuple[str, ...]:
    match = re.fullmatch(r"sandbox-bj-(\d+)", env)
    if not match:
        return ()
    return (f"bj8{match.group(1)}.lightclaw.pages.dev",)


def source_domain_replacements(from_env: str, to_plan: PlaygroundClonePlan | None = None) -> tuple[tuple[str, str], ...]:
    if to_plan is None:
        return ()
    replacements: list[tuple[str, str]] = [
        (default_api_host(from_env), to_plan.api_host),
        (default_sandbox_host(from_env), to_plan.sandbox_host),
        (default_wildcard_host(from_env), to_plan.wildcard_host),
        (tls_secret_name_for_host(default_sandbox_host(from_env)), to_plan.tls_secret_name),
    ]
    for alias in legacy_playground_domain_aliases(from_env):
        replacements.extend(
            [
                (f"*.{alias}", to_plan.wildcard_host),
                (alias, to_plan.sandbox_host),
                (tls_secret_name_for_host(alias), to_plan.tls_secret_name),
            ]
        )
    for alias in legacy_playground_api_aliases(from_env):
        replacements.extend(
            [
                (alias, to_plan.api_host),
                (f"{host_to_secret_stem(alias)}-tls", f"{host_to_secret_stem(to_plan.api_host)}-tls"),
            ]
        )
    for alias in legacy_playground_admin_aliases(from_env):
        replacements.extend(
            [
                (alias, default_admin_host(to_plan.to_env)),
                (
                    f"{host_to_secret_stem(alias)}-tls",
                    f"{host_to_secret_stem(default_admin_host(to_plan.to_env))}-tls",
                ),
            ]
        )
    for alias in legacy_playground_frontend_aliases(from_env):
        replacements.append((alias, default_frontend_host(to_plan.to_env)))
    return tuple(replacements)


def collect_files_under(root: Path) -> list[Path]:
    return sorted(path for path in root.rglob("*") if path.is_file())


def playground_gitops_checkout_hint(
    repo_root: Path,
    from_env: str,
    playground_root: str = DEFAULT_PLAYGROUND_ROOT,
) -> str:
    catalog_source = repo_root / catalog_dir(playground_root, from_env)
    return "\n".join(
        [
            f"missing source catalog directory: {catalog_source}",
            "不能在 master 源码 checkout 里直接跑默认命令，因为 playground GitOps 模板只在 origin/gitops，不在 master。",
            "请使用 GitOps checkout 作为 --repo-root，或者使用 wrapper 自动创建临时 GitOps worktree：",
            "  git fetch origin gitops",
            "  git worktree add --detach /tmp/mono2-gitops origin/gitops",
            f"  python3 .ci/runtime/commands/create_playground_environment.py --repo-root /tmp/mono2-gitops --from-env {from_env} --to-env <sandbox-bj-N>",
            "或直接执行：",
            f"  .ci/runtime/create_playground_from_gitops.sh --from-env {from_env} --to-env <sandbox-bj-N>",
        ]
    )


def build_playground_clone_plan(
    repo_root: Path,
    from_env: str,
    to_env: str,
    playground_root: str = DEFAULT_PLAYGROUND_ROOT,
    cluster_name: str = DEFAULT_CLUSTER_NAME,
    project: str = DEFAULT_PROJECT,
    namespace: str | None = None,
    api_host: str | None = None,
    sandbox_host: str | None = None,
    wildcard_host: str | None = None,
) -> PlaygroundClonePlan:
    repo_root = repo_root.resolve()
    namespace = namespace or default_namespace(to_env)
    sandbox_host = sandbox_host or default_sandbox_host(to_env)
    wildcard_host = wildcard_host or default_wildcard_host(to_env)
    api_host = api_host or default_api_host(to_env)
    tls_secret_name = tls_secret_name_for_host(sandbox_host)

    catalog_source = repo_root / catalog_dir(playground_root, from_env)
    secret_source = repo_root / "argocd/secrets" / from_env
    if not catalog_source.is_dir():
        raise FileNotFoundError(playground_gitops_checkout_hint(repo_root, from_env, playground_root))
    if not secret_source.is_dir():
        raise FileNotFoundError(f"missing source secret directory: {secret_source}")

    files: list[CloneFile] = []
    for source in collect_files_under(catalog_source):
        rel = source.relative_to(catalog_source)
        files.append(CloneFile(source, repo_root / catalog_dir(playground_root, to_env) / rel))

    service_dirs = sorted((repo_root / "argocd/services").glob(f"*/{from_env}"))
    if not service_dirs:
        raise FileNotFoundError(f"no source service directories found for {from_env}")
    for service_dir in service_dirs:
        service = service_dir.parent.name
        for source in collect_files_under(service_dir):
            rel = source.relative_to(service_dir)
            files.append(CloneFile(source, repo_root / "argocd/services" / service / to_env / rel))

    for source in collect_files_under(secret_source):
        rel = source.relative_to(secret_source)
        files.append(CloneFile(source, repo_root / "argocd/secrets" / to_env / rel))

    placeholder_plan = PlaygroundClonePlan(
        repo_root=repo_root,
        from_env=from_env,
        to_env=to_env,
        playground_root=playground_root,
        cluster_name=cluster_name,
        project=project,
        namespace=namespace,
        api_host=api_host,
        sandbox_host=sandbox_host,
        wildcard_host=wildcard_host,
        tls_secret_name=tls_secret_name,
        files=tuple(files),
        replacements=(),
    )
    replacements = [
        (default_namespace(from_env), namespace),
        (from_env, to_env),
        (env_slug(from_env), env_slug(to_env)),
        *source_domain_replacements(from_env, placeholder_plan),
    ]
    # Longer keys first avoids replacing sandbox-bj-3 before *.sandbox-bj83 aliases.
    replacements = sorted(dict(replacements).items(), key=lambda item: len(item[0]), reverse=True)
    return PlaygroundClonePlan(
        repo_root=repo_root,
        from_env=from_env,
        to_env=to_env,
        playground_root=playground_root,
        cluster_name=cluster_name,
        project=project,
        namespace=namespace,
        api_host=api_host,
        sandbox_host=sandbox_host,
        wildcard_host=wildcard_host,
        tls_secret_name=tls_secret_name,
        files=tuple(files),
        replacements=tuple(replacements),
    )


def render_clone_text(
    text: str,
    plan: PlaygroundClonePlan,
    runtime_values: PlaygroundRuntimeSecretValues | None = None,
) -> str:
    for old, new in plan.replacements:
        text = text.replace(old, new)
    text = apply_playground_runtime_overrides(text, plan)
    if runtime_values is not None:
        text = apply_ctl_runtime_overrides(text, plan, runtime_values)
    return "\n".join(line.rstrip() for line in text.splitlines()) + ("\n" if text.endswith("\n") else "")


def apply_playground_runtime_overrides(text: str, plan: PlaygroundClonePlan) -> str:
    """Point cloned playground services at namespace-local stateful dependencies."""

    mysql_host = local_mysql_host(plan.namespace)
    redis_addr = local_redis_addr(plan.namespace)
    text = re.sub(
        r"(?m)^([A-Z0-9_]*MYSQL_HOST=).*$",
        rf"\g<1>{mysql_host}",
        text,
    )
    text = re.sub(
        r"(?m)^([A-Z0-9_]*REDIS_ADDR=).*$",
        rf"\g<1>{redis_addr}",
        text,
    )
    text = re.sub(
        r"(?m)^(\s*[A-Z0-9_]*MYSQL_HOST:\s*).*$",
        rf"\g<1>{mysql_host}",
        text,
    )
    text = re.sub(
        r"(?m)^(\s*[A-Z0-9_]*REDIS_ADDR:\s*).*$",
        rf"\g<1>{redis_addr}",
        text,
    )
    return text


def apply_ctl_runtime_overrides(
    text: str,
    plan: PlaygroundClonePlan,
    runtime_values: PlaygroundRuntimeSecretValues,
) -> str:
    if "server_conf_rewrite.toml" not in text:
        return text
    mysql_host = local_mysql_host(plan.namespace)
    redis_host = f"redis.{plan.namespace}.svc.cluster.local"
    db_password = ctl_legacy_aes_encrypt(runtime_values.mysql_root_password)
    redis_password = ctl_legacy_aes_encrypt(runtime_values.redis_password)
    section = ""
    lines: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            section = stripped.strip("[]")
        prefix = line[: len(line) - len(line.lstrip())]
        if section == "db" and stripped.startswith("host ="):
            line = f'{prefix}host = "{mysql_host}"'
        elif section == "db" and stripped.startswith("password ="):
            line = f'{prefix}password = "{db_password}"'
        elif section == "redis" and stripped.startswith("host ="):
            line = f'{prefix}host = "{redis_host}"'
        elif section == "redis" and stripped.startswith("pass ="):
            line = f'{prefix}pass = "{redis_password}"'
        lines.append(line)
    return "\n".join(lines) + ("\n" if text.endswith("\n") else "")


def ctl_legacy_aes_encrypt(value: str) -> str:
    openssl = shutil.which("openssl")
    if not openssl:
        raise RuntimeError("missing required command: openssl")
    # Matches ctl/pkg/util/cipher.go: AES-256-CBC, PKCS7 padding, using ASCII md5 hex strings as key/IV bytes.
    result = run_command(
        [
            openssl,
            "enc",
            "-aes-256-cbc",
            "-K",
            "6661643063653232316338323665656465323533636230393536636130373030",
            "-iv",
            "39396330303737653132303961366166",
            "-base64",
            "-A",
        ],
        input=value,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ctl legacy AES encrypt failed: {result.stderr.strip()}")
    return result.stdout.strip()


def render_clone_bytes(
    data: bytes,
    plan: PlaygroundClonePlan,
    runtime_values: PlaygroundRuntimeSecretValues | None = None,
) -> bytes:
    try:
        text = data.decode()
    except UnicodeDecodeError:
        return data
    return render_clone_text(text, plan, runtime_values).encode()


def render_catalog_bytes(
    data: bytes,
    plan: PlaygroundClonePlan,
    runtime_values: PlaygroundRuntimeSecretValues | None = None,
) -> bytes:
    text = render_clone_bytes(data, plan, runtime_values).decode()
    payload = yaml.safe_load(text) or {}
    if isinstance(payload, dict):
        payload["project"] = plan.project
        payload["destinationName"] = plan.cluster_name
        if "playgroundCluster" in payload:
            payload["playgroundCluster"] = plan.cluster_name
        text = yaml.safe_dump(payload, allow_unicode=True, sort_keys=False)
    return text.encode()


def render_sops_secret_bytes(
    data: bytes,
    plan: PlaygroundClonePlan,
    target_path: Path,
    runtime_values: PlaygroundRuntimeSecretValues | None = None,
) -> bytes:
    payload = yaml.safe_load(data.decode()) or {}
    if not isinstance(payload, dict):
        return data
    if runtime_values is not None:
        return render_kubernetes_sops_secret_bytes(data, plan, target_path, runtime_values)
    if payload.get("kind") != "Secret":
        return data
    metadata = payload.setdefault("metadata", {})
    if isinstance(metadata, dict):
        metadata["namespace"] = plan.namespace
        annotations = metadata.setdefault("annotations", {})
        if isinstance(annotations, dict):
            managed_by = str(annotations.get("managed-by") or "")
            annotations["managed-by"] = managed_by.replace(plan.from_env, plan.to_env) or f"harness-ci-{plan.to_env}-bootstrap"
    return yaml.safe_dump(payload, allow_unicode=True, sort_keys=False).encode()


def render_kubernetes_sops_secret_bytes(
    data: bytes,
    plan: PlaygroundClonePlan,
    target_path: Path,
    runtime_values: PlaygroundRuntimeSecretValues,
) -> bytes:
    plaintext = decrypt_sops_yaml_bytes(data)
    if not isinstance(plaintext, dict) or plaintext.get("kind") != "Secret":
        return data
    metadata = plaintext.setdefault("metadata", {})
    if isinstance(metadata, dict):
        metadata["namespace"] = plan.namespace
        annotations = metadata.setdefault("annotations", {})
        if isinstance(annotations, dict):
            managed_by = str(annotations.get("managed-by") or "")
            annotations["managed-by"] = managed_by.replace(plan.from_env, plan.to_env) or f"harness-ci-{plan.to_env}-bootstrap"
    apply_runtime_secret_value_overrides(plaintext, target_path, runtime_values)
    recipients = age_recipients_from_sops_payload(yaml.safe_load(data.decode()) or {})
    return encrypt_sops_yaml_bytes(plaintext, recipients, target_path.relative_to(plan.repo_root).as_posix())


def apply_runtime_secret_value_overrides(
    payload: dict[str, Any],
    target_path: Path,
    runtime_values: PlaygroundRuntimeSecretValues,
) -> None:
    if target_path.name == "sandbox-runtime-secrets.sops.yaml":
        set_secret_value(payload, "MYSQL_PASSWORD", runtime_values.mysql_root_password)
    set_secret_value(payload, "REDIS_PASSWORD", runtime_values.redis_password)


def set_secret_value(payload: dict[str, Any], key: str, value: str) -> None:
    string_data = payload.get("stringData")
    if isinstance(string_data, dict) and key in string_data:
        string_data[key] = value
        return
    data = payload.get("data")
    if isinstance(data, dict) and key in data:
        data[key] = base64.b64encode(value.encode()).decode()


def decrypt_sops_yaml_bytes(data: bytes) -> dict[str, Any]:
    sops_bin = shutil.which("sops")
    if not sops_bin:
        raise RuntimeError("missing required command: sops")
    key_file, temp_key_file = resolve_sops_age_key_file()
    env = os.environ.copy()
    env["SOPS_AGE_KEY_FILE"] = str(key_file)
    env.pop("SOPS_AGE_KEY", None)
    try:
        result = run_command(
            [sops_bin, "--decrypt", "--input-type", "yaml", "--output-type", "yaml", "/dev/stdin"],
            input=data,
            capture_output=True,
            env=env,
        )
    finally:
        if temp_key_file is not None:
            temp_key_file.unlink(missing_ok=True)
    if result.returncode != 0:
        raise RuntimeError(f"sops decrypt failed: {result.stderr.decode(errors='replace').strip()}")
    payload = yaml.safe_load(result.stdout.decode()) or {}
    if not isinstance(payload, dict):
        raise ValueError("decrypted SOPS payload is not a YAML mapping")
    return payload


def encrypt_sops_yaml_bytes(payload: dict[str, Any], recipients: Sequence[str], filename_override: str) -> bytes:
    sops_bin = shutil.which("sops")
    if not sops_bin:
        raise RuntimeError("missing required command: sops")
    if not recipients:
        raise RuntimeError(f"missing SOPS age recipient for {filename_override}")
    key_file, temp_key_file = resolve_sops_age_key_file()
    plaintext = yaml.safe_dump(payload, allow_unicode=True, sort_keys=False)
    cmd = [
        sops_bin,
        "--encrypt",
        "--input-type",
        "yaml",
        "--output-type",
        "yaml",
        "--filename-override",
        filename_override,
        "--age",
        ",".join(recipients),
        "/dev/stdin",
    ]
    env = os.environ.copy()
    env["SOPS_AGE_KEY_FILE"] = str(key_file)
    env.pop("SOPS_AGE_KEY", None)
    try:
        result = run_command(cmd, input=plaintext.encode(), capture_output=True, env=env)
    finally:
        if temp_key_file is not None:
            temp_key_file.unlink(missing_ok=True)
    if result.returncode != 0:
        raise RuntimeError(f"sops encrypt failed: {result.stderr.decode(errors='replace').strip()}")
    return result.stdout


def generated_playground_files(plan: PlaygroundClonePlan) -> tuple[GeneratedFile, ...]:
    return (
        GeneratedFile(
            plan.repo_root / catalog_dir(plan.playground_root, plan.to_env) / "env-bootstrap.yaml",
            env_bootstrap_catalog_text(plan),
        ),
        GeneratedFile(
            plan.repo_root / "argocd/services/env-bootstrap" / plan.to_env / "kustomization.yaml",
            env_bootstrap_kustomization_text(plan),
        ),
        GeneratedFile(
            runtime_secret_generator_target(plan),
            env_bootstrap_runtime_secret_generator_text(plan),
        ),
        GeneratedFile(
            plan.repo_root / "argocd/services/env-bootstrap" / plan.to_env / "namespace.yaml",
            env_bootstrap_namespace_text(plan),
        ),
        GeneratedFile(
            plan.repo_root / "argocd/services/env-bootstrap" / plan.to_env / "serviceaccount.yaml",
            env_bootstrap_serviceaccount_text(plan),
        ),
        GeneratedFile(
            plan.repo_root / "argocd/services/env-bootstrap" / plan.to_env / "mysql.yaml",
            mysql_stateful_runtime_text(plan),
        ),
        GeneratedFile(
            plan.repo_root / "argocd/services/env-bootstrap" / plan.to_env / "redis.yaml",
            redis_stateful_runtime_text(plan),
        ),
    )


def env_bootstrap_catalog_text(plan: PlaygroundClonePlan) -> str:
    return yaml.safe_dump(
        {
            "service": "env-bootstrap",
            "env": plan.to_env,
            "project": plan.project,
            "destinationName": plan.cluster_name,
            "namespace": plan.namespace,
            "sourcePath": f"argocd/services/env-bootstrap/{plan.to_env}",
            "environmentModel": "playground",
            "playgroundCluster": plan.cluster_name,
        },
        allow_unicode=True,
        sort_keys=False,
    )


def env_bootstrap_kustomization_text(plan: PlaygroundClonePlan) -> str:
    resources = ["namespace.yaml", "serviceaccount.yaml", "mysql.yaml", "redis.yaml"]
    generators = [PLAYGROUND_RUNTIME_KSOPS_GENERATOR]
    if any(item.target.name == "ksops-pull-secret-generator.yaml" for item in plan.files):
        generators.insert(0, "ksops-pull-secret-generator.yaml")
    return yaml.safe_dump(
        {
            "apiVersion": "kustomize.config.k8s.io/v1beta1",
            "kind": "Kustomization",
            "namespace": plan.namespace,
            "resources": resources,
            "generators": generators,
        },
        allow_unicode=True,
        sort_keys=False,
    )


def env_bootstrap_runtime_secret_generator_text(plan: PlaygroundClonePlan) -> str:
    return yaml.safe_dump(
        {
            "apiVersion": "viaduct.ai/v1",
            "kind": "ksops",
            "metadata": {"name": PLAYGROUND_RUNTIME_SECRET_NAME},
            "files": [f"../../../secrets/{plan.to_env}/{PLAYGROUND_RUNTIME_SECRET_FILE}"],
        },
        allow_unicode=True,
        sort_keys=False,
    )


def env_bootstrap_namespace_text(plan: PlaygroundClonePlan) -> str:
    return yaml.safe_dump(
        {
            "apiVersion": "v1",
            "kind": "Namespace",
            "metadata": {
                "name": plan.namespace,
                "labels": {
                    "lightclaw.dev/environment-model": "playground",
                    "lightclaw.dev/environment-name": plan.to_env,
                },
            },
        },
        allow_unicode=True,
        sort_keys=False,
    )


def env_bootstrap_serviceaccount_text(plan: PlaygroundClonePlan) -> str:
    return yaml.safe_dump(
        {
            "apiVersion": "v1",
            "kind": "ServiceAccount",
            "metadata": {
                "name": "default",
                "namespace": plan.namespace,
            },
            "imagePullSecrets": [{"name": name} for name in PLAYGROUND_PULL_SECRET_NAMES],
        },
        allow_unicode=True,
        sort_keys=False,
    )


def mysql_stateful_runtime_text(plan: PlaygroundClonePlan) -> str:
    return yaml.safe_dump_all(
        [
            {
                "apiVersion": "v1",
                "kind": "Service",
                "metadata": {"name": "mysql", "labels": {"app": "mysql"}},
                "spec": {
                    "clusterIP": "None",
                    "ports": [{"name": "mysql", "port": 3306, "targetPort": 3306}],
                    "selector": {"app": "mysql"},
                },
            },
            {
                "apiVersion": "apps/v1",
                "kind": "StatefulSet",
                "metadata": {"name": "mysql", "labels": {"app": "mysql"}},
                "spec": {
                    "serviceName": "mysql",
                    "replicas": 1,
                    "selector": {"matchLabels": {"app": "mysql"}},
                    "template": {
                        "metadata": {"labels": {"app": "mysql"}},
                        "spec": {
                            "containers": [
                                {
                                    "name": "mysql",
                                    "image": "mysql:8.0",
                                    "args": [
                                        "--character-set-server=utf8mb4",
                                        "--collation-server=utf8mb4_unicode_ci",
                                        "--default-authentication-plugin=mysql_native_password",
                                    ],
                                    "ports": [{"name": "mysql", "containerPort": 3306}],
                                    "env": [
                                        {
                                            "name": "MYSQL_ROOT_PASSWORD",
                                            "valueFrom": {
                                                "secretKeyRef": {
                                                    "name": PLAYGROUND_RUNTIME_SECRET_NAME,
                                                    "key": "MYSQL_ROOT_PASSWORD",
                                                }
                                            },
                                        },
                                        {"name": "MYSQL_ROOT_HOST", "value": "%"},
                                    ],
                                    "volumeMounts": [{"name": "mysql-data", "mountPath": "/var/lib/mysql"}],
                                    "readinessProbe": {
                                        "tcpSocket": {"port": 3306},
                                        "initialDelaySeconds": 10,
                                        "periodSeconds": 5,
                                    },
                                    "resources": {
                                        "requests": {"cpu": "100m", "memory": "256Mi"},
                                        "limits": {"cpu": "1000m", "memory": "1Gi"},
                                    },
                                }
                            ]
                        },
                    },
                    "volumeClaimTemplates": [
                        {
                            "metadata": {"name": "mysql-data"},
                            "spec": {
                                "accessModes": ["ReadWriteOnce"],
                                "resources": {"requests": {"storage": "20Gi"}},
                            },
                        }
                    ],
                },
            },
        ],
        allow_unicode=True,
        sort_keys=False,
    )


def redis_stateful_runtime_text(plan: PlaygroundClonePlan) -> str:
    return yaml.safe_dump_all(
        [
            {
                "apiVersion": "v1",
                "kind": "Service",
                "metadata": {"name": "redis", "labels": {"app": "redis"}},
                "spec": {
                    "clusterIP": "None",
                    "ports": [{"name": "redis", "port": 6379, "targetPort": 6379}],
                    "selector": {"app": "redis"},
                },
            },
            {
                "apiVersion": "apps/v1",
                "kind": "StatefulSet",
                "metadata": {"name": "redis", "labels": {"app": "redis"}},
                "spec": {
                    "serviceName": "redis",
                    "replicas": 1,
                    "selector": {"matchLabels": {"app": "redis"}},
                    "template": {
                        "metadata": {"labels": {"app": "redis"}},
                        "spec": {
                            "containers": [
                                {
                                    "name": "redis",
                                    "image": "redis:7-alpine",
                                    "ports": [{"name": "redis", "containerPort": 6379}],
                                    "env": [
                                        {
                                            "name": "REDIS_PASSWORD",
                                            "valueFrom": {
                                                "secretKeyRef": {
                                                    "name": PLAYGROUND_RUNTIME_SECRET_NAME,
                                                    "key": "REDIS_PASSWORD",
                                                }
                                            },
                                        }
                                    ],
                                    "command": ["/bin/sh", "-ec"],
                                    "args": [
                                        'exec redis-server --appendonly yes --requirepass "$REDIS_PASSWORD"'
                                    ],
                                    "volumeMounts": [{"name": "redis-data", "mountPath": "/data"}],
                                    "readinessProbe": {
                                        "tcpSocket": {"port": 6379},
                                        "initialDelaySeconds": 5,
                                        "periodSeconds": 5,
                                    },
                                    "resources": {
                                        "requests": {"cpu": "50m", "memory": "128Mi"},
                                        "limits": {"cpu": "500m", "memory": "512Mi"},
                                    },
                                }
                            ]
                        },
                    },
                    "volumeClaimTemplates": [
                        {
                            "metadata": {"name": "redis-data"},
                            "spec": {
                                "accessModes": ["ReadWriteOnce"],
                                "resources": {"requests": {"storage": "10Gi"}},
                            },
                        }
                    ],
                },
            },
        ],
        allow_unicode=True,
        sort_keys=False,
    )


def all_plan_targets(plan: PlaygroundClonePlan) -> tuple[Path, ...]:
    return (
        tuple(item.target for item in plan.files)
        + tuple(item.target for item in generated_playground_files(plan))
        + (runtime_secret_target(plan),)
    )


def target_conflicts(plan: PlaygroundClonePlan) -> list[Path]:
    return sorted({path for path in all_plan_targets(plan) if path.exists()})


def validate_clone_plan(plan: PlaygroundClonePlan) -> list[str]:
    errors: list[str] = []
    generated_files = generated_playground_files(plan)
    catalog_targets = [
        path
        for path in all_plan_targets(plan)
        if f"/{plan.playground_root.rstrip('/')}/{plan.to_env}/" in path.as_posix()
    ]
    service_targets = [
        path
        for path in all_plan_targets(plan)
        if f"/argocd/services/" in path.as_posix() and f"/{plan.to_env}/" in path.as_posix()
    ]
    secret_targets = [path for path in all_plan_targets(plan) if f"/argocd/secrets/{plan.to_env}/" in path.as_posix()]
    if not catalog_targets:
        errors.append("no catalog files would be generated")
    if not service_targets:
        errors.append("no service sourcePath files would be generated")
    if not secret_targets:
        errors.append("no secret files would be copied")
    service_dirs = {
        path.parent.relative_to(plan.repo_root).as_posix()
        for path in service_targets
        if path.name == "kustomization.yaml"
    }
    source_residue_tokens = [
        plan.from_env,
        env_slug(plan.from_env),
        default_namespace(plan.from_env),
        *legacy_playground_domain_aliases(plan.from_env),
        *legacy_playground_api_aliases(plan.from_env),
    ]
    short_env_match = re.fullmatch(r"sandbox-bj-(\d+)", plan.from_env)
    if short_env_match:
        source_residue_tokens.append(f"bj8{short_env_match.group(1)}")
    rendered_items: list[tuple[Path, str]] = []
    for item in plan.files:
        if item.source.name.endswith(".sops.yaml"):
            continue
        try:
            rendered_items.append(
                (
                    item.target,
                    (
                        render_catalog_bytes(item.source.read_bytes(), plan).decode()
                        if f"/{plan.playground_root.rstrip('/')}/{plan.from_env}/" in item.source.as_posix()
                        else render_clone_bytes(item.source.read_bytes(), plan).decode()
                    ),
                )
            )
        except UnicodeDecodeError:
            continue
    rendered_items.extend((item.target, item.text) for item in generated_files)
    latest_rendered = {target: rendered for target, rendered in rendered_items}
    for target, rendered in latest_rendered.items():
        for token in source_residue_tokens:
            if token and token in rendered:
                errors.append(
                    f"{target.relative_to(plan.repo_root)} still contains source environment residue {token!r}"
                )
                break
        if f"/{plan.playground_root.rstrip('/')}/{plan.to_env}/" in target.as_posix():
            try:
                payload = load_yaml_mapping(rendered, target.as_posix())
            except ValueError as exc:
                errors.append(str(exc))
                continue
            if payload.get("env") != plan.to_env:
                errors.append(f"{target.relative_to(plan.repo_root)} env must be {plan.to_env}")
            if payload.get("namespace") != plan.namespace:
                errors.append(f"{target.relative_to(plan.repo_root)} namespace must be {plan.namespace}")
            if payload.get("project") != plan.project:
                errors.append(f"{target.relative_to(plan.repo_root)} project must be {plan.project}")
            if payload.get("destinationName") != plan.cluster_name:
                errors.append(f"{target.relative_to(plan.repo_root)} destinationName must be {plan.cluster_name}")
            source_path = str(payload.get("sourcePath") or "")
            if source_path not in service_dirs:
                errors.append(
                    f"{target.relative_to(plan.repo_root)} sourcePath {source_path!r} is not in generated service dirs"
                )
    return errors


def clone_plan_warnings(plan: PlaygroundClonePlan) -> list[str]:
    warnings: list[str] = []
    secret_count = sum(1 for item in plan.files if f"/argocd/secrets/{plan.to_env}/" in item.target.as_posix())
    if secret_count:
        warnings.append(
            "将复制并重新加密源环境 SOPS secret；脚本会改 metadata、Redis 密码，并把 sandbox MySQL 密码对齐到新环境 root 密码。强隔离环境必须重新生成 SSM/SOPS 后再发布。"
        )
    warnings.append(
        "将为目标环境生成新的最小 playground-runtime-secrets SOPS 文件，只包含 MYSQL_ROOT_PASSWORD/REDIS_PASSWORD；缺少 sops 或 age key 时 --write 会直接失败。"
    )
    if plan.tls_secret_name:
        warnings.append(
            f"计划替换 sandbox TLS secret 为 {plan.tls_secret_name}；只有证书 SAN 覆盖 {plan.wildcard_host} 时才应启用 wildcard HTTPS，否则保持 HTTP-only。"
        )
    warnings.append(
        "DNS、证书申请、qcloud cert id、Argo refresh 仍是外部动作；MySQL/Redis 运行时会进入 GitOps closure，DB schema bootstrap 仍需合入后执行。"
    )
    return warnings


def is_unexpanded_ci_setting(value: str) -> bool:
    stripped = value.strip()
    return stripped.startswith("${{") and stripped.endswith("}}")


def sops_age_key_file_candidates() -> tuple[Path, ...]:
    return (
        Path("/etc/lightclaw-ci/sops-age.keys.txt"),
        Path.home() / ".config/sops/age/keys.txt",
        Path("/.config/sops/age/keys.txt"),
    )


def resolve_sops_age_key_file() -> tuple[Path, Path | None]:
    env_key_file = os.environ.get("SOPS_AGE_KEY_FILE", "")
    env_key = os.environ.get("SOPS_AGE_KEY", "")
    if env_key_file and not is_unexpanded_ci_setting(env_key_file):
        path = Path(env_key_file)
        if not path.is_file():
            raise RuntimeError(f"SOPS_AGE_KEY_FILE is set but not readable: {env_key_file}")
        return path, None
    if env_key_file and is_unexpanded_ci_setting(env_key_file):
        env_key_file = ""

    for candidate in sops_age_key_file_candidates():
        if candidate.is_file():
            return candidate, None

    if env_key and not is_unexpanded_ci_setting(env_key):
        with tempfile.NamedTemporaryFile("w", prefix="lightclaw-sops-age.", delete=False) as handle:
            handle.write(env_key)
            handle.write("\n")
            handle.flush()
            temp_name = handle.name
        temp_path = Path(temp_name)
        temp_path.chmod(0o600)
        return temp_path, temp_path

    raise RuntimeError(
        "missing SOPS age key; set SOPS_AGE_KEY_FILE, provide /etc/lightclaw-ci/sops-age.keys.txt, "
        "provide ~/.config/sops/age/keys.txt, provide /.config/sops/age/keys.txt, or set SOPS_AGE_KEY"
    )


def sops_recipient_donor_paths(plan: PlaygroundClonePlan) -> tuple[Path, ...]:
    secret_root = plan.repo_root / "argocd/secrets" / plan.from_env
    preferred = (
        secret_root / PLAYGROUND_RUNTIME_SECRET_FILE,
        secret_root / "sandbox-runtime-secrets.sops.yaml",
    )
    others = tuple(sorted(path for path in secret_root.glob("*.sops.yaml") if path not in preferred))
    return (*preferred, *others)


def age_recipients_from_sops_file(path: Path) -> tuple[str, ...]:
    if not path.is_file():
        return ()
    payload = yaml.safe_load(path.read_text()) or {}
    return age_recipients_from_sops_payload(payload)


def age_recipients_from_sops_payload(payload: Any) -> tuple[str, ...]:
    if not isinstance(payload, dict):
        return ()
    sops = payload.get("sops") or {}
    if not isinstance(sops, dict):
        return ()
    recipients: list[str] = []
    for item in sops.get("age") or []:
        if isinstance(item, dict) and isinstance(item.get("recipient"), str):
            recipients.append(item["recipient"])
    return tuple(recipients)


def resolve_playground_runtime_recipients(plan: PlaygroundClonePlan) -> tuple[str, ...]:
    for donor in sops_recipient_donor_paths(plan):
        recipients = age_recipients_from_sops_file(donor)
        if recipients:
            return recipients
    searched = ", ".join(path.relative_to(plan.repo_root).as_posix() for path in sops_recipient_donor_paths(plan))
    raise RuntimeError(f"missing SOPS age recipient for {plan.from_env}; searched: {searched}")


def random_playground_password() -> str:
    return secrets.token_urlsafe(32)


def generate_playground_runtime_values() -> PlaygroundRuntimeSecretValues:
    return PlaygroundRuntimeSecretValues(
        mysql_root_password=random_playground_password(),
        redis_password=random_playground_password(),
    )


def playground_runtime_secret_plaintext(plan: PlaygroundClonePlan, values: PlaygroundRuntimeSecretValues) -> str:
    return yaml.safe_dump(
        {
            "apiVersion": "v1",
            "kind": "Secret",
            "metadata": {
                "name": PLAYGROUND_RUNTIME_SECRET_NAME,
                "namespace": plan.namespace,
                "labels": {
                    "lightclaw.dev/environment-model": "playground",
                    "lightclaw.dev/environment-name": plan.to_env,
                },
            },
            "type": "Opaque",
            "stringData": {
                "MYSQL_ROOT_PASSWORD": values.mysql_root_password,
                "REDIS_PASSWORD": values.redis_password,
            },
        },
        allow_unicode=True,
        sort_keys=False,
    )


def encrypt_playground_runtime_secret(
    plan: PlaygroundClonePlan,
    values: PlaygroundRuntimeSecretValues | None = None,
) -> bytes:
    sops_bin = shutil.which("sops")
    if not sops_bin:
        raise RuntimeError("missing required command: sops")
    recipients = resolve_playground_runtime_recipients(plan)
    key_file, temp_key_file = resolve_sops_age_key_file()
    plaintext = playground_runtime_secret_plaintext(plan, values or generate_playground_runtime_values())
    cmd = [
        sops_bin,
        "--encrypt",
        "--input-type",
        "yaml",
        "--output-type",
        "yaml",
        "--filename-override",
        runtime_secret_target(plan).relative_to(plan.repo_root).as_posix(),
        "--age",
        ",".join(recipients),
        "/dev/stdin",
    ]
    env = os.environ.copy()
    env["SOPS_AGE_KEY_FILE"] = str(key_file)
    env.pop("SOPS_AGE_KEY", None)
    try:
        result = run_command(cmd, input=plaintext, capture_output=True, text=True, env=env)
    finally:
        if temp_key_file is not None:
            temp_key_file.unlink(missing_ok=True)
    if result.returncode != 0:
        raise RuntimeError(f"sops encrypt failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}")
    return result.stdout.encode()


RuntimeSecretEncryptor = Callable[[PlaygroundClonePlan], bytes]


def rendered_clone_plan_files(
    plan: PlaygroundClonePlan,
    *,
    runtime_secret_encryptor: RuntimeSecretEncryptor | None = None,
) -> list[RenderedFile]:
    rendered: list[RenderedFile] = []
    runtime_values = generate_playground_runtime_values()
    for item in plan.files:
        if item.source.name.endswith(".sops.yaml"):
            sops_runtime_values = runtime_values if runtime_secret_encryptor is None else None
            data = render_sops_secret_bytes(item.source.read_bytes(), plan, item.target, sops_runtime_values)
        elif f"/{plan.playground_root.rstrip('/')}/{plan.from_env}/" in item.source.as_posix():
            data = render_catalog_bytes(item.source.read_bytes(), plan, runtime_values)
        else:
            data = render_clone_bytes(item.source.read_bytes(), plan, runtime_values)
        rendered.append(RenderedFile(item.target, data, item.source))
    for item in generated_playground_files(plan):
        rendered.append(RenderedFile(item.target, item.text.encode(), None))
    encryptor = runtime_secret_encryptor or encrypt_playground_runtime_secret
    if runtime_secret_encryptor is None:
        runtime_secret_data = encrypt_playground_runtime_secret(plan, runtime_values)
    else:
        runtime_secret_data = encryptor(plan)
    rendered.append(RenderedFile(runtime_secret_target(plan), runtime_secret_data, None))
    return rendered


def write_clone_plan(
    plan: PlaygroundClonePlan,
    *,
    force: bool = False,
    runtime_secret_encryptor: RuntimeSecretEncryptor | None = None,
) -> list[Path]:
    conflicts = target_conflicts(plan)
    if conflicts and not force:
        conflict_text = "\n".join(str(path.relative_to(plan.repo_root)) for path in conflicts[:50])
        raise FileExistsError(f"target files already exist; pass --force to overwrite:\n{conflict_text}")

    rendered_files = rendered_clone_plan_files(plan, runtime_secret_encryptor=runtime_secret_encryptor)
    written: list[Path] = []
    for item in rendered_files:
        item.target.parent.mkdir(parents=True, exist_ok=True)
        item.target.write_bytes(item.data)
        if item.mode_source is not None:
            shutil.copymode(item.mode_source, item.target, follow_symlinks=False)
        written.append(item.target)
    return written


def load_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def load_local_catalog_apps(repo_root: Path, catalog_path: str) -> list[CatalogApp]:
    catalog_root = repo_root / catalog_path
    if not catalog_root.is_dir():
        raise FileNotFoundError(f"missing local catalog directory: {catalog_path}")
    apps: list[CatalogApp] = []
    for path in sorted(catalog_root.glob("*.yaml")):
        payload = load_yaml_mapping(path.read_text(), path.as_posix())
        missing = [
            key
            for key in ("service", "env", "project", "destinationName", "namespace", "sourcePath")
            if not payload.get(key)
        ]
        if missing:
            raise ValueError(f"{path.relative_to(repo_root)} missing required fields: {', '.join(missing)}")
        service = str(payload["service"])
        env = str(payload["env"])
        apps.append(
            CatalogApp(
                app_name=f"{service}-{env}",
                service=service,
                env=env,
                project=str(payload["project"]),
                destination_name=str(payload["destinationName"]),
                namespace=str(payload["namespace"]),
                source_path=str(payload["sourcePath"]),
                catalog_file=path.relative_to(repo_root).as_posix(),
            )
        )
    return apps


def check_playground_catalog_contract(
    repo_root: Path,
    env: str,
    playground_root: str,
    namespace: str,
    project: str,
    cluster_name: str,
) -> tuple[CheckResult, list[CatalogApp]]:
    catalog_path = catalog_dir(playground_root, env)
    try:
        apps = load_local_catalog_apps(repo_root, catalog_path)
    except (FileNotFoundError, ValueError) as exc:
        return (
            CheckResult(
                "Playground catalog contract",
                "fail",
                (str(exc),),
                ("先用 create_playground_environment.py 生成 catalog，再提交 GitOps MR。",),
            ),
            [],
        )
    errors: list[str] = []
    services = sorted({app.service for app in apps})
    for app in apps:
        if app.env != env:
            errors.append(f"{app.catalog_file}: env={app.env}, expected={env}")
        if app.namespace != namespace:
            errors.append(f"{app.catalog_file}: namespace={app.namespace}, expected={namespace}")
        if app.project != project:
            errors.append(f"{app.catalog_file}: project={app.project}, expected={project}")
        if app.destination_name != cluster_name:
            errors.append(f"{app.catalog_file}: destinationName={app.destination_name}, expected={cluster_name}")
        source_path = repo_root / app.source_path
        if not source_path.is_dir():
            errors.append(f"{app.catalog_file}: sourcePath does not exist: {app.source_path}")
        if not app.source_path.endswith(f"/{env}"):
            errors.append(f"{app.catalog_file}: sourcePath must end with /{env}: {app.source_path}")
    if errors:
        return (
            CheckResult(
                "Playground catalog contract",
                "fail",
                tuple(errors),
                ("修复 catalog 的 env/namespace/project/destinationName/sourcePath 后重跑。",),
            ),
            apps,
        )
    return (
        CheckResult(
            "Playground catalog contract",
            "ok",
            (f"catalog apps={len(apps)} services={','.join(services)} namespace={namespace}",),
        ),
        apps,
    )


def public_service_source_paths(apps: Sequence[CatalogApp]) -> dict[str, str]:
    public_services = {"frontend", "service-gateway", "admin-gateway", "sandbox"}
    return {app.service: app.source_path for app in apps if app.service in public_services}


def source_path_contains(repo_root: Path, source_path: str, needle: str) -> bool:
    root = repo_root / source_path
    if not root.is_dir():
        return False
    for path in root.rglob("*"):
        if path.is_file() and needle in path.read_text(errors="ignore"):
            return True
    return False


def source_path_has_direct_access(repo_root: Path, source_path: str) -> bool:
    root = repo_root / source_path
    if not root.is_dir():
        return False
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        text = path.read_text(errors="ignore")
        if "direct-access" in text and ('value: "true"' in text or "value: 'true'" in text or "direct-access: \"true\"" in text):
            return True
    return False


def source_path_removes_sandbox_wildcard_tls(repo_root: Path, source_path: str) -> bool:
    root = repo_root / source_path
    if not root.is_dir():
        return False
    kustomization = root / "kustomization.yaml"
    if not kustomization.is_file():
        return False
    text = kustomization.read_text()
    return "path: /spec/tls" in text and "path: /spec/loadBalancer/l7Listeners/1" in text


def qcloud_cert_secret_files(repo_root: Path, source_path: str) -> list[str]:
    root = repo_root / source_path
    if not root.is_dir():
        return []
    files: list[str] = []
    for path in sorted(root.rglob("*.yaml")):
        if "qcloud_cert_id" in path.read_text(errors="ignore"):
            files.append(path.relative_to(repo_root).as_posix())
    return files


def is_encrypted_sops_scalar(value: Any) -> bool:
    return isinstance(value, str) and value.startswith("ENC[")


def pull_secret_name_from_path(path: Path) -> str:
    mapping = {
        "tcr-bj8-lightclaw-secret.sops.yaml": "tcr.bj8-lightclaw-secret",
        "tcr-ccr-clawhub-secret.sops.yaml": "tcr.ccr-clawhub-secret",
    }
    return mapping.get(path.name, "")


def check_playground_network_contract(repo_root: Path, env: str, apps: Sequence[CatalogApp]) -> CheckResult:
    expected_sandbox_host = default_sandbox_host(env)
    expected_wildcard_host = default_wildcard_host(env)
    sandbox_env_path = repo_root / "argocd/services/sandbox" / env / "sandbox-platform.env"
    sandbox_env = load_env_file(sandbox_env_path)
    errors: list[str] = []
    warnings: list[str] = []
    if not sandbox_env_path.is_file():
        errors.append(f"missing {sandbox_env_path.relative_to(repo_root)}")
    else:
        public_host = sandbox_env.get("SANDBOX_INGRESSPROXY_PUBLIC_HOST")
        healthcheck_host = sandbox_env.get("SANDBOX_INGRESSPROXY_HEALTHCHECK_HOST")
        tls_secret = sandbox_env.get("SANDBOX_INGRESSPROXY_TLS_SECRET_NAME")
        if public_host != expected_wildcard_host:
            errors.append(f"{sandbox_env_path.relative_to(repo_root)} SANDBOX_INGRESSPROXY_PUBLIC_HOST={public_host}, expected={expected_wildcard_host}")
        if healthcheck_host != expected_sandbox_host:
            errors.append(f"{sandbox_env_path.relative_to(repo_root)} SANDBOX_INGRESSPROXY_HEALTHCHECK_HOST={healthcheck_host}, expected={expected_sandbox_host}")
        sandbox_source_path = public_service_source_paths(apps).get("sandbox", "")
        if tls_secret and not source_path_removes_sandbox_wildcard_tls(repo_root, sandbox_source_path):
            warnings.append(
                f"{sandbox_env_path.relative_to(repo_root)} configures wildcard TLS secret {tls_secret}; verify cert SAN covers {expected_wildcard_host}, otherwise keep wildcard HTTP-only."
            )

    for service, source_path in public_service_source_paths(apps).items():
        if service == "sandbox":
            continue
        if not source_path_has_direct_access(repo_root, source_path):
            warnings.append(
                f"{source_path}: no direct-access annotation found in env sourcePath; if public CLB returns 504, compare this with working playground envs."
            )
        cert_files = qcloud_cert_secret_files(repo_root, source_path)
        for cert_file in cert_files:
            warnings.append(
                f"{cert_file}: contains qcloud_cert_id; after DNS is created, run this checker with --check-tls to prove the certificate SAN covers the target host."
            )
    status = "fail" if errors else ("warn" if warnings else "ok")
    lines = [*errors, *warnings] or ("network contract static checks passed",)
    actions = ()
    if errors:
        actions = ("修复 sandbox platform env 和对应 sourcePath 后重跑。",)
    elif warnings:
        actions = ("这些是现场易错项；合入前确认 DNS/证书/Ingress live 证据。",)
    return CheckResult("Playground network contract", status, tuple(lines), actions)


def check_playground_stateful_runtime_contract(
    repo_root: Path,
    env: str,
    namespace: str,
    apps: Sequence[CatalogApp],
) -> CheckResult:
    errors: list[str] = []
    warnings: list[str] = []
    env_bootstrap = next((app for app in apps if app.service == "env-bootstrap"), None)
    if env_bootstrap is None:
        errors.append("missing env-bootstrap catalog app; namespace-local MySQL/Redis must be managed by GitOps")
        source_root = repo_root / "argocd/services/env-bootstrap" / env
    else:
        source_root = repo_root / env_bootstrap.source_path
    kustomization_path = source_root / "kustomization.yaml"
    if not kustomization_path.is_file():
        errors.append(f"missing {kustomization_path.relative_to(repo_root)}")
        resources: set[str] = set()
        generators: set[str] = set()
    else:
        payload = load_yaml_mapping(kustomization_path.read_text(), kustomization_path.as_posix())
        if payload.get("namespace") != namespace:
            errors.append(f"{kustomization_path.relative_to(repo_root)} namespace={payload.get('namespace')}, expected={namespace}")
        resources = {str(item) for item in payload.get("resources") or []}
        generators = {str(item) for item in payload.get("generators") or []}
        for required in ("namespace.yaml", "serviceaccount.yaml", "mysql.yaml", "redis.yaml"):
            if required not in resources:
                errors.append(f"{kustomization_path.relative_to(repo_root)} missing resource {required}")
        if PLAYGROUND_RUNTIME_KSOPS_GENERATOR not in generators:
            errors.append(f"{kustomization_path.relative_to(repo_root)} missing generator {PLAYGROUND_RUNTIME_KSOPS_GENERATOR}")
        if PLAYGROUND_RUNTIME_KSOPS_GENERATOR in resources:
            errors.append(f"{kustomization_path.relative_to(repo_root)} must put {PLAYGROUND_RUNTIME_KSOPS_GENERATOR} under generators, not resources")

    runtime_sops = repo_root / "argocd/secrets" / env / PLAYGROUND_RUNTIME_SECRET_FILE
    if not runtime_sops.is_file():
        errors.append(f"missing {runtime_sops.relative_to(repo_root)}")
    runtime_generator = source_root / PLAYGROUND_RUNTIME_KSOPS_GENERATOR
    if not runtime_generator.is_file():
        errors.append(f"missing {runtime_generator.relative_to(repo_root)}")
    else:
        generator_payload = load_yaml_mapping(runtime_generator.read_text(), runtime_generator.as_posix())
        files = [str(item) for item in generator_payload.get("files") or []]
        expected_file_ref = f"../../../secrets/{env}/{PLAYGROUND_RUNTIME_SECRET_FILE}"
        if generator_payload.get("kind") != "ksops":
            errors.append(f"{runtime_generator.relative_to(repo_root)} kind must be ksops")
        if expected_file_ref not in files:
            errors.append(f"{runtime_generator.relative_to(repo_root)} must include {expected_file_ref}")

    serviceaccount_path = source_root / "serviceaccount.yaml"
    if serviceaccount_path.is_file():
        serviceaccount = load_yaml_mapping(serviceaccount_path.read_text(), serviceaccount_path.as_posix())
        refs = {
            str(item.get("name"))
            for item in serviceaccount.get("imagePullSecrets") or []
            if isinstance(item, dict)
        }
        for name in PLAYGROUND_PULL_SECRET_NAMES:
            if name not in refs:
                errors.append(f"{serviceaccount_path.relative_to(repo_root)} missing imagePullSecret {name}")

    pull_generator = source_root / "ksops-pull-secret-generator.yaml"
    if pull_generator.is_file():
        pull_payload = load_yaml_mapping(pull_generator.read_text(), pull_generator.as_posix())
        for file_ref in [str(item) for item in pull_payload.get("files") or []]:
            secret_path = (pull_generator.parent / file_ref).resolve()
            if not secret_path.is_file():
                errors.append(f"{pull_generator.relative_to(repo_root)} references missing {file_ref}")
                continue
            payload = load_yaml_mapping(secret_path.read_text(), secret_path.as_posix())
            metadata = payload.get("metadata") or {}
            raw_name = metadata.get("name") if isinstance(metadata, dict) else ""
            raw_namespace = metadata.get("namespace") if isinstance(metadata, dict) else ""
            name = pull_secret_name_from_path(secret_path) if is_encrypted_sops_scalar(raw_name) or not raw_name else str(raw_name)
            if name in PLAYGROUND_PULL_SECRET_NAMES and raw_namespace and not is_encrypted_sops_scalar(raw_namespace) and raw_namespace != namespace:
                errors.append(f"{secret_path.relative_to(repo_root)} namespace={raw_namespace}, expected={namespace}")
        pull_names: set[str] = set()
        for file_ref in [str(item) for item in pull_payload.get("files") or []]:
            secret_path = (pull_generator.parent / file_ref).resolve()
            if not secret_path.is_file():
                continue
            payload = load_yaml_mapping(secret_path.read_text(), file_ref)
            metadata = payload.get("metadata") or {}
            raw_name = metadata.get("name") if isinstance(metadata, dict) else ""
            name = pull_secret_name_from_path(secret_path) if is_encrypted_sops_scalar(raw_name) or not raw_name else str(raw_name)
            if name:
                pull_names.add(name)
        for name in PLAYGROUND_PULL_SECRET_NAMES:
            if name not in pull_names:
                errors.append(f"{pull_generator.relative_to(repo_root)} must generate Secret/{name}")

    for runtime_name, file_name, service_name, statefulset_name, required_secret_key in (
        ("MySQL", "mysql.yaml", "mysql", "mysql", "MYSQL_ROOT_PASSWORD"),
        ("Redis", "redis.yaml", "redis", "redis", "REDIS_PASSWORD"),
    ):
        path = source_root / file_name
        if not path.is_file():
            errors.append(f"missing {path.relative_to(repo_root)}")
            continue
        docs = [doc for doc in yaml.safe_load_all(path.read_text()) if isinstance(doc, dict)]
        kinds = {(doc.get("kind"), doc.get("metadata", {}).get("name")) for doc in docs}
        if ("Service", service_name) not in kinds:
            errors.append(f"{path.relative_to(repo_root)} must define Service/{service_name}")
        if ("StatefulSet", statefulset_name) not in kinds:
            errors.append(f"{path.relative_to(repo_root)} must define StatefulSet/{statefulset_name}")
        statefulsets = [doc for doc in docs if doc.get("kind") == "StatefulSet" and doc.get("metadata", {}).get("name") == statefulset_name]
        if not statefulsets:
            continue
        sts = statefulsets[0]
        if not sts.get("spec", {}).get("volumeClaimTemplates"):
            errors.append(f"{path.relative_to(repo_root)} StatefulSet/{statefulset_name} must use PVC volumeClaimTemplates")
        rendered = path.read_text()
        if "lightclaw-auth-secrets" in rendered or "sandbox-runtime-secrets" in rendered:
            errors.append(
                f"{path.relative_to(repo_root)} StatefulSet/{statefulset_name} must not use broad service secrets for runtime root password"
            )
        containers = sts.get("spec", {}).get("template", {}).get("spec", {}).get("containers") or []
        secret_refs = []
        for container in containers:
            for env_item in container.get("env") or []:
                ref = (env_item.get("valueFrom") or {}).get("secretKeyRef")
                if isinstance(ref, dict):
                    secret_refs.append((ref.get("name"), ref.get("key")))
        if (PLAYGROUND_RUNTIME_SECRET_NAME, required_secret_key) not in secret_refs:
            errors.append(
                f"{path.relative_to(repo_root)} StatefulSet/{statefulset_name} must reference {PLAYGROUND_RUNTIME_SECRET_NAME}/{required_secret_key}"
            )
        if runtime_name == "Redis":
            if "--appendonly yes" not in rendered:
                warnings.append(f"{path.relative_to(repo_root)} Redis should enable AOF for restart persistence")

    mysql_host = local_mysql_host(namespace)
    redis_addr = local_redis_addr(namespace)
    ignored_runtime_contract_files = {"README.md"}
    for app in apps:
        source_path = repo_root / app.source_path
        if not source_path.is_dir():
            continue
        for path in source_path.rglob("*"):
            if (
                not path.is_file()
                or path.name.endswith(".sops.yaml")
                or path.name in ignored_runtime_contract_files
                or path.suffix.lower() in {".md", ".markdown"}
            ):
                continue
            text = path.read_text(errors="ignore")
            if "MYSQL_HOST" in text and mysql_host not in text:
                errors.append(f"{path.relative_to(repo_root)} has MYSQL_HOST but does not point to {mysql_host}")
            if "REDIS_ADDR" in text and redis_addr not in text:
                errors.append(f"{path.relative_to(repo_root)} has REDIS_ADDR but does not point to {redis_addr}")

    status = "fail" if errors else ("warn" if warnings else "ok")
    lines = [*errors, *warnings] or (
        f"namespace-local MySQL/Redis contract passed: mysql={mysql_host} redis={redis_addr}",
    )
    actions = ()
    if errors:
        actions = ("修复 env-bootstrap StatefulSet/PVC 和业务 MYSQL_HOST/REDIS_ADDR 后重跑。",)
    return CheckResult("Playground stateful runtime contract", status, tuple(lines), actions)


def resolve_host(host: str, timeout_seconds: float) -> tuple[str, ...]:
    old_timeout = socket.getdefaulttimeout()
    socket.setdefaulttimeout(timeout_seconds)
    try:
        infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    finally:
        socket.setdefaulttimeout(old_timeout)
    return tuple(sorted({item[4][0] for item in infos}))


def check_dns_contract(env: str, timeout_seconds: float) -> CheckResult:
    hosts = (
        default_api_host(env),
        default_admin_host(env),
        default_frontend_host(env),
        default_sandbox_host(env),
    )
    lines: list[str] = []
    failed = False
    for host in hosts:
        try:
            addresses = resolve_host(host, timeout_seconds)
            lines.append(f"{host}: {','.join(addresses)}")
        except OSError as exc:
            failed = True
            lines.append(f"{host}: DNS lookup failed: {exc}")
    return CheckResult(
        "Playground DNS probe",
        "fail" if failed else "ok",
        tuple(lines),
        ("补齐 DNS 记录后重跑；wildcard 记录需要单独用实例 host 验证。",) if failed else (),
    )


def tls_certificate_matches(host: str, timeout_seconds: float) -> str:
    context = ssl.create_default_context()
    with socket.create_connection((host, 443), timeout=timeout_seconds) as sock:
        with context.wrap_socket(sock, server_hostname=host) as tls_sock:
            cert = tls_sock.getpeercert()
    ssl.match_hostname(cert, host)
    subject_alt_names = ", ".join(value for key, value in cert.get("subjectAltName", ()) if key == "DNS")
    return subject_alt_names or "-"


def check_tls_contract(env: str, timeout_seconds: float) -> CheckResult:
    hosts = (
        default_api_host(env),
        default_admin_host(env),
        default_frontend_host(env),
    )
    lines: list[str] = []
    failed = False
    for host in hosts:
        try:
            sans = tls_certificate_matches(host, timeout_seconds)
            lines.append(f"{host}: cert SAN OK ({sans})")
        except Exception as exc:  # noqa: BLE001
            failed = True
            lines.append(f"{host}: TLS cert check failed: {exc}")
    return CheckResult(
        "Playground TLS probe",
        "fail" if failed else "ok",
        tuple(lines),
        ("固定入口需要单域名证书；不要用不覆盖目标 host 的 wildcard 证书硬套。",) if failed else (),
    )


def http_status(url: str, timeout_seconds: float) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": "harness-ci-playground-check/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            return str(response.status)
    except urllib.error.HTTPError as exc:
        return str(exc.code)


def check_http_contract(env: str, timeout_seconds: float) -> CheckResult:
    probes = (
        (f"https://{default_api_host(env)}/healthz", {"200"}),
        (f"https://{default_admin_host(env)}/healthz", {"200"}),
        (f"https://{default_frontend_host(env)}/", {"200", "301", "302"}),
        (f"http://{default_sandbox_host(env)}/", {"200", "301", "302", "400", "404"}),
    )
    lines: list[str] = []
    failed = False
    for url, accepted in probes:
        try:
            status = http_status(url, timeout_seconds)
            lines.append(f"{url}: HTTP {status}")
            if status not in accepted:
                failed = True
        except Exception as exc:  # noqa: BLE001
            failed = True
            lines.append(f"{url}: probe failed: {exc}")
    return CheckResult(
        "Playground public endpoint probe",
        "fail" if failed else "ok",
        tuple(lines),
        ("公网入口未达预期；按 DNS -> TLS -> Ingress direct-access -> endpoints 顺序排查。",) if failed else (),
    )


def check_playground_contract_main(argv: Sequence[str] | None = None) -> int:
    args = parse_contract_args(argv)
    repo_root = args.repo_root.resolve()
    namespace = args.namespace or default_namespace(args.env)
    results: list[CheckResult] = []
    catalog_result, apps = check_playground_catalog_contract(
        repo_root,
        args.env,
        args.playground_root,
        namespace,
        args.project,
        args.cluster_name,
    )
    results.append(catalog_result)
    results.append(check_playground_stateful_runtime_contract(repo_root, args.env, namespace, apps))
    results.append(check_playground_network_contract(repo_root, args.env, apps))
    if args.check_dns:
        results.append(check_dns_contract(args.env, args.timeout_seconds))
    if args.check_tls:
        results.append(check_tls_contract(args.env, args.timeout_seconds))
    if args.check_http:
        results.append(check_http_contract(args.env, args.timeout_seconds))

    print(f"playground environment contract check: env={args.env} namespace={namespace}")
    print(f"expected fixed hosts: api={default_api_host(args.env)} admin={default_admin_host(args.env)} frontend={default_frontend_host(args.env)} sandbox={default_sandbox_host(args.env)}")
    print(f"expected wildcard host: {default_wildcard_host(args.env)}")
    for result in results:
        print_result(result)
    failed = [result for result in results if result.status == "fail"]
    if failed:
        print("=" * 60)
        print("检查结论：未通过。先修复 FAIL 项，再合入或继续 live 操作。")
        return 1
    warnings = [result for result in results if result.status == "warn"]
    print("=" * 60)
    if warnings:
        print("检查结论：静态硬约束通过，但仍有 WARN 项需要人工/Agent 确认证据。")
    else:
        print("检查结论：playground contract 通过。")
    return 0


def run_local_git(repo_root: Path, *args: str) -> str:
    result = run_command(["git", *args], cwd=repo_root, check=True, capture_output=True, text=True)
    return result.stdout.strip()


def default_kubeconfig_for_env(env: str) -> Path:
    candidates = (
        Path("/etc/lightclaw-ci") / f"kubeconfig_{env_slug(env)}",
        Path("/etc/lightclaw-ci/kubeconfig_beijing_sandbox_2"),
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return candidates[0]


def kubectl_cmd(kubeconfig: Path, namespace: str, *args: str) -> list[str]:
    return [
        "kubectl",
        "--request-timeout=60s",
        "--kubeconfig",
        str(kubeconfig),
        "-n",
        namespace,
        *args,
    ]


def transient_kubectl_error(stderr: str) -> bool:
    lowered = stderr.lower()
    return "eof" in lowered or "context deadline exceeded" in lowered or "timeout" in lowered


def kubectl_capture(kubeconfig: Path, namespace: str, *args: str, retries: int = 3) -> str:
    last: subprocess.CalledProcessError | None = None
    for attempt in range(1, max(retries, 1) + 1):
        try:
            result = run_command(
                kubectl_cmd(kubeconfig, namespace, *args),
                check=True,
                capture_output=True,
                text=True,
            )
            return result.stdout
        except subprocess.CalledProcessError as exc:
            last = exc
            stderr = exc.stderr.lower()
            if not transient_kubectl_error(stderr) or attempt >= max(retries, 1):
                break
            time.sleep(5)
    assert last is not None
    raise last


def kubectl_apply(kubeconfig: Path, manifest: dict[str, Any], retries: int = 3) -> str:
    last: subprocess.CalledProcessError | None = None
    for attempt in range(1, max(retries, 1) + 1):
        try:
            result = run_command(
                [
                    "kubectl",
                    "--request-timeout=60s",
                    "--kubeconfig",
                    str(kubeconfig),
                    "apply",
                    "--validate=false",
                    "-f",
                    "-",
                ],
                input=json.dumps(manifest),
                check=True,
                capture_output=True,
                text=True,
            )
            return result.stdout
        except subprocess.CalledProcessError as exc:
            last = exc
            stderr = exc.stderr.lower()
            if not transient_kubectl_error(stderr) or attempt >= max(retries, 1):
                break
            time.sleep(5)
    assert last is not None
    raise last


def kubectl_secret_key_ref(name: str, key: str) -> dict[str, Any]:
    return {"secretKeyRef": {"name": name, "key": key}}


def secret_value_from_cluster(kubeconfig: Path, namespace: str, secret: str, key: str, retries: int = 3) -> str:
    encoded = kubectl_capture(kubeconfig, namespace, "get", "secret", secret, "-o", f"jsonpath={{.data.{key}}}", retries=retries)
    return base64.b64decode(encoded.strip()).decode()


def discover_mysql_host(kubeconfig: Path, namespace: str, retries: int = 3) -> str:
    payload = kubectl_capture(kubeconfig, namespace, "get", "configmap", "-o", "json", retries=retries)
    data = json.loads(payload)
    hosts: set[str] = set()
    for item in data.get("items") or []:
        for key, value in (item.get("data") or {}).items():
            if key.endswith("MYSQL_HOST") and value:
                hosts.add(str(value))
    if len(hosts) != 1:
        raise ValueError(f"cannot infer a single MYSQL_HOST from namespace {namespace}; found={sorted(hosts)}")
    return next(iter(hosts))


def build_playground_bootstrap_plan(
    repo_root: Path,
    env: str,
    runtime_root: Path | None = None,
    namespace: str | None = None,
    kubeconfig: Path | None = None,
    mysql_host: str = "",
    revision: str = "",
) -> PlaygroundBootstrapPlan:
    repo_root = repo_root.resolve()
    runtime_root = (runtime_root or repo_root).resolve()
    namespace = namespace or default_namespace(env)
    kubeconfig = (kubeconfig or default_kubeconfig_for_env(env)).resolve()
    if not revision:
        revision = run_local_git(repo_root, "rev-parse", "HEAD")
    runtime_revision = run_local_git(runtime_root, "rev-parse", "HEAD")
    return PlaygroundBootstrapPlan(
        repo_root=repo_root,
        runtime_root=runtime_root,
        env=env,
        namespace=namespace,
        kubeconfig=kubeconfig,
        mysql_host=mysql_host,
        revision=revision,
        runtime_revision=runtime_revision,
        grants=playground_database_grants(env),
        db_jobs=PLAYGROUND_DB_SERVICES,
    )


def bootstrap_database_job_manifest(plan: PlaygroundBootstrapPlan) -> dict[str, Any]:
    env: list[dict[str, Any]] = [
        {"name": "MYSQL_HOST", "value": plan.mysql_host},
        {"name": "ROOT_PASSWORD", "valueFrom": kubectl_secret_key_ref(PLAYGROUND_RUNTIME_SECRET_NAME, "MYSQL_ROOT_PASSWORD")},
    ]
    for index, grant in enumerate(plan.grants):
        if grant.password_secret and grant.password_key:
            env.append({"name": f"GRANT_PASSWORD_{index}", "valueFrom": kubectl_secret_key_ref(grant.password_secret, grant.password_key)})
        if grant.database.startswith("cvm_"):
            env.append({"name": f"GRANT_USER_{index}", "valueFrom": kubectl_secret_key_ref("sandbox-runtime-secrets", "MYSQL_USER")})

    lines = [
        'sql_escape() { printf "%s" "$1" | sed "s/\'/\'\'/g"; }',
        "emit_sql() {",
    ]
    for index, grant in enumerate(plan.grants):
        db_env = f"DB_{index}"
        lines.append(f'  {db_env}="{grant.database}"')
        lines.append(f'  echo "CREATE DATABASE IF NOT EXISTS \\`${{{db_env}}}\\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"')
        if grant.username:
            user_literal = grant.username
            password_env = f"GRANT_PASSWORD_{index}"
            lines.append(f'  P_{index}="$(sql_escape "${{{password_env}}}")"')
            lines.append(f'  echo "CREATE USER IF NOT EXISTS \'{user_literal}\'@\'%\' IDENTIFIED BY \'${{P_{index}}}\';"')
            lines.append(f'  echo "ALTER USER \'{user_literal}\'@\'%\' IDENTIFIED BY \'${{P_{index}}}\';"')
            lines.append(f'  echo "GRANT ALL PRIVILEGES ON \\`${{{db_env}}}\\`.* TO \'{user_literal}\'@\'%\';"')
        elif grant.database.startswith("cvm_"):
            user_env = f"GRANT_USER_{index}"
            password_env = f"GRANT_PASSWORD_{index}"
            lines.append(f'  U_{index}="$(sql_escape "${{{user_env}}}")"')
            lines.append(f'  P_{index}="$(sql_escape "${{{password_env}}}")"')
            lines.append(f'  echo "CREATE USER IF NOT EXISTS \'${{U_{index}}}\'@\'%\' IDENTIFIED BY \'${{P_{index}}}\';"')
            lines.append(f'  echo "ALTER USER \'${{U_{index}}}\'@\'%\' IDENTIFIED BY \'${{P_{index}}}\';"')
            lines.append(f'  echo "GRANT ALL PRIVILEGES ON \\`${{{db_env}}}\\`.* TO \'${{U_{index}}}\'@\'%\';"')
    lines.extend(["  echo 'FLUSH PRIVILEGES;'", "}", "emit_sql >/tmp/bootstrap.sql", 'mysql --host="$MYSQL_HOST" --port=3306 --user=root --password="$ROOT_PASSWORD" </tmp/bootstrap.sql', f'echo "db bootstrap {plan.env} ok"'])
    return {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {"name": f"db-bootstrap-{plan.env}", "namespace": plan.namespace},
        "spec": {
            "backoffLimit": 0,
            "ttlSecondsAfterFinished": 86400,
            "template": {
                "spec": {
                    "restartPolicy": "Never",
                    "containers": [
                        {
                            "name": "mysql",
                            "image": "mysql:8.0",
                            "env": env,
                            "command": ["/bin/sh", "-ec"],
                            "args": ["\n".join(lines)],
                        }
                    ],
                }
            },
        },
    }


def wait_for_kubernetes_job(kubeconfig: Path, namespace: str, name: str, timeout_seconds: int, retries: int) -> str:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        payload = kubectl_capture(kubeconfig, namespace, "get", "job", name, "-o", "json", retries=retries)
        status = json.loads(payload).get("status") or {}
        if status.get("succeeded", 0) > 0:
            return "succeeded"
        if status.get("failed", 0) > 0 and status.get("active", 0) == 0:
            return "failed"
        time.sleep(5)
    return "timeout"


def run_database_bootstrap(plan: PlaygroundBootstrapPlan, timeout_seconds: int, retries: int) -> None:
    manifest = bootstrap_database_job_manifest(plan)
    try:
        kubectl_capture(
            plan.kubeconfig,
            plan.namespace,
            "delete",
            "job",
            manifest["metadata"]["name"],
            "--ignore-not-found=true",
            retries=retries,
        )
    except subprocess.CalledProcessError as exc:
        if not transient_kubectl_error(exc.stderr):
            raise
        print(f"警告：删除旧 DB bootstrap job 时遇到临时 apiserver 错误，继续幂等 apply：{exc.stderr.strip()}")
    kubectl_apply(plan.kubeconfig, manifest, retries=retries)
    result = wait_for_kubernetes_job(plan.kubeconfig, plan.namespace, manifest["metadata"]["name"], timeout_seconds, retries)
    if result != "succeeded":
        logs = kubectl_capture(plan.kubeconfig, plan.namespace, "logs", f"job/{manifest['metadata']['name']}", "--tail=80", retries=retries)
        raise RuntimeError(f"database bootstrap job {manifest['metadata']['name']} {result}\n{logs}")


def run_playground_db_jobs(plan: PlaygroundBootstrapPlan, skip: set[str], timeout_seconds: int, retries: int) -> None:
    env = os.environ.copy()
    env["DB_JOB_KUBECONFIG_FILE"] = str(plan.kubeconfig)
    try:
        env["CTL_TEST_MYSQL_PASSWORD"] = secret_value_from_cluster(
            plan.kubeconfig, plan.namespace, PLAYGROUND_RUNTIME_SECRET_NAME, "MYSQL_ROOT_PASSWORD", retries
        )
    except Exception:
        pass
    for service, operation in plan.db_jobs:
        key = f"{service}/{operation}"
        if key in skip or service in skip:
            print(f"跳过 DB job：{key}")
            continue
        print(f"执行 DB job：{key}")
        job_revision = plan.runtime_revision if (service, operation) in PLAYGROUND_REPO_BACKED_DB_JOBS else plan.revision
        run_command(
            [
                sys.executable,
                str(plan.runtime_root / ".ci/runtime/commands/run_gitops_db_job.py"),
                "--repo-root",
                str(plan.runtime_root),
                "--deploy-root",
                str(plan.repo_root),
                "--service",
                service,
                "--operation",
                operation,
                "--env",
                plan.env,
                "--revision",
                job_revision,
                "--namespace",
                plan.namespace,
                "--kubectl-retries",
                str(retries),
                "--apply",
                "--wait",
                "--timeout-seconds",
                str(timeout_seconds),
            ],
            cwd=plan.runtime_root,
            env=env,
            check=True,
        )


PLAYGROUND_RESTART_SELECTORS = (
    "app=ctl-api",
    "app=ctl-bypass",
    "app=ctl-service",
    "app=gateway-backend",
    "app=lightclaw-auth",
    "app=nextgen-dashboard",
    "app=payment",
    "app=sandbox-api",
    "app=sandbox-worker-sharded",
    "app=subscription",
)


def restart_playground_workloads(plan: PlaygroundBootstrapPlan, retries: int) -> None:
    for selector in PLAYGROUND_RESTART_SELECTORS:
        print(f"重启 workload pods：{selector}")
        kubectl_capture(plan.kubeconfig, plan.namespace, "delete", "pod", "-l", selector, "--ignore-not-found=true", retries=retries)


def print_bootstrap_plan(plan: PlaygroundBootstrapPlan, *, apply: bool, skip: set[str]) -> None:
    print("=" * 60)
    print("Playground 环境运行时初始化")
    print(f"模式：{'执行 live 修改' if apply else 'dry-run（不会改 live）'}")
    print(f"环境：{plan.env}")
    print(f"namespace：{plan.namespace}")
    print(f"kubeconfig：{plan.kubeconfig}")
    print(f"MySQL host：{plan.mysql_host or '自动从 ConfigMap 推导'}")
    print(f"revision：{plan.revision}")
    if plan.runtime_revision != plan.revision:
        print(f"runtime revision：{plan.runtime_revision}")
    print("=" * 60)
    print("将确保数据库/授权：")
    for grant in plan.grants:
        user = grant.username or ("sandbox-runtime-secrets/MYSQL_USER" if grant.database.startswith("cvm_") else "root-only")
        print(f"- database={grant.database} user={user}")
    print("将执行 DB job：")
    for service, operation in plan.db_jobs:
        key = f"{service}/{operation}"
        suffix = "（跳过）" if key in skip or service in skip else ""
        print(f"- {key}{suffix}")
    print("将重启 DB schema 相关 workload pod。")
    print("不会打印任何 Secret 值。")


def bootstrap_playground_main(argv: Sequence[str] | None = None) -> int:
    args = parse_bootstrap_args(argv)
    plan = build_playground_bootstrap_plan(
        repo_root=args.repo_root,
        runtime_root=args.runtime_root,
        env=args.env,
        namespace=args.namespace,
        kubeconfig=args.kubeconfig,
        mysql_host=args.mysql_host,
        revision=args.revision,
    )
    skip = set(args.skip_db_job)
    if not plan.mysql_host and args.apply:
        plan = PlaygroundBootstrapPlan(
            repo_root=plan.repo_root,
            runtime_root=plan.runtime_root,
            env=plan.env,
            namespace=plan.namespace,
            kubeconfig=plan.kubeconfig,
            mysql_host=discover_mysql_host(plan.kubeconfig, plan.namespace, args.kubectl_retries),
            revision=plan.revision,
            runtime_revision=plan.runtime_revision,
            grants=plan.grants,
            db_jobs=plan.db_jobs,
        )
    print_bootstrap_plan(plan, apply=args.apply, skip=skip)
    if not args.apply:
        print("=" * 60)
        print(f"确认后执行：python3 .ci/runtime/commands/bootstrap_playground_environment.py --env {plan.env} --apply")
        return 0
    if not plan.mysql_host:
        raise ValueError("--mysql-host is required when it cannot be inferred from live ConfigMaps")
    if args.skip_db_bootstrap:
        print("跳过 DB bootstrap：按参数 --skip-db-bootstrap")
    else:
        run_database_bootstrap(plan, args.timeout_seconds, args.kubectl_retries)
    run_playground_db_jobs(plan, skip, args.timeout_seconds, args.kubectl_retries)
    if not args.skip_restart:
        restart_playground_workloads(plan, args.kubectl_retries)
    print("=" * 60)
    print("Playground runtime bootstrap 完成。建议等待 1-2 分钟后运行 diagnose_playground_environment.py 验证 Argo/K8s。")
    return 0


def print_clone_plan(plan: PlaygroundClonePlan, *, write: bool, force: bool, written: Sequence[Path] = ()) -> None:
    targets = sorted(set(all_plan_targets(plan)))
    catalog_files = [path for path in targets if f"/{plan.playground_root.rstrip('/')}/{plan.to_env}/" in path.as_posix()]
    service_files = [path for path in targets if f"/argocd/services/" in path.as_posix() and f"/{plan.to_env}/" in path.as_posix()]
    secret_files = [path for path in targets if f"/argocd/secrets/{plan.to_env}/" in path.as_posix()]

    print("=" * 60)
    print("Playground 环境克隆脚手架")
    print(f"模式：{'写入文件' if write else 'dry-run（不会写文件）'}")
    print(f"源环境：{plan.from_env}")
    print(f"目标环境：{plan.to_env}")
    print(f"目标 namespace：{plan.namespace}")
    print(f"目标 cluster/project：{plan.cluster_name}/{plan.project}")
    print(f"目标域名：api={plan.api_host} sandbox={plan.sandbox_host} wildcard={plan.wildcard_host}")
    print(f"覆盖已有文件：{'是' if force else '否'}")
    print("=" * 60)
    print(f"将创建 catalog 文件：{len(catalog_files)}")
    for path in catalog_files[:20]:
        print(f"- {path.relative_to(plan.repo_root)}")
    print(f"将创建 service/sourcePath 文件：{len(service_files)}")
    for path in service_files[:30]:
        print(f"- {path.relative_to(plan.repo_root)}")
    print(f"将复制 secret 文件：{len(secret_files)}")
    for path in secret_files[:20]:
        print(f"- {path.relative_to(plan.repo_root)}")
    print("=" * 60)
    print("将自动替换：env、namespace、sourcePath、app 名、DB name、Redis prefix、内部 service DNS、域名。")
    print(
        "将自动生成：namespace-local MySQL/Redis StatefulSet + PVC，并把 MYSQL_HOST/REDIS_ADDR 指向 namespace 内 Service。"
    )
    print("将自动生成：最小 playground-runtime-secrets SOPS 文件，包含新的 MYSQL_ROOT_PASSWORD / REDIS_PASSWORD。")
    print("风险提示：将复制并重新加密源环境 SOPS secret；只改 metadata 与 Redis 密码对齐。如需强隔离，必须重新生成 SSM/SOPS。")
    print("需要 Agent/人工确认：DNS/证书、SSM/SOPS 是否需要重新生成、是否触发 Argo refresh、是否纳入 drift audit。")
    warnings = clone_plan_warnings(plan)
    if warnings:
        print("=" * 60)
        print("Checker 提示：")
        for warning in warnings:
            print(f"- {warning}")
    if write:
        print("=" * 60)
        print(f"已写入文件：{len(written)}")
        for path in written[:50]:
            print(f"- {path.relative_to(plan.repo_root)}")
        print("=" * 60)
        print(f"建议 GitOps MR 标题：Create playground environment {plan.to_env}")
        print("建议验证命令：")
        print(
            f"python3 .ci/runtime/commands/create_playground_environment.py --to-env {plan.to_env} --write --force"
        )
        print(
            f"python3 .ci/runtime/commands/diagnose_playground_environment.py --env {plan.to_env} --skip-argocd --skip-kubernetes"
        )


def create_playground_main(argv: Sequence[str] | None = None) -> int:
    args = parse_create_args(argv)
    try:
        plan = build_playground_clone_plan(
            repo_root=args.repo_root,
            from_env=args.from_env,
            to_env=args.to_env,
            playground_root=args.playground_root,
            cluster_name=args.cluster_name,
            project=args.project,
            namespace=args.namespace,
            api_host=args.api_host,
            sandbox_host=args.sandbox_host,
            wildcard_host=args.wildcard_host,
        )
    except FileNotFoundError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    errors = validate_clone_plan(plan)
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    if not args.write:
        conflicts = target_conflicts(plan)
        print_clone_plan(plan, write=False, force=args.force)
        if conflicts:
            print("=" * 60)
            print("目标文件已存在；dry-run 未写入。若确认覆盖，请加 --write --force。")
            for path in conflicts[:50]:
                print(f"- {path.relative_to(plan.repo_root)}")
        return 0

    written = write_clone_plan(plan, force=args.force)
    print_clone_plan(plan, write=True, force=args.force, written=written)
    return 0


def expected_appset_globs(playground_root: str) -> tuple[str, str]:
    return (
        "argocd/catalogs/sandbox/*/*.yaml",
        f"{playground_root.rstrip('/')}/*/*.yaml",
    )


def load_yaml_mapping(text: str, label: str) -> dict[str, Any]:
    payload = yaml.safe_load(text) or {}
    if not isinstance(payload, dict):
        raise ValueError(f"{label} must contain a YAML mapping")
    return payload


def appset_file_globs(appset: dict[str, Any]) -> set[str]:
    globs: set[str] = set()
    for generator in appset.get("spec", {}).get("generators") or []:
        if not isinstance(generator, dict):
            continue
        files = generator.get("git", {}).get("files") or []
        for item in files:
            if isinstance(item, dict) and isinstance(item.get("path"), str):
                globs.add(item["path"])
    return globs


def check_appset_refs(
    repo_root: Path,
    refs: Sequence[str],
    appset_path: str,
    required_globs: Iterable[str],
) -> CheckResult:
    required = set(required_globs)
    lines: list[str] = []
    actions: list[str] = []
    failed = False
    for ref in refs:
        try:
            appset = load_yaml_mapping(git_show_text(repo_root, ref, appset_path), f"{ref}:{appset_path}")
        except subprocess.CalledProcessError:
            failed = True
            lines.append(f"{ref}: missing {appset_path}")
            actions.append(f"把 {appset_path} 投影/提交到 {ref} 能访问的分支。")
            continue
        globs = appset_file_globs(appset)
        missing = sorted(required - globs)
        if missing:
            failed = True
            lines.append(f"{ref}: missing generator globs: {', '.join(missing)}")
            actions.append(
                f"提交 MR 修复 {ref} 的 {appset_path}，保持 sandbox 和 playground catalog glob 同时存在。"
            )
        else:
            lines.append(f"{ref}: appset generator globs OK")
    return CheckResult(
        "GitOps/AppSet 入口",
        "fail" if failed else "ok",
        tuple(lines),
        tuple(dict.fromkeys(actions)),
    )


def load_catalog_apps(repo_root: Path, gitops_ref: str, catalog_path: str) -> list[CatalogApp]:
    files = [path for path in git_list_files(repo_root, gitops_ref, catalog_path) if path.endswith(".yaml")]
    apps: list[CatalogApp] = []
    for path in sorted(files):
        payload = load_yaml_mapping(git_show_text(repo_root, gitops_ref, path), f"{gitops_ref}:{path}")
        missing = [
            key
            for key in ("service", "env", "project", "destinationName", "namespace", "sourcePath")
            if not payload.get(key)
        ]
        if missing:
            raise ValueError(f"{gitops_ref}:{path} missing required fields: {', '.join(missing)}")
        service = str(payload["service"])
        env = str(payload["env"])
        apps.append(
            CatalogApp(
                app_name=f"{service}-{env}",
                service=service,
                env=env,
                project=str(payload["project"]),
                destination_name=str(payload["destinationName"]),
                namespace=str(payload["namespace"]),
                source_path=str(payload["sourcePath"]),
                catalog_file=path,
            )
        )
    return apps


def check_catalog(repo_root: Path, gitops_ref: str, catalog_path: str) -> tuple[CheckResult, list[CatalogApp]]:
    try:
        apps = load_catalog_apps(repo_root, gitops_ref, catalog_path)
    except subprocess.CalledProcessError:
        return (
            CheckResult(
                "GitOps catalog inventory",
                "fail",
                (f"{gitops_ref}: no catalog files found under {catalog_path}",),
                (f"创建 GitOps MR，把 {catalog_path}/*.yaml 投影到 gitops。",),
            ),
            [],
        )
    except ValueError as exc:
        return (
            CheckResult(
                "GitOps catalog inventory",
                "fail",
                (str(exc),),
                ("修复 catalog 必填字段：service/env/project/destinationName/namespace/sourcePath。",),
            ),
            [],
        )
    if not apps:
        return (
            CheckResult(
                "GitOps catalog inventory",
                "fail",
                (f"{gitops_ref}: no catalog files found under {catalog_path}",),
                (f"创建 GitOps MR，把 {catalog_path}/*.yaml 投影到 gitops。",),
            ),
            [],
        )
    namespaces = ", ".join(sorted({app.namespace for app in apps}))
    return (
        CheckResult(
            "GitOps catalog inventory",
            "ok",
            (f"{gitops_ref}: catalog apps={len(apps)} namespaces={namespaces}",),
        ),
        apps,
    )


def argo_login(args: argparse.Namespace) -> tuple[str, Any, str]:
    base_url, username, password, ssl_context = resolve_argocd_settings(args)
    token = login_argocd(base_url, username, password, ssl_context)
    return base_url, ssl_context, token


def maybe_refresh_root_app(base_url: str, ssl_context: Any, token: str, root_app: str) -> str:
    try:
        argocd_api_request("GET", f"{base_url}/api/v1/applications/{root_app}?refresh=hard", ssl_context, token)
    except urllib.error.HTTPError as exc:
        return f"refresh {root_app} failed: HTTP {exc.code}"
    return f"refresh {root_app} requested"


def fetch_live_app(base_url: str, ssl_context: Any, token: str, name: str) -> dict[str, Any] | None:
    try:
        return argocd_api_request("GET", f"{base_url}/api/v1/applications/{name}", ssl_context, token)
    except urllib.error.HTTPError as exc:
        if exc.code in {403, 404}:
            return None
        raise


def check_argocd(args: argparse.Namespace, apps: Sequence[CatalogApp]) -> CheckResult:
    if args.skip_argocd:
        return CheckResult("Argo live apps", "warn", ("skipped by --skip-argocd",))
    if not apps:
        return CheckResult("Argo live apps", "warn", ("skipped because catalog inventory is empty",))
    try:
        base_url, ssl_context, token = argo_login(args)
    except Exception as exc:  # noqa: BLE001
        return CheckResult(
            "Argo live apps",
            "warn",
            (f"cannot login to Argo: {exc}",),
            ("配置 ARGOCD_BASE_URL/ARGOCD_USERNAME/ARGOCD_PASSWORD 后重跑，或手动登录 Argo 查看 app。",),
        )

    lines: list[str] = []
    if args.refresh_argocd:
        lines.append(maybe_refresh_root_app(base_url, ssl_context, token, args.root_app))

    failed = False
    missing: list[str] = []
    unhealthy: list[str] = []
    for expected in apps:
        live = fetch_live_app(base_url, ssl_context, token, expected.app_name)
        if live is None:
            failed = True
            missing.append(expected.app_name)
            lines.append(f"{expected.app_name}: missing")
            continue
        status = live.get("status", {})
        sync = status.get("sync", {}).get("status") or "-"
        health = status.get("health", {}).get("status") or "-"
        revision = (status.get("sync", {}).get("revision") or "-")[:12]
        conditions = status.get("conditions") or []
        lines.append(f"{expected.app_name}: sync={sync} health={health} revision={revision} conditions={len(conditions)}")
        if sync != "Synced" or health != "Healthy" or conditions:
            failed = True
            unhealthy.append(expected.app_name)

    actions: list[str] = []
    if missing:
        actions.append(
            f"先确认 {args.appset_path} 在 {args.gitops_ref} 包含 playground glob；然后 refresh {args.root_app}，等待 ApplicationSet 重新生成。"
        )
    if unhealthy:
        actions.append("对非 Healthy app 查看 Argo conditions/events；必要时先修配置契约，再重新 sync。")
    return CheckResult("Argo live apps", "fail" if failed else "ok", tuple(lines), tuple(actions))


def run_kubectl(kubeconfig: str, namespace: str) -> CheckResult:
    cmd = [
        "kubectl",
        "--request-timeout=20s",
        "--kubeconfig",
        kubeconfig,
        "get",
        "pods",
        "-n",
        namespace,
        "-o",
        "json",
    ]
    try:
        result = run_command(cmd, check=True, capture_output=True, text=True)
    except FileNotFoundError:
        return CheckResult("Kubernetes namespace", "warn", ("kubectl not found; skipped",))
    except subprocess.CalledProcessError as exc:
        return CheckResult(
            "Kubernetes namespace",
            "warn",
            (f"kubectl failed for namespace={namespace}: {exc.stderr.strip() or exc.stdout.strip()}",),
            ("如果 Argo 已 Healthy 但 kubectl EOF/超时，优先排查目标集群 apiserver/network 稳定性。",),
        )
    payload = json.loads(result.stdout)
    pods = payload.get("items") or []
    bad = []
    for pod in pods:
        phase = pod.get("status", {}).get("phase")
        name = pod.get("metadata", {}).get("name")
        if phase not in {"Running", "Succeeded"}:
            bad.append(f"{name}:{phase}")
    status = "ok" if pods and not bad else "warn"
    lines = (f"namespace={namespace} pods={len(pods)} non_running={', '.join(bad) if bad else '-'}",)
    actions = () if pods else ("namespace 为空时，先看 env-bootstrap app 是否存在且 Healthy，再看 AppSet 是否 prune 了 leaf apps。",)
    return CheckResult("Kubernetes namespace", status, lines, actions)


def check_kubernetes(args: argparse.Namespace, apps: Sequence[CatalogApp]) -> CheckResult:
    if args.skip_kubernetes:
        return CheckResult("Kubernetes namespace", "warn", ("skipped by --skip-kubernetes",))
    if not args.kubeconfig:
        return CheckResult(
            "Kubernetes namespace",
            "warn",
            ("skipped because --kubeconfig is not set",),
            ("需要 pod 级证据时传入 --kubeconfig <path>。",),
        )
    namespace = args.namespace or (apps[0].namespace if apps else f"lightvela-playground-{args.env}")
    return run_kubectl(args.kubeconfig, namespace)


def print_result(result: CheckResult) -> None:
    print("=" * 60)
    print(f"{result.name}: {result.status.upper()}")
    for line in result.lines:
        print(f"- {line}")
    if result.actions:
        print("下一步建议：")
        for action in result.actions:
            print(f"- {action}")


def main() -> int:
    args = parse_args()
    repo_root = args.repo_root.resolve()
    catalog_path = catalog_dir(args.playground_root, args.env)
    required_globs = expected_appset_globs(args.playground_root)

    results: list[CheckResult] = [
        *([fetch_origin_refs(repo_root, [args.source_ref, args.gitops_ref])] if args.fetch else []),
        check_appset_refs(repo_root, [args.source_ref, args.gitops_ref], args.appset_path, required_globs),
    ]
    catalog_result, apps = check_catalog(repo_root, args.gitops_ref, catalog_path)
    results.append(catalog_result)
    results.append(check_argocd(args, apps))
    results.append(check_kubernetes(args, apps))

    print(f"playground environment diagnostic: env={args.env} catalog={catalog_path}")
    for result in results:
        print_result(result)

    failed = [result for result in results if result.status == "fail"]
    if failed:
        print("=" * 60)
        print("诊断结论：需要修复后重跑。脚手架已列出建议动作；可由 AI 继续按步骤生成 MR/刷新 Argo。")
        return 1

    warnings = [result for result in results if result.status == "warn"]
    print("=" * 60)
    if warnings:
        print("诊断结论：GitOps/Argo 主链路未发现阻断；存在跳过或弱证据项，按需补充验证。")
    else:
        print("诊断结论：playground GitOps/AppSet/Argo/Kubernetes 证据齐全。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
