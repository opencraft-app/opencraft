import re
import unittest
from pathlib import Path


REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/runtime").is_dir())


class CIGoToolchainTests(unittest.TestCase):
    def test_shared_ci_go_default_matches_infra_pulumi_module(self):
        module = (REPO_ROOT / "infra_pulumi/go.mod").read_text()
        init = (REPO_ROOT / ".ci/init.sh").read_text()
        module_version = re.search(r"(?m)^go ([0-9.]+)$", module)
        ci_default = re.search(r'GO_VERSION_OVERRIDE:-([0-9.]+)', init)
        self.assertIsNotNone(module_version)
        self.assertIsNotNone(ci_default)
        self.assertEqual(ci_default.group(1), module_version.group(1))
        self.assertIn("export GOTOOLCHAIN=local", init)


if __name__ == "__main__":
    unittest.main()
