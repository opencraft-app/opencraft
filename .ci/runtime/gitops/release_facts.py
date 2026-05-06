"""Git-native facts for a GitOps promotion.

Facts here are derived from Git commit trailers, Gongfeng MR payloads, Git merge
commits, and Argo live snapshots. This module does not persist state.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping


RELEASE_TRAILER_KEYS = (
    "Release-id",
    "Release-created-at",
    "Release-source-branch",
    "Release-runtime-ref",
    "Release-runtime-commit",
    "Release-bundle",
    "Release-target-env",
    "Release-pin-targets",
    "Release-image",
    "Release-image-pin",
    "Release-image-digests",
    "Release-gate-image-status",
    "Release-gate-config-status",
    "Release-gate-db-status",
    "Release-gate-db-readiness-required",
    "Release-gate-auto-merge",
    "Release-gate-auto-sync",
    "Release-gate-argo-sync",
    "Release-gate-dependency-changed",
    "Source-revision",
)


def parse_trailers(message: str) -> dict[str, str]:
    """Parse git-native trailers, preserving unknown Release-* fields."""

    trailers: dict[str, str] = {}
    for raw_line in message.splitlines():
        if ": " not in raw_line:
            continue
        key, value = raw_line.split(": ", 1)
        if key.startswith("Release-") or key == "Source-revision":
            trailers[key] = value
    return trailers


def git_commit_message(repo_root: Path, revision: str = "HEAD") -> str:
    return subprocess.check_output(
        ["git", "-C", str(repo_root), "log", "-1", "--format=%B", revision],
        text=True,
    )


def trailers_from_git(repo_root: Path, revision: str = "HEAD") -> "ReleaseFacts":
    return ReleaseFacts(parse_trailers(git_commit_message(repo_root, revision)))


def short_revision(revision: str | None, length: int = 12) -> str:
    if not revision:
        return "-"
    return revision[:length]


@dataclass(frozen=True)
class ReleaseFacts:
    trailers: Mapping[str, str]

    def get(self, key: str, default: str = "-") -> str:
        value = self.trailers.get(key, "")
        return value if value else default

    @property
    def release_id(self) -> str:
        return self.get("Release-id")

    @property
    def env(self) -> str:
        return self.get("Release-target-env")

    @property
    def bundle(self) -> str:
        return self.get("Release-bundle")

    @property
    def pin_targets(self) -> str:
        return self.get("Release-pin-targets")

    @property
    def source_revision(self) -> str:
        return self.get("Source-revision")

    @property
    def image(self) -> str:
        return self.get("Release-image")

    @property
    def image_pin(self) -> str:
        return self.get("Release-image-pin")

    @property
    def runtime_ref(self) -> str:
        return self.get("Release-runtime-ref")

    @property
    def runtime_commit(self) -> str:
        return self.get("Release-runtime-commit")

    @property
    def is_empty(self) -> bool:
        return not bool(self.trailers)

    @property
    def gate_rows(self) -> list[tuple[str, str]]:
        return [
            ("镜像存在性", self.get("Release-gate-image-status")),
            ("配置契约", self.get("Release-gate-config-status")),
            ("DB readiness", self.get("Release-gate-db-status")),
            ("DB readiness required", self.get("Release-gate-db-readiness-required")),
            ("自动合并允许", self.get("Release-gate-auto-merge")),
            ("自动 sync 允许", self.get("Release-gate-auto-sync")),
            ("Argo sync", self.get("Release-gate-argo-sync")),
            ("依赖变更", self.get("Release-gate-dependency-changed")),
        ]


def release_facts_from_mapping(mapping: Mapping[str, str] | None) -> ReleaseFacts:
    return ReleaseFacts(mapping or {})


def mr_reference(mr: Mapping[str, Any] | None) -> str:
    if not mr:
        return "-"
    iid = mr.get("iid")
    return f"!{iid}" if iid else "-"


def mr_merge_commit(mr: Mapping[str, Any] | None) -> str:
    if not mr:
        return "-"
    return str(mr.get("merge_commit_sha") or "-")
