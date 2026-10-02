import copy
import importlib.util
import pathlib
import unittest


HERE = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("workers_api_autoscaling_verify", HERE / "verify.py")
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


def sample(current=3, desired=3, ready=3):
	spec = {
		"minReplicas": 3, "maxReplicas": 30,
		"behavior": {"scaleDown": {
			"stabilizationWindowSeconds": 300, "selectPolicy": "Min",
			"policies": [
				{"type": "Percent", "value": 25, "periodSeconds": 60},
				{"type": "Pods", "value": 1, "periodSeconds": 60},
			],
		}},
		"metrics": [
			{"type": "Pods", "pods": {"metric": {"name": "workers_api_routing_requests_per_second"}, "target": {"averageValue": "200"}}},
			{"type": "Pods", "pods": {"metric": {"name": "workers_api_routing_requests_in_flight"}, "target": {"averageValue": "64"}}},
			{"type": "Resource", "resource": {"name": "cpu", "target": {"averageUtilization": 65}}},
			{"type": "Resource", "resource": {"name": "memory", "target": {"averageUtilization": 75}}},
		],
	}
	pods = [{"name": f"p{i}", "ready": True} for i in range(ready)]
	metrics = {name: {pod["name"]: "0" for pod in pods} for name in (
		"workers_api_routing_requests_per_second", "workers_api_routing_requests_in_flight",
	)}
	return {
		"hpa": {"spec": spec, "status": {"currentReplicas": current, "desiredReplicas": desired}},
		"deployment": {"specReplicas": current, "status": {"readyReplicas": ready}},
		"pods": pods, "customMetrics": metrics,
	}


def load():
	return {
		"schema": "actor-stateless-autoscaling-load/v1", "verdict": "passed", "runId": "a" * 32,
		"counters": {"started": 225, "completed": 225, "failed": 0, "peakInFlight": 225},
		"workerDeleted": True,
	}


def dependent():
	cells = {"actor-bj-a01": {"pods": 3, "nodes": 3}, "actor-bj-b01": {"pods": 3, "nodes": 3}}
	return [{"phase": "initial", "cells": cells}, {"phase": "final", "cells": cells}]


class VerifyTest(unittest.TestCase):
	def test_accepts_production_scale_cycle(self):
		value = module.verify([sample(), sample(4, 4, 4), sample()], load(), dependent(), 3, 200)
		self.assertEqual(value["verdict"], "passed")
		self.assertEqual(value["replicas"]["peakReady"], 4)

	def test_rejects_hpa_mutation(self):
		trace = [sample(), sample(4, 4, 4), sample()]
		trace[1] = copy.deepcopy(trace[1])
		trace[1]["hpa"]["spec"]["maxReplicas"] = 4
		with self.assertRaisesRegex(ValueError, "HPA spec changed"):
			module.verify(trace, load(), dependent(), 3, 200)

	def test_rejects_missing_metric(self):
		trace = [sample(), sample(4, 4, 4), sample()]
		trace[0]["customMetrics"]["workers_api_routing_requests_in_flight"] = {}
		with self.assertRaisesRegex(ValueError, "healthy floor"):
			module.verify(trace, load(), dependent(), 3, 200)

	def test_rejects_wrong_production_target(self):
		trace = [sample(), sample(4, 4, 4), sample()]
		for item in trace:
			item["hpa"]["spec"]["metrics"][1]["pods"]["target"]["averageValue"] = "65"
		with self.assertRaisesRegex(ValueError, "metric targets drifted"):
			module.verify(trace, load(), dependent(), 3, 200)

	def test_rejects_dependent_capacity_left_inflated(self):
		capacity = dependent()
		capacity[1]["cells"]["actor-bj-a01"] = {"pods": 4, "nodes": 3}
		with self.assertRaisesRegex(ValueError, "did not converge"):
			module.verify([sample(), sample(4, 4, 4), sample()], load(), capacity, 3, 200)


if __name__ == "__main__":
	unittest.main()
