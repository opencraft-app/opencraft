import sys
import unittest
from pathlib import Path


REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/runtime").is_dir())
RUNTIME_DIR = REPO_ROOT / ".ci/runtime"

if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from harness_ci.prod_envs import resolve_prod_promote_envs


class ProdEnvTests(unittest.TestCase):
    def test_resolves_only_manual_prod_envs(self) -> None:
        self.assertEqual(
            resolve_prod_promote_envs(
                "beijing-sandbox, shprod, sandbox-bj-7, sgprod",
                "beijing-sandbox",
            ),
            ["shprod", "sgprod"],
        )

    def test_skips_prod_envs_that_are_already_auto_pinned(self) -> None:
        self.assertEqual(
            resolve_prod_promote_envs("beijing-sandbox,shprod,sgprod", "beijing-sandbox, sgprod"),
            ["shprod"],
        )

    def test_none_auto_pin_keeps_prod_envs(self) -> None:
        self.assertEqual(
            resolve_prod_promote_envs("shprod,sgprod", "none"),
            ["shprod", "sgprod"],
        )


if __name__ == "__main__":
    unittest.main()
