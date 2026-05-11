"""GitOps promotion environment policy.

This module is the single place that maps promote branch names to release
behavior. Stream YAML should orchestrate stages only; environment policy belongs
in testable runtime code.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class KustomizeMode(str, Enum):
    FULL = "full"
    CHANGED_ONLY = "changed_only"


class VerifyMode(str, Enum):
    ARGO_CONVERGENCE = "argo_convergence"
    MERGE_ONLY = "merge_only"


class GateDeniedBehavior(str, Enum):
    FAIL = "fail"
    SKIP = "skip"


@dataclass(frozen=True)
class PromotionPolicy:
    env: str
    branch_prefix: str
    display_name: str
    auto_merge: bool
    auto_sync: bool
    cleanup_source_branch: bool
    verify_mode: VerifyMode
    kustomize_mode: KustomizeMode
    gate_denied_behavior: GateDeniedBehavior
    required_argo_sync: str | None = None

    @property
    def merge_title(self) -> str:
        if self.env == "shprod":
            return "自动合并上海生产 GitOps 待同步 MR"
        return "自动合并北京 GitOps 发布 MR"

    @property
    def merge_description(self) -> str:
        if self.env == "shprod":
            return "promote 分支检查通过后自动合并到 gitops；上海生产仅进入待同步状态，不执行 Argo 自动 sync。"
        return "promote 分支检查通过后自动合并到 gitops，并进入 Argo 收敛验收。"

    @property
    def kustomize_args(self) -> list[str]:
        if self.kustomize_mode == KustomizeMode.CHANGED_ONLY:
            return ["--changed-only"]
        return []

    @property
    def verify_args(self) -> list[str]:
        if self.verify_mode == VerifyMode.MERGE_ONLY:
            return ["--merge-only", "--merge-wait-seconds", "3600", "--merge-poll-seconds", "15"]
        return []


PROMOTION_POLICIES: tuple[PromotionPolicy, ...] = (
    PromotionPolicy(
        env="beijing-sandbox-2",
        branch_prefix="promote-beijing-sandbox-2-",
        display_name="北京测试2",
        auto_merge=True,
        auto_sync=True,
        cleanup_source_branch=True,
        verify_mode=VerifyMode.ARGO_CONVERGENCE,
        kustomize_mode=KustomizeMode.FULL,
        gate_denied_behavior=GateDeniedBehavior.FAIL,
    ),
    PromotionPolicy(
        env="beijing-sandbox",
        branch_prefix="promote-beijing-sandbox-",
        display_name="北京测试",
        auto_merge=True,
        auto_sync=True,
        cleanup_source_branch=True,
        verify_mode=VerifyMode.ARGO_CONVERGENCE,
        kustomize_mode=KustomizeMode.FULL,
        gate_denied_behavior=GateDeniedBehavior.FAIL,
    ),
    PromotionPolicy(
        env="shprod",
        branch_prefix="promote-shprod-",
        display_name="上海生产",
        auto_merge=True,
        auto_sync=False,
        cleanup_source_branch=False,
        verify_mode=VerifyMode.MERGE_ONLY,
        kustomize_mode=KustomizeMode.CHANGED_ONLY,
        gate_denied_behavior=GateDeniedBehavior.SKIP,
        required_argo_sync="manual",
    ),
)


def policy_for_branch(source_branch: str) -> PromotionPolicy | None:
    """Return the policy for a promote source branch, if supported."""

    for policy in sorted(PROMOTION_POLICIES, key=lambda item: len(item.branch_prefix), reverse=True):
        if source_branch.startswith(policy.branch_prefix):
            return policy
    return None


def require_policy_for_branch(source_branch: str) -> PromotionPolicy:
    policy = policy_for_branch(source_branch)
    if policy is None:
        supported = ", ".join(policy.branch_prefix + "*" for policy in PROMOTION_POLICIES)
        raise ValueError(f"unsupported promote branch {source_branch!r}; supported patterns: {supported}")
    return policy
