import importlib.util
import pathlib
import sys
import tempfile
import unittest


MODULE_PATH = pathlib.Path(__file__).with_name("qualify_fdb_distribution.py")
SPEC = importlib.util.spec_from_file_location("qualify_fdb_distribution", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
distribution = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = distribution
SPEC.loader.exec_module(distribution)


class FdbDistributionTests(unittest.TestCase):
    def test_parses_status_storage_roles_and_distribution(self):
        status = {
            "cluster": {
                "processes": {
                    "p1": {
                        "address": "10.0.0.1:4500",
                        "roles": [
                            {
                                "role": "storage",
                                "id": "s1",
                                "input_bytes": {"hz": 10},
                                "total_queries": {"hz": 20},
                            }
                        ],
                    },
                    "p2": {
                        "address": "10.0.0.2:4500",
                        "roles": [
                            {
                                "role": "storage",
                                "id": "s2",
                                "input_bytes": {"hz": 10},
                                "total_queries": {"hz": 30},
                            }
                        ],
                    },
                }
            }
        }
        storage = distribution.storage_samples(status)
        self.assertEqual(set(storage), {"s1", "s2"})
        summary = distribution.distribution(
            values["input_bytes_hz"] for values in storage.values()
        )
        self.assertEqual(summary["max_share"], 0.5)
        self.assertEqual(summary["coefficient_of_variation"], 0)

    def test_parses_range_owners_and_teams(self):
        output = """
Key range:  - `a'
  10.0.0.1:4500
  10.0.0.2:4500:tls
  10.0.0.3:4500
Key range: `a' - \\xff
  10.0.0.2:4500
  10.0.0.3:4500
  10.0.0.4:4500
"""
        ranges = distribution.parse_locations(output)
        summary = distribution.location_summary(ranges)
        self.assertEqual(summary["ranges"], 2)
        self.assertEqual(summary["storage_servers"], 4)
        self.assertEqual(summary["replica_counts"], {3: 2})
        self.assertEqual(summary["unique_teams"], 2)
        self.assertEqual(summary["range_ownership"]["10.0.0.2:4500"], 2)

    def test_idle_distribution_is_not_evidence(self):
        self.assertIsNone(distribution.distribution([0, 0, 0]))

    def test_location_baseline_is_cell_bound(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary, "baseline.json")
            path.write_text(
                distribution.json.dumps(
                    {
                        "verdict": "baseline",
                        "cell_id": "actor-bj-b01",
                        "location": {
                            "ranges": 2,
                            "range_transcript_sha256": "1" * 64,
                        },
                    }
                )
            )
            baseline = distribution.load_location_baseline(path, "actor-bj-b01")
            self.assertEqual(baseline["ranges"], 2)
            with self.assertRaisesRegex(ValueError, "does not belong"):
                distribution.load_location_baseline(path, "actor-bj-a01")


if __name__ == "__main__":
    unittest.main()
