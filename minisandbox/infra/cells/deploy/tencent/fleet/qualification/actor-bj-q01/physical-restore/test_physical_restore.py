import copy
import hashlib
import importlib.util
import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


render = load("q01_dr_render", ROOT / "render.py")
verify = load("q01_dr_verify", ROOT / "verify-receipt.py")


class PhysicalRestoreTests(unittest.TestCase):
    def test_seed_and_freeze_shares_the_production_cold_deadline(self):
        fleet_root = ROOT.parents[2]
        source = (fleet_root / "dr" / "seed-and-freeze-actors.sh").read_text()
        self.assertIn(
            "cold_state_timeout_seconds=${DR_COLD_STATE_TIMEOUT_SECONDS:-3600}",
            source,
        )
        self.assertIn(
            '--cold-state-timeout-seconds "$cold_state_timeout_seconds"',
            source,
        )
        self.assertIn(
            'python3 - "$receipt" "$cold_state_timeout_seconds"',
            source,
        )
        self.assertIn(
            "deadline = time.time() + cold_state_timeout_seconds",
            source,
        )
        self.assertIn('receipt["dr_seed_progress"]', source)
        self.assertIn('"pending_actors": len(pending)', source)
        self.assertIn('receipt.pop("dr_seed_progress", None)', source)
        self.assertIn('{"retention_ms": 1}', source)
        self.assertIn('/depot/qualification/buckets/{}/databases/{}/shard-cache-policy', source)
        self.assertIn('policy.get("retention_ms") != 1', source)
        self.assertLess(source.index("policy_actors.append(actor)"), source.index("policy = request("))
        self.assertIn('"temporary_shard_cache_policy": {"retention_ms": 1, "cleared": True}', source)
        self.assertIn('final freeze cache policy cleanup failed', source)
        self.assertIn("--workers-api-url http://127.0.0.1:16422", source)
        self.assertIn('--public-worker "$qualification_worker"', source)
        self.assertIn('--output "$receipt" >"$temporary/qualifier.log"', source)

        run = (ROOT / "run.sh").read_text()
        self.assertIn("--workers-api-url http://127.0.0.1:26422", run)
        self.assertIn('--public-worker "$qualification_worker"', run)
        self.assertIn("DR_RESUME_FAILURE_RECEIPT", run)
        self.assertIn('failure.get("failed_stage") not in ("render", "restore")', run)
        self.assertIn('failure.get("failed_stage") != "render"', run)
        self.assertIn("source FDB UID changed after the failed render", run)
        self.assertIn("source FDB UID changed after the failed restore", run)
        self.assertIn("restore target UID changed after the failed restore", run)
        self.assertIn('key not in ("engine_pod_uids", "runtime_host_pod_uids")', run)
        self.assertIn('target_reused_after_restore_interruption', run)
        self.assertIn("live Engine/runtime release manifest identity is inconsistent", run)
        self.assertIn("capture_release_binding.py", run)
        self.assertIn("immutable release or Pod UID set changed while freezing the DR seed", run)
        self.assertIn('seed["release_binding"] = before', run)
        self.assertIn("resumed Agent is no longer at its exact frozen cold state", run)
        self.assertIn('"frozen_seed_revalidated": True', run)
        self.assertIn("restore-agent-placement.json", run)
        self.assertIn("restore agents are not Ready in three distinct availability zones", run)
        self.assertIn('scale deployment "${target}-restore-agents" --replicas=0', run)
        self.assertIn('"scaled_to_zero": True', run)

    def source_cluster(self):
        return {
            "spec": {
                "version": "7.3.79",
                "mainContainer": {
                    "imageConfigs": [
                        {
                            "baseImage": "registry.invalid/fdb-monitor",
                            "tag": "7.3.79@sha256:" + "1" * 64,
                        }
                    ]
                },
                "processes": {
                    "general": {
                        "podTemplate": {
                            "spec": {
                                "containers": [
                                    {
                                        "name": "foundationdb",
                                        "resources": {
                                            "requests": {"cpu": "2", "memory": "8Gi"},
                                            "limits": {"cpu": "2", "memory": "8Gi"},
                                        },
                                    }
                                ]
                            }
                        },
                        "volumeClaimTemplate": {
                            "spec": {"resources": {"requests": {"storage": "200Gi"}}}
                        },
                    }
                },
            }
        }

    def records(self):
        return [
            {
                "actor_id": f"actor{index}",
                "expected_count": 3,
                "expected_bottomless_bytes": 12582912 if index == 0 else 0,
            }
            for index in range(12)
        ]

    def test_renderer_replaces_every_k01_and_public_image_identity(self):
        fleet_root = ROOT.parents[2]
        rendered = render.render_bases(
            fleet_root,
            "actor-bj-q01",
            "actor-bj-q01-dr-test",
            self.source_cluster(),
        )
        for content in rendered.values():
            self.assertNotIn("actor-bj-k01", content)
            self.assertNotIn("foundationdb/fdb-kubernetes-monitor", content)
            self.assertIn("actor-bj-q01", content)
            self.assertIn("registry.invalid/fdb-monitor", content)
        self.assertIn("imagePullSecrets:\n            - name: actor-fleet-tcr", rendered["isolated-fdb-cluster.yaml"])

        restore_agents = rendered["restore-agents.yaml"]
        self.assertIn("replicas: 3", restore_agents)
        self.assertIn("minDomains: 3", restore_agents)
        self.assertIn("topology.kubernetes.io/zone", restore_agents)
        self.assertIn("whenUnsatisfiable: DoNotSchedule", restore_agents)
        isolated = rendered["isolated-fdb-cluster.yaml"]
        self.assertIn('requests:\n                  cpu: 2\n                  memory: 8Gi', isolated)
        self.assertIn('limits:\n                  cpu: 2\n                  memory: 8Gi', isolated)
        self.assertIn("storage: 200Gi", isolated)
        self.assertNotIn("storage: 40Gi", isolated)

    def test_renderer_rejects_missing_live_storage_capacity(self):
        source = self.source_cluster()
        del source["spec"]["processes"]
        with self.assertRaisesRegex(ValueError, "storage resources are unavailable"):
            render.render_bases(
                ROOT.parents[2], "actor-bj-q01", "actor-bj-q01-dr-no-capacity", source
            )

    def test_renderer_accepts_live_image_equal_to_the_reviewed_template_image(self):
        source = self.source_cluster()
        source["spec"]["mainContainer"]["imageConfigs"][0] = {
            "baseImage": "foundationdb/fdb-kubernetes-monitor",
            "tag": "7.3.79@sha256:" + "4" * 64,
        }
        rendered = render.render_bases(
            ROOT.parents[2], "actor-bj-q01", "actor-bj-q01-dr-live-image", source
        )
        self.assertIn(
            "baseImage: foundationdb/fdb-kubernetes-monitor",
            rendered["isolated-fdb-cluster.yaml"],
        )
        self.assertIn(
            "image: foundationdb/fdb-kubernetes-monitor:7.3.79@sha256:" + "4" * 64,
            rendered["restore-agents.yaml"],
        )

    def test_verifier_job_checks_every_actor_with_pinned_runtime(self):
        image = "registry.invalid/runtime@sha256:" + "2" * 64
        job = render.verifier_job(
            "actor-bj-q01", "actor-bj-q01-dr-test", image, self.records()
        )
        script = job["spec"]["template"]["spec"]["containers"][0]["args"][0]
        self.assertEqual(job["metadata"]["name"], "actor-bj-q01-dr-test-verify")
        self.assertEqual(script.count("PRAGMA integrity_check"), 12)
        self.assertIn("restored_actor_verification=passed actors=%s", script)

    def valid_receipt(self):
        image = "registry.invalid/runtime@sha256:" + "2" * 64
        payload = {
            "schema": "actor-fdb-physical-restore-v1",
            "verdict": "passed",
            "cell": "actor-bj-q01",
            "namespace": "actor-fdb-cell-system",
            "public_api_only": True,
            "application_api": {
                "path_prefix": "/v1",
                "worker": "q01-dr-physical-restore",
                "class_name": "Agent",
                "version_id": "v_" + "1" * 64,
                "deployment_id": "d_" + "2" * 32,
            },
            "privileged_recovery_interfaces": [
                "engine_depot_direct_restore_verification",
                "foundationdb_backup_restore_control",
                "kubernetes_isolated_target_control",
            ],
            "started_from_release": {
                "runtime_image": image,
                "runtime_digest": "sha256:" + "2" * 64,
                "manifest_sha256": "3" * 64,
            },
            "source": {
                "cluster": "actor-bj-q01",
                "cluster_uid": "source-uid",
                "frozen_read_version": 100,
                "actor_manifest_sha256": "4" * 64,
                "actors": 12,
                "actors_deleted_after_verification": True,
            },
            "restore": {
                "target_cluster": "actor-bj-q01-dr-test",
                "target_cluster_uid": "target-uid",
                "uid": "a1b2c3",
                "version": 101,
                "state": "completed",
                "fdb_available": True,
                "fdb_full_replication": True,
            },
            "verification": {
                "integrity_check": "ok",
                "actor_state_exact": True,
                "cold_objects_readable": True,
                "actors_verified": 12,
                "runtime_image": image,
            },
            "retained_target": {
                "review_required_before_cleanup": True,
                "persistent_volume_claims": ["pvc-a", "pvc-b", "pvc-c"],
            },
        }
        canonical = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        payload["evidence_sha256"] = hashlib.sha256(canonical).hexdigest()
        return payload

    def test_receipt_verifier_rejects_target_reuse_and_digest_tampering(self):
        valid = self.valid_receipt()
        self.assertEqual(verify.verify(valid)["actors_verified"], 12)
        reused = copy.deepcopy(valid)
        reused["restore"]["target_cluster_uid"] = "source-uid"
        with self.assertRaisesRegex(ValueError, "reused the source FDB UID"):
            verify.verify(reused)
        tampered = copy.deepcopy(valid)
        tampered["verification"]["actors_verified"] = 11
        with self.assertRaises(ValueError):
            verify.verify(tampered)

        bypassed = copy.deepcopy(valid)
        bypassed["public_api_only"] = False
        canonical_payload = dict(bypassed)
        canonical_payload.pop("evidence_sha256")
        bypassed["evidence_sha256"] = hashlib.sha256(
            json.dumps(canonical_payload, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        with self.assertRaisesRegex(ValueError, "bypassed public /v1"):
            verify.verify(bypassed)

    def test_generic_verifier_binds_a_different_cell_identity(self):
        payload = self.valid_receipt()
        payload["cell"] = "actor-bj-k02"
        payload["application_api"]["worker"] = "k02-dr-physical-restore"
        payload["source"]["cluster"] = "actor-bj-k02"
        payload.pop("evidence_sha256")
        payload["evidence_sha256"] = hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        result = verify.verify(payload, expected_cell="actor-bj-k02")
        self.assertEqual(result["cell"], "actor-bj-k02")
        with self.assertRaisesRegex(ValueError, "source Cell mismatch"):
            verify.verify(payload, expected_cell="actor-bj-q01")

    def add_resume_digest(self, payload):
        payload.pop("evidence_sha256", None)
        canonical = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        payload["evidence_sha256"] = hashlib.sha256(canonical).hexdigest()
        return payload

    def test_receipt_verifier_accepts_bound_render_failure_resume(self):
        valid = self.valid_receipt()
        valid["resume"] = {
            "failure_stage": "render",
            "seed_reused_after_render_failure": True,
            "target_reused_after_restore_interruption": False,
            "failure_run_id": "failed-run",
            "failure_receipt_sha256": "5" * 64,
            "frozen_seed_revalidated": True,
        }
        self.add_resume_digest(valid)
        self.assertEqual(verify.verify(valid)["actors_verified"], 12)
        invalid = copy.deepcopy(valid)
        invalid["resume"]["frozen_seed_revalidated"] = False
        self.add_resume_digest(invalid)
        with self.assertRaisesRegex(ValueError, "frozen seed was not revalidated"):
            verify.verify(invalid)

    def test_receipt_verifier_accepts_only_bound_restore_failure_resume(self):
        valid = self.valid_receipt()
        valid["resume"] = {
            "failure_stage": "restore",
            "seed_reused_after_render_failure": False,
            "target_reused_after_restore_interruption": True,
            "failure_run_id": "failed-run",
            "failure_receipt_sha256": "5" * 64,
            "frozen_seed_revalidated": True,
        }
        self.add_resume_digest(valid)
        self.assertEqual(verify.verify(valid)["actors_verified"], 12)

        inconsistent = copy.deepcopy(valid)
        inconsistent["resume"]["target_reused_after_restore_interruption"] = False
        self.add_resume_digest(inconsistent)
        with self.assertRaisesRegex(ValueError, "restore-stage resume evidence is inconsistent"):
            verify.verify(inconsistent)

        ambiguous = copy.deepcopy(valid)
        ambiguous["resume"]["seed_reused_after_render_failure"] = True
        self.add_resume_digest(ambiguous)
        with self.assertRaisesRegex(ValueError, "render-stage resume evidence is inconsistent"):
            verify.verify(ambiguous)


if __name__ == "__main__":
    unittest.main()
