#!/usr/bin/env python3
"""Qualify serial, lossless workerd Host drain against one local k3d Cell."""

import argparse
import copy
import importlib.util
import json
import os
import pathlib
import time
import urllib.parse
import uuid


HERE = pathlib.Path(__file__).resolve().parent
AUTOSCALING_MODULE = HERE.parent / "workerd-autoscaling-e2e" / "run.py"
SPEC = importlib.util.spec_from_file_location("workerd_autoscaling_e2e", AUTOSCALING_MODULE)
autoscaling = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(autoscaling)
capacity = autoscaling.capacity

NAMESPACE = "actor-fdb-cell-system"
CONTROLLER_NAME = "workerd-host-drain-e2e"
STATE_ANNOTATION = "fleet.actor.dev/workerd-host-drain-state"


def ordinal(pod_name):
	try:
		return int(pod_name.rsplit("-", 1)[1])
	except (IndexError, ValueError) as error:
		raise ValueError(f"invalid StatefulSet Pod name: {pod_name}") from error


def retained_actor_set(actors, owners, target_label):
	targets = [actor for actor in actors if owners[actor.actor_id] == [target_label]]
	others = [actor for actor in actors if owners[actor.actor_id] != [target_label]]
	if not targets or not others:
		raise ValueError(f"both target and remaining Host need an actor: {owners}")
	return {targets[0].actor_id, others[0].actor_id}, targets[0]


class Harness(autoscaling.Harness):
	def __init__(self, args):
		super().__init__(args)
		self.controller_installed = False
		self.evidence = {
			"schema": "rivet-workerd-host-drain-e2e/v1",
			"cell": args.cell,
			"cluster": args.cluster,
			"capacity_per_host": args.capacity,
			"started_at_unix_ms": int(time.time() * 1000),
			"phases": {},
		}

	def preflight_drain(self):
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
		if len(self.compute_nodes()) != 1:
			raise RuntimeError("qualification requires exactly one initial compute Node")
		try:
			self.kubectl.run("get", "deployment", CONTROLLER_NAME)
		except RuntimeError:
			pass
		else:
			raise RuntimeError(f"refusing to replace existing Deployment {CONTROLLER_NAME}")

	def scale_hosts_to_two(self):
		self.kubectl.run("scale", f"statefulset/{self.statefulset}", "--replicas=2")
		self.kubectl.run(
			"rollout", "status", f"statefulset/{self.statefulset}", "--timeout=10m", timeout=630
		)

	def controller_resources(self):
		labels = {"app.kubernetes.io/name": CONTROLLER_NAME}
		return [
			{
				"apiVersion": "v1",
				"kind": "ServiceAccount",
				"metadata": {"name": CONTROLLER_NAME, "namespace": NAMESPACE},
			},
			{
				"apiVersion": "rbac.authorization.k8s.io/v1",
				"kind": "Role",
				"metadata": {"name": CONTROLLER_NAME, "namespace": NAMESPACE},
				"rules": [
					{"apiGroups": [""], "resources": ["pods"], "verbs": ["get", "list"]},
					{
						"apiGroups": [""],
						"resources": ["secrets"],
						"resourceNames": [self.secret],
						"verbs": ["get"],
					},
					{
						"apiGroups": ["apps"],
						"resources": ["statefulsets"],
						"verbs": ["get", "patch"],
					},
				],
			},
			{
				"apiVersion": "rbac.authorization.k8s.io/v1",
				"kind": "RoleBinding",
				"metadata": {"name": CONTROLLER_NAME, "namespace": NAMESPACE},
				"roleRef": {
					"apiGroup": "rbac.authorization.k8s.io",
					"kind": "Role",
					"name": CONTROLLER_NAME,
				},
				"subjects": [
					{"kind": "ServiceAccount", "name": CONTROLLER_NAME, "namespace": NAMESPACE}
				],
			},
			{
				"apiVersion": "apps/v1",
				"kind": "Deployment",
				"metadata": {"name": CONTROLLER_NAME, "namespace": NAMESPACE},
				"spec": {
					"replicas": 1,
					"selector": {"matchLabels": labels},
					"template": {
						"metadata": {"labels": labels},
						"spec": {
							"serviceAccountName": CONTROLLER_NAME,
							"nodeSelector": {"rivet.dev/control": "true"},
							"containers": [
								{
									"name": "controller",
									"image": self.args.controller_image,
									"imagePullPolicy": "IfNotPresent",
									"command": ["/usr/local/bin/workerd-host-drain-controller"],
									"env": [
										{
											"name": "CELL_NAMESPACE",
											"valueFrom": {
												"fieldRef": {"fieldPath": "metadata.namespace"}
											},
										},
										{"name": "CELL_NAME", "value": self.args.cell},
										{"name": "HOST_DRAIN_MIN_REPLICAS", "value": "1"},
										{
											"name": "HOST_DRAIN_MAX_REMAINING_USAGE_PERCENT",
											"value": "70",
										},
										{"name": "HOST_DRAIN_STABILIZATION", "value": "1s"},
										{"name": "HOST_DRAIN_TIMEOUT", "value": "2m"},
										{"name": "HOST_DRAIN_RECONCILE_INTERVAL", "value": "250ms"},
									],
									"securityContext": {
										"allowPrivilegeEscalation": False,
										"capabilities": {"drop": ["ALL"]},
										"readOnlyRootFilesystem": True,
										"runAsNonRoot": True,
									},
								},
							],
						},
					},
				},
			},
		]

	def install_controller(self):
		autoscaling.run_command(
			["k3d", "image", "import", self.args.controller_image, "--cluster", self.args.cluster],
			timeout=300,
		)
		manifest = {
			"apiVersion": "v1",
			"kind": "List",
			"items": self.controller_resources(),
		}
		self.kubectl.run("apply", "-f", "-", input_text=json.dumps(manifest))
		self.controller_installed = True
		self.kubectl.run(
			"rollout", "status", f"deployment/{CONTROLLER_NAME}", "--timeout=5m", timeout=330
		)

	def state(self):
		statefulset = self.kubectl.json("get", "statefulset", self.statefulset)
		raw = statefulset.get("metadata", {}).get("annotations", {}).get(STATE_ANNOTATION)
		return json.loads(raw) if raw else {"phase": "Idle", "epoch": 0}

	def wait_serial_scale_down(self, target):
		deadline = time.monotonic() + self.args.drain_timeout
		states = []
		seen = set()
		last = None
		while time.monotonic() < deadline:
			statefulset = self.kubectl.json("get", "statefulset", self.statefulset)
			state = self.state()
			key = (state.get("phase"), state.get("targetName"), state.get("epoch"))
			if key not in seen:
				seen.add(key)
				states.append(state)
			last = {"state": state, "replicas": statefulset["spec"]["replicas"]}
			if (
				statefulset["spec"]["replicas"] == 1
				and state.get("phase") == "Idle"
				and state.get("epoch", 0) >= 1
			):
				break
			time.sleep(0.25)
		else:
			raise TimeoutError(f"serial Host drain did not converge: {last}")
		pods = self.kubectl.json(
			"get",
			"pods",
			"-l",
			f"fleet.actor.dev/cell-name={self.args.cell},fleet.actor.dev/component=workerd-host",
		)["items"]
		if any(item["metadata"]["name"] == target.pod for item in pods):
			raise RuntimeError(f"selected Host {target.pod} still exists after scale-down")
		if any(state.get("targetName") not in (None, target.pod) for state in states):
			raise RuntimeError(f"controller selected more than one Host: {states}")
		return states

	def run(self):
		self.preflight_drain()
		self.configure_allocator()
		self.patch_required_anti_affinity()
		node = json.loads(self.create_compute_node())
		self.scale_hosts_to_two()
		self.start_engine_forward()
		self.refresh_hosts(2)
		baseline = self.wait_empty()
		self.evidence["phases"]["baseline"] = {
			"compute_nodes": self.compute_nodes(),
			"new_node": node["metadata"]["name"],
			"hosts": [{"pod": host.pod, "uid": host.uid, "node": host.node} for host in self.hosts],
			"stats": baseline,
		}

		live = []
		for index in range(self.args.capacity + 1):
			live.append(self.create_actor(f"drain-{index}"))
			self.wait_ownership(live)
		owners = self.wait_ownership(live)
		target = max(self.hosts, key=lambda host: ordinal(host.pod))
		keep_ids, migrating_actor = retained_actor_set(live, owners, target.label)
		for actor in list(live):
			if actor.actor_id in keep_ids:
				continue
			self.delete_actor(actor)
			self.wait_actor_absent(actor)
			self.actors.remove(actor)
			live.remove(actor)
		owners_before = self.wait_ownership(live)
		before = capacity.request_json(
			"POST",
			self.actor_url(migrating_actor.actor_id, "/increment"),
			timeout=self.args.request_timeout,
		)
		if before.get("count") != 1:
			raise RuntimeError(f"pre-drain durable counter was not committed: {before}")
		self.evidence["phases"]["selected"] = {
			"target_pod": target.pod,
			"target_uid": target.uid,
			"target_node": target.node,
			"actors": [actor.actor_id for actor in live],
			"owners": owners_before,
			"durable_counter": before,
		}

		self.install_controller()
		states = self.wait_serial_scale_down(target)
		self.refresh_hosts(1)
		owners_after = self.wait_ownership(live, timeout=self.args.actor_timeout)
		after = capacity.request_json(
			"GET",
			self.actor_url(migrating_actor.actor_id),
			timeout=self.args.request_timeout,
		)
		if after.get("count") != before["count"]:
			raise RuntimeError(f"actor state changed across Host drain: before={before}, after={after}")
		if after.get("generation", 0) <= before.get("generation", 0):
			raise RuntimeError(f"drained actor did not restart in a newer generation: {after}")
		if any(labels != ["host-0"] for labels in owners_after.values()):
			raise RuntimeError(f"actors did not converge on the retained Host: {owners_after}")
		self.evidence["phases"]["converged"] = {
			"states": states,
			"replicas": 1,
			"owners": owners_after,
			"durable_counter": after,
			"remaining_host": self.hosts[0].pod,
		}
		self.evidence["verdict"] = "passed"

	def cleanup(self):
		cleanup_errors = []
		if self.controller_installed:
			for kind in ("deployment", "rolebinding", "role", "serviceaccount"):
				try:
					self.kubectl.run("delete", kind, CONTROLLER_NAME, "--ignore-not-found")
				except Exception as error:
					cleanup_errors.append(f"delete {kind}: {error}")
			self.controller_installed = False
		try:
			statefulset = self.kubectl.json("get", "statefulset", self.statefulset)
			if STATE_ANNOTATION in statefulset.get("metadata", {}).get("annotations", {}):
				self.kubectl.run(
					"annotate", "statefulset", self.statefulset, f"{STATE_ANNOTATION}-"
				)
		except Exception as error:
			cleanup_errors.append(f"remove state annotation: {error}")
		try:
			# Remove actors and close Pod port-forwards before restoring affinity;
			# changing the Pod template restarts the retained Host immediately.
			capacity.Harness.cleanup(self)
		except Exception as error:
			cleanup_errors.append(f"base cleanup: {error}")
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
				self.kubectl.run(
					"rollout",
					"status",
					f"statefulset/{self.statefulset}",
					"--timeout=10m",
					timeout=630,
				)
			except Exception as error:
				cleanup_errors.append(f"restore StatefulSet affinity: {error}")
		try:
			self.delete_created_node()
		except Exception as error:
			cleanup_errors.append(f"delete qualification Node: {error}")
		if cleanup_errors:
			self.evidence.setdefault("cleanup_errors", []).extend(cleanup_errors)


def default_output():
	agents_dir = pathlib.Path(os.environ.get("AGENTS_DIR", pathlib.Path.home() / ".agents"))
	stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
	return agents_dir / "benchmarks/local-mesh/workerd-host-drain-e2e" / f"{stamp}.json"


def parse_args():
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("--kubeconfig", type=pathlib.Path, required=True)
	parser.add_argument("--cluster", required=True)
	parser.add_argument("--cell", default="local-runtime-a")
	parser.add_argument("--controller-image", required=True)
	parser.add_argument("--capacity", type=int, default=4)
	parser.add_argument("--request-timeout", type=float, default=60)
	parser.add_argument("--actor-timeout", type=float, default=300)
	parser.add_argument("--failure-timeout", type=float, default=300)
	parser.add_argument("--settle-timeout", type=float, default=180)
	parser.add_argument("--pod-timeout", type=float, default=600)
	parser.add_argument("--drain-timeout", type=float, default=300)
	parser.add_argument("--max-generation", type=int, default=32)
	parser.add_argument("--hosts", type=int, default=2)
	parser.add_argument("--output", type=pathlib.Path, default=default_output())
	args = parser.parse_args()
	if not args.kubeconfig.is_file():
		parser.error(f"kubeconfig does not exist: {args.kubeconfig}")
	if not args.cluster.startswith("rivet-runtime-"):
		parser.error("cluster must be an explicit local rivet-runtime-* k3d cluster")
	if args.capacity < 2 or args.capacity > 128:
		parser.error("capacity must be between 2 and 128")
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
