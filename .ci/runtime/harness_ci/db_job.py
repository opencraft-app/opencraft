#!/usr/bin/env python3
"""
Run controlled GitOps database jobs for selected services.

This script intentionally separates steady-state Argo sync from database lifecycle
operations. It renders a one-off Kubernetes Job from live cluster/runtime inputs,
optionally applies it, waits for completion, and writes an audit summary.
"""

from __future__ import annotations

import argparse
import base64
import copy
import dataclasses
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from contracts.bundles import (
    DEFAULT_MANIFEST_PATH,
    load_bundle,
    load_manifest,
    playground_catalog_root,
)
from harness_ci.secrets import build_secret_manifest, redact, resolve_contract_secret_values, secret_env_ref

REPO_ROOT = Path(__file__).resolve().parents[3]


@dataclasses.dataclass(frozen=True)
class CommandResult:
    args: list[str]
    returncode: int
    stdout: str
    stderr: str


SERVICE_SPECS: dict[tuple[str, str], dict[str, Any]] = {
    ("payment", "migration"): {
        "namespace": "user-auth",
        "deployment": "payment",
        "configmap": "payment-config",
        "secret": "payment-runtime-secrets",
        "platform_env_file": "argocd/services/payment/{env}/payment-platform.env",
        "image_env_key": "PAYMENT_IMAGE",
        "command": ["/usr/local/bin/payment-migrate"],
    },
    ("subscription", "migration"): {
        "namespace": "user-auth",
        "deployment": "subscription",
        "configmap": "subscription-config",
        "secret": "subscription-runtime-secrets",
        "platform_env_file": "argocd/services/subscription/{env}/subscription-platform.env",
        "image_env_key": "SUBSCRIPTION_IMAGE",
        "command": [
            "/bin/sh",
            "-ec",
            'export SUBSCRIPTION_MYSQL_DSN="${SUBSCRIPTION_DB_USER}:${SUBSCRIPTION_DB_PASSWORD}@tcp(${MYSQL_HOST}:${MYSQL_PORT})/${SUBSCRIPTION_DB}?parseTime=true&multiStatements=true"; exec /usr/local/bin/subscription-migrate',
        ],
    },
    ("trade", "migration"): {
        "namespace": "trade",
        "deployment": "trade",
        "configmap": "trade-config",
        "secret": "trade-runtime-secrets",
        "platform_env_file": "argocd/services/trade/{env}/trade-platform.env",
        "image_env_key": "TRADE_IMAGE",
        "command": [
            "/bin/sh",
            "-ec",
            'export TRADE_MYSQL_DSN="${TRADE_DB_USER}:${TRADE_DB_PASSWORD}@tcp(${MYSQL_HOST}:${MYSQL_PORT})/${TRADE_DB}?parseTime=true&multiStatements=true"; exec /usr/local/bin/trade-migrate',
        ],
    },
    ("lightclaw-auth", "migration"): {
        "namespace": "user-auth",
        "deployment": "lightclaw-auth",
        "configmap": "lightclaw-auth-config",
        "secret": "lightclaw-auth-secrets",
        "platform_env_file": "argocd/services/lightclaw-auth/{env}/auth-platform.env",
        "image_env_key": "AUTH_IMAGE",
        "command": [
            "/bin/sh",
            "-ec",
            'export LIGHTCLAW_MYSQL_DSN="${LIGHTCLAW_AUTH_DB_USER}:${LIGHTCLAW_AUTH_DB_PASSWORD}@tcp(${MYSQL_HOST}:${MYSQL_PORT})/${LIGHTCLAW_AUTH_DB}?parseTime=true&multiStatements=true"; exec /usr/local/bin/lightclaw-auth-migrate',
        ],
    },
    ("lightclaw-auth", "seed"): {
        "namespace": "user-auth",
        "deployment": "lightclaw-auth",
        "configmap": "lightclaw-auth-config",
        "secret": "lightclaw-auth-secrets",
        "platform_env_file": "argocd/services/lightclaw-auth/{env}/auth-platform.env",
        "image_env_key": "AUTH_IMAGE",
        "command": [
            "/bin/sh",
            "-ec",
            'export LIGHTCLAW_MYSQL_DSN="${LIGHTCLAW_AUTH_DB_USER}:${LIGHTCLAW_AUTH_DB_PASSWORD}@tcp(${MYSQL_HOST}:${MYSQL_PORT})/${LIGHTCLAW_AUTH_DB}?parseTime=true&multiStatements=true"; exec /usr/local/bin/lightclaw-auth-seed',
        ],
    },
    ("ai-gateway", "migration"): {
        "namespace": "ai-gateway",
        "deployment": "gateway-backend",
        "configmap": "ai-gateway-runtime-config",
        "secret": "ai-gateway-runtime-secrets",
        "platform_env_file": "argocd/services/ai-gateway/{env}/ai-gateway-platform.env",
        "image_env_key": "AI_GATEWAY_IMAGE",
        "command": [
            "/bin/sh",
            "-ec",
            'export AI_GATEWAY_MIGRATE_DSN="${AI_GATEWAY_DB_USER}:${AI_GATEWAY_DB_PASSWORD}@tcp(${MYSQL_HOST}:${MYSQL_PORT})/${AI_GATEWAY_DB}?parseTime=true&multiStatements=true"; exec /usr/local/bin/ai-gateway-migrate',
        ],
    },
    ("ctl", "migration"): {
        "namespace": "ctl",
        "deployment": "ctl-api",
        "image": "migrate/migrate:v4.18.3",
        "ignore_image_override": True,
        "platform_env_file": "argocd/services/ctl/{env}/ctl-platform.env",
        "dynamic_builder": "ctl",
        "requires_repo_revision": True,
        "command": ["migrate"],
        "args": ["-path=/migrations", "-database=$(CTL_MIGRATE_DSN)", "up"],
        "restartPolicy": "OnFailure",
        "backoffLimit": 1,
        "ttlSecondsAfterFinished": 300,
        "hostNetwork": True,
        "dnsPolicy": "ClusterFirstWithHostNet",
    },
    ("sandbox", "migration"): {
        "namespace": "sandbox",
        "deployment": "sandbox-api",
        "configmap": "sandbox-runtime-config",
        "secret": "sandbox-runtime-secrets",
        "platform_env_file": "argocd/services/sandbox/{env}/sandbox-platform.env",
        "image_env_key": "SANDBOX_MIGRATE_IMAGE",
        "command": [
            "/bin/sh",
            "-c",
            'set -eu\ndb_url="mysql://${MYSQL_USER}:${MYSQL_PASSWORD}@tcp(${MYSQL_HOST}:${MYSQL_PORT})/${MYSQL_DB}?multiStatements=true"\nmigrate -path /migrations -database "${db_url}" up',
        ],
        "restartPolicy": "OnFailure",
        "backoffLimit": 3,
        "ttlSecondsAfterFinished": 300,
    },
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a controlled GitOps migration/seed job.")
    parser.add_argument(
        "--repo-root",
        default="",
        help="Source checkout root used for repo-backed DB payloads. Defaults to the runtime checkout.",
    )
    parser.add_argument(
        "--deploy-root",
        default="",
        help="Deploy-facing GitOps checkout root used for argocd/services env files. Defaults to repo root.",
    )
    parser.add_argument("--service", required=True, choices=sorted({svc for svc, _ in SERVICE_SPECS}))
    parser.add_argument("--operation", required=True, choices=sorted({op for _, op in SERVICE_SPECS}))
    parser.add_argument("--env", required=True, help="Deploy env name, e.g. beijing-sandbox")
    parser.add_argument("--revision", required=True, help="Git revision or commit SHA this job targets")
    parser.add_argument(
        "--namespace",
        default="",
        help="Optional namespace override for playground-style single-namespace environments.",
    )
    parser.add_argument("--apply", action="store_true", help="Apply the job to the cluster")
    parser.add_argument("--wait", action="store_true", help="Wait for job completion")
    parser.add_argument("--timeout-seconds", type=int, default=1800, help="Wait timeout in seconds")
    parser.add_argument(
        "--kubectl-retries",
        type=int,
        default=5,
        help="Retry count for kubectl calls against transiently unstable API servers.",
    )
    parser.add_argument("--output-json", default="", help="Optional path to write execution summary JSON")
    parser.add_argument(
        "--image-override",
        default="",
        help="Optional explicit image override. When set, use this image instead of reading from the live Deployment.",
    )
    parser.add_argument(
        "--bundle-service",
        default="",
        help="Release bundle service name. Defaults to --service.",
    )
    parser.add_argument(
        "--bundle-manifest",
        default=str(DEFAULT_MANIFEST_PATH),
        help="Release bundle manifest used for DB secret resolver configuration.",
    )
    parser.add_argument(
        "--kubeconfig-b64-env",
        default="DB_JOB_KUBECONFIG_B64",
        help="Environment variable holding base64 kubeconfig for CI use",
    )
    return parser.parse_args()


def load_platform_env(env_name: str, repo_root: Path | None = None) -> dict[str, str]:
    root = repo_root or REPO_ROOT
    path = root / "deploy" / "envs" / env_name / "platform.env"
    if not path.is_file():
        return {"PULUMI_ENV_NAME": env_name}
    return load_env_file(path)


def load_env_file(path: Path) -> dict[str, str]:
    if not path.is_file():
        raise FileNotFoundError(f"missing deploy env file: {path}")
    values: dict[str, str] = {}
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise ValueError(f"invalid env line in {path}: {raw}")
        key, value = line.split("=", 1)
        values[key] = value
    return values


def runtime_secret_value(source_key: str, env_name: str) -> str:
    value = os.environ.get(source_key, "").strip()
    if value:
        return value
    normalized_env = env_name.replace("-", "_")
    lower_key = source_key.lower()
    for path in (
        Path("/etc/lightclaw-ci") / f"{lower_key}_{normalized_env}",
        Path("/etc/lightclaw-ci") / lower_key,
    ):
        if path.is_file():
            return path.read_text().strip()
    return ""


def load_service_platform_env(spec: dict[str, Any], env_name: str, deploy_root: Path) -> dict[str, str]:
    relative = spec.get("platform_env_file", "").strip()
    if not relative:
        return {}
    path = deploy_root / relative.format(env=env_name)
    return load_env_file(path)


def load_playground_catalog_value(deploy_root: Path, env_name: str, service: str, key: str) -> str:
    path = (
        deploy_root
        / playground_catalog_root(env_name)
        / env_name
        / f"{service}.yaml"
    )
    if not path.is_file():
        return ""
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        candidate, value = line.split(":", 1)
        if candidate.strip() != key:
            continue
        value = value.strip()
        if "#" in value:
            value = value.split("#", 1)[0].strip()
        return value.strip("\"'")
    return ""


def resolve_kubeconfig_cluster_name(platform_env: dict[str, str], deploy_root: Path, env_name: str, service: str) -> str:
    destination_name = load_playground_catalog_value(deploy_root, env_name, service, "destinationName")
    if destination_name:
        return destination_name
    playground_cluster = load_playground_catalog_value(deploy_root, env_name, service, "playgroundCluster")
    if playground_cluster:
        return playground_cluster
    return env_name or platform_env.get("PULUMI_ENV_NAME", "").strip()


def resolve_job_namespace(deploy_root: Path, env_name: str, service: str, explicit_namespace: str) -> str:
    if explicit_namespace:
        return explicit_namespace
    return load_playground_catalog_value(deploy_root, env_name, service, "namespace")


def validate_command(command: list[str]) -> list[str]:
    if not command or not all(isinstance(part, str) and part for part in command):
        raise ValueError("command must be a non-empty list of non-empty strings")
    return command


def run_command(
    command: list[str],
    *,
    cwd: Path | None = None,
    input_text: str | None = None,
    timeout: int | None = None,
) -> CommandResult:
    safe_command = validate_command(command)
    completed = subprocess.run(  # nosemgrep: dangerous-subprocess-use-audit
        safe_command,
        cwd=cwd,
        input=input_text,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    return CommandResult(safe_command, completed.returncode, completed.stdout, completed.stderr)


def git_output(args: list[str]) -> str:
    result = run_command(["git", *args], cwd=REPO_ROOT)
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}")
    return result.stdout.strip()


def require_repo_payload_revision(spec: dict[str, Any], revision: str) -> None:
    if not spec.get("requires_repo_revision"):
        return
    resolved_revision = git_output(["rev-parse", revision])
    head = git_output(["rev-parse", "HEAD"])
    if head != resolved_revision:
        raise ValueError(
            f"current checkout {head} does not match requested revision {resolved_revision}; "
            "checkout the target revision before running this repo-backed DB job"
        )
    dirty = git_output(["status", "--porcelain", "--", "ctl/migrations"])
    if dirty:
        raise ValueError("ctl/migrations has uncommitted changes; commit or clean them before running the DB job")


def resolve_kubeconfig(
    platform_env: dict[str, str],
    b64_env_name: str,
    env_name: str = "",
    *,
    allow_ci_default_file: bool = True,
) -> tuple[str, Path | None]:
    b64 = os.environ.get(b64_env_name, "").strip()
    if b64:
        temp = tempfile.NamedTemporaryFile("wb", suffix=".kubeconfig", delete=False)
        temp.write(base64.b64decode(b64))
        temp.flush()
        temp.close()
        return temp.name, Path(temp.name)
    explicit_file = os.environ.get("DB_JOB_KUBECONFIG_FILE", "").strip()
    if explicit_file:
        resolved = Path(explicit_file)
        if not resolved.is_file():
            raise FileNotFoundError(f"missing DB_JOB_KUBECONFIG_FILE: {resolved}")
        return str(resolved), None
    ci_env_name = env_name or platform_env.get("PULUMI_ENV_NAME", "").strip()
    if allow_ci_default_file and ci_env_name:
        ci_file = Path("/etc/lightclaw-ci") / f"kubeconfig_{ci_env_name.replace('-', '_')}"
        if ci_file.is_file():
            return str(ci_file), None
    kubeconfig = platform_env.get("DEPLOY_KUBECONFIG", "").strip()
    if not kubeconfig:
        expected = ""
        if ci_env_name:
            expected = f", or provide /etc/lightclaw-ci/kubeconfig_{ci_env_name.replace('-', '_')}"
        raise ValueError(
            "DEPLOY_KUBECONFIG missing in platform.env and no kubeconfig b64 env provided"
            f"{expected}"
        )
    resolved = Path(kubeconfig)
    if not resolved.is_absolute():
        resolved = Path.cwd() / resolved
    if not resolved.is_file():
        raise FileNotFoundError(f"missing kubeconfig file: {resolved}")
    return str(resolved), None


def kubectl_command(cmd: list[str]) -> list[str]:
    if cmd and cmd[0] == "kubectl" and not any(part.startswith("--request-timeout=") for part in cmd):
        return [cmd[0], "--request-timeout=60s", *cmd[1:]]
    return cmd


def is_transient_kubectl_message(output: str) -> bool:
    transient_markers = (
        ": EOF",
        "Unable to connect to the server: EOF",
        "Client.Timeout",
        "connection reset by peer",
        "net/http: TLS handshake timeout",
        "i/o timeout",
        "unexpected EOF",
    )
    return any(marker in output for marker in transient_markers)


def is_transient_kubectl_error(result: CommandResult) -> bool:
    output = "\n".join(part for part in (result.stdout, result.stderr) if part)
    return is_transient_kubectl_message(output)


def kubectl_run(cmd: list[str], *, input_text: str | None = None, retries: int = 1) -> CommandResult:
    attempts = max(1, retries)
    kubectl_cmd = kubectl_command(cmd)
    last_result: CommandResult | None = None
    for attempt in range(1, attempts + 1):
        try:
            result = run_command(kubectl_cmd, input_text=input_text, timeout=75)
        except subprocess.TimeoutExpired as exc:
            result = CommandResult(
                kubectl_cmd,
                124,
                stdout=exc.stdout or "",
                stderr=(exc.stderr or "") + "\nkubectl command timed out after 75s",
            )
        if result.returncode == 0:
            return result
        last_result = result
        if attempt < attempts:
            time.sleep(min(2 * attempt, 10))
    assert last_result is not None
    return last_result


def kubectl_json(kubeconfig: str, namespace: str, kind: str, name: str, *, retries: int = 1) -> dict[str, Any]:
    result = kubectl_run(
        ["kubectl", "--kubeconfig", kubeconfig, "-n", namespace, "get", kind, name, "-o", "json"],
        retries=retries,
    )
    if result.returncode != 0:
        raise RuntimeError(f"kubectl get {kind}/{name} failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}")
    return json.loads(result.stdout)


def kubectl_secret_value(kubeconfig: str, namespace: str, secret_name: str, key: str, *, retries: int = 1) -> str:
    secret = kubectl_json(kubeconfig, namespace, "secret", secret_name, retries=retries)
    encoded = str(secret.get("data", {}).get(key, "")).strip()
    if not encoded:
        return ""
    return base64.b64decode(encoded).decode()


def first_container_image(deploy: dict[str, Any]) -> str:
    containers = deploy["spec"]["template"]["spec"].get("containers") or []
    if not containers:
        raise ValueError("deployment has no containers")
    return containers[0]["image"]


def resolve_job_image(
    args: argparse.Namespace,
    spec: dict[str, Any],
    kubeconfig: str,
    service_platform_env: dict[str, str],
) -> str:
    if args.image_override.strip() and not spec.get("ignore_image_override"):
        return args.image_override.strip()
    fixed_image = spec.get("image", "").strip()
    if fixed_image:
        return fixed_image
    image_env_key = spec.get("image_env_key", "").strip()
    if image_env_key:
        image = service_platform_env.get(image_env_key, "").strip()
        if not image:
            raise ValueError(f"missing {image_env_key} in service platform env")
        return image
    deploy = kubectl_json(
        kubeconfig,
        spec["namespace"],
        "deployment",
        spec["deployment"],
        retries=getattr(args, "kubectl_retries", 1),
    )
    return first_container_image(deploy)


def build_configmap_manifest(namespace: str, name: str, source_dir: Path) -> dict[str, Any]:
    result = run_command(
        [
            "kubectl",
            "-n",
            namespace,
            "create",
            "configmap",
            name,
            f"--from-file={source_dir}/",
            "--dry-run=client",
            "-o",
            "json",
        ]
    )
    if result.returncode != 0:
        raise RuntimeError(f"kubectl create configmap {name} failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}")
    return json.loads(result.stdout)


def build_ctl_dynamic_resources(
    job_name: str,
    namespace: str,
    env_name: str,
    deploy_root: Path,
    platform_env: dict[str, str],
    service_platform_env: dict[str, str],
    db_contract: dict[str, Any],
    kubeconfig: str = "",
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    mysql_host = service_platform_env.get("CTL_TEST_MYSQL_HOST", "").strip()
    resolved_secrets = resolve_contract_secret_values(deploy_root, env_name, db_contract)
    resolver_name = str(db_contract.get("db_job_secret_resolver") or "").strip()
    mysql_password = platform_env.get("CTL_TEST_MYSQL_PASSWORD", "").strip() or runtime_secret_value(
        "CTL_TEST_MYSQL_PASSWORD", env_name
    )
    if kubeconfig and namespace.startswith("lightvela-playground-"):
        mysql_password = (
            kubectl_secret_value(kubeconfig, namespace, "playground-runtime-secrets", "MYSQL_ROOT_PASSWORD").strip()
            or mysql_password
        )
    elif resolver_name:
        mysql_password = resolved_secrets.get(resolver_name, "").strip() or mysql_password
    if not mysql_host:
        raise ValueError("missing CTL_TEST_MYSQL_HOST in ctl platform env")
    if not mysql_password:
        raise ValueError(
            "missing ctl DB password from db_contract.secret_resolvers, platform.env, environment, or /etc/lightclaw-ci"
        )

    ctl_db = (
        service_platform_env.get("CTL_DB", "").strip()
        or platform_env.get("CTL_DB", "").strip()
        or default_ctl_database(env_name)
    )
    dsn = f"mysql://root:{mysql_password}@tcp({mysql_host}:3306)/{ctl_db}?multiStatements=true"  # pragma: allowlist secret
    migrations_name = f"{job_name}-migrations"
    secret_name = f"{job_name}-secrets"
    migrations = build_configmap_manifest(namespace, migrations_name, REPO_ROOT / "ctl" / "migrations")
    secret = build_secret_manifest(
        namespace,
        secret_name,
        {
            "MYSQL_ROOT_PASSWORD": mysql_password,
            "CTL_MIGRATE_DSN": dsn,
        },
        labels={
            "gitops.clawhub.dev/service": "ctl",
            "gitops.clawhub.dev/operation": "migration",
            "gitops.clawhub.dev/managed-by": "run_gitops_db_job.py",
        },
    )

    dynamic = {
        "env": [
            {"name": "CTL_MIGRATE_DSN", "valueFrom": secret_env_ref(secret_name, "CTL_MIGRATE_DSN")},
        ],
        "volumeMounts": [{"name": "migrations", "mountPath": "/migrations"}],
        "volumes": [{"name": "migrations", "configMap": {"name": migrations_name}}],
        "initContainers": [
            {
                "name": "mysql-init",
                "image": "mysql:8.0",
                "imagePullPolicy": "IfNotPresent",
                "env": [
                    {"name": "MYSQL_HOST", "value": mysql_host},
                    {"name": "MYSQL_PORT", "value": "3306"},
                    {"name": "MYSQL_ROOT_USER", "value": "root"},
                    {"name": "CTL_DB", "value": ctl_db},
                    {
                        "name": "MYSQL_ROOT_PASSWORD",
                        "valueFrom": secret_env_ref(secret_name, "MYSQL_ROOT_PASSWORD"),
                    },
                ],
                "command": [
                    "/bin/sh",
                    "-c",
                    "set -eu\nmysql --host=\"${MYSQL_HOST}\" --port=\"${MYSQL_PORT}\" --user=\"${MYSQL_ROOT_USER}\" --password=\"${MYSQL_ROOT_PASSWORD}\" <<SQL\nCREATE DATABASE IF NOT EXISTS \\`${CTL_DB}\\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;\nFLUSH PRIVILEGES;\nSQL",  # pragma: allowlist secret
                ],
            }
        ],
        "secretValues": {
            "MYSQL_ROOT_PASSWORD": mysql_password,
            "CTL_MIGRATE_DSN": dsn,
        },
    }
    return dynamic, [secret, migrations]


def default_ctl_database(env_name: str) -> str:
    if re.fullmatch(r"sandbox-(bj|kr)-\d+", env_name):
        return f"ctl_{env_name.replace('-', '_')}"
    return "ctl"


def generate_job_name(service: str, operation: str) -> str:
    stamp = time.strftime("%Y%m%d%H%M%S", time.gmtime())
    return f"gitops-{service}-{operation}-{stamp}"


def build_job_manifest(
    service: str,
    operation: str,
    revision: str,
    requested_by: str,
    spec: dict[str, Any],
    image: str,
    job_name: str,
    dynamic: dict[str, Any] | None = None,
) -> dict[str, Any]:
    dynamic = dynamic or {}
    container_name = spec.get("container_name", operation)
    container: dict[str, Any] = {
        "name": container_name,
        "image": image,
        "imagePullPolicy": spec.get("imagePullPolicy", "Always"),
    }
    env_from: list[dict[str, Any]] = []
    if spec.get("configmap"):
        env_from.append({"configMapRef": {"name": spec["configmap"]}})
    if spec.get("secret"):
        env_from.append({"secretRef": {"name": spec["secret"]}})
    if dynamic.get("envFrom"):
        env_from.extend(copy.deepcopy(dynamic["envFrom"]))
    if env_from:
        container["envFrom"] = env_from
    if spec.get("command"):
        container["command"] = copy.deepcopy(spec["command"])
    if spec.get("args"):
        container["args"] = copy.deepcopy(spec["args"])
    if dynamic.get("env"):
        container["env"] = copy.deepcopy(dynamic["env"])
    if dynamic.get("volumeMounts"):
        container["volumeMounts"] = copy.deepcopy(dynamic["volumeMounts"])

    pod_spec: dict[str, Any] = {
        "restartPolicy": spec.get("restartPolicy", "Never"),
        "containers": [container],
    }
    for field in ("initContainers", "volumes", "nodeSelector", "dnsPolicy", "hostNetwork"):
        if field in spec:
            pod_spec[field] = copy.deepcopy(spec[field])
    for field in ("initContainers", "volumes", "nodeSelector", "dnsPolicy", "hostNetwork"):
        if field in dynamic:
            pod_spec[field] = copy.deepcopy(dynamic[field])

    return {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {
            "name": job_name,
            "namespace": spec["namespace"],
            "labels": {
                "gitops.clawhub.dev/service": service,
                "gitops.clawhub.dev/operation": operation,
                "gitops.clawhub.dev/managed-by": "run_gitops_db_job.py",
            },
            "annotations": {
                "gitops.clawhub.dev/revision": revision,
                "gitops.clawhub.dev/requested-by": requested_by,
            },
        },
        "spec": {
            "backoffLimit": spec.get("backoffLimit", 1),
            "ttlSecondsAfterFinished": spec.get("ttlSecondsAfterFinished", 86400),
            "template": {
                "metadata": {
                    "labels": {
                        "gitops.clawhub.dev/service": service,
                        "gitops.clawhub.dev/operation": operation,
                    }
                },
                "spec": pod_spec,
            },
        },
    }


def apply_manifest(kubeconfig: str, manifest: dict[str, Any], *, retries: int = 1) -> None:
    result = kubectl_run(
        ["kubectl", "--kubeconfig", kubeconfig, "apply", "--validate=false", "-f", "-"],
        input_text=json.dumps(manifest),
        retries=retries,
    )
    if result.returncode != 0:
        raise RuntimeError(f"kubectl apply failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}")


def get_job_status(kubeconfig: str, namespace: str, name: str, *, retries: int = 1) -> dict[str, Any]:
    return kubectl_json(kubeconfig, namespace, "job", name, retries=retries)


def wait_for_job(kubeconfig: str, namespace: str, name: str, timeout_seconds: int, *, retries: int = 1) -> str:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        try:
            job = get_job_status(kubeconfig, namespace, name, retries=retries)
        except RuntimeError as exc:
            if not is_transient_kubectl_message(str(exc)):
                raise
            print(f"warning: transient kubectl get job/{name} failed; retrying until timeout", file=sys.stderr)
            time.sleep(5)
            continue
        status = job.get("status") or {}
        if status.get("succeeded", 0) > 0:
            return "succeeded"
        if status.get("failed", 0) > 0 and status.get("active", 0) == 0:
            return "failed"
        time.sleep(5)
    return "timeout"


def write_summary(path: str, summary: dict[str, Any]) -> None:
    if not path:
        return
    output = Path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(summary, ensure_ascii=False, indent=2))


def load_job_db_contract(bundle_manifest: Path, service: str, env_name: str) -> dict[str, Any]:
    try:
        manifest = load_manifest(bundle_manifest)
        return dict(load_bundle(manifest, service, env_name).db_contract)
    except KeyError:
        return {}


def kubectl_delete(kubeconfig: str, manifest: dict[str, Any], *, retries: int = 1) -> None:
    result = kubectl_run(
        ["kubectl", "--kubeconfig", kubeconfig, "delete", "-f", "-", "--ignore-not-found=true"],
        input_text=json.dumps(manifest),
        retries=retries,
    )
    if result.returncode != 0:
        print(f"warning: kubectl cleanup failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}", file=sys.stderr)


def collect_job_logs(
    kubeconfig: str,
    namespace: str,
    name: str,
    secret_values: dict[str, str],
    *,
    retries: int = 1,
) -> str:
    result = kubectl_run(
        [
            "kubectl",
            "--kubeconfig",
            kubeconfig,
            "-n",
            namespace,
            "logs",
            f"job/{name}",
            "--all-containers=true",
            "--tail=200",
        ],
        retries=retries,
    )
    combined = "\n".join(part for part in (result.stdout, result.stderr) if part.strip())
    return redact(combined, secret_values)


def main() -> int:
    global REPO_ROOT

    args = parse_args()
    if args.repo_root.strip():
        REPO_ROOT = Path(args.repo_root).resolve()
    deploy_root = Path(args.deploy_root).resolve() if args.deploy_root.strip() else REPO_ROOT

    key = (args.service, args.operation)
    if key not in SERVICE_SPECS:
        print(f"unsupported service/operation combination: {args.service}/{args.operation}", file=sys.stderr)
        return 1

    platform_env = load_platform_env(args.env, deploy_root)
    kubeconfig = ""
    temp_path: Path | None = None
    requested_by = os.environ.get("GITLAB_USER_LOGIN") or os.environ.get("USER") or "unknown"
    bundle_service = args.bundle_service.strip() or args.service
    db_contract = load_job_db_contract(Path(args.bundle_manifest).resolve(), bundle_service, args.env)

    apply_manifest_doc: dict[str, Any] | None = None
    manifest: dict[str, Any] | None = None
    dynamic: dict[str, Any] = {}
    try:
        spec = copy.deepcopy(SERVICE_SPECS[key])
        namespace_override = resolve_job_namespace(deploy_root, args.env, args.service, args.namespace.strip())
        if namespace_override:
            spec["namespace"] = namespace_override
        require_repo_payload_revision(spec, args.revision)
        service_platform_env = load_service_platform_env(spec, args.env, deploy_root)
        if args.apply or not (args.image_override.strip() or spec.get("image") or spec.get("image_env_key")):
            cluster_name = resolve_kubeconfig_cluster_name(platform_env, deploy_root, args.env, args.service)
            kubeconfig, temp_path = resolve_kubeconfig(platform_env, args.kubeconfig_b64_env, cluster_name)
        image = resolve_job_image(args, spec, kubeconfig, service_platform_env)
        job_name = generate_job_name(args.service, args.operation)
        extra_resources: list[dict[str, Any]] = []
        if spec.get("dynamic_builder") == "ctl":
            dynamic, extra_resources = build_ctl_dynamic_resources(
                job_name,
                spec["namespace"],
                args.env,
                deploy_root,
                platform_env,
                service_platform_env,
                db_contract,
                kubeconfig,
            )
        manifest = build_job_manifest(
            args.service, args.operation, args.revision, requested_by, spec, image, job_name=job_name, dynamic=dynamic
        )
        if extra_resources:
            apply_manifest_doc = {"apiVersion": "v1", "kind": "List", "items": [*extra_resources, manifest]}
        else:
            apply_manifest_doc = manifest

        summary: dict[str, Any] = {
            "service": args.service,
            "operation": args.operation,
            "env": args.env,
            "revision": args.revision,
            "namespace": spec["namespace"],
            "deployment": spec["deployment"],
            "job_name": manifest["metadata"]["name"],
            "image": image,
            "auxiliary_resources": [item["metadata"]["name"] for item in extra_resources],
            "log_command": f"kubectl --kubeconfig <kubeconfig> -n {spec['namespace']} logs job/{manifest['metadata']['name']}",
            "status": "rendered",
        }

        if args.apply:
            apply_manifest(kubeconfig, apply_manifest_doc, retries=args.kubectl_retries)
            summary["status"] = "applied"

        if args.apply and args.wait:
            result = wait_for_job(
                kubeconfig,
                spec["namespace"],
                manifest["metadata"]["name"],
                args.timeout_seconds,
                retries=args.kubectl_retries,
            )
            summary["status"] = result
            if result != "succeeded":
                logs = collect_job_logs(
                    kubeconfig,
                    spec["namespace"],
                    manifest["metadata"]["name"],
                    dynamic.get("secretValues") or {},
                    retries=args.kubectl_retries,
                )
                if logs:
                    summary["logs"] = logs
                    print("DB job logs:", file=sys.stderr)
                    print(logs, file=sys.stderr)
                write_summary(args.output_json, summary)
                print(json.dumps(summary, ensure_ascii=False, indent=2))
                return 1

        write_summary(args.output_json, summary)
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0
    finally:
        if args.apply and apply_manifest_doc is not None:
            kubectl_delete(kubeconfig, apply_manifest_doc, retries=args.kubectl_retries)
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


if __name__ == "__main__":
    sys.exit(main())
