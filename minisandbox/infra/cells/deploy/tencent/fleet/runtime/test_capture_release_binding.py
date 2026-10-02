import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("capture_release_binding.py")
SPEC = importlib.util.spec_from_file_location("capture_release_binding", MODULE_PATH)
assert SPEC and SPEC.loader
binding = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(binding)


DIGEST = "sha256:" + "a" * 64
IMAGE = "registry.example/runtime@" + DIGEST
MANIFEST = "b" * 64


def workload(kind, replicas=None):
    if replicas is None:
        replicas = 6 if kind == "Deployment" else 3
    return {
        "kind": kind,
        "metadata": {"generation": 4},
        "spec": {
            "replicas": replicas,
            "template": {
                "metadata": {"annotations": {"fleet.actor.dev/manifest-sha256": MANIFEST}},
                "spec": {"containers": [{"name": "runtime", "image": IMAGE}]},
            },
        },
        "status": {"readyReplicas": replicas, "observedGeneration": 4},
    }


def pod(component, ordinal):
    return {
        "metadata": {
            "uid": f"{component}-{ordinal}",
            "labels": {"fleet.actor.dev/component": component},
        },
        "spec": {"containers": [{"name": "runtime", "image": IMAGE}]},
        "status": {
            "containerStatuses": [
                {"ready": True, "imageID": "docker-pullable://registry.example/runtime@" + DIGEST}
            ]
        },
    }


def pod_list():
    return {"items": [pod("engine", ordinal) for ordinal in range(6)] +
            [pod("workerd-host", ordinal) for ordinal in range(3)]}


def production_runtime_workload():
    document = workload("StatefulSet")
    document["spec"]["template"]["spec"]["containers"] = [
        {"name": "workerd", "image": IMAGE},
        {"name": "workerd-host", "image": IMAGE},
        {"name": "workerd-metrics", "image": "registry.example/metrics@sha256:" + "c" * 64},
    ]
    return document


def production_pod_list():
    items = []
    for ordinal in range(6):
        items.append(
            {
                "metadata": {"uid": f"engine-{ordinal}", "labels": {"fleet.actor.dev/component": "engine"}},
                "spec": {"containers": [{"name": "runtime", "image": IMAGE}]},
                "status": {"containerStatuses": [{"name": "runtime", "ready": True, "imageID": "runtime@" + DIGEST}]},
            }
        )
    for ordinal in range(3):
        items.append(
            {
                "metadata": {"uid": f"host-{ordinal}", "labels": {"fleet.actor.dev/component": "workerd-host"}},
                "spec": {"containers": [
                    {"name": "workerd", "image": IMAGE},
                    {"name": "workerd-host", "image": IMAGE},
                    {"name": "workerd-metrics", "image": "registry.example/metrics@sha256:" + "c" * 64},
                ]},
                "status": {
                    "containerStatuses": [
                        {"name": "workerd", "ready": True, "imageID": "runtime@" + DIGEST},
                        {"name": "workerd-host", "ready": True, "imageID": "runtime@" + DIGEST},
                        {"name": "workerd-metrics", "ready": True, "imageID": "metrics@sha256:" + "c" * 64},
                    ]
                },
            }
        )
    return {"items": items}


def add_dynamic_runtime_pod(pods, ordinal, ready=True):
    item = {
        "metadata": {"uid": f"host-{ordinal}", "labels": {"fleet.actor.dev/component": "workerd-host"}},
        "spec": {
            "containers": [
                {"name": "workerd", "image": IMAGE},
                {"name": "workerd-host", "image": IMAGE},
                {"name": "workerd-metrics", "image": "registry.example/metrics@sha256:" + "c" * 64},
            ]
        },
        "status": {"containerStatuses": []},
    }
    if ready:
        item["status"]["containerStatuses"] = [
            {"name": "workerd", "ready": True, "imageID": "runtime@" + DIGEST},
            {"name": "workerd-host", "ready": True, "imageID": "runtime@" + DIGEST},
            {"name": "workerd-metrics", "ready": True, "imageID": "metrics@sha256:" + "c" * 64},
        ]
    pods["items"].append(item)


class CaptureReleaseBindingTests(unittest.TestCase):
    def test_captures_one_immutable_nine_pod_release(self):
        result = binding.capture(workload("Deployment"), workload("StatefulSet"), pod_list())
        self.assertEqual(result["runtime_digest"], DIGEST)
        self.assertEqual(result["engine_desired_replicas"], 6)
        self.assertEqual(len(result["engine_pod_uids"]), 6)
        self.assertEqual(len(result["runtime_host_pod_uids"]), 3)

    def test_rejects_rollout_or_unpinned_image(self):
        deployment = workload("Deployment")
        deployment["status"]["readyReplicas"] = 5
        with self.assertRaisesRegex(ValueError, "not at 6 Ready"):
            binding.capture(deployment, workload("StatefulSet"), pod_list())
        deployment = workload("Deployment")
        deployment["spec"]["template"]["spec"]["containers"][0]["image"] = "runtime:latest"
        with self.assertRaisesRegex(ValueError, "not pinned"):
            binding.capture(deployment, workload("StatefulSet"), pod_list())

    def test_rejects_changed_or_not_ready_pod_set(self):
        pods = pod_list()
        pods["items"][0]["status"]["containerStatuses"][0]["ready"] = False
        with self.assertRaisesRegex(ValueError, "not fully Ready"):
            binding.capture(workload("Deployment"), workload("StatefulSet"), pods)
        pods = pod_list()
        pods["items"].pop()
        with self.assertRaisesRegex(ValueError, "exactly 3"):
            binding.capture(workload("Deployment"), workload("StatefulSet"), pods)

    def test_binds_runtime_sidecar_without_confusing_it_for_runtime(self):
        result = binding.capture(workload("Deployment"), production_runtime_workload(), production_pod_list())
        self.assertEqual(result["runtime_primary_container_names"], ["workerd", "workerd-host"])
        self.assertEqual(result["runtime_auxiliary_images"], {"workerd-metrics": "registry.example/metrics@sha256:" + "c" * 64})
        pods = production_pod_list()
        pods["items"][6]["status"]["containerStatuses"][2]["imageID"] = "metrics@sha256:" + "d" * 64
        with self.assertRaisesRegex(ValueError, "resolved inconsistently"):
            binding.capture(workload("Deployment"), production_runtime_workload(), pods)

    def test_accepts_consistent_oci_index_platform_resolution(self):
        pods = production_pod_list()
        for item in pods["items"]:
            for status in item["status"]["containerStatuses"]:
                if status.get("name") == "workerd-metrics":
                    status["imageID"] = "metrics@sha256:" + "d" * 64
        result = binding.capture(workload("Deployment"), production_runtime_workload(), pods)
        self.assertEqual(
            result["resolved_container_digests"]["workerd-host"]["workerd-metrics"],
            "sha256:" + "d" * 64,
        )

    def test_rejects_pod_spec_image_drift(self):
        pods = production_pod_list()
        pods["items"][6]["spec"]["containers"][2]["image"] = "registry.example/metrics@sha256:" + "d" * 64
        with self.assertRaisesRegex(ValueError, "Pod spec"):
            binding.capture(workload("Deployment"), production_runtime_workload(), pods)

    def test_autonomy_binding_accepts_hpa_owned_runtime_capacity(self):
        runtime = production_runtime_workload()
        runtime["spec"]["replicas"] = 4
        runtime["status"]["readyReplicas"] = 4
        pods = production_pod_list()
        add_dynamic_runtime_pod(pods, 3)
        result = binding.capture(
            workload("Deployment"),
            runtime,
            pods,
            dynamic_runtime_capacity=True,
        )
        self.assertTrue(result["runtime_capacity_dynamic"])
        self.assertEqual(result["runtime_desired_replicas"], 4)
        self.assertEqual(len(result["runtime_host_pod_uids"]), 4)

    def test_autonomy_binding_accepts_production_scale_above_old_64_host_limit(self):
        runtime = production_runtime_workload()
        runtime["spec"]["replicas"] = 70
        runtime["status"]["readyReplicas"] = 70
        pods = production_pod_list()
        for ordinal in range(3, 70):
            add_dynamic_runtime_pod(pods, ordinal)
        result = binding.capture(
            workload("Deployment"),
            runtime,
            pods,
            dynamic_runtime_capacity=True,
        )
        self.assertEqual(result["runtime_desired_replicas"], 70)
        self.assertEqual(len(result["runtime_host_pod_uids"]), 70)

    def test_autonomy_binding_rejects_capacity_above_production_envelope(self):
        runtime = production_runtime_workload()
        runtime["spec"]["replicas"] = 302
        runtime["status"]["readyReplicas"] = 302
        with self.assertRaisesRegex(ValueError, "outside the dynamic capacity bound"):
            binding.capture(
                workload("Deployment"),
                runtime,
                production_pod_list(),
                dynamic_runtime_capacity=True,
            )

    def test_autonomy_binding_allows_release_bound_pending_scale_out(self):
        runtime = production_runtime_workload()
        runtime["spec"]["replicas"] = 4
        runtime["status"]["readyReplicas"] = 3
        pods = production_pod_list()
        add_dynamic_runtime_pod(pods, 3, ready=False)
        result = binding.capture(
            workload("Deployment"),
            runtime,
            pods,
            dynamic_runtime_capacity=True,
        )
        self.assertEqual(result["runtime_ready_replicas"], 3)
        self.assertEqual(len(result["runtime_host_pod_uids"]), 3)

        pods["items"][-1]["spec"]["containers"][0]["image"] = "registry.example/runtime@sha256:" + "d" * 64
        with self.assertRaisesRegex(ValueError, "Pod spec"):
            binding.capture(
                workload("Deployment"),
                runtime,
                pods,
                dynamic_runtime_capacity=True,
            )


if __name__ == "__main__":
    unittest.main()
