#!/usr/bin/env python3

import importlib.util
import pathlib
import time
import unittest
from unittest import mock


MODULE = pathlib.Path(__file__).with_name("provider.py")
SPEC = importlib.util.spec_from_file_location("stateless_capacity_provider", MODULE)
provider = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(provider)


def snapshot(**changes):
	values = {
		"phase": "Pending",
		"desired_replicas": 2,
		"pod_identity": "Exact",
		"node_exists": False,
		"node_ready": False,
		"node_admitted": False,
		"node_cordoned": False,
		"node_busy": False,
	}
	values.update(changes)
	return provider.Snapshot(**values)


class ProviderStateMachineTest(unittest.TestCase):
	def test_node_is_never_ready_before_exact_image_admission(self):
		self.assertEqual(provider.decide(snapshot()), "Provision")
		self.assertEqual(
			provider.decide(snapshot(phase="Provisioning", node_exists=True, node_ready=True)),
			"Prepare",
		)
		self.assertEqual(
			provider.decide(snapshot(
				phase="Provisioning", node_exists=True, node_ready=True, node_admitted=True
			)),
			"MarkReady",
		)

	def test_pod_or_node_identity_change_fails_closed(self):
		self.assertEqual(
			provider.decide(snapshot(phase="Ready", pod_identity="Replaced", node_exists=True)),
			"Fail",
		)
		self.assertEqual(provider.decide(snapshot(phase="Ready")), "Fail")

	def test_scale_down_waits_for_pod_and_every_non_daemon_workload(self):
		self.assertEqual(
			provider.decide(snapshot(
				phase="Ready", desired_replicas=1, node_exists=True, node_admitted=True
			)),
			"BeginDrain",
		)
		self.assertEqual(
			provider.decide(snapshot(
				phase="Draining", desired_replicas=1, node_exists=True,
				node_cordoned=True, pod_identity="Exact",
			)),
			"None",
		)
		self.assertEqual(
			provider.decide(snapshot(
				phase="Draining", desired_replicas=1, node_exists=True,
				node_cordoned=True, pod_identity="Absent", node_busy=True,
			)),
			"None",
		)
		self.assertEqual(
			provider.decide(snapshot(
				phase="Draining", desired_replicas=1, node_exists=True,
				node_cordoned=True, pod_identity="Absent", node_busy=False,
			)),
			"Delete",
		)

	def test_scale_up_aborts_retirement(self):
		self.assertEqual(
			provider.decide(snapshot(
				phase="Draining", desired_replicas=2, node_exists=True,
				node_cordoned=True, pod_identity="Exact",
			)),
			"Restore",
		)
		self.assertEqual(
			provider.decide(snapshot(
				phase="Draining", desired_replicas=2, node_exists=True,
				node_cordoned=True, pod_identity="Absent",
			)),
			"Fail",
		)


class ProviderSafetyTest(unittest.TestCase):
	def make_provider(self):
		return provider.Provider(
			kubeconfig="unused",
			cluster="rivet-runtime-a",
			namespace="actor-stateless-system",
			cell="local-runtime-a",
			deployment="local-runtime-a-stateless-executor",
			runtime_image="runtime:test",
			runtime_image_id="sha256:" + "a" * 64,
			run_id="deadbeef",
		)

	def test_multiple_active_requests_fail_closed(self):
		instance = self.make_provider()
		instance.requests = lambda: [
			{"metadata": {"name": "a"}, "status": {"phase": "Pending"}},
			{"metadata": {"name": "b"}, "status": {"phase": "Ready"}},
		]
		with self.assertRaisesRegex(RuntimeError, "2 active requests"):
			instance.request()

	def test_status_transition_has_resource_version_precondition(self):
		instance = self.make_provider()
		instance.kubectl = mock.Mock(return_value="")
		request = {
			"metadata": {"name": "request", "generation": 2, "resourceVersion": "19"},
			"status": {"phase": "Pending"},
		}
		instance.transition(request, "Provisioning", "accepted")
		patch = instance.kubectl.call_args.args[6]
		self.assertEqual(provider.json.loads(patch)["metadata"]["resourceVersion"], "19")

	def test_delete_is_fenced_by_run_and_node_uid(self):
		instance = self.make_provider()
		node = {
			"metadata": {"uid": "new", "labels": {provider.RUN_LABEL: "deadbeef"}},
		}
		instance.maybe_json = lambda *args, **kwargs: node
		with self.assertRaisesRegex(RuntimeError, "replacement Node"):
			instance.delete_node(expected_node_uid="old")

	def test_orphan_container_delete_requires_runtime_ownership_label(self):
		instance = self.make_provider()
		instance.maybe_json = lambda *args, **kwargs: None
		instance.json = lambda *args, **kwargs: {"spec": {"replicas": 1}}
		instance.node_busy = lambda _node: False
		instance.k3d_nodes = lambda: {instance.node_name}
		instance.command = mock.Mock(return_value=provider.json.dumps([{
			"Config": {"Labels": {
				provider.RUN_LABEL: "somebody-else",
				"k3d.cluster": "rivet-runtime-a",
			}},
		}]))
		with self.assertRaisesRegex(RuntimeError, "unowned provider container"):
			instance.delete_node()

	def test_stop_cancels_active_subprocess(self):
		instance = self.make_provider()
		instance.reconcile_once = lambda: instance.command(["sleep", "30"], timeout=60)
		instance.start()
		time.sleep(0.3)
		started = time.monotonic()
		instance.stop()
		self.assertLess(time.monotonic() - started, 3)
		self.assertEqual(instance.reconcile_errors, 0)

	def test_node_admission_requires_all_evidence(self):
		image_id = "sha256:" + "b" * 64
		node = {
			"metadata": {
				"labels": {
					"rivet.dev/stateless": "true",
					"fleet.actor.dev/stateless-admitted": "true",
				},
				"annotations": {provider.PREPARED_IMAGE_ANNOTATION: image_id},
			},
			"spec": {"taints": [{"key": "rivet.dev/stateless", "effect": "NoSchedule"}]},
		}
		self.assertTrue(provider.node_admitted(node, image_id))
		node["spec"]["taints"].append({"key": provider.STARTUP_TAINT_KEY})
		self.assertFalse(provider.node_admitted(node, image_id))

	def test_k3d_inherited_agent_args_are_normalized_without_duplicate_taints(self):
		instance = self.make_provider()
		node = {
			"metadata": {
				"uid": "node-uid",
				"labels": {
					provider.RUN_LABEL: "deadbeef",
					"local.fleet.actor.dev/stateless-base": "true",
					"rivet.dev/compute": "true",
				},
				"annotations": {},
			},
			"spec": {"taints": [
				{"key": "rivet.dev/stateless", "value": "true", "effect": "NoSchedule"},
				{"key": provider.STARTUP_TAINT_KEY, "value": "pending", "effect": "NoSchedule"},
			]},
		}
		instance.k3d_nodes = lambda: set()
		instance.maybe_json = lambda *args, **kwargs: node
		instance.json = lambda *args, **kwargs: node
		instance.command = mock.Mock(return_value="")
		instance.kubectl = mock.Mock(return_value="")

		instance.ensure_node()

		create = instance.command.call_args_list[0].args[0]
		self.assertNotIn("--k3s-arg", create)
		self.assertNotIn("--node-taint=rivet.dev/stateless=true:NoSchedule", create)
		self.assertIn("--runtime-label", create)
		self.assertIn(f"{provider.RUN_LABEL}=deadbeef", create)
		label_removal = next(
			call for call in instance.kubectl.call_args_list
			if call.args[:3] == ("label", "node", instance.node_name)
			and "local.fleet.actor.dev/stateless-base-" in call.args
		)
		self.assertIsNotNone(label_removal)
		publish_index = next(
			index for index, call in enumerate(instance.kubectl.call_args_list)
			if "fleet.actor.dev/stateless-admitted=true" in call.args
		)
		annotate_index = next(
			index for index, call in enumerate(instance.kubectl.call_args_list)
			if call.args[:3] == ("annotate", "node", instance.node_name)
		)
		self.assertLess(annotate_index, publish_index)


if __name__ == "__main__":
	unittest.main()
