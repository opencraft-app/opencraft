#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import tempfile
import threading
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().with_name("run_context_eval.py")


def load_module():
    spec = importlib.util.spec_from_file_location("run_context_eval", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class RunContextEvalTests(unittest.TestCase):
    def test_medium_experiment_uses_separate_results_and_audit_directory(self) -> None:
        module = load_module()

        results_path, run_mode = module.experiment_paths("tool-assisted", "medium", "glm-5.3")

        self.assertEqual(results_path.name, "reasoning-glm-5.3-medium-results.jsonl")
        self.assertEqual(run_mode, "tool-assisted-glm-5.3-medium")

    def test_low_experiment_keeps_existing_results_and_audit_directory(self) -> None:
        module = load_module()

        results_path, run_mode = module.experiment_paths("tool-assisted", "low", "glm-5.3")

        self.assertEqual(results_path, module.RESULTS)
        self.assertEqual(run_mode, "tool-assisted")

    def test_deepseek_medium_uses_model_specific_results(self) -> None:
        module = load_module()

        results_path, run_mode = module.experiment_paths(
            "tool-assisted", "medium", "deepseek-v4-flash-0731"
        )

        self.assertEqual(results_path.name, "reasoning-deepseek-v4-flash-0731-medium-results.jsonl")
        self.assertEqual(run_mode, "tool-assisted-deepseek-v4-flash-0731-medium")

    def test_second_round_two_uses_isolated_results_and_audit_directory(self) -> None:
        module = load_module()

        results_path, run_mode = module.experiment_paths(
            "tool-assisted",
            "low",
            "deepseek-v4-flash-0731",
            run_label="second-round-2",
        )

        self.assertEqual(results_path.name, "second-round-2-deepseek-v4-flash-0731-low-results.jsonl")
        self.assertEqual(run_mode, "second-round-2-deepseek-v4-flash-0731-low")

    def test_v2_context_files_use_current_repository_layout(self) -> None:
        module = load_module()

        paths = {path.relative_to(module.REPO).as_posix() for path in module.allowed_context_files()}

        self.assertIn("AGENTS.md", paths)
        self.assertIn("docs/context/INDEX.md", paths)
        self.assertIn(".agents/context/context-routing.yaml", paths)
        self.assertIn("docs/context/domains/release-gitops.md", paths)
        self.assertIn("docs/engineering/architecture/system-overview.md", paths)
        self.assertIn("docs/engineering/domains/release-gitops.md", paths)
        self.assertIn("frontend/catalog-info.yaml", paths)
        self.assertIn("frontend/docs/README.md", paths)
        self.assertIn(".agents/skills/product-skills/lv-docs/SKILL.md", paths)
        self.assertNotIn("docs/context/README.md", paths)
        self.assertFalse(any(path.startswith("docs/context/evaluation/") for path in paths))
        self.assertFalse(any("__pycache__" in path or path.endswith(".pyc") for path in paths))

    def test_output_schema_requires_plan_contract(self) -> None:
        module = load_module()

        schema = json.loads(module.SCHEMA.read_text(encoding="utf-8"))

        self.assertEqual(schema["type"], "object")
        self.assertEqual(
            set(schema["required"]),
            {"proposed_changed_files", "required_tests", "implementation_approach"},
        )
        self.assertEqual(schema["properties"]["proposed_changed_files"].get("minItems"), 1)

    def test_named_freeze_manifest_is_selected_from_evaluation_directory(self) -> None:
        module = load_module()

        manifest = module.resolve_freeze_manifest("freeze-manifest.zh-v2.json")

        self.assertEqual(manifest, module.EVAL_DIR / "freeze-manifest.zh-v2.json")

    def test_v4_dataset_must_be_named_evaluation_child(self) -> None:
        module = load_module()

        self.assertEqual(
            module.resolve_dataset("candidates-v4-holdout.jsonl"),
            module.EVAL_DIR / "candidates-v4-holdout.jsonl",
        )
        self.assertEqual(
            module.resolve_dataset("candidates-v4-final.jsonl"),
            module.EVAL_DIR / "candidates-v4-final.jsonl",
        )
        with self.assertRaisesRegex(ValueError, "V4 dataset"):
            module.resolve_dataset("candidates.jsonl")
        with self.assertRaisesRegex(ValueError, "V4 dataset"):
            module.resolve_dataset("../candidates-v4-final.jsonl")

    def test_v4_cli_requires_an_explicit_dataset(self) -> None:
        module = load_module()

        with self.assertRaises(SystemExit):
            module.parse_args([])
        args = module.parse_args(["--dataset", "candidates-v4-holdout.jsonl"])

        self.assertEqual(args.dataset, "candidates-v4-holdout.jsonl")

    def test_arm_rejects_any_evaluation_directory(self) -> None:
        module = load_module()

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "docs/context/evaluation").mkdir(parents=True)

            with self.assertRaisesRegex(RuntimeError, "evaluation directory"):
                module.assert_no_evaluation_assets(root)

    def test_freeze_manifest_rejects_directory_traversal(self) -> None:
        module = load_module()

        with self.assertRaisesRegex(ValueError, "freeze manifest must be a file name"):
            module.resolve_freeze_manifest("../freeze-manifest.json")

    def test_selected_freeze_manifest_must_match_current_context_hash(self) -> None:
        module = load_module()

        with tempfile.TemporaryDirectory() as temp:
            manifest = Path(temp) / "freeze-manifest.zh-v2.json"
            manifest.write_text(
                json.dumps({"context_sha256": "expected-hash"}),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(
                RuntimeError,
                "freeze-manifest.zh-v2.json",
            ):
                module.load_matching_freeze_manifest(manifest, "actual-hash")

    def test_codex_command_uses_requested_reasoning_effort(self) -> None:
        module = load_module()

        command = module.codex_command(
            workdir=Path("/tmp/workdir"),
            output_file=Path("/tmp/output.json"),
            model="deepseek-v4-flash-0731",
            reasoning_effort="medium",
        )

        medium_index = command.index("-c")
        self.assertEqual(command[medium_index + 1], "model_reasoning_effort=medium")
        self.assertIn("deepseek-v4-flash-0731", command)

    def test_new_glm_experiment_requires_the_pinned_high_responses_provider(self) -> None:
        module = load_module()
        provider_id = "ccf642d4-1927-4769-a8f7-e2882c488455"

        with self.assertRaisesRegex(ValueError, "--ccswitch-provider is required"):
            module.validate_experiment_provider_selection("glm-5.3", "high", None)
        with self.assertRaisesRegex(ValueError, "pinned CC Switch provider"):
            module.validate_experiment_provider_selection("glm-5.3", "high", "wrong")
        with self.assertRaisesRegex(ValueError, "reasoning effort high"):
            module.validate_experiment_provider_selection("glm-5.3", "low", provider_id)

        self.assertEqual(
            module.validate_experiment_provider_selection("glm-5.3", "high", provider_id),
            provider_id,
        )

    def test_ccswitch_provider_cannot_be_applied_to_another_model(self) -> None:
        module = load_module()

        with self.assertRaisesRegex(ValueError, "only valid for glm-5.3"):
            module.validate_experiment_provider_selection(
                "deepseek-v4-flash-0731",
                "high",
                "ccf642d4-1927-4769-a8f7-e2882c488455",
            )

    def test_control_and_treatment_run_in_parallel(self) -> None:
        module = load_module()
        barrier = threading.Barrier(2, timeout=2)

        def fake_run_codex(
            workdir,
            prompt_file,
            output_file,
            log_file,
            audit_dir,
            arm,
            sample_id,
            model="deepseek-v4-flash-0731",
            reasoning_effort="low",
        ):
            barrier.wait()
            return {
                "plan": {
                    "proposed_changed_files": [str(workdir / f"{arm}.ts")],
                    "required_tests": [],
                    "implementation_approach": arm,
                },
                "tokens_used": 1,
                "tool_calls": 0,
                "wall_time_ms": 1,
            }

        with tempfile.TemporaryDirectory() as temp:
            temp_dir = Path(temp)
            control_dir = temp_dir / "control"
            treatment_dir = temp_dir / "treatment"
            control_dir.mkdir()
            treatment_dir.mkdir()
            prompt_file = temp_dir / "prompt.txt"
            prompt_file.write_text("query", encoding="utf-8")

            control, treatment = module.run_paired_arms(
                control_dir=control_dir,
                treatment_dir=treatment_dir,
                prompt_file=prompt_file,
                control_output=temp_dir / "control.json",
                treatment_output=temp_dir / "treatment.json",
                control_log=temp_dir / "control.log",
                treatment_log=temp_dir / "treatment.log",
                audit_dir=temp_dir / "audit",
                sample_id="sample",
                run_codex_func=fake_run_codex,
            )

        self.assertEqual(control["plan"]["implementation_approach"], "control")
        self.assertEqual(treatment["plan"]["implementation_approach"], "treatment")

    def test_allowed_catalog_pointer_does_not_fail_log_audit(self) -> None:
        module = load_module()
        log_text = 'catalog entry: {"uri":"docs/context/evaluation/README.md"}'
        commands = []

        hits = module.forbidden_log_hits(log_text, commands, "sample")

        self.assertEqual(hits, [])

    def test_evaluation_directory_command_still_fails_log_audit(self) -> None:
        module = load_module()
        log_text = "exec\nrg docs/context/evaluation/\n"
        commands = ["rg docs/context/evaluation/ in /tmp/repo"]

        hits = module.forbidden_log_hits(log_text, commands, "sample")

        self.assertIn("command contains 'docs/context/evaluation/': rg docs/context/evaluation/ in /tmp/repo", hits)

    def test_negated_evaluation_glob_does_not_fail_log_audit(self) -> None:
        module = load_module()
        command = "rg --glob '!docs/context/evaluation/**' query in /tmp/repo"

        hits = module.forbidden_log_hits("", [command], "sample")

        self.assertEqual(hits, [])

    def test_source_code_merge_commit_identifier_does_not_fail_log_audit(self) -> None:
        module = load_module()
        log_text = "test_changed_files_from_merge_commit_uses_first_parent_diff"

        hits = module.forbidden_log_hits(log_text, [], "sample")

        self.assertEqual(hits, [])

    def test_prompt_requires_nonempty_three_to_five_file_plan(self) -> None:
        module = load_module()

        prompt = module.make_prompt("example query", "tool-assisted")

        self.assertIn("`proposed_changed_files` must contain at least one file", prompt)
        self.assertIn("Return the three to five highest-confidence changed files", prompt)
        self.assertIn("Read at most 120 lines per file", prompt)
        self.assertIn("Use `rg --max-count 50`", prompt)

    def test_normalize_plan_rejects_empty_file_plan(self) -> None:
        module = load_module()

        with self.assertRaisesRegex(ValueError, "proposed_changed_files must not be empty"):
            module.normalize_plan(
                {
                    "proposed_changed_files": [],
                    "required_tests": [],
                    "implementation_approach": "",
                }
            )

    def test_treatment_protocol_requires_route_must_read_search_and_neighbor(self) -> None:
        module = load_module()

        evidence = module.validate_treatment_protocol(
            {"must_read": ["docs/context/domains/release-gitops.md"]},
            [
                "python3 .agents/context/scripts/validate_context.py --route deploy",
                "sed -n '1,80p' docs/context/domains/release-gitops.md",
                "rg --max-count 50 image argocd .ci",
                "sed -n '1,120p' docs/context/project/adjacency/argocd-ci-secrets.md",
                "rg --max-count 50 targetRevision argocd/apps",
            ],
        )

        self.assertTrue(evidence["compliant"])
        self.assertEqual(evidence["missing"], [])

    def test_treatment_protocol_rejects_missing_exact_search(self) -> None:
        module = load_module()

        evidence = module.validate_treatment_protocol(
            {"must_read": ["docs/context/domains/release-gitops.md"]},
            [
                "python3 .agents/context/scripts/validate_context.py --route deploy",
                "sed -n '1,80p' docs/context/domains/release-gitops.md",
                "sed -n '1,120p' docs/context/project/adjacency/argocd-ci-secrets.md",
            ],
        )

        self.assertFalse(evidence["compliant"])
        self.assertIn("bounded exact search", evidence["missing"])

    def test_treatment_route_receipt_is_persisted_outside_arm(self) -> None:
        module = load_module()

        with tempfile.TemporaryDirectory() as temp:
            audit_dir = Path(temp) / "audit"
            route = module.capture_treatment_route(
                module.REPO,
                "GitOps Argo 发布镜像 promote",
                audit_dir,
            )
            saved = json.loads((audit_dir / "route.json").read_text(encoding="utf-8"))

        self.assertIn("docs/context/domains/release-gitops.md", route["must_read"])
        self.assertEqual(saved, route)

    def test_treatment_prompt_requires_the_route_then_search_protocol(self) -> None:
        module = load_module()

        prompt = module.make_prompt(
            "GitOps Argo 发布镜像 promote",
            "tool-assisted",
            {"must_read": ["docs/context/domains/release-gitops.md"]},
        )

        self.assertIn("validate_context.py --route", prompt)
        self.assertIn("docs/context/domains/release-gitops.md", prompt)
        self.assertIn("docs/context/project/adjacency/", prompt)

    def test_parse_failure_writes_sanitized_failure_audit(self) -> None:
        module = load_module()

        with tempfile.TemporaryDirectory() as temp:
            audit_dir = Path(temp) / "audit"
            module.write_failure_audit(
                audit_dir,
                "treatment",
                "empty-output",
                "",
                "codex log with raw output that must not be copied",
            )
            payload = json.loads((audit_dir / "treatment-failure.json").read_text(encoding="utf-8"))

        self.assertEqual(payload["failure_class"], "empty-output")
        self.assertIn("log_sha256", payload)
        self.assertNotIn("codex log", json.dumps(payload))


if __name__ == "__main__":
    unittest.main()
