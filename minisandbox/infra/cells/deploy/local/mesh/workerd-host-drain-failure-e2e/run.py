#!/usr/bin/env python3
"""Inject bounded failures into the serial workerd Host drain controller."""

import argparse
import copy
import importlib.util
import json
import os
import pathlib
import time
import uuid


HERE = pathlib.Path(__file__).resolve().parent
HAPPY_MODULE = HERE.parent / "workerd-host-drain-e2e" / "run.py"
SPEC = importlib.util.spec_from_file_location("workerd_host_drain_e2e", HAPPY_MODULE)
happy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(happy)
capacity = happy.capacity
autoscaling = happy.autoscaling

CONTROLLER_NAME = happy.CONTROLLER_NAME
STATE_ANNOTATION = happy.STATE_ANNOTATION
ACTOR_NAMESPACE = capacity.ACTOR_NAMESPACE


def runner_config_body(response):
	configs = response.get("runner_configs", {}).get("workerd", {}).get("datacenters")
	if not isinstance(configs, dict) or not configs:
		raise ValueError(f"workerd runner config is missing: {response}")
	clean = {}
	for datacenter, config in configs.items():
		if not isinstance(config, dict):
			raise ValueError(f"invalid runner config for {datacenter}: {config}")
		config = copy.deepcopy(config)
		config.pop("protocol_version", None)
		clean[datacenter] = config
	return {"datacenters": clean}


def with_eviction_delay(body, datacenter, seconds):
	updated = copy.deepcopy(body)
	config = updated["datacenters"].get(datacenter)
	if not isinstance(config, dict) or "normal" not in config:
		raise ValueError(f"{datacenter} is not a normal workerd runner: {body}")
	config["normal"]["actor_eviction_delay"] = seconds
	return updated


class Harness(happy.Harness):
	def __init__(self, args):
		super().__init__(args)
		self.controller_settings = {}
		self.original_runner_config = None
		self.image_imported = False
		self.extra_node_containers = []
		self.evidence = {
			"schema": "rivet-workerd-host-drain-failure-e2e/v1",
			"cell": args.cell,
			"cluster": args.cluster,
			"capacity_per_host": args.capacity,
			"started_at_unix_ms": int(time.time() * 1000),
			"scenarios": {},
		}

	def controller_resources(self):
		resources = super().controller_resources()
		deployment = next(item for item in resources if item["kind"] == "Deployment")
		container = deployment["spec"]["template"]["spec"]["containers"][0]
		environment = {item["name"]: item for item in container["env"]}
		for name, value in self.controller_settings.items():
			environment[name] = {"name": name, "value": str(value)}
		container["env"] = list(environment.values())
		return resources

	def import_controller_image(self):
		if self.image_imported:
			return
		autoscaling.run_command(
			["k3d", "image", "import", self.args.controller_image, "--cluster", self.args.cluster],
			timeout=300,
		)
		self.image_imported = True

	def create_extra_compute_node(self):
		"""Add capacity for the concurrent scale-up case without stealing parent cleanup state."""
		short = f"workerd-drain-e2e-{uuid.uuid4().hex[:8]}"
		before = self.k3d_nodes()
		autoscaling.run_command(
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
		created = self.k3d_nodes() - before
		if len(created) != 1:
			raise RuntimeError(f"k3d did not create one extra compute Node: {sorted(created)}")
		node = next(iter(created))
		self.extra_node_containers.append(node)
		self.kubectl_all(
			"taint", "node", node, "rivet.dev/compute=true:NoSchedule", "--overwrite"
		)
		autoscaling.run_command(
			["k3d", "image", "import", self.runtime_image, "--cluster", self.args.cluster],
			timeout=300,
		)
		return json.loads(self.kubectl_all("get", "node", node, "-o", "json"))

	def delete_extra_compute_nodes(self):
		errors = []
		for node in reversed(self.extra_node_containers):
			try:
				try:
					autoscaling.run_command(["k3d", "node", "delete", node], timeout=180)
				finally:
					# k3d intentionally leaves the Kubernetes Node object behind;
					# model the cloud-provider deletion half as the parent harness does.
					self.kubectl_all("delete", "node", node, "--ignore-not-found")
			except Exception as error:
				errors.append(f"delete extra compute Node {node}: {error}")
		self.extra_node_containers = []
		if errors:
			raise RuntimeError("; ".join(errors))

	def start_controller(self, **settings):
		self.stop_controller(delete=True)
		self.controller_settings = {
			"HOST_DRAIN_STABILIZATION": "1s",
			"HOST_DRAIN_TIMEOUT": "20s",
			"HOST_DRAIN_RECONCILE_INTERVAL": "1s",
			**settings,
		}
		manifest = {"apiVersion": "v1", "kind": "List", "items": self.controller_resources()}
		self.kubectl.run("apply", "-f", "-", input_text=json.dumps(manifest))
		self.controller_installed = True
		self.kubectl.run(
			"rollout", "status", f"deployment/{CONTROLLER_NAME}", "--timeout=5m", timeout=330
		)
		return self.controller_pod()

	def stop_controller(self, delete=False):
		try:
			if delete:
				self.kubectl.run("delete", "deployment", CONTROLLER_NAME, "--ignore-not-found")
			else:
				self.kubectl.run("scale", f"deployment/{CONTROLLER_NAME}", "--replicas=0")
		except RuntimeError:
			pass

	def resume_controller(self):
		self.kubectl.run("scale", f"deployment/{CONTROLLER_NAME}", "--replicas=1")
		self.kubectl.run(
			"rollout", "status", f"deployment/{CONTROLLER_NAME}", "--timeout=5m", timeout=330
		)
		return self.controller_pod()

	def controller_pod(self):
		deadline = time.monotonic() + 120
		last = None
		while time.monotonic() < deadline:
			items = self.kubectl.json(
				"get", "pods", "-l", f"app.kubernetes.io/name={CONTROLLER_NAME}"
			)["items"]
			for item in items:
				ready = any(
					condition.get("type") == "Ready" and condition.get("status") == "True"
					for condition in item.get("status", {}).get("conditions", [])
				)
				if ready:
					return {"name": item["metadata"]["name"], "uid": item["metadata"]["uid"]}
			last = items
			time.sleep(0.25)
		raise TimeoutError(f"controller Pod did not become Ready: {last}")

	def restart_controller_pod(self):
		before = self.controller_pod()
		self.kubectl.run("delete", "pod", before["name"], "--wait=false")
		deadline = time.monotonic() + 120
		while time.monotonic() < deadline:
			after = self.controller_pod()
			if after["uid"] != before["uid"]:
				return before, after
			time.sleep(0.25)
		raise TimeoutError("controller Pod UID did not change")

	def wait_controller_absent(self):
		deadline = time.monotonic() + 120
		while time.monotonic() < deadline:
			items = self.kubectl.json(
				"get", "pods", "-l", f"app.kubernetes.io/name={CONTROLLER_NAME}"
			)["items"]
			if not items:
				return
			time.sleep(0.25)
		raise TimeoutError("controller Pod did not stop")

	def wait_phase(self, phases, timeout=60, predicate=None):
		if isinstance(phases, str):
			phases = {phases}
		else:
			phases = set(phases)
		deadline = time.monotonic() + timeout
		last = None
		while time.monotonic() < deadline:
			last = self.state()
			if last.get("phase") in phases and (predicate is None or predicate(last)):
				return last
			time.sleep(0.05)
		raise TimeoutError(f"drain phase did not reach {sorted(phases)}: {last}")

	def host_for_pod(self, pod):
		return next(host for host in self.hosts if host.pod == pod)

	def wait_host_accepting(self, pod, accepting=True, timeout=30):
		deadline = time.monotonic() + timeout
		last = None
		while time.monotonic() < deadline:
			last = self.host_for_pod(pod).stats(self.token)
			if (
				last.get("host_accepting_actors") is accepting
				and last.get("host_draining") is (not accepting)
			):
				return last
			time.sleep(0.1)
		raise TimeoutError(f"Host {pod} did not reach accepting={accepting}: {last}")

	def set_runner_config(self, body):
		return capacity.request_json(
			"PUT",
			f"{self.engine_url}/runner-configs/workerd?namespace={ACTOR_NAMESPACE}",
			body,
			headers={"Authorization": f"Bearer {self.token}"},
			timeout=self.args.request_timeout,
		)

	def capture_and_delay_runner(self):
		response = capacity.request_json(
			"GET",
			f"{self.engine_url}/runner-configs?namespace={ACTOR_NAMESPACE}&runner_name=workerd",
			headers={"Authorization": f"Bearer {self.token}"},
			timeout=self.args.request_timeout,
		)
		self.original_runner_config = runner_config_body(response)
		self.set_runner_config(
			with_eviction_delay(self.original_runner_config, self.args.cell, self.args.eviction_delay)
		)
		self.restart_hosts(2)

	def restart_hosts(self, expected):
		for host in self.hosts:
			host.forward.stop()
		self.hosts = []
		self.kubectl.run("rollout", "restart", f"statefulset/{self.statefulset}")
		self.kubectl.run(
			"rollout", "status", f"statefulset/{self.statefulset}", "--timeout=10m", timeout=630
		)
		self.refresh_hosts(expected)

	def clear_state(self):
		statefulset = self.kubectl.json("get", "statefulset", self.statefulset)
		if STATE_ANNOTATION in statefulset.get("metadata", {}).get("annotations", {}):
			self.kubectl.run("annotate", "statefulset", self.statefulset, f"{STATE_ANNOTATION}-")

	def restore_host_fences(self):
		for host in self.hosts:
			capacity.request_json(
				"POST",
				f"{host.forward.base_url}/v1/sqlite/drain",
				{"draining": False},
				headers={"x-rivet-workerd-token": self.token},
				timeout=self.args.request_timeout,
			)

	def delete_scenario_actors(self):
		failed = []
		for actor in list(self.actors):
			try:
				self.delete_actor(actor)
			except Exception:
				failed.append(actor)
		self.actors = failed
		self.wait_empty()
		self.actors = []

	def reset_scenario(self):
		self.stop_controller(delete=True)
		self.delete_scenario_actors()
		statefulset = self.kubectl.json("get", "statefulset", self.statefulset)
		if statefulset["spec"]["replicas"] != 2:
			for host in self.hosts:
				host.forward.stop()
			self.hosts = []
			self.kubectl.run("scale", f"statefulset/{self.statefulset}", "--replicas=2")
			self.kubectl.run(
				"rollout", "status", f"statefulset/{self.statefulset}", "--timeout=10m", timeout=630
			)
			self.refresh_hosts(2)
		self.restore_host_fences()
		self.clear_state()

	def place_one_actor_per_host(self, suffix):
		live = []
		for index in range(self.args.capacity + 1):
			live.append(self.create_actor(f"{suffix}-{index}"))
			self.wait_ownership(live)
		owners = self.wait_ownership(live)
		target = max(self.hosts, key=lambda host: happy.ordinal(host.pod))
		keep_ids, target_actor = happy.retained_actor_set(live, owners, target.label)
		for actor in list(live):
			if actor.actor_id in keep_ids:
				continue
			self.delete_actor(actor)
			self.wait_actor_absent(actor)
			self.actors.remove(actor)
			live.remove(actor)
		owners = self.wait_ownership(live)
		return live, target, target_actor, owners

	def replicas(self):
		return self.kubectl.json("get", "statefulset", self.statefulset)["spec"]["replicas"]

	def scenario_management_unavailable(self):
		self.reset_scenario()
		self.start_controller(HOST_DRAIN_MANAGEMENT_PORT="19084")
		time.sleep(3)
		state = self.state()
		if self.replicas() != 2 or state.get("phase") not in (None, "Idle"):
			raise RuntimeError(f"unavailable management endpoint did not fail closed: {state}")
		logs = self.kubectl.run("logs", f"deployment/{CONTROLLER_NAME}")
		if "read Host" not in logs and "connection refused" not in logs:
			raise RuntimeError(f"controller did not report unavailable management evidence: {logs}")
		self.evidence["scenarios"]["management_unavailable"] = {
			"replicas": 2,
			"state": state,
			"failed_closed": True,
			"malformed_json_contract": "covered by hostdrain Go management client test",
		}

	def scenario_uid_replacement(self):
		self.reset_scenario()
		target = max(self.hosts, key=lambda host: happy.ordinal(host.pod))
		self.start_controller()
		selected = self.wait_phase("Selected")
		self.stop_controller()
		self.wait_controller_absent()
		old_uid = target.uid
		target.forward.stop()
		self.kubectl.run("delete", "pod", target.pod, "--wait=false")
		deadline = time.monotonic() + self.args.pod_timeout
		new_uid = None
		while time.monotonic() < deadline:
			try:
				pod = self.kubectl.json("get", "pod", target.pod)
			except RuntimeError as error:
				if "NotFound" not in str(error):
					raise
				time.sleep(0.25)
				continue
			ready = any(
				condition.get("type") == "Ready" and condition.get("status") == "True"
				for condition in pod.get("status", {}).get("conditions", [])
			)
			if ready and pod["metadata"]["uid"] != old_uid:
				new_uid = pod["metadata"]["uid"]
				break
			time.sleep(0.5)
		if new_uid is None:
			raise TimeoutError("replacement target Pod did not become Ready")
		self.refresh_hosts(2)
		self.resume_controller()
		recovered = self.wait_phase(
			{"Idle", "Observing"},
			predicate=lambda state: state.get("targetUID") != old_uid,
		)
		self.stop_controller()
		self.wait_controller_absent()
		stats = self.wait_host_accepting(target.pod, True)
		if self.replicas() != 2:
			raise RuntimeError("replacement Pod inherited the old scale-down")
		self.evidence["scenarios"]["target_uid_replacement"] = {
			"selected": selected,
			"old_uid": old_uid,
			"new_uid": new_uid,
			"recovered_state": recovered,
			"replacement_stats": stats,
			"replicas": 2,
		}

	def scenario_demand_burst(self):
		self.reset_scenario()
		live, target, target_actor, owners_before = self.place_one_actor_per_host("burst-base")
		generation_before = target_actor.generation
		self.start_controller()
		draining = self.wait_phase("Draining")
		self.wait_host_accepting(target.pod, False)
		burst = self.create_actor("burst-new-demand")
		live.append(burst)
		self.wait_ownership(live)
		aborting = self.wait_phase("Aborting")
		restored = self.wait_phase({"Idle", "Observing"})
		self.wait_host_accepting(target.pod, True)
		time.sleep(self.args.eviction_delay + 1)
		owners_after = self.wait_ownership(live)
		if self.replicas() != 2 or target_actor.generation != generation_before:
			raise RuntimeError("demand burst evicted the fenced actor or changed replicas")
		self.evidence["scenarios"]["demand_burst_abort"] = {
			"draining": draining,
			"aborting": aborting,
			"restored": restored,
			"owners_before": owners_before,
			"owners_after": owners_after,
			"target_generation": generation_before,
			"replicas": 2,
		}

	def scenario_scale_up_race(self):
		self.reset_scenario()
		live, target, _, _ = self.place_one_actor_per_host("scale-up")
		self.start_controller()
		draining = self.wait_phase("Draining")
		self.wait_host_accepting(target.pod, False)
		self.kubectl.run("scale", f"statefulset/{self.statefulset}", "--replicas=3")
		aborting = self.wait_phase("Aborting")
		restored = self.wait_phase({"Idle", "Observing"})
		self.wait_host_accepting(target.pod, True)
		if self.replicas() != 3:
			raise RuntimeError("drain controller overrode the concurrent scale-up")
		self.stop_controller()
		self.wait_controller_absent()
		self.kubectl.run("scale", f"statefulset/{self.statefulset}", "--replicas=2")
		self.kubectl.run(
			"rollout", "status", f"statefulset/{self.statefulset}", "--timeout=10m", timeout=630
		)
		owners = self.wait_ownership(live)
		self.evidence["scenarios"]["scale_up_wins"] = {
			"draining": draining,
			"aborting": aborting,
			"restored": restored,
			"replicas_before_test_cleanup": 3,
			"owners": owners,
		}

	def scenario_timeout(self):
		self.reset_scenario()
		live, target, target_actor, _ = self.place_one_actor_per_host("timeout")
		generation_before = target_actor.generation
		self.start_controller(HOST_DRAIN_TIMEOUT="2s")
		draining = self.wait_phase("Draining")
		aborting = self.wait_phase("Aborting", timeout=15)
		restored = self.wait_phase({"Idle", "Observing"})
		self.wait_host_accepting(target.pod, True)
		self.stop_controller()
		self.wait_controller_absent()
		time.sleep(self.args.eviction_delay + 1)
		owners = self.wait_ownership(live)
		if self.replicas() != 2 or target_actor.generation != generation_before:
			raise RuntimeError("timeout forced a scale-down or actor restart")
		self.evidence["scenarios"]["bounded_timeout_abort"] = {
			"draining": draining,
			"aborting": aborting,
			"restored": restored,
			"owners": owners,
			"target_generation": generation_before,
			"replicas": 2,
		}

	def scenario_controller_restarts(self):
		self.reset_scenario()
		live, target, _, owners_before = self.place_one_actor_per_host("controller-restart")
		self.start_controller(HOST_DRAIN_TIMEOUT="30s")
		selected = self.wait_phase("Selected")
		selected_before, selected_after = self.restart_controller_pod()
		resumed = self.wait_phase(
			{"Draining", "ReadyToScaleDown", "ScalingDown", "Converging"},
			predicate=lambda state: state.get("epoch") == selected.get("epoch")
			and state.get("targetUID") == selected.get("targetUID"),
			timeout=30,
		)
		scaling = self.wait_phase({"ScalingDown", "Converging"}, timeout=30)
		scaling_before, scaling_after = self.restart_controller_pod()
		converged = self.wait_phase(
			"Idle", timeout=90, predicate=lambda state: state.get("epoch", 0) >= selected["epoch"]
		)
		deadline = time.monotonic() + self.args.pod_timeout
		while time.monotonic() < deadline:
			if self.replicas() == 1:
				break
			time.sleep(0.25)
		else:
			raise TimeoutError("controller restart drain did not scale exactly one Host")
		self.refresh_hosts(1)
		owners_after = self.wait_ownership(live, timeout=self.args.actor_timeout)
		if any(labels != ["host-0"] for labels in owners_after.values()):
			raise RuntimeError(f"actors did not converge after controller restarts: {owners_after}")
		self.evidence["scenarios"]["controller_restart_resume"] = {
			"selected": selected,
			"selected_restart": {"before": selected_before, "after": selected_after},
			"resumed": resumed,
			"scaling": scaling,
			"scaling_restart": {"before": scaling_before, "after": scaling_after},
			"converged": converged,
			"owners_before": owners_before,
			"owners_after": owners_after,
			"replicas": 1,
		}

	def run(self):
		self.preflight_drain()
		self.configure_allocator()
		self.patch_required_anti_affinity()
		node = json.loads(self.create_compute_node())
		extra_node = self.create_extra_compute_node()
		self.scale_hosts_to_two()
		self.start_engine_forward()
		self.refresh_hosts(2)
		self.wait_empty()
		self.import_controller_image()
		self.capture_and_delay_runner()
		self.evidence["setup"] = {
			"new_compute_node": node["metadata"]["name"],
			"scale_up_compute_node": extra_node["metadata"]["name"],
			"eviction_delay_seconds": self.args.eviction_delay,
			"hosts": [{"pod": host.pod, "uid": host.uid, "node": host.node} for host in self.hosts],
		}

		self.scenario_management_unavailable()
		self.scenario_uid_replacement()
		self.scenario_demand_burst()
		self.scenario_scale_up_race()
		self.scenario_timeout()
		self.scenario_controller_restarts()
		self.evidence["verdict"] = "passed"

	def cleanup(self):
		cleanup_errors = []
		self.stop_controller(delete=True)
		if self.original_runner_config is not None and self.engine_forward is not None:
			try:
				self.set_runner_config(self.original_runner_config)
			except Exception as error:
				cleanup_errors.append(f"restore runner config: {error}")
		# A runner-config update can replace the selected Engine Pod and end a
		# service port-forward. Reconnect before the base cleanup proves that no
		# scenario actors remain.
		if self.engine_forward is not None:
			try:
				self.engine_forward.stop()
				self.engine_forward = None
				self.start_engine_forward()
			except Exception as error:
				cleanup_errors.append(f"reconnect Engine cleanup forward: {error}")
		try:
			super().cleanup()
		except Exception as error:
			cleanup_errors.append(f"base cleanup: {error}")
		try:
			self.delete_extra_compute_nodes()
		except Exception as error:
			cleanup_errors.append(str(error))
		if cleanup_errors:
			self.evidence.setdefault("cleanup_errors", []).extend(cleanup_errors)


def default_output():
	agents_dir = pathlib.Path(os.environ.get("AGENTS_DIR", pathlib.Path.home() / ".agents"))
	stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
	return agents_dir / "benchmarks/local-mesh/workerd-host-drain-failure-e2e" / f"{stamp}.json"


def parse_args():
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("--kubeconfig", type=pathlib.Path, required=True)
	parser.add_argument("--cluster", required=True)
	parser.add_argument("--cell", default="local-runtime-a")
	parser.add_argument("--controller-image", required=True)
	parser.add_argument("--capacity", type=int, default=4)
	parser.add_argument("--eviction-delay", type=int, default=15)
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
	if args.eviction_delay < 3 or args.eviction_delay > 30:
		parser.error("eviction delay must be between 3 and 30 seconds")
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
