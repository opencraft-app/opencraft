import importlib.util
import pathlib
import unittest


MODULE_PATH = pathlib.Path(__file__).with_name("recover-expanded-fdb.py")
SPEC = importlib.util.spec_from_file_location("recover_expanded_fdb", MODULE_PATH)
recovery = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(recovery)


class ExpandedRecoveryTests(unittest.TestCase):
    def test_profile_digest_is_canonical(self):
        left = {"b": 2, "a": {"y": 2, "x": 1}}
        right = {"a": {"x": 1, "y": 2}, "b": 2}
        self.assertEqual(recovery.profile_digest(left), recovery.profile_digest(right))
        self.assertRegex(recovery.profile_digest(left), r"^sha256:[0-9a-f]{64}$")

    def test_healthy_topology_requires_every_owner_to_converge(self):
        value = {
            "fdb": {
                "storageProcesses": 12,
                "generation": 8,
                "reconciledGeneration": 8,
                "available": True,
                "healthy": True,
                "fullReplication": True,
            },
            "machineSet": {"specReplicas": 12, "readyReplicas": 12, "availableReplicas": 12},
        }
        self.assertTrue(recovery.healthy_at(value, 12, 12))
        value["fdb"]["fullReplication"] = False
        self.assertFalse(recovery.healthy_at(value, 12, 12))
        value["fdb"]["fullReplication"] = True
        value["machineSet"]["availableReplicas"] = 11
        self.assertFalse(recovery.healthy_at(value, 12, 12))


if __name__ == "__main__":
    unittest.main()
