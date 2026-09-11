from __future__ import annotations

import json
import importlib.util
import re
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
VALIDATOR = REPO_ROOT / ".agents/context/scripts/validate_context.py"


def load_validator_module():
    spec = importlib.util.spec_from_file_location("validate_context", VALIDATOR)
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


class RepositoryContextContract(unittest.TestCase):
    def test_validator_accepts_repository_context(self) -> None:
        result = run_validator("--format", "json")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["errors"], [])
        self.assertEqual(payload["summary"]["active_packs"], 5)
        self.assertEqual(payload["summary"]["rule_rows"], 23)
        self.assertLessEqual(payload["summary"]["instruction_chain_max_bytes"], 16384)
        self.assertEqual(
            payload["summary"]["catalog_records"],
            payload["summary"]["context_documents"],
        )
        self.assertGreaterEqual(payload["summary"]["schema_validated_documents"], 20)
        self.assertTrue(payload["summary"]["external_sources_complete"])
        self.assertEqual(payload["summary"]["secret_literal_findings"], 0)

    def test_real_task_routes_include_all_required_packs(self) -> None:
        cases = {
            "实名认证失败 realname verify": {"identity-access"},
            "订阅续费套餐权益 subscription renewal quota": {"subscription-entitlements"},
            "Agent gateway streaming channel model": {"agent-gateway-runtime"},
            "国际站 lightvela.ai domain locale": {"site-environment-routing"},
            "GitOps Argo 发布镜像 promote": {"release-gitops"},
            "国际站未实名用户续费后发布到新加坡生产环境": {
                "identity-access",
                "subscription-entitlements",
                "site-environment-routing",
                "release-gitops",
            },
            "创建 sandbox-bj-8 playground 环境": {
                "site-environment-routing",
                "playground-environment",
            },
            "同步 product skills 到 product-ai": {"product-skill-sync"},
            "TAPD 短 ID 12345678 转完整 ID 并创建 MR": {"tapd-gongfeng-delivery"},
            "velalink 修复导出后更新 frontend 依赖": {"upstream-subtrees"},
            "上下文工程历史设计 docs-impact": {"context-governance"},
        }
        for query, expected_packs in cases.items():
            result = run_validator("--route", query, "--format", "json")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            payload = json.loads(result.stdout)
            self.assertTrue(
                expected_packs.issubset(set(payload["route"]["pack_ids"])),
                f"{query}: {payload['route']}",
            )

    def test_broad_words_do_not_alone_select_runtime_or_subscription_packs(self) -> None:
        cases = {
            "统一 Agent tab 顶部文案风格": {"agent-gateway-runtime"},
            "Agent 人设页国内站与国际站共用": {"agent-gateway-runtime"},
            "billing announcement copy update": {"subscription-entitlements"},
        }
        for query, forbidden_packs in cases.items():
            result = run_validator("--route", query, "--format", "json")
            payload = json.loads(result.stdout)
            self.assertEqual(
                set(payload["route"]["pack_ids"]).isdisjoint(forbidden_packs),
                True,
                f"{query}: {payload['route']['pack_ids']}",
            )

    def test_negated_delivery_terms_do_not_load_release_pack(self) -> None:
        result = run_validator(
            "--route",
            "检查上下文工程；不发布、不部署、不修改 GitOps",
            "--format",
            "json",
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        route = json.loads(result.stdout)["route"]
        self.assertNotIn("release-gitops", route["pack_ids"], route)

    def test_service_specific_queries_select_service_surface_packs(self) -> None:
        cases = {
            "修复国际站 trade Billing 测试域名": {
                "commerce-trade-ops",
                "site-environment-routing",
            },
            "LLMGateway named subscription credits": {
                "control-plane-ops",
                "subscription-entitlements",
            },
            "TAT PTY exec and restrict OAuth registration": {
                "control-plane-ops",
                "identity-access",
            },
            "统一账号与智能体顶部导航": {"frontend-product-surface"},
        }
        for query, expected_packs in cases.items():
            result = run_validator("--route", query, "--format", "json")
            payload = json.loads(result.stdout)
            self.assertTrue(
                expected_packs.issubset(set(payload["route"]["pack_ids"])),
                f"{query}: {payload['route']['pack_ids']}",
            )

    def test_compact_context_loading_contract(self) -> None:
        result = run_validator("--route", "unrelated localized widget", "--format", "json")
        payload = json.loads(result.stdout)
        self.assertEqual(payload["route"]["must_read"], [])

        root_text = (REPO_ROOT / "AGENTS.md").read_text(encoding="utf-8")
        self.assertIn(
            "先运行路由器，再用一条命令只读取路由结果中的 `must_read` 文件和最近的服务级 `AGENTS.md`。",
            root_text,
        )

        index_text = (REPO_ROOT / "docs/context/INDEX.md").read_text(encoding="utf-8")
        self.assertIn("默认不要读取本索引。", index_text)

    def test_service_contexts_stay_within_compact_budget(self) -> None:
        result = run_validator("--format", "json")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        summary = json.loads(result.stdout)["summary"]
        self.assertIn("oversized_service_contexts", summary)
        self.assertEqual(summary["oversized_service_contexts"], [])

    def test_context_route_defers_adjacency_index(self) -> None:
        result = run_validator("--route", "context engineering review", "--format", "json")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        route = json.loads(result.stdout)["route"]

        self.assertIn("docs/context/project/adjacency/README.md", route["deferred_paths"])

    def test_context_governance_assets_are_complete_without_default_injection(self) -> None:
        result = run_validator("--format", "json")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        payload = json.loads(result.stdout)

        self.assertIn("governance", payload)
        governance = payload["governance"]
        self.assertEqual(governance["errors"], [])
        self.assertEqual(
            set(governance["lifecycle_states"]),
            {"candidate", "pilot", "active", "stale", "retired"},
        )
        self.assertTrue(governance["project_context"]["valid"])
        self.assertTrue(governance["task_contract"]["valid"])
        self.assertTrue(governance["design_history"]["valid"])
        self.assertTrue(governance["responsibility_map"]["valid"])
        self.assertTrue(governance["change_impact"]["valid"])

        unrelated = run_validator("--route", "unrelated localized widget", "--format", "json")
        route = json.loads(unrelated.stdout)["route"]
        self.assertNotIn("docs/context/project/overview.md", route["must_read"])

    def test_docs_impact_requires_the_mapped_design_document(self) -> None:
        script = REPO_ROOT / ".agents/context/scripts/validate_change_impact.py"
        missing_design_doc = subprocess.run(
            [
                "python3", str(script), "--repo", str(REPO_ROOT),
                "--changed-file", "user/auth/internal/session/service.go",
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(missing_design_doc.returncode, 1)
        self.assertIn("必须同步更新以下正式设计文档", missing_design_doc.stderr)

        covered_change = subprocess.run(
            [
                "python3", str(script), "--repo", str(REPO_ROOT),
                "--changed-file", "user/auth/internal/session/service.go",
                "--changed-file", "docs/engineering/domains/identity-access.md",
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(covered_change.returncode, 0, covered_change.stdout + covered_change.stderr)
        self.assertIn("docs-impact: passed", covered_change.stdout)

    def _run_impact(self, *changed: str) -> subprocess.CompletedProcess[str]:
        script = REPO_ROOT / ".agents/context/scripts/validate_change_impact.py"
        command = ["python3", str(script), "--repo", str(REPO_ROOT)]
        for path in changed:
            command.extend(["--changed-file", path])
        return subprocess.run(command, check=False, capture_output=True, text=True)

    def test_docs_impact_excludes_surfaces_without_architectural_meaning(self) -> None:
        """A responsibility root also covers copy, locales, assets and tests.

        Those carry no architectural meaning, so they must not demand a design
        document update.  This mirrors a real false positive on a changelog MR.
        """
        marketing_only = self._run_impact(
            "frontend/src/pages/marketing/changelog-page.tsx",
            "frontend/src/i18n/generated/zh-CN.json",
            "frontend/public/assets/changelog/instance-storage-zh.png",
            "frontend/src/pages/marketing/__tests__/global-changelog.test.tsx",
        )
        self.assertEqual(marketing_only.returncode, 0, marketing_only.stderr)
        self.assertEqual(json.loads(marketing_only.stdout.splitlines()[-1])["matched_rules"], [])

        tests_only = self._run_impact("user/auth/internal/session/service_test.go")
        self.assertEqual(tests_only.returncode, 0, tests_only.stderr)
        self.assertEqual(json.loads(tests_only.stdout.splitlines()[-1])["matched_rules"], [])

    def test_docs_impact_blocks_high_risk_and_only_advises_normal_risk(self) -> None:
        """``risk`` must decide guard strength, per ADR-0002.

        A high-risk surface may not move without its formal design document.  A
        normal-risk surface only reminds, so a coarse root cannot force authors to
        edit unrelated architecture documents just to pass the guard.
        """
        normal_risk = self._run_impact("frontend/src/config/environment.ts")
        self.assertEqual(normal_risk.returncode, 0, normal_risk.stderr)
        self.assertIn("risk=normal，不阻断", normal_risk.stdout)
        payload = json.loads(normal_risk.stdout.splitlines()[-1])
        self.assertIn("site-environment-routing", payload["advisory_rules"])

        high_risk = self._run_impact("argocd/apps/testing/kustomization.yaml")
        self.assertEqual(high_risk.returncode, 1, high_risk.stdout)
        self.assertIn("release-gitops", high_risk.stderr)

    def test_docs_impact_manifest_rejects_unknown_rule_fields(self) -> None:
        manifest = json.loads(
            (REPO_ROOT / ".agents/context/change-impact.json").read_text(encoding="utf-8")
        )
        manifest["rules"][0]["surprise_field"] = ["x"]
        with tempfile.TemporaryDirectory() as raw_dir:
            bad_manifest = Path(raw_dir) / "change-impact.json"
            bad_manifest.write_text(json.dumps(manifest), encoding="utf-8")
            script = REPO_ROOT / ".agents/context/scripts/validate_change_impact.py"
            result = subprocess.run(
                [
                    "python3", str(script), "--repo", str(REPO_ROOT),
                    "--manifest", str(bad_manifest),
                    "--changed-file", "user/auth/internal/session/service.go",
                ],
                check=False,
                capture_output=True,
                text=True,
            )
        self.assertEqual(result.returncode, 2, result.stdout)
        self.assertIn("未知字段", result.stderr)

    def test_human_facing_context_docs_are_chinese_first(self) -> None:
        documents = []
        documents.extend(
            path
            for path in REPO_ROOT.rglob("AGENTS.md")
            if not {".git", "node_modules"}.intersection(path.parts)
        )
        documents.extend(REPO_ROOT.glob("docs/context/**/*.md"))
        documents.extend(REPO_ROOT.glob(".agents/skills/context-audit/**/*.md"))

        failures: list[str] = []
        for path in sorted(set(documents)):
            if not path.is_file():
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
            text = re.sub(r"\A---\n.*?\n---\n", "", text, flags=re.DOTALL)
            text = re.sub(r"```.*?```", "", text, flags=re.DOTALL)
            for paragraph in re.split(r"\n\s*\n", text):
                human_text = re.sub(r"`[^`]+`", "", paragraph)
                human_text = re.sub(r"https?://\S+", "", human_text)
                human_text = re.sub(r"\[[^\]]+\]\([^\)]+\)", "", human_text)
                chinese_chars = len(re.findall(r"[\u4e00-\u9fff]", human_text))
                english_words = len(re.findall(r"[A-Za-z]{2,}", human_text))
                if english_words >= 12 and chinese_chars == 0:
                    preview = re.sub(r"\s+", " ", human_text).strip()[:120]
                    failures.append(
                        f"{path.relative_to(REPO_ROOT)}: "
                        f"英文词 {english_words}，段落 {preview!r}"
                    )
                    break

        self.assertEqual(
            failures,
            [],
            "以下人读 Context 文档仍以英文为主：\n" + "\n".join(failures),
        )

    def test_machine_contract_human_descriptions_are_chinese_first(self) -> None:
        contract_files = [
            ".agents/context/authority-policy.yaml",
            ".agents/context/context-pack.schema.json",
            ".agents/context/context-routing.yaml",
            ".agents/context/external-sources.yaml",
            ".agents/context/lifecycle.yaml",
            ".agents/context/tool-contracts.yaml",
        ]
        human_keys = {
            "authority",
            "conflict_rule",
            "description",
            "failure_policy",
            "input",
            "pilot_only",
            "priority",
            "purpose",
            "repository_boundary",
            "requirements",
            "rule",
            "scope",
            "side_effects",
            "title",
            "unavailable_policy",
            "use_for",
            "version_policy",
        }

        failures: list[str] = []

        def inspect_value(path: str, value: object) -> None:
            if isinstance(value, str):
                chinese_chars = len(re.findall(r"[\u4e00-\u9fff]", value))
                english_words = len(re.findall(r"[A-Za-z]{2,}", value))
                if english_words >= 4 and chinese_chars < english_words:
                    failures.append(
                        f"{path}: 中文字符 {chinese_chars}，英文词 {english_words}"
                    )
            elif isinstance(value, list):
                for index, item in enumerate(value):
                    inspect_value(f"{path}[{index}]", item)

        def walk(path: str, value: object) -> None:
            if isinstance(value, dict):
                for key, item in value.items():
                    child_path = f"{path}.{key}"
                    if key in human_keys:
                        inspect_value(child_path, item)
                    walk(child_path, item)
            elif isinstance(value, list):
                for index, item in enumerate(value):
                    walk(f"{path}[{index}]", item)

        for relative_path in contract_files:
            payload = json.loads((REPO_ROOT / relative_path).read_text(encoding="utf-8"))
            walk(relative_path, payload)

        self.assertEqual(
            failures,
            [],
            "以下机器契约的人读说明仍以英文为主：\n" + "\n".join(failures),
        )

    def test_instruction_chain_includes_all_ancestor_agents_files(self) -> None:
        validator = load_validator_module()
        with tempfile.TemporaryDirectory() as temp_dir:
            repo = Path(temp_dir)
            (repo / "service/web").mkdir(parents=True)
            (repo / "AGENTS.md").write_text("r" * 100, encoding="utf-8")
            (repo / "service/AGENTS.md").write_text("s" * 200, encoding="utf-8")
            (repo / "service/web/AGENTS.md").write_text("w" * 300, encoding="utf-8")

            chains = validator.instruction_chains(repo)

            self.assertEqual(chains[repo / "service/web/AGENTS.md"], 600)

    def test_frontmatter_is_parsed_with_real_yaml_types(self) -> None:
        validator = load_validator_module()
        metadata = validator.parse_frontmatter(
            """---
id: example-pack
triggers:
  - alpha
  - beta
source_of_truth:
  - docs/example.md
derived: false
---
"""
        )

        self.assertEqual(metadata["triggers"], ["alpha", "beta"])
        self.assertEqual(metadata["source_of_truth"], ["docs/example.md"])
        self.assertIs(metadata["derived"], False)

    def test_runtime_context_rejects_literal_credentials(self) -> None:
        validator = load_validator_module()
        with tempfile.TemporaryDirectory() as temp_dir:
            unsafe = Path(temp_dir) / "unsafe.md"
            safe = Path(temp_dir) / "safe.md"
            unsafe.write_text(
                "Web UI password: `not-a-placeholder-value`\n"
                "export CONTROL_TOKEN='0123456789abcdef0123456789abcdef0123456789abcdef'\n",
                encoding="utf-8",
            )
            safe.write_text(
                "Read TKE Secret `runtime`, key `CLUSTER_ADMIN_TOKEN`; never print the value.\n",
                encoding="utf-8",
            )

            errors = validator.secret_literal_errors([unsafe, safe])

            self.assertEqual(len(errors), 2)
            self.assertTrue(all("unsafe.md" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
