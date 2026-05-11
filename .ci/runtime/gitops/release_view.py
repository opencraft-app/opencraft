"""Render Git-native GitOps promotion facts for console and MR comments."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from gitops.release_facts import ReleaseFacts, mr_merge_commit, mr_reference, release_facts_from_mapping, short_revision
from support.logging import SECTION_SEPARATOR


def _code(value: str | None) -> str:
    return f"`{value}`" if value else "`-`"


def _fact_lines(facts: ReleaseFacts) -> list[str]:
    return [
        f"- Release ID：{_code(facts.release_id)}",
        f"- 环境：{_code(facts.env)}",
        f"- Bundle：{_code(facts.bundle)}",
        f"- 目标服务：{_code(facts.pin_targets)}",
        f"- 源 revision：{_code(short_revision(facts.source_revision))}",
        f"- 镜像：{_code(facts.image)}",
        f"- GitOps pin：{_code(facts.image_pin)}",
        f"- Runtime：{_code(facts.runtime_ref)} / {_code(short_revision(facts.runtime_commit))}",
    ]


def _gate_lines(facts: ReleaseFacts) -> list[str]:
    return [f"- {label}：{_code(value)}" for label, value in facts.gate_rows]


def _mr_lines(mr: Mapping[str, Any] | None, source_branch: str | None = None, target_branch: str | None = None) -> list[str]:
    if not mr and not source_branch and not target_branch:
        return ["- MR：`-`"]
    return [
        f"- MR：{mr_reference(mr)}",
        f"- source branch：{_code(str(mr.get('source_branch') or source_branch or '-')) if mr else _code(source_branch)}",
        f"- target branch：{_code(str(mr.get('target_branch') or target_branch or '-')) if mr else _code(target_branch)}",
        f"- merge status：{_code(str(mr.get('merge_status') or '-')) if mr else _code('-')}",
        f"- commit check：{_code(str(mr.get('commit_check_state') or '-')) if mr else _code('-')}",
        f"- merge commit：{_code(mr_merge_commit(mr))}",
    ]


def _target_names(targets: Sequence[Any]) -> str:
    names = []
    for target in targets:
        app_name = getattr(target, "app_name", None)
        names.append(str(app_name or target))
    return ", ".join(f"`{name}`" for name in names) if names else "-"


def _argo_table(results: Sequence[Mapping[str, Any]]) -> list[str]:
    if not results:
        return []
    lines = [
        "| App | Revision | Sync | Health | Expected images | Live images |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for result in results:
        expected = "<br/>".join(result.get("expected_images") or [])
        live = "<br/>".join(result.get("images") or [])
        lines.append(
            "| `{app}` | `{revision}` | `{sync}` | `{health}` | `{expected}` | `{live}` |".format(
                app=result.get("app_name", "-"),
                revision=result.get("revision", "-"),
                sync=result.get("sync_status", "-"),
                health=result.get("health_status", "-"),
                expected=expected or "-",
                live=live or "-",
            )
        )
    return lines


def next_action_for(stage: str, *, error: str | None = None, merge_only: bool = False, noop: bool = False) -> str:
    if error:
        lower = error.lower()
        if "image" in lower or "manifest" in lower:
            return "检查镜像是否已构建并推送到目标 registry；必要时重跑业务构建。"
        if "kustomize" in lower or "placeholder" in lower or "sourcepath" in lower:
            return "修复 GitOps 配置契约、Kustomize 渲染或未替换占位符后重新 promote。"
        if "database" in lower or "migration" in lower or "db job" in lower or "db readiness" in lower:
            return "检查 DB job/readiness 结果，确认 migration 状态后重试。"
        if "merge" in lower:
            return "检查 MR commit check、冲突和合并权限。"
        if "converge" in lower or "argo" in lower or "healthy" in lower:
            return "打开 Argo app 查看 live revision、sync、health 和 workload image 差异。"
        return "查看上方失败层级和 CI 原始日志，修复后重新触发 promote。"
    if merge_only:
        return "生产环境不自动同步；上海生产已进入待同步状态，人工确认 DB readiness 后执行 Argo sync。"
    if noop:
        return "本次 GitOps merge 没有 deploy-facing diff；无需等待 Argo revision。"
    if stage == "merge_waiting":
        return "等待 commit checks 通过并满足 MR auto-merge 条件。"
    if stage == "merged":
        return "等待下一阶段执行 GitOps 合并后验收。"
    if stage == "argo_waiting":
        return "等待 Argo app 达到 Synced / Healthy 且 live image 匹配本次发布。"
    if stage == "argo_success":
        return "发布闭环完成。"
    return "继续等待下一阶段。"


def render_release_view(
    *,
    headline: str,
    facts: ReleaseFacts | Mapping[str, str] | None = None,
    mr: Mapping[str, Any] | None = None,
    source_branch: str | None = None,
    target_branch: str | None = None,
    targets: Sequence[Any] = (),
    argo_results: Sequence[Mapping[str, Any]] = (),
    error: str | None = None,
    next_action: str | None = None,
) -> str:
    release_facts = facts if isinstance(facts, ReleaseFacts) else release_facts_from_mapping(facts)
    lines = [headline, ""]
    lines.extend(_fact_lines(release_facts))
    lines.extend(["", "门禁："])
    lines.extend(_gate_lines(release_facts))
    lines.extend(["", "MR："])
    lines.extend(_mr_lines(mr, source_branch, target_branch))
    if targets:
        lines.extend(["", f"目标 apps：{_target_names(targets)}"])
    if error:
        lines.extend(["", f"错误：`{error}`"])
    if argo_results:
        lines.extend(["", "Argo："])
        lines.extend(_argo_table(argo_results))
    if next_action:
        lines.extend(["", f"下一步：{next_action}"])
    return "\n".join(lines)


def render_console_section(
    *,
    title: str,
    facts: ReleaseFacts | Mapping[str, str] | None = None,
    source_branch: str | None = None,
    stage: str | None = None,
) -> str:
    release_facts = facts if isinstance(facts, ReleaseFacts) else release_facts_from_mapping(facts)
    lines = [SECTION_SEPARATOR, title]
    if source_branch:
        lines.append(f"source_branch={source_branch}")
    if stage:
        lines.append(f"stage={stage}")
    lines.extend(
        [
            f"release_id={release_facts.release_id}",
            f"env={release_facts.env}",
            f"bundle={release_facts.bundle}",
            f"pin_targets={release_facts.pin_targets}",
            f"source_revision={short_revision(release_facts.source_revision)}",
            f"image={release_facts.image}",
            f"image_pin={release_facts.image_pin}",
            f"runtime={release_facts.runtime_ref}/{short_revision(release_facts.runtime_commit)}",
            SECTION_SEPARATOR,
        ]
    )
    return "\n".join(lines)


def render_merge_waiting_note(facts: ReleaseFacts, mr: Mapping[str, Any], source_branch: str, target_branch: str) -> str:
    return render_release_view(
        headline="GitOps 进度：已进入 MR 自动合并阶段。",
        facts=facts,
        mr=mr,
        source_branch=source_branch,
        target_branch=target_branch,
        next_action=next_action_for("merge_waiting"),
    )


def render_merged_note(facts: ReleaseFacts, mr: Mapping[str, Any], source_branch: str, target_branch: str) -> str:
    return render_release_view(
        headline="GitOps 进度：MR 已合并。",
        facts=facts,
        mr=mr,
        source_branch=source_branch,
        target_branch=target_branch,
        next_action=next_action_for("merged", merge_only=facts.get("Release-gate-argo-sync") == "manual"),
    )


def render_argo_waiting_note(facts: ReleaseFacts, mr: Mapping[str, Any], targets: Sequence[Any]) -> str:
    return render_release_view(
        headline="自动验收进度：已开始等待 Argo CD 收敛。",
        facts=facts,
        mr=mr,
        targets=targets,
        next_action=next_action_for("argo_waiting"),
    )


def render_argo_success_note(
    facts: ReleaseFacts,
    mr: Mapping[str, Any],
    results: Sequence[Mapping[str, Any]],
) -> str:
    return render_release_view(
        headline="自动验收通过：Argo CD 已收敛到目标 revision，且 live workload image 匹配本次 GitOps 发布。",
        facts=facts,
        mr=mr,
        argo_results=results,
        next_action=next_action_for("argo_success"),
    )


def render_noop_note(facts: ReleaseFacts, mr: Mapping[str, Any]) -> str:
    return render_release_view(
        headline="自动验收通过：GitOps MR 已合并，但本次 merge commit 没有 deploy-facing diff，跳过 Argo revision 等待。",
        facts=facts,
        mr=mr,
        next_action=next_action_for("argo_success", noop=True),
    )


def render_merge_only_note(facts: ReleaseFacts, mr: Mapping[str, Any], targets: Sequence[Any]) -> str:
    return render_release_view(
        headline="GitOps MR 已合并：上海生产已进入待同步状态。",
        facts=facts,
        mr=mr,
        targets=targets,
        next_action=next_action_for("merged", merge_only=True),
    )


def render_failure_note(
    facts: ReleaseFacts,
    mr: Mapping[str, Any],
    error: str,
    partial_results: Sequence[Mapping[str, Any]],
) -> str:
    return render_release_view(
        headline="自动验收失败：GitOps MR 已合并，但 Argo CD 收敛状态未达到预期。",
        facts=facts,
        mr=mr,
        argo_results=partial_results,
        error=error,
        next_action=next_action_for("argo_failure", error=error),
    )
