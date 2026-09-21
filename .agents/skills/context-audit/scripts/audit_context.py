#!/usr/bin/env python3
"""Collect repository evidence and score an Agent-authored context assessment."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import subprocess
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any
from urllib.parse import unquote


SCHEMA_VERSION = 3
IGNORED_PARTS = {
    ".git", ".hg", ".svn", ".venv", "__pycache__", "build", "dist",
    "node_modules", "target", "vendor",
}
DOCUMENT_SUFFIXES = {".md", ".mdx", ".rst", ".adoc", ".txt"}
CONFIG_SUFFIXES = {".json", ".jsonl", ".yaml", ".yml", ".toml"}
SOURCE_SUFFIXES = {
    ".c", ".cc", ".cpp", ".cs", ".go", ".java", ".js", ".kt", ".php",
    ".py", ".rb", ".rs", ".swift", ".ts", ".tsx",
}
MANIFEST_NAMES = {
    "Cargo.toml", "Gemfile", "go.mod", "package.json", "pom.xml",
    "pyproject.toml", "requirements.txt",
}
INSTRUCTION_NAMES = {
    "agents.md", "claude.md", "copilot-instructions.md", "instructions.md",
}
OWNER_NAMES = {
    "codeowners", "maintainers", "maintainers.md", "owners", "owners.md",
    "owners.yaml", "owners.yml",
}
PROFILE_CLASSES = {"empty", "underbuilt", "overbuilt", "managed"}
EVIDENCE_KINDS = {
    "file", "git", "validator", "test", "owner_review", "receipt", "trace",
    "model_effect",
}
EXECUTABLE_EVIDENCE = {"validator", "test"}
OBSERVATION_STATUSES = {"pass", "partial", "fail", "unknown"}
NOOP_COMMANDS = {":", "echo", "false", "ls", "printf", "pwd", "true", "whoami"}
COMPONENT_CONTAINERS = {"apps", "components", "modules", "packages", "services"}
TOOL_RELATIVE_ROOTS = {
    (".agents", "skills", "context-audit"),
    (".codex", "skills", "context-audit"),
}


CONTEXT_DIMENSIONS: dict[str, dict[str, Any]] = {
    "entry_routing": {
        "weight": 15, "label": "入口与分层路由",
        "why_evaluate": "Agent 需要从最短入口找到与当前任务匹配的局部知识。",
        "why_this_weight": "入口决定所有任务起点，但不替代路由正确性、权威性和执行证据。",
        "proves": "证明目标仓库存在可发现、按作用域加载的入口。",
        "does_not_prove": "不能单凭入口存在证明正文正确或任务效果提升。",
    },
    "routing_coverage": {
        "weight": 15, "label": "真实任务路由覆盖",
        "why_evaluate": "代表性任务需要命中必要资料并排除禁入内容。",
        "why_this_weight": "漏掉必要资料会直接造成错误，与入口同属发现能力核心。",
        "proves": "证明已核查任务样本的路由结果和隔离行为。",
        "does_not_prove": "不能外推到未采样的所有表达和代码路径。",
    },
    "authority_and_content": {
        "weight": 15, "label": "权威性与知识完整度",
        "why_evaluate": "Context 必须能回到当前源码、配置、Owner 或正式文档。",
        "why_this_weight": "错误或过期事实与漏路由风险同级。",
        "proves": "证明抽样内容具备来源、责任和时效证据。",
        "does_not_prove": "抽样不能证明仓库全部正文永久正确。",
    },
    "rule_enforceability": {
        "weight": 15, "label": "规则可执行性",
        "why_evaluate": "规则需要可执行检查、测试或明确人工门禁才能稳定复用。",
        "why_this_weight": "它决定设计是否真正成为可重复行为。",
        "proves": "证明目标仓库自己的关键规则有执行和失败证据。",
        "does_not_prove": "不能证明未观测的每次 Agent 运行都遵守规则。",
    },
    "token_budget": {
        "weight": 10, "label": "指令链 Token 预算",
        "why_evaluate": "默认注入会与源码、工具结果和推理空间竞争。",
        "why_this_weight": "Token 是重要效率约束，但静态体积不等于 API Token 或准确率。",
        "proves": "证明已识别入口和继承链处于目标仓库声明的预算内。",
        "does_not_prove": "不能证明真实调用成本、缓存命中和总上下文消耗。",
    },
    "task_loop": {
        "weight": 10, "label": "任务状态与反馈闭环",
        "why_evaluate": "长期任务需要可恢复状态、验收证据和失败反馈。",
        "why_this_weight": "它决定持续改进能力，但不替代首轮发现和事实正确性。",
        "proves": "证明抽样任务存在状态、证据和反馈闭环。",
        "does_not_prove": "模板存在不等于团队持续采用。",
    },
    "skill_governance": {
        "weight": 10, "label": "Skill 与工作流治理",
        "why_evaluate": "可复用工作流需要明确触发、边界、资源和验证方式。",
        "why_this_weight": "工作流影响复用效率，但不能替代仓库事实。",
        "proves": "证明目标仓库采用的工作流入口可发现且经过核查。",
        "does_not_prove": "不能证明每个工作流在所有平台都成功。",
    },
    "lifecycle_consumption_isolation": {
        "weight": 10, "label": "生命周期、消费观测与评测隔离",
        "why_evaluate": "知识需要晋级、失效和退出，运行时还要隔离 Gold、答案和评分。",
        "why_this_weight": "这是防污染和长期治理底线，完整运行时证据需要 Receipt 或 Trace。",
        "proves": "证明生命周期、隔离和实际消费在证据覆盖范围内成立。",
        "does_not_prove": "没有 Receipt 或 Trace 时不能证明 Agent 实际消费。",
    },
}

DOCUMENTATION_DIMENSIONS: dict[str, dict[str, Any]] = {
    "inventory_classification": {
        "weight": 20, "label": "文档盘点与分类",
        "why_evaluate": "只有先建立真实文档母集，才能判断覆盖、重复、归档和污染。",
        "why_this_weight": "盘点是全部治理动作的分母。",
        "proves": "证明已识别文档母集并按目标仓库语义分类。",
        "does_not_prove": "不能证明每份文档内容准确或仍被使用。",
    },
    "service_ownership_and_entry": {
        "weight": 25, "label": "服务责任与入口",
        "why_evaluate": "代码边界、Owner 和最短文档入口需要共同演进。",
        "why_this_weight": "服务或组件通常是日常研发的主要责任边界。",
        "proves": "证明动态发现的真实组件具有责任和入口证据。",
        "does_not_prove": "提交次数不能代替 Owner 声明。",
    },
    "engineering_hierarchy": {
        "weight": 20, "label": "跨组件工程知识层级",
        "why_evaluate": "跨组件架构、决策和运行知识需要稳定权威来源。",
        "why_this_weight": "系统级知识影响范围仅次于组件责任。",
        "proves": "证明目标仓库需要的跨组件知识类型有正式入口。",
        "does_not_prove": "不要求采用某套固定目录名或文档框架。",
    },
    "link_integrity": {
        "weight": 15, "label": "链接与来源完整性",
        "why_evaluate": "失效链接和来源锚点会中断人和 Agent 的证据链。",
        "why_this_weight": "它是可执行导航的直接依赖。",
        "proves": "证明扫描范围内的相对链接和来源锚点可解析。",
        "does_not_prove": "链接存在不等于目标内容正确。",
    },
    "derived_context_interfaces": {
        "weight": 10, "label": "Context 派生接口",
        "why_evaluate": "Agent Context 应回到正式知识，而不是形成平行真相。",
        "why_this_weight": "它是正式知识到运行时的接口。",
        "proves": "证明派生内容有来源、范围和消费入口。",
        "does_not_prove": "不能证明所有任务都读取了派生内容。",
    },
    "content_quality_and_freshness": {
        "weight": 10, "label": "内容质量与时效",
        "why_evaluate": "组织正确不能替代正文事实、复查时间和任务可用性。",
        "why_this_weight": "静态结构只能有限验证，必须保留给抽样事实核查。",
        "proves": "证明抽样范围内的事实、时效和任务步骤经过核查。",
        "does_not_prove": "抽样不能证明全仓内容永久正确。",
    },
}


OBSERVATION_SLOTS: dict[str, dict[str, list[dict[str, Any]]]] = {
    "context_control_plane": {
        "entry_routing": [
            {"key": "entry_exists", "label": "最短入口可发现"},
            {"key": "scope_resolution", "label": "作用域与继承优先级明确"},
            {"key": "progressive_disclosure", "label": "按任务渐进加载而非默认全量注入"},
            {"key": "route_check", "label": "代表性入口或路由检查可复现", "strong": True},
        ],
        "routing_coverage": [
            {"key": "task_set_defined", "label": "代表性任务分母已定义"},
            {"key": "required_context_hit", "label": "必要上下文命中已核查"},
            {"key": "forbidden_context_excluded", "label": "禁入内容未进入运行时上下文", "critical": True},
            {"key": "coverage_check", "label": "覆盖与排除检查可复现", "strong": True},
        ],
        "authority_and_content": [
            {"key": "authority_mapped", "label": "事实可回到源码、配置、Owner 或正式知识"},
            {"key": "conflict_resolution", "label": "冲突与优先级有明确处理方式"},
            {"key": "freshness_sampled", "label": "内容准确性与时效经过抽样"},
            {"key": "authority_review", "label": "权威性复核有可追溯证据", "strong": True},
        ],
        "rule_enforceability": [
            {"key": "critical_rules_identified", "label": "关键规则及风险已识别"},
            {"key": "enforcement_mapped", "label": "规则映射到检查、测试或人工门禁"},
            {"key": "failure_behavior", "label": "违规时的失败行为明确"},
            {"key": "rule_check", "label": "至少一项关键规则检查可复现", "strong": True},
        ],
        "token_budget": [
            {"key": "injection_boundary", "label": "默认注入与按需读取边界明确"},
            {"key": "budget_declared", "label": "预算口径、目标和例外明确"},
            {"key": "default_context_measured", "label": "默认指令链体积有当前测量"},
            {"key": "budget_check", "label": "预算检查可复现", "strong": True},
        ],
        "task_loop": [
            {"key": "state_artifact", "label": "长期任务状态可恢复"},
            {"key": "acceptance_evidence", "label": "完成条件绑定实际证据"},
            {"key": "feedback_reentry", "label": "失败与反馈能回到下一轮建设"},
            {"key": "loop_check", "label": "任务闭环或恢复检查可复现", "strong": True},
        ],
        "skill_governance": [
            {"key": "trigger_boundary", "label": "Skill 触发与排除边界明确"},
            {"key": "progressive_resources", "label": "入口与参考资料渐进披露"},
            {"key": "authorization_boundary", "label": "外部写入与高风险动作不被隐式授权"},
            {"key": "skill_check", "label": "Skill 契约或行为检查可复现", "strong": True},
        ],
        "lifecycle_consumption_isolation": [
            {"key": "lifecycle_states", "label": "知识创建、复查、失效和退出明确"},
            {"key": "consumption_observed", "label": "运行时消费边界可观测"},
            {"key": "evaluation_isolation", "label": "Gold、答案和评分与运行时隔离", "critical": True},
            {"key": "isolation_check", "label": "隔离或消费检查可复现", "strong": True},
        ],
    },
    "repository_documentation": {
        "inventory_classification": [
            {"key": "inventory_scope", "label": "文档母集与排除范围明确"},
            {"key": "classification", "label": "文档按职责而非路径外观分类"},
            {"key": "duplicate_archive_policy", "label": "重复、过期和归档有治理方式"},
            {"key": "inventory_check", "label": "盘点或分类检查可复现", "strong": True},
        ],
        "service_ownership_and_entry": [
            {"key": "component_denominator", "label": "真实组件分母已核查"},
            {"key": "owner_authority", "label": "Owner 来自权威声明而非提交次数"},
            {"key": "colocated_entry", "label": "组件代码、责任与最短入口可共同演进"},
            {"key": "coverage_review", "label": "Owner 与入口覆盖复核可追溯", "strong": True},
        ],
        "engineering_hierarchy": [
            {"key": "cross_component_scope", "label": "跨组件知识边界明确"},
            {"key": "decision_runbook_layers", "label": "架构、决策与运行知识职责分层"},
            {"key": "authority_links", "label": "跨层链接回到权威来源"},
            {"key": "hierarchy_review", "label": "层级完整性复核可追溯", "strong": True},
        ],
        "link_integrity": [
            {"key": "link_scope", "label": "链接扫描能力与限制明确"},
            {"key": "relative_targets", "label": "相对文件与图片目标可解析"},
            {"key": "source_anchors", "label": "引用来源和文档锚点可解析"},
            {"key": "link_check", "label": "链接检查可复现", "strong": True},
        ],
        "derived_context_interfaces": [
            {"key": "derivation_source", "label": "派生 Context 标明来源和范围"},
            {"key": "source_backlinks", "label": "派生层能回到正式知识"},
            {"key": "runtime_boundary", "label": "运行时消费与真源边界明确"},
            {"key": "derivation_check", "label": "来源或消费检查可复现", "strong": True},
        ],
        "content_quality_and_freshness": [
            {"key": "task_usefulness", "label": "正文能支持目标任务而非只有目录"},
            {"key": "factual_sampling", "label": "关键事实与步骤经过源码或配置抽样"},
            {"key": "freshness_ownership", "label": "复查时间与维护责任明确"},
            {"key": "content_review", "label": "内容质量复核可追溯", "strong": True},
        ],
    },
}

STRONG_EVIDENCE_BY_DIMENSION = {
    "authority_and_content": {"owner_review", "test", "trace", "validator"},
    "routing_coverage": {"test", "trace", "validator"},
    "task_loop": {"test", "trace", "validator"},
    "lifecycle_consumption_isolation": {"test", "trace", "validator"},
    "service_ownership_and_entry": {"owner_review", "test", "validator"},
    "engineering_hierarchy": {"owner_review", "test", "validator"},
    "derived_context_interfaces": {"test", "trace", "validator"},
    "content_quality_and_freshness": {"owner_review", "test", "validator"},
}


def run_command(repo: Path, arguments: list[str]) -> dict[str, Any]:
    result = subprocess.run(
        arguments, cwd=repo, check=False, capture_output=True, text=True,
    )
    return {
        "command": arguments, "exit_code": result.returncode,
        "stdout": result.stdout.strip(), "stderr": result.stderr.strip(),
    }


def relative(repo: Path, path: Path) -> str:
    return path.relative_to(repo).as_posix()


MAX_FILES = 50000


def is_tooling_path(repo: Path, path: Path) -> bool:
    parts = path.relative_to(repo).parts
    return any(parts[:len(root)] == root for root in TOOL_RELATIVE_ROOTS)


def safe_repository_file(repo: Path, path: Path) -> bool:
    if not path.is_file() or is_tooling_path(repo, path):
        return False
    if any(part in IGNORED_PARTS for part in path.relative_to(repo).parts):
        return False
    try:
        path.resolve().relative_to(repo.resolve())
    except (OSError, ValueError):
        return False
    return True


def repository_files(repo: Path) -> tuple[list[Path], dict[str, Any]]:
    listed = subprocess.run(
        ["git", "ls-files", "-co", "--exclude-standard", "-z"],
        cwd=repo,
        check=False,
        capture_output=True,
    )
    if listed.returncode == 0:
        files: list[Path] = []
        tooling_excluded: list[str] = []
        truncated = False
        for raw in listed.stdout.split(b"\0"):
            if not raw:
                continue
            path = repo / raw.decode("utf-8", errors="replace")
            if path.is_file() and is_tooling_path(repo, path):
                tooling_excluded.append(relative(repo, path))
                continue
            if safe_repository_file(repo, path):
                files.append(path)
            if len(files) >= MAX_FILES:
                truncated = True
                break
        return sorted(set(files)), {
            "source": "git_ls_files", "limit": MAX_FILES,
            "truncated": truncated, "tooling_excluded": tooling_excluded,
        }
    files: list[Path] = []
    tooling_excluded = []
    truncated = False
    for path in repo.rglob("*"):
        if path.is_file() and is_tooling_path(repo, path):
            tooling_excluded.append(relative(repo, path))
            continue
        if safe_repository_file(repo, path):
            files.append(path)
        if len(files) >= MAX_FILES:
            truncated = True
            break
    return sorted(files), {
        "source": "filesystem_walk", "limit": MAX_FILES,
        "truncated": truncated, "tooling_excluded": tooling_excluded,
    }


def is_instruction_candidate(repo: Path, path: Path) -> bool:
    name = path.name.lower()
    rel = relative(repo, path).lower()
    return (
        name in INSTRUCTION_NAMES
        or name == "skill.md"
        or (path.suffix.lower() in {".md", ".mdc"} and "instruction" in name)
        or ("/.cursor/rules/" in f"/{rel}" and path.suffix.lower() in {".md", ".mdc"})
    )


def is_owner_candidate(path: Path) -> bool:
    name = path.name.lower()
    return name in OWNER_NAMES or name.startswith("catalog-info.")


def is_control_candidate(path: Path) -> bool:
    if path.suffix.lower() not in CONFIG_SUFFIXES:
        return False
    stem = path.stem.lower()
    return any(token in stem for token in (
        "authority", "catalog", "context", "lifecycle", "manifest", "route",
        "routing", "source-map",
    ))


def is_evaluation_candidate(repo: Path, path: Path) -> bool:
    tokens = re.split(r"[/_.-]+", relative(repo, path).lower())
    return any(token in {
        "audit", "benchmark", "dataset", "eval", "evaluation", "gold", "score",
    } for token in tokens)


def workspace_member_roots(repo: Path, files: list[Path]) -> set[str]:
    patterns: list[str] = []
    package = repo / "package.json"
    if package in files:
        try:
            payload = json.loads(package.read_text(encoding="utf-8"))
            workspaces = payload.get("workspaces", []) if isinstance(payload, dict) else []
            if isinstance(workspaces, dict):
                workspaces = workspaces.get("packages", [])
            if isinstance(workspaces, list):
                patterns.extend(value for value in workspaces if isinstance(value, str))
        except (OSError, json.JSONDecodeError):
            pass
    pnpm = repo / "pnpm-workspace.yaml"
    if pnpm in files:
        try:
            for line in pnpm.read_text(encoding="utf-8", errors="replace").splitlines():
                match = re.match(r"^\s*-\s*['\"]?([^'\"#]+)['\"]?\s*$", line)
                if match:
                    patterns.append(match.group(1).strip())
        except OSError:
            pass
    roots: set[str] = set()
    for pattern in patterns:
        if pattern.startswith("!") or pattern.startswith("/") or ".." in Path(pattern).parts:
            continue
        try:
            for path in repo.glob(pattern):
                if path.is_dir():
                    roots.add(relative(repo, path))
        except (OSError, ValueError):
            continue
    go_work = repo / "go.work"
    if go_work in files:
        try:
            text = go_work.read_text(encoding="utf-8", errors="replace")
            for match in re.finditer(r"(?m)^\s*(?:use\s+)?(\./[^\s()]+)\s*$", text):
                candidate = (repo / match.group(1)).resolve()
                if candidate.is_dir():
                    roots.add(relative(repo, candidate))
        except OSError:
            pass
    return roots


def discover_services(repo: Path, files: list[Path]) -> list[dict[str, Any]]:
    candidates: dict[str, dict[str, Any]] = {}

    def add_candidate(root: str, method: str, confidence: str) -> None:
        item = candidates.setdefault(root, {"methods": set(), "confidence": confidence})
        item["methods"].add(method)
        if confidence == "high":
            item["confidence"] = "high"

    for root in workspace_member_roots(repo, files):
        add_candidate(root, "workspace_member", "high")

    for path in files:
        rel_path = path.relative_to(repo)
        parts = rel_path.parts
        if path.name in MANIFEST_NAMES:
            root = rel_path.parent.as_posix() or "."
            add_candidate(root, "manifest_root", "high")
        if len(parts) >= 3 and parts[0].lower() in COMPONENT_CONTAINERS:
            add_candidate("/".join(parts[:2]), "conventional_container_child", "medium")

    # Root-level source and manifest files belong to one repository component.
    if any(
        len(path.relative_to(repo).parts) == 1
        and (path.suffix.lower() in SOURCE_SUFFIXES or path.name in MANIFEST_NAMES)
        for path in files
    ):
        add_candidate(".", "repository_root", "high")

    assignments: dict[str, list[Path]] = defaultdict(list)
    sorted_roots = sorted(
        candidates, key=lambda value: len(Path(value).parts), reverse=True,
    )
    for path in files:
        rel_value = relative(repo, path)
        if path.suffix.lower() not in SOURCE_SUFFIXES and path.name not in MANIFEST_NAMES:
            continue
        matched = None
        for root in sorted_roots:
            if root == "." and "/" not in rel_value:
                matched = root
                break
            if root != "." and (rel_value == root or rel_value.startswith(root + "/")):
                matched = root
                break
        if matched is None:
            parts = path.relative_to(repo).parts
            if len(parts) == 1:
                matched = "."
                add_candidate(matched, "repository_root", "medium")
            elif not parts[0].startswith(".") and parts[0].lower() not in {
                "doc", "docs", "script", "scripts", "test", "tests", "tool", "tools",
            }:
                matched = parts[0]
                add_candidate(matched, "top_level_source", "low")
        if matched is not None:
            assignments[matched].append(path)

    services: list[dict[str, Any]] = []
    for root in sorted(assignments):
        root_files = assignments[root]
        manifests = [relative(repo, path) for path in root_files if path.name in MANIFEST_NAMES]
        source_count = sum(path.suffix.lower() in SOURCE_SUFFIXES for path in root_files)
        if not manifests and source_count == 0:
            continue
        prefix = "" if root == "." else root + "/"
        document_count = sum(
            path.suffix.lower() in DOCUMENT_SUFFIXES
            and (root == "." or relative(repo, path).startswith(prefix))
            for path in files
        )
        metadata = candidates.get(root, {"methods": {"fallback"}, "confidence": "low"})
        services.append({
            "path": root, "manifests": manifests, "source_files": source_count,
            "document_files": document_count,
            "discovery_method": sorted(metadata["methods"]),
            "confidence": metadata["confidence"],
        })
    return services


def markdown_targets(text: str) -> list[tuple[str, str]]:
    targets: list[tuple[str, str]] = []
    index = 0
    while index < len(text):
        close = text.find("](", index)
        if close < 0:
            break
        cursor = close + 2
        depth = 1
        escaped = False
        while cursor < len(text):
            char = text[cursor]
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
                if depth == 0:
                    targets.append(("inline", text[close + 2:cursor]))
                    break
            cursor += 1
        index = max(cursor + 1, close + 2)
    for match in re.finditer(r"(?m)^\s*\[[^\]]+\]:\s*(<[^>]+>|\S+)", text):
        targets.append(("reference_definition", match.group(1)))
    return targets


def markdown_anchors(path: Path) -> set[str]:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return set()
    anchors: set[str] = set()
    counts: Counter[str] = Counter()
    for line in text.splitlines():
        match = re.match(r"^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$", line)
        if not match:
            continue
        slug = match.group(1).strip().lower()
        slug = re.sub(r"[^\w\-\s\u4e00-\u9fff]", "", slug)
        slug = re.sub(r"\s+", "-", slug)
        suffix = counts[slug]
        counts[slug] += 1
        anchors.add(slug if suffix == 0 else f"{slug}-{suffix}")
    return anchors


def scan_links(repo: Path, documents: list[Path]) -> dict[str, Any]:
    broken: list[dict[str, str]] = []
    checked = 0
    for path in documents:
        if path.suffix.lower() not in {".md", ".mdx"}:
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for link_kind, raw in markdown_targets(text):
            target = raw.strip()
            if target.startswith("<") and target.endswith(">"):
                target = target[1:-1]
            if " " in target and not target.startswith("<"):
                target = target.split(" ", 1)[0]
            target_without_query = target.split("?", 1)[0]
            file_target, separator, fragment = target_without_query.partition("#")
            if target.startswith((
                "/", "data:", "file:", "http:", "https:", "mailto:", "tel:",
            )):
                continue
            checked += 1
            resolved = (path if not file_target else path.parent / unquote(file_target)).resolve()
            try:
                resolved.relative_to(repo.resolve())
            except ValueError:
                broken.append({
                    "source": relative(repo, path), "target": target,
                    "reason": "escapes_repository",
                })
                continue
            if not resolved.exists():
                broken.append({
                    "source": relative(repo, path), "target": target, "reason": "missing",
                })
                continue
            if fragment and resolved.suffix.lower() in {".md", ".mdx"}:
                if unquote(fragment).lower() not in markdown_anchors(resolved):
                    broken.append({
                        "source": relative(repo, path), "target": target,
                        "reason": "missing_anchor",
                    })
    return {
        "checked": checked, "broken": broken[:500], "broken_count": len(broken),
        "broken_truncated": len(broken) > 500,
        "scope": "inline_links_images_reference_definitions_and_markdown_heading_anchors",
        "limitations": [
            "不解析原始 HTML、动态生成链接或外部 URL 可达性。",
            "Heading anchor 按常见 GitHub 风格近似，平台自定义 slug 需专用 Validator。",
        ],
    }


def duplicate_documents(repo: Path, documents: list[Path]) -> list[list[str]]:
    groups: dict[str, list[str]] = defaultdict(list)
    for path in documents:
        try:
            payload = path.read_bytes()
        except OSError:
            continue
        if len(payload) >= 200:
            groups[hashlib.sha256(payload).hexdigest()].append(relative(repo, path))
    return [paths for paths in groups.values() if len(paths) > 1][:100]


def hash_path(repo: Path, path: Path) -> dict[str, str]:
    rel_value = relative(repo, path)
    if path.is_symlink():
        return {"path": rel_value, "sha256": hashlib.sha256(
            ("symlink:" + str(path.readlink())).encode("utf-8")
        ).hexdigest()}
    if not path.exists():
        return {"path": rel_value, "sha256": "deleted"}
    if not path.is_file():
        return {"path": rel_value, "sha256": "not-a-file"}
    return {"path": rel_value, "sha256": file_sha256(path)}


def git_dirty_paths(repo: Path) -> tuple[list[Path], bytes, bool]:
    result = subprocess.run(
        ["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
        cwd=repo, check=False, capture_output=True,
    )
    if result.returncode != 0:
        return [], b"", False
    chunks = [chunk for chunk in result.stdout.split(b"\0") if chunk]
    paths: list[Path] = []
    index = 0
    while index < len(chunks):
        entry = chunks[index]
        if len(entry) >= 4:
            raw_path = entry[3:]
            decoded = raw_path.decode("utf-8", errors="replace")
            paths.append(repo / decoded)
            status = entry[:2]
            if b"R" in status or b"C" in status:
                index += 1
                if index < len(chunks):
                    old = chunks[index].decode("utf-8", errors="replace")
                    paths.append(repo / old)
        index += 1
    return paths, result.stdout, True


def repository_snapshot(
    repo: Path, files: list[Path] | None = None,
) -> dict[str, Any]:
    head = repository_head(repo)
    entries: list[dict[str, str]] = []
    complete = True
    scope = "git_dirty_worktree"
    dirty_paths, status_bytes, is_git = git_dirty_paths(repo)
    if is_git:
        seen: set[str] = set()
        for path in dirty_paths:
            try:
                rel_value = relative(repo, path)
            except ValueError:
                continue
            if rel_value in seen or is_tooling_path(repo, path):
                continue
            seen.add(rel_value)
            entries.append(hash_path(repo, path))
        status_sha = hashlib.sha256(status_bytes).hexdigest()
    else:
        scope = "non_git_repository_files"
        status_sha = None
        if files is None:
            files, scan = repository_files(repo)
            complete = not scan["truncated"]
        for path in files or []:
            entries.append(hash_path(repo, path))
    payload = {
        "algorithm": "sha256-path-content-v1", "scope": scope,
        "head": head, "status_sha256": status_sha,
        "entries": sorted(entries, key=lambda item: item["path"]),
        "complete": complete,
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return {
        "algorithm": payload["algorithm"], "scope": scope,
        "head": head, "fingerprint": hashlib.sha256(encoded).hexdigest(),
        "complete": complete, "dirty_or_input_files": payload["entries"],
    }


def git_evidence(repo: Path, sample_paths: list[str]) -> dict[str, Any]:
    commands: list[dict[str, Any]] = []
    inside = run_command(repo, ["git", "rev-parse", "--is-inside-work-tree"])
    commands.append(inside)
    if inside["exit_code"] != 0 or inside["stdout"] != "true":
        return {
            "availability": "non-git", "head": None, "branch": None,
            "dirty_paths": [], "history_samples": [], "executed_commands": commands,
        }
    head = run_command(repo, ["git", "rev-parse", "HEAD"])
    branch = run_command(repo, ["git", "branch", "--show-current"])
    shallow = run_command(repo, ["git", "rev-parse", "--is-shallow-repository"])
    status = run_command(repo, ["git", "status", "--short", "--untracked-files=all"])
    commands.extend((head, branch, shallow, status))
    history_samples: list[dict[str, Any]] = []
    for path in sample_paths[:25]:
        history = run_command(
            repo, ["git", "log", "-1", "--format=%H%x09%aI%x09%s", "--", path],
        )
        commands.append(history)
        if history["exit_code"] == 0 and history["stdout"]:
            parts = history["stdout"].split("\t", 2)
            if len(parts) == 3:
                history_samples.append({
                    "path": path, "commit": parts[0], "authored_at": parts[1],
                    "subject": parts[2],
                })
    return {
        "availability": "shallow" if shallow["stdout"] == "true" else "full",
        "head": head["stdout"] or None, "branch": branch["stdout"] or None,
        "dirty_paths": [line for line in status["stdout"].splitlines() if line.strip()],
        "history_samples": history_samples, "executed_commands": commands,
    }


def discover(repo: Path) -> dict[str, Any]:
    repo = repo.resolve()
    files, scan = repository_files(repo)
    documents = [path for path in files if path.suffix.lower() in DOCUMENT_SUFFIXES]
    instructions = [path for path in files if is_instruction_candidate(repo, path)]
    skills = [path for path in files if path.name.lower() == "skill.md"]
    owners = [path for path in files if is_owner_candidate(path)]
    controls = [path for path in files if is_control_candidate(path)]
    evaluations = [path for path in files if is_evaluation_candidate(repo, path)]
    validators = [
        path for path in files
        if path.suffix.lower() in {".py", ".js", ".ts", ".sh"}
        and any(token in path.stem.lower() for token in (
            "audit", "check", "lint", "test", "validate",
        ))
    ]
    doc_roots: Counter[str] = Counter()
    for path in documents:
        parts = path.relative_to(repo).parts
        doc_roots[parts[0] if len(parts) == 1 else "/".join(parts[:2])] += 1
    sample_paths = [relative(repo, path) for path in instructions + owners + controls + validators]
    snapshot = repository_snapshot(repo, files)
    return {
        "schema_version": SCHEMA_VERSION,
        "repository": {
            "path": str(repo), "files_scanned": len(files),
            "scan": scan, "scan_limit": scan["limit"],
            "scan_truncated": scan["truncated"],
            "excluded_tool_roots": [
                "/".join(root) for root in TOOL_RELATIVE_ROOTS
                if any(path.startswith("/".join(root) + "/") or path == "/".join(root)
                       for path in scan["tooling_excluded"])
            ],
            "worktree_snapshot": snapshot,
        },
        "inventory": {
            "documents": [relative(repo, path) for path in documents],
            "document_roots": [
                {"path": root, "count": count} for root, count in doc_roots.most_common()
            ],
            "instructions": [relative(repo, path) for path in instructions],
            "skills": [relative(repo, path) for path in skills],
            "owner_sources": [relative(repo, path) for path in owners],
            "control_candidates": [relative(repo, path) for path in controls],
            "evaluation_candidates": [relative(repo, path) for path in evaluations],
            "validator_candidates": [relative(repo, path) for path in validators],
            "services": discover_services(repo, files),
            "manifests": [relative(repo, path) for path in files if path.name in MANIFEST_NAMES],
            "duplicate_document_groups": duplicate_documents(repo, documents),
        },
        "links": scan_links(repo, documents),
        "git": git_evidence(repo, list(dict.fromkeys(sample_paths))),
        "tooling_excluded": scan["tooling_excluded"],
        "boundary": (
            "发现结果只说明候选文件和可复现事实；目录名、文件数和候选命中"
            "不会自动换算为成熟度分数。"
        ),
    }


def observation_id(scope: str, dimension: str, slot: str) -> str:
    prefix = "context" if scope == "context_control_plane" else "documentation"
    return f"{prefix}.{dimension}.{slot}"


def empty_dimension_assessment(scope: str) -> dict[str, Any]:
    return {
        dimension: {
            "rationale": "",
            "observations": {
                observation_id(scope, dimension, slot["key"]): {
                    "status": "unknown", "rationale": "", "subject": "",
                    "evidence": [], "limitations": [],
                }
                for slot in slots
            },
            "findings": [],
        }
        for dimension, slots in OBSERVATION_SLOTS[scope].items()
    }


def assessment_template(discovery: dict[str, Any]) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "repository": {
            "head": discovery["git"].get("head"), "assessment_scope": "",
            "worktree_fingerprint": discovery["repository"]["worktree_snapshot"]["fingerprint"],
        },
        "repository_profile": {"class": None, "rationale": "", "tags": []},
        "dimensions": {
            "context_control_plane": empty_dimension_assessment("context_control_plane"),
            "repository_documentation": empty_dimension_assessment("repository_documentation"),
        },
        "cross_cutting_findings": [], "actions": [],
    }


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"cannot read assessment JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError("assessment must be a JSON object")
    return value


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def repository_head(repo: Path) -> str | None:
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, check=False,
        capture_output=True, text=True,
    )
    return result.stdout.strip() or None if result.returncode == 0 else None


def expand_input_path(repo: Path, raw: str) -> list[Path]:
    candidate = Path(raw.split("::", 1)[0]).expanduser()
    candidate = candidate if candidate.is_absolute() else repo / candidate
    try:
        candidate.resolve().relative_to(repo.resolve())
    except (OSError, ValueError):
        return []
    if candidate.is_file():
        return [candidate]
    if candidate.is_dir():
        return [path for path in candidate.rglob("*") if safe_repository_file(repo, path)]
    return []


def command_input_files(repo: Path, command: list[str], explicit: list[Path]) -> list[Path]:
    inputs: list[Path] = []
    for path in explicit:
        inputs.extend(expand_input_path(repo, str(path)))
    for token in command[1:]:
        if token.startswith("-"):
            continue
        inputs.extend(expand_input_path(repo, token))
    return sorted(set(inputs))


def record_check(
    repo: Path, output: Path, claim_id: str, command: list[str],
    explicit_inputs: list[Path], expected_output: str | None,
) -> int:
    if not command:
        raise ValueError("--record-check requires a command after --")
    if not claim_id or not re.fullmatch(r"[a-z0-9_.-]+", claim_id):
        raise ValueError("--record-check requires --claim <observation-id>")
    inputs = command_input_files(repo, command, explicit_inputs)
    input_manifest = [hash_path(repo, path) for path in inputs]
    command_name = Path(command[0]).name.lower()
    if expected_output is not None and len(expected_output) > 256:
        raise ValueError("--expect must be at most 256 characters")
    snapshot_files, _ = repository_files(repo)
    snapshot = repository_snapshot(repo, snapshot_files)
    started_at = dt.datetime.now(dt.timezone.utc).isoformat()
    started = time.monotonic()
    result = subprocess.run(command, cwd=repo, check=False, capture_output=True)
    duration_ms = round((time.monotonic() - started) * 1000)
    combined_output = result.stdout.decode("utf-8", errors="replace") + "\n" + result.stderr.decode(
        "utf-8", errors="replace",
    )
    assertion_matched = bool(expected_output) and expected_output in combined_output
    meaningful = (
        command_name not in NOOP_COMMANDS
        and bool(input_manifest)
        and assertion_matched
    )
    receipt = {
        "schema_version": SCHEMA_VERSION,
        "type": "context-audit-check-receipt",
        "claim_id": claim_id,
        "repository": {
            "path": str(repo.resolve()), "head": repository_head(repo),
            "worktree_fingerprint": snapshot["fingerprint"],
            "snapshot_complete": snapshot["complete"],
        },
        "producer": {
            "tool": "context-audit", "script_sha256": file_sha256(Path(__file__).resolve()),
        },
        "command": command,
        "meaningful_check": meaningful,
        "output_assertion": {
            "kind": "substring", "expected": expected_output,
            "matched": assertion_matched,
        },
        "input_files": input_manifest,
        "exit_code": result.returncode,
        "started_at": started_at,
        "duration_ms": duration_ms,
        "stdout_sha256": hashlib.sha256(result.stdout).hexdigest(),
        "stderr_sha256": hashlib.sha256(result.stderr).hexdigest(),
        "stdout_bytes": len(result.stdout),
        "stderr_bytes": len(result.stderr),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if result.stdout:
        sys.stdout.buffer.write(result.stdout)
    if result.stderr:
        sys.stderr.buffer.write(result.stderr)
    print(f"context-audit receipt: {output.resolve()}", file=sys.stderr)
    if result.returncode != 0:
        return result.returncode
    return 0 if meaningful else 3


def validate_check_receipt(
    repo: Path, item: dict[str, Any], location: str, claim_id: str,
) -> list[str]:
    receipt_value = item.get("receipt")
    expected_hash = item.get("receipt_sha256")
    if not isinstance(receipt_value, str) or not receipt_value:
        return [f"{location}.receipt is required for validator/test evidence"]
    if not isinstance(expected_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_hash):
        return [f"{location}.receipt_sha256 must be a lowercase SHA-256"]
    receipt_path = Path(receipt_value).expanduser()
    if not receipt_path.is_absolute():
        return [f"{location}.receipt must be an absolute local path"]
    if not receipt_path.is_file():
        return [f"{location}.receipt does not exist"]
    if file_sha256(receipt_path) != expected_hash:
        return [f"{location}.receipt_sha256 does not match receipt"]
    try:
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return [f"{location}.receipt is not valid JSON"]
    if not isinstance(receipt, dict):
        return [f"{location}.receipt must contain a JSON object"]
    errors: list[str] = []
    if receipt.get("schema_version") != SCHEMA_VERSION:
        errors.append(f"{location}.receipt schema_version must be {SCHEMA_VERSION}")
    if receipt.get("type") != "context-audit-check-receipt":
        errors.append(f"{location}.receipt has an invalid type")
    if receipt.get("claim_id") != claim_id:
        errors.append(f"{location}.receipt claim does not match observation {claim_id}")
    repository = receipt.get("repository")
    if not isinstance(repository, dict):
        return errors + [f"{location}.receipt repository must be an object"]
    if repository.get("path") != str(repo.resolve()):
        errors.append(f"{location}.receipt repository path does not match")
    current_head = repository_head(repo)
    if repository.get("head") and current_head and repository.get("head") != current_head:
        errors.append(f"{location}.receipt repository HEAD is stale")
    current_files, current_scan = repository_files(repo)
    current_snapshot = repository_snapshot(repo, current_files)
    if not repository.get("snapshot_complete") or current_scan["truncated"]:
        errors.append(f"{location}.receipt repository snapshot is incomplete")
    if repository.get("worktree_fingerprint") != current_snapshot["fingerprint"]:
        errors.append(f"{location}.receipt dirty worktree snapshot is stale")
    producer = receipt.get("producer")
    if not isinstance(producer, dict):
        errors.append(f"{location}.receipt producer must be an object")
    elif producer.get("script_sha256") != file_sha256(Path(__file__).resolve()):
        errors.append(f"{location}.receipt producer script is stale")
    command = item.get("command")
    if not isinstance(command, list) or not command or not all(
        isinstance(part, str) for part in command
    ):
        errors.append(f"{location}.command must be a non-empty string array")
    elif receipt.get("command") != command:
        errors.append(f"{location}.command does not match receipt")
    if receipt.get("meaningful_check") is not True:
        errors.append(
            f"{location}.receipt command is generic/no-input, "
            "or lacks a matched output assertion"
        )
    assertion = receipt.get("output_assertion")
    if not isinstance(assertion, dict) or assertion.get("kind") != "substring":
        errors.append(f"{location}.receipt output_assertion is invalid")
    elif (
        not isinstance(assertion.get("expected"), str)
        or not assertion.get("expected")
        or assertion.get("matched") is not True
    ):
        errors.append(f"{location}.receipt output assertion did not match")
    if receipt.get("exit_code") != 0:
        errors.append(f"{location}.receipt records a failing command")
    input_files = receipt.get("input_files")
    if not isinstance(input_files, list) or not input_files:
        errors.append(f"{location}.receipt must bind at least one repository input file")
    else:
        input_paths: set[str] = set()
        for index, value in enumerate(input_files):
            if not isinstance(value, dict):
                errors.append(f"{location}.receipt.input_files[{index}] must be an object")
                continue
            path_value = value.get("path")
            sha_value = value.get("sha256")
            if not isinstance(path_value, str) or not isinstance(sha_value, str):
                errors.append(f"{location}.receipt.input_files[{index}] is malformed")
                continue
            input_paths.add(path_value)
            resolved = (repo / path_value).resolve()
            if not resolved.is_file() or file_sha256(resolved) != sha_value:
                errors.append(f"{location}.receipt input file is stale: {path_value}")
        evidence_path = item.get("path")
        if isinstance(evidence_path, str) and evidence_path not in input_paths:
            errors.append(f"{location}.path is not bound as a receipt input")
    for field in ("stdout_sha256", "stderr_sha256"):
        if not isinstance(receipt.get(field), str) or not re.fullmatch(
            r"[0-9a-f]{64}", receipt.get(field, "")
        ):
            errors.append(f"{location}.receipt is missing {field}")
    return errors


def validate_local_artifact(
    repo: Path, item: dict[str, Any], location: str, claim_id: str,
) -> list[str]:
    artifact_value = item.get("artifact")
    expected_hash = item.get("artifact_sha256")
    if not isinstance(artifact_value, str) or not artifact_value:
        return [f"{location}.artifact is required"]
    if not isinstance(expected_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_hash):
        return [f"{location}.artifact_sha256 must be a lowercase SHA-256"]
    artifact = Path(artifact_value).expanduser()
    if not artifact.is_absolute() or not artifact.is_file():
        return [f"{location}.artifact must be an existing absolute local path"]
    if file_sha256(artifact) != expected_hash:
        return [f"{location}.artifact_sha256 does not match artifact"]
    try:
        payload = json.loads(artifact.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return [f"{location}.artifact is not valid JSON"]
    if not isinstance(payload, dict):
        return [f"{location}.artifact must contain a JSON object"]
    kind = item.get("kind")
    expected_types = {
        "receipt": "context-audit-check-receipt",
        "trace": "context-audit-consumption-trace",
        "model_effect": "context-audit-model-effect",
    }
    errors: list[str] = []
    if payload.get("type") != expected_types.get(kind):
        errors.append(f"{location}.artifact type does not match kind {kind}")
    repository = payload.get("repository")
    if not isinstance(repository, dict) or repository.get("path") != str(repo.resolve()):
        errors.append(f"{location}.artifact repository does not match")
    if kind == "trace":
        current_files, _ = repository_files(repo)
        current_snapshot = repository_snapshot(repo, current_files)
        if not isinstance(repository, dict) or repository.get("head") != repository_head(repo):
            errors.append(f"{location}.trace repository HEAD is stale")
        if not isinstance(repository, dict) or repository.get("worktree_fingerprint") != current_snapshot["fingerprint"]:
            errors.append(f"{location}.trace worktree snapshot is stale")
        observation_ids = payload.get("observation_ids")
        if not isinstance(observation_ids, list) or claim_id not in observation_ids:
            errors.append(f"{location}.trace does not bind observation {claim_id}")
        if not isinstance(payload.get("events"), list) or not payload.get("events"):
            errors.append(f"{location}.trace requires non-empty events")
        if not isinstance(payload.get("consumed_sources"), list):
            errors.append(f"{location}.trace requires consumed_sources")
    if kind == "model_effect":
        for field in ("protocol", "dataset", "result"):
            if not isinstance(payload.get(field), dict):
                errors.append(f"{location}.model_effect requires {field} object")
    return errors


def validate_git_item(repo: Path, item: dict[str, Any], location: str) -> list[str]:
    path_value = item.get("path")
    commit = item.get("commit")
    if not isinstance(path_value, str) or not path_value:
        return [f"{location}.path is required for git evidence"]
    if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40}", commit):
        return [f"{location}.commit must be a full Git SHA"]
    result = subprocess.run(
        ["git", "log", "--follow", "-1", "--format=%H", "--", path_value],
        cwd=repo,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0 or result.stdout.strip() != commit:
        return [f"{location}.commit does not match current path history"]
    return []


def validate_evidence(
    repo: Path, item: Any, location: str, claim_id: str,
) -> list[str]:
    if not isinstance(item, dict):
        return [f"{location} must be an object"]
    errors: list[str] = []
    kind = item.get("kind")
    if kind not in EVIDENCE_KINDS:
        errors.append(f"{location}.kind must be one of {sorted(EVIDENCE_KINDS)}")
    for field in ("statement", "proves", "does_not_prove"):
        if not isinstance(item.get(field), str) or not item.get(field, "").strip():
            errors.append(f"{location}.{field} is required")
    path_value = item.get("path")
    if path_value:
        if not isinstance(path_value, str):
            errors.append(f"{location}.path must be a string")
        else:
            resolved = (repo / path_value).resolve()
            try:
                resolved.relative_to(repo.resolve())
            except ValueError:
                errors.append(f"{location}.path escapes repository")
            else:
                if not resolved.exists():
                    errors.append(f"{location}.path does not exist: {path_value}")
                elif is_tooling_path(repo, resolved):
                    errors.append(f"{location}.path cannot use the audit tool as target evidence")
                elif "line_start" in item or "line_end" in item:
                    line_start = item.get("line_start")
                    line_end = item.get("line_end")
                    if (
                        not isinstance(line_start, int)
                        or isinstance(line_start, bool)
                        or not isinstance(line_end, int)
                        or isinstance(line_end, bool)
                        or line_start < 1
                        or line_end < line_start
                    ):
                        errors.append(
                            f"{location}.line_start/line_end must be a positive ordered range"
                        )
                    elif resolved.is_file():
                        try:
                            line_count = sum(
                                1 for _ in resolved.open(
                                    "r", encoding="utf-8", errors="replace",
                                )
                            )
                        except OSError:
                            line_count = 0
                        if line_end > line_count:
                            errors.append(
                                f"{location}.line_end exceeds current file length"
                            )
    if kind in {"validator", "test"}:
        errors.extend(validate_check_receipt(repo, item, location, claim_id))
    if kind == "git":
        errors.extend(validate_git_item(repo, item, location))
    if kind in {"receipt", "trace", "model_effect"}:
        errors.extend(validate_local_artifact(repo, item, location, claim_id))
    if kind == "owner_review":
        if not isinstance(item.get("path"), str) or not item.get("path", "").strip():
            errors.append(f"{location}.path is required for owner_review")
        else:
            errors.extend(validate_git_item(repo, item, location))
        if not isinstance(item.get("reviewer"), str) or not item.get("reviewer", "").strip():
            errors.append(f"{location}.reviewer is required for owner_review")
        if item.get("decision") not in {"approved", "rejected"}:
            errors.append(f"{location}.decision must be approved or rejected")
        reviewed_at = item.get("reviewed_at")
        if not isinstance(reviewed_at, str) or "T" not in reviewed_at:
            errors.append(f"{location}.reviewed_at must be an ISO timestamp")
    return errors


def evidence_has_locator(item: dict[str, Any]) -> bool:
    line_start = item.get("line_start")
    line_end = item.get("line_end")
    return (
        isinstance(line_start, int)
        and not isinstance(line_start, bool)
        and isinstance(line_end, int)
        and not isinstance(line_end, bool)
        and line_start >= 1
        and line_end >= line_start
    )


def receipt_payload(item: dict[str, Any]) -> dict[str, Any] | None:
    receipt_value = item.get("receipt")
    if not isinstance(receipt_value, str):
        return None
    try:
        payload = json.loads(Path(receipt_value).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def receipt_input_paths(item: dict[str, Any]) -> set[str]:
    payload = receipt_payload(item)
    if payload is None or not isinstance(payload.get("input_files"), list):
        return set()
    return {
        value["path"]
        for value in payload["input_files"]
        if isinstance(value, dict) and isinstance(value.get("path"), str)
    }


def receipt_execution_fingerprint(item: dict[str, Any]) -> str | None:
    payload = receipt_payload(item)
    if payload is None:
        return None
    selector = {
        "command": payload.get("command"),
        "input_files": payload.get("input_files"),
        "stdout_sha256": payload.get("stdout_sha256"),
        "stderr_sha256": payload.get("stderr_sha256"),
        "exit_code": payload.get("exit_code"),
        "worktree_fingerprint": (
            payload.get("repository", {}).get("worktree_fingerprint")
            if isinstance(payload.get("repository"), dict) else None
        ),
    }
    return hashlib.sha256(
        json.dumps(selector, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def validate_assessment(
    repo: Path, discovery: dict[str, Any], assessment: dict[str, Any],
) -> list[str]:
    errors: list[str] = []
    used_receipt_selectors: dict[str, str] = {}
    if assessment.get("schema_version") != SCHEMA_VERSION:
        errors.append(f"assessment.schema_version must be {SCHEMA_VERSION}")
    repository = assessment.get("repository")
    assessed_head = repository.get("head") if isinstance(repository, dict) else None
    current_head = discovery["git"].get("head")
    if assessed_head and current_head and assessed_head != current_head:
        errors.append("assessment repository HEAD does not match current repository HEAD")
    if not isinstance(repository, dict):
        errors.append("assessment.repository must be an object")
    else:
        expected_fingerprint = discovery["repository"]["worktree_snapshot"]["fingerprint"]
        if repository.get("worktree_fingerprint") != expected_fingerprint:
            errors.append("assessment repository worktree fingerprint is stale or missing")
    profile = assessment.get("repository_profile")
    if not isinstance(profile, dict) or profile.get("class") not in PROFILE_CLASSES:
        errors.append(f"repository_profile.class must be one of {sorted(PROFILE_CLASSES)}")
    elif not isinstance(profile.get("rationale"), str) or not profile.get("rationale", "").strip():
        errors.append("repository_profile.rationale is required")
    scopes = assessment.get("dimensions")
    if not isinstance(scopes, dict):
        return errors + ["dimensions must be an object"]
    for scope, definitions in (
        ("context_control_plane", CONTEXT_DIMENSIONS),
        ("repository_documentation", DOCUMENTATION_DIMENSIONS),
    ):
        values = scopes.get(scope)
        if not isinstance(values, dict):
            errors.append(f"dimensions.{scope} must be an object")
            continue
        if set(values) != set(definitions):
            errors.append(f"dimensions.{scope} must contain exactly {sorted(definitions)}")
            continue
        for key in definitions:
            entry = values[key]
            location = f"dimensions.{scope}.{key}"
            if not isinstance(entry, dict):
                errors.append(f"{location} must be an object")
                continue
            if "level" in entry:
                errors.append(f"{location}.level is derived and must not be supplied")
            if not isinstance(entry.get("rationale"), str) or not entry.get("rationale", "").strip():
                errors.append(f"{location}.rationale is required")
            observations = entry.get("observations")
            if not isinstance(observations, dict):
                errors.append(f"{location}.observations must be an object")
                continue
            expected_ids = {
                observation_id(scope, key, slot["key"])
                for slot in OBSERVATION_SLOTS[scope][key]
            }
            if set(observations) != expected_ids:
                errors.append(
                    f"{location}.observations must contain exactly {sorted(expected_ids)}"
                )
                continue
            slot_by_id = {
                observation_id(scope, key, slot["key"]): slot
                for slot in OBSERVATION_SLOTS[scope][key]
            }
            for claim_id, observation in observations.items():
                observation_location = f"{location}.observations.{claim_id}"
                if not isinstance(observation, dict):
                    errors.append(f"{observation_location} must be an object")
                    continue
                status = observation.get("status")
                if status not in OBSERVATION_STATUSES:
                    errors.append(
                        f"{observation_location}.status must be one of {sorted(OBSERVATION_STATUSES)}"
                    )
                rationale = observation.get("rationale")
                if status != "unknown" and (
                    not isinstance(rationale, str) or not rationale.strip()
                ):
                    errors.append(f"{observation_location}.rationale is required")
                subject = observation.get("subject")
                if status != "unknown" and (
                    not isinstance(subject, str) or not subject.strip()
                ):
                    errors.append(f"{observation_location}.subject is required")
                limitations = observation.get("limitations")
                if not isinstance(limitations, list) or not all(
                    isinstance(value, str) for value in limitations
                ):
                    errors.append(f"{observation_location}.limitations must be a string array")
                evidence = observation.get("evidence")
                if not isinstance(evidence, list):
                    errors.append(f"{observation_location}.evidence must be an array")
                    continue
                for index, item in enumerate(evidence):
                    errors.extend(validate_evidence(
                        repo, item, f"{observation_location}.evidence[{index}]", claim_id,
                    ))
                    if isinstance(item, dict) and item.get("kind") in {"validator", "test"}:
                        signature = receipt_execution_fingerprint(item)
                        if signature:
                            previous_claim = used_receipt_selectors.get(signature)
                            if previous_claim and previous_claim != claim_id:
                                errors.append(
                                    f"{observation_location}.evidence[{index}] reuses the same "
                                    f"execution fingerprint across claims {previous_claim} and {claim_id}"
                                )
                            else:
                                used_receipt_selectors[signature] = claim_id
                if status in {"pass", "partial", "fail"} and not evidence:
                    errors.append(f"{observation_location} requires evidence for status {status}")
                kinds = {item.get("kind") for item in evidence if isinstance(item, dict)}
                if status in {"pass", "partial"}:
                    for index, item in enumerate(evidence):
                        if (
                            isinstance(item, dict)
                            and item.get("kind") in {"file", "git"}
                            and not evidence_has_locator(item)
                        ):
                            errors.append(
                                f"{observation_location}.evidence[{index}] "
                                "file/git evidence for pass or partial requires "
                                "line_start/line_end locator"
                            )
                if status in {"pass", "partial", "fail"} and not (
                    kinds & {"file", "git", "owner_review", "test", "trace", "validator"}
                ):
                    errors.append(
                        f"{observation_location} requires static or reviewed evidence; "
                        "receipt/model_effect are supplementary only"
                    )
                slot = slot_by_id[claim_id]
                if slot.get("strong") and status == "pass":
                    allowed = STRONG_EVIDENCE_BY_DIMENSION.get(
                        key, EXECUTABLE_EVIDENCE,
                    )
                    claim_paths = {
                        item.get("path")
                        for item in evidence
                        if isinstance(item, dict)
                        and item.get("kind") in {"file", "git"}
                        and isinstance(item.get("path"), str)
                    }
                    strong_kinds: set[str] = set()
                    unbound_executable = False
                    for item in evidence:
                        if not isinstance(item, dict):
                            continue
                        evidence_kind = item.get("kind")
                        if evidence_kind == "owner_review":
                            if item.get("decision") == "approved":
                                strong_kinds.add(evidence_kind)
                            continue
                        if evidence_kind in EXECUTABLE_EVIDENCE:
                            if claim_paths & receipt_input_paths(item):
                                strong_kinds.add(evidence_kind)
                            else:
                                unbound_executable = True
                            continue
                        if evidence_kind in {"trace"}:
                            strong_kinds.add(evidence_kind)
                    if unbound_executable and not (strong_kinds & allowed):
                        errors.append(
                            f"{observation_location} validator/test receipt input_files "
                            "must include a file/git evidence path from the same observation"
                        )
                    if not (strong_kinds & allowed):
                        errors.append(
                            f"{observation_location} pass requires strong evidence: {sorted(allowed)}"
                        )
    for field in ("cross_cutting_findings", "actions"):
        if not isinstance(assessment.get(field), list):
            errors.append(f"{field} must be an array")
    return errors


def flatten_findings(
    assessment: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    context: list[dict[str, Any]] = []
    documentation: list[dict[str, Any]] = []
    for scope, target in (
        ("context_control_plane", context),
        ("repository_documentation", documentation),
    ):
        for key, entry in assessment["dimensions"][scope].items():
            for finding in entry.get("findings", []):
                if isinstance(finding, dict):
                    target.append({"dimension": key, **finding})
    for finding in assessment.get("cross_cutting_findings", []):
        if isinstance(finding, dict):
            context.append({
                "dimension": finding.get("dimension", "cross_cutting"), **finding,
            })
    return context, documentation


def critical_observation_findings(
    assessment: dict[str, Any], scope: str,
) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    for dimension, entry in assessment["dimensions"][scope].items():
        slots = {
            observation_id(scope, dimension, slot["key"]): slot
            for slot in OBSERVATION_SLOTS[scope][dimension]
        }
        for claim_id, observation in entry.get("observations", {}).items():
            if slots.get(claim_id, {}).get("critical") and observation.get("status") == "fail":
                findings.append({
                    "dimension": dimension, "observation_id": claim_id,
                    "severity": "P0", "title": slots[claim_id]["label"],
                    "evidence": observation.get("evidence", []),
                    "rationale": observation.get("rationale", ""),
                    "source": "derived_from_critical_observation",
                })
    return findings


def dimension_points(
    entries: dict[str, Any], definitions: dict[str, dict[str, Any]],
) -> dict[str, float | None]:
    values = {"pass": 1.0, "partial": 0.5, "fail": 0.0}
    points: dict[str, float | None] = {}
    for key, definition in definitions.items():
        statuses = [
            observation.get("status")
            for observation in entries[key].get("observations", {}).values()
        ]
        if not statuses or any(status == "unknown" for status in statuses):
            points[key] = None
            continue
        score = sum(values.get(status, 0.0) for status in statuses) / len(statuses)
        points[key] = round(definition["weight"] * score, 2)
    return points


def derived_levels(entries: dict[str, Any]) -> dict[str, float | None]:
    values = {"pass": 1.0, "partial": 0.5, "fail": 0.0}
    result: dict[str, float | None] = {}
    for key, entry in entries.items():
        statuses = [
            observation.get("status")
            for observation in entry.get("observations", {}).values()
        ]
        result[key] = (
            None if not statuses or any(status == "unknown" for status in statuses)
            else round(4 * sum(values.get(status, 0.0) for status in statuses) / len(statuses), 2)
        )
    return result


def score_total(points: dict[str, float | None]) -> float | None:
    if any(value is None for value in points.values()):
        return None
    return round(sum(float(value) for value in points.values()), 1)


def evidence_grade(
    discovery: dict[str, Any], assessment: dict[str, Any] | None, complete: bool,
) -> str:
    if assessment is None:
        return "Unknown"
    items: list[dict[str, Any]] = []
    for scope in assessment["dimensions"].values():
        for entry in scope.values():
            for observation in entry.get("observations", {}).values():
                items.extend(
                    item for item in observation.get("evidence", []) if isinstance(item, dict)
                )
    kinds = {item.get("kind") for item in items}
    if not kinds:
        return "Unknown"
    has_git = (
        discovery["git"].get("availability") in {"full", "shallow"}
        and "git" in kinds
    )
    has_executable = bool(kinds & EXECUTABLE_EVIDENCE)
    snapshot_complete = discovery["repository"]["worktree_snapshot"].get("complete") is True
    dirty_paths = {
        line[3:] for line in discovery["git"].get("dirty_paths", [])
        if isinstance(line, str) and len(line) >= 4
    }
    evidence_paths = {
        item.get("path") for item in items
        if isinstance(item.get("path"), str)
    }
    dirty_evidence = bool(dirty_paths & evidence_paths)
    strong_complete = True
    for scope_name, scope in assessment["dimensions"].items():
        for dimension, entry in scope.items():
            slots = {
                observation_id(scope_name, dimension, slot["key"]): slot
                for slot in OBSERVATION_SLOTS[scope_name][dimension]
            }
            for claim_id, observation in entry.get("observations", {}).items():
                if slots.get(claim_id, {}).get("strong") and observation.get("status") != "pass":
                    strong_complete = False
    has_approved_owner_review = False
    for scope_name, scope in assessment["dimensions"].items():
        for dimension, entry in scope.items():
            if dimension not in {"authority_and_content", "service_ownership_and_entry"}:
                continue
            for observation in entry.get("observations", {}).values():
                for item in observation.get("evidence", []):
                    if (
                        isinstance(item, dict)
                        and item.get("kind") == "owner_review"
                        and item.get("decision") == "approved"
                        and isinstance(item.get("path"), str)
                        and isinstance(item.get("commit"), str)
                    ):
                        has_approved_owner_review = True
    if (
        complete and "file" in kinds and has_git and has_executable
        and discovery["git"].get("availability") == "full"
        and snapshot_complete and strong_complete and has_approved_owner_review
        and not dirty_evidence
    ):
        return "A"
    if "file" in kinds and (has_git or has_executable):
        return "B"
    return "C"


def evidence_grade_reason(
    discovery: dict[str, Any], assessment: dict[str, Any] | None,
    complete: bool, grade: str,
) -> str:
    if assessment is None or grade == "Unknown":
        return "尚未完成 Agent Assessment，证据组合未进入等级判定。"
    if grade == "A":
        return (
            "Assessment 完整，且具备当前文件、完整 Git、完整快照、全部强证据槽、"
            "可执行回执和已定位且批准的 Owner/权威复核。"
        )
    if grade == "C":
        return "证据尚未形成当前文件与 Git 或可执行检查的最小组合，因此为 C。"
    missing: list[str] = []
    if not complete:
        missing.append("全部 observations 已判定")
    if discovery["git"].get("availability") != "full":
        missing.append("完整 Git 历史")
    if discovery["repository"]["worktree_snapshot"].get("complete") is not True:
        missing.append("完整工作区快照")
    owner_review = False
    incomplete_strong = False
    evidence_paths: set[str] = set()
    for scope_name, scope in assessment["dimensions"].items():
        for dimension, entry in scope.items():
            slots = {
                observation_id(scope_name, dimension, slot["key"]): slot
                for slot in OBSERVATION_SLOTS[scope_name][dimension]
            }
            for claim_id, observation in entry.get("observations", {}).items():
                if slots.get(claim_id, {}).get("strong") and observation.get("status") != "pass":
                    incomplete_strong = True
                if dimension in {"authority_and_content", "service_ownership_and_entry"}:
                    owner_review = owner_review or any(
                        isinstance(item, dict)
                        and item.get("kind") == "owner_review"
                        and item.get("decision") == "approved"
                        and isinstance(item.get("path"), str)
                        and isinstance(item.get("commit"), str)
                        for item in observation.get("evidence", [])
                    )
                evidence_paths.update(
                    item.get("path") for item in observation.get("evidence", [])
                    if isinstance(item, dict) and isinstance(item.get("path"), str)
                )
    if incomplete_strong:
        missing.append("全部强证据槽 pass")
    if not owner_review:
        missing.append("已定位且批准的 Owner/权威复核")
    dirty_paths = {
        line[3:] for line in discovery["git"].get("dirty_paths", [])
        if isinstance(line, str) and len(line) >= 4
    }
    if dirty_paths & evidence_paths:
        missing.append("已提交的核心证据路径")
    suffix = "、".join(missing) if missing else "A 级所需的完整证据组合"
    return f"文件与 Git/可执行证据已形成组合，但仍缺 {suffix}，因此为 B。"


def assessment_evidence_catalog(
    assessment: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Return normalized, receipt-backed and Git-backed assessment evidence."""
    receipts: list[dict[str, Any]] = []
    git_items: list[dict[str, Any]] = []
    for scope_name, scope in assessment["dimensions"].items():
        for dimension, entry in scope.items():
            for claim_id, observation in entry.get("observations", {}).items():
                claim_paths = sorted({
                    item.get("path")
                    for item in observation.get("evidence", [])
                    if isinstance(item, dict)
                    and item.get("kind") in {"file", "git"}
                    and isinstance(item.get("path"), str)
                })
                for item in observation.get("evidence", []):
                    if not isinstance(item, dict):
                        continue
                    kind = item.get("kind")
                    if kind in EXECUTABLE_EVIDENCE:
                        payload = receipt_payload(item)
                        if payload is None:
                            continue
                        input_hashes = [
                            {"path": value.get("path"), "sha256": value.get("sha256")}
                            for value in payload.get("input_files", [])
                            if isinstance(value, dict)
                        ]
                        assertion = payload.get("output_assertion")
                        selector = assertion if isinstance(assertion, dict) else {}
                        stdout_sha256 = payload.get("stdout_sha256")
                        stderr_sha256 = payload.get("stderr_sha256")
                        validated_input_paths = sorted({
                            value["path"] for value in input_hashes
                            if isinstance(value.get("path"), str)
                        })
                        receipts.append({
                            "scope": scope_name,
                            "dimension": dimension,
                            "observation_id": claim_id,
                            "claim": payload.get("claim_id"),
                            "kind": kind,
                            "path": item.get("path"),
                            "command": payload.get("command"),
                            "artifact_path": item.get("receipt"),
                            "artifact_sha256": item.get("receipt_sha256"),
                            "receipt_sha256": item.get("receipt_sha256"),
                            "execution_fingerprint": receipt_execution_fingerprint(item),
                            "input_hashes": input_hashes,
                            "validated_input_paths": validated_input_paths,
                            "claimed_evidence_paths": claim_paths,
                            "matched_claim_paths": sorted(
                                set(claim_paths) & set(validated_input_paths)
                            ),
                            "stdout_sha256": stdout_sha256,
                            "stderr_sha256": stderr_sha256,
                            "output_hashes": {
                                "stdout_sha256": stdout_sha256,
                                "stderr_sha256": stderr_sha256,
                            },
                            "expected_output": selector.get("expected"),
                            "selector": selector,
                            "exit_code": payload.get("exit_code"),
                            "recorded_at": payload.get("started_at"),
                            "duration_ms": payload.get("duration_ms"),
                        })
                    if kind in {"git", "owner_review"}:
                        git_item = {
                            "scope": scope_name,
                            "dimension": dimension,
                            "observation_id": claim_id,
                            "kind": kind,
                            "path": item.get("path"),
                            "commit": item.get("commit"),
                            "statement": item.get("statement"),
                            "proves": item.get("proves"),
                            "does_not_prove": item.get("does_not_prove"),
                        }
                        if evidence_has_locator(item):
                            git_item["locator"] = {
                                "line_start": item.get("line_start"),
                                "line_end": item.get("line_end"),
                            }
                        if kind == "owner_review":
                            git_item.update({
                                "reviewer": item.get("reviewer"),
                                "decision": item.get("decision"),
                                "reviewed_at": item.get("reviewed_at"),
                            })
                        git_items.append(git_item)

    shared: defaultdict[tuple[Any, ...], set[str]] = defaultdict(set)
    for item in git_items:
        locator = item.get("locator", {})
        key = (
            item.get("kind"), item.get("path"), item.get("commit"),
            locator.get("line_start"), locator.get("line_end"),
        )
        shared[key].add(item["observation_id"])
    for item in git_items:
        locator = item.get("locator", {})
        key = (
            item.get("kind"), item.get("path"), item.get("commit"),
            locator.get("line_start"), locator.get("line_end"),
        )
        item["shared_with_observation_ids"] = sorted(
            shared[key] - {item["observation_id"]}
        )
    return receipts, git_items


def rationale_payload() -> dict[str, dict[str, Any]]:
    payload = {
        "context_control_plane": {}, "repository_documentation": {},
    }
    for scope, definitions in (
        ("context_control_plane", CONTEXT_DIMENSIONS),
        ("repository_documentation", DOCUMENTATION_DIMENSIONS),
    ):
        for key, definition in definitions.items():
            payload[scope][key] = {
                **definition,
                "observations": [
                    {
                        **slot,
                        "id": observation_id(scope, key, slot["key"]),
                    }
                    for slot in OBSERVATION_SLOTS[scope][key]
                ],
                "scoring": "pass=1, partial=0.5, fail=0；任一 unknown 时该维及量表不出分。",
            }
    return payload


def unassessed_result(discovery: dict[str, Any]) -> dict[str, Any]:
    template = assessment_template(discovery)
    return {
        "schema_version": SCHEMA_VERSION,
        "assessment_status": "needs_agent_review", "gate_status": "not_assessed",
        "score": None, "dimensions": {key: None for key in CONTEXT_DIMENSIONS},
        "derived_levels": {key: None for key in CONTEXT_DIMENSIONS},
        "dimension_labels": {
            key: value["label"] for key, value in CONTEXT_DIMENSIONS.items()
        },
        "documentation": {
            "score": None,
            "dimensions": {key: None for key in DOCUMENTATION_DIMENSIONS},
            "derived_levels": {key: None for key in DOCUMENTATION_DIMENSIONS},
            "dimension_labels": {
                key: value["label"] for key, value in DOCUMENTATION_DIMENSIONS.items()
            },
            "findings": [], "p0_findings": [],
        },
        "repository_profile": {
            "class": None, "rationale": "等待 Agent 根据仓库事实完成画像。",
            "signals": discovery["inventory"],
        },
        "git_evidence": discovery["git"], "evidence_grade": "Unknown",
        "evidence_grade_reason": evidence_grade_reason(
            discovery, None, False, "Unknown",
        ),
        "receipt_evidence": [], "git_assessment_evidence": [],
        "dimension_rationale": rationale_payload(),
        "dimension_assessments": template["dimensions"],
        "findings": [], "p0_findings": [], "p1_findings": [],
        "actions": [
            "读取发现结果，映射目标仓库自己的入口、Owner、文档、路由和验证方式。",
            "抽样核查文件、Git、Validator/测试与内容来源后填写本地 Assessment。",
            "Assessment 完整且证据契约通过后再计算双百分制分数。",
        ],
        "discovery": discovery, "assessment_errors": [],
    }


def scored_result(
    repo: Path, discovery: dict[str, Any], assessment: dict[str, Any],
) -> dict[str, Any]:
    errors = validate_assessment(repo, discovery, assessment)
    if errors:
        result = unassessed_result(discovery)
        result.update({
            "assessment_status": "invalid", "assessment_errors": errors,
            "evidence_grade_reason": (
                "Assessment 证据契约无效，修复前不判定证据等级。"
            ),
            "actions": ["修复 Assessment 证据契约后重新评分。"],
        })
        return result
    context_entries = assessment["dimensions"]["context_control_plane"]
    documentation_entries = assessment["dimensions"]["repository_documentation"]
    context_points = dimension_points(context_entries, CONTEXT_DIMENSIONS)
    documentation_points = dimension_points(
        documentation_entries, DOCUMENTATION_DIMENSIONS,
    )
    context_score = score_total(context_points)
    documentation_score = score_total(documentation_points)
    context_levels = derived_levels(context_entries)
    documentation_levels = derived_levels(documentation_entries)
    complete = context_score is not None and documentation_score is not None
    context_findings, documentation_findings = flatten_findings(assessment)
    context_findings.extend(
        critical_observation_findings(assessment, "context_control_plane")
    )
    documentation_findings.extend(
        critical_observation_findings(assessment, "repository_documentation")
    )
    p0_context = [item for item in context_findings if item.get("severity") == "P0"]
    p1_context = [item for item in context_findings if item.get("severity") == "P1"]
    p0_documentation = [
        item for item in documentation_findings if item.get("severity") == "P0"
    ]
    if not complete:
        gate_status = "not_assessed"
    elif p0_context or p0_documentation:
        gate_status = "blocked"
    elif context_score >= 85 and documentation_score >= 85:
        gate_status = "passed"
    else:
        gate_status = "needs_improvement"
    grade = evidence_grade(discovery, assessment, complete)
    receipt_evidence, git_assessment_evidence = assessment_evidence_catalog(assessment)
    return {
        "schema_version": SCHEMA_VERSION,
        "assessment_status": "complete" if complete else "partial",
        "gate_status": gate_status, "score": context_score,
        "dimensions": context_points,
        "derived_levels": context_levels,
        "dimension_labels": {
            key: value["label"] for key, value in CONTEXT_DIMENSIONS.items()
        },
        "documentation": {
            "score": documentation_score, "dimensions": documentation_points,
            "derived_levels": documentation_levels,
            "dimension_labels": {
                key: value["label"] for key, value in DOCUMENTATION_DIMENSIONS.items()
            },
            "findings": documentation_findings, "p0_findings": p0_documentation,
        },
        "repository_profile": {
            **assessment["repository_profile"], "signals": discovery["inventory"],
        },
        "git_evidence": discovery["git"],
        "evidence_grade": grade,
        "evidence_grade_reason": evidence_grade_reason(
            discovery, assessment, complete, grade,
        ),
        "receipt_evidence": receipt_evidence,
        "git_assessment_evidence": git_assessment_evidence,
        "dimension_rationale": rationale_payload(),
        "dimension_assessments": assessment["dimensions"],
        "findings": context_findings, "p0_findings": p0_context,
        "p1_findings": p1_context, "actions": assessment.get("actions", []),
        "discovery": discovery, "assessment_errors": [],
    }


def audit(repo: Path, assessment_path: Path | None = None) -> dict[str, Any]:
    repo = repo.resolve()
    discovery = discover(repo)
    if assessment_path is None:
        return unassessed_result(discovery)
    try:
        assessment = load_json(assessment_path)
    except ValueError as exc:
        result = unassessed_result(discovery)
        result.update({
            "assessment_status": "invalid",
            "assessment_errors": [str(exc)],
            "evidence_grade_reason": (
                "Assessment JSON 无效，修复前不判定证据等级。"
            ),
            "actions": ["修复 Assessment JSON 后重新评分。"],
        })
        return result
    return scored_result(repo, discovery, assessment)


def score_text(score: float | None) -> str:
    return "待评测" if score is None else f"{score:g} / 100"


def render_markdown(result: dict[str, Any]) -> str:
    profile = result["repository_profile"]
    lines = [
        "# 仓库上下文审计", "",
        f"评测状态：`{result['assessment_status']}`；门禁：`{result['gate_status']}`；证据等级：`{result['evidence_grade']}`。",
        "",
        f"仓库画像：`{profile.get('class') or '待评测'}` — {profile['rationale']}",
        "",
        f"Context 控制面：{score_text(result['score'])}",
        f"Repository Documentation：{score_text(result['documentation']['score'])}",
        "",
    ]
    if result["assessment_errors"]:
        lines.extend(["## Assessment 错误", ""])
        lines.extend(f"- {error}" for error in result["assessment_errors"])
        lines.append("")
    lines.extend([
        "## 证据边界", "", result["discovery"]["boundary"], "",
        "没有完成 Agent Assessment 时不生成数值分数；脚本只负责发现、验证证据契约和确定性算分。",
    ])
    return "\n".join(lines) + "\n"


def write_output(payload: str, output: Path | None) -> None:
    if output is None:
        print(payload, end="" if payload.endswith("\n") else "\n")
        return
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(payload, encoding="utf-8")
    print(output.resolve())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--assessment", type=Path)
    parser.add_argument("--write-template", type=Path)
    parser.add_argument("--record-check", type=Path)
    parser.add_argument("--claim")
    parser.add_argument("--input", type=Path, action="append", default=[])
    parser.add_argument("--expect")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--format", choices=("json", "markdown"), default="markdown")
    parser.add_argument("check_command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    repo = args.repo.resolve()
    if args.record_check:
        command = args.check_command[1:] if args.check_command[:1] == ["--"] else args.check_command
        try:
            return record_check(
                repo, args.record_check, args.claim or "", command, args.input,
                args.expect,
            )
        except ValueError as exc:
            parser.error(str(exc))
    discovery = discover(repo)
    if args.write_template:
        args.write_template.parent.mkdir(parents=True, exist_ok=True)
        args.write_template.write_text(
            json.dumps(assessment_template(discovery), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(args.write_template.resolve())
        return 0
    if args.format == "json" and args.output is None:
        parser.error("--format json requires --output so complete discovery stays local")
    if args.assessment is None:
        result = unassessed_result(discovery)
    else:
        try:
            result = scored_result(repo, discovery, load_json(args.assessment))
        except ValueError as exc:
            result = unassessed_result(discovery)
            result.update({
                "assessment_status": "invalid", "assessment_errors": [str(exc)],
                "evidence_grade_reason": (
                    "Assessment JSON 无效，修复前不判定证据等级。"
                ),
                "actions": ["修复 Assessment JSON 后重新评分。"],
            })
    payload = (
        json.dumps(result, ensure_ascii=False, indent=2) + "\n"
        if args.format == "json" else render_markdown(result)
    )
    write_output(payload, args.output)
    return 2 if result["assessment_status"] == "invalid" else 0


if __name__ == "__main__":
    raise SystemExit(main())
