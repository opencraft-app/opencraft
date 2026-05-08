"""Diagnostic and creation scaffold for playground GitOps environments."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import urllib.error
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

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
DEFAULT_FROM_ENV = "sandbox-bj-3"
DEFAULT_CLUSTER_NAME = "beijing-playground"
DEFAULT_PROJECT = "beijing-playground"
LIGHTCLAW_DOMAIN = "lightclaw.tech"


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


def default_namespace(env: str) -> str:
    return f"lightvela-playground-{env}"


def default_api_host(env: str) -> str:
    return f"api-{env}.{LIGHTCLAW_DOMAIN}"


def default_sandbox_host(env: str) -> str:
    return f"{env}.{LIGHTCLAW_DOMAIN}"


def default_wildcard_host(env: str) -> str:
    return f"*.{default_sandbox_host(env)}"


def tls_secret_name_for_host(host: str) -> str:
    return f"{host.replace('*.', '').replace('.', '-')}-wildcard-tls"


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
        replacements.append((alias, to_plan.api_host))
    return tuple(replacements)


def collect_files_under(root: Path) -> list[Path]:
    return sorted(path for path in root.rglob("*") if path.is_file())


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
        raise FileNotFoundError(f"missing source catalog directory: {catalog_source}")
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


def render_clone_text(text: str, plan: PlaygroundClonePlan) -> str:
    for old, new in plan.replacements:
        text = text.replace(old, new)
    return text


def render_clone_bytes(data: bytes, plan: PlaygroundClonePlan) -> bytes:
    try:
        text = data.decode()
    except UnicodeDecodeError:
        return data
    return render_clone_text(text, plan).encode()


def render_catalog_bytes(data: bytes, plan: PlaygroundClonePlan) -> bytes:
    text = render_clone_bytes(data, plan).decode()
    payload = yaml.safe_load(text) or {}
    if isinstance(payload, dict):
        payload["project"] = plan.project
        payload["destinationName"] = plan.cluster_name
        if "playgroundCluster" in payload:
            payload["playgroundCluster"] = plan.cluster_name
        text = yaml.safe_dump(payload, allow_unicode=True, sort_keys=False)
    return text.encode()


def target_conflicts(plan: PlaygroundClonePlan) -> list[Path]:
    return sorted({item.target for item in plan.files if item.target.exists()})


def validate_clone_plan(plan: PlaygroundClonePlan) -> list[str]:
    errors: list[str] = []
    catalog_targets = [item for item in plan.files if f"/{plan.playground_root.rstrip('/')}/{plan.to_env}/" in item.target.as_posix()]
    service_targets = [item for item in plan.files if f"/argocd/services/" in item.target.as_posix() and f"/{plan.to_env}/" in item.target.as_posix()]
    secret_targets = [item for item in plan.files if f"/argocd/secrets/{plan.to_env}/" in item.target.as_posix()]
    if not catalog_targets:
        errors.append("no catalog files would be generated")
    if not service_targets:
        errors.append("no service sourcePath files would be generated")
    if not secret_targets:
        errors.append("no secret files would be copied")
    return errors


def write_clone_plan(plan: PlaygroundClonePlan, *, force: bool = False) -> list[Path]:
    conflicts = target_conflicts(plan)
    if conflicts and not force:
        conflict_text = "\n".join(str(path.relative_to(plan.repo_root)) for path in conflicts[:50])
        raise FileExistsError(f"target files already exist; pass --force to overwrite:\n{conflict_text}")

    written: list[Path] = []
    for item in plan.files:
        item.target.parent.mkdir(parents=True, exist_ok=True)
        if item.source.name.endswith(".sops.yaml"):
            item.target.write_bytes(item.source.read_bytes())
        elif f"/{plan.playground_root.rstrip('/')}/{plan.from_env}/" in item.source.as_posix():
            item.target.write_bytes(render_catalog_bytes(item.source.read_bytes(), plan))
        else:
            item.target.write_bytes(render_clone_bytes(item.source.read_bytes(), plan))
        shutil.copymode(item.source, item.target, follow_symlinks=False)
        written.append(item.target)
    return written


def print_clone_plan(plan: PlaygroundClonePlan, *, write: bool, force: bool, written: Sequence[Path] = ()) -> None:
    catalog_files = [item.target for item in plan.files if f"/{plan.playground_root.rstrip('/')}/{plan.to_env}/" in item.target.as_posix()]
    service_files = [item.target for item in plan.files if f"/argocd/services/" in item.target.as_posix() and f"/{plan.to_env}/" in item.target.as_posix()]
    secret_files = [item.target for item in plan.files if f"/argocd/secrets/{plan.to_env}/" in item.target.as_posix()]

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
    print("风险提示：将复制源环境的加密 SOPS secret；不会解密也不会修改敏感值。如需强隔离，必须重新生成 SSM/SOPS。")
    print("需要 Agent/人工确认：DNS/证书、SSM/SOPS 是否需要重新生成、是否触发 Argo refresh、是否纳入 drift audit。")
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
        result = subprocess.run(cmd, check=True, capture_output=True, text=True)
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
