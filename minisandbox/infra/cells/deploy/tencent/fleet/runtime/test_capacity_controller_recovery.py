import copy
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


MODULE = Path(__file__).with_name("capacity-controller-recovery.py")
SPEC = importlib.util.spec_from_file_location("capacity_recovery", MODULE)
assert SPEC and SPEC.loader
recovery = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(recovery)
CELL = "actor-bj-a01"
NAMESPACE = "actor-fdb-cell-system"
OLD_IMAGE = "registry.invalid/controller@sha256:" + "a" * 64
NEW_IMAGE = "registry.invalid/controller@sha256:" + "b" * 64


def fixture():
    hold = {"id": "release-" + "c" * 32, "workload_uid": "runtime-uid", "acquired_at": "2026-10-02T03:00:00Z"}
    intent = {
        "version": 2, "phase": "prepared", "machine_set_name": "np-runtime0",
        "machine_set_uid": "set-uid", "machine_name": "np-runtime0-a", "machine_uid": "machine-uid",
        "node_name": "10.1.2.3", "node_uid": "node-uid", "from_replicas": 5, "to_replicas": 4,
    }
    deployment = {
        "kind": "Deployment", "metadata": {"name": CELL + "-runtime-capacity", "namespace": NAMESPACE,
        "uid": "deployment-uid", "resourceVersion": "1", "labels": {recovery.CELL: CELL}},
        "spec": {"replicas": 1, "strategy": {"type": "Recreate"}, "template": {
            "metadata": {"labels": {recovery.CELL: CELL}}, "spec": {"containers": [
                {"name": "controller", "image": OLD_IMAGE, "env": [
                    {"name": "RUNTIME_AUTH_TOKEN", "valueFrom": {"secretKeyRef": {"name": "runtime-auth", "key": "token"}}}
                ]}
            ]}}},
    }
    statefulset = {"kind": "StatefulSet", "metadata": {"name": CELL + "-runtime-hosts", "namespace": NAMESPACE,
        "uid": "runtime-uid", "resourceVersion": "2", "labels": {recovery.CELL: CELL},
        "annotations": {recovery.HOLD: json.dumps(hold)}}}
    machine_set = {"kind": "MachineSet", "metadata": {"name": "np-runtime0", "uid": "set-uid", "resourceVersion": "3",
        "annotations": {recovery.INTENT: json.dumps(intent)}}, "spec": {"replicas": 5,
        "template": {"spec": {"metadata": {"labels": {recovery.CELL: CELL}}}}}}
    machine = {"kind": "Machine", "metadata": {"name": "np-runtime0-a", "uid": "machine-uid", "resourceVersion": "4",
        "labels": {recovery.MACHINE_SET: "np-runtime0"}}, "status": {"nodeRef": {"name": "10.1.2.3"}}}
    node = {"kind": "Node", "metadata": {"name": "10.1.2.3", "uid": "node-uid", "resourceVersion": "5",
        "labels": {recovery.MACHINE_SET: "np-runtime0"}}, "spec": {"taints": []}}
    return {"deployment": deployment, "statefulset": statefulset, "hold": hold, "machine_set": machine_set,
        "machines": {"items": [machine]}, "nodes": {"items": [node]}}


def prepare(state):
    return recovery.prepare(**state, cell=CELL, namespace=NAMESPACE, image=NEW_IMAGE,
        revision="d" * 40, manifest="e" * 64, journal_name=CELL + "-cap-recovery-" + "c" * 32)


def persisted(journal):
    result = copy.deepcopy(journal)
    result["metadata"].update(uid="journal-uid", resourceVersion="6")
    return result


class CapacityControllerRecoveryTests(unittest.TestCase):
    def test_prepared_and_armed_unattempted_are_exact_image_only_plans(self):
        for phase in ("prepared", "issued"):
            state = fixture()
            intent = json.loads(state["machine_set"]["metadata"]["annotations"][recovery.INTENT])
            intent["phase"] = phase
            state["machine_set"]["metadata"]["annotations"][recovery.INTENT] = json.dumps(intent)
            original = copy.deepcopy(state)
            configmap, patch = prepare(state)
            self.assertEqual(state, original)
            self.assertTrue(configmap["immutable"])
            journal = json.loads(configmap["data"]["journal.json"])
            self.assertEqual(journal["originalTemplate"], state["deployment"]["spec"]["template"])
            candidate = copy.deepcopy(journal["candidateTemplate"])
            self.assertEqual(candidate["spec"]["containers"][0]["image"], NEW_IMAGE)
            candidate["spec"]["containers"][0]["image"] = OLD_IMAGE
            self.assertEqual(candidate, journal["originalTemplate"])
            self.assertEqual([item["path"] for item in patch[:3]], ["/metadata/uid", "/metadata/resourceVersion", "/spec/template"])

    def test_attempts_receipts_bad_phases_and_malformed_intents_fail_closed(self):
        for change in ({"attempts": 1}, {"attempts": False}, {"request_id": "accepted"},
                       {"phase": "unknown"}, {"version": 1}, {"to_replicas": 2},
                       {"machine_name": "../replacement"}):
            with self.subTest(change=change):
                state = fixture()
                raw = state["machine_set"]["metadata"]["annotations"][recovery.INTENT]
                intent = json.loads(raw)
                intent.update(change)
                state["machine_set"]["metadata"]["annotations"][recovery.INTENT] = json.dumps(intent)
                with self.assertRaises(ValueError):
                    prepare(state)

    def test_uid_replacement_partial_fences_and_association_change_fail_closed(self):
        for target in ("node", "machine", "set", "hold", "annotation", "taint", "association"):
            with self.subTest(target=target):
                state = fixture()
                if target == "node":
                    state["nodes"]["items"][0]["metadata"]["uid"] = "replacement"
                elif target == "machine":
                    state["machines"]["items"][0]["metadata"]["uid"] = "replacement"
                elif target == "set":
                    state["machine_set"]["metadata"]["uid"] = "replacement"
                elif target == "hold":
                    state["statefulset"]["metadata"]["annotations"][recovery.HOLD] = "{}"
                elif target == "annotation":
                    state["nodes"]["items"][0]["metadata"]["annotations"] = {recovery.DRAIN: "another-owner"}
                elif target == "taint":
                    state["nodes"]["items"][0]["spec"]["taints"] = [{"key": recovery.DRAIN}]
                else:
                    state["machines"]["items"][0]["status"]["nodeRef"]["name"] = "another-node"
                with self.assertRaises(ValueError):
                    prepare(state)

    def test_duplicate_partial_or_large_inventory_fails_closed(self):
        for change in ("duplicate", "partial", "large"):
            state = fixture()
            if change == "partial":
                state["nodes"]["metadata"] = {"continue": "next"}
            else:
                state["nodes"]["items"] *= 2 if change == "duplicate" else 501
            with self.assertRaises(ValueError):
                prepare(state)

    def test_non_singleton_inline_credentials_and_mutable_images_fail_closed(self):
        for change in ("replicas", "strategy", "token", "image"):
            state = fixture()
            if change == "replicas":
                state["deployment"]["spec"]["replicas"] = 2
            elif change == "strategy":
                state["deployment"]["spec"]["strategy"]["type"] = "RollingUpdate"
            elif change == "token":
                state["deployment"]["spec"]["template"]["spec"]["containers"][0]["env"] = [{"name": "RUNTIME_AUTH_TOKEN", "value": "not-a-real-token"}]
            else:
                state["deployment"]["spec"]["template"]["spec"]["containers"][0]["image"] = "controller:latest"
            with self.assertRaises(ValueError):
                prepare(state)

    def test_status_only_change_refreshes_cas_without_adopting_another_writer(self):
        state = fixture()
        original = copy.deepcopy(state["deployment"])
        state["deployment"]["metadata"]["resourceVersion"] = "new-status-version"
        recovery.unchanged_original(state["deployment"], original, CELL, NAMESPACE)
        _, patch = prepare(state)
        self.assertEqual(patch[1]["value"], "new-status-version")
        state["deployment"]["spec"]["template"]["metadata"]["labels"]["another"] = "writer"
        with self.assertRaises(ValueError):
            recovery.unchanged_original(state["deployment"], original, CELL, NAMESPACE)

    def test_ambiguous_deployment_ack_can_rollback_and_rollback_is_idempotent(self):
        state = fixture()
        configmap, _ = prepare(state)
        configmap = persisted(configmap)
        journal = json.loads(configmap["data"]["journal.json"])
        state["deployment"]["spec"]["template"] = journal["candidateTemplate"]
        state["deployment"]["metadata"]["resourceVersion"] = "after-lost-ack"
        patch = recovery.rollback(state["deployment"], configmap, state["statefulset"])
        self.assertEqual(patch[1]["value"], "after-lost-ack")
        self.assertEqual(patch[-1]["value"], journal["originalTemplate"])
        state["deployment"]["spec"]["template"] = journal["originalTemplate"]
        self.assertEqual(recovery.rollback(state["deployment"], configmap, state["statefulset"])[-1]["value"], journal["originalTemplate"])

    def test_rollback_rejects_replacement_uid_foreign_template_or_mutable_journal(self):
        for change in ("uid", "template", "journal", "hold"):
            state = fixture()
            configmap, _ = prepare(state)
            configmap = persisted(configmap)
            journal = json.loads(configmap["data"]["journal.json"])
            state["deployment"]["spec"]["template"] = journal["candidateTemplate"]
            if change == "uid":
                state["deployment"]["metadata"]["uid"] = "replacement"
            elif change == "template":
                state["deployment"]["spec"]["template"]["spec"]["containers"][0]["image"] = OLD_IMAGE
                state["deployment"]["spec"]["template"]["metadata"]["labels"]["foreign"] = "writer"
            elif change == "journal":
                configmap["immutable"] = False
            else:
                state["statefulset"]["metadata"]["annotations"][recovery.HOLD] = "{}"
            with self.assertRaises(ValueError):
                recovery.rollback(state["deployment"], configmap, state["statefulset"])

    def test_cli_reads_exact_files_and_emits_a_persistable_journal(self):
        state = fixture()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = ["python3", str(MODULE), "prepare"]
            for key, flag in (("deployment", "deployment"), ("deployment", "original-deployment"),
                              ("statefulset", "statefulset"), ("hold", "hold-identity"),
                              ("machine_set", "machineset"), ("machines", "machines"), ("nodes", "nodes")):
                path = root / (flag + ".json")
                path.write_text(json.dumps(state[key]))
                args += ["--" + flag, str(path)]
            args += ["--cell", CELL, "--namespace", NAMESPACE, "--image", NEW_IMAGE, "--revision", "d" * 40,
                     "--manifest", "e" * 64, "--journal-name", CELL + "-cap-recovery-" + "c" * 32,
                     "--journal", str(root / "journal.json"), "--patch", str(root / "patch.json")]
            result = subprocess.run(args, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(json.loads((root / "journal.json").read_text())["immutable"])
            self.assertEqual(json.loads((root / "patch.json").read_text())[0]["op"], "test")

    def test_release_order_and_failed_recovery_hold_are_permanent_gates(self):
        source = MODULE.with_name("release-runtime.sh").read_text()
        ordered = ["acquire_runtime_release_hold\n", '"$script_dir/validate-runtime-image.sh"',
                   '"$operations_dir/preflight-image-pull.sh" /usr/local/bin/rivet-cell-reporter --help',
                   "\trecover_capacity_controller\n", "wait_for_runtime_capacity_settle\n", "rollout_started=true\n"]
        offsets = [source.index(value) for value in ordered]
        self.assertEqual(offsets, sorted(offsets))
        function = source[source.index("recover_capacity_controller() {"):source.index("restore_recovered_capacity_controller() {")]
        self.assertLess(function.index("create -f"), function.index("capacity_recovery_started=true"))
        self.assertLess(function.index("capacity_recovery_started=true"), function.index("patch deployment"))
        rollback_source = source[source.index("rollback() {"):source.index("trap rollback ERR INT TERM")]
        self.assertIn("retaining the release hold and durable journal", rollback_source)
        failure = rollback_source[rollback_source.index("if ! restore_recovered_capacity_controller"):]
        self.assertLess(failure.index('exit "$status"'), failure.index("release_runtime_release_hold"))

    def test_real_shell_journals_before_patch_and_recovers_lost_patch_ack(self):
        source = MODULE.with_name("release-runtime.sh").read_text()
        functions = source[source.index("recover_capacity_controller() {"):source.index("acquire_runtime_release_hold() {")]
        # A separate CLI process emulates the API's atomic JSON Patch contract.
        # No Python module mock replaces the production helper or shell stage.
        cli = '''#!/usr/bin/env python3
import copy,json,os,sys
from pathlib import Path
root=Path(os.environ["RECOVERY_TEST_STATE"])
args=sys.argv[1:]
if args[:1]==["-n"]:
    args=args[2:]
def emit(value):
    print(json.dumps(value))
def read(name):
    return json.loads((root/(name+".json")).read_text())
if args[0]=="get":
    key={"deployment":"deployment","statefulset":"statefulset","machineset":"machine_set","machines":"machines","nodes":"nodes"}[args[1]]
    emit(read(key))
elif args[0]=="create":
    if os.environ.get("RECOVERY_TEST_FAULT")=="journal-failure":
        sys.exit(7)
    journal=json.loads(Path(args[args.index("-f")+1]).read_text())
    journal["metadata"].update(uid="journal-uid",resourceVersion="6")
    (root/"persisted.json").write_text(json.dumps(journal))
    with (root/"events").open("a") as log:
        log.write("journal-persisted\\n")
    emit(journal)
elif args[0]=="patch":
    if not (root/"persisted.json").exists():
        sys.exit(99)
    original=read("deployment")
    working=copy.deepcopy(original)
    patch=json.loads(Path(args[args.index("--patch-file")+1]).read_text())
    for op in patch:
        keys=op["path"].strip("/").split("/")
        parent=working
        for key in keys[:-1]:
            parent=parent[int(key)] if isinstance(parent,list) else parent[key]
        key=int(keys[-1]) if isinstance(parent,list) else keys[-1]
        if op["op"]=="test":
            if parent[key]!=op["value"]:
                sys.exit(8)
        elif op["op"]=="replace":
            parent[key]=op["value"]
        else:
            sys.exit(9)
    working["metadata"]["resourceVersion"]=str(int(original["metadata"]["resourceVersion"])+1)
    (root/"deployment.json").write_text(json.dumps(working))
    with (root/"events").open("a") as log:
        log.write("deployment-patched\\n")
    if os.environ.get("RECOVERY_TEST_FAULT")=="lost-patch-ack" and not (root/"lost-ack").exists():
        (root/"lost-ack").touch()
        sys.exit(7)
    emit(working)
elif args[:2]==["rollout","status"]:
    sys.exit(0)
else:
    sys.exit(10)
'''
        for fault in ("none", "journal-failure", "lost-patch-ack"):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                state = fixture()
                for name, value in state.items():
                    (root / (name + ".json")).write_text(json.dumps(value))
                (root / "capacity.json").write_text(json.dumps(state["deployment"]))
                (root / "runtime-release-hold-identity.json").write_text(json.dumps(state["hold"]))
                command = root / "kubectl"
                command.write_text(cli)
                command.chmod(0o755)
                environment = {**os.environ, "PATH": str(root) + os.pathsep + os.environ["PATH"],
                    "RECOVERY_TEST_STATE": str(root), "RECOVERY_TEST_FAULT": fault}
                setup = '''set -euo pipefail
temporary=$RECOVERY_TEST_STATE
cell_name=actor-bj-a01
namespace=actor-fdb-cell-system
runtime_machine_set=np-runtime0
runtime_release_hold_id=release-cccccccccccccccccccccccccccccccc
runtime_admission_field_manager=rivet-runtime-admission-installer
runtime_capacity_recovery_field_manager=rivet-runtime-capacity-recovery
kubeconfig_args=()
capacity_recovery_started=false
'''
                setup += "capacity_recovery_helper=" + str(MODULE) + "\n"
                setup += "reporter_image=" + NEW_IMAGE + "\n"
                setup += "reporter_source_revision=" + "d" * 40 + "\n"
                setup += "reporter_source_manifest_sha=" + "e" * 64 + "\n"
                result = subprocess.run(["bash", "-c", setup + functions + "recover_capacity_controller"],
                    env=environment, capture_output=True, text=True)
                observed = json.loads((root / "deployment.json").read_text())
                if fault == "journal-failure":
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(observed, state["deployment"])
                    self.assertFalse((root / "persisted.json").exists())
                    continue
                self.assertEqual((root / "events").read_text().splitlines(), ["journal-persisted", "deployment-patched"])
                self.assertEqual(observed["spec"]["template"]["spec"]["containers"][0]["image"], NEW_IMAGE)
                self.assertEqual(result.returncode == 0, fault == "none", result.stderr)
                undone = subprocess.run(["bash", "-c", setup + functions + "restore_recovered_capacity_controller"],
                    env=environment, capture_output=True, text=True)
                self.assertEqual(undone.returncode, 0, undone.stderr)
                restored = json.loads((root / "deployment.json").read_text())
                self.assertEqual(restored["spec"]["template"], state["deployment"]["spec"]["template"])
                self.assertTrue((root / "persisted.json").exists())


if __name__ == "__main__":
    unittest.main()
