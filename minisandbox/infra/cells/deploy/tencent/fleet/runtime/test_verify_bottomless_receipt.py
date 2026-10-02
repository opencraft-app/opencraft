import copy
import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("verify_bottomless_receipt.py")
SPEC = importlib.util.spec_from_file_location("verify_bottomless_receipt", MODULE_PATH)
assert SPEC and SPEC.loader
verifier = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verifier)


def valid_receipt():
    actors = 96
    state = {
        "logical_storage_limit_bytes": None,
        "cold_ready": True,
        "counts_exact": True,
    }
    host = {
        "queued_requests": 12,
        "rejected_requests": 0,
        "timed_out_requests": 0,
        "limits": {"max_in_flight": 16, "max_queued": 64, "queue_timeout_ms": 15000},
    }
    return {
        "schema": "actor-bottomless-qualification/v1",
        "cell": "actor-bj-q01",
        "cell_namespace": "actor-fdb-cell-system",
        "verdict": "passed",
        "public_api_only": True,
        "application_api": {
            "path_prefix": "/v1",
            "worker": "q01-bottomless-qualification",
            "class_name": "Agent",
            "version_id": "v_" + "1" * 64,
            "deployment_id": "d_" + "2" * 32,
        },
        "privileged_qualification_interfaces": [
            "engine_object_resolution_and_sleep",
            "depot_checkpoint_and_inspect",
            "host_stats",
        ],
        "qualification_profile": "production",
        "receipt_scope": "production-qualification",
        "actors": actors,
        "concurrency": 96,
        "increments_per_actor": 130,
        "writes": 12480,
        "cleanup_errors": [],
        "actors_retained": False,
        "final_verification_skipped": False,
        "actor_manifest_sha256": "a" * 64,
        "release_binding": {
            "contract": "same_immutable_release_and_pod_set_before_after_qualification",
            "runtime_image": "registry.example/runtime@sha256:" + "b" * 64,
            "runtime_digest": "sha256:" + "b" * 64,
            "manifest_sha256": "c" * 64,
            "engine_desired_replicas": 6,
            "engine_pod_uids": [f"engine-{index}" for index in range(6)],
            "runtime_host_pod_uids": ["host-0", "host-1", "host-2"],
        },
        "online_checkpoint": {
            "passed": True,
            "service_interrupted": False,
            "writes_accepted_after_initial_checkpoint": 12480,
            "continuity_reads": actors,
            "initial": {str(i): {} for i in range(actors)},
            "final": {str(i): {} for i in range(actors)},
            "post_sleep_reclaim": {
                str(i): {"force_reclaim_accepted": True} for i in range(actors)
            },
        },
        "bottomless": {
            "contract": "no_fixed_logical_limit_with_bounded_fdb_write_debt",
            "qualification_actor_count": 1,
            "bytes_per_qualification_actor": 12 * 1024 * 1024,
            "states": {str(i): state for i in range(actors)},
        },
        "logical_quota": {
            "contract": "no_fixed_per_database_logical_byte_quota",
            "required": True,
            "passed": True,
            "states": {
                "0": {
                    "logical_storage_limit_bytes": None,
                    "logical_size_bytes": 13 * 1024 * 1024,
                    "fdb_write_debt_limit_bytes": 12 * 1024 * 1024,
                    "crossed_transient_write_debt_limit": True,
                }
            },
        },
        "cold_read_slo": {
            "required": True,
            "passed": True,
            "thresholds_ms": {"p95": 10000, "p99": 20000, "max": 30000},
            "observed": {"count": actors, "p95_ms": 8000, "p99_ms": 12000, "max_ms": 18000},
        },
        "latency": {"wake_requests": {"count": actors * 2}},
        "recovery_admission": {
            "required": True,
            "passed": True,
            "measurement_window": "synchronized_recovery_wave",
            "requests_per_actor": 2,
            "minimum_queued_hosts": 3,
            "queued_hosts": ["host-0", "host-1", "host-2"],
            "per_host": {f"host-{i}": host for i in range(3)},
        },
        "host_stats": {
            "active_hosts": ["host-0", "host-1", "host-2"],
            "wake_hosts": ["host-0", "host-1", "host-2"],
            "post_cleanup": {
                "host_active_actors": 0,
                "bridge_active_actors": 0,
                "quiescent": True,
            },
        },
    }


class VerifyBottomlessReceiptTests(unittest.TestCase):
    def test_accepts_complete_production_evidence(self):
        result = verifier.verify_receipt(valid_receipt(), "production")
        self.assertTrue(result["claim_eligible"])

    def test_expected_cell_and_namespace_prevent_cross_cell_reuse(self):
        receipt = valid_receipt()
        verifier.verify_receipt(
            receipt,
            "production",
            expected_cell="actor-bj-q01",
            expected_namespace="actor-fdb-cell-system",
        )
        with self.assertRaisesRegex(ValueError, "Cell identity mismatch"):
            verifier.verify_receipt(
                receipt,
                "production",
                expected_cell="actor-bj-k02",
                expected_namespace="actor-fdb-cell-system",
            )

    def test_explicit_worker_identity_allows_isolated_rerun(self):
        receipt = valid_receipt()
        receipt["application_api"]["worker"] = "q01-bottomless-qualification-v2"
        result = verifier.verify_receipt(
            receipt,
            "production",
            expected_worker="q01-bottomless-qualification-v2",
        )
        self.assertTrue(result["verified"])
        with self.assertRaisesRegex(ValueError, "qualification Worker mismatch"):
            verifier.verify_receipt(receipt, "production")

    def test_rejects_development_scope_and_quota_below_write_debt_limit(self):
        receipt = valid_receipt()
        receipt["receipt_scope"] = "development-e2e"
        quota = receipt["logical_quota"]["states"]["0"]
        quota["logical_size_bytes"] = quota["fdb_write_debt_limit_bytes"]
        quota["crossed_transient_write_debt_limit"] = False
        with self.assertRaisesRegex(ValueError, "scope mismatch.*did not cross"):
            verifier.verify_receipt(receipt, "production")

    def test_rejects_legacy_actor_application_data_plane(self):
        receipt = valid_receipt()
        receipt["public_api_only"] = False
        receipt["privileged_qualification_interfaces"].append(
            "legacy_engine_actor_data_plane"
        )
        with self.assertRaisesRegex(ValueError, "public /v1.*legacy Engine Actor"):
            verifier.verify_receipt(receipt, "production")

    def test_rejects_relaxed_slo_and_partial_recovery_storm(self):
        receipt = copy.deepcopy(valid_receipt())
        receipt["cold_read_slo"]["thresholds_ms"]["p95"] = 15000
        receipt["recovery_admission"]["queued_hosts"] = ["host-0"]
        with self.assertRaisesRegex(ValueError, "threshold was relaxed.*fewer than three"):
            verifier.verify_receipt(receipt, "production")

    def test_accepts_three_host_production_cell_evidence_without_ready_claim(self):
        receipt = valid_receipt()
        receipt["qualification_profile"] = "production-cell"
        receipt["receipt_scope"] = "production-cell-qualification"
        receipt["actors"] = 48
        receipt["writes"] = 48 * 130
        receipt["online_checkpoint"]["writes_accepted_after_initial_checkpoint"] = 48 * 130
        receipt["latency"]["wake_requests"]["count"] = 96
        receipt["recovery_admission"]["minimum_queued_hosts"] = 0
        receipt["recovery_admission"]["queued_hosts"] = []
        receipt["online_checkpoint"]["continuity_reads"] = 48
        receipt["online_checkpoint"]["initial"] = {
            str(i): {} for i in range(48)
        }
        receipt["online_checkpoint"]["final"] = {
            str(i): {} for i in range(48)
        }
        receipt["online_checkpoint"]["post_sleep_reclaim"] = {
            str(i): {"force_reclaim_accepted": True} for i in range(48)
        }
        receipt["bottomless"]["states"] = {
            str(i): {
                "logical_storage_limit_bytes": None,
                "cold_ready": True,
                "counts_exact": True,
            }
            for i in range(48)
        }
        receipt["cold_read_slo"]["observed"]["count"] = 48
        result = verifier.verify_receipt(receipt, "production-cell")
        self.assertFalse(result["claim_eligible"])

        receipt["actors"] = 47
        with self.assertRaisesRegex(ValueError, "actor count mismatch"):
            verifier.verify_receipt(receipt, "production-cell")

    def test_accepts_fully_ready_dynamic_production_cell_hosts(self):
        receipt = valid_receipt()
        receipt["qualification_profile"] = "production-cell"
        receipt["receipt_scope"] = "production-cell-qualification"
        receipt["actors"] = 48
        receipt["writes"] = 48 * 130
        receipt["online_checkpoint"]["writes_accepted_after_initial_checkpoint"] = 48 * 130
        receipt["online_checkpoint"]["continuity_reads"] = 48
        receipt["online_checkpoint"]["initial"] = {str(i): {} for i in range(48)}
        receipt["online_checkpoint"]["final"] = {str(i): {} for i in range(48)}
        receipt["online_checkpoint"]["post_sleep_reclaim"] = {
            str(i): {"force_reclaim_accepted": True} for i in range(48)
        }
        receipt["bottomless"]["states"] = {
            str(i): {"logical_storage_limit_bytes": None, "cold_ready": True, "counts_exact": True}
            for i in range(48)
        }
        receipt["cold_read_slo"]["observed"]["count"] = 48
        receipt["latency"]["wake_requests"]["count"] = 96
        receipt["recovery_admission"]["minimum_queued_hosts"] = 0
        receipt["recovery_admission"]["queued_hosts"] = []
        release = receipt["release_binding"]
        release["runtime_capacity_dynamic"] = True
        release["runtime_desired_replicas"] = 7
        release["runtime_ready_replicas"] = 7
        release["runtime_host_pod_uids"] = [f"host-{index}" for index in range(7)]
        verifier.verify_receipt(receipt, "production-cell")

        release["runtime_ready_replicas"] = 6
        with self.assertRaisesRegex(ValueError, "fully Ready"):
            verifier.verify_receipt(receipt, "production-cell")

    def test_rejects_downgraded_production_workload(self):
        receipt = valid_receipt()
        receipt["concurrency"] = 12
        receipt["increments_per_actor"] = 1
        receipt["writes"] = receipt["actors"]
        receipt["bottomless"]["bytes_per_qualification_actor"] = 1024
        with self.assertRaisesRegex(
            ValueError,
            "concurrency mismatch.*increments per Actor mismatch.*write workload count mismatch.*Bottomless payload size mismatch",
        ):
            verifier.verify_receipt(receipt, "production")

    def test_rejects_unversioned_or_ambiguous_privileged_surfaces(self):
        receipt = valid_receipt()
        receipt.pop("schema")
        receipt["privileged_qualification_interfaces"] = []
        with self.assertRaisesRegex(
            ValueError,
            "receipt schema mismatch.*privileged qualification interface inventory mismatch",
        ):
            verifier.verify_receipt(receipt, "production")


if __name__ == "__main__":
    unittest.main()
