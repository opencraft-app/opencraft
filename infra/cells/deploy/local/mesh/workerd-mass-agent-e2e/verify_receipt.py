#!/usr/bin/env python3
import argparse
import json
import pathlib


def main():
	parser = argparse.ArgumentParser()
	parser.add_argument("receipt", type=pathlib.Path)
	parser.add_argument("--expected-agents", type=int, required=True)
	args = parser.parse_args()
	receipt = json.loads(args.receipt.read_text())
	assert receipt["schema"] == "rivet-workerd-mass-agent-e2e/v3"
	assert receipt["verdict"] == "passed"
	assert receipt["target_agents"] == args.expected_agents
	assert receipt["hosts_per_cell"] >= 1
	assert receipt["engines_per_cell"] >= 1
	assert receipt["host_capacity_per_host"] >= receipt["max_in_flight_per_host"] >= 1
	assert receipt["max_queued_per_host"] >= receipt["max_in_flight_per_host"]
	assert receipt["queue_timeout_ms"] >= 1_000
	assert receipt["populate"]["operated_count"] == args.expected_agents
	assert receipt["populate"]["requested_arrival_rate_per_second"] == receipt[
		"arrival_rate_per_second"
	]
	assert receipt["populate"]["throughput_per_second"] >= receipt["qualification_thresholds"][
		"min_populate_throughput_per_second"
	]
	maximum_p95 = receipt["qualification_thresholds"]["max_populate_p95_ms"]
	assert maximum_p95 == 0 or receipt["populate"]["latency_ms"]["p95"] <= maximum_p95
	maximum_latency = receipt["qualification_thresholds"]["max_populate_latency_ms"]
	assert maximum_latency == 0 or receipt["populate"]["latency_ms"]["max"] <= maximum_latency
	maximum_retries = receipt["qualification_thresholds"]["max_populate_retries"]
	assert maximum_retries < 0 or receipt["populate"]["retries"] <= maximum_retries
	assert sum(receipt["populate"]["cell_distribution"].values()) == args.expected_agents
	assert all(value > 0 for value in receipt["populate"]["cell_distribution"].values())
	assert receipt["quiescence"]["after_populate"] is True
	assert receipt["quiescence"]["after_probe"] is True
	assert receipt["cleanup"]["operated_count"] == args.expected_agents
	assert receipt["quiescence"]["after_cleanup"] is True
	for stats in receipt["quiescence"]["populate_stats"]["per_cell"].values():
		assert stats["host_count"] == receipt["hosts_per_cell"]
		assert stats["host_max_active_actors"] == (
			receipt["host_capacity_per_host"] * receipt["hosts_per_cell"]
		)
		assert stats["workerd_admission"]["max_in_flight"] == (
			receipt["max_in_flight_per_host"] * receipt["hosts_per_cell"]
		)
		assert stats["workerd_admission"]["max_queued"] == (
			receipt["max_queued_per_host"] * receipt["hosts_per_cell"]
		)
		assert stats["workerd_admission"]["rejected_total"] == 0
		assert stats["workerd_admission"]["timed_out_total"] == 0
		for host in stats["per_host"].values():
			assert host["host_max_active_actors"] == receipt["host_capacity_per_host"]
			assert host["workerd_admission"]["max_in_flight"] == receipt["max_in_flight_per_host"]
			assert host["workerd_admission"]["max_queued"] == receipt["max_queued_per_host"]
			assert host["workerd_admission"]["queue_timeout_ms"] == receipt["queue_timeout_ms"]
	assert receipt["sample_probe"]["operated_count"] == min(
		receipt["sample_agents"], args.expected_agents
	)
	resources = receipt["container_resources"]
	assert resources["after_populate"]["memory_peak_total"] >= resources["baseline"][
		"memory_peak_total"
	]
	for cell in resources["after_populate"]["per_cell"].values():
		assert cell["host_count"] == receipt["hosts_per_cell"]
		assert len(cell["engines"]) == receipt["engines_per_cell"]
		for host in cell["per_host"].values():
			for container in host.values():
				limit = container["memory_limit"]
				assert limit is None or container["memory_peak"] * 100 < limit * 95
	print(args.receipt)


if __name__ == "__main__":
	main()
