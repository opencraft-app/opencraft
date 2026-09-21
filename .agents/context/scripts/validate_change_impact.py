#!/usr/bin/env python3
"""Check that a changed responsibility surface updates a mapped formal design document.

This is a deterministic change-set guard, not a semantic document reviewer.  Agents
still decide the actual impact from source, history and the Task Pack; Owners still
accept high-risk changes in the protected MR platform.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import subprocess
import sys
from pathlib import Path
from typing import Any


VALID_RISKS = {"normal", "high"}
REQUIRED_RULE_FIELDS = {"id", "paths", "design_docs", "risk", "owner"}
OPTIONAL_RULE_FIELDS = {"exclude_paths"}


def load_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"无法读取 {label}: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"{label} 必须是 JSON object")
    return value


def repo_relative(value: str, label: str) -> str:
    candidate = Path(value.strip())
    if not value.strip() or candidate.is_absolute() or ".." in candidate.parts:
        raise ValueError(f"{label} 必须是仓库内相对路径: {value}")
    return candidate.as_posix()


def matches(path: str, patterns: list[str]) -> bool:
    for pattern in patterns:
        if fnmatch.fnmatchcase(path, pattern):
            return True
        if pattern.endswith("/**"):
            root = pattern[:-3]
            if path == root or path.startswith(root + "/"):
                return True
    return False


def validate_manifest(repo: Path, payload: dict[str, Any]) -> list[dict[str, Any]]:
    if payload.get("schema_version") != 1:
        raise ValueError("change-impact manifest schema_version 必须为 1")
    for field in ("owner", "reviewed_at", "review_due"):
        if not isinstance(payload.get(field), str) or not payload[field].strip():
            raise ValueError(f"change-impact manifest 缺少 {field}")

    raw_rules = payload.get("rules")
    if not isinstance(raw_rules, list) or not raw_rules:
        raise ValueError("change-impact manifest rules 必须是非空数组")

    rules: list[dict[str, Any]] = []
    ids: set[str] = set()
    for index, raw_rule in enumerate(raw_rules):
        label = f"rules[{index}]"
        if not isinstance(raw_rule, dict):
            raise ValueError(f"{label} 必须是 JSON object")
        present = set(raw_rule)
        if not REQUIRED_RULE_FIELDS <= present:
            missing_fields = sorted(REQUIRED_RULE_FIELDS - present)
            raise ValueError(f"{label} 缺少必填字段 {missing_fields}")
        unknown_fields = sorted(present - REQUIRED_RULE_FIELDS - OPTIONAL_RULE_FIELDS)
        if unknown_fields:
            raise ValueError(f"{label} 包含未知字段 {unknown_fields}")
        rule_id = raw_rule.get("id")
        if not isinstance(rule_id, str) or not rule_id.strip() or rule_id in ids:
            raise ValueError(f"{label}.id 必须是唯一非空字符串")
        ids.add(rule_id)
        for field in ("paths", "design_docs"):
            values = raw_rule.get(field)
            if not isinstance(values, list) or not values or not all(isinstance(item, str) and item.strip() for item in values):
                raise ValueError(f"{label}.{field} 必须是非空字符串数组")
        excludes = raw_rule.get("exclude_paths", [])
        if not isinstance(excludes, list) or not all(isinstance(item, str) and item.strip() for item in excludes):
            raise ValueError(f"{label}.exclude_paths 必须是字符串数组")
        for path in raw_rule["design_docs"]:
            normalized = repo_relative(path, f"{label}.design_docs")
            if not (repo / normalized).is_file():
                raise ValueError(f"{label} 引用了不存在的正式设计文档: {normalized}")
        if raw_rule.get("risk") not in VALID_RISKS:
            raise ValueError(f"{label}.risk 必须是 {sorted(VALID_RISKS)} 之一")
        if not isinstance(raw_rule.get("owner"), str) or not raw_rule["owner"].strip():
            raise ValueError(f"{label}.owner 必须非空")
        rules.append(raw_rule)
    return rules


def git_changed_files(repo: Path, args: list[str]) -> list[str]:
    result = subprocess.run(["git", *args], cwd=repo, check=False, capture_output=True, text=True)
    if result.returncode != 0:
        raise ValueError(f"无法读取 Git 变更清单: {result.stderr.strip()}")
    return [repo_relative(line, "Git 变更路径") for line in result.stdout.splitlines() if line.strip()]


def changed_files(args: argparse.Namespace, repo: Path) -> list[str]:
    changed = [repo_relative(path, "--changed-file") for path in args.changed_file]
    if args.changed_files_file:
        try:
            lines = args.changed_files_file.read_text(encoding="utf-8").splitlines()
        except OSError as exc:
            raise ValueError(f"无法读取 --changed-files-file: {exc}") from exc
        changed.extend(repo_relative(line, "变更文件") for line in lines if line.strip())
    if args.staged:
        changed.extend(git_changed_files(repo, ["diff", "--cached", "--name-only"]))
    if args.base_ref:
        changed.extend(git_changed_files(repo, ["diff", "--name-only", f"{args.base_ref}...HEAD"]))
    return list(dict.fromkeys(changed))


def rule_triggers(rule: dict[str, Any], changed: list[str]) -> list[str]:
    """Return the changed paths that make this rule responsible for a design update.

    ``exclude_paths`` removes surfaces that live under a responsibility root but carry
    no architectural meaning, for example generated locale bundles, marketing copy,
    test fixtures and binary assets.  A rule only triggers when at least one changed
    path survives the exclusion filter.
    """
    excludes = rule.get("exclude_paths", [])
    return [
        path for path in changed
        if matches(path, rule["paths"]) and not matches(path, excludes)
    ]


def assess(
    rules: list[dict[str, Any]], changed: list[str]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    """Split matched rules into blocking failures and advisory reminders.

    ``risk: high`` rules block the change set, matching ADR-0002: a protected surface
    must not move without its formal design document.  ``risk: normal`` rules only
    remind, because a coarse responsibility root also covers low-risk edits whose
    architecture documents genuinely should not change.  Hard-blocking those would
    push authors to edit design documents for no reason, or to bypass the guard.
    """
    matched: list[dict[str, Any]] = []
    for rule in rules:
        if rule_triggers(rule, changed):
            matched.append(rule)
    undocumented = [
        rule for rule in matched
        if not any(matches(path, rule["design_docs"]) for path in changed)
    ]
    blocking = [rule for rule in undocumented if rule["risk"] == "high"]
    advisory = [rule for rule in undocumented if rule["risk"] != "high"]
    return matched, blocking, advisory


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--manifest", type=Path, default=Path(".agents/context/change-impact.json"))
    parser.add_argument("--changed-file", action="append", default=[])
    parser.add_argument("--changed-files-file", type=Path)
    parser.add_argument("--staged", action="store_true")
    parser.add_argument("--base-ref")
    parser.add_argument(
        "--require-owner-review",
        action="store_true",
        help="仅供受保护 MR adapter 使用；本地检查只输出高风险 Owner 提示。",
    )
    args = parser.parse_args()
    repo = args.repo.resolve()
    manifest = args.manifest if args.manifest.is_absolute() else repo / args.manifest

    try:
        rules = validate_manifest(repo, load_json(manifest, "change-impact manifest"))
        changed = changed_files(args, repo)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    matched, blocking, advisory = assess(rules, changed)
    if blocking:
        print("docs-impact: failed", file=sys.stderr)
        print("高风险变更必须同步更新以下正式设计文档（每个命中规则至少一份）：", file=sys.stderr)
        for rule in blocking:
            print(f"- {rule['id']}: {', '.join(rule['design_docs'])}", file=sys.stderr)
        print(
            "若确认本次变更不改变该责任面的架构语义，请收窄规则 paths 或补充 exclude_paths，"
            "不要为通过门禁而修改无关设计文档。",
            file=sys.stderr,
        )
        return 1

    for rule in advisory:
        print(
            f"docs-impact: 提示 {rule['id']} 命中但未更新设计文档"
            f"（risk=normal，不阻断）：{', '.join(rule['design_docs'])}"
        )

    high_risk = [rule for rule in matched if rule["risk"] == "high"]
    payload = {
        "status": "passed",
        "changed_files": changed,
        "matched_rules": [rule["id"] for rule in matched],
        "advisory_rules": [rule["id"] for rule in advisory],
        "owner_review_required": [
            {"rule_id": rule["id"], "owner": rule["owner"]} for rule in high_risk
        ],
        "boundary": "只校验变更集合与正式设计映射；语义正确性由 Agent 与 Owner 审阅。",
    }
    print("docs-impact: passed")
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    if args.require_owner_review and high_risk:
        print("高风险变更需要由受保护 MR 平台完成 Owner 审阅。", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
