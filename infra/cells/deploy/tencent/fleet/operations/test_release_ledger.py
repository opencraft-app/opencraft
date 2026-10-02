import copy
import importlib.util
import json
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("release_ledger.py")
SPEC = importlib.util.spec_from_file_location("release_ledger", MODULE_PATH)
assert SPEC and SPEC.loader
ledger_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ledger_module)


CELL = "actor-bj-q01"
NAMESPACE = "actor-fdb-cell-system"
RUNTIME = "registry.invalid/runtime@sha256:" + "a" * 64
REPORTER = "registry.invalid/reporter@sha256:" + "b" * 64
NATS = "registry.invalid/nats@sha256:" + "c" * 64
METRICS = "registry.invalid/metrics@sha256:" + "d" * 64


def workload(kind, name, component, containers, init_containers=None, replicas=3):
    return {
        "apiVersion": "apps/v1",
        "kind": kind,
        "metadata": {"name": name, "namespace": NAMESPACE},
        "spec": {
            "replicas": replicas,
            "selector": {"matchLabels": {"fleet.actor.dev/component": component}},
            "strategy" if kind == "Deployment" else "updateStrategy": {"type": "RollingUpdate"},
            "template": {
                "metadata": {
                    "labels": {"fleet.actor.dev/component": component},
                    "annotations": {"fleet.actor.dev/manifest-sha256": "e" * 64},
                },
                "spec": {
                    "containers": [
                        {"name": container_name, "image": image, "args": ["serve"]}
                        for container_name, image in containers.items()
                    ],
                    "initContainers": [
                        {"name": container_name, "image": image}
                        for container_name, image in (init_containers or {}).items()
                    ],
                },
            },
        },
    }


def configmap(name, value):
    return {
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {"name": name, "namespace": NAMESPACE},
        "data": {"config": value},
    }


def ready_pod(name, component, containers, init_containers=None):
    def statuses(images):
        return [
            {
                "name": container_name,
                "ready": True,
                "imageID": "containerd://" + image.rsplit("@", 1)[1],
            }
            for container_name, image in images.items()
        ]

    return {
        "metadata": {"name": name, "labels": {"fleet.actor.dev/component": component}},
        "spec": {
            "containers": [
                {"name": container_name, "image": image}
                for container_name, image in containers.items()
            ],
            "initContainers": [
                {"name": container_name, "image": image}
                for container_name, image in (init_containers or {}).items()
            ],
        },
        "status": {
            "phase": "Running",
            "conditions": [{"type": "Ready", "status": "True"}],
            "containerStatuses": statuses(containers),
            "initContainerStatuses": statuses(init_containers or {}),
        },
    }


class ReleaseLedgerTests(unittest.TestCase):
    def test_canonical_digest_matches_go_reporter(self):
        self.assertEqual(
            ledger_module.digest({"command": "a && b < c", "unicode": "中文"}),
            "sha256:aeac6d31e2fd68f35869322c3e0bff5e442e88f7be5b290c6bb172402ad1263f",
        )

    def setUp(self):
        self.engine = workload("Deployment", f"{CELL}-engine", "engine", {"engine": RUNTIME})
        self.runtime = workload(
            "StatefulSet",
            f"{CELL}-runtime-hosts",
            "workerd-host",
            {"workerd": RUNTIME, "workerd-host": RUNTIME, "workerd-metrics": METRICS},
            {"prepare-workerd-config": RUNTIME},
        )
        self.capacity = workload(
            "Deployment", f"{CELL}-runtime-capacity", "runtime-capacity-controller", {"controller": REPORTER}, replicas=1
        )
        self.nats = workload("StatefulSet", f"{CELL}-nats", "nats", {"nats": NATS})
        self.reporter = workload(
            "Deployment", f"{CELL}-cell-reporter", "cell-reporter", {"reporter": REPORTER}, replicas=1
        )
        self.runtime_config = configmap(f"{CELL}-runtime-config", "runtime")
        self.nats_config = configmap(f"{CELL}-nats-config", "nats")
        self.ledger = ledger_module.build_runtime_ledger(
            cell=CELL,
            namespace=NAMESPACE,
            released_at="2026-09-05T00:00:00Z",
            source_revision="f" * 40,
            source_manifest_sha256="1" * 64,
            reporter_source_revision="2" * 40,
            reporter_source_manifest_sha256="3" * 64,
            runtime_image=RUNTIME,
            reporter_image=REPORTER,
            nats_image=NATS,
            workerd_metrics_image=METRICS,
            engine=self.engine,
            runtime_hosts=self.runtime,
            runtime_capacity=self.capacity,
            nats=self.nats,
            reporter=self.reporter,
            runtime_config=self.runtime_config,
            nats_config=self.nats_config,
        )

    def inputs(self):
        workloads = {
            (item["kind"], item["metadata"]["name"]): item
            for item in (self.engine, self.runtime, self.capacity, self.nats, self.reporter)
        }
        configmaps = {
            self.runtime_config["metadata"]["name"]: self.runtime_config,
            self.nats_config["metadata"]["name"]: self.nats_config,
        }
        pods = [
            ready_pod("engine-0", "engine", {"engine": RUNTIME}),
            ready_pod(
                "runtime-0",
                "workerd-host",
                {"workerd": RUNTIME, "workerd-host": RUNTIME, "workerd-metrics": METRICS},
                {"prepare-workerd-config": RUNTIME},
            ),
            ready_pod("capacity-0", "runtime-capacity-controller", {"controller": REPORTER}),
            ready_pod("nats-0", "nats", {"nats": NATS}),
            ready_pod("reporter-0", "cell-reporter", {"reporter": REPORTER}),
        ]
        return workloads, configmaps, pods

    def audit(self, ledger=None, workloads=None, configmaps=None, pods=None):
        defaults = self.inputs()
        return ledger_module.audit_ledger(
            self.ledger if ledger is None else ledger,
            cell=CELL,
            namespace=NAMESPACE,
            workloads=defaults[0] if workloads is None else workloads,
            configmaps=defaults[1] if configmaps is None else configmaps,
            pods=defaults[2] if pods is None else pods,
        )

    def test_matching_release_is_ready(self):
        result = self.audit()
        self.assertTrue(result["ready"], result["drifts"])
        self.assertEqual(result["driftCount"], 0)

    def test_capacity_help_is_a_successful_side_effect_free_preflight(self):
        by_command = {tuple(item.get("command", ())): item for item in self.ledger["preflight"]}
        self.assertEqual(
            by_command[("/usr/local/bin/workerd-runtime-capacity-controller", "--help")]["expectedExitCode"],
            0,
        )
        self.assertEqual(
            by_command[("/usr/local/bin/rivet-cell-reporter", "--help")]["expectedExitCode"],
            1,
        )

    def test_release_qualification_scope_is_cell_neutral_and_complete(self):
        scope = ledger_module.release_qualification_scope(self.ledger)
        self.assertEqual(scope["schema"], "actor-runtime-release-artifact/v1")
        self.assertEqual(
            set(scope["targetImages"]),
            {"engine", "runtime", "capacity", "nats", "reporter"},
        )
        self.assertEqual(scope["targetImages"]["engine"], {"container/engine": RUNTIME})
        self.assertEqual(
            scope["targetImages"]["runtime"],
            {
                "container/workerd": RUNTIME,
                "container/workerd-host": RUNTIME,
                "container/workerd-metrics": METRICS,
                "init/prepare-workerd-config": RUNTIME,
            },
        )
        identity = dict(scope)
        artifact_digest = identity.pop("artifactDigest")
        self.assertEqual(artifact_digest, ledger_module.digest(identity))
        self.assertNotIn(CELL, json.dumps(scope, sort_keys=True))

    def test_replica_count_is_explicitly_not_owned(self):
        workloads, _, _ = self.inputs()
        workloads[("StatefulSet", f"{CELL}-runtime-hosts")]["spec"]["replicas"] = 19
        workloads[("Deployment", f"{CELL}-engine")]["spec"]["replicas"] = 8
        result = self.audit(workloads=workloads)
        self.assertTrue(result["ready"], result["drifts"])

    def test_pod_template_null_creation_timestamp_is_serialization_noise(self):
        workloads, _, _ = self.inputs()
        for document in workloads.values():
            document["spec"]["template"]["metadata"]["creationTimestamp"] = None
        result = self.audit(workloads=workloads)
        self.assertTrue(result["ready"], result["drifts"])

    def test_reporter_admission_inputs_are_owned_by_qualification(self):
        workloads, _, _ = self.inputs()
        reporter = workloads[("Deployment", f"{CELL}-cell-reporter")]
        reporter["spec"]["template"]["spec"]["containers"][0]["env"] = [
            {"name": "CAPACITY_RISK", "value": "Normal"},
            {"name": "QUALIFICATION_READY", "value": "true"},
            {"name": "QUALIFICATION_RECEIPT", "value": "kubernetes://receipt"},
            {"name": "QUALIFICATION_DIGEST", "value": "sha256:" + "1" * 64},
            {"name": "QUALIFICATION_RELEASE_DIGEST", "value": "sha256:" + "2" * 64},
        ]
        result = self.audit(workloads=workloads)
        self.assertTrue(result["ready"], result["drifts"])

    def test_other_reporter_environment_remains_release_owned(self):
        workloads, _, _ = self.inputs()
        reporter = workloads[("Deployment", f"{CELL}-cell-reporter")]
        reporter["spec"]["template"]["spec"]["containers"][0]["env"] = [
            {"name": "REPORT_INTERVAL", "value": "1s"}
        ]
        result = self.audit(workloads=workloads)
        self.assertFalse(result["ready"])
        self.assertIn("static_spec_digest_mismatch", {item["reason"] for item in result["drifts"]})

    def test_static_template_drift_is_detected(self):
        workloads, _, _ = self.inputs()
        workloads[("Deployment", f"{CELL}-engine")]["spec"]["template"]["spec"]["containers"][0]["args"] = ["wrong"]
        result = self.audit(workloads=workloads)
        self.assertFalse(result["ready"])
        self.assertIn("static_spec_digest_mismatch", {item["reason"] for item in result["drifts"]})

    def test_pod_image_id_drift_is_detected(self):
        _, _, pods = self.inputs()
        pods[0]["status"]["containerStatuses"][0]["imageID"] = "runtime:latest"
        result = self.audit(pods=pods)
        self.assertFalse(result["ready"])
        self.assertIn("pod_image_id_mismatch", {item["reason"] for item in result["drifts"]})

    def test_oci_index_platform_digest_is_accepted(self):
        _, _, pods = self.inputs()
        pods[0]["status"]["containerStatuses"][0]["imageID"] = "containerd://sha256:" + "0" * 64
        result = self.audit(pods=pods)
        self.assertTrue(result["ready"], result["drifts"])

    def test_pod_spec_image_drift_is_detected(self):
        _, _, pods = self.inputs()
        pods[0]["spec"]["containers"][0]["image"] = "registry.invalid/runtime@sha256:" + "0" * 64
        result = self.audit(pods=pods)
        self.assertFalse(result["ready"])
        self.assertIn("pod_spec_image_mismatch", {item["reason"] for item in result["drifts"]})

    def test_configmap_drift_is_detected(self):
        _, configmaps, _ = self.inputs()
        configmaps[f"{CELL}-runtime-config"]["data"]["config"] = "mutated"
        result = self.audit(configmaps=configmaps)
        self.assertFalse(result["ready"])
        self.assertIn("configmap_content_digest_mismatch", {item["reason"] for item in result["drifts"]})

    def test_ledger_tamper_fails_closed(self):
        tampered = copy.deepcopy(self.ledger)
        tampered["source"]["revision"] = "0" * 40
        result = self.audit(ledger=tampered)
        self.assertFalse(result["ready"])
        self.assertEqual(result["drifts"][0]["component"], "ledger")


if __name__ == "__main__":
    unittest.main()
