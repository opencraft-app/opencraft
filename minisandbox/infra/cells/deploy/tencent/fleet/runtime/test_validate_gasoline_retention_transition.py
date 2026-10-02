import json
import pathlib
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parent
SCRIPT = ROOT / "validate-gasoline-retention-transition.py"


class RetentionTransitionTest(unittest.TestCase):
    def run_case(self, old_runtime, new_runtime):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as directory:
            root = pathlib.Path(directory)
            old = root / "old.json"
            new = root / "new.json"
            old.write_text(json.dumps({"data": {"config.jsonc": json.dumps({"runtime": old_runtime})}}))
            new.write_text(json.dumps({"runtime": new_runtime}))
            return subprocess.run(
                [str(SCRIPT), str(old), str(new)], text=True, capture_output=True
            )

    def test_equal_and_longer_retention_are_rollback_safe(self):
        for candidate in (900, 1800, 0):
            result = self.run_case(
                {
                    "gasoline_history_prune_eligibility_duration": 900,
                    "gasoline_prune_eligibility_duration": 604800,
                },
                {
                    "gasoline_history_prune_eligibility_duration": candidate,
                    "gasoline_prune_eligibility_duration": 604800,
                },
            )
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_decrease_and_enable_from_disabled_are_rejected(self):
        for previous, candidate in ((900, 899), (0, 900)):
            result = self.run_case(
                {
                    "gasoline_history_prune_eligibility_duration": previous,
                    "gasoline_prune_eligibility_duration": 604800,
                },
                {
                    "gasoline_history_prune_eligibility_duration": candidate,
                    "gasoline_prune_eligibility_duration": 604800,
                },
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("irreversible Gasoline retention decrease rejected", result.stderr)

    def test_omitted_values_use_runtime_defaults(self):
        result = self.run_case({}, {})
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
