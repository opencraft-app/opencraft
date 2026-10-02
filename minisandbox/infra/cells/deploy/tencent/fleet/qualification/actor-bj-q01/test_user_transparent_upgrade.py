#!/usr/bin/env python3
import importlib.util
import pathlib
import unittest
from unittest import mock


def load_module():
    path = pathlib.Path(__file__).resolve().with_name("user-transparent-upgrade.py")
    spec = importlib.util.spec_from_file_location("q01_user_transparent_upgrade", str(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


upgrade = load_module()


class UpgradeInvariantTests(unittest.TestCase):
    @staticmethod
    def healthy_snapshot(runtime_desired=3, runtime_ready=None):
        if runtime_ready is None:
            runtime_ready = runtime_desired
        return {
            "at": "2026-09-06T00:00:00Z",
            "engine_spec_replicas": 6,
            "engine_ready_replicas": 6,
            "engine_generation": 1,
            "engine_observed_generation": 1,
            "nats_spec_replicas": 3,
            "nats_ready_replicas": 3,
            "nats_generation": 1,
            "nats_observed_generation": 1,
            "nats_current_revision": "n",
            "nats_update_revision": "n",
            "runtime_spec_replicas": runtime_desired,
            "runtime_ready_replicas": runtime_ready,
            "runtime_generation": 1,
            "runtime_observed_generation": 1,
            "runtime_current_revision": "r",
            "runtime_update_revision": "r",
            "runtime_replica_field_managers": ["horizontal-pod-autoscaler"],
            "engine_template_sha256": "engine-template",
            "engine_images": {"container/engine": "runtime"},
            "nats_template_sha256": "nats-template",
            "nats_images": {"container/nats": "nats"},
            "runtime_template_sha256": "runtime-template",
            "runtime_images": {
                "init/prepare-workerd-config": "runtime",
                "container/workerd": "runtime",
                "container/workerd-metrics": "metrics",
            },
            "capacity_spec_replicas": 1,
            "capacity_ready_replicas": 1,
            "capacity_generation": 1,
            "capacity_observed_generation": 1,
            "capacity_template_sha256": "capacity-template",
            "capacity_images": {"container/controller": "reporter"},
            "reporter_spec_replicas": 1,
            "reporter_ready_replicas": 1,
            "reporter_generation": 1,
            "reporter_observed_generation": 1,
            "reporter_template_sha256": "reporter-template",
            "reporter_images": {"container/reporter": "reporter"},
            "engine_pods": [
                {"uid": "e" + str(index), "ready": True, "deleting": False}
                for index in range(6)
            ],
            "nats_pods": [
                {"uid": "n" + str(index), "ready": True, "deleting": False}
                for index in range(3)
            ],
            "runtime_pods": [
                {
                    "name": "runtime-" + str(index),
                    "uid": "r" + str(index),
                    "ready": index < runtime_ready,
                    "deleting": False,
                }
                for index in range(runtime_desired)
            ],
            "capacity_pods": [
                {"name": "capacity", "uid": "capacity", "ready": True, "deleting": False}
            ],
            "reporter_pods": [
                {"name": "reporter", "uid": "reporter", "ready": True, "deleting": False}
            ],
        }

    def test_replica_owner_is_found_only_at_exact_path(self):
        statefulset = {"metadata": {"managedFields": [
            {"manager": "horizontal-pod-autoscaler", "fieldsV1": {"f:spec": {"f:replicas": {}}}},
            {"manager": "rivet-runtime-installer", "fieldsV1": {"f:spec": {"f:template": {}}}},
        ]}}
        self.assertEqual(
            upgrade.replica_field_managers(statefulset),
            ["horizontal-pod-autoscaler"],
        )

    def test_optional_kubectl_json_suppresses_expected_absence(self):
        kube = upgrade.soak.Kubectl("/data/fake.kubeconfig")
        with mock.patch.object(
            upgrade.soak.subprocess, "check_output", return_value=""
        ) as command:
            self.assertIsNone(kube.json_optional(
                "-n", "namespace", "get", "configmap", "missing",
                "--ignore-not-found",
            ))
        self.assertEqual(
            command.call_args.kwargs["stderr"], upgrade.soak.subprocess.DEVNULL
        )

    def test_static_replica_owner_is_rejected(self):
        snapshot = {
            "engine_spec_replicas": 6,
            "engine_ready_replicas": 6,
            "engine_generation": 1,
            "engine_observed_generation": 1,
            "nats_spec_replicas": 3,
            "nats_ready_replicas": 3,
            "nats_generation": 1,
            "nats_observed_generation": 1,
            "nats_current_revision": "n",
            "nats_update_revision": "n",
            "runtime_spec_replicas": 3,
            "runtime_ready_replicas": 3,
            "runtime_generation": 1,
            "runtime_observed_generation": 1,
            "runtime_current_revision": "a",
            "runtime_update_revision": "a",
            "runtime_replica_field_managers": ["rivet-runtime-installer"],
            "capacity_spec_replicas": 1,
            "capacity_ready_replicas": 1,
            "capacity_generation": 1,
            "capacity_observed_generation": 1,
            "reporter_spec_replicas": 1,
            "reporter_ready_replicas": 1,
            "reporter_generation": 1,
            "reporter_observed_generation": 1,
            "engine_pods": [
                {"uid": str(index), "ready": True, "deleting": False}
                for index in range(6)
            ],
            "nats_pods": [
                {"uid": "n" + str(index), "ready": True, "deleting": False}
                for index in range(3)
            ],
            "runtime_pods": [
                {"uid": str(index), "ready": True, "deleting": False}
                for index in range(3)
            ],
            "capacity_pods": [
                {"uid": "capacity", "ready": True, "deleting": False}
            ],
            "reporter_pods": [
                {"uid": "reporter", "ready": True, "deleting": False}
            ],
        }
        with self.assertRaisesRegex(RuntimeError, "owns runtime replicas"):
            upgrade.assert_healthy_snapshot(snapshot)
        upgrade.assert_healthy_snapshot(snapshot, require_replica_ownership=False)

    def test_private_public_field_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "actor_id"):
            upgrade.assert_public_resource({"object": "object", "actor_id": "private"}, "object")

    def test_capacity_wait_accepts_hpa_scale_out_after_convergence(self):
        scaling = self.healthy_snapshot(runtime_desired=4, runtime_ready=3)
        converged = self.healthy_snapshot(runtime_desired=4, runtime_ready=4)
        with mock.patch.object(
            upgrade, "workload_snapshot", side_effect=[scaling, converged]
        ), mock.patch.object(upgrade.time, "sleep"):
            snapshot, evidence = upgrade.wait_for_healthy_capacity(object(), 60)
        self.assertEqual(snapshot["runtime_spec_replicas"], 4)
        self.assertEqual(snapshot["runtime_ready_replicas"], 4)
        self.assertEqual(len(evidence["observations"]), 2)

    def test_capacity_wait_does_not_record_timestamp_only_changes(self):
        first = self.healthy_snapshot()
        second = self.healthy_snapshot()
        second["at"] = "2026-09-06T00:00:05Z"
        with mock.patch.object(
            upgrade, "workload_snapshot", side_effect=[first, second]
        ), mock.patch.object(
            upgrade, "assert_healthy_snapshot", side_effect=[RuntimeError("not yet"), None]
        ), mock.patch.object(upgrade.time, "sleep"):
            _, evidence = upgrade.wait_for_healthy_capacity(object(), 60)
        self.assertEqual(len(evidence["observations"]), 1)

    def test_workload_timeline_is_bounded_and_commits_to_every_observation(self):
        timeline = upgrade.BoundedWorkloadTimeline()
        for index in range(1000):
            snapshot = self.healthy_snapshot(runtime_desired=3 + (index % 2))
            snapshot["at"] = "tick-{}".format(index)
            timeline.record_snapshot(snapshot)
        for index in range(200):
            timeline.record_error("failure-{}".format(index))
        summary = timeline.summary()
        self.assertEqual(summary["schema"], "bounded-workload-timeline/v1")
        self.assertEqual(summary["observation_count"], 1000)
        self.assertEqual(summary["state_change_count"], 1000)
        self.assertEqual(summary["error_count"], 200)
        self.assertLessEqual(len(summary["state_changes"]), 128)
        self.assertLessEqual(len(summary["errors"]), 128)
        self.assertEqual(summary["state_changes_truncated"], 872)
        self.assertEqual(summary["errors_truncated"], 72)
        self.assertEqual(summary["first_snapshot"]["at"], "tick-0")
        self.assertEqual(summary["last_snapshot"]["at"], "tick-999")
        self.assertEqual(len(summary["stream_sha256"]), 64)

    def test_workload_timeline_ignores_timestamp_only_state_changes(self):
        timeline = upgrade.BoundedWorkloadTimeline()
        first = self.healthy_snapshot()
        second = self.healthy_snapshot()
        second["at"] = "2026-09-06T00:00:02Z"
        timeline.record_snapshot(first)
        timeline.record_snapshot(second)
        summary = timeline.summary()
        self.assertEqual(summary["observation_count"], 2)
        self.assertEqual(summary["state_change_count"], 1)
        self.assertNotEqual(summary["stream_sha256"], "0" * 64)

    def test_changed_template_requires_every_old_uid_to_leave(self):
        before = {
            "template_sha256": "old",
            "pods": [{"name": "component-0", "uid": "old-0"}],
        }
        after = {
            "template_sha256": "new",
            "pods": [{"name": "component-0", "uid": "new-0"}],
        }
        evidence = upgrade.assert_component_transition("component", before, after)
        self.assertEqual(evidence["outcome"], "changed_complete_rollout")
        after["pods"][0]["uid"] = "old-0"
        with self.assertRaisesRegex(RuntimeError, "old Pod UIDs survived"):
            upgrade.assert_component_transition("component", before, after)

    def test_unchanged_fixed_template_requires_exact_uid_set(self):
        before = {
            "template_sha256": "same",
            "pods": [{"name": "component", "uid": "old"}],
        }
        after = {
            "template_sha256": "same",
            "pods": [{"name": "component", "uid": "new"}],
        }
        with self.assertRaisesRegex(RuntimeError, "Pod UID set changed"):
            upgrade.assert_component_transition("component", before, after)

    def test_unchanged_scalable_template_allows_ordinals_only_to_appear_or_leave(self):
        before = {
            "template_sha256": "same",
            "pods": [
                {"name": "runtime-0", "uid": "r0"},
                {"name": "runtime-1", "uid": "r1"},
                {"name": "runtime-2", "uid": "r2"},
            ],
        }
        after = {
            "template_sha256": "same",
            "pods": [
                {"name": "runtime-0", "uid": "r0"},
                {"name": "runtime-1", "uid": "r1"},
                {"name": "runtime-2", "uid": "r2"},
                {"name": "runtime-3", "uid": "r3"},
            ],
        }
        evidence = upgrade.assert_component_transition(
            "runtime", before, after, scalable=True
        )
        self.assertEqual(evidence["outcome"], "unchanged_preserved_existing_ordinals")
        after["pods"][1]["uid"] = "replacement"
        with self.assertRaisesRegex(RuntimeError, "existing ordinals were replaced"):
            upgrade.assert_component_transition("runtime", before, after, scalable=True)

    def test_target_images_are_exact_per_named_container(self):
        snapshot = {"capacity": {"images": {"container/controller": "digest-a"}}}
        self.assertEqual(
            upgrade.assert_target_images(
                snapshot, {"capacity": {"container/controller": "digest-a"}}
            ),
            {"capacity": {"container/controller": "digest-a"}},
        )
        with self.assertRaisesRegex(RuntimeError, "target image mismatch"):
            upgrade.assert_target_images(
                snapshot, {"capacity": {"container/controller": "digest-b"}}
            )


if __name__ == "__main__":
    unittest.main()
