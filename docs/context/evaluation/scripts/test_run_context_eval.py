#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
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


if __name__ == "__main__":
    unittest.main()
