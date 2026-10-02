#!/usr/bin/env python3
import argparse
import json
import pathlib
import sys


def verify(payload, expected_cell, expected_machine_set, cluster_uid=None, machine_set_uid=None):
	if payload.get("schema") != "rivet-runtime-machine-repair-qualification/v2":
		raise ValueError("unexpected receipt schema")
	if payload.get("verdict") != "passed":
		raise ValueError("qualification did not pass")
	if payload.get("cell") != expected_cell or payload.get("machine_set") != expected_machine_set:
		raise ValueError("receipt is not bound to the expected runtime MachineSet")
	if payload.get("delete_policy") != "Newest":
		raise ValueError("qualification did not bind deletePolicy=Newest")
	for key in ("cluster_uid", "machine_set_uid"):
		if not isinstance(payload.get(key), str) or not payload[key]:
			raise ValueError(f"{key} is missing")
	if cluster_uid is not None and payload["cluster_uid"] != cluster_uid:
		raise ValueError("Kubernetes cluster UID mismatch")
	if machine_set_uid is not None and payload["machine_set_uid"] != machine_set_uid:
		raise ValueError("MachineSet UID mismatch")
	baseline = payload.get("baseline_machine_uids")
	final = payload.get("final_machine_uids")
	if not isinstance(baseline, list) or not baseline or len(set(baseline)) != len(baseline):
		raise ValueError("baseline Machine UID inventory is invalid")
	if final != baseline or payload.get("exact_baseline_restored") is not True:
		raise ValueError("exact baseline Machine UID inventory was not restored")
	if payload.get("baseline_replicas") != len(baseline):
		raise ValueError("baseline replica count does not match Machine UID inventory")
	target = payload.get("target")
	if not isinstance(target, dict) or not all(target.get(key) for key in ("name", "uid", "node")):
		raise ValueError("exact repair target identity is incomplete")
	if target["uid"] in baseline:
		raise ValueError("repair target was not the isolated surge Machine")
	for key in ("started_at", "finished_at"):
		if not isinstance(payload.get(key), str) or not payload[key].endswith("Z"):
			raise ValueError(f"{key} is missing")


def main():
	parser = argparse.ArgumentParser()
	parser.add_argument("--expected-cell", required=True)
	parser.add_argument("--expected-machine-set", required=True)
	parser.add_argument("--cluster-uid")
	parser.add_argument("--machine-set-uid")
	parser.add_argument("receipt", type=pathlib.Path)
	args = parser.parse_args()
	try:
		payload = json.loads(args.receipt.read_text())
		verify(payload, args.expected_cell, args.expected_machine_set, args.cluster_uid, args.machine_set_uid)
	except (OSError, json.JSONDecodeError, ValueError) as error:
		print(f"invalid runtime Machine repair receipt: {error}", file=sys.stderr)
		return 1
	print("runtime Machine repair receipt: pass")
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
