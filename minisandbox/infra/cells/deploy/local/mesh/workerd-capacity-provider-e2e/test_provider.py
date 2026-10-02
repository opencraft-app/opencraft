#!/usr/bin/env python3

import importlib.util
import pathlib
import time
import unittest
from unittest import mock


MODULE = pathlib.Path(__file__).with_name("provider.py")
SPEC = importlib.util.spec_from_file_location("workerd_capacity_provider", MODULE)
provider = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(provider)


def snapshot(**changes):
	values = {
		"phase": "Pending",
		"desired_replicas": 2,
		"ordinal": 1,
		"pod_identity": "Exact",
		"node_exists": False,
		"node_ready": False,
		"node_cordoned": False,
		"node_busy": False,
	}
	values.update(changes)
	return provider.Snapshot(**values)


class ProviderStateMachineTest(unittest.TestCase):
	def test_provisioning_is_idempotent_across_restart(self):
		self.assertEqual(provider.decide(snapshot()), "Provision")
		self.assertEqual(provider.decide(snapshot(phase="Provisioning")), "Provision")
		self.assertEqual(
			provider.decide(snapshot(phase="Provisioning", node_exists=True, node_ready=True)),
			"MarkReady",
		)

	def test_replacement_pod_uid_fails_closed(self):
		self.assertEqual(
			provider.decide(snapshot(phase="Ready", pod_identity="Replaced", node_exists=True)),
			"Fail",
		)

	def test_replacement_node_identity_fails_before_state_machine(self):
		# Node UID validation is performed by the reconciler before Decide; the
		# pure state machine never receives authority to delete a replacement.
		source = MODULE.read_text()
		self.assertIn('expected_node_uid not in (None, node["metadata"]["uid"])', source)

	def test_scale_up_cancels_pending_node_retirement(self):
		self.assertEqual(
			provider.decide(
				snapshot(
					phase="Draining",
					desired_replicas=2,
					pod_identity="Absent",
					node_exists=True,
				)
			),
			"Restore",
		)

	def test_replacement_pod_can_rebind_only_to_the_fenced_node(self):
		previous = {
			"spec": {
				"ordinal": 1,
				"nodeName": "provider-node",
				"podRef": {"name": "workerd-1", "uid": "old-pod"},
			},
			"status": {"phase": "Failed", "nodeUID": "original-node"},
		}
		pod = {"metadata": {"name": "workerd-1", "uid": "new-pod"}, "spec": {"nodeName": "provider-node"}}
		node = {
			"metadata": {
				"uid": "original-node",
				"labels": {"local.fleet.actor.dev/provider-run-id": "deadbeef"},
			}
		}
		self.assertTrue(
			provider.can_rebind_replacement_pod(
				previous, pod, node, "provider-node", 1, "deadbeef"
			)
		)
		node["metadata"]["uid"] = "replacement-node"
		self.assertFalse(
			provider.can_rebind_replacement_pod(
				previous, pod, node, "provider-node", 1, "deadbeef"
			)
		)

	def test_scale_up_after_node_deletion_finishes_old_request(self):
		self.assertEqual(
			provider.decide(
				snapshot(
					phase="Deleting",
					desired_replicas=2,
					pod_identity="Absent",
					node_exists=False,
				)
			),
			"MarkDeleted",
		)

	def test_ready_request_never_claims_absent_capacity(self):
		self.assertEqual(
			provider.decide(snapshot(phase="Ready", node_exists=False)),
			"Fail",
		)

	def test_cordon_side_effect_is_reconciled_in_both_directions(self):
		self.assertEqual(
			provider.decide(snapshot(phase="Ready", node_exists=True, node_cordoned=True)),
			"Restore",
		)
		self.assertEqual(
			provider.decide(
				snapshot(
					phase="Draining",
					desired_replicas=1,
					node_exists=True,
					node_cordoned=False,
				)
			),
			"Cordon",
		)

	def test_busy_node_is_never_deleted(self):
		self.assertEqual(
			provider.decide(
				snapshot(
					phase="Draining",
					desired_replicas=1,
					pod_identity="Absent",
					node_exists=True,
					node_cordoned=True,
					node_busy=True,
				)
			),
			"None",
		)

	def test_empty_node_deletion_is_replay_safe(self):
		deleting = snapshot(
			phase="Deleting",
			desired_replicas=1,
			pod_identity="Absent",
			node_exists=True,
			node_cordoned=True,
		)
		self.assertEqual(provider.decide(deleting), "Delete")
		self.assertEqual(provider.decide(dataclasses_replace(deleting, node_exists=False)), "MarkDeleted")


class ProviderSafetyTest(unittest.TestCase):
	def make_provider(self):
		return provider.Provider(
			kubeconfig="unused",
			cluster="rivet-runtime-a",
			namespace="rivet-engine",
			cell="local-runtime-a",
			statefulset="workerd-local-runtime-a",
			runtime_image="workerd:test",
			run_id="deadbeef",
		)

	def test_active_request_wins_over_terminal_history(self):
		instance = self.make_provider()
		terminal = {
			"metadata": {"name": "old", "creationTimestamp": "2026-01-01T00:00:00Z"},
			"status": {"phase": "Deleted"},
		}
		active = {
			"metadata": {"name": "new", "creationTimestamp": "2026-01-01T00:01:00Z"},
			"status": {"phase": "Provisioning"},
		}
		instance.requests = lambda: [terminal, active]
		self.assertIs(instance.request(), active)

	def test_multiple_active_requests_fail_closed(self):
		instance = self.make_provider()
		instance.requests = lambda: [
			{"metadata": {"name": "a"}, "status": {"phase": "Pending"}},
			{"metadata": {"name": "b"}, "status": {"phase": "Ready"}},
		]
		with self.assertRaisesRegex(RuntimeError, "2 active requests"):
			instance.request()

	def test_status_transition_uses_resource_version_precondition(self):
		instance = self.make_provider()
		instance.kubectl = mock.Mock(return_value="")
		request = {
			"metadata": {"name": "request", "generation": 3, "resourceVersion": "17"},
			"status": {"phase": "Pending"},
		}
		instance.transition(request, "Provisioning", "accepted")
		patch = instance.kubectl.call_args.args[6]
		self.assertEqual(provider.json.loads(patch)["metadata"]["resourceVersion"], "17")

	def test_failed_k3d_delete_keeps_kubernetes_node_identity(self):
		instance = self.make_provider()
		node = {
			"metadata": {
				"uid": "node-uid",
				"labels": {"local.fleet.actor.dev/provider-run-id": "deadbeef"},
			}
		}
		instance.maybe_json = lambda *args, **kwargs: node
		instance.node_busy = lambda _name: False
		instance.k3d_nodes = lambda: {"k3d-workerd-provider-deadbeef-1-0"}
		instance.json = lambda *args, **kwargs: {"spec": {"replicas": 1}}
		instance.kubectl = mock.Mock()
		with mock.patch.object(provider, "run_command", side_effect=RuntimeError("delete failed")):
			with self.assertRaisesRegex(RuntimeError, "delete failed"):
				instance.delete_node(
					"k3d-workerd-provider-deadbeef-1-0",
					ordinal=1,
					expected_node_uid="node-uid",
				)
		self.assertNotIn(mock.call("delete", "node", mock.ANY, "--ignore-not-found"), instance.kubectl.mock_calls)

	def test_stop_cancels_an_active_subprocess(self):
		instance = self.make_provider()
		instance.reconcile_once = lambda: instance.command(["sleep", "30"], timeout=60)
		instance.start()
		time.sleep(0.3)
		started = time.monotonic()
		instance.stop()
		self.assertLess(time.monotonic() - started, 3)
		self.assertIsNone(instance.thread)
		self.assertEqual(instance.reconcile_errors, 0)

	def test_node_is_prepared_before_compute_capacity_is_published(self):
		instance = self.make_provider()
		node_name = "k3d-workerd-provider-deadbeef-1-0"
		node = {
			"metadata": {
				"uid": "node-uid",
				"annotations": {},
				"labels": {"local.fleet.actor.dev/provider-run-id": "deadbeef"},
			},
			"spec": {
				"taints": [
					{
						"key": provider.PREPARING_TAINT_KEY,
						"value": "true",
						"effect": "NoSchedule",
					}
				]
			},
		}
		instance.k3d_nodes = lambda: set()
		instance.maybe_json = lambda *args, **kwargs: node
		instance.json = lambda *args, **kwargs: node
		instance.command = mock.Mock(return_value="")
		instance.kubectl = mock.Mock(return_value="")

		instance.ensure_node(1, node_name)

		create_command = instance.command.call_args_list[0].args[0]
		self.assertNotIn("rivet.dev/compute=true", create_command)
		self.assertIn(
			f"--node-taint={provider.PREPARING_TAINT_KEY}=true:NoSchedule",
			create_command,
		)
		import_index = next(
			index
			for index, call in enumerate(instance.command.call_args_list)
			if call.args[0][:3] == ["k3d", "image", "import"]
		)
		self.assertGreater(import_index, 0)
		calls = instance.kubectl.call_args_list
		annotate_index = next(index for index, call in enumerate(calls) if call.args[0] == "annotate")
		publish_index = next(
			index
			for index, call in enumerate(calls)
			if call.args[:4] == ("label", "node", node_name, "rivet.dev/compute=true")
		)
		uncordon_index = next(index for index, call in enumerate(calls) if call.args[0] == "uncordon")
		self.assertLess(annotate_index, publish_index)
		self.assertLess(publish_index, uncordon_index)
		self.assertEqual(instance.image_imports, 1)

	def test_prepared_node_skips_cluster_image_import(self):
		instance = self.make_provider()
		node_name = "k3d-workerd-provider-deadbeef-1-0"
		node = {
			"metadata": {
				"uid": "node-uid",
				"annotations": {provider.PREPARED_IMAGE_ANNOTATION: "workerd:test"},
				"labels": {"local.fleet.actor.dev/provider-run-id": "deadbeef"},
			},
			"spec": {"taints": []},
		}
		instance.k3d_nodes = lambda: {node_name}
		instance.maybe_json = lambda *args, **kwargs: node
		instance.json = lambda *args, **kwargs: node
		instance.command = mock.Mock(return_value="")
		instance.kubectl = mock.Mock(return_value="")

		instance.ensure_node(1, node_name)

		instance.command.assert_not_called()
		self.assertEqual(instance.image_imports, 0)


def dataclasses_replace(value, **changes):
	values = value.__dict__.copy()
	values.update(changes)
	return provider.Snapshot(**values)


if __name__ == "__main__":
	unittest.main()
