#!/usr/bin/env python3
import argparse
import json
import pathlib
import re
import sys


SHA256 = re.compile(r"^[0-9a-f]{64}$")


def verify(payload, expected_cell, expected_machine_set, cluster_uid=None, machine_set_uid=None, provider_receipt_sha256=None):
	if payload.get("schema") != "rivet-runtime-automatic-repair-qualification/v2":
		raise ValueError("unexpected receipt schema")
	if payload.get("verdict") != "passed":
		raise ValueError("automatic replacement qualification did not pass")
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
	provider_sha = payload.get("provider_receipt_sha256")
	if not isinstance(provider_sha, str) or SHA256.fullmatch(provider_sha) is None:
		raise ValueError("provider qualification receipt digest is invalid")
	if provider_receipt_sha256 is not None and provider_sha != provider_receipt_sha256:
		raise ValueError("provider qualification receipt digest mismatch")
	if not isinstance(payload.get("baseline_replicas"), int) or payload["baseline_replicas"] < 1:
		raise ValueError("baseline replica count is invalid")
	target = payload.get("target")
	replacement = payload.get("replacement")
	for label, identity in (("target", target), ("replacement", replacement)):
		if not isinstance(identity, dict) or not all(
			isinstance(identity.get(key), str) and identity[key]
			for key in ("name", "uid", "node", "node_uid", "zone")
		):
			raise ValueError(f"exact {label} identity is incomplete")
	if (target["uid"] == replacement["uid"] or target["node"] == replacement["node"] or
			target["node_uid"] == replacement["node_uid"]):
		raise ValueError("replacement reused the retired Machine or Node identity")
	if payload.get("fault_injected") is not True or payload.get("exact_target_removed") is not True:
		raise ValueError("exact fault and target removal were not proven")
	if payload.get("ready_capacity_restored") is not True:
		raise ValueError("ready admitted capacity was not restored")
	topology = payload.get("topology", {})
	if topology.get("required_zones") != 3:
		raise ValueError("three-zone repair contract is missing")
	for phase in ("baseline_zones", "final_zones"):
		zones = topology.get(phase)
		if not isinstance(zones, list) or len(zones) != 3 or len(set(zones)) != 3 or any(not isinstance(zone, str) or not zone for zone in zones):
			raise ValueError(f"{phase} is not an exact three-zone topology")
	if target["zone"] not in topology["baseline_zones"] or replacement["zone"] not in topology["final_zones"]:
		raise ValueError("target or replacement zone is outside the bound topology")
	for key in ("started_at", "finished_at"):
		if not isinstance(payload.get(key), str) or not payload[key].endswith("Z"):
			raise ValueError(f"{key} is missing")


def main():
	parser = argparse.ArgumentParser()
	parser.add_argument("--expected-cell", required=True)
	parser.add_argument("--expected-machine-set", required=True)
	parser.add_argument("--cluster-uid")
	parser.add_argument("--machine-set-uid")
	parser.add_argument("--provider-receipt-sha256")
	parser.add_argument("receipt", type=pathlib.Path)
	args = parser.parse_args()
	try:
		payload = json.loads(args.receipt.read_text())
		verify(payload, args.expected_cell, args.expected_machine_set, args.cluster_uid, args.machine_set_uid, args.provider_receipt_sha256)
	except (OSError, json.JSONDecodeError, ValueError) as error:
		print(f"invalid automatic runtime repair receipt: {error}", file=sys.stderr)
		return 1
	print("automatic runtime repair receipt: pass")
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
