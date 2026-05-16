"""
Run a production DB migration plan with an explicit source revision and GitOps deploy root.

The command is intentionally CI-facing: it first renders the one-off migration and
readiness jobs, and only applies them when the caller has passed the manual approval
stage and sets --apply.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from contracts.bundles import load_bundle, load_manifest
from contracts.release_plan import plan_release_gates
from gates import db_contract_verifier
from harness_ci.secrets import build_secret_manifest, secret_env_ref


REPO_ROOT = Path(__file__).resolve().parents[3]
RUNTIME_DIR = REPO_ROOT / ".ci" / "runtime"
RUNTIME_COMMAND_DIR = REPO_ROOT / ".ci" / "runtime" / "commands"
ANSI_RESET = "\033[0m"
ANSI_BOLD_GREEN = "\033[1;32m"
ANSI_BOLD_YELLOW = "\033[1;33m"
ANSI_CYAN = "\033[36m"


def color(text: str, code: str) -> str:
    if os.environ.get("NO_COLOR"):
        return text
    return f"{code}{text}{ANSI_RESET}"


def resolve_python_bin() -> str:
    candidates = [
        os.environ.get("PYTHON_BIN", "").strip(),
        sys.executable,
        shutil.which("python3") or "",
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
        "/usr/bin/python3",
    ]
    seen: set[str] = set()
    for candidate in candidates:
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        result = subprocess.run(
            [candidate, "-c", "import yaml"],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode == 0:
            return candidate
    return sys.executable


PYTHON_BIN = resolve_python_bin()
SUPPORTED_SERVICES = {"payment", "subscription", "ai-gateway", "ctl", "sandbox", "user-auth", "lightclaw-auth"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run production DB migration dry-run/apply flow.")
    parser.add_argument("--service", required=True)
    parser.add_argument("--env", required=True, choices=("shprod", "sgprod"))
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--timeout-seconds", type=int, default=1800)
    parser.add_argument("--skip-if-no-migration-change", action="store_true")
    parser.add_argument("--apply", action="store_true")
    return parser.parse_args()


def run(command: list[str], *, cwd: Path = REPO_ROOT, capture: bool = False) -> str:
    printable = " ".join(shlex.quote(part) for part in command)
    print(f"+ {printable}", flush=True)
    result = subprocess.run(
        command,
        cwd=cwd,
        capture_output=capture,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        stdout = result.stdout if capture else ""
        stderr = result.stderr if capture else ""
        raise RuntimeError(f"command failed: {printable}\nstdout:\n{stdout}\nstderr:\n{stderr}")
    return result.stdout.strip() if capture else ""


def map_service(service: str) -> tuple[str, str]:
    if service in {"payment", "subscription", "ai-gateway", "ctl", "sandbox"}:
        return service, service
    if service in {"user-auth", "lightclaw-auth"}:
        return "user-auth", "lightclaw-auth"
    raise ValueError(
        "SERVICE must be one of: payment, subscription, user-auth, "
        f"lightclaw-auth, ai-gateway, ctl, sandbox; got: {service}"
    )


def resolve_source_sha(source_sha: str) -> str:
    if not source_sha.strip():
        raise ValueError("SOURCE_SHA is required. Use the commit SHA that produced the image you want to migrate.")
    run(["git", "fetch", "--no-tags", "origin", "master", "gitops"])
    return run(["git", "rev-parse", f"{source_sha}^{{commit}}"], capture=True)


def dotenv(command_output: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in command_output.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#") or "=" not in raw:
            continue
        key, value = raw.split("=", 1)
        values[key] = shlex.split(value)[0] if value else ""
    return values


def resolve_release_metadata(bundle_service: str, env: str, tag: str) -> dict[str, str]:
    output = run(
        [
            PYTHON_BIN,
            str(RUNTIME_COMMAND_DIR / "resolve_release_bundle.py"),
            "--service",
            bundle_service,
            "--env",
            env,
            "--tag",
            tag,
            "--format",
            "dotenv",
        ],
        capture=True,
    )
    return dotenv(output)


def resolve_image_override(bundle_service: str, metadata: dict[str, str]) -> str:
    if bundle_service != "sandbox":
        return metadata["BUILD_IMAGE"]
    return json.loads(metadata["BUILD_IMAGES_JSON"])["images"]["SANDBOX_MIGRATE_IMAGE"]


def migration_diff_hint(bundle_service: str, env: str, source_sha: str, image_payload: str) -> dict[str, Any]:
    plan = plan_release_gates(
        repo_root=REPO_ROOT,
        bundle_manifest=RUNTIME_DIR / "release-bundles.manifest",
        service=bundle_service,
        env=env,
        source_sha=source_sha,
        image=image_payload,
        pin_targets=bundle_service,
        db_status="unknown",
    )
    hint = {
        "db_mode": plan.db_mode,
        "requires_db_job": plan.requires_db_job,
        "migration_changed": plan.migration_changed,
    }
    if plan.db_mode != "migration" or not plan.requires_db_job:
        print(f"skip production DB migration: {bundle_service}/{env} has no migration DB job contract", flush=True)
        hint["has_migration_contract"] = False
        return hint
    hint["has_migration_contract"] = True
    if not plan.migration_changed:
        print(
            f"production DB migration diff hint: SOURCE_SHA {source_sha} does not change migration paths for {bundle_service}/{env}; "
            "environment DB version will decide whether migration is required",
            flush=True,
        )
    else:
        print(
            f"production DB migration diff hint: SOURCE_SHA {source_sha} changes migration paths for {bundle_service}/{env}",
            flush=True,
        )
    return hint


def load_db_contract(bundle_service: str, env: str) -> dict[str, Any]:
    manifest = load_manifest(RUNTIME_DIR / "release-bundles.manifest")
    return dict(load_bundle(manifest, bundle_service, env).db_contract)


def pending_migration_files(repo_root: Path, source: str, current: int, expected: int) -> list[dict[str, Any]]:
    source_dir = repo_root / source
    if not source_dir.is_dir() or current >= expected:
        return []
    migrations: list[dict[str, Any]] = []
    for path in sorted(source_dir.glob("*.up.sql")):
        match = re.match(r"^(\d+)_", path.name)
        if not match:
            continue
        version = int(match.group(1))
        if current < version <= expected:
            migrations.append(
                {
                    "version": version,
                    "path": str(path.relative_to(repo_root)),
                    "sql": path.read_text(),
                }
            )
    return migrations


def build_version_probe_script(verifier: dict[str, Any], expected_version: int) -> str:
    database_env = str(verifier["database_env"])
    user_env = str(verifier["user_env"])
    password_env = str(verifier["password_env"])
    return "\n".join(
        [
            "set -eu",
            "value() {",
            '  name="$1"',
            '  eval "printf \'%s\' \\"\\${${name}:-}\\""',
            "}",
            f"db=\"$(value {db_contract_verifier.shell_single_quote(database_env)})\"",
            f"user=\"$(value {db_contract_verifier.shell_single_quote(user_env)})\"",
            f"password=\"$(value {db_contract_verifier.shell_single_quote(password_env)})\"",
            'test -n "${MYSQL_HOST:-}"',
            'test -n "${MYSQL_PORT:-}"',
            'test -n "$db"',
            'test -n "$user"',
            'test -n "$password"',
            'mysql_query() { mysql --host="${MYSQL_HOST}" --port="${MYSQL_PORT}" --user="$user" --password="$password" "$db" -Nse "$1"; }',
            'table_exists="$(mysql_query "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'schema_migrations\'")"',
            'if [ "$table_exists" = "0" ]; then',
            f'  echo "MIGRATION_VERSION current=0 dirty=false table_exists=false expected={expected_version}"',
            "  exit 0",
            "fi",
            'dirty_count="$(mysql_query "SELECT COUNT(*) FROM schema_migrations WHERE dirty = 1")"',
            'version="$(mysql_query "SELECT COALESCE(MAX(version), 0) FROM schema_migrations")"',
            'dirty=false',
            'if [ "$dirty_count" != "0" ]; then dirty=true; fi',
            f'echo "MIGRATION_VERSION current=$version dirty=$dirty table_exists=true expected={expected_version}"',
        ]
    ) + "\n"


def build_version_probe_job(
    *,
    service: str,
    env: str,
    verifier: dict[str, Any],
    expected_version: int,
    env_values: dict[str, str],
    env_secret_refs: dict[str, tuple[str, str]],
    node_selector: dict[str, str],
) -> dict[str, Any]:
    job_name = f"db-version-{service.replace('_', '-').replace('/', '-')}-{env}-{int(time.time())}"
    env_from = []
    if verifier.get("configmap"):
        env_from.append({"configMapRef": {"name": verifier["configmap"]}})
    if verifier.get("secret"):
        env_from.append({"secretRef": {"name": verifier["secret"]}})
    container: dict[str, Any] = {
        "name": "probe",
        "image": verifier.get("image", "mysql:8.0"),
        "imagePullPolicy": "IfNotPresent",
        "envFrom": env_from,
        "command": ["/bin/sh", "-c", build_version_probe_script(verifier, expected_version)],
    }
    env_entries = [{"name": key, "value": value} for key, value in sorted(env_values.items())]
    env_entries.extend(
        [
            {"name": key, "valueFrom": secret_env_ref(secret_name, secret_key)}
            for key, (secret_name, secret_key) in sorted(env_secret_refs.items())
        ]
    )
    if env_entries:
        container["env"] = env_entries
    pod_spec: dict[str, Any] = {
        "restartPolicy": "Never",
        "containers": [container],
    }
    if verifier.get("hostNetwork") or verifier.get("host_network"):
        pod_spec["hostNetwork"] = True
        pod_spec["dnsPolicy"] = str(verifier.get("dnsPolicy") or verifier.get("dns_policy") or "ClusterFirstWithHostNet")
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
                "gitops.clawhub.dev/operation": "db-version-probe",
                "gitops.clawhub.dev/managed-by": "run_prod_db_migration.py",
            },
        },
        "spec": {
            "backoffLimit": 0,
            "ttlSecondsAfterFinished": 300,
            "template": {"spec": pod_spec},
        },
    }


def parse_version_probe_logs(logs: str) -> dict[str, Any]:
    for line in logs.splitlines():
        if not line.startswith("MIGRATION_VERSION "):
            continue
        values: dict[str, Any] = {}
        for item in line.removeprefix("MIGRATION_VERSION ").split():
            key, value = item.split("=", 1)
            if key in {"current", "expected"}:
                values[key] = int(value)
            elif key in {"dirty", "table_exists"}:
                values[key] = value.lower() == "true"
            else:
                values[key] = value
        return values
    raise ValueError(f"migration version probe output missing MIGRATION_VERSION line:\n{logs}")


def probe_db_version(*, source_dir: Path, deploy_root: Path, bundle_service: str, env: str, timeout_seconds: int) -> dict[str, Any]:
    contract = load_db_contract(bundle_service, env)
    verifier = contract.get("verifier") or {}
    if not verifier:
        raise ValueError(f"bundle {bundle_service} does not define db_contract.verifier")
    expected_version = db_contract_verifier.max_migration_version(
        source_dir,
        str(contract.get("expected_migration_source") or ""),
    )
    expected_source = str(contract.get("expected_migration_source") or "")
    env_values, node_selector, env_secret_values = db_contract_verifier.resolve_runtime_env(
        deploy_root,
        env,
        verifier,
        contract,
    )
    secret_name = ""
    env_secret_refs: dict[str, tuple[str, str]] = {}
    secret_manifest: dict[str, Any] | None = None
    if env_secret_values:
        secret_name = f"db-version-{bundle_service.replace('_', '-').replace('/', '-')}-{env}-{int(time.time())}-secrets"
        secret_manifest = build_secret_manifest(
            verifier["namespace"],
            secret_name,
            env_secret_values,
            labels={
                "gitops.clawhub.dev/service": bundle_service,
                "gitops.clawhub.dev/env": env,
                "gitops.clawhub.dev/operation": "db-version-probe",
                "gitops.clawhub.dev/managed-by": "run_prod_db_migration.py",
            },
        )
        env_secret_refs = {key: (secret_name, key) for key in env_secret_values}
    job = build_version_probe_job(
        service=bundle_service,
        env=env,
        verifier=verifier,
        expected_version=expected_version,
        env_values=env_values,
        env_secret_refs=env_secret_refs,
        node_selector=node_selector,
    )
    manifest = {"apiVersion": "v1", "kind": "List", "items": [secret_manifest, job]} if secret_manifest else job
    kubeconfig, temp_path = db_contract_verifier.resolve_kubeconfig(deploy_root, env, "DB_JOB_KUBECONFIG_B64")
    try:
        db_contract_verifier.apply_manifest(kubeconfig, manifest)
        status = db_contract_verifier.wait_for_job(kubeconfig, verifier["namespace"], job["metadata"]["name"], timeout_seconds)
        logs = db_contract_verifier.collect_job_logs(
            kubeconfig,
            verifier["namespace"],
            job["metadata"]["name"],
            env_secret_values,
        )
        if status != "succeeded":
            raise RuntimeError(f"DB version probe failed: status={status}\n{logs}")
        probe = parse_version_probe_logs(logs)
        pending_migrations = pending_migration_files(
            source_dir,
            expected_source,
            int(probe["current"]),
            expected_version,
        )
        probe.update(
            {
                "expected_source": expected_source,
                "pending_migrations": pending_migrations,
                "namespace": verifier["namespace"],
                "job_name": job["metadata"]["name"],
            }
        )
        return probe
    finally:
        db_contract_verifier.delete_manifest(kubeconfig, manifest)
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def decide_migration(version_probe: dict[str, Any]) -> dict[str, Any]:
    current = int(version_probe["current"])
    expected = int(version_probe["expected"])
    dirty = bool(version_probe["dirty"])
    if dirty:
        return {"decision": "block", "reason": f"schema_migrations dirty at version {current}"}
    if current > expected:
        return {"decision": "block", "reason": f"database version {current} is newer than source latest {expected}"}
    if current < expected:
        return {"decision": "run_migration", "reason": f"database version {current} is behind source latest {expected}"}
    return {"decision": "skip_migration", "reason": f"database version {current} already matches source latest {expected}"}


def human_decision_summary(*, apply: bool, version_probe: dict[str, Any], migration_decision: dict[str, Any]) -> str:
    current = int(version_probe["current"])
    expected = int(version_probe["expected"])
    decision = str(migration_decision["decision"])
    if decision == "run_migration":
        action = "将执行 migration" if apply else "审批通过后将执行 migration"
        pending_count = len(version_probe.get("pending_migrations") or [])
        return (
            f"结论：目标库当前版本 {current}，源码 latest {expected}；{action}，"
            f"预计执行 {pending_count} 个 pending SQL，把 schema_migrations 推进到 {expected}。"
        )
    if decision == "skip_migration":
        action = "将跳过 migration" if apply else "审批通过后也会跳过 migration"
        return f"结论：目标库当前版本 {current} 已等于源码 latest {expected}；{action}，只执行 DB readiness。"
    return f"结论：阻断生产 DB migration；{migration_decision['reason']}。"


def add_worktree(path: Path, ref: str) -> None:
    run(["git", "worktree", "add", "--detach", str(path), ref])


def remove_worktree(path: Path) -> None:
    subprocess.run(["git", "worktree", "remove", "--force", str(path)], cwd=REPO_ROOT, check=False)


def project_gitops(bundle_service: str, env: str, source_sha: str, gitops_dir: Path) -> None:
    run(["git", "fetch", "--no-tags", "origin", "gitops:refs/remotes/origin/gitops"])
    add_worktree(gitops_dir, "origin/gitops")
    run(
        [
            PYTHON_BIN,
            str(RUNTIME_COMMAND_DIR / "project_release_bundle.py"),
            "--repo-root",
            str(gitops_dir),
            "--service",
            bundle_service,
            "--env",
            env,
            "--source-ref",
            source_sha,
        ]
    )


def print_plan(
    *,
    db_job_service: str,
    bundle_service: str,
    env: str,
    source_sha: str,
    tag: str,
    image: str,
    apply: bool,
    version_probe: dict[str, Any],
    migration_decision: dict[str, Any],
    diff_hint: dict[str, Any],
) -> None:
    if apply:
        action = "APPLY: 已执行只读 DB 版本探测；将创建并等待一次性 migration Job，然后执行 readiness Job"
    else:
        action = "DRY-RUN: 已执行只读 DB 版本探测；只渲染后续 migration/readiness Job，不执行 migration"
    if migration_decision["decision"] == "skip_migration":
        action = action.replace("migration Job，然后执行 readiness Job", "readiness Job；migration Job 会跳过")
        action = action.replace("只渲染后续 migration/readiness Job", "只渲染后续 readiness Job；migration Job 会跳过")
    print("=" * 60, flush=True)
    print("生产 DB migration 执行计划", flush=True)
    print(human_decision_summary(apply=apply, version_probe=version_probe, migration_decision=migration_decision), flush=True)
    print(f"action={action}", flush=True)
    if not apply:
        print("dry_run_safety=本阶段只执行只读 DB 版本探测；migration/readiness 只渲染 JSON，不会创建 Job，不会修改 DB。", flush=True)
    print(f"service={db_job_service}", flush=True)
    print(f"bundle={bundle_service}", flush=True)
    print(f"env={env}", flush=True)
    print(f"source_sha={source_sha}", flush=True)
    print(f"tag={tag}", flush=True)
    print(f"image={image}", flush=True)
    print(f"diff_migration_changed={str(diff_hint.get('migration_changed')).lower()}", flush=True)
    print(
        "db_version_probe="
        f"current={version_probe['current']} "
        f"latest={version_probe['expected']} "
        f"dirty={str(version_probe['dirty']).lower()} "
        f"table_exists={str(version_probe['table_exists']).lower()} "
        f"namespace={version_probe.get('namespace', '')} "
        f"job={version_probe.get('job_name', '')}",
        flush=True,
    )
    print(f"decision={migration_decision['decision']} reason={migration_decision['reason']}", flush=True)
    pending_migrations = version_probe.get("pending_migrations") or []
    print(f"pending_migration_count={len(pending_migrations)}", flush=True)
    if pending_migrations:
        print(color("pending_migrations:", ANSI_BOLD_GREEN), flush=True)
        for migration in pending_migrations:
            print(color(f"  - version={migration['version']} path={migration['path']}", ANSI_BOLD_YELLOW), flush=True)
        print(color("pending_migration_sql:", ANSI_BOLD_GREEN), flush=True)
        for migration in pending_migrations:
            print(color(f"----- BEGIN {migration['path']} -----", ANSI_BOLD_YELLOW), flush=True)
            sql = str(migration.get("sql") or "").rstrip()
            print(color(sql if sql else "-- empty migration file", ANSI_CYAN), flush=True)
            print(color(f"----- END {migration['path']} -----", ANSI_BOLD_YELLOW), flush=True)
    print("gitops_source=origin/gitops with SOURCE_SHA bundle projection", flush=True)
    print(
        "说明：SOURCE_SHA 提供 migration 源码和镜像 tag；GitOps 投影后的 worktree 提供生产配置和密钥；"
        "是否执行 migration 由目标环境 schema_migrations 与源码 latest version 对比决定。",
        flush=True,
    )
    print("=" * 60, flush=True)


def run_db_jobs(
    *,
    source_dir: Path,
    gitops_dir: Path,
    db_job_service: str,
    bundle_service: str,
    env: str,
    source_sha: str,
    image: str,
    timeout_seconds: int,
    apply: bool,
    run_migration: bool,
) -> None:
    db_job_args = [
        PYTHON_BIN,
        str(RUNTIME_COMMAND_DIR / "run_gitops_db_job.py"),
        "--repo-root",
        str(source_dir),
        "--deploy-root",
        str(gitops_dir),
        "--service",
        db_job_service,
        "--operation",
        "migration",
        "--env",
        env,
        "--revision",
        source_sha,
        "--bundle-service",
        bundle_service,
        "--bundle-manifest",
        str(REPO_ROOT / ".ci" / "runtime" / "release-bundles.manifest"),
        "--timeout-seconds",
        str(timeout_seconds),
        "--kubectl-retries",
        "2",
        "--output-json",
        "db-migration-job.json",
        "--image-override",
        image,
    ]
    verify_args = [
        PYTHON_BIN,
        str(RUNTIME_COMMAND_DIR / "verify_db_contract.py"),
        "--repo-root",
        str(source_dir),
        "--deploy-root",
        str(gitops_dir),
        "--service",
        bundle_service,
        "--env",
        env,
        "--bundle-manifest",
        str(REPO_ROOT / ".ci" / "runtime" / "release-bundles.manifest"),
        "--timeout-seconds",
        str(timeout_seconds),
        "--output-json",
        "db-readiness.json",
    ]
    if apply:
        db_job_args.extend(["--apply", "--wait"])
        verify_args.extend(["--apply", "--wait"])

    if run_migration:
        if not apply:
            print(
                "dry-run render: migration Job 只渲染；下面命令没有 --apply/--wait，不会创建 migration Job，不会修改 DB。",
                flush=True,
            )
        run(db_job_args)
    else:
        print("skip migration Job: target DB schema version already matches source latest version", flush=True)
    if not apply:
        print(
            "dry-run render: DB readiness Job 只渲染；下面命令没有 --apply/--wait，不会创建 readiness Job。",
            flush=True,
        )
    run(verify_args)
    for path in ("db-migration-job.json", "db-readiness.json"):
        if path == "db-migration-job.json" and not run_migration:
            continue
        print(f"{path}:")
        print(Path(path).read_text())


def main() -> int:
    args = parse_args()
    if args.skip_if_no_migration_change and args.service not in SUPPORTED_SERVICES:
        print(f"skip production DB migration: {args.service} has no migration DB job runner", flush=True)
        return 0
    bundle_service, db_job_service = map_service(args.service)
    source_sha = resolve_source_sha(args.source_sha)
    short_sha = source_sha[:12]
    tag = f"{bundle_service}-{short_sha}"
    metadata = resolve_release_metadata(bundle_service, args.env, tag)
    image_payload = metadata["BUILD_IMAGE"]
    image = resolve_image_override(bundle_service, metadata)
    diff_hint = migration_diff_hint(bundle_service, args.env, source_sha, image_payload)
    if not diff_hint.get("has_migration_contract", False):
        return 0

    with tempfile.TemporaryDirectory(prefix="prod-db-source-") as source_tmp, tempfile.TemporaryDirectory(
        prefix="prod-db-gitops-"
    ) as gitops_tmp:
        source_dir = Path(source_tmp)
        gitops_dir = Path(gitops_tmp)
        source_dir.rmdir()
        gitops_dir.rmdir()
        try:
            add_worktree(source_dir, source_sha)
            project_gitops(bundle_service, args.env, source_sha, gitops_dir)
            version_probe = probe_db_version(
                source_dir=source_dir,
                deploy_root=gitops_dir,
                bundle_service=bundle_service,
                env=args.env,
                timeout_seconds=args.timeout_seconds,
            )
            migration_decision = decide_migration(version_probe)
            if migration_decision["decision"] == "block":
                print_plan(
                    db_job_service=db_job_service,
                    bundle_service=bundle_service,
                    env=args.env,
                    source_sha=source_sha,
                    tag=tag,
                    image=image,
                    apply=args.apply,
                    version_probe=version_probe,
                    migration_decision=migration_decision,
                    diff_hint=diff_hint,
                )
                raise RuntimeError(f"production DB migration blocked: {migration_decision['reason']}")
            print_plan(
                db_job_service=db_job_service,
                bundle_service=bundle_service,
                env=args.env,
                source_sha=source_sha,
                tag=tag,
                image=image,
                apply=args.apply,
                version_probe=version_probe,
                migration_decision=migration_decision,
                diff_hint=diff_hint,
            )
            run_db_jobs(
                source_dir=source_dir,
                gitops_dir=gitops_dir,
                db_job_service=db_job_service,
                bundle_service=bundle_service,
                env=args.env,
                source_sha=source_sha,
                image=image,
                timeout_seconds=args.timeout_seconds,
                apply=args.apply,
                run_migration=migration_decision["decision"] == "run_migration",
            )
        finally:
            remove_worktree(source_dir)
            remove_worktree(gitops_dir)

    if args.apply:
        print("production DB migration completed; continue with GitOps promote/sync after review.")
    else:
        print("production DB migration dry-run completed; DB mutation has NOT run. Approve the next CI stage only if the plan is expected.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
