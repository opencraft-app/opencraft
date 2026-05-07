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
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent


SERVICE_SPECS: dict[tuple[str, str], dict[str, Any]] = {
    ("payment", "migration"): {
        "namespace": "user-auth",
        "deployment": "payment",
        "configmap": "payment-config",
        "secret": "payment-runtime-secrets",
        "command": ["/usr/local/bin/payment-migrate"],
    },
    ("subscription", "migration"): {
        "namespace": "user-auth",
        "deployment": "subscription",
        "configmap": "subscription-config",
        "secret": "subscription-runtime-secrets",
        "command": ["/usr/local/bin/subscription-migrate"],
    },
    ("lightclaw-auth", "migration"): {
        "namespace": "user-auth",
        "deployment": "lightclaw-auth",
        "configmap": "lightclaw-auth-config",
        "secret": "lightclaw-auth-secrets",
        "command": ["/usr/local/bin/lightclaw-auth-migrate"],
    },
    ("lightclaw-auth", "seed"): {
        "namespace": "user-auth",
        "deployment": "lightclaw-auth",
        "configmap": "lightclaw-auth-config",
        "secret": "lightclaw-auth-secrets",
        "command": ["/usr/local/bin/lightclaw-auth-seed"],
    },
    ("ai-gateway", "migration"): {
        "namespace": "ai-gateway",
        "deployment": "gateway-backend",
        "configmap": "ai-gateway-runtime-config",
        "secret": "ai-gateway-runtime-secrets",
        "command": ["/usr/local/bin/ai-gateway-migrate"],
    },
    ("ctl", "migration"): {
        "namespace": "ctl",
        "deployment": "ctl-api",
        "image": "migrate/migrate:v4.18.3",
        "platform_env_file": "argocd/services/ctl/{env}/ctl-platform.env",
        "dynamic_builder": "ctl",
        "requires_repo_revision": True,
        "command": ["/bin/sh", "-c", 'set -eu\nmigrate -path=/migrations -database "${CTL_MIGRATE_DSN}" up'],
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
    parser.add_argument("--service", required=True, choices=sorted({svc for svc, _ in SERVICE_SPECS}))
    parser.add_argument("--operation", required=True, choices=sorted({op for _, op in SERVICE_SPECS}))
    parser.add_argument("--env", required=True, help="Deploy env name, e.g. beijing-sandbox")
    parser.add_argument("--revision", required=True, help="Git revision or commit SHA this job targets")
    parser.add_argument("--apply", action="store_true", help="Apply the job to the cluster")
    parser.add_argument("--wait", action="store_true", help="Wait for job completion")
    parser.add_argument("--timeout-seconds", type=int, default=1800, help="Wait timeout in seconds")
    parser.add_argument("--output-json", default="", help="Optional path to write execution summary JSON")
    parser.add_argument(
        "--image-override",
        default="",
        help="Optional explicit image override. When set, use this image instead of reading from the live Deployment.",
    )
    parser.add_argument(
        "--kubeconfig-b64-env",
        default="DB_JOB_KUBECONFIG_B64",
        help="Environment variable holding base64 kubeconfig for CI use",
    )
    return parser.parse_args()


def load_platform_env(env_name: str) -> dict[str, str]:
    path = REPO_ROOT / "deploy" / "envs" / env_name / "platform.env"
    return load_env_file(path) if path.is_file() else {}


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


def load_service_platform_env(spec: dict[str, Any], env_name: str) -> dict[str, str]:
    relative = spec.get("platform_env_file", "").strip()
    if not relative:
        return {}
    path = REPO_ROOT / relative.format(env=env_name)
    return load_env_file(path)


def git_output(args: list[str]) -> str:
    result = subprocess.run(["git", *args], cwd=REPO_ROOT, capture_output=True, text=True)
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


def resolve_kubeconfig(platform_env: dict[str, str], env_name: str, b64_env_name: str) -> tuple[str, Path | None]:
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
    ci_env_name = platform_env.get("PULUMI_ENV_NAME", "").strip() or env_name
    ci_file = Path("/etc/lightclaw-ci") / f"kubeconfig_{ci_env_name.replace('-', '_')}"
    if ci_file.is_file():
        return str(ci_file), None
    kubeconfig = platform_env.get("DEPLOY_KUBECONFIG", "").strip()
    if not kubeconfig:
        raise ValueError("DEPLOY_KUBECONFIG missing in platform.env and no kubeconfig b64 env provided")
    resolved = Path(kubeconfig)
    if not resolved.is_absolute():
        resolved = Path.cwd() / resolved
    if not resolved.is_file():
        raise FileNotFoundError(f"missing kubeconfig file: {resolved}")
    return str(resolved), None


def kubectl_json(kubeconfig: str, namespace: str, kind: str, name: str) -> dict[str, Any]:
    result = subprocess.run(
        ["kubectl", "--kubeconfig", kubeconfig, "-n", namespace, "get", kind, name, "-o", "json"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"kubectl get {kind}/{name} failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}")
    return json.loads(result.stdout)


def first_container_image(deploy: dict[str, Any]) -> str:
    containers = deploy["spec"]["template"]["spec"].get("containers") or []
    if not containers:
        raise ValueError("deployment has no containers")
    return containers[0]["image"]


def resolve_job_image(
    args: argparse.Namespace, spec: dict[str, Any], kubeconfig: str, service_platform_env: dict[str, str]
) -> str:
    if args.image_override.strip():
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
    deploy = kubectl_json(kubeconfig, spec["namespace"], "deployment", spec["deployment"])
    return first_container_image(deploy)


def build_configmap_manifest(namespace: str, name: str, source_dir: Path) -> dict[str, Any]:
    result = subprocess.run(
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
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"kubectl create configmap {name} failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}")
    return json.loads(result.stdout)


def build_ctl_dynamic_resources(
    job_name: str,
    env_name: str,
    platform_env: dict[str, str],
    service_platform_env: dict[str, str],
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    mysql_host = service_platform_env.get("CTL_TEST_MYSQL_HOST", "").strip()
    mysql_password = platform_env.get("CTL_TEST_MYSQL_PASSWORD", "").strip() or runtime_secret_value(
        "CTL_TEST_MYSQL_PASSWORD", env_name
    )
    if not mysql_host:
        raise ValueError("missing CTL_TEST_MYSQL_HOST in ctl platform env")
    if not mysql_password:
        raise ValueError("missing CTL_TEST_MYSQL_PASSWORD in platform.env, environment, or /etc/lightclaw-ci")

    dsn = f"mysql://root:{mysql_password}@tcp({mysql_host}:3306)/ctl?multiStatements=true"  # pragma: allowlist secret
    migrations_name = f"{job_name}-migrations"
    migrations = build_configmap_manifest("ctl", migrations_name, REPO_ROOT / "ctl" / "migrations")

    dynamic = {
        "env": [{"name": "CTL_MIGRATE_DSN", "value": dsn}],
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
                    {"name": "CTL_DB", "value": "ctl"},
                    {"name": "MYSQL_ROOT_PASSWORD", "value": mysql_password},
                ],
                "command": [
                    "/bin/sh",
                    "-c",
                    "set -eu\nmysql --host=\"${MYSQL_HOST}\" --port=\"${MYSQL_PORT}\" --user=\"${MYSQL_ROOT_USER}\" --password=\"${MYSQL_ROOT_PASSWORD}\" <<SQL\nCREATE DATABASE IF NOT EXISTS \\`${CTL_DB}\\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;\nFLUSH PRIVILEGES;\nSQL",  # pragma: allowlist secret
                ],
            }
        ],
    }
    return dynamic, [migrations]


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


def apply_manifest(kubeconfig: str, manifest: dict[str, Any]) -> None:
    result = subprocess.run(
        ["kubectl", "--kubeconfig", kubeconfig, "apply", "-f", "-"],
        input=json.dumps(manifest),
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"kubectl apply failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}")


def get_job_status(kubeconfig: str, namespace: str, name: str) -> dict[str, Any]:
    return kubectl_json(kubeconfig, namespace, "job", name)


def wait_for_job(kubeconfig: str, namespace: str, name: str, timeout_seconds: int) -> str:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        job = get_job_status(kubeconfig, namespace, name)
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


def main() -> int:
    args = parse_args()
    key = (args.service, args.operation)
    if key not in SERVICE_SPECS:
        print(f"unsupported service/operation combination: {args.service}/{args.operation}", file=sys.stderr)
        return 1

    platform_env = load_platform_env(args.env)
    kubeconfig, temp_path = resolve_kubeconfig(platform_env, args.env, args.kubeconfig_b64_env)
    requested_by = os.environ.get("GITLAB_USER_LOGIN") or os.environ.get("USER") or "unknown"

    try:
        spec = SERVICE_SPECS[key]
        require_repo_payload_revision(spec, args.revision)
        service_platform_env = load_service_platform_env(spec, args.env)
        image = resolve_job_image(args, spec, kubeconfig, service_platform_env)
        job_name = generate_job_name(args.service, args.operation)
        dynamic: dict[str, Any] = {}
        extra_resources: list[dict[str, Any]] = []
        if spec.get("dynamic_builder") == "ctl":
            dynamic, extra_resources = build_ctl_dynamic_resources(job_name, args.env, platform_env, service_platform_env)
        manifest = build_job_manifest(
            args.service, args.operation, args.revision, requested_by, spec, image, job_name=job_name, dynamic=dynamic
        )
        apply_manifest_doc: dict[str, Any]
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
            apply_manifest(kubeconfig, apply_manifest_doc)
            summary["status"] = "applied"

        if args.apply and args.wait:
            result = wait_for_job(kubeconfig, spec["namespace"], manifest["metadata"]["name"], args.timeout_seconds)
            summary["status"] = result
            if result != "succeeded":
                write_summary(args.output_json, summary)
                print(json.dumps(summary, ensure_ascii=False, indent=2))
                return 1

        write_summary(args.output_json, summary)
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


if __name__ == "__main__":
    sys.exit(main())
