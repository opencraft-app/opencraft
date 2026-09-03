from __future__ import annotations

import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
VALIDATOR = REPO_ROOT / ".agents/context/scripts/validate_documentation.py"

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

DOMAIN_DOCS = {
    "identity-access",
    "subscription-entitlements",
    "agent-gateway-runtime",
    "site-environment-routing",
    "release-gitops",
}

JOURNEY_DOCS = {
    "account-to-agent",
    "subscription-purchase-renewal",
    "agent-request-streaming",
    "dual-site-request-routing",
    "source-to-production",
}

ARCHITECTURE_DOCS = {
    "system-overview",
    "service-topology",
    "authority-and-contracts",
}


def load_validator_module():
    if not VALIDATOR.exists():
        raise AssertionError(f"documentation validator is missing: {VALIDATOR}")
    spec = importlib.util.spec_from_file_location("validate_documentation", VALIDATOR)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_validator(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["python3", str(VALIDATOR), "--repo", str(REPO_ROOT), *args],
        check=False,
        capture_output=True,
        text=True,
    )


class DocumentationSystemContract(unittest.TestCase):
    def test_repository_documentation_validator_passes(self) -> None:
        result = run_validator("--format", "json")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["errors"], [])
        self.assertEqual(payload["summary"]["service_records"], 23)
        self.assertEqual(payload["summary"]["service_entry_coverage"], 1.0)
        self.assertEqual(payload["summary"]["service_documentation_contract_coverage"], 1.0)
        self.assertEqual(payload["summary"]["context_derived_coverage"], 1.0)
        self.assertEqual(payload["summary"]["broken_first_party_links"], 0)

    def test_service_catalog_covers_every_primary_service(self) -> None:
        validator = load_validator_module()
        result = validator.validate_repository(REPO_ROOT)
        records = result["service_records"]

        self.assertEqual(set(records), set(PRIMARY_SERVICES))
        self.assertEqual(
            {service_id: record["path"] for service_id, record in records.items()},
            PRIMARY_SERVICES,
        )
        for service_id, service_path in PRIMARY_SERVICES.items():
            root = REPO_ROOT / service_path
            with self.subTest(service=service_id):
                self.assertTrue((root / validator.catalog_filename(service_id)).is_file())
                self.assertTrue((root / "README.md").is_file())
                self.assertTrue((root / "AGENTS.md").is_file())
                self.assertTrue((root / "docs/README.md").is_file())

    def test_service_documentation_entries_are_not_placeholders(self) -> None:
        validator = load_validator_module()
        result = validator.validate_repository(REPO_ROOT)

        self.assertEqual(result["service_documentation"]["invalid"], [])
        self.assertEqual(result["summary"]["service_documentation_contract_coverage"], 1.0)

    def test_cross_service_engineering_hierarchy_is_complete(self) -> None:
        engineering = REPO_ROOT / "docs/engineering"
        self.assertTrue((engineering / "README.md").is_file())
        self.assertEqual(
            {path.stem for path in (engineering / "architecture").glob("*.md")},
            ARCHITECTURE_DOCS,
        )
        self.assertEqual(
            {path.stem for path in (engineering / "domains").glob("*.md")},
            DOMAIN_DOCS,
        )
        self.assertEqual(
            {path.stem for path in (engineering / "journeys").glob("*.md")},
            JOURNEY_DOCS,
        )
        for relative_path in (
            "catalog/owners.yaml",
            "catalog/services.yaml",
            "platform/README.md",
            "operations/README.md",
            "governance/documentation-policy.md",
            "governance/documentation-map.yaml",
            "decisions/ADR-0001-documentation-architecture.md",
        ):
            with self.subTest(path=relative_path):
                self.assertTrue((engineering / relative_path).is_file())

    def test_domain_context_is_derived_from_canonical_engineering_docs(self) -> None:
        validator = load_validator_module()
        result = validator.validate_repository(REPO_ROOT)

        self.assertEqual(result["context_derived"]["missing"], [])
        self.assertEqual(result["context_derived"]["invalid"], [])
        for domain_id in DOMAIN_DOCS:
            context_doc = REPO_ROOT / f"docs/context/domains/{domain_id}.md"
            text = context_doc.read_text(encoding="utf-8")
            self.assertIn("authority: derived", text)
            self.assertIn("derived: true", text)
            self.assertIn(f"docs/engineering/domains/{domain_id}.md", text)

    def test_every_primary_service_has_a_routable_derived_context_pack(self) -> None:
        validator = load_validator_module()
        result = validator.validate_repository(REPO_ROOT)

        self.assertIn("service_context", result)
        self.assertEqual(result["service_context"]["missing_packs"], [])
        self.assertEqual(result["service_context"]["invalid_packs"], [])
        self.assertEqual(result["service_context"]["missing_routes"], [])
        self.assertEqual(result["summary"]["service_route_coverage"], 1.0)

    def test_documentation_map_registers_all_roots_and_link_exclusions(self) -> None:
        validator = load_validator_module()
        result = validator.validate_repository(REPO_ROOT)
        documentation_map = result["documentation_map"]

        self.assertEqual(
            set(documentation_map["classes"]),
            {
                "canonical",
                "product",
                "work",
                "generated",
                "context",
                "evaluation",
                "archive",
                "vendor",
                "upstream",
            },
        )
        self.assertEqual(result["links"]["broken"], [])
        self.assertGreaterEqual(len(result["links"]["registered_exclusions"]), 1)

    def test_versioned_evaluation_protocol_links_are_checked(self) -> None:
        validator = load_validator_module()
        documentation_map = validator.load_json_object(
            REPO_ROOT / "docs/engineering/governance/documentation-map.yaml"
        )
        link_check = documentation_map["link_check"]

        self.assertNotIn("docs/context/evaluation", link_check["excluded_roots"])
        with tempfile.TemporaryDirectory() as temp_dir:
            repo = Path(temp_dir)
            evaluation = repo / "docs/context/evaluation"
            evaluation.mkdir(parents=True)
            (evaluation / "protocol.md").write_text(
                "[缺失协议](missing-schema.json)\n", encoding="utf-8"
            )
            (evaluation / "local-report.md").write_text(
                "[本地报告附件](missing-local.json)\n", encoding="utf-8"
            )

            links = validator.validate_links(repo, documentation_map)

        self.assertEqual(
            links["broken"],
            ["docs/context/evaluation/protocol.md: missing-schema.json"],
        )

    def test_lv_docs_skill_tracks_the_indonesian_source_contract(self) -> None:
        skill = (REPO_ROOT / ".agents/skills/product-skills/lv-docs/SKILL.md").read_text(
            encoding="utf-8"
        )
        rules = (
            REPO_ROOT
            / ".agents/skills/product-skills/lv-docs/references/docs-rules.md"
        ).read_text(encoding="utf-8")

        for text in (skill, rules):
            self.assertIn("id-id", text)
            self.assertIn("frontend/src/content/docs/id/<file>", text)
            self.assertIn(".fumadocs-content/docs/id-id/", text)
            self.assertIn("globalDocsForIndonesian", text)
            self.assertIn("-en", text)


if __name__ == "__main__":
    unittest.main()
