"""
Render and optionally run read-only DB contract checks in the target cluster.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any, Mapping

from contracts.bundles import DEFAULT_MANIFEST_PATH, load_bundle, load_manifest
from harness_ci.secrets import build_secret_manifest, redact, resolve_contract_secret_values, secret_env_ref


def load_env_file(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    values: dict[str, str] = {}
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key] = value
    return values


def required_mapping(raw: Any, name: str) -> dict[str, str]:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise TypeError(f"{name} must be a mapping")
    return {str(key): str(value) for key, value in raw.items()}


def resolve_service_platform_env(repo_root: Path, env: str, verifier: Mapping[str, Any]) -> dict[str, str]:
    template = str(verifier.get("service_platform_env_file") or "").strip()
    if not template:
        return {}
    path = repo_root / template.format(env=env)
    values = load_env_file(path)
    if not values:
        raise FileNotFoundError(f"missing or empty service platform env file: {path}")
    return values


def resolve_platform_env(repo_root: Path, env: str, verifier: Mapping[str, Any]) -> dict[str, str]:
    if not verifier.get("env_from_platform"):
        return {}
    path = repo_root / "deploy" / "envs" / env / "platform.env"
    return load_env_file(path)


def runtime_secret_value(source_key: str, env: str) -> str:
    value = os.environ.get(source_key, "").strip()
    if value:
        return value
    normalized_env = env.replace("-", "_")
    lower_key = source_key.lower()
    for path in (
        Path("/etc/lightclaw-ci") / f"{lower_key}_{normalized_env}",
        Path("/etc/lightclaw-ci") / lower_key,
    ):
        if path.is_file():
            return path.read_text().strip()
    return ""


def copy_env_values(
    source: Mapping[str, str],
    mapping: Mapping[str, str],
    source_name: str,
    *,
    env: str = "",
    allow_runtime_fallback: bool = False,
) -> dict[str, str]:
    values: dict[str, str] = {}
    for target_key, source_key in mapping.items():
        value = str(source.get(source_key, "")).strip()
        if not value and allow_runtime_fallback:
            value = runtime_secret_value(source_key, env)
        if not value:
            raise ValueError(f"missing {source_key} in {source_name}")
        values[target_key] = value
    return values


def resolve_runtime_env(
    repo_root: Path,
    env: str,
    verifier: Mapping[str, Any],
    db_contract: Mapping[str, Any] | None = None,
) -> tuple[dict[str, str], dict[str, str], dict[str, str]]:
    service_platform_env = resolve_service_platform_env(repo_root, env, verifier)
    platform_env = resolve_platform_env(repo_root, env, verifier)
    resolved_secrets = resolve_contract_secret_values(repo_root, env, db_contract or {})

    env_values = required_mapping(verifier.get("static_env"), "verifier.static_env")
    env_values.update(
        copy_env_values(
            service_platform_env,
            required_mapping(verifier.get("env_from_service_platform"), "verifier.env_from_service_platform"),
            str(verifier.get("service_platform_env_file")),
        )
    )
    env_values.update(
        copy_env_values(
            platform_env,
            required_mapping(verifier.get("env_from_platform"), "verifier.env_from_platform"),
            f"deploy/envs/{env}/platform.env, environment, or /etc/lightclaw-ci",
            env=env,
            allow_runtime_fallback=True,
        )
    )
    env_secret_values: dict[str, str] = {}
    for target_key, resolver_name in required_mapping(
        verifier.get("env_from_secret_resolver"),
        "verifier.env_from_secret_resolver",
    ).items():
        value = resolved_secrets.get(resolver_name, "").strip()
        if not value:
            raise ValueError(f"missing secret resolver output {resolver_name} for {target_key}")
        env_secret_values[target_key] = value

    node_selector = required_mapping(verifier.get("node_selector"), "verifier.node_selector")
    node_selector.update(
        copy_env_values(
            service_platform_env,
            required_mapping(
                verifier.get("node_selector_from_service_platform"),
                "verifier.node_selector_from_service_platform",
            ),
            str(verifier.get("service_platform_env_file")),
        )
    )
    return env_values, node_selector, env_secret_values


def resolve_kubeconfig(repo_root: Path, env: str, b64_env_name: str) -> tuple[str, Path | None]:
    import os

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

    ci_file = Path("/etc/lightclaw-ci") / f"kubeconfig_{env.replace('-', '_')}"
    if ci_file.is_file():
        return str(ci_file), None

    platform_env = load_env_file(repo_root / "deploy" / "envs" / env / "platform.env")
    kubeconfig = platform_env.get("DEPLOY_KUBECONFIG", "").strip()
    if not kubeconfig:
        raise ValueError("DEPLOY_KUBECONFIG missing in platform.env and no kubeconfig b64 env provided")
    resolved = Path(kubeconfig)
    if not resolved.is_absolute():
        resolved = repo_root / resolved
    if not resolved.is_file():
        raise FileNotFoundError(f"missing kubeconfig file: {resolved}")
    return str(resolved), None


def max_migration_version(repo_root: Path, source: str) -> int:
    source_dir = repo_root / source
    if not source_dir.is_dir():
        return 0
    versions: list[int] = []
    for path in source_dir.glob("*.up.sql"):
        match = re.match(r"^(\d+)_", path.name)
        if match:
            versions.append(int(match.group(1)))
    return max(versions) if versions else 0


def shell_single_quote(value: str) -> str:
    return "'" + value.replace("'", "'\"'\"'") + "'"


def build_check_script(verifier: dict[str, Any], expected_version: int) -> str:
    database_env = str(verifier["database_env"])
    user_env = str(verifier["user_env"])
    password_env = str(verifier["password_env"])
    baseline_checks = verifier.get("baseline_checks") or []

    lines = [
        "set -eu",
        "value() {",
        '  name="$1"',
        '  eval "printf \'%s\' \\"\\${${name}:-}\\""',
        "}",
        f"db=\"$(value {shell_single_quote(database_env)})\"",
        f"user=\"$(value {shell_single_quote(user_env)})\"",
        f"password=\"$(value {shell_single_quote(password_env)})\"",
        'test -n "${MYSQL_HOST:-}"',
        'test -n "${MYSQL_PORT:-}"',
        'test -n "$db"',
        'test -n "$user"',
        'test -n "$password"',
        'mysql_query() { mysql --host="${MYSQL_HOST}" --port="${MYSQL_PORT}" --user="$user" --password="$password" "$db" -Nse "$1"; }',
        'dirty_count="$(mysql_query "SELECT COUNT(*) FROM schema_migrations WHERE dirty = 1")"',
        'test "$dirty_count" = "0"',
    ]
    if expected_version > 0:
        lines.extend(
            [
                'version="$(mysql_query "SELECT COALESCE(MAX(version), 0) FROM schema_migrations")"',
                f'test "$version" -ge "{expected_version}"',
                f'echo "schema_migrations version=$version expected_min={expected_version} dirty=0"',
            ]
        )
    for check in baseline_checks:
        name = str(check["name"])
        query = str(check["query"])
        lines.append(f"result=\"$(mysql_query {shell_single_quote(query)})\"")
        if "expected" in check:
            expected = str(check["expected"])
            lines.append(f"test \"$result\" = {shell_single_quote(expected)}")
            lines.append(f"echo \"baseline {name} result=$result expected={expected}\"")
        elif "min" in check:
            minimum = int(check["min"])
            lines.append(f"test \"$result\" -ge \"{minimum}\"")
            lines.append(f"echo \"baseline {name} result=$result min={minimum}\"")
        else:
            raise ValueError(f"baseline check {name} must define expected or min")
    return "\n".join(lines) + "\n"


def build_job_manifest(
    service: str,
    env: str,
    verifier: dict[str, Any],
    expected_version: int,
    *,
    env_values: Mapping[str, str] | None = None,
    env_secret_refs: Mapping[str, tuple[str, str]] | None = None,
    node_selector: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    job_name = f"db-contract-{service.replace('_', '-').replace('/', '-')}-{env}-{int(time.time())}"
    env_from = []
    if verifier.get("configmap"):
        env_from.append({"configMapRef": {"name": verifier["configmap"]}})
    if verifier.get("secret"):
        env_from.append({"secretRef": {"name": verifier["secret"]}})
    pod_spec: dict[str, Any] = {
        "restartPolicy": "Never",
        "containers": [
            {
                "name": "verify",
                "image": verifier.get("image", "mysql:8.0"),
                "imagePullPolicy": "IfNotPresent",
                "envFrom": env_from,
                "command": ["/bin/sh", "-c", build_check_script(verifier, expected_version)],
            }
        ],
    }
    if env_values:
        pod_spec["containers"][0]["env"] = [
            {"name": key, "value": value} for key, value in sorted(env_values.items())
        ]
    if env_secret_refs:
        pod_spec["containers"][0].setdefault("env", [])
        pod_spec["containers"][0]["env"].extend(
            [
                {"name": key, "valueFrom": secret_env_ref(secret_name, secret_key)}
                for key, (secret_name, secret_key) in sorted(env_secret_refs.items())
            ]
        )
    if verifier.get("hostNetwork") or verifier.get("host_network"):
        pod_spec["hostNetwork"] = True
        pod_spec["dnsPolicy"] = str(
            verifier.get("dnsPolicy") or verifier.get("dns_policy") or "ClusterFirstWithHostNet"
        )
    if node_selector:
        pod_spec["nodeSelector"] = dict(node_selector)
    return {
        "apiVersion": "batch/v1",
        "kind": "Job",
        "metadata": {
            "name": job_name,
            "namespace": verifier["namespace"],
            "labels": {
                "gitops.clawhub.dev/service": service,
                "gitops.clawhub.dev/env": env,
                "gitops.clawhub.dev/operation": "db-contract-readiness",
                "gitops.clawhub.dev/managed-by": "verify_db_contract.py",
            },
        },
        "spec": {
            "backoffLimit": 0,
            "ttlSecondsAfterFinished": 300,
            "template": {"spec": pod_spec},
        },
    }


def kubectl(kubeconfig: str, args: list[str], *, input_text: str | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["kubectl", "--kubeconfig", kubeconfig, *args],
        input=input_text,
        capture_output=True,
        text=True,
    )


def apply_manifest(kubeconfig: str, manifest: dict[str, Any]) -> None:
    result = kubectl(kubeconfig, ["apply", "-f", "-"], input_text=json.dumps(manifest))
    if result.returncode != 0:
        raise RuntimeError(f"kubectl apply failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}")


def delete_manifest(kubeconfig: str, manifest: dict[str, Any]) -> None:
    result = kubectl(
        kubeconfig,
        ["delete", "-f", "-", "--ignore-not-found=true"],
        input_text=json.dumps(manifest),
    )
    if result.returncode != 0:
        print(f"warning: kubectl cleanup failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}", file=sys.stderr)


def wait_for_job(kubeconfig: str, namespace: str, name: str, timeout_seconds: int) -> str:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        result = kubectl(kubeconfig, ["-n", namespace, "get", "job", name, "-o", "json"])
        if result.returncode != 0:
            raise RuntimeError(f"kubectl get job failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}")
        status = (json.loads(result.stdout).get("status") or {})
        if status.get("succeeded", 0) > 0:
            return "succeeded"
        if status.get("failed", 0) > 0 and status.get("active", 0) == 0:
            return "failed"
        time.sleep(5)
    return "timeout"


def collect_job_logs(kubeconfig: str, namespace: str, name: str, secret_values: Mapping[str, str]) -> str:
    result = kubectl(
        kubeconfig,
        ["-n", namespace, "logs", f"job/{name}", "--all-containers=true", "--tail=200"],
    )
    combined = "\n".join(part for part in (result.stdout, result.stderr) if part.strip())
    return redact(combined, secret_values)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Verify a service DB contract with a read-only Kubernetes Job.")
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--bundle-manifest", default=str(DEFAULT_MANIFEST_PATH))
    parser.add_argument("--service", required=True)
    parser.add_argument("--env", required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--wait", action="store_true")
    parser.add_argument("--timeout-seconds", type=int, default=900)
    parser.add_argument("--output-json", default="")
    parser.add_argument("--kubeconfig-b64-env", default="DB_JOB_KUBECONFIG_B64")
    return parser


def write_summary(path: str, summary: dict[str, Any]) -> None:
    if not path:
        return
    output = Path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(summary, ensure_ascii=False, indent=2))


def main() -> int:
    args = build_parser().parse_args()
    repo_root = Path(args.repo_root).resolve()
    manifest = load_manifest(Path(args.bundle_manifest).resolve())
    bundle = load_bundle(manifest, args.service, args.env)
    contract = bundle.db_contract
    if contract.get("mode") == "none":
        summary = {"service": args.service, "env": args.env, "status": "not-required"}
        write_summary(args.output_json, summary)
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0
    verifier = contract.get("verifier") or {}
    if not verifier:
        raise ValueError(f"bundle {args.service} does not define db_contract.verifier")
    expected_version = max_migration_version(repo_root, str(contract.get("expected_migration_source") or ""))
    env_values, node_selector, env_secret_values = resolve_runtime_env(repo_root, args.env, verifier, contract)
    secret_name = ""
    env_secret_refs: dict[str, tuple[str, str]] = {}
    secret_manifest: dict[str, Any] | None = None
    if env_secret_values:
        secret_name = f"db-contract-{args.service.replace('_', '-').replace('/', '-')}-{args.env}-{int(time.time())}-secrets"
        secret_manifest = build_secret_manifest(
            verifier["namespace"],
            secret_name,
            env_secret_values,
            labels={
                "gitops.clawhub.dev/service": args.service,
                "gitops.clawhub.dev/env": args.env,
                "gitops.clawhub.dev/operation": "db-contract-readiness",
                "gitops.clawhub.dev/managed-by": "verify_db_contract.py",
            },
        )
        env_secret_refs = {key: (secret_name, key) for key in env_secret_values}
    manifest_doc = build_job_manifest(
        args.service,
        args.env,
        verifier,
        expected_version,
        env_values=env_values,
        env_secret_refs=env_secret_refs,
        node_selector=node_selector,
    )
    apply_manifest_doc = (
        {"apiVersion": "v1", "kind": "List", "items": [secret_manifest, manifest_doc]}
        if secret_manifest
        else manifest_doc
    )
    summary = {
        "service": args.service,
        "env": args.env,
        "namespace": verifier["namespace"],
        "job_name": manifest_doc["metadata"]["name"],
        "expected_schema_version": expected_version,
        "auxiliary_resources": [secret_name] if secret_name else [],
        "status": "rendered",
    }
    temp_path: Path | None = None
    try:
        if args.apply:
            kubeconfig, temp_path = resolve_kubeconfig(repo_root, args.env, args.kubeconfig_b64_env)
            apply_manifest(kubeconfig, apply_manifest_doc)
            summary["status"] = "applied"
            if args.wait:
                status = wait_for_job(kubeconfig, verifier["namespace"], manifest_doc["metadata"]["name"], args.timeout_seconds)
                summary["status"] = status
                if status != "succeeded":
                    logs = collect_job_logs(
                        kubeconfig,
                        verifier["namespace"],
                        manifest_doc["metadata"]["name"],
                        env_secret_values,
                    )
                    if logs:
                        summary["logs"] = logs
                        print("DB readiness logs:", file=sys.stderr)
                        print(logs, file=sys.stderr)
                    write_summary(args.output_json, summary)
                    print(json.dumps(summary, ensure_ascii=False, indent=2))
                    return 1
        write_summary(args.output_json, summary)
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0
    finally:
        if args.apply and "kubeconfig" in locals():
            delete_manifest(kubeconfig, apply_manifest_doc)
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)
