#!/usr/bin/env python3
"""Static ordering contract for the post-human Cell admission entry point."""

from pathlib import Path
import unittest


SCRIPT = Path(__file__).with_name("complete-cell-admission.sh")


class CompleteCellAdmissionTests(unittest.TestCase):
    def test_preflight_precedes_first_public_mutation(self):
        source = SCRIPT.read_text()
        preflight = source.index("--preflight-only --output")
        placement = source.index('"$python" "$script_dir/qualify-first-placement.py"')
        final_join = source.index('--placement "$ACTOR_FIRST_PLACEMENT_RECEIPT"')
        self.assertLess(preflight, placement)
        self.assertLess(placement, final_join)

    def test_preflight_is_ephemeral_and_fail_closed(self):
        source = SCRIPT.read_text()
        self.assertIn("mktemp -d /data/tmp/actor-cell-admission-preflight.", source)
        self.assertIn("actor-cell-admission-preflight/v1", source)
        self.assertIn("trap 'rm -rf -- \"$preflight_dir\"' EXIT INT TERM", source)

    def test_preflight_requires_complete_management_desired_state_chain(self):
        source = SCRIPT.read_text()
        for name in (
            "ACTOR_MANAGEMENT_IMAGE_INVENTORY",
            "ACTOR_MANAGEMENT_PLATFORM_RECEIPT",
            "ACTOR_MANAGEMENT_GIT_RECEIPT",
            "ACTOR_MANAGEMENT_DESIRED_RECEIPT",
            "ACTOR_WORKERS_API_IMAGE_INVENTORY",
        ):
            self.assertIn(f': "${{{name}:?', source)
        self.assertIn('--management-platform "$ACTOR_MANAGEMENT_PLATFORM_RECEIPT"', source)
        self.assertIn('--management-images "$ACTOR_MANAGEMENT_IMAGE_INVENTORY"', source)
        self.assertIn('--management-git "$ACTOR_MANAGEMENT_GIT_RECEIPT"', source)
        self.assertIn('--management-desired "$ACTOR_MANAGEMENT_DESIRED_RECEIPT"', source)
        self.assertIn('--workers-api-images "$ACTOR_WORKERS_API_IMAGE_INVENTORY"', source)

    def test_preflight_requires_reviewed_pre_activation_chain(self):
        source = SCRIPT.read_text()
        self.assertIn(': "${ACTOR_CELL_QUALIFICATION_CHAIN_RECEIPT:?', source)
        self.assertIn('--qualification-chain "$ACTOR_CELL_QUALIFICATION_CHAIN_RECEIPT"', source)
        self.assertIn(': "${ACTOR_CELL_ADOPTION_RECEIPT:?', source)
        self.assertIn('--adoption "$ACTOR_CELL_ADOPTION_RECEIPT"', source)

    def test_python_runtime_is_explicit_and_version_gated(self):
        source = SCRIPT.read_text()
        self.assertIn("python=${PYTHON:-python3}", source)
        self.assertIn("sys.version_info >= (3, 10)", source)
        self.assertNotIn('python3 "$script_dir/', source)


if __name__ == "__main__":
    unittest.main()
