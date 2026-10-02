#!/usr/bin/env python3
"""Qualify actor-driven workerd Pod and compute-Node autoscaling on local k3d."""

import argparse
import copy
import hashlib
import importlib.util
import json
import os
import pathlib
import subprocess
import time
import uuid


HERE = pathlib.Path(__file__).resolve().parent
CAPACITY_MODULE = HERE.parent / "workerd-capacity-e2e" / "run.py"
SPEC = importlib.util.spec_from_file_location("workerd_capacity_e2e", CAPACITY_MODULE)
capacity = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(capacity)

NAMESPACE = "actor-fdb-cell-system"
ADAPTER_RELEASE = "workerd-autoscaling-e2e-adapter"
ADAPTER_VERSION = "5.3.0"
ADAPTER_SHA256 = "aa6752b6207ed788522714c3ef7f67f27d423eb4d9512fecb52dc641b6434f31"
ADAPTER_OCI = "oci://ghcr.io/prometheus-community/charts/prometheus-adapter"


def run_command(arguments, timeout=300):
	result = subprocess.run(
		arguments,
		text=True,
		stdout=subprocess.PIPE,
		stderr=subprocess.PIPE,
		timeout=timeout,
	)
	if result.returncode != 0:
		raise RuntimeError(
			f"command failed ({result.returncode}): {' '.join(arguments)}\n{result.stderr}"
		)
	return result.stdout


def condition_is_unschedulable(pod):
	for condition in pod.get("status", {}).get("conditions", []):
		if (
			condition.get("type") == "PodScheduled"
			and condition.get("status") == "False"
			and condition.get("reason") == "Unschedulable"
		):
			return True
	return False


def desired_replicas(active_actors, target_actors, minimum, maximum):
	if target_actors < 1:
		raise ValueError("target actors must be positive")
	return max(minimum, min(maximum, (active_actors + target_actors - 1) // target_actors))


class Harness(capacity.Harness):
	def __init__(self, args):
		super().__init__(args)
		self.hpa = f"{args.cell}-runtime-hosts-actor-capacity"
		self.original_affinity = None
		self.adapter_installed = False
		self.hpa_installed = False
		self.node_container = None
		self.node_name = None
		self.runtime_image = None
		self.evidence = {
			"schema": "rivet-workerd-autoscaling-e2e/v1",
			"cell": args.cell,
			"cluster": args.cluster,
			"capacity_per_host": args.capacity,
			"hpa_target_actors_per_host": args.capacity - 1,
			"started_at_unix_ms": int(time.time() * 1000),
			"phases": {},
		}

	def kubectl_all(self, *arguments, timeout=120):
		command = ["kubectl", "--kubeconfig", str(self.args.kubeconfig), *arguments]
		return run_command(command, timeout=timeout)

	def preflight(self):
		self.capture_original_state()
		if self.original_replicas != 1:
			raise RuntimeError(f"qualification requires one initial Host, got {self.original_replicas}")
		statefulset = self.kubectl.json("get", "statefulset", self.statefulset)
		self.original_affinity = copy.deepcopy(
			statefulset["spec"]["template"]["spec"].get("affinity")
		)
		self.runtime_image = next(
			container["image"]
			for container in statefulset["spec"]["template"]["spec"]["containers"]
			if container["name"] == "workerd"
		)
		try:
			self.kubectl.run("get", "horizontalpodautoscaler", self.hpa)
		except RuntimeError:
			pass
		else:
			raise RuntimeError(f"refusing to replace existing HPA {self.hpa}")
		api_services = json.loads(self.kubectl_all("get", "apiservice", "-o", "json"))
		if any(
			item["metadata"]["name"].endswith(".custom.metrics.k8s.io")
			for item in api_services["items"]
		):
			raise RuntimeError("refusing to replace an existing custom.metrics.k8s.io provider")
		compute_nodes = self.compute_nodes()
		if len(compute_nodes) != 1:
			raise RuntimeError(f"qualification requires one initial compute Node, got {compute_nodes}")

	def compute_nodes(self):
		payload = json.loads(
			self.kubectl_all("get", "nodes", "-l", "rivet.dev/compute=true", "-o", "json")
		)
		return sorted(item["metadata"]["name"] for item in payload["items"])

	def k3d_nodes(self):
		payload = json.loads(run_command(["k3d", "node", "list", "-o", "json"]))
		return {
			item["name"]
			for item in payload
			if item.get("runtimeLabels", {}).get("k3d.cluster") == self.args.cluster
		}

	def ensure_adapter_chart(self):
		agents_dir = pathlib.Path(os.environ.get("AGENTS_DIR", pathlib.Path.home() / ".agents"))
		cache = agents_dir / "cache" / f"prometheus-adapter-{ADAPTER_VERSION}.tgz"
		cache.parent.mkdir(parents=True, exist_ok=True)
		if not cache.exists():
			run_command(
				[
					"helm",
					"pull",
					ADAPTER_OCI,
					"--version",
					ADAPTER_VERSION,
					"--destination",
					str(cache.parent),
				],
				timeout=180,
			)
		actual = hashlib.sha256(cache.read_bytes()).hexdigest()
		if actual != ADAPTER_SHA256:
			raise RuntimeError(f"Prometheus Adapter chart SHA-256 mismatch: {actual}")
		return cache

	def install_adapter(self):
		chart = self.ensure_adapter_chart()
		run_command(
			[
				"helm",
				"--kubeconfig",
				str(self.args.kubeconfig),
				"upgrade",
				"--install",
				ADAPTER_RELEASE,
				str(chart),
				"--namespace",
				"observability",
				"--values",
				str(HERE / "adapter-values.yaml"),
				"--atomic",
				"--wait",
				"--timeout",
				"10m",
			],
			timeout=660,
		)
		self.adapter_installed = True
		deadline = time.monotonic() + self.args.adapter_timeout
		while time.monotonic() < deadline:
			try:
				payload = json.loads(
					self.kubectl_all("get", "apiservice", "v1beta1.custom.metrics.k8s.io", "-o", "json")
				)
				if any(
					condition.get("type") == "Available" and condition.get("status") == "True"
					for condition in payload.get("status", {}).get("conditions", [])
				):
					return
			except Exception:
				pass
			time.sleep(2)
		raise TimeoutError("custom metrics API did not become Available")

	def patch_required_anti_affinity(self):
		affinity = copy.deepcopy(self.original_affinity) or {}
		affinity["podAntiAffinity"] = {
			"requiredDuringSchedulingIgnoredDuringExecution": [
				{
					"labelSelector": {
						"matchLabels": {
							"fleet.actor.dev/cell-name": self.args.cell,
							"fleet.actor.dev/component": "workerd-host",
						}
					},
					"topologyKey": "kubernetes.io/hostname",
				}
			]
		}
		patch = {"spec": {"template": {"spec": {"affinity": affinity}}}}
		self.kubectl.run(
			"patch", "statefulset", self.statefulset, "--type=merge", "-p", json.dumps(patch)
		)
		self.kubectl.run(
			"rollout", "status", f"statefulset/{self.statefulset}", "--timeout=10m", timeout=630
		)

	def install_hpa(self):
		target = self.args.capacity - 1
		if target < 1:
			raise RuntimeError("capacity must leave at least one occupied target slot")
		hpa = {
			"apiVersion": "autoscaling/v2",
			"kind": "HorizontalPodAutoscaler",
			"metadata": {"name": self.hpa, "namespace": NAMESPACE},
			"spec": {
				"minReplicas": 1,
				"maxReplicas": 2,
				"scaleTargetRef": {
					"apiVersion": "apps/v1",
					"kind": "StatefulSet",
					"name": self.statefulset,
				},
				"behavior": {
					"scaleUp": {
						"stabilizationWindowSeconds": 0,
						"selectPolicy": "Max",
						"policies": [{"type": "Pods", "value": 1, "periodSeconds": 15}],
					},
					"scaleDown": {
						# Scale-in is owned by the serial Host drain controller. HPA remains
						# scale-up-only so it can never delete a Pod with live actors.
						"selectPolicy": "Disabled",
					},
				},
				"metrics": [
					{
						"type": "Pods",
						"pods": {
							"metric": {"name": "rivet_workerd_active_actors"},
							"target": {"type": "AverageValue", "averageValue": str(target)},
						},
					}
				],
			},
		}
		self.kubectl.run("apply", "-f", "-", input_text=json.dumps(hpa))
		self.hpa_installed = True

	def start_engine_forward(self):
		self.engine_forward = capacity.PortForward(
			self.kubectl, f"service/{self.args.cell}-engine", 6420
		)
		self.engine_forward.start()

	def refresh_hosts(self, expected):
		for host in self.hosts:
			host.forward.stop()
		self.hosts = []
		deadline = time.monotonic() + self.args.pod_timeout
		pods = []
		while time.monotonic() < deadline:
			payload = self.kubectl.json(
				"get",
				"pods",
				"-l",
				f"fleet.actor.dev/cell-name={self.args.cell},fleet.actor.dev/component=workerd-host",
			)
			pods = []
			for item in payload["items"]:
				ready = any(
					condition.get("type") == "Ready" and condition.get("status") == "True"
					for condition in item.get("status", {}).get("conditions", [])
				)
				if ready:
					pods.append(
						(
							item["metadata"]["name"],
							item["metadata"]["uid"],
							item["spec"]["nodeName"],
						)
					)
			pods.sort()
			if len(pods) == expected:
				break
			time.sleep(1)
		if len(pods) != expected:
			raise TimeoutError(f"expected {expected} Ready Hosts, got {pods}")
		for index, (pod, uid, node) in enumerate(pods):
			forward = capacity.PortForward(self.kubectl, f"pod/{pod}", 18081)
			forward.start()
			self.hosts.append(capacity.Host(f"host-{index}", pod, uid, node, forward))

	def wait_hpa_replicas(self, replicas):
		deadline = time.monotonic() + self.args.hpa_timeout
		last = None
		while time.monotonic() < deadline:
			last = self.kubectl.json("get", "horizontalpodautoscaler", self.hpa)
			statefulset = self.kubectl.json("get", "statefulset", self.statefulset)
			if statefulset["spec"]["replicas"] == replicas:
				return last
			time.sleep(2)
		raise TimeoutError(f"HPA did not select {replicas} replicas: {last}")

	def wait_unschedulable_ordinal(self, ordinal):
		name = f"{self.statefulset}-{ordinal}"
		deadline = time.monotonic() + self.args.pod_timeout
		last = None
		while time.monotonic() < deadline:
			try:
				last = self.kubectl.json("get", "pod", name)
				if condition_is_unschedulable(last):
					return last
			except Exception:
				pass
			time.sleep(1)
		raise TimeoutError(f"Pod {name} did not become Unschedulable: {last}")

	def create_compute_node(self):
		short = f"workerd-e2e-{uuid.uuid4().hex[:8]}"
		before = self.k3d_nodes()
		try:
			run_command(
				[
					"k3d",
					"node",
					"create",
					short,
					"--cluster",
					self.args.cluster,
					"--role",
					"agent",
					"--k3s-node-label",
					"rivet.dev/compute=true",
					"--wait",
					"--timeout",
					"5m",
				],
				timeout=330,
			)
		finally:
			created = self.k3d_nodes() - before
			if len(created) == 1:
				self.node_container = next(iter(created))
				self.node_name = self.node_container
		if self.node_container is None:
			raise RuntimeError(f"k3d did not create exactly one Node; before={sorted(before)}")
		self.kubectl_all(
			"taint",
			"node",
			self.node_name,
			"rivet.dev/compute=true:NoSchedule",
			"--overwrite",
		)
		run_command(
			["k3d", "image", "import", self.runtime_image, "--cluster", self.args.cluster],
			timeout=300,
		)
		return self.kubectl_all("get", "node", self.node_name, "-o", "json")

	def delete_created_node(self):
		if self.node_container is None:
			return
		node_container = self.node_container
		node_name = self.node_name
		try:
			self.kubectl_all("cordon", node_name)
		except Exception:
			pass
		try:
			run_command(["k3d", "node", "delete", node_container], timeout=180)
		finally:
			# k3d removes the agent container but intentionally leaves the Kubernetes
			# Node object to age NotReady. A cloud provider removes both; complete that
			# exact provider-side lifecycle here before allowing another Pod rollout.
			self.kubectl_all("delete", "node", node_name, "--ignore-not-found")
		self.node_container = None
		self.node_name = None

	def run(self):
		self.preflight()
		self.configure_allocator()
		self.patch_required_anti_affinity()
		self.install_adapter()
		self.install_hpa()
		self.start_engine_forward()
		self.refresh_hosts(1)
		baseline = self.wait_empty()
		self.evidence["phases"]["baseline"] = {
			"compute_nodes": self.compute_nodes(),
			"replicas": 1,
			"stats": baseline,
		}

		live = []
		for index in range(self.args.capacity):
			actor = self.create_actor(f"fill-{index}")
			live.append(actor)
			self.wait_ownership(live)
		full_stats = self.read_stats()
		hpa = self.wait_hpa_replicas(2)
		pending_pod = self.wait_unschedulable_ordinal(1)
		self.evidence["phases"]["pod_scale_up"] = {
			"active_actors": len(live),
			"hpa": hpa.get("status", {}),
			"pending_pod": pending_pod["metadata"]["name"],
			"pending_pod_uid": pending_pod["metadata"]["uid"],
			"unschedulable": True,
			"stats": full_stats,
		}

		pending_actor = self.create_actor("pending-node")
		live.append(pending_actor)
		pending_control = self.wait_pending_no_envoys(pending_actor)
		node = json.loads(self.create_compute_node())
		self.refresh_hosts(2)
		owners = self.wait_ownership(live, timeout=self.args.actor_timeout)
		if owners[pending_actor.actor_id] != ["host-1"]:
			raise RuntimeError(f"pending Actor did not spill to new Host: {owners}")
		if self.hosts[1].node != self.node_name:
			raise RuntimeError(
				f"new Host landed on {self.hosts[1].node}, expected qualification Node {self.node_name}"
			)
		self.evidence["phases"]["node_scale_up"] = {
			"pending_actor_id": pending_actor.actor_id,
			"pending_actor_error": pending_control.get("error"),
			"node": self.node_name,
			"node_uid": node["metadata"]["uid"],
			"host_pod": self.hosts[1].pod,
			"host_pod_uid": self.hosts[1].uid,
			"owners": owners,
			"compute_nodes": self.compute_nodes(),
		}

		for actor in list(live):
			self.delete_actor(actor)
			self.wait_actor_absent(actor)
			self.actors.remove(actor)
		self.wait_empty()
		# Give the HPA more than one reconcile interval and prove it cannot own
		# scale-in. The dedicated Host-drain E2E qualifies the active-actor path;
		# this empty manual scale is only bounded test-environment cleanup.
		time.sleep(20)
		down_hpa = self.kubectl.json("get", "horizontalpodautoscaler", self.hpa)
		statefulset = self.kubectl.json("get", "statefulset", self.statefulset)
		if statefulset["spec"]["replicas"] != 2:
			raise RuntimeError("scale-up HPA unexpectedly performed a direct Host scale-down")
		self.kubectl.run("scale", f"statefulset/{self.statefulset}", "--replicas=1")
		deadline = time.monotonic() + self.args.pod_timeout
		while time.monotonic() < deadline:
			pods = self.kubectl.json(
				"get",
				"pods",
				"-l",
				f"fleet.actor.dev/cell-name={self.args.cell},fleet.actor.dev/component=workerd-host",
			)["items"]
			if len(pods) == 1:
				break
			time.sleep(1)
		else:
			raise TimeoutError("runtime Host ordinal 1 did not terminate after HPA scale-down")
		if pods[0].get("spec", {}).get("nodeName") == self.node_name:
			raise RuntimeError("remaining Host unexpectedly moved to the Node selected for scale-down")
		for host in self.hosts:
			host.forward.stop()
		self.hosts = []
		removed_node = self.node_name
		self.delete_created_node()
		if len(self.compute_nodes()) != 1:
			raise RuntimeError("qualification compute Node did not scale down cleanly")
		self.evidence["phases"]["scale_down_handoff"] = {
			"hpa": down_hpa.get("status", {}),
			"direct_hpa_scale_down_disabled": True,
			"replicas": 1,
			"removed_node": removed_node,
			"compute_nodes": self.compute_nodes(),
		}
		self.evidence["verdict"] = "passed"

	def cleanup(self):
		cleanup_errors = []
		if self.hpa_installed:
			try:
				self.kubectl.run("delete", "horizontalpodautoscaler", self.hpa, "--ignore-not-found")
			except Exception as error:
				cleanup_errors.append(f"delete HPA: {error}")
			self.hpa_installed = False
		if self.original_affinity is not None or self.original_replicas is not None:
			try:
				patch = {
					"spec": {
						"replicas": self.original_replicas,
						"template": {"spec": {"affinity": self.original_affinity}},
					}
				}
				self.kubectl.run(
					"patch", "statefulset", self.statefulset, "--type=merge", "-p", json.dumps(patch)
				)
			except Exception as error:
				cleanup_errors.append(f"restore StatefulSet: {error}")
		try:
			super().cleanup()
		except Exception as error:
			cleanup_errors.append(f"base cleanup: {error}")
		try:
			self.delete_created_node()
		except Exception as error:
			cleanup_errors.append(f"delete qualification Node: {error}")
		if self.adapter_installed:
			try:
				run_command(
					[
						"helm",
						"--kubeconfig",
						str(self.args.kubeconfig),
						"uninstall",
						ADAPTER_RELEASE,
						"--namespace",
						"observability",
					],
					timeout=180,
				)
			except Exception as error:
				cleanup_errors.append(f"uninstall Prometheus Adapter: {error}")
			self.adapter_installed = False
		if cleanup_errors:
			self.evidence.setdefault("cleanup_errors", []).extend(cleanup_errors)


def default_output():
	agents_dir = pathlib.Path(os.environ.get("AGENTS_DIR", pathlib.Path.home() / ".agents"))
	stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
	return agents_dir / "benchmarks/local-mesh/workerd-autoscaling-e2e" / f"{stamp}.json"


def parse_args():
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("--kubeconfig", type=pathlib.Path, required=True)
	parser.add_argument("--cluster", required=True)
	parser.add_argument("--cell", default="local-runtime-b")
	parser.add_argument("--capacity", type=int, default=4)
	parser.add_argument("--request-timeout", type=float, default=20)
	parser.add_argument("--actor-timeout", type=float, default=300)
	parser.add_argument("--failure-timeout", type=float, default=300)
	parser.add_argument("--settle-timeout", type=float, default=180)
	parser.add_argument("--adapter-timeout", type=float, default=180)
	parser.add_argument("--hpa-timeout", type=float, default=300)
	parser.add_argument("--pod-timeout", type=float, default=600)
	parser.add_argument("--max-generation", type=int, default=32)
	parser.add_argument("--hosts", type=int, default=2)
	parser.add_argument("--output", type=pathlib.Path, default=default_output())
	args = parser.parse_args()
	if not args.kubeconfig.is_file():
		parser.error(f"kubeconfig does not exist: {args.kubeconfig}")
	if args.capacity < 2 or args.capacity > 128:
		parser.error("capacity must be between 2 and 128")
	if not args.cluster.startswith("rivet-runtime-"):
		parser.error("cluster must be an explicit local rivet-runtime-* k3d cluster")
	return args


def main():
	args = parse_args()
	harness = Harness(args)
	failure = None
	try:
		harness.run()
	except BaseException as error:
		failure = error
		harness.evidence["verdict"] = "failed"
		harness.evidence["error"] = {"type": type(error).__name__, "message": str(error)}
	finally:
		harness.cleanup()
		harness.evidence["finished_at_unix_ms"] = int(time.time() * 1000)
		capacity.write_receipt(args.output, harness.evidence)
	print(json.dumps(harness.evidence, indent=2, sort_keys=True))
	print(f"receipt: {args.output}")
	if failure is not None:
		raise failure
	if harness.evidence.get("cleanup_errors"):
		raise RuntimeError("qualification passed but cleanup did not complete")


if __name__ == "__main__":
	main()
