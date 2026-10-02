#!/usr/bin/env python3
"""Qualify a large dormant Agent population through the public Workers API."""

import argparse
import fcntl
import importlib.util
import json
import os
import pathlib
import subprocess
import time
import urllib.parse
import uuid


HERE = pathlib.Path(__file__).resolve().parent
MESH_DIR = HERE.parent
REPO_ROOT = HERE.parents[5]
BASE_RUNNER = MESH_DIR / "workerd-persistent-code-e2e" / "run.py"
KUBE_NAMESPACE = "actor-fdb-cell-system"


def load_base():
	spec = importlib.util.spec_from_file_location("mass_agent_base", BASE_RUNNER)
	if spec is None or spec.loader is None:
		raise RuntimeError(f"cannot load E2E helpers from {BASE_RUNNER}")
	module = importlib.util.module_from_spec(spec)
	spec.loader.exec_module(module)
	return module


base = load_base()


def parse_args():
	state = pathlib.Path(
		os.environ.get("MESH_STATE_DIR", pathlib.Path.home() / ".local/state/rivet-local-mesh")
	)
	agents = pathlib.Path(os.environ.get("AGENTS_DIR", pathlib.Path.home() / ".agents"))
	stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("--runtime-a-kubeconfig", type=pathlib.Path, default=state / "runtime-a.kubeconfig")
	parser.add_argument("--runtime-b-kubeconfig", type=pathlib.Path, default=state / "runtime-b.kubeconfig")
	parser.add_argument("--api-endpoint", default="http://9.134.163.40:6688/v1")
	parser.add_argument("--agents", type=int, default=1000)
	parser.add_argument("--concurrency", type=int, default=64)
	parser.add_argument("--cleanup-concurrency", type=int, default=32)
	parser.add_argument("--arrival-rate", type=float, default=0)
	parser.add_argument("--sample-agents", type=int, default=32)
	parser.add_argument("--hosts-per-cell", type=int, default=1)
	parser.add_argument("--engines-per-cell", type=int, default=1)
	parser.add_argument("--resource-profile", choices=("local", "production"), default="local")
	parser.add_argument("--host-capacity", type=int, default=32)
	parser.add_argument("--max-in-flight", type=int, default=16)
	parser.add_argument("--max-queued", type=int, default=64)
	parser.add_argument("--queue-timeout-ms", type=int, default=15_000)
	parser.add_argument("--idle-sleep-ms", type=int, default=5_000)
	parser.add_argument("--min-populate-throughput", type=float, default=0)
	parser.add_argument("--max-populate-p95-ms", type=float, default=0)
	parser.add_argument("--max-populate-latency-ms", type=float, default=0)
	parser.add_argument("--max-populate-retries", type=int, default=-1)
	parser.add_argument("--quiescence-timeout", type=float, default=300)
	parser.add_argument("--keep-agents", action="store_true")
	parser.add_argument(
		"--output",
		type=pathlib.Path,
		default=agents / "benchmarks/local-mesh/workerd-mass-agent-e2e" / f"{stamp}.json",
	)
	args = parser.parse_args()
	if not 1 <= args.agents <= 10_000:
		parser.error("--agents must be between 1 and 10000")
	if not 1 <= args.concurrency <= 1024:
		parser.error("--concurrency must be between 1 and 1024")
	if not 1 <= args.cleanup_concurrency <= 64:
		parser.error("--cleanup-concurrency must be between 1 and 64")
	if args.arrival_rate < 0 or args.arrival_rate > 10_000:
		parser.error("--arrival-rate must be between 0 and 10000")
	if not 1 <= args.sample_agents <= args.agents:
		parser.error("--sample-agents must be between 1 and --agents")
	if not 1 <= args.hosts_per_cell <= 16:
		parser.error("--hosts-per-cell must be between 1 and 16")
	if not 1 <= args.engines_per_cell <= 8:
		parser.error("--engines-per-cell must be between 1 and 8")
	if not 1 <= args.host_capacity <= 64:
		parser.error("--host-capacity must be between 1 and 64")
	if not 1 <= args.max_in_flight <= args.host_capacity:
		parser.error("--max-in-flight must be between 1 and --host-capacity")
	if not args.max_in_flight <= args.max_queued <= 1024:
		parser.error("--max-queued must be between --max-in-flight and 1024")
	if not 1_000 <= args.queue_timeout_ms <= 60_000:
		parser.error("--queue-timeout-ms must be between 1000 and 60000")
	if not 100 <= args.idle_sleep_ms <= 30_000:
		parser.error("--idle-sleep-ms must be between 100 and 30000")
	if args.min_populate_throughput < 0:
		parser.error("--min-populate-throughput must not be negative")
	if args.max_populate_p95_ms < 0:
		parser.error("--max-populate-p95-ms must not be negative")
	if args.max_populate_latency_ms < 0:
		parser.error("--max-populate-latency-ms must not be negative")
	if args.max_populate_retries < -1:
		parser.error("--max-populate-retries must be -1 or greater")
	if (
		args.max_populate_latency_ms > 0
		and args.queue_timeout_ms > args.max_populate_latency_ms
	):
		parser.error("--queue-timeout-ms must not exceed the maximum populate latency")
	if not args.api_endpoint.rstrip("/").endswith("/v1"):
		parser.error("--api-endpoint must be the complete public /v1 URL")
	return args


class Runtime:
	def __init__(self, label, kubeconfig):
		self.label = label
		self.cell = f"local-runtime-{label}"
		self.kubectl = base.Kubectl(kubeconfig, KUBE_NAMESPACE)
		self.statefulset = f"{self.cell}-runtime-hosts"
		self.engine_deployment = f"{self.cell}-engine"
		self.original_env = None
		self.original_replicas = None
		self.original_engine_replicas = None
		self.original_resources = None
		self.pods = []
		self.engine_pods = []

	def host_pods(self, expected=None):
		items = self.kubectl.json(
			"get",
			"pods",
			"-l",
			f"fleet.actor.dev/cell-name={self.cell},fleet.actor.dev/component=workerd-host",
		).get("items", [])
		ready = [
			item
			for item in items
			if item["metadata"].get("deletionTimestamp") is None and base.ready(item)
		]
		if expected is not None and len(ready) != expected:
			raise RuntimeError(
				f"{self.cell}: expected {expected} Ready Hosts, got {len(ready)}"
			)
		return sorted(item["metadata"]["name"] for item in ready)

	def ready_engine_pods(self, expected=None):
		items = self.kubectl.json(
			"get",
			"pods",
			"-l",
			f"fleet.actor.dev/cell-name={self.cell},fleet.actor.dev/component=engine",
		).get("items", [])
		ready = [
			item
			for item in items
			if item["metadata"].get("deletionTimestamp") is None and base.ready(item)
		]
		if expected is not None and len(ready) != expected:
			raise RuntimeError(
				f"{self.cell}: expected {expected} Ready Engines, got {len(ready)}"
			)
		return sorted(item["metadata"]["name"] for item in ready)

	def capture_and_configure(
		self,
		replicas,
		engine_replicas,
		resource_profile,
		capacity,
		max_in_flight,
		max_queued,
		queue_timeout_ms,
		idle_sleep_ms,
	):
		statefulset = self.kubectl.json("get", "statefulset", self.statefulset)
		containers = statefulset["spec"]["template"]["spec"]["containers"]
		host_index = next(
			(index for index, container in enumerate(containers) if container["name"] == "workerd-host"),
			None,
		)
		workerd_index = next(
			(index for index, container in enumerate(containers) if container["name"] == "workerd"),
			None,
		)
		if host_index is None or workerd_index is None:
			raise RuntimeError(f"{self.cell}: workerd-host container is missing")
		self.original_env = (host_index, containers[host_index].get("env", []))
		self.original_replicas = int(statefulset["spec"]["replicas"])
		engine = self.kubectl.json("get", "deployment", self.engine_deployment)
		self.original_engine_replicas = int(engine["spec"]["replicas"])
		engine_index = next(
			(
				index
				for index, container in enumerate(engine["spec"]["template"]["spec"]["containers"])
				if container["name"] == "engine"
			),
			None,
		)
		if engine_index is None:
			raise RuntimeError(f"{self.cell}: engine container is missing")
		self.original_resources = {
			"host": (host_index, containers[host_index].get("resources", {})),
			"workerd": (workerd_index, containers[workerd_index].get("resources", {})),
			"engine": (
				engine_index,
				engine["spec"]["template"]["spec"]["containers"][engine_index].get(
					"resources", {}
				),
			),
		}
		if resource_profile == "production":
			statefulset_patch = json.dumps(
				[
					{
						"op": "replace",
						"path": f"/spec/template/spec/containers/{workerd_index}/resources",
						"value": {
							"requests": {"cpu": "1", "memory": "1Gi"},
							"limits": {"cpu": "4", "memory": "6Gi"},
						},
					},
					{
						"op": "replace",
						"path": f"/spec/template/spec/containers/{host_index}/resources",
						"value": {
							"requests": {"cpu": "250m", "memory": "256Mi"},
							"limits": {"cpu": "1", "memory": "1Gi"},
						},
					},
				]
			)
			self.kubectl.run(
				"patch", "statefulset", self.statefulset, "--type=json", "-p", statefulset_patch
			)
			engine_patch = json.dumps(
				[
					{
						"op": "replace",
						"path": f"/spec/template/spec/containers/{engine_index}/resources",
						"value": {
							"requests": {"cpu": "1", "memory": "1Gi"},
							"limits": {"cpu": "4", "memory": "4Gi"},
						},
					}
				]
			)
			self.kubectl.run(
				"patch", "deployment", self.engine_deployment, "--type=json", "-p", engine_patch
			)
		self.kubectl.run(
			"scale", f"deployment/{self.engine_deployment}", f"--replicas={engine_replicas}"
		)
		self.kubectl.run(
			"rollout", "status", f"deployment/{self.engine_deployment}", "--timeout=10m", timeout=630
		)
		self.engine_pods = self.ready_engine_pods(engine_replicas)
		self.kubectl.run(
			"set",
			"env",
			f"statefulset/{self.statefulset}",
			"--containers=workerd-host",
			f"RIVET_WORKERD_MAX_ACTIVE_ACTORS={capacity}",
			f"RIVET_WORKERD_MAX_IN_FLIGHT={max_in_flight}",
			f"RIVET_WORKERD_MAX_QUEUED={max_queued}",
			f"RIVET_WORKERD_QUEUE_TIMEOUT_MS={queue_timeout_ms}",
			f"RIVET_WORKERD_IDLE_SLEEP_MS={idle_sleep_ms}",
		)
		self.kubectl.run(
			"scale", f"statefulset/{self.statefulset}", f"--replicas={replicas}"
		)
		self.kubectl.run(
			"rollout", "status", f"statefulset/{self.statefulset}", "--timeout=10m", timeout=630
		)
		self.pods = self.host_pods(replicas)

	def restore(self):
		if (
			self.original_env is None
			or self.original_replicas is None
			or self.original_engine_replicas is None
			or self.original_resources is None
		):
			return
		index, environment = self.original_env
		host_resource_index, host_resources = self.original_resources["host"]
		workerd_resource_index, workerd_resources = self.original_resources["workerd"]
		engine_resource_index, engine_resources = self.original_resources["engine"]
		patch = json.dumps(
			[
				{
					"op": "replace",
					"path": f"/spec/template/spec/containers/{index}/env",
					"value": environment,
				},
				{
					"op": "replace",
					"path": f"/spec/template/spec/containers/{host_resource_index}/resources",
					"value": host_resources,
				},
				{
					"op": "replace",
					"path": f"/spec/template/spec/containers/{workerd_resource_index}/resources",
					"value": workerd_resources,
				},
				{"op": "replace", "path": "/spec/replicas", "value": self.original_replicas},
			]
		)
		self.kubectl.run("patch", "statefulset", self.statefulset, "--type=json", "-p", patch)
		self.kubectl.run(
			"rollout", "status", f"statefulset/{self.statefulset}", "--timeout=10m", timeout=630
		)
		engine_patch = json.dumps(
			[
				{
					"op": "replace",
					"path": f"/spec/template/spec/containers/{engine_resource_index}/resources",
					"value": engine_resources,
				},
				{
					"op": "replace",
					"path": "/spec/replicas",
					"value": self.original_engine_replicas,
				},
			]
		)
		self.kubectl.run(
			"patch", "deployment", self.engine_deployment, "--type=json", "-p", engine_patch
		)
		self.kubectl.run(
			"rollout", "status", f"deployment/{self.engine_deployment}", "--timeout=10m", timeout=630
		)
		self.original_env = None
		self.original_replicas = None
		self.original_engine_replicas = None
		self.original_resources = None
		self.pods = []
		self.engine_pods = []

	def pod_stats(self, pod):
		output = self.kubectl.run(
			"exec",
			pod,
			"-c",
			"workerd-host",
			"--",
			"bash",
			"-c",
			'curl --fail --silent -H "x-rivet-workerd-token: $RIVET_WORKERD_TOKEN" '
			"http://127.0.0.1:19083/v1/sqlite/stats",
		)
		return json.loads(output)

	def stats(self):
		per_host = {pod: self.pod_stats(pod) for pod in self.pods or self.host_pods()}
		admission = [value["workerd_admission"] for value in per_host.values()]
		engine_active_actor_workflows = self.prometheus_scalar(
			'max(rivet_gasoline_workflow_active{workflow_name="pegboard_actor2"}) or vector(0)'
		)
		engine_pending_actor_metrics_signals = self.prometheus_scalar(
			'sum(max by (signal_name) (rivet_gasoline_signal_pending{signal_name=~"pegboard_actor_metrics_(pause|destroy)"}))'
			" or vector(0)"
		)
		return {
			"host_count": len(per_host),
			"per_host": per_host,
			"host_active_actors": sum(int(value.get("host_active_actors", 0)) for value in per_host.values()),
			"bridge_active_actors": sum(int(value.get("bridge_active_actors", 0)) for value in per_host.values()),
			"engine_active_actor_workflows": engine_active_actor_workflows,
			"engine_pending_actor_metrics_signals": engine_pending_actor_metrics_signals,
			"host_max_active_actors": sum(int(value.get("host_max_active_actors", 0)) for value in per_host.values()),
			"host_draining": any(bool(value.get("host_draining")) for value in per_host.values()),
			"host_accepting_actors": all(bool(value.get("host_accepting_actors")) for value in per_host.values()),
			"workerd_admission": {
				field: sum(int(value.get(field, 0)) for value in admission)
				for field in (
					"in_flight",
					"queued",
					"max_in_flight",
					"max_queued",
					"peak_in_flight",
					"peak_queued",
					"queued_total",
					"rejected_total",
					"timed_out_total",
				)
			},
		}

	def prometheus_scalar(self, query):
		proxy = (
			"/api/v1/namespaces/observability/services/"
			"http:actor-observability-prometheus:9090/proxy"
		)
		encoded = urllib.parse.quote(query, safe="")
		deadline = time.monotonic() + 30
		last_error = None
		while time.monotonic() < deadline:
			try:
				response = json.loads(
					self.kubectl.run("get", "--raw", f"{proxy}/api/v1/query?query={encoded}")
				)
				results = response.get("data", {}).get("result", [])
				if len(results) != 1:
					raise RuntimeError(
						f"Prometheus query did not return one scalar: {query}"
					)
				return int(float(results[0]["value"][1]))
			except (RuntimeError, json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
				last_error = error
				time.sleep(1)
		raise RuntimeError(
			f"Prometheus query remained unavailable for 30s: {query}: {last_error}"
		) from last_error

	def cgroup_value(self, pod, container, path):
		if path not in {"memory.current", "memory.peak", "memory.max", "cpu.stat"}:
			raise ValueError(f"unsupported cgroup path: {path}")
		output = self.kubectl.run(
			"exec", pod, "-c", container, "--", "sh", "-c", f"cat /sys/fs/cgroup/{path}"
		)
		return output.strip()

	def cgroup_memory_bytes(self, pod, container, metric):
		if metric not in {"memory.current", "memory.peak", "memory.max"}:
			raise ValueError(f"unsupported cgroup memory metric: {metric}")
		value = self.cgroup_value(pod, container, metric)
		return None if value == "max" else int(value)

	def cgroup_cpu_usage_usec(self, pod, container):
		fields = dict(
			line.split(maxsplit=1) for line in self.cgroup_value(pod, container, "cpu.stat").splitlines()
		)
		return int(fields["usage_usec"])


def aggregate_stats(runtimes):
	values = {runtime.cell: runtime.stats() for runtime in runtimes}
	return {
		"per_cell": values,
		"host_active_actors": sum(int(value.get("host_active_actors", 0)) for value in values.values()),
		"bridge_active_actors": sum(int(value.get("bridge_active_actors", 0)) for value in values.values()),
		"engine_active_actor_workflows": sum(
			int(value.get("engine_active_actor_workflows", 0)) for value in values.values()
		),
		"engine_pending_actor_metrics_signals": sum(
			int(value.get("engine_pending_actor_metrics_signals", 0)) for value in values.values()
		),
	}


def container_resource_snapshot(runtimes):
	per_cell = {}
	for runtime in runtimes:
		per_host = {}
		for pod in runtime.pods or runtime.host_pods():
			per_host[pod] = {
				container: {
					"memory_current": runtime.cgroup_memory_bytes(pod, container, "memory.current"),
					"memory_peak": runtime.cgroup_memory_bytes(pod, container, "memory.peak"),
					"memory_limit": runtime.cgroup_memory_bytes(pod, container, "memory.max"),
					"cpu_usage_usec": runtime.cgroup_cpu_usage_usec(pod, container),
				}
				for container in ("workerd", "workerd-host")
			}
		per_cell[runtime.cell] = {
			"host_count": len(per_host),
			"per_host": per_host,
			"memory_current_total": sum(
				entry["memory_current"]
				for host in per_host.values()
				for entry in host.values()
			),
			"memory_peak_total": sum(
				entry["memory_peak"] for host in per_host.values() for entry in host.values()
			),
			"engines": {
				pod: {
					"memory_current": runtime.cgroup_memory_bytes(pod, "engine", "memory.current"),
					"memory_peak": runtime.cgroup_memory_bytes(pod, "engine", "memory.peak"),
					"memory_limit": runtime.cgroup_memory_bytes(pod, "engine", "memory.max"),
					"cpu_usage_usec": runtime.cgroup_cpu_usage_usec(pod, "engine"),
				}
				for pod in runtime.engine_pods or runtime.ready_engine_pods()
			},
		}
		per_cell[runtime.cell]["memory_current_total"] += sum(
			entry["memory_current"] for entry in per_cell[runtime.cell]["engines"].values()
		)
		per_cell[runtime.cell]["memory_peak_total"] += sum(
			entry["memory_peak"] for entry in per_cell[runtime.cell]["engines"].values()
		)
	return {
		"per_cell": per_cell,
		"memory_current_total": sum(cell["memory_current_total"] for cell in per_cell.values()),
		"memory_peak_total": sum(cell["memory_peak_total"] for cell in per_cell.values()),
	}


def resource_delta(before, after):
	per_cell = {}
	for cell, after_cell in after["per_cell"].items():
		before_cell = before["per_cell"][cell]
		per_host = {}
		for pod, after_host in after_cell["per_host"].items():
			before_host = before_cell["per_host"][pod]
			per_host[pod] = {
				container: {
					"cpu_usage_usec": after_values["cpu_usage_usec"]
					- before_host[container]["cpu_usage_usec"]
				}
				for container, after_values in after_host.items()
			}
		per_cell[cell] = {
			"per_host": per_host,
			"engines": {
				pod: {
					"cpu_usage_usec": values["cpu_usage_usec"]
					- before_cell["engines"][pod]["cpu_usage_usec"]
				}
				for pod, values in after_cell["engines"].items()
			},
		}
	return {"per_cell": per_cell}


def assert_qualification(args, populate, resources):
	failures = []
	if (
		args.min_populate_throughput > 0
		and populate["throughput_per_second"] < args.min_populate_throughput
	):
		failures.append(
			f"populate throughput {populate['throughput_per_second']:.2f}/s is below "
			f"{args.min_populate_throughput:.2f}/s"
		)
	if (
		args.max_populate_p95_ms > 0
		and populate["latency_ms"]["p95"] > args.max_populate_p95_ms
	):
		failures.append(
			f"populate p95 {populate['latency_ms']['p95']:.2f}ms exceeds "
			f"{args.max_populate_p95_ms:.2f}ms"
		)
	if (
		args.max_populate_latency_ms > 0
		and populate["latency_ms"]["max"] > args.max_populate_latency_ms
	):
		failures.append(
			f"populate max {populate['latency_ms']['max']:.2f}ms exceeds "
			f"{args.max_populate_latency_ms:.2f}ms"
		)
	if args.max_populate_retries >= 0 and populate["retries"] > args.max_populate_retries:
		failures.append(
			f"populate retries {populate['retries']} exceeds {args.max_populate_retries}"
		)
	for cell, cell_values in resources["after_populate"]["per_cell"].items():
		for pod, host in cell_values["per_host"].items():
			workerd = host["workerd"]
			limit = workerd["memory_limit"]
			if limit is not None and workerd["memory_peak"] * 100 >= limit * 95:
				failures.append(
					f"{cell}/{pod} workerd peak memory reached at least 95% of its limit"
				)
	if failures:
		raise RuntimeError("; ".join(failures))


def wait_quiescent(runtimes, baseline, timeout):
	deadline = time.monotonic() + timeout
	last = None
	while time.monotonic() < deadline:
		last = aggregate_stats(runtimes)
		if (
			last["host_active_actors"] == baseline["host_active_actors"]
			and last["bridge_active_actors"] == baseline["bridge_active_actors"]
			and last["engine_active_actor_workflows"]
			<= baseline["engine_active_actor_workflows"]
			and last["engine_pending_actor_metrics_signals"]
			<= baseline["engine_pending_actor_metrics_signals"]
		):
			return last
		time.sleep(1)
	raise TimeoutError(f"Host registries did not return to baseline: baseline={baseline}, last={last}")


def run_node(args, run_id, mode):
	module = REPO_ROOT / "runtimes/workerd/miniflare/dist/index.js"
	if not module.is_file():
		raise RuntimeError(f"Miniflare build is missing: {module}")
	concurrency = args.cleanup_concurrency if mode == "cleanup" else args.concurrency
	command = [
		"node",
		str(HERE / "runner.mjs"),
		str(module),
		args.api_endpoint.rstrip("/"),
		run_id,
		mode,
		str(args.agents),
		str(concurrency),
		str(args.sample_agents),
		str(args.arrival_rate),
	]
	started_at_unix_ms = int(time.time() * 1000)
	process = subprocess.run(command, text=True, stdout=subprocess.PIPE)
	finished_at_unix_ms = int(time.time() * 1000)
	if process.returncode:
		raise RuntimeError(f"Node {mode} phase failed with exit {process.returncode}")
	result = json.loads(process.stdout)
	result["started_at_unix_ms"] = started_at_unix_ms
	result["finished_at_unix_ms"] = finished_at_unix_ms
	result["wall_duration_ms"] = finished_at_unix_ms - started_at_unix_ms
	return result


def main():
	args = parse_args()
	runtimes = [Runtime("a", args.runtime_a_kubeconfig), Runtime("b", args.runtime_b_kubeconfig)]
	args.output.parent.mkdir(parents=True, exist_ok=True)
	lock_path = args.output.parent / ".lock"
	run_id = f"{int(time.time())}-{uuid.uuid4().hex[:8]}"
	evidence = {
		"schema": "rivet-workerd-mass-agent-e2e/v3",
		"verdict": "failed",
		"run_id": run_id,
		"target_agents": args.agents,
		"arrival_rate_per_second": args.arrival_rate,
		"sample_agents": args.sample_agents,
		"hosts_per_cell": args.hosts_per_cell,
		"engines_per_cell": args.engines_per_cell,
		"resource_profile": args.resource_profile,
		"host_capacity_per_host": args.host_capacity,
		"max_in_flight_per_host": args.max_in_flight,
		"max_queued_per_host": args.max_queued,
		"queue_timeout_ms": args.queue_timeout_ms,
		"idle_sleep_ms": args.idle_sleep_ms,
		"qualification_thresholds": {
			"min_populate_throughput_per_second": args.min_populate_throughput,
			"max_populate_p95_ms": args.max_populate_p95_ms,
			"max_populate_latency_ms": args.max_populate_latency_ms,
			"max_populate_retries": args.max_populate_retries,
			"max_workerd_memory_percent": 95,
		},
		"started_at_unix_ms": int(time.time() * 1000),
	}
	cleanup_required = False
	cleanup_errors = []
	baseline = None
	with lock_path.open("w") as lock:
		fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
		try:
			for runtime in runtimes:
				runtime.capture_and_configure(
					args.hosts_per_cell,
					args.engines_per_cell,
					args.resource_profile,
					args.host_capacity,
					args.max_in_flight,
					args.max_queued,
					args.queue_timeout_ms,
					args.idle_sleep_ms,
				)
			baseline = aggregate_stats(runtimes)
			evidence["baseline"] = baseline
			evidence["container_resources"] = {
				"baseline": container_resource_snapshot(runtimes),
			}
			cleanup_required = True
			populate = run_node(args, run_id, "populate")
			evidence["populate"] = populate
			after_populate = wait_quiescent(runtimes, baseline, args.quiescence_timeout)
			evidence["container_resources"]["after_populate"] = container_resource_snapshot(
				runtimes
			)
			evidence["container_resources"]["populate_delta"] = resource_delta(
				evidence["container_resources"]["baseline"],
				evidence["container_resources"]["after_populate"],
			)
			probe = run_node(args, run_id, "probe")
			evidence["sample_probe"] = probe
			after_probe = wait_quiescent(runtimes, baseline, args.quiescence_timeout)
			evidence["container_resources"]["after_probe"] = container_resource_snapshot(
				runtimes
			)
			evidence["quiescence"] = {
				"after_populate": True,
				"after_probe": True,
				"populate_stats": after_populate,
				"probe_stats": after_probe,
			}
			assert_qualification(args, populate, evidence["container_resources"])
			if not args.keep_agents:
				cleanup = run_node(args, run_id, "cleanup")
				evidence["cleanup"] = cleanup
				wait_quiescent(runtimes, baseline, args.quiescence_timeout)
				evidence["quiescence"]["after_cleanup"] = True
				evidence["container_resources"]["after_cleanup"] = container_resource_snapshot(
					runtimes
				)
				cleanup_required = False
			else:
				evidence["cleanup"] = {"kept": True, "operated_count": 0}
				evidence["quiescence"]["after_cleanup"] = True
			evidence["verdict"] = "passed"
		except BlockingIOError as error:
			evidence["failure"] = {
				"type": type(error).__name__,
				"message": "another mass Agent qualification is running",
			}
			raise RuntimeError("another mass Agent qualification is running") from error
		except Exception as error:
			evidence["failure"] = {
				"type": type(error).__name__,
				"message": str(error),
			}
			raise
		finally:
			if cleanup_required and not args.keep_agents:
				try:
					cleanup = run_node(args, run_id, "cleanup")
					evidence["cleanup"] = cleanup
					if baseline is not None:
						after_cleanup = wait_quiescent(
							runtimes, baseline, args.quiescence_timeout
						)
						evidence.setdefault("quiescence", {})["after_cleanup"] = True
						evidence["quiescence"]["cleanup_stats"] = after_cleanup
						evidence.setdefault("container_resources", {})[
							"after_cleanup"
						] = container_resource_snapshot(runtimes)
					cleanup_required = False
				except Exception as error:
					cleanup_errors.append(f"object cleanup: {error}")
			for runtime in reversed(runtimes):
				try:
					runtime.restore()
				except Exception as error:
					cleanup_errors.append(f"restore {runtime.cell}: {error}")
			evidence["finished_at_unix_ms"] = int(time.time() * 1000)
			if cleanup_errors:
				evidence["cleanup_errors"] = cleanup_errors
				if evidence["verdict"] == "passed":
					evidence["verdict"] = "passed_with_cleanup_errors"
			args.output.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
			print(args.output, flush=True)
	if evidence["verdict"] != "passed":
		raise RuntimeError(f"mass Agent qualification did not pass: {evidence['verdict']}")


if __name__ == "__main__":
	main()
