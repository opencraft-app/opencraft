#!/usr/bin/env python3
import importlib.util
import tempfile
import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "partition_runtime_manifest", ROOT / "partition-runtime-manifest.py"
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PartitionRuntimeManifestTest(unittest.TestCase):
    def test_extracts_exact_workloads_and_keeps_the_base(self):
        source = (ROOT / "runtime.yaml").read_text()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            MODULE.partition(source, output, "actor-bj-k01", True)
            expected = {
                "phase-base.yaml",
                "phase-engine.yaml",
                "phase-runtime.yaml",
                "phase-pool.yaml",
                "phase-reporter.yaml",
            }
            self.assertEqual({path.name for path in output.iterdir()}, expected)
            identities = {}
            for path in output.iterdir():
                identities[path.name] = {
                    (document["kind"], document["metadata"]["name"])
                    for document in yaml.safe_load_all(path.read_text())
                }
            self.assertEqual(
                identities["phase-engine.yaml"],
                {("Deployment", "actor-bj-k01-engine")},
            )
            self.assertEqual(
                identities["phase-runtime.yaml"],
                {("StatefulSet", "actor-bj-k01-runtime-hosts")},
            )
            self.assertEqual(
                identities["phase-pool.yaml"],
                {("Job", "actor-bj-k01-workerd-pool-init")},
            )
            self.assertEqual(
                identities["phase-reporter.yaml"],
                {("Deployment", "actor-bj-k01-cell-reporter")},
            )
            flattened = set().union(*identities.values())
            self.assertEqual(len(flattened), 15)

    def test_rejects_a_missing_enabled_reporter(self):
        documents = (ROOT / "runtime.yaml").read_text().split("\n---\n")
        source = "\n---\n".join(
            document
            for document in documents
            if MODULE.identity(document.strip())
            != ("Deployment", "actor-bj-k01-cell-reporter")
        )
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "failed to partition"):
                MODULE.partition(source, Path(directory), "actor-bj-k01", True)

    def test_installer_delays_field_handoffs_and_rolls_hosts_by_exact_uid(self):
        installer = (ROOT / "install.sh").read_text()
        ordered = [
            '-f "$temporary/phase-engine.yaml"',
            'rollout status deployment/"${cell_name}-engine"',
            '-f "$temporary/runtime-rollout-on-delete.json"',
            'runtime-release-fields-runtime.json',
            '-f "$temporary/phase-runtime.yaml"',
            'roll_runtime_hosts_serially',
            '-f "$temporary/runtime-rollout-rolling.json"',
            'runtime-release-fields-reporter.json',
            '-f "$temporary/phase-reporter.yaml"',
        ]
        offsets = []
        cursor = 0
        for marker in ordered:
            cursor = installer.index(marker, cursor)
            offsets.append(cursor)
            cursor += len(marker)
        self.assertEqual(offsets, sorted(offsets))
        for guard in (
            '"preconditions": {"uid": sys.argv[1]}',
            '--raw "/api/v1/namespaces/${namespace}/pods/${pod}"',
            'spec.get("updateStrategy") != {"type": "OnDelete"}',
            'controller-revision-hash',
            'runtime Host UID changed before drain',
            'runtime Host UID changed after drain',
            'not pod.get("spec", {}).get("nodeName")',
            'conditions(pod).get("Ready") != "True"',
            'workerd_metrics = next(item for item in runtime["spec"]["template"]["spec"]["containers"] if item["name"] == "workerd-metrics")',
            '{"name": "workerd-metrics", "image": workerd_metrics["image"]}',
        ):
            self.assertIn(guard, installer)

    def test_rollback_restores_nats_before_engine_then_host(self):
        release = (ROOT / "release-runtime.sh").read_text()
        self.assertIn(
            'operations.insert(0, {\n            "op": "replace",\n            "path": "/spec/updateStrategy"',
            release,
        )
        nats_patch = release.index('--patch-file "$temporary/nats-patch.json"')
        nats_wait = release.index('statefulset/"${cell_name}-nats" --timeout=10m')
        engine_patch = release.index('--patch-file "$temporary/engine-patch.json"')
        engine_wait = release.index('deployment/"${cell_name}-engine" --timeout=10m')
        runtime_patch = release.index('--patch-file "$temporary/runtime-patch.json"')
        runtime_wait = release.index('statefulset/"${cell_name}-runtime-hosts" --timeout=45m')
        self.assertLess(nats_patch, nats_wait)
        self.assertLess(nats_wait, engine_patch)
        self.assertLess(engine_patch, engine_wait)
        self.assertLess(engine_wait, runtime_patch)
        self.assertLess(runtime_patch, runtime_wait)

    def test_release_uid_cas_hold_serializes_the_scale_in_owner(self):
        release = (ROOT / "release-runtime.sh").read_text()
        hold_builder = (ROOT / "build-runtime-scale-in-hold-patch.py").read_text()
        for guard in (
            "fleet.actor.dev/runtime-release-hold",
            "statefulset-uid-cas-v1",
            "status == 75",
            "SECONDS + 900",
            'observed != identity',
            '"op": "remove", "path": path',
            "runtime release hold remains latched after rollback",
        ):
            self.assertIn(guard, release)
        for guard in (
            'phase not in ("Idle", "Observing")',
            "waiting for a passive phase",
            '"path": "/metadata/uid"',
            '"path": "/metadata/resourceVersion"',
            '"op": "test", "path": state_path',
            '"op": "replace", "path": state_path',
        ):
            self.assertIn(guard, hold_builder)
        acquire = release.rindex("acquire_runtime_release_hold\n")
        rollout = release.index("rollout_started=true")
        release_hold = release.rindex("release_runtime_release_hold\n")
        ledger = release.index("# Publish the release ledger only after")
        self.assertLess(acquire, rollout)
        self.assertLess(rollout, release_hold)
        self.assertLess(release_hold, ledger)

    def test_release_waits_for_exact_node_contraction_before_controller_restart(self):
        release = (ROOT / "release-runtime.sh").read_text()
        settle_checker = (ROOT / "check-runtime-capacity-settle.py").read_text()
        for guard in (
            "wait_for_runtime_capacity_settle",
            'node.tke.cloud.tencent.com/machineset=${runtime_machine_set}',
            "runtime capacity did not settle under release hold within 900 seconds",
        ):
            self.assertIn(guard, release)
        for guard in (
            "fleet.actor.dev/runtime-capacity-downscale-intent",
            "fleet.actor.dev/runtime-capacity-drain",
        ):
            self.assertIn(guard, settle_checker)
        acquire = release.rindex("acquire_runtime_release_hold\n")
        settle = release.rindex("wait_for_runtime_capacity_settle\n")
        rollout = release.index("rollout_started=true")
        self.assertLess(acquire, settle)
        self.assertLess(settle, rollout)

    def test_qualification_hold_waits_for_provider_contraction(self):
        helper = (ROOT / "with-runtime-scale-in-hold.sh").read_text()
        for guard in (
            "build-runtime-scale-in-hold-patch.py",
            "check-runtime-capacity-settle.py",
            "wait_for_runtime_capacity_settle",
            'node.tke.cloud.tencent.com/machineset=${runtime_machine_set}',
            "runtime capacity did not settle under scale-in hold within 900 seconds",
        ):
            self.assertIn(guard, helper)
        acquired = helper.index('[[ $acquired == true ]]')
        settled = helper.rindex("wait_for_runtime_capacity_settle\n")
        command = helper.rindex('RUNTIME_SCALE_IN_HOLD_HELD=1 "$@"')
        self.assertLess(acquired, settled)
        self.assertLess(settled, command)

    def test_release_rejects_irreversible_retention_before_rollout_and_kicks_after_health(self):
        release = (ROOT / "release-runtime.sh").read_text()
        validation = release.index('validate-gasoline-retention-transition.py')
        rollout = release.index("rollout_started=true")
        health = release.rindex("health_gate\n")
        kick = release.index('kick-gasoline-pruner.sh')
        ledger = release.index("# Publish the release ledger only after")
        self.assertLess(validation, rollout)
        self.assertLess(health, kick)
        self.assertLess(kick, ledger)

    def test_release_checks_host_drain_entrypoint_before_mutating_workloads(self):
        release = (ROOT / "release-runtime.sh").read_text()
        start = release.index('ACTOR_IMAGE_PREFLIGHT_NAME=host-drain-release')
        end = release.index('"$operations_dir/preflight-image-pull.sh" /usr/local/bin/workerd-host-drain-controller --help', start)
        probe = release[start:end]
        self.assertIn('ACTOR_IMAGE_PREFLIGHT_IMAGE="$reporter_image"', probe)
        self.assertIn('ACTOR_IMAGE_PREFLIGHT_NODE_SELECTOR=fleet.actor.dev/control-pool=true', probe)
        self.assertIn('ACTOR_IMAGE_PREFLIGHT_EXPECTED_EXIT_CODE=0', probe)
        self.assertIn("ACTOR_IMAGE_PREFLIGHT_REQUIRED_OUTPUT='Usage: workerd-host-drain-controller [--help]'", probe)
        self.assertLess(end, release.index("rollout_started=true"))
        self.assertLess(end, release.rindex("wait_for_runtime_capacity_settle\n"))
        dockerfile = (ROOT.parents[3] / "Dockerfile.actor-fleet-controller").read_text()
        self.assertIn("go test ./cmd/workerd-host-drain-controller", dockerfile)


if __name__ == "__main__":
    unittest.main()
