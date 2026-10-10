#!/usr/bin/env python3
"""Static contract for the production stateless execution plane."""

from pathlib import Path
import os
import subprocess
import tempfile
import unittest

import yaml


ROOT = Path(__file__).resolve().parent
DOCUMENTS = [
    item
    for item in yaml.safe_load_all((ROOT / "stateless-executor.yaml").read_text())
    if item
]
INSTALLER = (ROOT / "install-stateless-executor.sh").read_text()
AUTH_BOOTSTRAP = (ROOT / "ensure-stateless-auth.sh").read_text()
ENDPOINT_INSTALLER = (ROOT / "install-private-stateless-endpoint.sh").read_text()
ADMISSION_INSTALLER = (ROOT / "install-stateless-admission-controller.sh").read_text()
ADMISSION_DOCUMENTS = [
    item
    for item in yaml.safe_load_all((ROOT / "stateless-admission-controller.yaml").read_text())
    if item
]


def resource(kind: str) -> dict:
    return next(item for item in DOCUMENTS if item["kind"] == kind)


class StatelessExecutorContractTest(unittest.TestCase):
    def test_native_isolate_cache_policy_is_rendered_and_fails_closed(self) -> None:
        pod = resource("Deployment")["spec"]["template"]["spec"]
        init = next(item for item in pod["initContainers"] if item["name"] == "prepare-workerd-config")
        defaults = {item["name"]: item["value"] for item in init["env"]}
        self.assertEqual(defaults, {
            "RIVET_STATELESS_ISOLATE_CACHE_CAPACITY": "16",
            "RIVET_STATELESS_ISOLATE_CACHE_IDLE_MS": "60000",
        })
        build = (ROOT / "build-image.sh").read_text()
        self.assertIn('"$stage_dir/workerd" test --experimental --no-verbose --gc-stress', build)
        self.assertIn("stateless-isolate-cache-native.wd-test cache-test", build)
        self.assertIn("stateless-isolate-cache-native.wd-test metrics-test", build)
        host = ROOT.parents[5] / "runtimes/workerd/host/workerd"
        with tempfile.TemporaryDirectory(prefix="stateless-config-") as directory:
            root = Path(directory)
            (root / "auth").mkdir()
            (root / "run").mkdir()
            (root / "share").mkdir()
            (root / "share/config-stateless.capnp").write_text((host / "config-stateless.capnp").read_text())
            (root / "share/stateless-worker.js").write_text((host / "stateless-worker.js").read_text())
            (root / "auth/workerd-token").write_text("1" * 64)
            (root / "auth/object-router-token").write_text("2" * 64)
            # Execute the actual manifest shell against disposable paths. No
            # runtime secrets or cloud mutation are needed to verify rendering.
            script = init["args"][0].replace("/var/run/stateless-auth", str(root / "auth"))
            script = script.replace("/opt/actor/share", str(root / "share"))
            script = script.replace("/run/stateless", str(root / "run"))
            for capacity, ttl in [("1", "1"), ("256", "3600000"), ("16", "60000")]:
                env = dict(os.environ, RIVET_STATELESS_ISOLATE_CACHE_CAPACITY=capacity,
                           RIVET_STATELESS_ISOLATE_CACHE_IDLE_MS=ttl)
                result = subprocess.run(["bash", "-ec", script], env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                config = (root / "run/config-stateless.capnp").read_text()
                self.assertIn(f'name = "RIVET_STATELESS_ISOLATE_CACHE_CAPACITY", text = "{capacity}"', config)
                self.assertIn(f'name = "RIVET_STATELESS_ISOLATE_CACHE_IDLE_MS", text = "{ttl}"', config)
            for capacity, ttl in [("0", "60000"), ("257", "60000"), ("16", "0"),
                                  ("16", "3600001"), ("01", "60000"), ("1e2", "60000"),
                                  ("16", "1.5"), ("16", "99999999999999999999")]:
                env = dict(os.environ, RIVET_STATELESS_ISOLATE_CACHE_CAPACITY=capacity,
                           RIVET_STATELESS_ISOLATE_CACHE_IDLE_MS=ttl)
                result = subprocess.run(["bash", "-ec", script], env=env, capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0, (capacity, ttl))
            # An incompatible image/template must not silently ignore policy.
            template = root / "share/config-stateless.capnp"
            template.write_text(template.read_text().replace("RIVET_STATELESS_ISOLATE_CACHE_IDLE_MS", "REMOVED_BINDING"))
            result = subprocess.run(["bash", "-ec", script], env=dict(os.environ, **defaults), capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)

    def test_execution_plane_uses_a_secret_isolated_namespace(self) -> None:
        self.assertTrue(DOCUMENTS)
        self.assertTrue(ADMISSION_DOCUMENTS)
        self.assertEqual(
            {item["metadata"].get("namespace") for item in DOCUMENTS},
            {"actor-stateless-system"},
        )
        admission_by_kind = {item["kind"]: item for item in ADMISSION_DOCUMENTS}
        self.assertEqual(
            admission_by_kind["ServiceAccount"]["metadata"]["namespace"],
            "actor-runtime-admission-system",
        )
        self.assertEqual(
            admission_by_kind["Deployment"]["metadata"]["namespace"],
            "actor-runtime-admission-system",
        )
        for kind in ("Role", "RoleBinding"):
            self.assertEqual(
                admission_by_kind[kind]["metadata"]["namespace"],
                "actor-stateless-system",
            )
        for kind in ("RoleBinding", "ClusterRoleBinding"):
            self.assertEqual(
                admission_by_kind[kind]["subjects"][0]["namespace"],
                "actor-runtime-admission-system",
            )
        self.assertIn("namespace=actor-stateless-system", INSTALLER)
        self.assertIn("namespace=actor-runtime-admission-system", ADMISSION_INSTALLER)
        self.assertIn("workload_namespace=actor-stateless-system", ADMISSION_INSTALLER)
        self.assertIn("namespace=${RIVET_STATELESS_NAMESPACE:-actor-stateless-system}", ENDPOINT_INSTALLER)

    def test_execution_plane_is_not_a_durable_actor_host(self) -> None:
        deployment = resource("Deployment")
        pod = deployment["spec"]["template"]["spec"]
        containers = {item["name"]: item for item in pod["containers"]}

        self.assertEqual(set(containers), {"workerd", "executor"})
        self.assertEqual(
            containers["executor"]["command"],
            ["/opt/actor/bin/rivet-workerd-host", "--mode=stateless"],
        )
        encoded = (ROOT / "stateless-executor.yaml").read_text()
        for forbidden in ("RIVET_ENVOY", "RIVET_SQLITE", "RIVET_DEPOT", "hostPort"):
            self.assertNotIn(forbidden, encoded)
        self.assertFalse(pod["automountServiceAccountToken"])
        self.assertEqual(pod["serviceAccountName"], "__CELL_NAME__-stateless-executor")
        self.assertEqual(deployment["spec"]["replicas"], 3)
        self.assertEqual(
            deployment["spec"]["strategy"]["rollingUpdate"],
            {"maxUnavailable": 0, "maxSurge": 1},
        )
        self.assertEqual(resource("PodDisruptionBudget")["spec"]["minAvailable"], 2)
        self.assertEqual(
            resource("Service")["metadata"]["labels"]["app.kubernetes.io/name"],
            "actor-stateless-executor",
        )
        self.assertNotIn(
            "app.kubernetes.io/name",
            resource("ServiceAccount")["metadata"]["labels"],
        )

    def test_capacity_and_node_admission_are_bounded(self) -> None:
        deployment = resource("Deployment")
        pod = deployment["spec"]["template"]["spec"]
        requirements = {
            item["key"]: item
            for item in pod["affinity"]["nodeAffinity"]
            ["requiredDuringSchedulingIgnoredDuringExecution"]["nodeSelectorTerms"][0]
            ["matchExpressions"]
        }
        self.assertEqual(requirements["fleet.actor.dev/stateless-admitted"]["values"], ["true"])
        self.assertEqual(requirements["rivet.dev/stateless"]["values"], ["true"])
        self.assertEqual(
            requirements["fleet.actor.dev/stateless-pool"]["values"], ["true"],
        )
        self.assertEqual(requirements["fleet.actor.dev/cell-name"]["values"], ["__CELL_NAME__"])
        self.assertNotIn("node.tke.cloud.tencent.com/machineset", requirements)
        self.assertEqual(
            deployment["metadata"]["annotations"]["fleet.actor.dev/stateless-machine-set"],
            "__STATELESS_MACHINE_SET__",
        )
        self.assertEqual(pod["tolerations"], [{
            "key": "rivet.dev/stateless", "operator": "Equal", "value": "true",
            "effect": "NoSchedule",
        }])
        self.assertNotIn(
            "startup-taint.cluster-autoscaler.kubernetes.io/stateless-admission",
            {item["key"] for item in pod["tolerations"]},
        )
        hpa = resource("HorizontalPodAutoscaler")["spec"]
        self.assertEqual((hpa["minReplicas"], hpa["maxReplicas"]), (3, 30))
        self.assertEqual(hpa["behavior"]["scaleDown"]["policies"], [
            {"type": "Pods", "value": 1, "periodSeconds": 60}
        ])
        external_metrics = {
            item["external"]["metric"]["name"]: item["external"]
            for item in hpa["metrics"]
            if item["type"] == "External"
        }
        self.assertEqual(set(external_metrics), {
            "rivet_stateless_in_flight_total",
            "rivet_stateless_peak_in_flight",
            "rivet_stateless_queued_total",
        })
        external = external_metrics["rivet_stateless_in_flight_total"]
        self.assertEqual(
            external["metric"],
            {
                "name": "rivet_stateless_in_flight_total",
                "selector": {"matchLabels": {"cell": "__CELL_NAME__"}},
            },
        )
        self.assertEqual(external["target"]["averageValue"], "24")
        peak = external_metrics["rivet_stateless_peak_in_flight"]
        self.assertEqual(
            peak["metric"],
            {
                "name": "rivet_stateless_peak_in_flight",
                "selector": {"matchLabels": {"cell": "__CELL_NAME__"}},
            },
        )
        self.assertEqual(peak["target"]["averageValue"], "24")
        self.assertEqual(
            external_metrics["rivet_stateless_queued_total"]["target"]["averageValue"],
            "1",
        )
        executor = next(item for item in pod["containers"] if item["name"] == "executor")
        env = {item["name"]: item.get("value") for item in executor["env"]}
        self.assertEqual(env["RIVET_WORKERD_MAX_IN_FLIGHT"], "64")
        self.assertEqual(env["RIVET_WORKERD_MAX_QUEUED"], "256")
        self.assertEqual(env["RIVET_WORKERD_QUEUE_TIMEOUT_MS"], "15000")

    def test_termination_drains_before_kubernetes_removes_the_pod(self) -> None:
        pod = resource("Deployment")["spec"]["template"]["spec"]
        executor = next(item for item in pod["containers"] if item["name"] == "executor")
        self.assertEqual(executor["startupProbe"]["httpGet"]["path"], "/readyz")
        self.assertEqual(executor["readinessProbe"]["httpGet"]["path"], "/readyz")
        self.assertEqual(executor["livenessProbe"]["httpGet"]["path"], "/healthz")
        command = executor["lifecycle"]["preStop"]["exec"]["command"]
        self.assertEqual(command[:2], ["/bin/bash", "-ec"])
        self.assertIn("-X POST", command[2])
        self.assertIn("/internal/v1/drain", command[2])
        self.assertIn("RIVET_STATELESS_EXECUTOR_TOKEN", command[2])
        self.assertIn("sleep 30", command[2])
        self.assertIn("rivet_stateless_in_flight", command[2])
        self.assertIn("rivet_stateless_queued", command[2])
        self.assertIn("deadline=$((SECONDS + 520))", command[2])
        self.assertEqual(executor["readinessProbe"]["periodSeconds"], 1)
        self.assertEqual(executor["readinessProbe"]["failureThreshold"], 1)
        workerd = next(item for item in pod["containers"] if item["name"] == "workerd")
        workerd_command = workerd["lifecycle"]["preStop"]["exec"]["command"]
        self.assertEqual(workerd_command[:2], ["/bin/bash", "-ec"])
        self.assertIn("http://127.0.0.1:19084/healthz", workerd_command[2])
        self.assertIn("deadline=$((SECONDS + 610))", workerd_command[2])
        self.assertEqual(
            workerd["livenessProbe"]["exec"]["command"],
            ["/bin/bash", "-ec", "exec 3<>/dev/tcp/127.0.0.1/18090"],
        )
        self.assertGreaterEqual(pod["terminationGracePeriodSeconds"], 620)

    def test_capabilities_are_cell_scoped_and_endpoint_is_private(self) -> None:
        self.assertIn("${cell}-stateless-auth", AUTH_BOOTSTRAP)
        self.assertIn("openssl rand -hex 32", AUTH_BOOTSTRAP)
        self.assertIn('"immutable":True', AUTH_BOOTSTRAP)
        self.assertIn('"schema":"actor-stateless-auth/v1"', AUTH_BOOTSTRAP)
        for capability in ("executor-token", "object-router-token", "workerd-token"):
            self.assertIn(capability, AUTH_BOOTSTRAP)
        self.assertIn("RIVET_STATELESS_AUTH_RECEIPT", INSTALLER)
        self.assertIn("credentialReceiptSha256", INSTALLER)
        deployment = resource("Deployment")
        executor = next(
            item for item in deployment["spec"]["template"]["spec"]["containers"]
            if item["name"] == "executor"
        )
        secret_keys = {
            item["name"]: item.get("valueFrom", {}).get("secretKeyRef", {}).get("key")
            for item in executor["env"]
        }
        self.assertEqual(secret_keys["RIVET_STATELESS_EXECUTOR_TOKEN"], "executor-token")
        self.assertEqual(secret_keys["RIVET_WORKERD_TOKEN"], "workerd-token")
        self.assertIn('"schema":"actor-stateless-executor-installation/v1"', INSTALLER)
        self.assertIn("actor-stateless-private-endpoint/v1", ENDPOINT_INSTALLER)
        self.assertIn("loadBalancerSourceRanges", ENDPOINT_INSTALLER)
        self.assertIn("RIVET_STATELESS_SECURITY_GROUP_ID", ENDPOINT_INSTALLER)
        self.assertIn('"service.cloud.tencent.com/loadbalance-retain":"true"', ENDPOINT_INSTALLER)
        self.assertIn("service.cloud.tencent.com/security-groups", ENDPOINT_INSTALLER)
        self.assertIn("service.cloud.tencent.com/tke-service-config", ENDPOINT_INSTALLER)
        self.assertIn('"scheduler":"LEAST_CONN"', ENDPOINT_INSTALLER)
        self.assertIn('"externalTrafficPolicy":"Local"', ENDPOINT_INSTALLER)
        self.assertIn('"kind":"TkeServiceConfig"', ENDPOINT_INSTALLER)
        self.assertIn("service.kubernetes.io/loadbalance-id", ENDPOINT_INSTALLER)
        self.assertIn("readyEndpointCount", ENDPOINT_INSTALLER)
        self.assertIn("ipaddress.ip_address(endpoint).is_private", ENDPOINT_INSTALLER)
        self.assertIn("cell_object[\"metadata\"][\"uid\"]", ENDPOINT_INSTALLER)
        self.assertIn('f"http://{endpoint}:19084"', ENDPOINT_INSTALLER)
        self.assertNotIn("0.0.0.0/0", ENDPOINT_INSTALLER)

    def test_runtime_image_contains_the_complete_stateless_abi(self) -> None:
        dockerfile = (ROOT / "Dockerfile").read_text()
        builder = (ROOT / "build-image.sh").read_text()
        local_dockerfile = (
            ROOT.parents[2] / "local" / "mesh" / "real" / "Dockerfile.runtime"
        ).read_text()
        local_builder = (
            ROOT.parents[2] / "local" / "mesh" / "build-real-runtime-image.sh"
        ).read_text()
        for source in (dockerfile, builder, local_dockerfile, local_builder):
            self.assertIn("stateless-worker.js", source)
            self.assertIn("config-stateless.capnp", source)

    def test_stateless_node_admission_is_independent_and_fail_closed(self) -> None:
        deployment = next(
            item for item in ADMISSION_DOCUMENTS
            if item["kind"] == "Deployment"
        )
        container = deployment["spec"]["template"]["spec"]["containers"][0]
        env = {item["name"]: item.get("value") for item in container["env"]}
        self.assertEqual(env["CELL_NAMESPACE"], "actor-stateless-system")
        self.assertEqual(env["RUNTIME_CAPACITY_CONTROLLER_ENABLED"], "false")
        self.assertEqual(env["RUNTIME_ADMISSION_WORKLOAD_KIND"], "Deployment")
        self.assertEqual(env["RUNTIME_ADMISSION_POOL_LABEL_KEY"], "fleet.actor.dev/stateless-pool")
        self.assertEqual(env["RUNTIME_ADMISSION_POOL_TAINT_KEY"], "rivet.dev/stateless")
        self.assertEqual(
            env["RUNTIME_ADMISSION_PENDING_TAINT_KEY"],
            "startup-taint.cluster-autoscaler.kubernetes.io/stateless-admission",
        )
        self.assertEqual(env["RUNTIME_ADMISSION_ADMITTED_LABEL"], "fleet.actor.dev/stateless-admitted")
        self.assertEqual(env["RUNTIME_ADMISSION_PROFILE_VERSION"], "workerd-stateless-node-v1")
        cluster_role = next(
            item for item in ADMISSION_DOCUMENTS
            if item["kind"] == "ClusterRole"
        )
        machine_rule = next(
            item for item in cluster_role["rules"]
            if "machines" in item["resources"]
        )
        self.assertEqual(machine_rule["verbs"], ["get", "list", "patch"])
        self.assertNotIn("delete", machine_rule["verbs"])
        self.assertIn("fleet.actor.dev/stateless-admitted", ADMISSION_INSTALLER)
        self.assertIn("machine_set_uid", ADMISSION_INSTALLER)
        self.assertIn('"schema":"actor-stateless-node-admission/v1"', ADMISSION_INSTALLER)
        self.assertIn("install-stateless-admission-controller.sh", INSTALLER)
        self.assertIn("nodeAdmissionReceiptSha256", INSTALLER)


if __name__ == "__main__":
    unittest.main()
