import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("strip-update-owned-fields.py")
SPEC = importlib.util.spec_from_file_location("strip_update_owned_fields", MODULE_PATH)
assert SPEC and SPEC.loader
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class StripUpdateOwnedFieldsTests(unittest.TestCase):
    def manifest(self, replicas="7"):
        return f"""apiVersion: apps/v1
kind: Deployment
metadata:
  name: actor-bj-q01-engine
spec:
  replicas: 6
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: actor-bj-q01-runtime-hosts
spec:
  serviceName: actor-bj-q01-runtime-hosts
  replicas: {replicas}
  updateStrategy:
    type: RollingUpdate
  template: {{}}
"""

    def test_only_runtime_replica_field_is_removed(self):
        result = module.strip_runtime_replicas(self.manifest(), "actor-bj-q01")
        self.assertIn("name: actor-bj-q01-engine\nspec:\n  replicas: 6", result)
        runtime = result.split("\n---\n")[1]
        self.assertNotIn("replicas:", runtime)
        self.assertIn("serviceName: actor-bj-q01-runtime-hosts", runtime)

    def test_runtime_strategy_is_released_to_the_serial_rollout_owner(self):
        result = module.strip_runtime_update_owned_fields(self.manifest(), "actor-bj-q01")
        runtime = result.split("\n---\n")[1]
        self.assertNotIn("replicas:", runtime)
        self.assertNotIn("updateStrategy:", runtime)
        self.assertIn("serviceName: actor-bj-q01-runtime-hosts", runtime)

    def test_missing_runtime_strategy_fails_closed(self):
        source = self.manifest().replace(
            "  updateStrategy:\n    type: RollingUpdate\n", ""
        )
        with self.assertRaisesRegex(ValueError, "bootstrap updateStrategy"):
            module.strip_runtime_update_owned_fields(source, "actor-bj-q01")

    def test_missing_or_zero_bootstrap_replica_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "bootstrap replicas"):
            module.strip_runtime_replicas(self.manifest("0"), "actor-bj-q01")

    def test_wrong_cell_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "exactly one runtime StatefulSet"):
            module.strip_runtime_replicas(self.manifest(), "actor-bj-other")


if __name__ == "__main__":
    unittest.main()
