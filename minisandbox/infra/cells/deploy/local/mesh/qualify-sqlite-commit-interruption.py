#!/usr/bin/env python3
"""Qualify SQLite atomicity across lost HTTP replies and Engine restarts."""

import argparse
import importlib.util
import json
import os
import pathlib
import subprocess
import time
import urllib.parse


HELPERS_PATH = pathlib.Path(__file__).with_name("qualify-real-cos-outage.py")
HELPERS_SPEC = importlib.util.spec_from_file_location("cos_outage_helpers", HELPERS_PATH)
helpers = importlib.util.module_from_spec(HELPERS_SPEC)
HELPERS_SPEC.loader.exec_module(helpers)

DELETE_GATE_PATH = pathlib.Path(__file__).with_name("qualify-sqlite-uncertain-delete.py")
DELETE_GATE_SPEC = importlib.util.spec_from_file_location("uncertain_delete_gate", DELETE_GATE_PATH)
delete_gate = importlib.util.module_from_spec(DELETE_GATE_SPEC)
DELETE_GATE_SPEC.loader.exec_module(delete_gate)


def parse_args():
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("--kubeconfig", required=True)
	parser.add_argument("--cell", required=True)
	parser.add_argument("--output", type=pathlib.Path, required=True)
	parser.add_argument("--engine-port", type=int, default=22520)
	parser.add_argument("--depot-port", type=int, default=22521)
	parser.add_argument("--delays-ms", default="0,1,10,50,250,1000")
	return parser.parse_args()


def main():
	args = parse_args()
	namespace = "actor-fdb-cell-system"
	actor_namespace = "default"
	engine = f"http://127.0.0.1:{args.engine_port}"
	depot = f"http://127.0.0.1:{args.depot_port}"
	query = urllib.parse.urlencode({"namespace": actor_namespace})
	delays = [int(value) for value in args.delays_ms.split(",")]
	if not delays or any(value < 0 or value > 10_000 for value in delays):
		raise ValueError("commit interruption delays must be between 0 and 10000 ms")
	forward = helpers.PortForward(
		args.kubeconfig,
		namespace,
		f"{args.cell}-engine",
		[f"{args.engine_port}:6420", f"{args.depot_port}:6421"],
	)
	evidence = {
		"schema": "rivet-sqlite-commit-interruption/v1",
		"cell": args.cell,
		"cases": [],
	}
	actor_id = None
	namespace_id = None
	original_runtime_config = None
	failure = None

	def actor_url(suffix):
		return f"{engine}/gateway/{urllib.parse.quote(actor_id, safe='')}{suffix}"

	try:
		config_map_name = f"{args.cell}-runtime-config"
		config_map = json.loads(
			helpers.kubectl(
				args, "-n", namespace, "get", "configmap", config_map_name, "-o", "json"
			)
		)
		original_runtime_config = config_map["data"]["config.jsonc"]
		qualification_config = json.loads(original_runtime_config)
		qualification_config["sqlite"]["workflow_write_debt"] = {
			"target_bytes": 33_554_432,
			"limit_bytes": 67_108_864,
		}
		helpers.kubectl(
			args,
			"-n", namespace,
			"patch", "configmap", config_map_name,
			"--type=merge",
			"-p", json.dumps({"data": {"config.jsonc": json.dumps(qualification_config)}}),
		)
		helpers.kubectl(
			args, "-n", namespace, "rollout", "restart", f"deployment/{args.cell}-engine"
		)
		helpers.kubectl(
			args, "-n", namespace, "rollout", "status",
			f"deployment/{args.cell}-engine", "--timeout=5m",
		)
		delete_gate.wait_single_engine_pod(args, namespace)
		forward.start()
		namespace_payload = helpers.request_json("GET", f"{depot}/namespaces?name=default")
		namespace_id = namespace_payload["namespaces"][0]["namespace_id"]
		created = helpers.request_json(
			"POST",
			f"{engine}/actors?{query}",
			{
				"name": "workerd-counter",
				"key": f"commit-interruption-{int(time.time() * 1000)}",
				"runner_name_selector": "workerd",
				"crash_policy": "restart",
			},
		)
		actor_id = created["actor"]["actor_id"]
		delete_gate.wait_actor(actor_url, actor_id)
		helpers.request_json(
			"POST", actor_url("/bottomless-fill?chunk=0&chunks=4&bytes=262144"), timeout=120
		)
		expected_chunks = 4
		delete_gate.verify_export(engine, actor_id, actor_namespace, expected_chunks * 262144)

		for index, delay_ms in enumerate(delays):
			chunk = (index + 1) * 4
			prior_chunks = expected_chunks
			request_url = actor_url(
				f"/bottomless-fill?chunk={chunk}&chunks=4&bytes=262144"
			)
			client = subprocess.Popen(
				["curl", "--silent", "--show-error", "--request", "POST", request_url],
				stdout=subprocess.PIPE,
				stderr=subprocess.PIPE,
				text=True,
			)
			time.sleep(delay_ms / 1000)
			client_was_killed = client.poll() is None
			if client_was_killed:
				client.kill()
			client.wait(timeout=5)

			restart_engine = index % 2 == 1
			pod_uid_before = helpers.engine_pod_uid(args, namespace)
			if restart_engine:
				forward.stop()
				helpers.kubectl(
					args, "-n", namespace, "rollout", "restart", f"deployment/{args.cell}-engine"
				)
				helpers.kubectl(
					args, "-n", namespace, "rollout", "status",
					f"deployment/{args.cell}-engine", "--timeout=5m",
				)
				delete_gate.wait_single_engine_pod(args, namespace)
				forward.start()
			pod_uid_after = helpers.engine_pod_uid(args, namespace)

			# Let a request whose response was killed finish or roll back before observing the
			# durable state. A later request must reopen the Actor cleanly after Engine restart.
			time.sleep(3)
			observed = delete_gate.wait_actor(actor_url, actor_id)
			observed_chunks = int(observed["bottomlessChunks"])
			observed_bytes = int(observed["bottomlessBytes"])
			if observed_chunks not in (expected_chunks, expected_chunks + 4):
				raise RuntimeError(
					"interrupted SQLite statement partially committed: "
					f"expected {expected_chunks} or {expected_chunks + 4} chunks, got {observed_chunks}"
				)
			if observed_bytes != observed_chunks * 262144:
				raise RuntimeError("interrupted SQLite statement published partial payload bytes")
			if int(observed.get("bottomlessCorruptChunks", -1)) != 0:
				raise RuntimeError("interrupted SQLite statement returned corrupt payload bytes")
			expected_chunks = observed_chunks
			verification = delete_gate.verify_export(
				engine, actor_id, actor_namespace, expected_chunks * 262144
			)
			state = helpers.request_json(
				"GET",
				f"{depot}/depot/inspect/buckets/{namespace_id}/databases/{actor_id}/bottomless-state",
				timeout=10,
			)
			if state.get("head") is None:
				raise RuntimeError("active Actor lost its durable SQLite head after interruption")
			evidence["cases"].append({
				"delay_ms": delay_ms,
				"client_killed": client_was_killed,
				"client_exit_code": client.returncode,
				"engine_restarted": restart_engine,
				"pod_uid_before": pod_uid_before,
				"pod_uid_after": pod_uid_after,
				"durable_outcome": "committed" if observed_chunks > prior_chunks else "not_committed",
				"chunks": observed_chunks,
				"head_txid": state["head"]["head_txid"],
				"verification": verification,
			})

		evidence["actor_id"] = actor_id
		evidence["final_chunks"] = expected_chunks
		evidence["verdict"] = "passed"
	except Exception as exc:
		failure = exc
		evidence["verdict"] = "failed"
		evidence["error"] = {"type": type(exc).__name__, "message": str(exc)}
	finally:
		if actor_id is not None:
			for attempt in range(10):
				try:
					helpers.request_json(
						"DELETE",
						f"{engine}/actors/{urllib.parse.quote(actor_id, safe='')}?{query}",
						timeout=10,
					)
					break
				except Exception:
					time.sleep(min(attempt + 1, 5))
		forward.stop()
		if original_runtime_config is not None:
			try:
				helpers.kubectl(
					args,
					"-n", namespace,
					"patch", "configmap", f"{args.cell}-runtime-config",
					"--type=merge",
					"-p", json.dumps({"data": {"config.jsonc": original_runtime_config}}),
				)
				helpers.kubectl(
					args, "-n", namespace, "rollout", "restart", f"deployment/{args.cell}-engine"
				)
				helpers.kubectl(
					args, "-n", namespace, "rollout", "status",
					f"deployment/{args.cell}-engine", "--timeout=5m",
				)
			except Exception as restore_error:
				evidence["config_restore_error"] = str(restore_error)

	args.output.parent.mkdir(parents=True, exist_ok=True)
	temporary = args.output.with_suffix(args.output.suffix + ".tmp")
	temporary.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
	os.replace(temporary, args.output)
	print(json.dumps(evidence, indent=2, sort_keys=True))
	if failure is not None:
		raise failure


if __name__ == "__main__":
	main()
