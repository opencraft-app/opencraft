import importlib.util
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).with_name("coordinate-noop-release-identity.py")
SPEC = importlib.util.spec_from_file_location("coordinate_noop_release_identity", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


OLD = "a" * 64
OTHER_OLD = "b" * 64
NEW = "c" * 64


def plan(noop, live=OLD, candidate=NEW):
    return {
        "noop": noop,
        "live_identity": live,
        "candidate_identity": candidate,
    }


class CoordinateNoopReleaseIdentityTest(unittest.TestCase):
    def test_preserves_only_a_coherent_noop_pair(self):
        result = MODULE.coordinate(plan(True), plan(True))
        self.assertTrue(result["preserve"])
        self.assertEqual(result["live_identity"], OLD)

    def test_engine_change_rebinds_both_workloads(self):
        result = MODULE.coordinate(plan(False), plan(True))
        self.assertFalse(result["preserve"])
        self.assertIsNone(result["live_identity"])

    def test_runtime_change_rebinds_both_workloads(self):
        result = MODULE.coordinate(plan(True), plan(False))
        self.assertFalse(result["preserve"])

    def test_incoherent_live_pair_is_repaired_by_new_identity(self):
        result = MODULE.coordinate(plan(True), plan(True, live=OTHER_OLD))
        self.assertFalse(result["preserve"])

    def test_incoherent_candidate_pair_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "candidates"):
            MODULE.coordinate(plan(True), plan(True, candidate=OTHER_OLD))


if __name__ == "__main__":
    unittest.main()
