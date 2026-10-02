import importlib.util
import pathlib
import unittest
from unittest import mock


HERE = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("workers_api_autoscaling_observe", HERE / "observe.py")
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


def pod(name):
	return {
		"metadata": {"name": name, "uid": f"uid-{name}"},
		"spec": {"nodeName": f"node-{name}"},
		"status": {"conditions": [{"type": "Ready", "status": "True"}]},
	}


class ObserveTest(unittest.TestCase):
	@mock.patch.object(module, "kubectl_raw")
	@mock.patch.object(module, "kubectl")
	def test_sample_sorts_pods_and_preserves_metrics(self, kubectl, kubectl_raw):
		kubectl.side_effect = [
			{"spec": {"minReplicas": 3}, "status": {"currentReplicas": 3}},
			{"spec": {"replicas": 3}, "status": {"readyReplicas": 3}},
			{"items": [pod("z"), pod("a")]},
		]
		kubectl_raw.side_effect = [
			{"items": [{"describedObject": {"name": "a"}, "value": "1"}]},
			{"items": [{"describedObject": {"name": "a"}, "value": "2"}]},
		]
		value = module.sample(pathlib.Path("/kubeconfig"))
		self.assertEqual([item["name"] for item in value["pods"]], ["a", "z"])
		self.assertEqual(
			value["customMetrics"]["workers_api_routing_requests_in_flight"], {"a": "2"},
		)


if __name__ == "__main__":
	unittest.main()
