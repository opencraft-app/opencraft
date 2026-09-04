#!/usr/bin/env python3
"""Validate and route the LightVela repository context contract."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import date
from pathlib import Path
from typing import Any


IGNORED_INSTRUCTION_PARTS = {".git", "node_modules", ".worktrees"}
VALID_STATUSES = {"active", "pilot", "candidate", "stale", "retired"}
SERVICE_CONTEXT_MAX_BYTES = 4096
GOVERNANCE_LAYER_IDS = {
    "formal_engineering_knowledge",
    "service_colocated_knowledge",
    "agent_derived_context",
    "context_control_plane",
    "reusable_workflows",
}
PROJECT_CONTEXT_FIELDS = {
    "architecture_refs",
    "module_relationships",
    "data_model_refs",
    "key_flows",
    "special_rules",
    "pitfalls",
    "decision_refs",
}
TASK_CONTRACT_FIELDS = {
    "requirement_ids",
    "requirement_refs",
    "requirement_excerpt",
    "interface_refs",
    "data_structure_refs",
    "history_context",
    "current_design_refs",
    "relevant_evolution",
    "superseded_refs",
    "context_receipt",
}
LONG_HEX_CREDENTIAL = re.compile(r"(?i)(?<![a-f0-9])[a-f0-9]{48,}(?![a-f0-9])")
PASSWORD_ASSIGNMENT = re.compile(
    r"(?i)\b(?:password|passwd|pwd)\b\s*[:=]\s*[`'\"]?([^\s`'\"]+)"
)
SHELL_CREDENTIAL_ASSIGNMENT = re.compile(
    r"^\s*(?:export\s+)?[A-Z][A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*['\"]?([^\s'\"]+)"
)
PRIVATE_KEY_MARKER = re.compile(r"-----BEGIN [A-Z ]+ PRIVATE KEY-----")
SAFE_CREDENTIAL_VALUES = {"<redacted>", "<secret>", "redacted", "placeholder", "..."}


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ValueError(f"cannot read {path}: {exc}") from exc


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(read_text(path))
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON-compatible YAML in {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain an object")
    return value


def parse_scalar(value: str) -> Any:
    value = value.strip()
    if not value:
        return None
    if value in {"true", "false"}:
        return value == "true"
    if value in {"null", "~"}:
        return None
    if value.startswith("[") or value.startswith("{"):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            pass
    if (value.startswith('"') and value.endswith('"')) or (
        value.startswith("'") and value.endswith("'")
    ):
        return value[1:-1]
    return value


def parse_frontmatter(text: str) -> dict[str, Any]:
    """Parse the flat scalar/list subset used by repository context metadata."""
    match = re.match(r"^---\s*\n(.*?)\n---\s*\n", text, re.DOTALL)
    if not match:
        return {}
    result: dict[str, Any] = {}
    current_key: str | None = None
    for line in match.group(1).splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("- ") and current_key is not None:
            if result.get(current_key) is None:
                result[current_key] = []
            if not isinstance(result[current_key], list):
                raise ValueError(f"frontmatter field {current_key} mixes scalar and list values")
            result[current_key].append(parse_scalar(stripped[2:]))
            continue
        if line.startswith((" ", "\t")) or ":" not in line:
            raise ValueError(f"unsupported nested frontmatter line: {line}")
        key, value = line.split(":", 1)
        current_key = key.strip()
        result[current_key] = parse_scalar(value)
    return result


def jsonl_records(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    if not path.exists():
        return records
    for line_number, line in enumerate(read_text(path).splitlines(), 1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"invalid JSONL at {path}:{line_number}: {exc}") from exc
        if not isinstance(value, dict):
            raise ValueError(f"JSONL record at {path}:{line_number} must be an object")
        records.append(value)
    return records


def is_iso_date(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        date.fromisoformat(value)
    except ValueError:
        return False
    return True


def validate_schema(instance: dict[str, Any], schema: dict[str, Any]) -> list[str]:
    """Validate the JSON Schema subset used by context-pack.schema.json."""
    errors: list[str] = []
    for field in schema.get("required", []):
        if field not in instance or instance[field] in (None, "", []):
            errors.append(f"missing required field {field}")
    for field, rules in schema.get("properties", {}).items():
        if field not in instance:
            continue
        value = instance[field]
        expected_type = rules.get("type")
        type_matches = {
            "string": isinstance(value, str),
            "array": isinstance(value, list),
            "boolean": isinstance(value, bool),
            "integer": isinstance(value, int) and not isinstance(value, bool),
        }
        if expected_type and not type_matches.get(expected_type, False):
            errors.append(f"{field} must be {expected_type}, got {type(value).__name__}")
            continue
        if "enum" in rules and value not in rules["enum"]:
            errors.append(f"{field} must be one of {rules['enum']}")
        if isinstance(value, str):
            if len(value) < rules.get("minLength", 0):
                errors.append(f"{field} is shorter than {rules['minLength']}")
            if rules.get("pattern") and re.fullmatch(rules["pattern"], value) is None:
                errors.append(f"{field} does not match {rules['pattern']}")
            if rules.get("format") == "date" and not is_iso_date(value):
                errors.append(f"{field} must be an ISO date")
        if isinstance(value, list):
            if len(value) < rules.get("minItems", 0):
                errors.append(f"{field} needs at least {rules['minItems']} items")
            item_type = rules.get("items", {}).get("type")
            if item_type == "string" and any(not isinstance(item, str) for item in value):
                errors.append(f"{field} items must be strings")
    return errors


def local_link_errors(paths: list[Path]) -> list[str]:
    errors: list[str] = []
    markdown_link = re.compile(r"\[[^\]]+\]\(([^)]+)\)")
    for path in paths:
        for link in markdown_link.findall(read_text(path)):
            if link.startswith(("http://", "https://", "mailto:", "#")):
                continue
            target = link.split("#", 1)[0]
            if target and not (path.parent / target).resolve().exists():
                errors.append(f"broken local link {link} in {path}")
    return errors


def is_placeholder_credential(value: str) -> bool:
    normalized = value.strip("`'\"").lower()
    return (
        normalized in SAFE_CREDENTIAL_VALUES
        or normalized.startswith(("$", "${", "<", "{{"))
        or normalized.endswith("...")
    )


def secret_literal_errors(paths: list[Path]) -> list[str]:
    """Reject likely credential values while allowing names and Secret references."""
    errors: list[str] = []
    for path in paths:
        for line_number, line in enumerate(read_text(path).splitlines(), 1):
            reasons: list[str] = []
            if PRIVATE_KEY_MARKER.search(line):
                reasons.append("private-key marker")
            if LONG_HEX_CREDENTIAL.search(line):
                reasons.append("long hexadecimal credential")
            password = PASSWORD_ASSIGNMENT.search(line)
            if password and not is_placeholder_credential(password.group(1)):
                reasons.append("literal password assignment")
            shell_assignment = SHELL_CREDENTIAL_ASSIGNMENT.search(line)
            if shell_assignment and not is_placeholder_credential(shell_assignment.group(1)):
                reasons.append("shell credential assignment")
            if reasons:
                errors.append(
                    f"possible plaintext credential in {path}:{line_number} ({', '.join(reasons)})"
                )
    return errors


def instruction_files(repo: Path) -> list[Path]:
    return sorted(
        path
        for path in repo.rglob("AGENTS.md")
        if not any(part in IGNORED_INSTRUCTION_PARTS for part in path.relative_to(repo).parts)
    )


def instruction_chains(repo: Path) -> dict[Path, int]:
    chains: dict[Path, int] = {}
    for path in instruction_files(repo):
        total = 0
        current = path.parent
        while True:
            instruction = current / "AGENTS.md"
            if instruction.exists():
                total += instruction.stat().st_size
            if current == repo:
                break
            current = current.parent
        chains[path] = total
    return chains


def matches_token(query: str, candidate: str) -> bool:
    candidate = candidate.lower().strip()
    if not candidate:
        return False
    if any(ord(char) > 127 for char in candidate) or any(char in candidate for char in "/._"):
        matches = list(re.finditer(re.escape(candidate), query))
    else:
        matches = list(re.finditer(rf"(?<![a-z0-9]){re.escape(candidate)}(?![a-z0-9])", query))

    for match in matches:
        prefix = query[max(0, match.start() - 16) : match.start()]
        chinese_negation = re.search(
            r"(?:不(?:需要|进行|执行|修改|提交|推送|发布|部署|上线)?|不要|无需|不需|禁止|避免)\s*$",
            prefix,
        )
        english_negation = re.search(
            r"(?:do not|don't|without|no)\s+(?:[a-z0-9_-]+\s+){0,2}$",
            prefix,
        )
        if not chinese_negation and not english_negation:
            return True
    return False


def route_score(query: str, route: dict[str, Any]) -> tuple[int, dict[str, list[str]]]:
    normalized = query.lower()
    matches = {
        "paths": [value for value in route.get("path_prefixes", []) if value.lower() in normalized],
        "deferred_paths": [value for value in route.get("deferred_paths", []) if value.lower() in normalized],
        "symbols": [value for value in route.get("symbols", []) if matches_token(normalized, value)],
        "triggers": [value for value in route.get("triggers", []) if matches_token(normalized, value)],
        "weak_triggers": [
            value for value in route.get("weak_triggers", []) if matches_token(normalized, value)
        ],
    }
    score = (
        30 * len(matches["paths"])
        + 20 * len(matches["deferred_paths"])
        + 5 * len(matches["symbols"])
        + 2 * len(matches["triggers"])
        + 1 * len(matches["weak_triggers"])
    )
    return score, matches


def route_packs(query: str, routing: dict[str, Any]) -> list[dict[str, Any]]:
    candidates = [*routing.get("packs", []), *routing.get("supplemental_routes", [])]
    matched: list[dict[str, Any]] = []
    for order, route in enumerate(candidates):
        score, matches = route_score(query, route)
        if score >= 2:
            matched.append({**route, "score": score, "match": matches, "_order": order})
    return sorted(matched, key=lambda item: (-item["score"], item["_order"]))


def unique(values: list[str]) -> list[str]:
    return list(dict.fromkeys(values))


def context_documents(repo: Path) -> list[Path]:
    root = repo / "docs/context"
    return sorted(root.rglob("*.md"))


def catalog_record(repo: Path, path: Path, metadata: dict[str, Any]) -> dict[str, Any]:
    return {
        "authority": metadata["authority"],
        "derived": metadata["derived"],
        "id": metadata["id"],
        "owner": metadata["owner"],
        "precedence": metadata["precedence"],
        "review_due": metadata["review_due"],
        "reviewed_at": metadata["reviewed_at"],
        "revision": metadata["revision"],
        "scope": metadata["scope"],
        "source_hash": hashlib.sha256(read_text(path).encode("utf-8")).hexdigest(),
        "status": metadata["status"],
        "type": metadata["type"],
        "uri": path.relative_to(repo).as_posix(),
    }


def validate_external_sources(path: Path) -> tuple[list[str], int]:
    errors: list[str] = []
    if not path.exists():
        return [f"missing external source registry: {path}"], 0
    payload = load_json(path)
    required = {
        "id",
        "uri",
        "authority",
        "use_for",
        "owner",
        "reviewed_at",
        "review_due",
        "version_policy",
        "stale_after_days",
        "unavailable_policy",
    }
    sources = payload.get("sources", [])
    for source in sources:
        missing = sorted(field for field in required if source.get(field) in (None, "", []))
        if missing:
            errors.append(f"external source {source.get('id', '<missing>')} missing: {', '.join(missing)}")
        uri = source.get("uri", "")
        if uri and not uri.startswith("https://cloud.tencent.com/"):
            errors.append(f"external source {source.get('id')} must use an official Tencent Cloud URI")
        if source.get("reviewed_at") and not is_iso_date(source["reviewed_at"]):
            errors.append(f"external source {source.get('id')} has invalid reviewed_at")
        if source.get("review_due") and not is_iso_date(source["review_due"]):
            errors.append(f"external source {source.get('id')} has invalid review_due")
    return errors, len(sources)


def validate_route_cases(repo: Path, routing: dict[str, Any]) -> tuple[list[str], int]:
    path = repo / ".agents/context/route-smoke-cases.json"
    if not path.exists():
        return ["missing route-smoke-cases.json"], 0
    cases = load_json(path).get("cases", [])
    errors: list[str] = []
    for case in cases:
        actual = {route["id"] for route in route_packs(case["query"], routing)}
        expected = set(case.get("required_pack_ids", []))
        forbidden = set(case.get("forbidden_pack_ids", []))
        if not expected.issubset(actual):
            errors.append(f"route case {case['id']} missing {sorted(expected - actual)}")
        if forbidden & actual:
            errors.append(f"route case {case['id']} included forbidden {sorted(forbidden & actual)}")
    return errors, len(cases)


def check_repo_paths(repo: Path, paths: Any, label: str, errors: list[str]) -> None:
    if not isinstance(paths, list) or not paths:
        errors.append(f"{label} must be a non-empty array")
        return
    for value in paths:
        if not isinstance(value, str) or not value:
            errors.append(f"{label} contains an invalid path")
            continue
        if value.startswith("<service>/"):
            continue
        candidate = Path(value)
        if candidate.is_absolute() or ".." in candidate.parts or not (repo / candidate).exists():
            errors.append(f"{label} references missing path {value}")


def validate_design_history(repo: Path, path: Path) -> tuple[dict[str, Any], list[str]]:
    result: dict[str, Any] = {"valid": False, "families": 0, "lifecycle_counts": {}}
    errors: list[str] = []
    if not path.exists():
        return result, [f"missing design history index: {path.relative_to(repo)}"]
    try:
        payload = load_json(path)
    except ValueError as exc:
        return result, [str(exc)]

    for field in ("schema_version", "owner", "reviewed_at", "review_due", "requirements_scope", "source_inventory", "families"):
        if payload.get(field) in (None, "", []):
            errors.append(f"design history index missing {field}")
    if payload.get("schema_version") != 1:
        errors.append("design history index schema_version must be 1")
    scope = payload.get("requirements_scope")
    if not isinstance(scope, dict) or scope.get("status") not in {"partial", "complete", "unknown"}:
        errors.append("design history index requirements_scope.status is invalid")
    sources = payload.get("source_inventory")
    if isinstance(sources, list):
        for index, source in enumerate(sources):
            label = f"design history source_inventory[{index}]"
            if not isinstance(source, dict):
                errors.append(f"{label} must be an object")
                continue
            for field in ("source_id", "kind", "scope", "access_status", "limitations"):
                if source.get(field) in (None, "", []):
                    errors.append(f"{label} missing {field}")
            if source.get("access_status") not in {"complete", "partial", "unknown", "unavailable"}:
                errors.append(f"{label} has invalid access_status")

    families = payload.get("families")
    ids: set[str] = set()
    counts: dict[str, int] = {}
    if isinstance(families, list):
        for index, family in enumerate(families):
            label = f"design history families[{index}]"
            if not isinstance(family, dict):
                errors.append(f"{label} must be an object")
                continue
            for field in (
                "family_id", "scope", "lifecycle", "owner_ref", "design_record",
                "current_code_evidence", "derived_contexts", "risk", "unknowns",
            ):
                if family.get(field) in (None, "", []):
                    errors.append(f"{label} missing {field}")
            family_id = family.get("family_id")
            if not isinstance(family_id, str) or not family_id or family_id in ids:
                errors.append(f"{label}.family_id must be unique and non-empty")
            elif family_id:
                ids.add(family_id)
            lifecycle = family.get("lifecycle")
            counts[str(lifecycle)] = counts.get(str(lifecycle), 0) + 1
            if lifecycle not in {"current", "superseded", "retired", "historical", "unknown"}:
                errors.append(f"{label} has invalid lifecycle {lifecycle}")
            if lifecycle == "current" and family.get("superseded_by") is not None:
                errors.append(f"{label} current family cannot have superseded_by")
            design_record = family.get("design_record")
            if not isinstance(design_record, str) or not (repo / design_record).is_file():
                errors.append(f"{label} references missing design_record {design_record}")
            check_repo_paths(repo, family.get("current_code_evidence"), f"{label}.current_code_evidence", errors)
            contexts = family.get("derived_contexts")
            if not isinstance(contexts, list) or not contexts:
                errors.append(f"{label}.derived_contexts must be non-empty")
            else:
                for context_index, context in enumerate(contexts):
                    context_label = f"{label}.derived_contexts[{context_index}]"
                    if not isinstance(context, dict):
                        errors.append(f"{context_label} must be an object")
                        continue
                    for field in ("context_id", "path", "status", "default_routed"):
                        if context.get(field) in (None, ""):
                            errors.append(f"{context_label} missing {field}")
                    context_path = context.get("path")
                    if not isinstance(context_path, str) or not (repo / context_path).is_file():
                        errors.append(f"{context_label} references missing path {context_path}")
    if not counts.get("current"):
        errors.append("design history index requires at least one current family")
    result.update({"valid": not errors, "families": len(families) if isinstance(families, list) else 0, "lifecycle_counts": counts})
    return result, errors


def validate_governance_assets(
    repo: Path,
    config_root: Path,
    context_root: Path,
    routing: dict[str, Any],
    metadata_by_path: dict[Path, dict[str, Any]],
) -> tuple[dict[str, Any], list[str]]:
    errors: list[str] = []
    lifecycle_path = config_root / "lifecycle.yaml"
    lifecycle = load_json(lifecycle_path) if lifecycle_path.exists() else {}
    lifecycle_states = lifecycle.get("states", [])
    if set(lifecycle_states) != VALID_STATUSES:
        errors.append(f"lifecycle states must be {sorted(VALID_STATUSES)}")
    transitions = lifecycle.get("transitions", {})
    if not isinstance(transitions, dict) or set(transitions) != VALID_STATUSES:
        errors.append("lifecycle transitions must cover every lifecycle state")
    elif transitions.get("retired") != []:
        errors.append("retired lifecycle state must not transition further")

    project_path = context_root / "project/overview.md"
    project_metadata = metadata_by_path.get(project_path, {})
    project_errors: list[str] = []
    if not project_metadata:
        project_errors.append("missing project overview context")
    else:
        if project_metadata.get("id") != "project-overview" or project_metadata.get("authority") != "derived":
            project_errors.append("project overview must be a derived project-overview context")
        if project_metadata.get("status") != "active":
            project_errors.append("project overview must be active")
        for field in PROJECT_CONTEXT_FIELDS:
            if project_metadata.get(field) in (None, "", []):
                project_errors.append(f"project overview missing {field}")
        if project_path.relative_to(repo).as_posix() in routing.get("default", {}).get("must_read", []):
            project_errors.append("project overview must not be default injected")
    errors.extend(project_errors)

    task_errors: list[str] = []
    template_path = context_root / "tasks/TASK-TEMPLATE.md"
    template_text = read_text(template_path) if template_path.exists() else ""
    for field in TASK_CONTRACT_FIELDS:
        if field not in template_text:
            task_errors.append(f"task template missing {field}")
    active_task_paths = [
        path for path, metadata in metadata_by_path.items()
        if path.parent == context_root / "tasks"
        and path.name not in {"TASK-TEMPLATE.md", "CHECKPOINT-TEMPLATE.md"}
        and metadata.get("status") == "active"
    ]
    if not active_task_paths:
        task_errors.append("at least one active task pack is required")
    for path in active_task_paths:
        text = read_text(path)
        for field in TASK_CONTRACT_FIELDS:
            if field not in text:
                task_errors.append(f"{path.relative_to(repo)} missing {field}")
    errors.extend(task_errors)

    responsibility_path = config_root / "context-responsibility-map.json"
    responsibility_errors: list[str] = []
    if not responsibility_path.exists():
        responsibility_errors.append("missing context responsibility map")
    else:
        responsibility = load_json(responsibility_path)
        layers = responsibility.get("layers")
        if responsibility.get("schema_version") != 1 or not isinstance(layers, dict):
            responsibility_errors.append("context responsibility map has invalid schema")
        elif set(layers) != GOVERNANCE_LAYER_IDS:
            responsibility_errors.append("context responsibility map must cover exactly five responsibility layers")
        else:
            for layer_id, layer in layers.items():
                label = f"responsibility layer {layer_id}"
                if not isinstance(layer, dict):
                    responsibility_errors.append(f"{label} must be an object")
                    continue
                for field in ("status", "locations", "entrypoints", "owner_refs", "authority", "source_links", "validators"):
                    if layer.get(field) in (None, "", []):
                        responsibility_errors.append(f"{label} missing {field}")
                check_repo_paths(repo, layer.get("entrypoints"), f"{label}.entrypoints", responsibility_errors)
                check_repo_paths(repo, layer.get("owner_refs"), f"{label}.owner_refs", responsibility_errors)
                check_repo_paths(repo, layer.get("source_links"), f"{label}.source_links", responsibility_errors)
    errors.extend(responsibility_errors)

    impact_path = config_root / "change-impact.json"
    impact_errors: list[str] = []
    if not impact_path.exists():
        impact_errors.append("missing change-impact manifest")
    else:
        impact = load_json(impact_path)
        rules = impact.get("rules")
        if impact.get("schema_version") != 1 or not isinstance(rules, list) or not rules:
            impact_errors.append("change-impact manifest has invalid schema")
        else:
            ids: set[str] = set()
            for index, rule in enumerate(rules):
                label = f"change-impact rules[{index}]"
                if not isinstance(rule, dict):
                    impact_errors.append(f"{label} must be an object")
                    continue
                required = {"id", "paths", "design_docs", "risk", "owner"}
                optional = {"exclude_paths"}
                if not required <= set(rule) or set(rule) - required - optional:
                    impact_errors.append(f"{label} has unexpected fields")
                    continue
                if not isinstance(rule.get("exclude_paths", []), list):
                    impact_errors.append(f"{label}.exclude_paths must be an array")
                if not isinstance(rule["id"], str) or not rule["id"] or rule["id"] in ids:
                    impact_errors.append(f"{label}.id must be unique")
                else:
                    ids.add(rule["id"])
                check_repo_paths(repo, rule["design_docs"], f"{label}.design_docs", impact_errors)
                if rule["risk"] not in {"normal", "high"}:
                    impact_errors.append(f"{label}.risk must be normal or high")
    errors.extend(impact_errors)

    history_result, history_errors = validate_design_history(repo, config_root / "design-history-index.json")
    errors.extend(history_errors)
    return {
        "errors": errors,
        "lifecycle_states": lifecycle_states,
        "project_context": {"valid": not project_errors},
        "task_contract": {"valid": not task_errors, "active_task_packs": len(active_task_paths)},
        "design_history": history_result,
        "responsibility_map": {"valid": not responsibility_errors},
        "change_impact": {"valid": not impact_errors},
    }, errors


def validate(repo: Path, build_catalog: bool = False) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    context_root = repo / "docs/context"
    config_root = repo / ".agents/context"
    required_files = [
        config_root / "context-routing.yaml",
        config_root / "context-pack.schema.json",
        config_root / "authority-policy.yaml",
        config_root / "lifecycle.yaml",
        config_root / "tool-contracts.yaml",
        config_root / "external-sources.yaml",
        config_root / "route-smoke-cases.json",
        config_root / "context-responsibility-map.json",
        config_root / "design-history-index.json",
        config_root / "change-impact.json",
        context_root / "INDEX.md",
        context_root / "23-rules-matrix.md",
        context_root / ".context/source-map.yaml",
        context_root / "project/overview.md",
    ]
    for path in required_files:
        if not path.exists():
            errors.append(f"missing required file: {path.relative_to(repo)}")

    routing = load_json(required_files[0]) if required_files[0].exists() else {}
    schema = load_json(required_files[1]) if required_files[1].exists() else {}
    domain_packs = routing.get("packs", [])
    supplemental_routes = routing.get("supplemental_routes", [])
    if len(domain_packs) != 5:
        errors.append(f"expected 5 domain packs, found {len(domain_packs)}")
    if len(supplemental_routes) < 4:
        errors.append(f"expected at least 4 supplemental routes, found {len(supplemental_routes)}")

    all_routes = [*domain_packs, *supplemental_routes]
    for route in all_routes:
        route_id = route.get("id", "<missing>")
        for field in ("id", "scope", "triggers", "must_read", "deferred_paths"):
            if not route.get(field):
                errors.append(f"route {route_id} is missing {field}")
        for category in ("must_read", "deferred_paths"):
            for value in route.get(category, []):
                if not (repo / value).exists():
                    errors.append(f"route {route_id} references missing path: {value}")

    documents = context_documents(repo)
    service_context_root = context_root / "project/services"
    oversized_service_contexts = [
        path.relative_to(repo).as_posix()
        for path in documents
        if path.parent == service_context_root and path.stat().st_size > SERVICE_CONTEXT_MAX_BYTES
    ]
    for relative in oversized_service_contexts:
        errors.append(
            f"service context exceeds {SERVICE_CONTEXT_MAX_BYTES} bytes: {relative}; "
            "keep only routing facts and link to the formal source"
        )
    metadata_by_path: dict[Path, dict[str, Any]] = {}
    seen_ids: dict[str, Path] = {}
    for path in documents:
        relative = path.relative_to(repo).as_posix()
        try:
            metadata = parse_frontmatter(read_text(path))
        except ValueError as exc:
            errors.append(f"{relative}: {exc}")
            continue
        metadata_by_path[path] = metadata
        schema_errors = validate_schema(metadata, schema)
        errors.extend(f"{relative}: {message}" for message in schema_errors)
        context_id = metadata.get("id")
        if context_id in seen_ids:
            errors.append(f"duplicate context id {context_id}: {seen_ids[context_id]} and {path}")
        elif context_id:
            seen_ids[context_id] = path
        if metadata.get("status") not in VALID_STATUSES:
            errors.append(f"{relative}: invalid status {metadata.get('status')}")
        sources = metadata.get("source_of_truth", [])
        if isinstance(sources, list):
            for source in sources:
                if not source.startswith(("http://", "https://")) and not (repo / source).exists():
                    errors.append(f"{relative}: missing source_of_truth path {source}")

    rule_text = read_text(context_root / "23-rules-matrix.md") if (context_root / "23-rules-matrix.md").exists() else ""
    rule_numbers = [int(value) for value in re.findall(r"^\|\s*(\d{1,2})\s*\|", rule_text, re.MULTILINE)]
    if rule_numbers != list(range(1, 24)):
        errors.append(f"23-rules matrix must contain rows 1..23; found {rule_numbers}")

    root_agents = repo / "AGENTS.md"
    root_bytes = root_agents.stat().st_size if root_agents.exists() else 0
    if root_bytes > 8192:
        errors.append(f"root AGENTS.md exceeds 8192 bytes: {root_bytes}")
    chains = instruction_chains(repo)
    max_path, max_bytes = max(chains.items(), key=lambda item: item[1], default=(root_agents, root_bytes))
    for path, size in chains.items():
        if size > 16384:
            errors.append(f"instruction chain for {path.relative_to(repo)} exceeds 16384 bytes: {size}")

    markdown_paths = [root_agents, *instruction_files(repo), *documents]
    scanned_markdown = [path for path in dict.fromkeys(markdown_paths) if path.exists()]
    errors.extend(local_link_errors(scanned_markdown))
    secret_errors = secret_literal_errors(scanned_markdown)
    errors.extend(secret_errors)

    expected_catalog = [
        catalog_record(repo, path, metadata_by_path[path])
        for path in documents
        if path in metadata_by_path and not validate_schema(metadata_by_path[path], schema)
    ]
    catalog_path = context_root / ".context/catalog.jsonl"
    if build_catalog:
        catalog_path.parent.mkdir(parents=True, exist_ok=True)
        catalog_path.write_text(
            "".join(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n" for record in expected_catalog),
            encoding="utf-8",
        )
    catalog_records = jsonl_records(catalog_path)
    if catalog_records != expected_catalog:
        errors.append("catalog.jsonl is stale; regenerate it with --build-catalog")

    external_errors, external_count = validate_external_sources(config_root / "external-sources.yaml")
    errors.extend(external_errors)
    route_errors, route_case_count = validate_route_cases(repo, routing)
    errors.extend(route_errors)
    governance, governance_errors = validate_governance_assets(
        repo, config_root, context_root, routing, metadata_by_path,
    )
    errors.extend(governance_errors)

    return {
        "errors": errors,
        "warnings": warnings,
        "governance": governance,
        "summary": {
            "runtime_packs": len(all_routes),
            "domain_packs": len(domain_packs),
            "supplemental_routes": len(supplemental_routes),
            "active_packs": sum(
                metadata.get("status") == "active"
                for path, metadata in metadata_by_path.items()
                if path.parent == context_root / "domains"
            ),
            "rule_rows": len(rule_numbers),
            "root_agents_bytes": root_bytes,
            "instruction_files_scanned": len(chains),
            "instruction_chain_max_bytes": max_bytes,
            "instruction_chain_max_path": max_path.relative_to(repo).as_posix() if max_path.exists() else "AGENTS.md",
            "context_documents": len(documents),
            "service_context_max_bytes": SERVICE_CONTEXT_MAX_BYTES,
            "oversized_service_contexts": oversized_service_contexts,
            "schema_validated_documents": sum(
                not validate_schema(metadata, schema) for metadata in metadata_by_path.values()
            ),
            "catalog_records": len(catalog_records),
            "external_sources": external_count,
            "external_sources_complete": not external_errors and external_count > 0,
            "route_smoke_cases": route_case_count,
            "route_smoke_failures": len(route_errors),
            "secret_scan_files": len(scanned_markdown),
            "secret_literal_findings": len(secret_errors),
        },
    }


def render_markdown(result: dict[str, Any]) -> str:
    summary = result["summary"]
    lines = ["# Repository Context Validation", "", "| Item | Value |", "|---|---:|"]
    for key, value in summary.items():
        lines.append(f"| {key.replace('_', ' ').title()} | {value} |")
    lines.append("")
    if result["errors"]:
        lines.extend(["## Errors", "", *(f"- {error}" for error in result["errors"])])
    if result["warnings"]:
        lines.extend(["", "## Warnings", "", *(f"- {warning}" for warning in result["warnings"])])
    if not result["errors"] and not result["warnings"]:
        lines.append("All context contracts pass.")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--format", choices=("json", "markdown"), default="markdown")
    parser.add_argument("--route", help="resolve a runtime task query")
    parser.add_argument("--build-catalog", action="store_true")
    args = parser.parse_args()
    repo = args.repo.resolve()

    if args.route:
        routing = load_json(repo / ".agents/context/context-routing.yaml")
        routes = route_packs(args.route, routing)
        payload = {
            "route": {
                "query": args.route,
                "pack_ids": [route["id"] for route in routes],
                "must_read": unique(
                    routing["default"]["must_read"] + [value for route in routes for value in route["must_read"]]
                ),
                "deferred_paths": unique([value for route in routes for value in route["deferred_paths"]]),
                "reason": [route["scope"] for route in routes]
                if routes
                else ["no route matched; perform a bounded exact search and record the failed query"],
                "matches": {route["id"]: route["match"] for route in routes},
            }
        }
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    try:
        result = validate(repo, build_catalog=args.build_catalog)
    except (OSError, ValueError) as exc:
        result = {"errors": [str(exc)], "warnings": [], "summary": {}}
    print(
        json.dumps(result, ensure_ascii=False, indent=2)
        if args.format == "json"
        else render_markdown(result),
        end="\n" if args.format == "json" else "",
    )
    return 1 if result["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
