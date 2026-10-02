#!/usr/bin/env python3
"""Validate a one-Cell Agent capacity profile and print its deterministic envelope."""

import argparse
import json
import math
import pathlib


def load_profile(path):
	profile = json.loads(path.read_text())
	assert profile["schema"] == "rivet-production-cell-capacity-profile/v1"
	assert profile["capacity_unit"] == "one_cell"
	return profile


def capacity_envelope(profile):
	qualification = profile["qualification"]
	topology = profile["topology"]
	workerd = profile["workerd"]
	planning = profile["planning"]
	hosts = topology["workerd_hosts"]
	resident_slots = hosts * workerd["active_actors_per_host"]
	in_flight_slots = hosts * workerd["max_in_flight_per_host"]
	create_rate = qualification["create_rate_per_second"]
	conversations = qualification["long_conversations"]
	resident_demand = math.ceil(
		create_rate * workerd["idle_sleep_ms"] / 1000 + conversations
	)
	in_flight_demand = math.ceil(
		create_rate * planning["ready_service_time_seconds"] + conversations
	)
	resident_usable = math.floor(
		resident_slots * (100 - planning["resident_headroom_percent"]) / 100
	)
	in_flight_usable = math.floor(
		in_flight_slots * (100 - planning["in_flight_headroom_percent"]) / 100
	)
	return {
		"resident_slots": resident_slots,
		"resident_usable": resident_usable,
		"resident_demand": resident_demand,
		"in_flight_slots": in_flight_slots,
		"in_flight_usable": in_flight_usable,
		"in_flight_demand": in_flight_demand,
		"aggregate_two_cell_arrival_rate": create_rate * 2,
		"aggregate_two_cell_agents": create_rate
		* qualification["duration_seconds"]
		* 2,
	}


def validate(profile):
	qualification = profile["qualification"]
	topology = profile["topology"]
	workerd = profile["workerd"]
	fdb = topology["foundationdb"]
	assert profile["status"] in {"candidate", "qualified"}
	assert qualification["actor_ready_max_ms"] <= 3000
	assert qualification["actor_ready_p95_ms"] <= qualification["actor_ready_max_ms"]
	assert qualification["platform_retries"] == 0
	assert fdb["redundancy_mode"] == "three_data_hall"
	assert fdb["process_count"] >= 9
	assert fdb["coordinator_count"] == 9
	assert fdb["zone_count"] == 3
	assert topology["nats_replicas"] == 3
	assert topology["engine_replicas"] == 3
	assert workerd["queue_timeout_ms"] <= qualification["actor_ready_max_ms"]
	assert workerd["max_in_flight_per_host"] <= workerd["active_actors_per_host"]
	assert workerd["max_queued_per_host"] >= workerd["max_in_flight_per_host"]
	envelope = capacity_envelope(profile)
	assert envelope["resident_demand"] <= envelope["resident_usable"]
	assert envelope["in_flight_demand"] <= envelope["in_flight_usable"]
	if profile["status"] == "qualified":
		assert all(value == "passed" for value in profile["evidence"].values())
	return envelope


def main():
	parser = argparse.ArgumentParser(description=__doc__)
	parser.add_argument(
		"profile",
		type=pathlib.Path,
		nargs="?",
		default=pathlib.Path(__file__).with_name("production-agent-v1.json"),
	)
	args = parser.parse_args()
	profile = load_profile(args.profile)
	print(json.dumps(capacity_envelope(profile) | {"valid": bool(validate(profile))}, indent=2))


if __name__ == "__main__":
	main()
