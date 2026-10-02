import importlib.util
import json
import subprocess
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).parent
SPEC = importlib.util.spec_from_file_location("agent_upload_observe", ROOT / "observe.py")
assert SPEC is not None and SPEC.loader is not None
OBSERVE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(OBSERVE)


class OptionalKubernetesObjectTest(unittest.TestCase):
    @mock.patch.object(OBSERVE.subprocess, "run")
    def test_exact_not_found_is_returned_as_absent(self, run):
        run.return_value = subprocess.CompletedProcess([], 0, stdout="", stderr="")
        self.assertIsNone(OBSERVE.kube_optional(Path("/tmp/config"), "get", "machineset", "retired"))
        self.assertIn("--ignore-not-found=true", run.call_args.args[0])
        self.assertTrue(run.call_args.kwargs["check"])

    @mock.patch.object(OBSERVE.subprocess, "run")
    def test_present_object_is_decoded(self, run):
        value = {"metadata": {"uid": "machine-set-uid"}, "spec": {"replicas": 0}}
        run.return_value = subprocess.CompletedProcess(
            [], 0, stdout=json.dumps(value) + "\n", stderr="",
        )
        self.assertEqual(
            OBSERVE.kube_optional(Path("/tmp/config"), "get", "machineset", "retired"),
            value,
        )

    @mock.patch.object(OBSERVE.subprocess, "run")
    def test_transport_failure_is_not_reclassified_as_absent(self, run):
        run.side_effect = subprocess.CalledProcessError(1, ["kubectl"], stderr="timeout")
        with self.assertRaises(subprocess.CalledProcessError):
            OBSERVE.kube_optional(Path("/tmp/config"), "get", "machineset", "retired")


class DiagnosticMetricTest(unittest.TestCase):
    def test_capacity_trace_preserves_depot_pressure(self):
        queries = OBSERVE.metric_queries("actor-fdb-cell-system", "actor-bj-a01")
        self.assertEqual(
            set(queries),
            {
                "activeActors", "hostRssBytes", "udbPending", "gasolineWorkflows",
                "depotManagerRefreshInflight", "depotManagerRefreshWaiters",
                "depotCompactionInflight", "depotCompactionWaiters",
            },
        )
        self.assertIn('class="manager_refresh"', queries["depotManagerRefreshInflight"])
        self.assertIn('class="compaction"', queries["depotCompactionWaiters"])
        self.assertTrue(all('pod=~"actor-bj-a01-' in query for query in queries.values()))


if __name__ == "__main__":
    unittest.main()
