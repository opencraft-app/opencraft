import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).with_name("autonomy_audit.py")
SPEC = importlib.util.spec_from_file_location("autonomy_audit", MODULE_PATH)
assert SPEC and SPEC.loader
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)
EVALUATOR_PATH = Path(__file__).with_name("evaluate-autonomy-receipt.py")
EVALUATOR_SPEC = importlib.util.spec_from_file_location(
    "evaluate_autonomy_receipt", EVALUATOR_PATH
)
assert EVALUATOR_SPEC and EVALUATOR_SPEC.loader
evaluator = importlib.util.module_from_spec(EVALUATOR_SPEC)
EVALUATOR_SPEC.loader.exec_module(evaluator)


class ClusterIdentityTests(unittest.TestCase):
    def test_cluster_prefix_defaults_to_audited_cell(self):
        self.assertEqual(
            audit.resolve_cluster_prefix(None, "actor-bj-q01"), "actor-bj-q01"
        )

    def test_explicit_distinct_workload_prefix_is_preserved(self):
        self.assertEqual(
            audit.resolve_cluster_prefix("runtime-blue", "actor-bj-q01"),
            "runtime-blue",
        )

    def test_backup_restorable_requires_fresh_successful_exact_collection(self):
        self.assertTrue(audit.derive_backup_restorable(1.0, 1.0))
        self.assertFalse(audit.derive_backup_restorable(0.0, 1.0))
        self.assertFalse(audit.derive_backup_restorable(1.0, 0.0))
        self.assertFalse(audit.derive_backup_restorable(None, 1.0))

    def test_control_decision_preserves_reviewed_source_identity(self):
        source_identity = {
            "revision": "a" * 40,
            "manifest_sha256": "b" * 64,
            "target": "/var/lib/actor-build/deploy/q01-src-{}-{}".format(
                "a" * 40, "b" * 64
            ),
        }
        decision = evaluator.evaluate(
            "/var/lib/actor/autonomy/receipts/audit.json",
            "c" * 64,
            {
                "verdict": "passed",
                "cell": "actor-bj-q01",
                "namespace": "actor-fdb-cell-system",
                "timestamp": "2026-09-06T00:00:00Z",
                "autonomy_score": 100,
                "warnings": [],
                "failures": [],
                "sourceIdentity": source_identity,
            },
            {"policy_version": "test-v1", "rules": []},
        )
        self.assertEqual("allow", decision["control"])
        self.assertEqual(source_identity, decision["sourceIdentity"])
        self.assertEqual("c" * 64, decision["source_receipt_sha256"])


class ProfileBindingTests(unittest.TestCase):
    def snapshot(self, cell_inventory="sha256:" + "1" * 64):
        spec = {
            "driverABI": "rivet-fdb-cos-kubernetes-v1",
            "region": "ap-beijing",
        }
        digest = "sha256:" + hashlib.sha256(
            json.dumps(spec, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        return {
            "rivetCell": {
                "metadata": {"annotations": {
                    "fleet.actor.dev/profile-digest": digest,
                    "fleet.actor.dev/image-inventory-digest": cell_inventory,
                }},
                "spec": {"className": "class", "region": "ap-beijing"},
            },
            "shardClass": {
                "metadata": {"name": "class"},
                "spec": {"profileRef": {"name": "profile", "digest": digest}},
            },
            "rivetCellProfile": {
                "metadata": {
                    "name": "profile",
                    "annotations": {"fleet.actor.dev/image-inventory-digest": "sha256:" + "2" * 64},
                },
                "spec": spec,
            },
        }

    def test_cell_and_promoted_profile_inventory_may_differ(self):
        binding = audit.collect_current_profile_binding(self.snapshot())
        self.assertEqual(binding["imageInventoryDigest"], "sha256:" + "2" * 64)

    def test_cell_inventory_must_still_be_an_exact_digest(self):
        with self.assertRaisesRegex(RuntimeError, "binding is inconsistent"):
            audit.collect_current_profile_binding(self.snapshot("mutable-tag"))


class DynamicRuntimeReleaseBindingTests(unittest.TestCase):
    def test_full_audit_binding_accepts_four_hpa_owned_hosts(self):
        digest = "sha256:" + "a" * 64
        image = "registry.example/runtime@" + digest
        manifest = "b" * 64

        def workload(kind, replicas, names):
            return {
                "kind": kind,
                "metadata": {"generation": 7},
                "spec": {
                    "replicas": replicas,
                    "template": {
                        "metadata": {"annotations": {"fleet.actor.dev/manifest-sha256": manifest}},
                        "spec": {"containers": [{"name": name, "image": image} for name in names]},
                    },
                },
                "status": {"readyReplicas": replicas, "observedGeneration": 7},
            }

        def pod(component, ordinal, names):
            return {
                "metadata": {
                    "uid": f"{component}-{ordinal}",
                    "labels": {"fleet.actor.dev/component": component},
                },
                "spec": {
                    "containers": [{"name": name, "image": image} for name in names]
                },
                "status": {
                    "containerStatuses": [
                        {"name": name, "ready": True, "imageID": "runtime@" + digest}
                        for name in names
                    ]
                },
            }

        snapshot = {
            "engineDeployment": [workload("Deployment", 6, ("engine",))],
            "runtimeHostStatefulSet": [workload("StatefulSet", 4, ("workerd", "workerd-host"))],
            "enginePods": {"items": [pod("engine", i, ("engine",)) for i in range(6)]},
            "runtimeHostPods": {
                "items": [pod("workerd-host", i, ("workerd", "workerd-host")) for i in range(4)]
            },
        }
        runtime_root = MODULE_PATH.parent.parent / "runtime"
        result = audit.collect_current_release_binding(snapshot, runtime_root)
        self.assertTrue(result["runtime_capacity_dynamic"])
        self.assertEqual(result["runtime_desired_replicas"], 4)
        self.assertEqual(len(result["runtime_host_pod_uids"]), 4)


class DisasterRecoveryReceiptSelectionTests(unittest.TestCase):
    def collect(self, dr_directory, qualification_mode="standalone"):
        current_release = {
            "runtime_image": "registry.invalid/runtime@sha256:" + "a" * 64,
            "runtime_digest": "sha256:" + "a" * 64,
            "manifest_sha256": "b" * 64,
        }
        return audit.collect_receipts_for_cell(
            "actor-bj-q01",
            "actor-fdb-cell-system",
            Path(dr_directory) / "runtime",
            Path(dr_directory),
            MODULE_PATH.parent.parent / "runtime",
            24,
            24,
            24,
            current_release,
            "source-fdb-uid",
            qualification_mode=qualification_mode,
        )

    def test_autoscaling_cell_ignores_failed_physical_restore_exercise(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "actor-bj-q01-dr-physical-restore-failed.json"
            path.write_text(json.dumps({"verdict": "failed"}))
            evidence, failures = self.collect(directory, qualification_mode="autoscaling-cell")
        self.assertNotIn("dr_receipt_not_recent_passed", failures)
        self.assertEqual([item.name for item in evidence if item.name == "dr"], [])

    def test_dr_cleanup_receipt_cannot_satisfy_the_restore_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "actor-bj-q01-dr-failed-seed-cleanup-test.json"
            path.write_text(json.dumps({"verdict": "passed"}))
            evidence, failures = self.collect(directory, qualification_mode="autoscaling-cell")
        self.assertNotIn("dr_receipt_missing", failures)
        self.assertEqual([item for item in evidence if item.name == "dr"], [])

    def test_autoscaling_cell_does_not_require_recovery_exercise(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "actor-bj-q01-fdb-expanded-recovery-run.json"
            path.write_text(json.dumps({"verdict": "passed"}))
            evidence, failures = self.collect(directory, qualification_mode="autoscaling-cell")
        self.assertNotIn("dr_receipt_missing", failures)
        self.assertEqual([item for item in evidence if item.name == "dr"], [])

    def test_initial_cell_requires_only_live_runtime_qualification(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence, failures = self.collect(directory, qualification_mode="initial-cell")
        self.assertIn("latest_bottomless_receipt_missing", failures)
        self.assertIn("latest_engine_ha_receipt_missing", failures)
        self.assertNotIn("dr_receipt_missing", failures)
        self.assertNotIn("latest_agent_arrival_receipt_missing", failures)
        self.assertNotIn("latest_fdb_autoscaling_receipt_missing", failures)
        self.assertNotIn("latest_user_transparent_upgrade_receipt_missing", failures)
        self.assertNotIn("latest_semantic_failure_rollback_receipt_missing", failures)


class CompositeQualificationTests(unittest.TestCase):
    def release(self, pod_suffix):
        return {
            "runtime_image": "registry.invalid/runtime@sha256:" + "a" * 64,
            "runtime_digest": "sha256:" + "a" * 64,
            "manifest_sha256": "b" * 64,
            "engine_pod_uids": [f"engine-{pod_suffix}"],
            "runtime_host_pod_uids": [f"runtime-{pod_suffix}"],
        }

    def agent_receipt(self):
        receipt = {
            "schema": "actor-cell-agent-arrival-rate/v1",
            "cell": "actor-bj-q01",
            "namespace": "actor-fdb-cell-system",
            "verdict": "pass",
            "release_binding": self.release("before"),
            "parameters": {
                "actors": 100,
                "prewarm_actors": 80,
                "rate": 100.0,
                "target_actors_per_host": 16,
                "hard_actors_per_host": 32,
                "hpa_tolerance": 0.1,
            },
            "hpa_contract": {
                "average_value": "16",
                "hard_actors_per_host": 32,
                "scale_up_tolerance_ceiling": 0.1,
            },
            "baseline": {"statefulset_spec_replicas": 3, "runtime_nodes": 3},
            "arrival": {
                "requested_rate_per_second": 100.0,
                "scheduled_to_chat_ready_seconds": {"count": 100, "max": 2.9},
            },
            "burst_scaled": {
                "statefulset_ready_replicas": 6,
                "runtime_nodes": 6,
            },
            "scale_down": {
                "baseline": {
                    "statefulset_spec_replicas": 3,
                    "statefulset_ready_replicas": 3,
                    "runtime_nodes": 3,
                },
                "observed_downward_jumps": [1, 1, 1],
            },
            "cleanup": {"deleted_objects": 180},
            "keepalive_failures": [],
            "placement_metrics_delta": {
                "transactions": 180,
                "successful_allocations": 180,
                "unavailable_allocations": 0,
                "no_envoy_allocations": 0,
                "capacity_rejections": 0,
                "allocation_gate_count": 180,
                "allocation_gate_over_one_second": 0,
                "allocation_gate_over_one_second_budget": 18,
                "average_allocation_gate_wait_seconds": 0.0,
                "allocation_amplification": 1.0,
                "over_five_attempts": 0,
                "over_eight_attempts": 0,
                "average_attempts": 1.25,
                "active_actors_by_host": {
                    "runtime-a": 17,
                    "runtime-b": 17,
                    "runtime-c": 17,
                    "runtime-d": 17,
                    "runtime-e": 16,
                    "runtime-f": 16,
                },
            },
        }
        canonical = json.dumps(
            receipt, sort_keys=True, separators=(",", ":")
        ).encode()
        receipt["evidence_sha256"] = hashlib.sha256(canonical).hexdigest()
        return receipt

    def profile_binding(self):
        return {
            "className": "rivet-fdb-cos-kubernetes-v1",
            "profileName": "rivet-fdb-operator-cbs-beijing-v1",
            "profileDigest": "sha256:" + "c" * 64,
            "driverABI": "rivet-fdb-cos-kubernetes-v1",
            "region": "ap-beijing",
            "imageInventoryDigest": "sha256:" + "d" * 64,
        }

    def class_qualification(self):
        certificate = {
            "schema": "actor-cell-class-qualification/v1",
            "verdict": "passed",
            "issuedAt": "2026-09-13T00:00:00Z",
            "scope": self.profile_binding(),
            "qualification": {
                "cell": "actor-bj-b01", "cellUid": "cell-uid",
                "foundationDBUid": "fdb-uid", "runId": "run",
            },
            "evidence": {
                "schema": "actor-fdb-autoscaling-qualification-v4",
                "sha256": "e" * 64,
                "sourceRevision": "f" * 40,
                "sourceManifestSHA256": "a" * 64,
                "loadgenImage": "registry.invalid/loadgen@sha256:" + "b" * 64,
                "scaleOperationUids": {"Up": "up-uid", "Down": "down-uid"},
            },
        }
        canonical = json.dumps(certificate, sort_keys=True, separators=(",", ":")).encode()
        certificate["evidenceSha256"] = hashlib.sha256(canonical).hexdigest()
        return certificate

    def release_qualification_scope(self):
        identity = {
            "schema": "actor-runtime-release-artifact/v1",
            "source": {
                "runtime": {"revision": "1" * 40, "manifestSha256": "2" * 64},
                "control": {"revision": "3" * 40, "manifestSha256": "4" * 64},
            },
            "targetImages": {
                "engine": {"container/engine": self.release("live")["runtime_image"]},
                "runtime": {
                    "container/workerd": self.release("live")["runtime_image"],
                    "container/workerd-host": self.release("live")["runtime_image"],
                    "container/workerd-metrics": "registry.invalid/metrics@sha256:" + "5" * 64,
                    "init/prepare-workerd-config": self.release("live")["runtime_image"],
                },
                "capacity": {"container/controller": "registry.invalid/control@sha256:" + "6" * 64},
                "nats": {"container/nats": "registry.invalid/nats@sha256:" + "7" * 64},
                "reporter": {"container/reporter": "registry.invalid/control@sha256:" + "6" * 64},
            },
        }
        return {
            **identity,
            "artifactDigest": "sha256:" + hashlib.sha256(
                json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest(),
        }

    def release_qualification(self):
        certificate = {
            "schema": "actor-runtime-release-qualification/v1",
            "verdict": "passed",
            "issuedAt": "2026-09-13T00:00:00Z",
            "scope": self.release_qualification_scope(),
            "qualification": {
                "cell": "actor-bj-q01", "cellUid": "canary-uid", "runId": "release-run",
            },
            "evidence": {
                "upgrade": {
                    "schema": "actor-bj-q01-user-transparent-upgrade/v4",
                    "sha256": "8" * 64,
                },
                "semanticRollback": {
                    "schema": "actor-bj-q01-user-transparent-rollback/v2",
                    "sha256": "9" * 64,
                    "failedReceiptSha256": "a" * 64,
                },
            },
        }
        canonical = json.dumps(certificate, sort_keys=True, separators=(",", ":")).encode()
        certificate["evidenceSha256"] = hashlib.sha256(canonical).hexdigest()
        return certificate

    def test_cell_class_qualification_is_reusable_only_for_exact_profile(self):
        certificate = self.class_qualification()
        passed, errors = audit._verify_cell_class_qualification(
            certificate, self.profile_binding()
        )
        self.assertTrue(passed, errors)
        changed = self.profile_binding()
        changed["profileDigest"] = "sha256:" + "0" * 64
        passed, errors = audit._verify_cell_class_qualification(certificate, changed)
        self.assertFalse(passed)
        self.assertIn("Cell-class qualification scope does not match the live profile", errors)

    def test_cell_class_qualification_accepts_v5_raw_evidence(self):
        certificate = self.class_qualification()
        certificate["evidence"]["schema"] = "actor-fdb-autoscaling-qualification-v5"
        certificate.pop("evidenceSha256")
        canonical = json.dumps(certificate, sort_keys=True, separators=(",", ":")).encode()
        certificate["evidenceSha256"] = hashlib.sha256(canonical).hexdigest()
        passed, errors = audit._verify_cell_class_qualification(
            certificate, self.profile_binding()
        )
        self.assertTrue(passed, errors)

    def test_cell_class_qualification_satisfies_fdb_gate_without_cell_local_drill(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            digest = self.profile_binding()["profileDigest"][7:]
            (root / f"actor-cell-class-qualification-{digest}.json").write_text(
                json.dumps(self.class_qualification())
            )
            evidence, failures = audit.collect_receipts_for_cell(
                "actor-bj-a01", "actor-fdb-cell-system", root, root,
                MODULE_PATH.parent.parent / "runtime", 168, 168, 720,
                self.release("live"), "fdb-uid", "autoscaling-cell", 168,
                self.profile_binding(),
            )
        self.assertNotIn("latest_fdb_autoscaling_receipt_missing", failures)
        item = next(value for value in evidence if value.name == "fdb_autoscaling_cell_class")
        self.assertTrue(item.passed, item.reason)

    def test_runtime_release_qualification_is_reusable_only_for_exact_artifact_set(self):
        certificate = self.release_qualification()
        passed, errors = audit._verify_runtime_release_qualification(
            certificate, self.release_qualification_scope()
        )
        self.assertTrue(passed, errors)
        changed = self.release_qualification_scope()
        changed["targetImages"]["nats"]["container/nats"] = (
            "registry.invalid/nats@sha256:" + "0" * 64
        )
        passed, errors = audit._verify_runtime_release_qualification(certificate, changed)
        self.assertFalse(passed)
        self.assertIn(
            "Runtime-release qualification scope does not match the live artifact set",
            errors,
        )

    def test_runtime_release_qualification_satisfies_both_legacy_evolution_gates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            digest = self.release_qualification_scope()["artifactDigest"][7:]
            (root / f"actor-runtime-release-qualification-{digest}.json").write_text(
                json.dumps(self.release_qualification())
            )
            evidence, failures = audit.collect_receipts_for_cell(
                "actor-bj-a01", "actor-fdb-cell-system", root, root,
                MODULE_PATH.parent.parent / "runtime", 168, 168, 720,
                self.release("live"), "fdb-uid", "autoscaling-cell", 168,
                self.profile_binding(), self.release_qualification_scope(),
            )
        self.assertNotIn("latest_user_transparent_upgrade_receipt_missing", failures)
        self.assertNotIn("latest_semantic_failure_rollback_receipt_missing", failures)
        item = next(value for value in evidence if value.name == "runtime_release_qualification")
        self.assertTrue(item.passed, item.reason)

    def test_release_identity_survives_expected_pod_replacement(self):
        self.assertTrue(
            audit._same_runtime_release(self.release("before"), self.release("after"))
        )

    def test_agent_arrival_accepts_bound_scale_out_and_serial_drain(self):
        passed, errors = audit._verify_agent_arrival_receipt(
            self.agent_receipt(),
            "actor-bj-q01",
            "actor-fdb-cell-system",
            self.release("live"),
        )
        self.assertTrue(passed, errors)

    def test_agent_arrival_rejects_host_above_hard_capacity(self):
        receipt = self.agent_receipt()
        receipt["placement_metrics_delta"]["active_actors_by_host"]["runtime-a"] = 33
        receipt.pop("evidence_sha256")
        canonical = json.dumps(
            receipt, sort_keys=True, separators=(",", ":")
        ).encode()
        receipt["evidence_sha256"] = hashlib.sha256(canonical).hexdigest()
        passed, errors = audit._verify_agent_arrival_receipt(
            receipt,
            "actor-bj-q01",
            "actor-fdb-cell-system",
            self.release("live"),
        )
        self.assertFalse(passed)
        self.assertIn("a runtime Host exceeded its hard Actor admission capacity", errors)

    def test_agent_arrival_rejects_unbound_legacy_receipt(self):
        receipt = self.agent_receipt()
        receipt["schema"] = "actor-cell-agent-arrival-rate/v0"
        receipt.pop("release_binding")
        passed, errors = audit._verify_agent_arrival_receipt(
            receipt,
            "actor-bj-q01",
            "actor-fdb-cell-system",
            self.release("live"),
        )
        self.assertFalse(passed)
        self.assertIn("schema mismatch", errors)
        self.assertIn("runtime release binding mismatch", errors)

    def test_failed_upgrade_with_exact_verified_rollback_satisfies_evolution_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime_receipts = Path(directory) / "runtime"
            runtime_receipts.mkdir()
            run_id = "1" * 32
            upgrade = runtime_receipts / f"actor-bj-q01-user-transparent-upgrade-{run_id}.json"
            rollback = runtime_receipts / f"actor-bj-q01-user-transparent-rollback-{run_id}.json"
            upgrade.write_text(json.dumps({"cell": "actor-bj-q01", "verdict": "failed"}))
            rollback.write_text(json.dumps({"cell": "actor-bj-q01", "verdict": "passed"}))
            with mock.patch.object(audit, "_verify_external_receipt", return_value=(False, "expected candidate failure")), mock.patch.object(
                audit, "_verify_rollback_receipt", return_value=(True, None)
            ):
                evidence, failures = audit.collect_receipts_for_cell(
                    "actor-bj-q01", "actor-fdb-cell-system", runtime_receipts,
                    Path(directory) / "dr", MODULE_PATH.parent.parent / "runtime",
                    24, 24, 24, self.release("live"), "source-fdb-uid",
                    qualification_mode="autoscaling-cell", max_scale_age_hours=24,
                )
        by_name = {item.name: item for item in evidence}
        self.assertTrue(by_name["user_transparent_upgrade"].passed)
        self.assertEqual(by_name["user_transparent_upgrade"].verdict, "rolled_back")
        self.assertTrue(by_name["user_transparent_rollback"].passed)
        self.assertTrue(by_name["semantic_failure_rollback"].passed)
        self.assertNotIn("latest_user_transparent_upgrade_receipt_failed", failures)
        self.assertNotIn("latest_semantic_failure_rollback_receipt_failed", failures)

    def test_failed_upgrade_with_unverified_rollback_remains_blocking(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime_receipts = Path(directory) / "runtime"
            runtime_receipts.mkdir()
            run_id = "2" * 32
            (runtime_receipts / f"actor-bj-q01-user-transparent-upgrade-{run_id}.json").write_text(
                json.dumps({"cell": "actor-bj-q01", "verdict": "failed"})
            )
            (runtime_receipts / f"actor-bj-q01-user-transparent-rollback-{run_id}.json").write_text(
                json.dumps({"cell": "actor-bj-q01", "verdict": "passed"})
            )
            with mock.patch.object(audit, "_verify_external_receipt", return_value=(False, "expected candidate failure")), mock.patch.object(
                audit, "_verify_rollback_receipt", return_value=(False, "binding mismatch")
            ):
                evidence, failures = audit.collect_receipts_for_cell(
                    "actor-bj-q01", "actor-fdb-cell-system", runtime_receipts,
                    Path(directory) / "dr", MODULE_PATH.parent.parent / "runtime",
                    24, 24, 24, self.release("live"), "source-fdb-uid",
                    qualification_mode="autoscaling-cell", max_scale_age_hours=24,
                )
        by_name = {item.name: item for item in evidence}
        self.assertFalse(by_name["user_transparent_upgrade"].passed)
        self.assertFalse(by_name["user_transparent_rollback"].passed)
        self.assertFalse(by_name["semantic_failure_rollback"].passed)
        self.assertIn("latest_user_transparent_upgrade_receipt_failed", failures)
        self.assertIn("latest_semantic_failure_rollback_receipt_failed", failures)

    def test_successful_upgrade_cannot_hide_missing_semantic_rollback(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime_receipts = Path(directory) / "runtime"
            runtime_receipts.mkdir()
            upgrade = runtime_receipts / (
                "actor-bj-q01-user-transparent-upgrade-" + "3" * 32 + ".json"
            )
            upgrade.write_text(json.dumps({
                "cell": "actor-bj-q01",
                "verdict": "passed",
                "target_images": {
                    "runtime": {"container/workerd": self.release("live")["runtime_image"]}
                },
            }))
            with mock.patch.object(
                audit, "_verify_external_receipt", return_value=(True, None)
            ):
                evidence, failures = audit.collect_receipts_for_cell(
                    "actor-bj-q01", "actor-fdb-cell-system", runtime_receipts,
                    Path(directory) / "dr", MODULE_PATH.parent.parent / "runtime",
                    24, 24, 24, self.release("live"), "source-fdb-uid",
                    qualification_mode="autoscaling-cell", max_scale_age_hours=24,
                )
        self.assertTrue({item.name: item for item in evidence}["user_transparent_upgrade"].passed)
        self.assertIn("latest_semantic_failure_rollback_receipt_missing", failures)

    def test_agent_arrival_uses_p99_and_absolute_retry_tail_budgets(self):
        receipt = self.agent_receipt()
        receipt["placement_metrics_delta"]["over_five_attempts"] = 1
        receipt.pop("evidence_sha256")
        receipt["evidence_sha256"] = hashlib.sha256(
            json.dumps(receipt, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        passed, errors = audit._verify_agent_arrival_receipt(
            receipt,
            "actor-bj-q01",
            "actor-fdb-cell-system",
            self.release("live"),
        )
        self.assertTrue(passed, errors)

        receipt["placement_metrics_delta"]["over_eight_attempts"] = 1
        receipt.pop("evidence_sha256")
        receipt["evidence_sha256"] = hashlib.sha256(
            json.dumps(receipt, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        passed, errors = audit._verify_agent_arrival_receipt(
            receipt,
            "actor-bj-q01",
            "actor-fdb-cell-system",
            self.release("live"),
        )
        self.assertFalse(passed)
        self.assertIn("FDB placement-attempt budget failed", errors)

    def test_agent_arrival_accepts_bounded_unavailable_retry_with_exact_counters(self):
        receipt = self.agent_receipt()
        placement = receipt["placement_metrics_delta"]
        placement.update(
            transactions=181,
            successful_allocations=180,
            unavailable_allocations=1,
            no_envoy_allocations=1,
            capacity_rejections=1,
            allocation_gate_count=181,
            allocation_amplification=181 / 180,
        )
        receipt.pop("evidence_sha256")
        receipt["evidence_sha256"] = hashlib.sha256(
            json.dumps(receipt, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        passed, errors = audit._verify_agent_arrival_receipt(
            receipt,
            "actor-bj-q01",
            "actor-fdb-cell-system",
            self.release("live"),
        )
        self.assertTrue(passed, errors)

        receipt["placement_metrics_delta"]["allocation_gate_count"] = 180
        receipt.pop("evidence_sha256")
        receipt["evidence_sha256"] = hashlib.sha256(
            json.dumps(receipt, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        passed, errors = audit._verify_agent_arrival_receipt(
            receipt,
            "actor-bj-q01",
            "actor-fdb-cell-system",
            self.release("live"),
        )
        self.assertFalse(passed)
        self.assertIn("FDB placement-attempt budget failed", errors)

    def test_engine_ha_is_bound_to_release_not_replaceable_pod_set(self):
        image = self.release("live")["runtime_image"]
        payload = {
            "schema": "actor-cell-engine-ha/v1",
            "verdict": "passed",
            "cell_name": "actor-bj-q01",
            "namespace": "actor-fdb-cell-system",
            "contract": "public_v1_workers_api_survives_one_engine_pod_loss_without_request_failure",
            "release_binding": self.release("before"),
            "release_binding_after": self.release("after"),
            "fault": {
                "kind": "uid_fenced_zero_grace_engine_pod_delete",
                "uid": "pod-old",
                "injected_at_epoch_ms": 200,
            },
            "probe": {
                "verdict": "passed",
                "public_api": "/v1",
                "worker": "q01-engine-ha-gate",
                "object_count": 10,
                "failures": 0,
                "requests": 1500,
                "concurrency": 10,
                "traffic_started_at_ms": 100,
                "traffic_finished_at_ms": 300,
                "post_failure_write_count": 1,
                "cleanup": "passed",
                "worker_fixture_retained": True,
            },
            "before": {
                "image": image,
                "deployment_replicas": 6,
                "deployment_available": 6,
                "pdb_min_available": 4,
                "topology": [
                    {"uid": "pod-old", "hostname": "host-a", "zone": "zone-a"},
                    {"uid": "pod-a2", "hostname": "host-a", "zone": "zone-a"},
                    {"uid": "pod-b", "hostname": "host-b", "zone": "zone-b"},
                    {"uid": "pod-b2", "hostname": "host-b", "zone": "zone-b"},
                    {"uid": "pod-c", "hostname": "host-c", "zone": "zone-c"},
                    {"uid": "pod-c2", "hostname": "host-c", "zone": "zone-c"},
                ],
            },
            "after": {
                "image": image,
                "deployment_replicas": 6,
                "deployment_available": 6,
                "pdb_min_available": 4,
                "topology": [
                    {"uid": "pod-new", "hostname": "host-a", "zone": "zone-a"},
                    {"uid": "pod-a2", "hostname": "host-a", "zone": "zone-a"},
                    {"uid": "pod-b", "hostname": "host-b", "zone": "zone-b"},
                    {"uid": "pod-b2", "hostname": "host-b", "zone": "zone-b"},
                    {"uid": "pod-c", "hostname": "host-c", "zone": "zone-c"},
                    {"uid": "pod-c2", "hostname": "host-c", "zone": "zone-c"},
                ],
            },
        }
        canonical = json.dumps(
            payload, sort_keys=True, separators=(",", ":")
        ).encode()
        payload["evidence_sha256"] = hashlib.sha256(canonical).hexdigest()
        passed, errors = audit._verify_engine_ha_receipt(
            payload,
            "actor-bj-q01",
            "actor-fdb-cell-system",
            self.release("live"),
        )
        self.assertTrue(passed, errors)

        payload["fault"]["kind"] = "graceful_engine_pod_delete"
        payload.pop("evidence_sha256")
        payload["evidence_sha256"] = hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        passed, errors = audit._verify_engine_ha_receipt(
            payload,
            "actor-bj-q01",
            "actor-fdb-cell-system",
            self.release("live"),
        )
        self.assertFalse(passed)
        self.assertIn(
            "Engine fault is not an exact UID-fenced zero-grace Pod loss", errors
        )

        payload["fault"]["kind"] = "uid_fenced_zero_grace_engine_pod_delete"
        payload.pop("evidence_sha256")
        payload["evidence_sha256"] = hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()

        payload["probe"]["public_api"] = None
        payload.pop("evidence_sha256")
        payload["evidence_sha256"] = hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        passed, errors = audit._verify_engine_ha_receipt(
            payload,
            "actor-bj-q01",
            "actor-fdb-cell-system",
            self.release("live"),
        )
        self.assertFalse(passed)
        self.assertIn("Engine fault traffic proof failed", errors)

        payload["probe"]["public_api"] = "/v1"
        payload["fault"]["injected_at_epoch_ms"] = 400
        payload.pop("evidence_sha256")
        payload["evidence_sha256"] = hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        passed, errors = audit._verify_engine_ha_receipt(
            payload,
            "actor-bj-q01",
            "actor-fdb-cell-system",
            self.release("live"),
        )
        self.assertFalse(passed)
        self.assertIn(
            "Engine fault did not overlap the measured public traffic window", errors
        )

    def test_agent_arrival_rejects_tampered_evidence(self):
        receipt = self.agent_receipt()
        receipt["parameters"]["actors"] = 101
        passed, errors = audit._verify_agent_arrival_receipt(
            receipt,
            "actor-bj-q01",
            "actor-fdb-cell-system",
            self.release("live"),
        )
        self.assertFalse(passed)
        self.assertIn("evidence digest mismatch", errors)

    def test_latest_failed_attempt_is_authoritative(self):
        paths = [
            Path("actor-bj-q01-dr-new.inflight.json"),
            Path("actor-bj-q01-dr-new.failed.json"),
            Path("actor-bj-q01-dr-old.json"),
        ]
        self.assertEqual(
            audit._latest_terminal_receipt(paths),
            Path("actor-bj-q01-dr-new.failed.json"),
        )


if __name__ == "__main__":
    unittest.main()
