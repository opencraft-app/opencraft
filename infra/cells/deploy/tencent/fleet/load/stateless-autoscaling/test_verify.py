import importlib.util
import json
import pathlib
import tempfile
import unittest


HERE = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("stateless_autoscaling_verify", HERE / "verify.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


CELLS = ("actor-bj-a01", "actor-bj-b01")
RUNTIME_DIGEST = "sha256:" + "a" * 64
RUNTIME_IMAGE = "registry.example/runtime@" + RUNTIME_DIGEST


def cell(name, phase, floor=3):
	count = floor if phase in ("low", "hpa") else floor + 1
	nodes = [{
		"name": f"{name}-node-{index}", "uid": f"{name}-uid-{index}", "ready": True,
		"admitted": True, "admissionPhase": "Admitted", "runtimeImage": RUNTIME_IMAGE,
		"profileDigest": "profile", "taints": [],
	} for index in range(count)]
	pods = [{"name": f"pod-{index}", "uid": f"pod-uid-{index}", "node": nodes[index]["name"], "phase": "Running", "ready": True}
		for index in range(count)]
	if phase == "hpa":
		pods.append({"name": "pending", "uid": "pending", "node": None, "phase": "Pending", "ready": False})
	return {
		"cell": name, "errors": [],
		"hpa": {"uid": f"hpa-{name}", "current": floor if phase == "low" else floor + 1, "desired": floor if phase == "low" else floor + 1},
		"deployment": {"uid": f"deploy-{name}", "runtimeImage": RUNTIME_IMAGE, "runtimeDigest": RUNTIME_DIGEST,
			"desired": floor + 1 if phase == "hpa" else count, "ready": count, "available": count},
		"machineSet": {"uid": f"machine-{name}", "desired": count, "current": count, "ready": count},
		"nodes": nodes, "pods": pods,
	}


class VerifyTest(unittest.TestCase):
	def test_complete_low_expand_low_cycle_passes(self):
		with tempfile.TemporaryDirectory(dir="/data/tmp") as directory:
			root = pathlib.Path(directory)
			trace = root / "trace.ndjson"
			rows = [
				{"schema": "actor-stateless-autoscaling-sample/v1", "observedAt": "t0", "cells": [cell(name, "low") for name in CELLS]},
				{"schema": "actor-stateless-autoscaling-sample/v1", "observedAt": "t1", "cells": [cell(name, "hpa") for name in CELLS]},
				{"schema": "actor-stateless-autoscaling-sample/v1", "observedAt": "t2", "cells": [cell(name, "expanded") for name in CELLS]},
				{"schema": "actor-stateless-autoscaling-sample/v1", "observedAt": "t3", "cells": [cell(name, "low") for name in CELLS]},
			]
			trace.write_text("".join(json.dumps(row) + "\n" for row in rows))
			load = root / "load.json"
			load.write_text(json.dumps({
				"schema": "actor-stateless-autoscaling-load/v1", "verdict": "passed", "workerDeleted": True,
				"config": {"durationMs": 900000, "holdMs": 450000, "rate": 2.5, "maxInFlight": 1500, "responsePaddingBytes": 65536},
				"counters": {"started": 2400, "completed": 2400, "failed": 0},
			}))
			receipt = MODULE.verify(trace, load, CELLS, 3)
			self.assertEqual(receipt["verdict"], "passed")
			self.assertTrue(all(receipt["checks"].values()))

	def test_missing_pending_or_failed_load_cannot_pass(self):
		with tempfile.TemporaryDirectory(dir="/data/tmp") as directory:
			root = pathlib.Path(directory)
			trace = root / "trace.ndjson"
			rows = [
				{"schema": "actor-stateless-autoscaling-sample/v1", "observedAt": "t0", "cells": [cell(name, "low") for name in CELLS]},
				{"schema": "actor-stateless-autoscaling-sample/v1", "observedAt": "t1", "cells": [cell(name, "expanded") for name in CELLS]},
				{"schema": "actor-stateless-autoscaling-sample/v1", "observedAt": "t2", "cells": [cell(name, "low") for name in CELLS]},
			]
			trace.write_text("".join(json.dumps(row) + "\n" for row in rows))
			load = root / "load.json"
			load.write_text(json.dumps({
				"schema": "actor-stateless-autoscaling-load/v1", "verdict": "failed", "workerDeleted": True,
				"config": {"durationMs": 900000, "holdMs": 450000, "rate": 2.5, "maxInFlight": 1500, "responsePaddingBytes": 65536},
				"counters": {"started": 2400, "completed": 2399, "failed": 1},
			}))
			receipt = MODULE.verify(trace, load, CELLS, 3)
			self.assertEqual(receipt["verdict"], "failed")
			self.assertFalse(receipt["checks"]["loadPassed"])
			self.assertFalse(receipt["checks"]["pendingPodObservedInBothCells"])

	def test_new_node_with_stale_runtime_identity_cannot_pass(self):
		with tempfile.TemporaryDirectory(dir="/data/tmp") as directory:
			root = pathlib.Path(directory)
			baseline = [cell(name, "low") for name in CELLS]
			hpa = [cell(name, "hpa") for name in CELLS]
			expanded = [cell(name, "expanded") for name in CELLS]
			for value in expanded:
				value["nodes"][-1]["runtimeImage"] = "registry.example/runtime@sha256:" + "b" * 64
			trace = root / "trace.ndjson"
			trace.write_text("".join(json.dumps(row) + "\n" for row in [
				{"schema": "actor-stateless-autoscaling-sample/v1", "observedAt": "t0", "cells": baseline},
				{"schema": "actor-stateless-autoscaling-sample/v1", "observedAt": "t1", "cells": hpa},
				{"schema": "actor-stateless-autoscaling-sample/v1", "observedAt": "t2", "cells": expanded},
				{"schema": "actor-stateless-autoscaling-sample/v1", "observedAt": "t3", "cells": [cell(name, "low") for name in CELLS]},
			]))
			load = root / "load.json"
			load.write_text(json.dumps({
				"schema": "actor-stateless-autoscaling-load/v1", "verdict": "passed", "workerDeleted": True,
				"config": {"durationMs": 900000, "holdMs": 450000, "rate": 2.5, "maxInFlight": 1500, "responsePaddingBytes": 65536},
				"counters": {"started": 2400, "completed": 2400, "failed": 0},
			}))
			receipt = MODULE.verify(trace, load, CELLS, 3)
			self.assertEqual(receipt["verdict"], "failed")
			self.assertFalse(receipt["checks"]["tkeMachineAndAdmissionScaleUpObserved"])


if __name__ == "__main__":
	unittest.main()
