from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[4]
AUDIT = REPO_ROOT / ".agents/skills/context-audit/scripts/audit_context.py"


def write(repo: Path, relative: str, content: str = "# fixture\n") -> Path:
    path = repo / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def run_audit(
    repo: Path, assessment: dict | None = None,
) -> tuple[subprocess.CompletedProcess[str], dict]:
    output_path = repo.parent / f"{repo.name}-audit-result.json"
    command = [
        "python3", str(AUDIT), "--repo", str(repo),
        "--format", "json", "--output", str(output_path),
    ]
    if assessment is not None:
        assessment_path = repo.parent / f"{repo.name}-assessment.json"
        assessment_path.write_text(
            json.dumps(assessment, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        command.extend(("--assessment", str(assessment_path)))
    result = subprocess.run(command, check=False, capture_output=True, text=True)
    if not output_path.is_file():
        raise AssertionError(result.stderr)
    return result, json.loads(output_path.read_text(encoding="utf-8"))


def write_template(repo: Path) -> dict:
    template_path = repo.parent / f"{repo.name}-assessment-template.json"
    result = subprocess.run(
        [
            "python3", str(AUDIT), "--repo", str(repo),
            "--write-template", str(template_path),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0 or not template_path.is_file():
        raise AssertionError(result.stdout + result.stderr)
    return json.loads(template_path.read_text(encoding="utf-8"))


def evidence(
    kind: str, path: str, *, line_start: int | None = None,
    line_end: int | None = None,
) -> dict:
    item = {
        "kind": kind,
        "path": path,
        "statement": f"核查 {path}",
        "proves": "证明该观察项在当前抽样范围内成立。",
        "does_not_prove": "不能外推到未抽样文件或真实模型效果。",
    }
    if line_start is not None:
        item["line_start"] = line_start
        item["line_end"] = line_end if line_end is not None else line_start
    return item


def validator_evidence(path: str, command: list[str], receipt: Path) -> dict:
    return {
        **evidence("validator", path),
        "command": command,
        "receipt": str(receipt.resolve()),
        "receipt_sha256": hashlib.sha256(receipt.read_bytes()).hexdigest(),
    }


def record_check(
    repo: Path, claim_id: str, command: list[str], *, name: str,
    expected_output: str | None = None,
    expect_success: bool = True,
    input_paths: list[str] | None = None,
) -> Path:
    receipt = repo.parent / f"{repo.name}-{name}.json"
    arguments = [
        "python3", str(AUDIT), "--repo", str(repo),
        "--record-check", str(receipt), "--claim", claim_id,
    ]
    for input_path in input_paths or []:
        arguments.extend(("--input", input_path))
    if expected_output is not None:
        arguments.extend(("--expect", expected_output))
    arguments.extend(("--", *command))
    result = subprocess.run(
        arguments,
        check=False,
        capture_output=True,
        text=True,
    )
    if (expect_success and result.returncode != 0) or not receipt.is_file():
        raise AssertionError(result.stdout + result.stderr)
    return receipt


def observation_definitions(repo: Path) -> dict[str, dict[str, list[dict]]]:
    _, result = run_audit(repo)
    return {
        scope: {
            dimension: rationale["observations"]
            for dimension, rationale in dimensions.items()
        }
        for scope, dimensions in result["dimension_rationale"].items()
    }


def build_assessment(
    repo: Path,
    fact_path: str,
    validator_path: str,
    *,
    status: str,
) -> tuple[dict, dict[str, Path]]:
    payload = write_template(repo)
    definitions = observation_definitions(repo)
    payload["repository"]["assessment_scope"] = "fixture repository"
    payload["repository_profile"] = {
        "class": "managed",
        "rationale": "仓库具备按模板核查的上下文与文档治理证据。",
        "tags": ["fixture"],
    }
    payload["actions"] = ["保持证据随仓库演进更新。"]
    receipts: dict[str, Path] = {}
    evidence_line = 1
    for scope, dimensions in payload["dimensions"].items():
        for dimension, entry in dimensions.items():
            metadata = {item["id"]: item for item in definitions[scope][dimension]}
            entry["rationale"] = "成熟度由四个固定观察项推导。"
            for claim_id, observation in entry["observations"].items():
                observation.update({
                    "status": status,
                    "rationale": f"Agent 将 {claim_id} 判断为 {status}。",
                    "subject": fact_path,
                    "limitations": ["仅覆盖测试仓库中的当前抽样。"],
                    "evidence": [evidence(
                        "file", fact_path, line_start=evidence_line,
                    )],
                })
                evidence_line += 1
                if status == "pass" and metadata[claim_id].get("strong"):
                    command = ["python3", validator_path, claim_id]
                    receipt = record_check(
                        repo, claim_id, command,
                        name=hashlib.sha256(claim_id.encode()).hexdigest()[:12],
                        expected_output=claim_id,
                        input_paths=[fact_path],
                    )
                    receipts[claim_id] = receipt
                    observation["evidence"].append(
                        validator_evidence(validator_path, command, receipt)
                    )
    return payload, receipts


def prepare_layout(repo: Path, fact_path: str, validator_path: str) -> None:
    write(
        repo, fact_path,
        "\n".join(
            f"Context contract evidence line {index}"
            for index in range(1, 81)
        ) + "\n",
    )
    write(repo, validator_path, "import sys\nprint(sys.argv[-1])\n")


def strong_claim(
    repo: Path, scope: str, dimension: str,
) -> str:
    return next(
        item["id"]
        for item in observation_definitions(repo)[scope][dimension]
        if item.get("strong")
    )


class GenericRepositoryAuditTests(unittest.TestCase):
    def test_without_assessment_discovers_facts_but_does_not_score(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            write(repo, "README.md")
            _, payload = run_audit(repo)

        self.assertEqual(payload["schema_version"], 3)
        self.assertEqual(payload["assessment_status"], "needs_agent_review")
        self.assertEqual(payload["gate_status"], "not_assessed")
        self.assertIsNone(payload["score"])
        self.assertIsNone(payload["documentation"]["score"])
        self.assertIsNone(payload["repository_profile"]["class"])
        self.assertEqual(payload["evidence_grade"], "Unknown")
        self.assertTrue(payload["evidence_grade_reason"])
        self.assertEqual(payload["receipt_evidence"], [])
        self.assertEqual(payload["git_assessment_evidence"], [])
        self.assertEqual(payload["discovery"]["inventory"]["documents"], ["README.md"])

    def test_complete_assessment_calculates_scores_from_observations(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory) / "repository"
            repo.mkdir()
            prepare_layout(repo, "project/agent-guide.md", "quality/context_check.py")
            assessment, _ = build_assessment(
                repo, "project/agent-guide.md", "quality/context_check.py",
                status="partial",
            )
            result, payload = run_audit(repo, assessment)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(payload["assessment_status"], "complete")
        self.assertEqual(payload["gate_status"], "needs_improvement")
        self.assertEqual(payload["score"], 50)
        self.assertEqual(payload["documentation"]["score"], 50)
        self.assertEqual(set(payload["derived_levels"].values()), {2})

    def test_strong_pass_without_strong_evidence_is_invalid(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory) / "repository"
            repo.mkdir()
            prepare_layout(repo, "guide.md", "checks/verify.py")
            assessment, _ = build_assessment(
                repo, "guide.md", "checks/verify.py", status="partial",
            )
            claim_id = strong_claim(repo, "context_control_plane", "entry_routing")
            observation = assessment["dimensions"]["context_control_plane"]["entry_routing"]["observations"][claim_id]
            observation["status"] = "pass"
            result, payload = run_audit(repo, assessment)

        self.assertEqual(result.returncode, 2)
        self.assertEqual(payload["assessment_status"], "invalid")
        self.assertIsNone(payload["score"])
        self.assertTrue(any(
            "pass requires strong evidence" in error
            for error in payload["assessment_errors"]
        ))

    def test_different_layouts_receive_same_score_from_their_own_evidence(self) -> None:
        layouts = (
            ("handbook/agents/entry.md", "tooling/audit_context.py"),
            ("knowledge-base/runtime/instructions.md", "ci/verify_knowledge.py"),
        )
        payloads = []
        with tempfile.TemporaryDirectory() as directory:
            for index, (fact_path, validator_path) in enumerate(layouts):
                repo = Path(directory) / f"repository-{index}"
                repo.mkdir()
                prepare_layout(repo, fact_path, validator_path)
                assessment, _ = build_assessment(
                    repo, fact_path, validator_path, status="partial",
                )
                _, payload = run_audit(repo, assessment)
                payloads.append(payload)

        self.assertEqual(payloads[0]["score"], 50)
        self.assertEqual(payloads[0]["documentation"]["score"], 50)
        self.assertEqual(payloads[0]["score"], payloads[1]["score"])
        self.assertEqual(
            payloads[0]["documentation"]["score"],
            payloads[1]["documentation"]["score"],
        )
        first_observation = next(iter(
            payloads[0]["dimension_assessments"]["context_control_plane"]["entry_routing"]["observations"].values()
        ))
        second_observation = next(iter(
            payloads[1]["dimension_assessments"]["context_control_plane"]["entry_routing"]["observations"].values()
        ))
        self.assertNotEqual(
            first_observation["evidence"][0]["path"],
            second_observation["evidence"][0]["path"],
        )

    def test_deleted_claim_receipt_invalidates_assessment(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory) / "repository"
            repo.mkdir()
            prepare_layout(repo, "guide.md", "checks/verify.py")
            assessment, receipts = build_assessment(
                repo, "guide.md", "checks/verify.py", status="pass",
            )
            next(iter(receipts.values())).unlink()
            result, payload = run_audit(repo, assessment)

        self.assertEqual(result.returncode, 2)
        self.assertEqual(payload["assessment_status"], "invalid")
        self.assertIsNone(payload["score"])
        self.assertTrue(any(
            ".receipt does not exist" in error
            for error in payload["assessment_errors"]
        ))

    def test_discovers_real_broken_relative_link(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            write(
                repo,
                "handbook/start.md",
                "# Start\n\n[missing contract](../contracts/missing.md)\n",
            )
            _, payload = run_audit(repo)

        links = payload["discovery"]["links"]
        self.assertEqual(links["checked"], 1)
        self.assertEqual(links["broken_count"], 1)
        self.assertEqual(links["broken"][0]["source"], "handbook/start.md")
        self.assertEqual(links["broken"][0]["target"], "../contracts/missing.md")
        self.assertEqual(links["broken"][0]["reason"], "missing")

    def test_git_history_samples_are_results_of_executed_commands(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            write(repo, "AGENTS.md", "# Repository instructions\n")
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            subprocess.run(["git", "-C", str(repo), "add", "AGENTS.md"], check=True)
            subprocess.run(
                [
                    "git", "-C", str(repo), "-c", "user.name=Context Fixture",
                    "-c", "user.email=context@example.invalid", "commit", "-qm",
                    "add repository instructions",
                ],
                check=True,
            )
            expected_head = subprocess.run(
                ["git", "-C", str(repo), "rev-parse", "HEAD"],
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()
            _, payload = run_audit(repo)

        git = payload["git_evidence"]
        self.assertEqual(git["availability"], "full")
        self.assertEqual(git["head"], expected_head)
        self.assertEqual(len(git["history_samples"]), 1)
        self.assertEqual(git["history_samples"][0]["path"], "AGENTS.md")
        self.assertEqual(git["history_samples"][0]["commit"], expected_head)
        self.assertEqual(
            git["history_samples"][0]["subject"], "add repository instructions",
        )
        history_commands = [
            item for item in git["executed_commands"]
            if item["command"][:3] == ["git", "log", "-1"]
        ]
        self.assertEqual(len(history_commands), 1)
        self.assertEqual(history_commands[0]["exit_code"], 0)
        self.assertIn(expected_head, history_commands[0]["stdout"])

    def test_every_dimension_explains_weight_slots_and_evidence_boundary(self) -> None:
        _, payload = run_audit(REPO_ROOT)
        for scope in ("context_control_plane", "repository_documentation"):
            rationales = payload["dimension_rationale"][scope]
            self.assertTrue(rationales)
            for rationale in rationales.values():
                self.assertGreater(rationale["weight"], 0)
                self.assertTrue(rationale["why_evaluate"])
                self.assertTrue(rationale["why_this_weight"])
                self.assertTrue(rationale["proves"])
                self.assertTrue(rationale["does_not_prove"])
                self.assertEqual(len(rationale["observations"]), 4)
                self.assertEqual(
                    rationale["scoring"],
                    "pass=1, partial=0.5, fail=0；任一 unknown 时该维及量表不出分。",
                )


if __name__ == "__main__":
    unittest.main()
