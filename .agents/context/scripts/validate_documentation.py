#!/usr/bin/env python3
"""Validate the repository-wide LightVela documentation system."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path
from typing import Any
from urllib.parse import unquote


PRIMARY_SERVICES = {
    "ci": ".ci",
    "admin-gateway": "admin-gateway",
    "ai-gateway": "ai-gateway",
    "cloudagent": "cloudagent",
    "cloudladdergateway": "cloudladdergateway",
    "codesign": "codesign",
    "ctl": "ctl",
    "frontend": "frontend",
    "gateway-dashboard": "gateway-dashboard",
    "infra-pulumi": "infra_pulumi",
    "new-api": "new-api",
    "nextgen-dashboard": "nextgen-dashboard",
    "payment": "payment",
    "sandbox": "sandbox",
    "service-gateway": "service-gateway",
    "shadow": "shadow",
    "subscription": "subscription",
    "ticket": "ticket",
    "trade": "trade",
    "user-auth": "user/auth",
    "velagw": "velagw",
    "velalink": "velalink",
    "workers": "workers",
}

# BK-CI treats any file under .ci/**/*.yaml as a pipeline candidate, so the
# `.ci` service catalog record cannot use the `.yaml` extension like every
# other service. `catalog_filename()` centralizes this single exception so
# the rest of the validator, the central catalog, and Context Packs stay in
# sync with the actual on-disk filename per service.
CATALOG_FILENAME_OVERRIDES = {
    "ci": "catalog-info.manifest",
}


def catalog_filename(service_id: str) -> str:
    return CATALOG_FILENAME_OVERRIDES.get(service_id, "catalog-info.yaml")

DOMAIN_DOCS = {
    "identity-access",
    "subscription-entitlements",
    "agent-gateway-runtime",
    "site-environment-routing",
    "release-gitops",
}
ARCHITECTURE_DOCS = {
    "system-overview",
    "service-topology",
    "authority-and-contracts",
}
JOURNEY_DOCS = {
    "account-to-agent",
    "subscription-purchase-renewal",
    "agent-request-streaming",
    "dual-site-request-routing",
    "source-to-production",
}
DOCUMENTATION_CLASSES = {
    "canonical",
    "product",
    "work",
    "generated",
    "context",
    "archive",
    "vendor",
    "upstream",
}
SERVICE_REQUIRED_FIELDS = {
    "id",
    "name",
    "kind",
    "path",
    "owner",
    "lifecycle",
    "domains",
    "summary",
    "runtime",
    "interfaces",
    "dependencies",
    "source_docs",
    "agent_entry",
    "service_docs",
    "deploy",
    "generated_paths",
}
DOC_EXTENSIONS = {".md", ".mdx", ".rst"}
IGNORED_PARTS = {".git", "node_modules", ".worktrees"}
LINK_PATTERN = re.compile(r"!?(?:\[[^\]]*\])\(([^)]+)\)")


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def load_json_object(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise ValueError(f"missing JSON-compatible YAML: {path}")
    try:
        payload = json.loads(read_text(path))
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON-compatible YAML in {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise ValueError(f"{path} must contain an object")
    return payload


def parse_frontmatter(text: str) -> dict[str, Any]:
    match = re.match(r"^---\s*\n(.*?)\n---\s*\n", text, re.DOTALL)
    if not match:
        return {}
    metadata: dict[str, Any] = {}
    current_key: str | None = None
    for line in match.group(1).splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("- ") and current_key:
            if metadata.get(current_key) is None:
                metadata[current_key] = []
            if isinstance(metadata[current_key], list):
                metadata[current_key].append(stripped[2:].strip().strip("\"'"))
            continue
        if line.startswith((" ", "\t")) or ":" not in line:
            continue
        key, value = line.split(":", 1)
        current_key = key.strip()
        value = value.strip()
        if value.startswith("["):
            try:
                metadata[current_key] = json.loads(value)
                continue
            except json.JSONDecodeError:
                pass
        if value in {"true", "false"}:
            metadata[current_key] = value == "true"
        else:
            metadata[current_key] = value.strip("\"'") or None
    return metadata


def markdown_documents(repo: Path) -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=repo,
        check=False,
        capture_output=True,
    )
    if result.returncode == 0:
        paths = []
        for raw_path in result.stdout.decode("utf-8", errors="replace").split("\0"):
            if not raw_path:
                continue
            path = repo / raw_path
            if (
                path.is_file()
                and path.suffix.lower() in DOC_EXTENSIONS
                and not IGNORED_PARTS.intersection(Path(raw_path).parts)
            ):
                paths.append(path)
        return sorted(set(paths))
    return sorted(
        path
        for path in repo.rglob("*")
        if path.is_file()
        and path.suffix.lower() in DOC_EXTENSIONS
        and not IGNORED_PARTS.intersection(path.relative_to(repo).parts)
    )


def glob_matches(relative: str, pattern: str) -> bool:
    parts: list[str] = []
    index = 0
    while index < len(pattern):
        char = pattern[index]
        if char == "*":
            if index + 1 < len(pattern) and pattern[index + 1] == "*":
                index += 2
                if index < len(pattern) and pattern[index] == "/":
                    parts.append("(?:.*/)?")
                    index += 1
                else:
                    parts.append(".*")
                continue
            parts.append("[^/]*")
        elif char == "?":
            parts.append("[^/]")
        else:
            parts.append(re.escape(char))
        index += 1
    return re.fullmatch("".join(parts), relative) is not None


def classify_document(relative: str, rules: list[dict[str, Any]]) -> str | None:
    for rule in rules:
        doc_class = rule.get("class")
        patterns = rule.get("patterns", [])
        if isinstance(doc_class, str) and isinstance(patterns, list):
            if any(isinstance(pattern, str) and glob_matches(relative, pattern) for pattern in patterns):
                return doc_class
    return None


def matches_any(relative: str, patterns: list[Any]) -> bool:
    return any(
        isinstance(pattern, str) and glob_matches(relative, pattern)
        for pattern in patterns
    )


def load_documentation_map(repo: Path, errors: list[str]) -> dict[str, Any]:
    path = repo / "docs/engineering/governance/documentation-map.yaml"
    try:
        payload = load_json_object(path)
    except ValueError as exc:
        errors.append(str(exc))
        return {"classes": {}, "rules": [], "link_check": {}}
    classes = payload.get("classes", {})
    if not isinstance(classes, dict) or set(classes) != DOCUMENTATION_CLASSES:
        errors.append(
            "documentation map classes must be exactly "
            + ", ".join(sorted(DOCUMENTATION_CLASSES))
        )
    rules = payload.get("rules", [])
    if not isinstance(rules, list):
        errors.append("documentation map rules must be an array")
    return payload


def validate_service_catalog(repo: Path, errors: list[str]) -> dict[str, dict[str, Any]]:
    owners_path = repo / "docs/engineering/catalog/owners.yaml"
    services_path = repo / "docs/engineering/catalog/services.yaml"
    try:
        owners_payload = load_json_object(owners_path)
        services_payload = load_json_object(services_path)
    except ValueError as exc:
        errors.append(str(exc))
        return {}

    owners = owners_payload.get("owners", {})
    if not isinstance(owners, dict) or not owners:
        errors.append("owners catalog must contain at least one owner")
        owners = {}
    central_records = services_payload.get("services", [])
    if not isinstance(central_records, list):
        errors.append("services catalog must contain a services array")
        return {}

    central_map: dict[str, dict[str, Any]] = {}
    for record in central_records:
        if not isinstance(record, dict) or not isinstance(record.get("id"), str):
            errors.append("services catalog contains a record without a string id")
            continue
        service_id = record["id"]
        if service_id in central_map:
            errors.append(f"duplicate service id in central catalog: {service_id}")
            continue
        central_map[service_id] = record

    if {service_id: record.get("path") for service_id, record in central_map.items()} != PRIMARY_SERVICES:
        errors.append("central services catalog does not match the 23 primary service paths")

    service_records: dict[str, dict[str, Any]] = {}
    for service_id, service_path in PRIMARY_SERVICES.items():
        root = repo / service_path
        catalog_entry = catalog_filename(service_id)
        entry_files = (catalog_entry, "README.md", "AGENTS.md", "docs/README.md")
        for entry_file in entry_files:
            if not (root / entry_file).is_file():
                errors.append(f"{service_id}: missing {service_path}/{entry_file}")
        catalog_path = root / catalog_entry
        if not catalog_path.exists():
            continue
        try:
            record = load_json_object(catalog_path)
        except ValueError as exc:
            errors.append(str(exc))
            continue
        missing = sorted(SERVICE_REQUIRED_FIELDS - set(record))
        if missing:
            errors.append(f"{service_path}/{catalog_entry} missing fields: {', '.join(missing)}")
        if record.get("id") != service_id or record.get("path") != service_path:
            errors.append(f"{service_path}/{catalog_entry} id/path do not match the central contract")
        if record.get("owner") not in owners:
            errors.append(f"{service_path}/{catalog_entry} references unknown owner {record.get('owner')!r}")
        domains = record.get("domains")
        if not isinstance(domains, list) or not domains or not set(domains).issubset(DOMAIN_DOCS):
            errors.append(f"{service_path}/{catalog_entry} has invalid domains {domains!r}")
        for field in ("interfaces", "dependencies", "source_docs", "deploy", "generated_paths"):
            if not isinstance(record.get(field), list):
                errors.append(f"{service_path}/{catalog_entry} field {field} must be an array")
        if record.get("agent_entry") != f"{service_path}/AGENTS.md":
            errors.append(f"{service_path}/{catalog_entry} has an invalid agent_entry")
        if record.get("service_docs") != f"{service_path}/docs/README.md":
            errors.append(f"{service_path}/{catalog_entry} has an invalid service_docs")
        central = central_map.get(service_id, {})
        expected_catalog = f"{service_path}/{catalog_entry}"
        if central.get("catalog") != expected_catalog:
            errors.append(f"central catalog pointer for {service_id} must be {expected_catalog}")
        service_records[service_id] = record
    return service_records


def validate_service_documentation(repo: Path, errors: list[str]) -> dict[str, list[str]]:
    invalid: list[str] = []
    boundary_headings = (
        "## 关键边界",
        "## 变更边界",
        "## 发布边界",
        "## 核心不变量",
    )
    for service_id, service_path in sorted(PRIMARY_SERVICES.items()):
        path = repo / service_path / "docs/README.md"
        if not path.is_file():
            invalid.append(service_id)
            continue
        text = read_text(path)
        if (
            len(text.encode("utf-8")) < 600
            or not text.startswith("# ")
            or "## 权威入口" not in text
            or "## 验证" not in text
            or not any(heading in text for heading in boundary_headings)
            or re.search(r"\b(?:TBD|TODO)\b|待补", text, re.IGNORECASE)
        ):
            invalid.append(service_id)
    if invalid:
        errors.append(
            "service documentation entries are placeholders or miss authority/boundary/validation sections: "
            + ", ".join(invalid)
        )
    return {"invalid": invalid}


def validate_engineering_hierarchy(repo: Path, errors: list[str]) -> dict[str, int | float]:
    engineering = repo / "docs/engineering"
    required_files = (
        "README.md",
        "platform/README.md",
        "operations/README.md",
        "governance/documentation-policy.md",
        "decisions/ADR-0001-documentation-architecture.md",
    )
    present = 0
    for relative in required_files:
        if (engineering / relative).is_file():
            present += 1
        else:
            errors.append(f"missing engineering document docs/engineering/{relative}")
    expected_by_directory = {
        "architecture": ARCHITECTURE_DOCS,
        "domains": DOMAIN_DOCS,
        "journeys": JOURNEY_DOCS,
    }
    for directory, expected in expected_by_directory.items():
        actual = {path.stem for path in (engineering / directory).glob("*.md")}
        present += len(actual & expected)
        if actual != expected:
            errors.append(
                f"docs/engineering/{directory} must contain {sorted(expected)}; found {sorted(actual)}"
            )
    required = len(required_files) + sum(len(expected) for expected in expected_by_directory.values())
    return {
        "required": required,
        "present": present,
        "coverage": round(present / required, 4),
    }


def validate_context_derivation(repo: Path, errors: list[str]) -> dict[str, list[str]]:
    missing: list[str] = []
    invalid: list[str] = []
    for domain_id in sorted(DOMAIN_DOCS):
        path = repo / f"docs/context/domains/{domain_id}.md"
        if not path.exists():
            missing.append(domain_id)
            continue
        metadata = parse_frontmatter(read_text(path))
        canonical_source = f"docs/engineering/domains/{domain_id}.md"
        sources = metadata.get("source_of_truth", [])
        if (
            metadata.get("authority") != "derived"
            or metadata.get("derived") is not True
            or not isinstance(sources, list)
            or canonical_source not in sources
        ):
            invalid.append(domain_id)
    if missing:
        errors.append(f"missing Context domain packs: {', '.join(missing)}")
    if invalid:
        errors.append(f"Context domain packs are not derived from canonical docs: {', '.join(invalid)}")
    return {"missing": missing, "invalid": invalid}


def validate_service_context(repo: Path, errors: list[str]) -> dict[str, list[str]]:
    missing_packs: list[str] = []
    invalid_packs: list[str] = []
    for service_id, service_path in sorted(PRIMARY_SERVICES.items()):
        path = repo / f"docs/context/project/services/{service_id}.md"
        if not path.exists():
            missing_packs.append(service_id)
            continue
        metadata = parse_frontmatter(read_text(path))
        sources = metadata.get("source_of_truth", [])
        expected_sources = {
            f"{service_path}/docs/README.md",
            f"{service_path}/{catalog_filename(service_id)}",
        }
        if (
            metadata.get("type") != "service"
            or metadata.get("authority") != "derived"
            or metadata.get("derived") is not True
            or not isinstance(sources, list)
            or not expected_sources.issubset(set(sources))
        ):
            invalid_packs.append(service_id)

    missing_routes: list[str] = []
    try:
        routing = load_json_object(repo / ".agents/context/context-routing.yaml")
    except ValueError as exc:
        errors.append(str(exc))
        routing = {}
    route_ids = {
        route.get("id")
        for route in routing.get("supplemental_routes", [])
        if isinstance(route, dict)
    }
    for service_id in sorted(PRIMARY_SERVICES):
        if f"service-{service_id}" not in route_ids:
            missing_routes.append(service_id)

    if missing_packs:
        errors.append(f"missing service Context packs: {', '.join(missing_packs)}")
    if invalid_packs:
        errors.append(f"invalid derived service Context packs: {', '.join(invalid_packs)}")
    if missing_routes:
        errors.append(f"missing service Context routes: {', '.join(missing_routes)}")
    return {
        "missing_packs": missing_packs,
        "invalid_packs": invalid_packs,
        "missing_routes": missing_routes,
    }


def normalize_link_target(raw_target: str) -> str:
    target = raw_target.strip()
    if target.startswith("<") and target.endswith(">"):
        target = target[1:-1]
    if " \"" in target:
        target = target.split(" \"", 1)[0]
    elif " '" in target:
        target = target.split(" '", 1)[0]
    target = target.split("#", 1)[0].split("?", 1)[0]
    return unquote(target)


def validate_links(
    repo: Path,
    documentation_map: dict[str, Any],
) -> dict[str, list[Any]]:
    link_config = documentation_map.get("link_check", {})
    include_patterns = link_config.get("include", []) if isinstance(link_config, dict) else []
    excluded_roots = link_config.get("excluded_roots", []) if isinstance(link_config, dict) else []
    excluded_patterns = link_config.get("excluded_patterns", []) if isinstance(link_config, dict) else []
    excluded_links = link_config.get("excluded_links", []) if isinstance(link_config, dict) else []
    exact_exclusions = {
        (item.get("source"), item.get("target"))
        for item in excluded_links
        if isinstance(item, dict)
    }
    registered_exclusions: list[Any] = [
        {"root": root, "reason": "documentation map excluded root"}
        for root in excluded_roots
        if isinstance(root, str)
    ] + [
        {"pattern": pattern, "reason": "documentation map excluded local output pattern"}
        for pattern in excluded_patterns
        if isinstance(pattern, str)
    ] + [item for item in excluded_links if isinstance(item, dict)]
    broken: list[str] = []
    service_entry_paths = {
        f"{service_path}/{entry}"
        for service_path in PRIMARY_SERVICES.values()
        for entry in ("README.md", "AGENTS.md", "docs/README.md")
    }

    for path in markdown_documents(repo):
        relative = path.relative_to(repo).as_posix()
        if include_patterns and not (
            matches_any(relative, include_patterns) or relative in service_entry_paths
        ):
            continue
        if any(relative == root.rstrip("/") or relative.startswith(root.rstrip("/") + "/") for root in excluded_roots):
            continue
        if matches_any(relative, excluded_patterns):
            continue
        for raw_target in LINK_PATTERN.findall(read_text(path)):
            target = normalize_link_target(raw_target)
            if not target or target.startswith(("http://", "https://", "file://", "mailto:", "tel:", "#", "/")):
                continue
            if target.startswith(("data:", "javascript:")) or "{" in target or "}" in target:
                continue
            if (relative, target) in exact_exclusions:
                continue
            resolved = (path.parent / target).resolve()
            try:
                resolved.relative_to(repo.resolve())
            except ValueError:
                broken.append(f"{relative}: target escapes repository: {target}")
                continue
            if not resolved.exists():
                broken.append(f"{relative}: {target}")
    return {"broken": sorted(set(broken)), "registered_exclusions": registered_exclusions}


def validate_repository(repo: Path) -> dict[str, Any]:
    repo = repo.resolve()
    errors: list[str] = []
    warnings: list[str] = []
    documentation_map = load_documentation_map(repo, errors)
    service_records = validate_service_catalog(repo, errors)
    service_documentation = validate_service_documentation(repo, errors)
    engineering_hierarchy = validate_engineering_hierarchy(repo, errors)
    context_derived = validate_context_derivation(repo, errors)
    service_context = validate_service_context(repo, errors)
    links = validate_links(repo, documentation_map)
    errors.extend(f"broken first-party documentation link: {item}" for item in links["broken"])

    rules = documentation_map.get("rules", []) if isinstance(documentation_map.get("rules"), list) else []
    inventory = {doc_class: 0 for doc_class in DOCUMENTATION_CLASSES}
    unclassified: list[str] = []
    for path in markdown_documents(repo):
        relative = path.relative_to(repo).as_posix()
        doc_class = classify_document(relative, rules)
        if doc_class in inventory:
            inventory[doc_class] += 1
        else:
            unclassified.append(relative)
    if unclassified:
        errors.append(f"unclassified documentation files: {', '.join(unclassified[:20])}")

    complete_entries = sum(
        all(
            (repo / service_path / entry).is_file()
            for entry in (catalog_filename(service_id), "README.md", "AGENTS.md", "docs/README.md")
        )
        for service_id, service_path in PRIMARY_SERVICES.items()
    )
    derived_complete = len(DOMAIN_DOCS) - len(context_derived["missing"]) - len(context_derived["invalid"])
    routed_services = len(PRIMARY_SERVICES) - len(service_context["missing_routes"])
    documented_services = len(PRIMARY_SERVICES) - len(service_documentation["invalid"])
    return {
        "errors": sorted(set(errors)),
        "warnings": warnings,
        "summary": {
            "service_records": len(service_records),
            "service_entry_coverage": round(complete_entries / len(PRIMARY_SERVICES), 4),
            "service_documentation_contract_coverage": round(
                documented_services / len(PRIMARY_SERVICES), 4
            ),
            "context_derived_coverage": round(derived_complete / len(DOMAIN_DOCS), 4),
            "service_route_coverage": round(routed_services / len(PRIMARY_SERVICES), 4),
            "engineering_hierarchy_coverage": engineering_hierarchy["coverage"],
            "broken_first_party_links": len(links["broken"]),
            "documentation_files": sum(inventory.values()),
            "documentation_inventory": inventory,
            "unclassified_documents": len(unclassified),
            "documentation_classes": len(documentation_map.get("classes", {})),
        },
        "service_records": service_records,
        "service_documentation": service_documentation,
        "context_derived": context_derived,
        "service_context": service_context,
        "documentation_map": documentation_map,
        "links": links,
        "unclassified": unclassified,
    }


def render_text(result: dict[str, Any]) -> str:
    summary = result["summary"]
    lines = [
        "# Vela 全仓文档系统校验",
        "",
        f"- 服务目录：{summary['service_records']}/23",
        f"- 服务入口覆盖：{summary['service_entry_coverage']:.1%}",
        f"- 服务文档契约覆盖：{summary['service_documentation_contract_coverage']:.1%}",
        f"- Context 派生覆盖：{summary['context_derived_coverage']:.1%}",
        f"- 文档总数：{summary['documentation_files']}",
        f"- 未分类文档：{summary['unclassified_documents']}",
        f"- 未登记失效链接：{summary['broken_first_party_links']}",
        "",
        "## 错误",
    ]
    lines.extend(f"- {error}" for error in result["errors"])
    if not result["errors"]:
        lines.append("- 无")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--format", choices=("json", "text"), default="text")
    args = parser.parse_args()
    result = validate_repository(args.repo)
    if args.format == "json":
        print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print(render_text(result), end="")
    return 1 if result["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
