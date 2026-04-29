"""
Render and optionally run read-only DB contract checks in the target cluster.
"""

from __future__ import annotations

import argparse
import base64
import json
import re
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

from harness_ci.bundles import DEFAULT_MANIFEST_PATH, load_bundle, load_manifest


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


def build_job_manifest(service: str, env: str, verifier: dict[str, Any], expected_version: int) -> dict[str, Any]:
    job_name = f"db-contract-{service.replace('_', '-').replace('/', '-')}-{env}-{int(time.time())}"
    env_from = []
    if verifier.get("configmap"):
        env_from.append({"configMapRef": {"name": verifier["configmap"]}})
    if verifier.get("secret"):
        env_from.append({"secretRef": {"name": verifier["secret"]}})
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
            "template": {
                "spec": {
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
            },
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
    manifest_doc = build_job_manifest(args.service, args.env, verifier, expected_version)
    summary = {
        "service": args.service,
        "env": args.env,
        "namespace": verifier["namespace"],
        "job_name": manifest_doc["metadata"]["name"],
        "expected_schema_version": expected_version,
        "status": "rendered",
    }
    temp_path: Path | None = None
    try:
        if args.apply:
            kubeconfig, temp_path = resolve_kubeconfig(repo_root, args.env, args.kubeconfig_b64_env)
            apply_manifest(kubeconfig, manifest_doc)
            summary["status"] = "applied"
            if args.wait:
                status = wait_for_job(kubeconfig, verifier["namespace"], manifest_doc["metadata"]["name"], args.timeout_seconds)
                summary["status"] = status
                if status != "succeeded":
                    write_summary(args.output_json, summary)
                    print(json.dumps(summary, ensure_ascii=False, indent=2))
                    return 1
        write_summary(args.output_json, summary)
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)
