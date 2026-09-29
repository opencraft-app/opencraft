"""
Project the publish-facing subset of a bundle from a source ref onto the current worktree.
"""

from __future__ import annotations

import argparse
import fnmatch
import re
import subprocess
import sys
from pathlib import PurePosixPath

from contracts.bundles import is_playground_env, load_bundle, parse_manifest_text
from contracts.release_bundle_manifest import dump_manifest, merge_bundle_source_documents
from gitops.git import list_files as git_list_files
from gitops.git import output as git_output
from gitops.git import run as git_run
from gitops.git import show_text as git_show_text


PLATFORM_ENV_PATTERN = re.compile(
    r"^.+?-platform(?:-(?P<variant>[A-Za-z0-9]+))?\.env$"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Project a bundle's publish subset from a source ref")
    parser.add_argument("--repo-root", default=".", help="Repository root")
    parser.add_argument("--service", required=True, help="Bundle id, e.g. user-auth")
    parser.add_argument("--env", required=True, help="Target env, e.g. beijing-sandbox")
    parser.add_argument("--source-ref", required=True, help="Source git ref or sha to project from")
    parser.add_argument("--target-ref", default="HEAD", help="Target ref to diff against; defaults to current HEAD")
    parser.add_argument(
        "--image-pin-variant",
        default="all",
        help=(
            "Comma-separated platform env variants selected for projection; "
            "preserve all unselected GitOps variants"
        ),
    )
    return parser.parse_args()


def list_tracked_files(repo_root: str, ref: str) -> list[str]:
    return git_list_files(repo_root, ref)


def match_path(path: str, pattern: str) -> bool:
    return _match_parts(PurePosixPath(path).parts, PurePosixPath(pattern).parts)


def _match_parts(path_parts: tuple[str, ...], pattern_parts: tuple[str, ...]) -> bool:
    if not pattern_parts:
        return not path_parts
    head = pattern_parts[0]
    if head == "**":
        if len(pattern_parts) == 1:
            return True
        return any(_match_parts(path_parts[index:], pattern_parts[1:]) for index in range(len(path_parts) + 1))
    if not path_parts:
        return False
    if fnmatch.fnmatchcase(path_parts[0], head):
        return _match_parts(path_parts[1:], pattern_parts[1:])
    return False


def select_matching_files(files: list[str], patterns: list[str]) -> set[str]:
    return {
        path
        for path in files
        if any(match_path(path, pattern) for pattern in patterns)
    }


def batched(paths: list[str], size: int = 200) -> list[list[str]]:
    return [paths[index:index + size] for index in range(0, len(paths), size)]


def normalize_platform_variants(variant: str) -> set[str] | None:
    normalized = [item.strip().lower() for item in variant.split(",") if item.strip()]
    if not normalized or normalized == ["all"]:
        return None
    if "all" in normalized:
        raise ValueError("platform env variant 'all' cannot be combined with named variants")
    return {
        "" if item in ("primary", "prod", "production") else item
        for item in normalized
    }


def platform_env_variant(path: str) -> str | None:
    match = PLATFORM_ENV_PATTERN.match(PurePosixPath(path).name)
    if not match:
        return None
    return (match.group("variant") or "").lower()


def source_commit_changed_path(repo_root: str, source_ref: str, path: str) -> bool:
    try:
        parent = git_output(repo_root, "rev-parse", f"{source_ref}^1", strip=True)
    except subprocess.CalledProcessError:
        return True
    changed = git_output(
        repo_root,
        "diff",
        "--name-only",
        parent,
        source_ref,
        "--",
        path,
        strip=True,
    )
    return bool(changed)


def unselected_platform_envs_to_preserve(
    repo_root: str,
    source_ref: str,
    target_ref: str,
    patterns: list[str],
    image_pin_variant: str,
) -> set[str]:
    selected_variants = normalize_platform_variants(image_pin_variant)
    if selected_variants is None:
        return set()

    target_files = select_matching_files(list_tracked_files(repo_root, target_ref), patterns)
    return {
        path
        for path in target_files
        if platform_env_variant(path) is not None
        and platform_env_variant(path) not in selected_variants
        and not source_commit_changed_path(repo_root, source_ref, path)
    }


def sync_publish_subset(
    repo_root: str,
    source_ref: str,
    target_ref: str,
    patterns: list[str],
    *,
    preserve_target_only: bool = False,
    preserve_target_paths: list[str] | None = None,
) -> tuple[int, int]:
    source_files = select_matching_files(list_tracked_files(repo_root, source_ref), patterns)
    target_files = select_matching_files(list_tracked_files(repo_root, target_ref), patterns)
    preserve_paths = set(preserve_target_paths or [])
    preserved = target_files & preserve_paths

    to_delete = [] if preserve_target_only else sorted(target_files - source_files - preserved)
    to_checkout = sorted(source_files - preserve_paths)

    for chunk in batched(to_delete):
        git_run(repo_root, "rm", "-f", "--ignore-unmatch", "--", *chunk)
    for chunk in batched(to_checkout):
        git_run(repo_root, "checkout", source_ref, "--", *chunk)

    return len(to_checkout), len(to_delete)


def load_manifest_text_from_source_ref(repo_root: str, source_ref: str) -> str:
    source_dir = ".ci/runtime/bundles"
    bundle_paths = [
        path
        for path in git_list_files(repo_root, source_ref, source_dir)
        if path.startswith(f"{source_dir}/") and path.endswith(".bundle")
    ]
    if not bundle_paths:
        raise FileNotFoundError(f"release bundle sources not found in {source_ref}:{source_dir}")
    documents = [(path, git_show_text(repo_root, source_ref, path)) for path in sorted(bundle_paths)]
    return dump_manifest(merge_bundle_source_documents(documents))


def main() -> int:
    args = parse_args()
    manifest_text = load_manifest_text_from_source_ref(args.repo_root, args.source_ref)
    manifest = parse_manifest_text(manifest_text)
    try:
        bundle = load_bundle(manifest, args.service, args.env)
    except (KeyError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1

    if not bundle.publish_paths:
        print(f"bundle {args.service} does not define publish_paths", file=sys.stderr)
        return 1

    preserve_target_paths = set(bundle.preserve_target_paths)
    preserve_target_paths.update(
        unselected_platform_envs_to_preserve(
            repo_root=args.repo_root,
            source_ref=args.source_ref,
            target_ref=args.target_ref,
            patterns=bundle.publish_paths,
            image_pin_variant=args.image_pin_variant,
        )
    )

    projected, deleted = sync_publish_subset(
        repo_root=args.repo_root,
        source_ref=args.source_ref,
        target_ref=args.target_ref,
        patterns=bundle.publish_paths,
        preserve_target_only=is_playground_env(args.env),
        preserve_target_paths=sorted(preserve_target_paths),
    )
    print(f"projected {projected} files, deleted {deleted} stale files")
    return 0
