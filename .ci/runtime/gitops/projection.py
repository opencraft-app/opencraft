"""
Project the publish-facing subset of a bundle from a source ref onto the current worktree.
"""

from __future__ import annotations

import argparse
import fnmatch
import subprocess
import sys
from pathlib import PurePosixPath

from contracts.bundles import load_bundle, parse_manifest_text


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Project a bundle's publish subset from a source ref")
    parser.add_argument("--repo-root", default=".", help="Repository root")
    parser.add_argument("--service", required=True, help="Bundle id, e.g. user-auth")
    parser.add_argument("--env", required=True, help="Target env, e.g. beijing-sandbox")
    parser.add_argument("--source-ref", required=True, help="Source git ref or sha to project from")
    parser.add_argument("--target-ref", default="HEAD", help="Target ref to diff against; defaults to current HEAD")
    return parser.parse_args()


def git_output(repo_root: str, *args: str) -> str:
    return subprocess.check_output(["git", "-C", repo_root, *args], text=True)


def list_tracked_files(repo_root: str, ref: str) -> list[str]:
    output = git_output(repo_root, "ls-tree", "-r", "--name-only", ref)
    return [line.strip() for line in output.splitlines() if line.strip()]


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


def sync_publish_subset(repo_root: str, source_ref: str, target_ref: str, patterns: list[str]) -> tuple[int, int]:
    source_files = select_matching_files(list_tracked_files(repo_root, source_ref), patterns)
    target_files = select_matching_files(list_tracked_files(repo_root, target_ref), patterns)

    to_delete = sorted(target_files - source_files)
    to_checkout = sorted(source_files)

    for chunk in batched(to_delete):
        subprocess.run(["git", "-C", repo_root, "rm", "-f", "--ignore-unmatch", "--", *chunk], check=True)
    for chunk in batched(to_checkout):
        subprocess.run(["git", "-C", repo_root, "checkout", source_ref, "--", *chunk], check=True)

    return len(to_checkout), len(to_delete)


def load_manifest_text_from_source_ref(repo_root: str, source_ref: str) -> str:
    for path in (".ci/runtime/release-bundles.manifest", ".ci/runtime/release-bundles.yaml"):
        try:
            return git_output(repo_root, "show", f"{source_ref}:{path}")
        except subprocess.CalledProcessError:
            continue
    raise FileNotFoundError(f"release bundle manifest not found in {source_ref}")


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

    projected, deleted = sync_publish_subset(
        repo_root=args.repo_root,
        source_ref=args.source_ref,
        target_ref=args.target_ref,
        patterns=bundle.publish_paths,
    )
    print(f"projected {projected} files, deleted {deleted} stale files")
    return 0
