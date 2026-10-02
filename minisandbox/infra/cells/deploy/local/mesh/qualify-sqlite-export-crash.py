#!/usr/bin/env python3
"""Destructively qualify a cold 256 MiB Actor SQLite export across an Engine restart."""

import argparse
import base64
import importlib.util
import json
import os
import pathlib
import signal
import sqlite3
import subprocess
import tempfile
import threading
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
	parser.add_argument("--engine-port", type=int, default=21520)
	parser.add_argument("--depot-port", type=int, default=21521)
	parser.add_argument("--fill-bytes", type=int, default=256 * 1024 * 1024)
	parser.add_argument("--download-rate", default="1m")
	parser.add_argument("--lease-ttl-ms", type=int, default=10_000)
	parser.add_argument("--settle-timeout-seconds", type=float, default=900)
	parser.add_argument(
		"--preserve-on-failure",
		action="store_true",
		help="leave the Actor and its Depot metadata intact when qualification fails",
	)
	return parser.parse_args()


def wait_actor(url, actor_id, timeout=180):
	deadline = time.monotonic() + timeout
	while time.monotonic() < deadline:
		try:
			payload = helpers.request_json("GET", url("/counter"), timeout=10)
			if payload.get("actorId") == actor_id:
				return payload
		except Exception:
			pass
		time.sleep(0.25)
	raise TimeoutError("Actor did not become ready")


def wait_single_engine_pod(args, namespace, timeout=120):
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
		active = [
			item
			for item in payload.get("items", [])
			if item.get("status", {}).get("phase") == "Running"
			and item.get("metadata", {}).get("deletionTimestamp") is None
		]
		if len(active) == 1 and len(payload.get("items", [])) == 1:
			return active[0]["metadata"]["uid"]
		time.sleep(0.25)
	raise TimeoutError("Engine rollout left multiple routable Pods")


def wait_settled(state_fn, checkpoint_fn, timeout, stable_samples=2, on_sample=None):
	deadline = time.monotonic() + timeout
	stable = 0
	last = None
	try:
		checkpoint_fn()
	except (TimeoutError, OSError):
		# The durable compaction root below resolves this uncertain result. Repeatedly forcing a
		# checkpoint would refresh branch access and prevent the hot-shard reclaimer from running.
		pass
	while time.monotonic() < deadline:
		try:
			last = state_fn()
		except (TimeoutError, OSError):
			time.sleep(0.5)
			continue
		if on_sample is not None:
			on_sample(last)
		settled = (
			last.get("cold_ready") is True
			and last["row_counts"]["hot_shards"]["count"] == 0
			and last["row_counts"]["staged_hot_shards"]["count"] == 0
		)
		stable = stable + 1 if settled else 0
		if stable >= stable_samples:
			return last
		time.sleep(0.5)
	raise TimeoutError(f"database did not fully settle to COS: {last}")


def sqlite_verify(path, expected_bytes, expected_count):
	connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
	try:
		integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
		if integrity != "ok":
			raise RuntimeError(f"SQLite integrity_check failed: {integrity}")
		count = connection.execute("SELECT value FROM counters WHERE name = 'main'").fetchone()[0]
		chunks, total, corrupt = connection.execute(
			"SELECT count(*), coalesce(sum(length(payload)), 0), "
			"coalesce(sum(payload != zeroblob(length(payload))), 0) "
			"FROM bottomless_qualification_payloads"
		).fetchone()
	finally:
		connection.close()
	if count != expected_count:
		raise RuntimeError(f"counter mismatch: expected {expected_count}, got {count}")
	if total != expected_bytes or corrupt != 0:
		raise RuntimeError(
			f"payload mismatch: expected_bytes={expected_bytes}, bytes={total}, corrupt={corrupt}"
		)
	return {"integrity_check": integrity, "counter": count, "chunks": chunks, "bytes": total}


def export_pin_count(payload):
	count = 0
	for row in payload.get("rows", []):
		encoded = row.get("key", "")
		try:
			key = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
		except (ValueError, TypeError):
			continue
		if b"export/" in key:
			count += 1
	return count


def main():
	args = parse_args()
	namespace = "actor-fdb-cell-system"
	engine = f"http://127.0.0.1:{args.engine_port}"
	depot = f"http://127.0.0.1:{args.depot_port}"
	query = urllib.parse.urlencode({"namespace": "default"})
	actor_id = None
	namespace_id = None
	stop_writer = threading.Event()
	writer_state = {
		"attempted": 0,
		"succeeded": 0,
		"failed": 0,
		"http_failed": 0,
		"indeterminate": 0,
	}
	writer = None
	curl = None
	forward = helpers.PortForward(
		args.kubeconfig,
		namespace,
		f"{args.cell}-engine",
		[f"{args.engine_port}:6420", f"{args.depot_port}:6421"],
	)
	started_at = time.monotonic()
	evidence = {
		"schema": "rivet-sqlite-export-crash/v2",
		"cell": args.cell,
		"timings_ms": {},
	}
	failure = None
	original_runtime_config = None

	def actor_url(suffix):
		return f"{engine}/gateway/{urllib.parse.quote(actor_id, safe='')}{suffix}"

	def bottomless_state():
		return helpers.request_json(
			"GET",
			f"{depot}/depot/inspect/buckets/{namespace_id}/databases/{actor_id}/bottomless-state",
			timeout=10,
		)

	def checkpoint():
		return helpers.request_json(
			"POST",
			f"{depot}/depot/checkpoints/buckets/{namespace_id}/databases/{actor_id}",
			{"force_reclaim": True},
			timeout=15,
		)

	def pins(branch_id):
		return helpers.request_json(
			"GET", f"{depot}/depot/inspect/branches/{branch_id}/rows/pins", timeout=30
		)

	def write_loop():
		while not stop_writer.is_set():
			writer_state["attempted"] += 1
			try:
				helpers.request_json("POST", actor_url("/increment"), timeout=10)
				writer_state["succeeded"] += 1
			except urllib.error.HTTPError:
				writer_state["failed"] += 1
				writer_state["http_failed"] += 1
			except Exception:
				writer_state["failed"] += 1
				writer_state["indeterminate"] += 1
			stop_writer.wait(0.05)

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
			"target_bytes": 268_435_456,
			"limit_bytes": 536_870_912,
		}
		helpers.kubectl(
			args,
			"-n", namespace,
			"patch", "configmap", config_map_name,
			"--type=merge",
			"-p", json.dumps({"data": {"config.jsonc": json.dumps(qualification_config)}}),
		)
		# A short qualification-only TTL makes orphan reclamation observable without weakening the
		# production default. The rollout also proves the running image contains lease support.
		helpers.kubectl(
			args,
			"-n", namespace,
			"set", "env",
			f"deployment/{args.cell}-engine",
			f"RIVET_SQLITE_EXPORT_LEASE_TTL_MS={args.lease_ttl_ms}",
		)
		# A ConfigMap update does not change the Deployment's Pod template, and set env is a
		# no-op when the requested TTL is already present. Always force a fresh Pod so the
		# subPath-mounted runtime config is read again.
		helpers.kubectl(
			args, "-n", namespace, "rollout", "restart", f"deployment/{args.cell}-engine"
		)
		helpers.kubectl(
			args,
			"-n", namespace,
			"rollout", "status",
			f"deployment/{args.cell}-engine",
			"--timeout=5m",
		)
		wait_single_engine_pod(args, namespace)
		forward.start()
		namespace_payload = helpers.request_json("GET", f"{depot}/namespaces?name=default")
		namespace_id = namespace_payload["namespaces"][0]["namespace_id"]
		created = helpers.request_json(
			"POST",
			f"{engine}/actors?{query}",
			{
				"name": "workerd-counter",
				"key": f"export-crash-{int(time.time() * 1000)}",
				"runner_name_selector": "workerd",
				"crash_policy": "restart",
			},
		)
		actor_id = created["actor"]["actor_id"]
		evidence["actor_id"] = actor_id
		wait_actor(actor_url, actor_id)
		runtime_state = bottomless_state()
		if runtime_state["fdb_write_debt_target_bytes"] != 268_435_456:
			raise RuntimeError(
				"Engine did not load qualification write-debt target: "
				f"{runtime_state['fdb_write_debt_target_bytes']}"
			)
		if runtime_state["fdb_write_debt_limit_bytes"] != 536_870_912:
			raise RuntimeError(
				"Engine did not load qualification write-debt limit: "
				f"{runtime_state['fdb_write_debt_limit_bytes']}"
			)

		chunk_bytes = 256 * 1024
		chunk_count = (args.fill_bytes + chunk_bytes - 1) // chunk_bytes
		fill_started_at = time.monotonic()
		for chunk in range(0, chunk_count, 4):
			chunks = min(4, chunk_count - chunk)
			size = min(chunk_bytes, args.fill_bytes - chunk * chunk_bytes)
			for attempt in range(20):
				try:
					helpers.request_json(
						"POST",
						actor_url(
							f"/bottomless-fill?chunk={chunk}&chunks={chunks}&bytes={size}"
						),
						timeout=120,
					)
					break
				except urllib.error.HTTPError as exc:
					if exc.code not in (429, 502, 503, 504) or attempt == 19:
						raise
					time.sleep(min(2 ** attempt, 10))
				except (TimeoutError, OSError):
					if attempt == 19:
						raise
					time.sleep(min(2 ** attempt, 10))
			if chunk == 0:
				# The first durable write creates the database branch. Binding policy before this
				# point can target no branch and leaves hot shards under the default retention.
				helpers.request_json(
					"PUT",
					f"{depot}/depot/qualification/buckets/{namespace_id}/databases/{actor_id}/shard-cache-policy",
					{"retention_ms": 1},
				)
		evidence["timings_ms"]["fill"] = round((time.monotonic() - fill_started_at) * 1000)
		settlement_started_at = time.monotonic()
		settlement_milestones = {}

		def observe_settlement(state):
			elapsed_ms = round((time.monotonic() - settlement_started_at) * 1000)
			if state.get("cold_ready") is True:
				settlement_milestones.setdefault("cold_ready", elapsed_ms)
			if state["row_counts"]["staged_hot_shards"]["count"] == 0:
				settlement_milestones.setdefault("staged_hot_shards_zero", elapsed_ms)
			if state["row_counts"]["hot_shards"]["count"] == 0:
				settlement_milestones.setdefault("hot_shards_zero", elapsed_ms)

		settled = wait_settled(
			bottomless_state,
			checkpoint,
			args.settle_timeout_seconds,
			on_sample=observe_settlement,
		)
		evidence["timings_ms"]["settlement"] = round(
			(time.monotonic() - settlement_started_at) * 1000
		)
		evidence["timings_ms"]["settlement_milestones"] = settlement_milestones
		branch_id = settled["branch_id"]
		evidence["initial_settlement"] = {
			"head_txid": settled["head"]["head_txid"],
			"hot_shards": settled["row_counts"]["hot_shards"]["count"],
			"staged_hot_shards": settled["row_counts"]["staged_hot_shards"]["count"],
			"cold_ready": settled["cold_ready"],
		}

		writer = threading.Thread(target=write_loop, daemon=True)
		writer.start()
		while writer_state["succeeded"] < 3:
			time.sleep(0.1)

		with tempfile.TemporaryDirectory(prefix="rivet-export-crash-") as temp_dir:
			temp = pathlib.Path(temp_dir)
			partial = temp / "old-head.partial.sqlite"
			headers = temp / "old-head.headers"
			download_url = f"{engine}/actors/{urllib.parse.quote(actor_id, safe='')}/sqlite?{query}"
			curl = subprocess.Popen(
				[
					"curl", "--fail", "--silent", "--show-error",
					"--limit-rate", args.download_rate,
					"--dump-header", str(headers),
					"--output", str(partial), download_url,
				],
				stdout=subprocess.PIPE,
				stderr=subprocess.PIPE,
				text=True,
			)
			deadline = time.monotonic() + 60
			while time.monotonic() < deadline:
				if curl.poll() is not None:
					raise RuntimeError(f"limited download exited before restart: {curl.stderr.read()}")
				if partial.exists() and partial.stat().st_size >= 1024 * 1024 and headers.exists():
					break
				time.sleep(0.1)
			else:
				raise TimeoutError("limited download did not start")
			uid_before = helpers.engine_pod_uid(args, namespace)
			forward.stop()
			helpers.kubectl(
				args, "-n", namespace, "rollout", "restart", f"deployment/{args.cell}-engine"
			)
			helpers.kubectl(
				args, "-n", namespace, "rollout", "status",
				f"deployment/{args.cell}-engine", "--timeout=5m",
			)
			curl.wait(timeout=60)
			stderr = curl.stderr.read()
			if curl.returncode == 0:
				raise RuntimeError("old-head download incorrectly succeeded across Engine restart")
			uid_after = helpers.engine_pod_uid(args, namespace)
			if uid_after == uid_before:
				raise RuntimeError("Engine Pod UID did not change")
			forward.start()
			partial_bytes = partial.stat().st_size
			content_length = None
			for line in headers.read_text(errors="replace").splitlines():
				if line.lower().startswith("content-length:"):
					content_length = int(line.split(":", 1)[1].strip())
			if content_length is None or partial_bytes >= content_length:
				raise RuntimeError("interrupted response was not observably truncated")
			try:
				connection = sqlite3.connect(f"file:{partial}?mode=ro", uri=True)
				partial_integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
				connection.close()
			except sqlite3.DatabaseError as exc:
				partial_integrity = f"failed-closed: {exc}"
			if partial_integrity == "ok":
				raise RuntimeError("truncated old-head download passed SQLite integrity_check")
			evidence["crash"] = {
				"pod_uid_before": uid_before,
				"pod_uid_after": uid_after,
				"curl_exit_code": curl.returncode,
				"curl_stderr": stderr.strip(),
				"content_length": content_length,
				"partial_bytes": partial_bytes,
				"partial_integrity": partial_integrity,
				"lease_established": headers.exists() and partial_bytes > 0,
			}

			time.sleep(args.lease_ttl_ms / 1000 + 2)
			stop_writer.set()
			writer.join(timeout=30)
			if writer.is_alive():
				raise RuntimeError("background writer did not stop")
			# A request interrupted by the Engine restart can commit even when the client never
			# observes its reply. Read the authoritative actor state instead of treating client
			# acknowledgements as a transaction oracle.
			expected_count = int(wait_actor(actor_url, actor_id)["count"])
			final = temp / "new-head.sqlite"
			subprocess.run(
				["curl", "--fail", "--silent", "--show-error", "--output", str(final), download_url],
				check=True,
				timeout=args.settle_timeout_seconds,
			)
			# Acquiring the new export reaps an expired orphan from the interrupted export. The
			# completed response then releases its own lease. Poll the exact branch until no
			# internal export pin remains.
			pin_deadline = time.monotonic() + 60
			while True:
				pins_after_download = pins(branch_id)
				remaining_export_pins = export_pin_count(pins_after_download)
				if remaining_export_pins == 0:
					break
				if time.monotonic() >= pin_deadline:
					raise RuntimeError(
						f"orphan export pins were not reclaimed: {remaining_export_pins}"
					)
				time.sleep(0.5)
			verification = sqlite_verify(final, args.fill_bytes, expected_count)
			evidence["crash"].update({
				"pins_after_recovery_download": pins_after_download,
				"remaining_export_pins": remaining_export_pins,
			})
			evidence["new_head"] = verification
			evidence["writer"] = writer_state

		evidence["verdict"] = "passed"
	except Exception as exc:
		failure = exc
		evidence["verdict"] = "failed"
		evidence["error"] = {"type": type(exc).__name__, "message": str(exc)}
	finally:
		stop_writer.set()
		if curl is not None and curl.poll() is None:
			curl.terminate()
			try:
				curl.wait(timeout=5)
			except subprocess.TimeoutExpired:
				curl.kill()
				curl.wait(timeout=5)
		if writer is not None:
			writer.join(timeout=5)
		preserve_failure = failure is not None and args.preserve_on_failure
		if preserve_failure:
			evidence["failure_evidence_preserved"] = True
			if actor_id is not None:
				try:
					evidence["preserved_actor_control"] = helpers.request_json(
						"GET",
						f"{engine}/actors?{urllib.parse.urlencode({'namespace': 'default', 'actor_ids': actor_id})}",
						timeout=10,
					)
				except Exception as inspect_error:
					evidence["preserved_actor_control_error"] = str(inspect_error)
			if actor_id is not None and namespace_id is not None:
				try:
					evidence["preserved_bottomless_state"] = helpers.request_json(
						"GET",
						f"{depot}/depot/inspect/buckets/{namespace_id}/databases/{actor_id}/bottomless-state",
						timeout=10,
					)
				except Exception as inspect_error:
					evidence["preserved_bottomless_state_error"] = str(inspect_error)
		if not preserve_failure and actor_id is not None and namespace_id is not None:
			try:
				helpers.request_json(
					"DELETE",
					f"{depot}/depot/qualification/buckets/{namespace_id}/databases/{actor_id}/shard-cache-policy",
					timeout=10,
				)
			except Exception:
				pass
		if not preserve_failure and actor_id is not None:
			cleanup_error = None
			for attempt in range(10):
				try:
					helpers.request_json(
						"DELETE",
						f"{engine}/actors/{urllib.parse.quote(actor_id, safe='')}?{query}",
						timeout=10,
					)
					lookup = helpers.request_json(
						"GET",
						f"{engine}/actors?{urllib.parse.urlencode({'namespace': 'default', 'actor_ids': actor_id})}",
						timeout=10,
					)
					actors = lookup.get("actors", [])
					if not actors or actors[0].get("destroy_ts") is not None:
						evidence["actor_destroyed"] = True
						cleanup_error = None
						break
					cleanup_error = RuntimeError("Actor destroy has no durable destroy_ts")
				except Exception as exc:
					cleanup_error = exc
				time.sleep(min(attempt + 1, 5))
			if cleanup_error is not None:
				evidence["actor_destroyed"] = False
				evidence["actor_cleanup_error"] = str(cleanup_error)
				if failure is None:
					failure = cleanup_error
					evidence["verdict"] = "failed"
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

	evidence["timings_ms"]["total"] = round((time.monotonic() - started_at) * 1000)
	args.output.parent.mkdir(parents=True, exist_ok=True)
	temporary = args.output.with_suffix(args.output.suffix + ".tmp")
	temporary.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
	os.replace(temporary, args.output)
	print(json.dumps(evidence, indent=2, sort_keys=True))
	if failure is not None:
		raise failure


if __name__ == "__main__":
	main()
