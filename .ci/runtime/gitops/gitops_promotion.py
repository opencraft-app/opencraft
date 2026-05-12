"""Thin command layer for GitOps promotion CI stages."""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

from gitops.promotion_policy import GateDeniedBehavior, PromotionPolicy, require_policy_for_branch
from gitops.release_facts import release_facts_from_mapping, trailers_from_git
from gitops.release_view import render_console_section
from support.logging import print_section


RUNTIME_DIR = Path(__file__).resolve().parents[1]
COMMAND_DIR = RUNTIME_DIR / "commands"


def _run(command: list[str], *, cwd: Path | None = None) -> None:
    print("+ " + " ".join(command), flush=True)
    subprocess.run(command, cwd=str(cwd) if cwd else None, check=True)


def _git_output(args: list[str], *, cwd: Path) -> str:
    return subprocess.check_output(["git", "-C", str(cwd), *args], text=True).strip()


def _commit_trailers(repo_root: Path, revision: str = "HEAD") -> dict[str, str]:
    message = _git_output(["log", "-1", "--format=%B", revision], cwd=repo_root)
    trailers: dict[str, str] = {}
    for raw_line in message.splitlines():
        if ": " not in raw_line:
            continue
        key, value = raw_line.split(": ", 1)
        if key.startswith("Release-") or key == "Source-revision":
            trailers[key] = value
    return trailers


def _git_success(args: list[str], *, cwd: Path) -> bool:
    return subprocess.run(
        ["git", "-C", str(cwd), *args],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    ).returncode == 0


def _resolve_revision(repo_root: Path, name: str) -> str:
    candidates = [name, f"origin/{name}", f"refs/remotes/origin/{name}"]
    for candidate in candidates:
        if _git_success(["rev-parse", "--verify", candidate], cwd=repo_root):
            return candidate
    return name


def _fetch_branch(repo_root: Path, branch: str) -> None:
    subprocess.run(
        [
            "git",
            "-C",
            str(repo_root),
            "fetch",
            "origin",
            f"+refs/heads/{branch}:refs/remotes/origin/{branch}",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )


def _release_trailers(repo_root: Path, source_branch: str, target_branch: str) -> dict[str, str]:
    """Find release trailers from the promote range, not necessarily HEAD.

    Promote branches may receive follow-up CI-only repair commits. Those commits
    intentionally do not carry release trailers, so policy decisions must use the
    latest commit in target..source that actually describes a release.
    """

    _fetch_branch(repo_root, source_branch)
    _fetch_branch(repo_root, target_branch)
    source_ref = _resolve_revision(repo_root, source_branch)
    target_ref = _resolve_revision(repo_root, target_branch)

    revisions = _git_output(["log", "--format=%H", f"{target_ref}..{source_ref}"], cwd=repo_root).splitlines()
    for revision in revisions:
        trailers = _commit_trailers(repo_root, revision)
        if trailers.get("Release-id") or trailers.get("Release-gate-auto-merge"):
            print(f"release trailers selected from commit {revision[:12]}", flush=True)
            return trailers

    return _commit_trailers(repo_root)


def _changed_files(repo_root: Path, source_branch: str, target_branch: str) -> list[str]:
    _fetch_branch(repo_root, source_branch)
    _fetch_branch(repo_root, target_branch)
    source_ref = _resolve_revision(repo_root, source_branch)
    target_ref = _resolve_revision(repo_root, target_branch)
    output = _git_output(["diff", "--name-only", f"{target_ref}..{source_ref}"], cwd=repo_root)
    return [line for line in output.splitlines() if line]


def _reject_ci_changes(repo_root: Path, source_branch: str, target_branch: str) -> None:
    ci_changes = [path for path in _changed_files(repo_root, source_branch, target_branch) if path == ".ci" or path.startswith(".ci/")]
    if ci_changes:
        formatted = ", ".join(ci_changes[:20])
        suffix = "" if len(ci_changes) <= 20 else f", ... (+{len(ci_changes) - 20} more)"
        raise RuntimeError(
            "GitOps promote branches must not carry .ci changes; "
            f"move CI/runtime updates to master/gitops before promoting. changed={formatted}{suffix}"
        )


def _print_policy(source_branch: str, policy: PromotionPolicy, stage: str) -> None:
    print_section(
        f"GitOps promote 策略：{stage}",
        [
            f"source_branch={source_branch}",
            f"env={policy.env}",
            f"display_name={policy.display_name}",
            f"auto_merge={str(policy.auto_merge).lower()}",
            f"auto_sync={str(policy.auto_sync).lower()}",
            f"cleanup_source_branch={str(policy.cleanup_source_branch).lower()}",
            f"verify_mode={policy.verify_mode.value}",
            f"kustomize_mode={policy.kustomize_mode.value}",
        ],
    )


def _print_release_view(repo_root: Path, source_branch: str, target_branch: str, stage: str) -> None:
    if (
        subprocess.run(
            ["git", "-C", str(repo_root), "rev-parse", "--is-inside-work-tree"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        ).returncode
        != 0
    ):
        return
    try:
        facts = release_facts_from_mapping(_release_trailers(repo_root, source_branch, target_branch))
    except subprocess.CalledProcessError:
        try:
            facts = trailers_from_git(repo_root)
        except subprocess.CalledProcessError:
            return
    print(render_console_section(title="GitOps release view", facts=facts, source_branch=source_branch, stage=stage))


def _base_parser(description: str) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--source-branch", required=True)
    parser.add_argument("--target-branch", default="gitops")
    return parser


def _add_gongfeng_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--api-base")
    parser.add_argument("--project-id")
    parser.add_argument("--private-token")
    parser.add_argument("--private-token-file")
    parser.add_argument("--repo-path")


def _forward_optional_args(args: argparse.Namespace, names: list[str]) -> list[str]:
    forwarded: list[str] = []
    for name in names:
        value = getattr(args, name.replace("-", "_"), None)
        if value is None or value == "":
            continue
        forwarded.extend([f"--{name}", str(value)])
    return forwarded


def _compile_runtime_python() -> None:
    roots = ["contracts", "gitops", "gates", "commands"]
    files = sorted(str(path) for root in roots for path in (RUNTIME_DIR / root).rglob("*.py"))
    if files:
        _run([sys.executable, "-m", "py_compile", *files])


def validate_main(argv: list[str] | None = None) -> int:
    parser = _base_parser("Validate a GitOps promote branch before auto-merge.")
    parser.add_argument("--bundle-manifest", default=str(RUNTIME_DIR / "release-bundles.manifest"))
    args = parser.parse_args(argv)

    repo_root = Path(args.repo_root).resolve()
    policy = require_policy_for_branch(args.source_branch)
    _print_policy(args.source_branch, policy, "前置验收")
    _print_release_view(repo_root, args.source_branch, args.target_branch, "validate")
    _compile_runtime_python()
    _reject_ci_changes(repo_root, args.source_branch, args.target_branch)

    _run(
        [
            sys.executable,
            str(COMMAND_DIR / "validate_gitops_static.py"),
            "--repo-root",
            str(repo_root),
            "--env",
            policy.env,
            "--bundle-manifest",
            args.bundle_manifest,
        ]
    )
    _run(
        [
            sys.executable,
            str(COMMAND_DIR / "validate_gitops_kustomize.py"),
            "--repo-root",
            str(repo_root),
            "--env",
            policy.env,
            *policy.kustomize_args,
        ]
    )
    print("gitops promotion check passed")
    return 0


def merge_main(argv: list[str] | None = None) -> int:
    parser = _base_parser("Merge a GitOps promote MR according to environment policy.")
    _add_gongfeng_args(parser)
    args = parser.parse_args(argv)

    repo_root = Path(args.repo_root).resolve()
    policy = require_policy_for_branch(args.source_branch)
    _print_policy(args.source_branch, policy, "自动合并")
    _print_release_view(repo_root, args.source_branch, args.target_branch, "merge")
    if not policy.auto_merge:
        print(f"skip auto-merge for {args.source_branch}: policy auto_merge=false")
        return 0

    trailers = _release_trailers(repo_root, args.source_branch, args.target_branch)
    gate_auto_merge = trailers.get("Release-gate-auto-merge", "")
    gate_argo_sync = trailers.get("Release-gate-argo-sync", "")

    if gate_auto_merge != "true":
        message = (
            f"release gate does not allow auto-merge for {args.source_branch}: "
            f"Release-gate-auto-merge={gate_auto_merge or 'missing'}"
        )
        if policy.gate_denied_behavior == GateDeniedBehavior.SKIP:
            print(message)
            return 0
        raise RuntimeError(message)

    if policy.required_argo_sync is not None and gate_argo_sync != policy.required_argo_sync:
        raise RuntimeError(
            f"refuse GitOps auto-merge for {args.source_branch}: "
            f"Release-gate-argo-sync={gate_argo_sync or 'missing'} expected={policy.required_argo_sync}"
        )

    command = [
        sys.executable,
        str(COMMAND_DIR / "gitops_merge_request.py"),
        "--source-branch",
        args.source_branch,
        "--target-branch",
        args.target_branch,
        "--title",
        policy.merge_title,
        "--description",
        policy.merge_description,
        "--auto-merge",
        *_forward_optional_args(
            args,
            ["api-base", "project-id", "private-token", "private-token-file", "repo-path"],
        ),
    ]
    if policy.cleanup_source_branch:
        command.append("--remove-source-branch")
    _run(command, cwd=repo_root)
    return 0


def verify_main(argv: list[str] | None = None) -> int:
    parser = _base_parser("Verify a merged GitOps promote MR according to environment policy.")
    _add_gongfeng_args(parser)
    parser.add_argument("--merge-wait-seconds", type=int)
    parser.add_argument("--merge-poll-seconds", type=int)
    parser.add_argument("--wait-seconds", type=int)
    parser.add_argument("--poll-seconds", type=int)
    args = parser.parse_args(argv)

    repo_root = Path(args.repo_root).resolve()
    policy = require_policy_for_branch(args.source_branch)
    _print_policy(args.source_branch, policy, "合并后验收")
    _print_release_view(repo_root, args.source_branch, args.target_branch, "verify")

    command = [
        sys.executable,
        str(COMMAND_DIR / "verify_gitops_release.py"),
        "--repo-root",
        str(repo_root),
        "--source-branch",
        args.source_branch,
        "--target-branch",
        args.target_branch,
        *policy.verify_args,
        *_forward_optional_args(
            args,
            [
                "api-base",
                "project-id",
                "private-token",
                "private-token-file",
                "merge-wait-seconds",
                "merge-poll-seconds",
                "wait-seconds",
                "poll-seconds",
            ],
        ),
    ]
    _run(command, cwd=repo_root)
    return 0


def cleanup_main(argv: list[str] | None = None) -> int:
    parser = _base_parser("Clean up a GitOps promote source branch according to environment policy.")
    _add_gongfeng_args(parser)
    parser.add_argument("--wait-seconds", type=int, default=120)
    parser.add_argument("--poll-seconds", type=int, default=5)
    args = parser.parse_args(argv)

    repo_root = Path(args.repo_root).resolve()
    policy = require_policy_for_branch(args.source_branch)
    _print_policy(args.source_branch, policy, "清理分支")
    _print_release_view(repo_root, args.source_branch, args.target_branch, "cleanup")

    if not policy.cleanup_source_branch:
        print(
            f"skip source branch cleanup for {args.source_branch}; "
            f"{policy.display_name} policy keeps promote branches"
        )
        return 0

    command = [
        sys.executable,
        str(COMMAND_DIR / "gitops_cleanup_source_branch.py"),
        "--source-branch",
        args.source_branch,
        "--target-branch",
        args.target_branch,
        "--wait-seconds",
        str(args.wait_seconds),
        "--poll-seconds",
        str(args.poll_seconds),
        *_forward_optional_args(
            args,
            ["api-base", "project-id", "private-token", "private-token-file"],
        ),
    ]
    _run(command, cwd=repo_root)
    return 0
