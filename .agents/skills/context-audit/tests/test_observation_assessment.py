from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from test_generic_audit import (
    build_assessment,
    evidence,
    observation_definitions,
    prepare_layout,
    record_check,
    run_audit,
    strong_claim,
    validator_evidence,
    write,
)


def replace_observation(
    payload: dict,
    scope: str,
    dimension: str,
    claim_id: str,
    *,
    status: str,
    fact_path: str,
    evidence_items: list[dict],
) -> None:
    payload["dimensions"][scope][dimension]["observations"][claim_id] = {
        "status": status,
        "rationale": f"Agent 将 {claim_id} 判断为 {status}。",
        "subject": fact_path,
        "evidence": evidence_items,
        "limitations": ["仅覆盖当前测试快照。"],
    }


def init_git(repo: Path) -> str:
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
    subprocess.run(
        [
            "git", "-C", str(repo), "-c", "user.name=Context Fixture",
            "-c", "user.email=context@example.invalid", "commit", "-qm",
            "initial context fixture",
        ],
        check=True,
    )
    return subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def git_item(path: str, commit: str) -> dict:
    return {
        **evidence("git", path, line_start=1, line_end=2),
        "commit": commit,
    }


def owner_review_item(path: str, commit: str, decision: str) -> dict:
    return {
        **evidence("owner_review", path),
        "commit": commit,
        "reviewer": "fixture-owner",
        "decision": decision,
        "reviewed_at": "2026-08-31T00:00:00+00:00",
    }


class ObservationAssessmentIntegrityTests(unittest.TestCase):
    def test_pass_or_partial_file_evidence_requires_line_locator(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory) / "repository"
            repo.mkdir()
            prepare_layout(repo, "context/entry.md", "checks/context.py")
            payload, _ = build_assessment(
                repo, "context/entry.md", "checks/context.py", status="partial",
            )
            observation = next(iter(
                payload["dimensions"]["context_control_plane"]
                ["entry_routing"]["observations"].values()
            ))
            observation["evidence"][0].pop("line_end")
            result, audited = run_audit(repo, payload)

        self.assertEqual(result.returncode, 2)
        self.assertEqual(audited["assessment_status"], "invalid")
        self.assertTrue(any(
            "requires line_start/line_end locator" in error
            for error in audited["assessment_errors"]
        ))

    def test_strong_receipt_must_bind_same_observation_fact_path(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory) / "repository"
            repo.mkdir()
            prepare_layout(repo, "context/entry.md", "checks/context.py")
            claim_id = strong_claim(
                repo, "context_control_plane", "entry_routing",
            )
            command = ["python3", "checks/context.py", claim_id]
            receipt = record_check(
                repo, claim_id, command, name="unbound-fact",
                expected_output=claim_id,
            )
            payload, _ = build_assessment(
                repo, "context/entry.md", "checks/context.py", status="partial",
            )
            replace_observation(
                payload, "context_control_plane", "entry_routing", claim_id,
                status="pass", fact_path="context/entry.md",
                evidence_items=[
                    evidence("file", "context/entry.md", line_start=1, line_end=2),
                    validator_evidence("checks/context.py", command, receipt),
                ],
            )
            result, audited = run_audit(repo, payload)

        self.assertEqual(result.returncode, 2)
        self.assertEqual(audited["assessment_status"], "invalid")
        self.assertTrue(any(
            "must include a file/git evidence path" in error
            for error in audited["assessment_errors"]
        ))

    def test_grade_a_requires_and_reports_verified_evidence_chain(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory) / "repository"
            repo.mkdir()
            prepare_layout(repo, "context/entry.md", "checks/context.py")
            head = init_git(repo)
            payload, _ = build_assessment(
                repo, "context/entry.md", "checks/context.py", status="pass",
            )
            first_observation = next(iter(
                payload["dimensions"]["context_control_plane"]
                ["entry_routing"]["observations"].values()
            ))
            first_observation["evidence"].append(git_item("context/entry.md", head))
            authority_observation = next(iter(
                payload["dimensions"]["context_control_plane"]
                ["authority_and_content"]["observations"].values()
            ))
            authority_observation["evidence"].append(
                owner_review_item("context/entry.md", head, "approved")
            )
            result, audited = run_audit(repo, payload)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(audited["evidence_grade"], "A")
        self.assertIn("Owner/权威复核", audited["evidence_grade_reason"])
        self.assertEqual(len(audited["receipt_evidence"]), 14)
        self.assertEqual(len(audited["git_assessment_evidence"]), 2)
        receipt = audited["receipt_evidence"][0]
        self.assertEqual(receipt["observation_id"], receipt["claim"])
        self.assertEqual(receipt["matched_claim_paths"], ["context/entry.md"])
        self.assertEqual(len(receipt["execution_fingerprint"]), 64)
        self.assertEqual(receipt["exit_code"], 0)
        self.assertTrue(receipt["recorded_at"])
        self.assertTrue(receipt["input_hashes"])
        self.assertEqual(len(receipt["stdout_sha256"]), 64)
        self.assertEqual(len(receipt["stderr_sha256"]), 64)
        git_evidence = audited["git_assessment_evidence"][0]
        self.assertEqual(git_evidence["path"], "context/entry.md")
        self.assertEqual(git_evidence["commit"], head)

    def test_rejected_owner_review_cannot_unlock_grade_a(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory) / "repository"
            repo.mkdir()
            prepare_layout(repo, "context/entry.md", "checks/context.py")
            head = init_git(repo)
            payload, _ = build_assessment(
                repo, "context/entry.md", "checks/context.py", status="pass",
            )
            first_observation = next(iter(
                payload["dimensions"]["context_control_plane"]
                ["entry_routing"]["observations"].values()
            ))
            first_observation["evidence"].append(git_item("context/entry.md", head))
            authority_observation = next(iter(
                payload["dimensions"]["context_control_plane"]
                ["authority_and_content"]["observations"].values()
            ))
            authority_observation["evidence"].append(
                owner_review_item("context/entry.md", head, "rejected")
            )
            result, audited = run_audit(repo, payload)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(audited["evidence_grade"], "B")
        self.assertIn("已定位且批准的 Owner/权威复核", audited["evidence_grade_reason"])

    def test_generic_true_and_echo_receipts_cannot_unlock_strong_pass(self) -> None:
        for index, command in enumerate((["true"], ["echo", "ok"])):
            with self.subTest(command=command), tempfile.TemporaryDirectory() as directory:
                repo = Path(directory) / f"repository-{index}"
                repo.mkdir()
                prepare_layout(repo, "context/entry.md", "checks/context.py")
                claim_id = strong_claim(
                    repo, "context_control_plane", "entry_routing",
                )
                receipt = record_check(
                    repo, claim_id, list(command), name=f"generic-{index}",
                    expect_success=False,
                )
                payload, _ = build_assessment(
                    repo, "context/entry.md", "checks/context.py", status="partial",
                )
                replace_observation(
                    payload,
                    "context_control_plane",
                    "entry_routing",
                    claim_id,
                    status="pass",
                    fact_path="context/entry.md",
                    evidence_items=[
                        validator_evidence("checks/context.py", list(command), receipt),
                    ],
                )
                result, audited = run_audit(repo, payload)

                self.assertEqual(result.returncode, 2)
                self.assertEqual(audited["assessment_status"], "invalid")
                self.assertIsNone(audited["dimensions"]["entry_routing"])
                self.assertTrue(any(
                    "generic/no-input" in error.lower()
                    for error in audited["assessment_errors"]
                ))

    def test_receipt_without_claim_binding_is_invalid(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory) / "repository"
            repo.mkdir()
            prepare_layout(repo, "context/entry.md", "checks/context.py")
            claim_id = strong_claim(repo, "context_control_plane", "entry_routing")
            command = ["python3", "checks/context.py"]
            receipt = record_check(
                repo, claim_id, command, name="missing-claim",
                expected_output="checks/context.py",
            )
            receipt_payload = json.loads(receipt.read_text(encoding="utf-8"))
            receipt_payload.pop("claim_id", None)
            receipt.write_text(
                json.dumps(receipt_payload, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            payload, _ = build_assessment(
                repo, "context/entry.md", "checks/context.py", status="partial",
            )
            replace_observation(
                payload,
                "context_control_plane",
                "entry_routing",
                claim_id,
                status="pass",
                fact_path="context/entry.md",
                evidence_items=[validator_evidence("checks/context.py", command, receipt)],
            )
            result, audited = run_audit(repo, payload)

        self.assertEqual(result.returncode, 2)
        self.assertEqual(audited["assessment_status"], "invalid")
        self.assertTrue(any(
            "claim" in error.lower() for error in audited["assessment_errors"]
        ))

    def test_claim_bound_receipt_cannot_be_reused_across_dimensions(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory) / "repository"
            repo.mkdir()
            prepare_layout(repo, "context/entry.md", "checks/context.py")
            first_claim = strong_claim(
                repo, "context_control_plane", "entry_routing",
            )
            second_claim = strong_claim(
                repo, "context_control_plane", "routing_coverage",
            )
            command = ["python3", "checks/context.py"]
            receipt = record_check(
                repo, first_claim, command, name="single-claim",
                expected_output="checks/context.py",
            )
            shared_evidence = validator_evidence(
                "checks/context.py", command, receipt,
            )
            payload, _ = build_assessment(
                repo, "context/entry.md", "checks/context.py", status="partial",
            )
            replace_observation(
                payload,
                "context_control_plane",
                "entry_routing",
                first_claim,
                status="pass",
                fact_path="context/entry.md",
                evidence_items=[shared_evidence],
            )
            replace_observation(
                payload,
                "context_control_plane",
                "routing_coverage",
                second_claim,
                status="pass",
                fact_path="context/entry.md",
                evidence_items=[shared_evidence],
            )
            result, audited = run_audit(repo, payload)

        self.assertEqual(result.returncode, 2)
        self.assertEqual(audited["assessment_status"], "invalid")
        self.assertTrue(any(
            "claim does not match observation" in error.lower()
            for error in audited["assessment_errors"]
        ))

    def test_same_check_selector_cannot_be_repackaged_for_two_claims(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory) / "repository"
            repo.mkdir()
            prepare_layout(repo, "context/entry.md", "checks/context.py")
            first_claim = strong_claim(
                repo, "context_control_plane", "entry_routing",
            )
            second_claim = strong_claim(
                repo, "context_control_plane", "routing_coverage",
            )
            command = ["python3", "checks/context.py", "shared-selector"]
            first_receipt = record_check(
                repo, first_claim, command, name="selector-first",
                expected_output="shared-selector",
            )
            second_receipt = record_check(
                repo, second_claim, command, name="selector-second",
                expected_output="shared-selector",
            )
            payload, _ = build_assessment(
                repo, "context/entry.md", "checks/context.py", status="partial",
            )
            replace_observation(
                payload, "context_control_plane", "entry_routing", first_claim,
                status="pass", fact_path="context/entry.md",
                evidence_items=[validator_evidence("checks/context.py", command, first_receipt)],
            )
            replace_observation(
                payload, "context_control_plane", "routing_coverage", second_claim,
                status="pass", fact_path="context/entry.md",
                evidence_items=[validator_evidence("checks/context.py", command, second_receipt)],
            )
            result, audited = run_audit(repo, payload)

        self.assertEqual(result.returncode, 2)
        self.assertEqual(audited["assessment_status"], "invalid")
        self.assertTrue(any(
            "reuses the same execution fingerprint" in error.lower()
            for error in audited["assessment_errors"]
        ))

    def test_changed_output_selector_cannot_hide_same_execution_reuse(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory) / "repository"
            repo.mkdir()
            prepare_layout(repo, "context/entry.md", "checks/context.py")
            first_claim = strong_claim(repo, "context_control_plane", "entry_routing")
            second_claim = strong_claim(repo, "context_control_plane", "routing_coverage")
            command = ["python3", "checks/context.py", "alpha-beta"]
            first_receipt = record_check(
                repo, first_claim, command, name="expect-alpha", expected_output="alpha",
            )
            second_receipt = record_check(
                repo, second_claim, command, name="expect-beta", expected_output="beta",
            )
            payload, _ = build_assessment(
                repo, "context/entry.md", "checks/context.py", status="partial",
            )
            replace_observation(
                payload, "context_control_plane", "entry_routing", first_claim,
                status="pass", fact_path="context/entry.md",
                evidence_items=[validator_evidence("checks/context.py", command, first_receipt)],
            )
            replace_observation(
                payload, "context_control_plane", "routing_coverage", second_claim,
                status="pass", fact_path="context/entry.md",
                evidence_items=[validator_evidence("checks/context.py", command, second_receipt)],
            )
            result, audited = run_audit(repo, payload)

        self.assertEqual(result.returncode, 2)
        self.assertTrue(any(
            "reuses the same execution fingerprint" in error.lower()
            for error in audited["assessment_errors"]
        ))

    def test_unmatched_output_assertion_returns_nonzero_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory) / "repository"
            repo.mkdir()
            prepare_layout(repo, "context/entry.md", "checks/context.py")
            claim_id = strong_claim(repo, "context_control_plane", "entry_routing")
            receipt = repo.parent / "unmatched.json"
            result = subprocess.run(
                [
                    "python3", str(Path(__file__).resolve().parents[1] / "scripts/audit_context.py"),
                    "--repo", str(repo), "--record-check", str(receipt),
                    "--claim", claim_id, "--expect", "not-present",
                    "--", "python3", "checks/context.py", "actual-output",
                ],
                check=False, capture_output=True, text=True,
            )
            payload = json.loads(receipt.read_text(encoding="utf-8"))

        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(payload["meaningful_check"])
        self.assertFalse(payload["output_assertion"]["matched"])

    def test_observation_status_derives_score_and_manual_level_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory) / "repository"
            repo.mkdir()
            prepare_layout(repo, "context/entry.md", "checks/context.py")
            derived_payload, _ = build_assessment(
                repo, "context/entry.md", "checks/context.py", status="partial",
            )
            derived_result, derived = run_audit(repo, derived_payload)
            manual_payload, _ = build_assessment(
                repo, "context/entry.md", "checks/context.py", status="fail",
            )
            manual_payload["dimensions"]["context_control_plane"]["entry_routing"]["level"] = 4
            manual_result, manual = run_audit(repo, manual_payload)

        self.assertEqual(derived_result.returncode, 0, derived_result.stderr)
        self.assertEqual(derived["score"], 50)
        self.assertEqual(derived["documentation"]["score"], 50)
        self.assertEqual(derived["dimensions"]["entry_routing"], 7.5)
        self.assertEqual(derived["derived_levels"]["entry_routing"], 2)
        self.assertEqual(manual_result.returncode, 2)
        self.assertEqual(manual["assessment_status"], "invalid")
        self.assertTrue(any(
            "level is derived" in error.lower()
            for error in manual["assessment_errors"]
        ))

    def test_unknown_observation_withholds_dimension_and_both_totals(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory) / "repository"
            repo.mkdir()
            prepare_layout(repo, "context/entry.md", "checks/context.py")
            payload, _ = build_assessment(
                repo, "context/entry.md", "checks/context.py", status="partial",
            )
            claim_id = next(iter(
                payload["dimensions"]["context_control_plane"]["entry_routing"]["observations"]
            ))
            payload["dimensions"]["context_control_plane"]["entry_routing"]["observations"][claim_id] = {
                "status": "unknown", "rationale": "", "subject": "",
                "evidence": [], "limitations": [],
            }
            result, audited = run_audit(repo, payload)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(audited["assessment_status"], "partial")
        self.assertEqual(audited["gate_status"], "not_assessed")
        self.assertIsNone(audited["dimensions"]["entry_routing"])
        self.assertIsNone(audited["score"])
        self.assertEqual(audited["documentation"]["score"], 50)

    def test_malformed_receipt_returns_structured_invalid_result(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory) / "repository"
            repo.mkdir()
            prepare_layout(repo, "context/entry.md", "checks/context.py")
            receipt = repo.parent / "malformed-receipt.json"
            receipt.write_text("{not valid json", encoding="utf-8")
            claim_id = strong_claim(repo, "context_control_plane", "entry_routing")
            command = ["python3", "checks/context.py"]
            payload, _ = build_assessment(
                repo, "context/entry.md", "checks/context.py", status="partial",
            )
            replace_observation(
                payload,
                "context_control_plane",
                "entry_routing",
                claim_id,
                status="pass",
                fact_path="context/entry.md",
                evidence_items=[validator_evidence("checks/context.py", command, receipt)],
            )
            result, audited = run_audit(repo, payload)

        self.assertEqual(result.returncode, 2)
        self.assertEqual(audited["assessment_status"], "invalid")
        self.assertTrue(any(
            "not valid json" in error.lower()
            for error in audited["assessment_errors"]
        ))
        self.assertNotIn("Traceback", result.stderr)

    def test_dirty_entry_change_invalidates_receipt_but_not_fresh_assessment(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory) / "repository"
            repo.mkdir()
            prepare_layout(repo, "context/entry.md", "checks/context.py")
            head = init_git(repo)
            write(
                repo,
                "checks/context.py",
                "# first dirty version\nraise SystemExit(0)\n",
            )
            claim_id = strong_claim(repo, "context_control_plane", "entry_routing")
            command = ["python3", "checks/context.py"]
            receipt = record_check(
                repo, claim_id, command, name="dirty-snapshot",
                expect_success=False,
            )
            write(
                repo,
                "checks/context.py",
                "# second dirty version\nraise SystemExit(0)\n",
            )
            payload, _ = build_assessment(
                repo, "context/entry.md", "checks/context.py", status="partial",
            )
            self.assertEqual(payload["repository"]["head"], head)
            replace_observation(
                payload,
                "context_control_plane",
                "entry_routing",
                claim_id,
                status="pass",
                fact_path="context/entry.md",
                evidence_items=[validator_evidence("checks/context.py", command, receipt)],
            )
            result, audited = run_audit(repo, payload)

        self.assertEqual(result.returncode, 2)
        self.assertEqual(audited["assessment_status"], "invalid")
        self.assertFalse(any(
            "assessment repository worktree fingerprint" in error.lower()
            for error in audited["assessment_errors"]
        ))
        self.assertTrue(any(
            "receipt dirty worktree snapshot is stale" in error.lower()
            or "receipt input file is stale" in error.lower()
            for error in audited["assessment_errors"]
        ))

    def test_template_supplies_four_required_observations_per_dimension(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory) / "repository"
            repo.mkdir()
            prepare_layout(repo, "context/entry.md", "checks/context.py")
            payload, _ = build_assessment(
                repo, "context/entry.md", "checks/context.py", status="partial",
            )
            definitions = observation_definitions(repo)

        for scope, dimensions in payload["dimensions"].items():
            for dimension, entry in dimensions.items():
                expected = {item["id"] for item in definitions[scope][dimension]}
                self.assertEqual(set(entry["observations"]), expected)
                self.assertEqual(len(entry["observations"]), 4)


if __name__ == "__main__":
    unittest.main()
