#!/usr/bin/env python3
"""Qualify Actor/SQLite fencing when a DELETE result is lost or Engine restarts."""

import argparse
import importlib.util
import json
import os
import pathlib
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse


HELPERS_PATH = pathlib.Path(__file__).with_name("qualify-real-cos-outage.py")
SPEC = importlib.util.spec_from_file_location("cos_outage_helpers", HELPERS_PATH)
helpers = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helpers)


def parse_args():
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument("--kubeconfig", required=True)
	parser.add_argument("--cell", required=True)
	parser.add_argument("--output", type=pathlib.Path, required=True)
	parser.add_argument("--engine-port", type=int, default=22520)
	parser.add_argument("--depot-port", type=int, default=22521)
	parser.add_argument(
		"--delays-ms",
		default="0,1,10,50,250,1000",
		help="comma-separated delays before killing the DELETE client",
	)
	return parser.parse_args()


def wait_single_engine_pod(args, namespace, timeout=180):
	deadline = time.monotonic() + timeout
	while time.monotonic() < deadline:
		payload = json.loads(
			helpers.kubectl(
				args,
				"-n", namespace,
				"get", "pods",
				"-l", f"fleet.actor.dev/cell-name={args.cell},fleet.actor.dev/component=engine",
				"-o", "json",
			)
		)
		items = payload.get("items", [])
		active = [
			item
			for item in items
			if item.get("status", {}).get("phase") == "Running"
			and item.get("metadata", {}).get("deletionTimestamp") is None
			and item.get("status", {}).get("containerStatuses", [{}])[0].get("ready") is True
		]
		if len(items) == 1 and len(active) == 1:
			return active[0]["metadata"]["uid"]
		time.sleep(0.25)
	raise TimeoutError("Engine rollout did not converge to one ready Pod")


def wait_actor(url, actor_id, timeout=180):
	deadline = time.monotonic() + timeout
	while time.monotonic() < deadline:
		try:
			payload = helpers.request_json("GET", url("/bottomless-verify"), timeout=10)
			if payload.get("actorId") == actor_id:
				return payload
		except Exception:
			pass
		time.sleep(0.25)
	raise TimeoutError(f"Actor {actor_id} did not become ready")


def verify_export(engine, actor_id, namespace, expected_bytes):
	query = urllib.parse.urlencode({"namespace": namespace})
	url = f"{engine}/actors/{urllib.parse.quote(actor_id, safe='')}/sqlite?{query}"
	with tempfile.TemporaryDirectory(prefix="rivet-uncertain-delete-") as temp_dir:
		path = pathlib.Path(temp_dir) / "actor.sqlite"
		subprocess.run(
			["curl", "--fail", "--silent", "--show-error", "--output", str(path), url],
			check=True,
			timeout=180,
		)
		connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
		try:
			integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
			chunks, payload_bytes, corrupt = connection.execute(
				"SELECT count(*), coalesce(sum(length(payload)), 0), "
				"coalesce(sum(payload != zeroblob(length(payload))), 0) "
				"FROM bottomless_qualification_payloads"
			).fetchone()
		finally:
			connection.close()
	if integrity != "ok" or payload_bytes != expected_bytes or corrupt != 0:
		raise RuntimeError(
			"active Actor SQLite failed validation: "
			f"integrity={integrity!r}, bytes={payload_bytes}, corrupt={corrupt}"
		)
	return {"integrity_check": integrity, "chunks": chunks, "bytes": payload_bytes}


def main():
	args = parse_args()
	namespace = "actor-fdb-cell-system"
	actor_namespace = "default"
	engine = f"http://127.0.0.1:{args.engine_port}"
	depot = f"http://127.0.0.1:{args.depot_port}"
	query = urllib.parse.urlencode({"namespace": actor_namespace})
	delays = [int(value) for value in args.delays_ms.split(",")]
	if not delays or any(value < 0 or value > 10_000 for value in delays):
		raise ValueError("DELETE interruption delays must be between 0 and 10000 ms")
	forward = helpers.PortForward(
		args.kubeconfig,
		namespace,
		f"{args.cell}-engine",
		[f"{args.engine_port}:6420", f"{args.depot_port}:6421"],
	)
	test_actor_ids = []
	evidence = {
		"schema": "rivet-sqlite-uncertain-delete/v1",
		"cell": args.cell,
		"cases": [],
	}
	failure = None

	def actor_url(actor_id, suffix):
		return f"{engine}/gateway/{urllib.parse.quote(actor_id, safe='')}{suffix}"

	def control(actor_id):
		payload = helpers.request_json(
			"GET",
			f"{engine}/actors?{urllib.parse.urlencode({'namespace': actor_namespace, 'actor_ids': actor_id})}",
			timeout=10,
		)
		actors = payload.get("actors", [])
		return actors[0] if actors else None

	try:
		forward.start()
		namespace_payload = helpers.request_json("GET", f"{depot}/namespaces?name=default")
		namespace_id = namespace_payload["namespaces"][0]["namespace_id"]
		for index, delay_ms in enumerate(delays):
			created = helpers.request_json(
				"POST",
				f"{engine}/actors?{query}",
				{
					"name": "workerd-counter",
					"key": f"uncertain-delete-{int(time.time() * 1000)}-{index}",
					"runner_name_selector": "workerd",
					"crash_policy": "restart",
				},
			)
			actor_id = created["actor"]["actor_id"]
			test_actor_ids.append(actor_id)
			ready = wait_actor(lambda suffix: actor_url(actor_id, suffix), actor_id)
			helpers.request_json(
				"POST",
				actor_url(actor_id, "/bottomless-fill?chunk=0&chunks=4&bytes=262144"),
				timeout=120,
			)
			baseline = verify_export(engine, actor_id, actor_namespace, 1024 * 1024)
			state_before = helpers.request_json(
				"GET",
				f"{depot}/depot/inspect/buckets/{namespace_id}/databases/{actor_id}/bottomless-state",
				timeout=10,
			)
			if state_before.get("head") is None:
				raise RuntimeError("baseline Actor has no durable SQLite head")

			delete_url = f"{engine}/actors/{urllib.parse.quote(actor_id, safe='')}?{query}"
			client = subprocess.Popen(
				["curl", "--silent", "--show-error", "--request", "DELETE", delete_url],
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
				wait_single_engine_pod(args, namespace)
				forward.start()
			pod_uid_after = helpers.engine_pod_uid(args, namespace)

			deadline = time.monotonic() + 60
			terminal = None
			while time.monotonic() < deadline:
				try:
					terminal = control(actor_id)
				except Exception:
					time.sleep(0.25)
					continue
				if terminal is None or terminal.get("destroy_ts") is not None:
					break
				# A request killed before reaching Engine is a valid active outcome. Give a
				# delivered DELETE time to publish destroy_ts before classifying it active.
				if time.monotonic() + 5 >= deadline:
					break
				time.sleep(0.25)

			case = {
				"actor_id": actor_id,
				"delay_ms": delay_ms,
				"delete_client_killed": client_was_killed,
				"delete_client_exit_code": client.returncode,
				"engine_restarted": restart_engine,
				"pod_uid_before": pod_uid_before,
				"pod_uid_after": pod_uid_after,
				"baseline": baseline,
			}
			if terminal is None or terminal.get("destroy_ts") is not None:
				try:
					helpers.request_json(
						"GET", actor_url(actor_id, "/bottomless-verify"), timeout=10
					)
				except urllib.error.HTTPError as exc:
					if exc.code != 404:
						raise
				else:
					raise RuntimeError("destroyed Actor remained gateway-accessible")
				case["outcome"] = "destroyed"
				case["destroy_ts"] = None if terminal is None else terminal.get("destroy_ts")
			else:
				state_after = helpers.request_json(
					"GET",
					f"{depot}/depot/inspect/buckets/{namespace_id}/databases/{actor_id}/bottomless-state",
					timeout=10,
				)
				if state_after.get("head") is None:
					raise RuntimeError("active Actor points at missing SQLite head")
				wait_actor(lambda suffix: actor_url(actor_id, suffix), actor_id)
				case["active_verification"] = verify_export(
					engine, actor_id, actor_namespace, 1024 * 1024
				)
				case["outcome"] = "active"
			evidence["cases"].append(case)

		evidence["verdict"] = "passed"
	except Exception as exc:
		failure = exc
		evidence["verdict"] = "failed"
		evidence["error"] = {"type": type(exc).__name__, "message": str(exc)}
	finally:
		for actor_id in test_actor_ids:
			for attempt in range(10):
				try:
					helpers.request_json(
						"DELETE",
						f"{engine}/actors/{urllib.parse.quote(actor_id, safe='')}?{query}",
						timeout=10,
					)
					actor = control(actor_id)
					if actor is None or actor.get("destroy_ts") is not None:
						break
				except Exception:
					pass
				time.sleep(min(attempt + 1, 5))
		forward.stop()

	args.output.parent.mkdir(parents=True, exist_ok=True)
	temporary = args.output.with_suffix(args.output.suffix + ".tmp")
	temporary.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
	os.replace(temporary, args.output)
	print(json.dumps(evidence, indent=2, sort_keys=True))
	if failure is not None:
		raise failure


if __name__ == "__main__":
	main()
