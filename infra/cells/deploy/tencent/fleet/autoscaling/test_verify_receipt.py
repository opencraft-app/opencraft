import importlib.util
import pathlib
import unittest


MODULE_PATH = pathlib.Path(__file__).with_name("verify_receipt.py")
SPEC = importlib.util.spec_from_file_location("verify_autoscaling_receipt", MODULE_PATH)
verifier = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verifier)


def runtime_sample(active=32, replicas=3):
    return {
        "activeActors": active,
        "runtimeStatefulSet": {"specReplicas": replicas, "readyReplicas": replicas},
        "runtimeMachineSet": {"specReplicas": replicas, "readyReplicas": replicas, "availableReplicas": replicas},
    }


def result(mode, job):
    value = {
        "mode": mode,
        "verdict": "passed",
        "api_mode": "workers-v1",
        "public_api_only": True,
        "run_id": "run",
        "cell_id": "actor-bj-q01",
        "target_actors": 1000,
        "batch_size": 32,
        "batch_settle_seconds": 45,
        "operation_rate": 0,
        "max_idempotent_retries": 3,
        "actor_states": {"dormant": 1000},
        "probe_states": {},
        "qualification_evidence": {"jobName": job, "podUID": "12345678-1234-1234-1234-123456789abc"},
    }
    if mode == "probe":
        value["probe_states"] = {"deleted": 256}
    elif mode == "cleanup":
        value["actor_states"] = {"deleted": 1000}
    return value


class AutoscalingReceiptTests(unittest.TestCase):
    def test_v5_loadgen_config_is_dynamic_and_bounded(self):
        document = {
            "schemaVersion": "actor-fdb-autoscaling-qualification-v5",
            "loadgenConfig": {
                "targetActors": 1000000,
                "probeActors": 10000,
                "concurrency": 64,
                "batchSize": 1024,
                "batchSettleSeconds": 0.0,
                "operationRate": 100.0,
                "maxIdempotentRetries": 8,
                "retryBaseDelaySeconds": 0.2,
                "runtimeBaselineReplicas": 4,
            },
        }
        config = verifier.loadgen_config(document)
        self.assertTrue(config["strict"])
        self.assertEqual(config["targetActors"], 1000000)
        document["loadgenConfig"]["targetActors"] = 1000001
        with self.assertRaises(AssertionError):
            verifier.loadgen_config(document)

    def test_profile_binding_is_exact_and_cell_visible(self):
        digest = "sha256:" + "a" * 64
        inventory = "sha256:" + "b" * 64
        document = {
            "profileBinding": {
                "className": "rivet-fdb-cos-kubernetes-v1",
                "profileName": "rivet-fdb-operator-cbs-beijing-v1",
                "profileDigest": digest,
                "driverABI": "rivet-fdb-cos-kubernetes-v1",
                "region": "ap-beijing",
                "imageInventoryDigest": inventory,
            },
            "rivetCell": {
                "metadata": {"annotations": {
                    "fleet.actor.dev/profile-digest": digest,
                    "fleet.actor.dev/image-inventory-digest": inventory,
                }},
                "spec": {
                    "className": "rivet-fdb-cos-kubernetes-v1",
                    "region": "ap-beijing",
                },
            },
        }
        self.assertEqual(document["profileBinding"], verifier.verify_profile_binding(document))
        document["rivetCell"]["metadata"]["annotations"]["fleet.actor.dev/profile-digest"] = "sha256:" + "c" * 64
        with self.assertRaises(AssertionError):
            verifier.verify_profile_binding(document)

    def test_runtime_must_remain_inside_three_host_envelope(self):
        verifier.verify_runtime_isolation({"runtimeIsolationTimeline": [runtime_sample()]})
        with self.assertRaises(AssertionError):
            verifier.verify_runtime_isolation({"runtimeIsolationTimeline": [runtime_sample(replicas=4)]})
        with self.assertRaises(AssertionError):
            verifier.verify_runtime_isolation({"runtimeIsolationTimeline": [runtime_sample(active=49)]})

    def test_job_success_cannot_replace_exact_public_results(self):
        jobs = [{"metadata": {"name": name}} for name in ("seed", "expanded", "contracted", "cleanup")]
        document = {
            "runID": "run",
            "cell": "actor-bj-q01",
            "loadgenResults": [
                result("populate", "seed"),
                result("probe", "expanded"),
                result("probe", "contracted"),
                result("cleanup", "cleanup"),
            ],
        }
        verifier.verify_loadgen_results(document, jobs)
        document["loadgenResults"][1]["actor_states"] = {"dormant": 999}
        with self.assertRaises(AssertionError):
            verifier.verify_loadgen_results(document, jobs)

    def test_v5_results_are_bound_to_declared_scale_and_rate(self):
        jobs = [{"metadata": {"name": name}} for name in ("seed", "expanded", "contracted", "cleanup")]
        config = dict(verifier.LEGACY_LOADGEN_CONFIG)
        config.update({
            "targetActors": 10000, "probeActors": 1000, "batchSize": 256,
            "batchSettleSeconds": 0.0, "operationRate": 100.0,
            "maxIdempotentRetries": 8, "strict": True,
        })
        results = [
            result("populate", "seed"), result("probe", "expanded"),
            result("probe", "contracted"), result("cleanup", "cleanup"),
        ]
        for item in results:
            item.update({
                "target_actors": 10000, "batch_size": 256,
                "batch_settle_seconds": 0.0, "operation_rate": 100.0,
                "max_idempotent_retries": 8,
            })
            item["actor_states"] = {"dormant": 10000}
        for item in results[1:3]:
            item["probe_states"] = {"deleted": 1000}
        results[3]["actor_states"] = {"deleted": 10000}
        document = {"runID": "run", "cell": "actor-bj-q01", "loadgenResults": results}
        verifier.verify_loadgen_results(document, jobs, config)
        results[2]["operation_rate"] = 99.0
        with self.assertRaises(AssertionError):
            verifier.verify_loadgen_results(document, jobs, config)


if __name__ == "__main__":
    unittest.main()
