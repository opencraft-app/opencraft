"""DB-aware release gate execution."""

from __future__ import annotations

import sys
from pathlib import Path

from contracts.release_plan import GatePlan, is_preprod_auto_sync_env, plan_release_gates
from support.process import run_logged


def load_plan(
    *,
    repo_root: Path,
    bundle_manifest: Path,
    service: str,
    env: str,
    source_ref: str,
    image: str,
    pin_targets: str,
    db_status: str,
) -> GatePlan:
    return plan_release_gates(
        repo_root=repo_root,
        bundle_manifest=bundle_manifest,
        service=service,
        env=env,
        source_sha=source_ref,
        image=image,
        pin_targets=pin_targets,
        db_status=db_status,
    )


def run_db_gate(
    *,
    repo_root: Path,
    gitops_worktree: Path,
    runtime_repo_root: Path,
    runtime_command_dir: Path,
    bundle_manifest: Path,
    service: str,
    env: str,
    source_ref: str,
    image: str,
    pin_targets: str,
) -> tuple[str, GatePlan]:
    plan = load_plan(
        repo_root=repo_root,
        bundle_manifest=bundle_manifest,
        service=service,
        env=env,
        source_ref=source_ref,
        image=image,
        pin_targets=pin_targets,
        db_status="unknown",
    )
    emit_plan(plan)

    if is_preprod_auto_sync_env(env):
        emit_preprod_db_gate_view(plan)
        if plan.release_dependency_changed:
            raise RuntimeError("同批依赖服务发生变更；预发布自动发布停止，避免无序自动 sync。")
        if plan.requires_db_readiness:
            run_db_readiness_flow(
                repo_root,
                gitops_worktree,
                runtime_repo_root,
                runtime_command_dir,
                bundle_manifest,
                plan,
                env,
                source_ref,
                apply_migration=True,
            )
            plan = load_plan(
                repo_root=repo_root,
                bundle_manifest=bundle_manifest,
                service=service,
                env=env,
                source_ref=source_ref,
                image=image,
                pin_targets=pin_targets,
                db_status="passed",
            )
        if not plan.auto_merge_allowed:
            raise RuntimeError("预发布自动发布门禁未通过；不创建可自动合并的 GitOps MR。")
        return "passed", plan

    if env in {"shprod", "sgprod"}:
        print(f"{env} 生产策略：GitOps MR 可进入待同步状态；Argo sync 保持人工执行。", file=sys.stderr)
        if plan.requires_db_readiness:
            run_db_readiness_flow(
                repo_root,
                gitops_worktree,
                runtime_repo_root,
                runtime_command_dir,
                bundle_manifest,
                plan,
                env,
                source_ref,
                apply_migration=False,
                shprod=True,
            )
            plan = load_plan(
                repo_root=repo_root,
                bundle_manifest=bundle_manifest,
                service=service,
                env=env,
                source_ref=source_ref,
                image=image,
                pin_targets=pin_targets,
                db_status="passed",
            )
        return "passed", plan

    print("非自动环境：只创建 GitOps MR，不自动 Argo sync。", file=sys.stderr)
    return "not-required", plan


def run_db_readiness_flow(
    repo_root: Path,
    gitops_worktree: Path,
    runtime_repo_root: Path,
    runtime_command_dir: Path,
    bundle_manifest: Path,
    plan: GatePlan,
    env: str,
    source_ref: str,
    *,
    apply_migration: bool,
    shprod: bool = False,
) -> None:
    if not plan.readiness_supported:
        if shprod:
            raise RuntimeError("DB readiness contract 不支持自动校验；停止进入生产待同步状态。")
        raise RuntimeError("DB readiness contract 不支持自动校验；停止自动发布。")
    if apply_migration and plan.requires_db_job:
        args = [
            "python3",
            str(runtime_command_dir / "run_gitops_db_job.py"),
            "--repo-root",
            str(repo_root),
            "--deploy-root",
            str(gitops_worktree),
            "--service",
            plan.db_job_service,
            "--operation",
            plan.db_job_operation,
            "--env",
            env,
            "--revision",
            source_ref,
            "--bundle-service",
            plan.service,
            "--bundle-manifest",
            str(bundle_manifest),
            "--apply",
            "--wait",
        ]
        if plan.db_job_image_override:
            args.extend(["--image-override", plan.db_job_image_override])
        print(f"环境 {env} 执行 DB 变更：受控 DB job {plan.db_job_service}/{plan.db_job_operation}", file=sys.stderr)
        run_with_db_tools(runtime_repo_root, args, cwd=gitops_worktree)

    if shprod:
        print(f"GitOps 待同步门禁：执行 {env} 生产 DB readiness 只读校验", file=sys.stderr)
    else:
        print(f"环境 {env} 执行 DB readiness：服务 {plan.service}", file=sys.stderr)
    run_with_db_tools(
        runtime_repo_root,
        [
            "python3",
            str(runtime_command_dir / "verify_db_contract.py"),
            "--repo-root",
            str(gitops_worktree),
            "--service",
            plan.service,
            "--env",
            env,
            "--bundle-manifest",
            str(bundle_manifest),
            "--apply",
            "--wait",
        ],
        cwd=gitops_worktree,
    )


def run_with_db_tools(runtime_repo_root: Path, command: list[str], *, cwd: Path) -> None:
    run_logged(
        [
            "bash",
            "-c",
            'set -euo pipefail; source "$1/.ci/init.sh"; shift; ci_ensure_db_job_tools; "$@"',
            "bash",
            str(runtime_repo_root),
            *command,
        ],
        cwd=cwd,
    )


def emit_plan(plan: GatePlan) -> None:
    print("============================================================", file=sys.stderr)
    print("GitOps 发布门禁：DB-aware release gate", file=sys.stderr)
    print(f"DB contract：mode={plan.db_mode} migration_changed={str(plan.migration_changed).lower()}", file=sys.stderr)
    print(
        f"DB job：required={str(plan.requires_db_job).lower()} "
        f"service={plan.db_job_service} operation={plan.db_job_operation}",
        file=sys.stderr,
    )
    print(
        f"DB readiness：required={str(plan.requires_db_readiness).lower()} "
        f"supported={str(plan.readiness_supported).lower()} status={plan.db_status}",
        file=sys.stderr,
    )
    print(
        f"依赖变更：{str(plan.release_dependency_changed).lower()} dependencies={plan.release_dependencies}",
        file=sys.stderr,
    )
    print(f"自动合并允许：{str(plan.auto_merge_allowed).lower()}", file=sys.stderr)
    print(f"Argo sync 策略：{plan.argo_sync} auto_sync_allowed={str(plan.auto_sync_allowed).lower()}", file=sys.stderr)
    print("人工动作：", file=sys.stderr)
    for action in plan.manual_actions or ["无"]:
        print(f"- {action}", file=sys.stderr)
    print("============================================================", file=sys.stderr)


def emit_preprod_db_gate_view(plan: GatePlan) -> None:
    print("============================================================", file=sys.stderr)
    print("北京自动发布 DB gate 可视化", file=sys.stderr)
    print(f"环境：{plan.env}", file=sys.stderr)
    print(f"服务：{plan.service}", file=sys.stderr)
    print(f"源 revision：{plan.source_sha}", file=sys.stderr)
    print(f"DB contract：mode={plan.db_mode}", file=sys.stderr)
    print(f"migration 文件变更：{str(plan.migration_changed).lower()}", file=sys.stderr)
    print(
        f"环境 {plan.env} 是否执行 DB 变更：{str(plan.requires_db_job and plan.requires_db_readiness).lower()}",
        file=sys.stderr,
    )
    print(f"受控 DB job：will_run={str(plan.requires_db_job and plan.requires_db_readiness).lower()}", file=sys.stderr)
    if plan.requires_db_job:
        command = (
            "python3 .ci/runtime/commands/run_gitops_db_job.py "
            f"--service {plan.db_job_service} --operation {plan.db_job_operation} "
            f"--env {plan.env} --revision {plan.source_sha} --apply --wait"
        )
        if plan.db_job_image_override:
            command += f" --image-override {plan.db_job_image_override}"
        print(f"受控 DB job 命令：{command}", file=sys.stderr)
    print(f"DB readiness：will_run={str(plan.requires_db_readiness).lower()}", file=sys.stderr)
    if plan.requires_db_readiness:
        print(
            "DB readiness 命令："
            f"python3 .ci/runtime/commands/verify_db_contract.py --service {plan.service} "
            f"--env {plan.env} --apply --wait",
            file=sys.stderr,
        )
    print("执行顺序：image gate -> config projection -> DB job/migration -> DB readiness -> GitOps MR auto-merge/sync", file=sys.stderr)
    print("============================================================", file=sys.stderr)
