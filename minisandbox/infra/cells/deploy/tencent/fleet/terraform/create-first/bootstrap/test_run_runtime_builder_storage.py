#!/usr/bin/env python3
"""Real private files, flock and the repository's TAT shell protocol processes."""
import ast
import base64
import copy
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import zlib


ROOT = Path(__file__).resolve().parent


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


COORD = module("storage_coordinator", "run-runtime-builder-storage.py")
FIXTURE = module("storage_fixtures", "test_validate_runtime_builder_storage.py")
REVISION = "a" * 40
MANIFEST = "b" * 64


def valid_receipt():
    return {"schema": "actor-runtime-builder-storage-initialization/v1", "verdict": "passed",
            "storageReady": False, "mountVerified": True, "instanceId": "ins-builder01",
            "diskId": "disk-builder01", "filesystemUuid": "3e54d4d8-85b2-4e22-9054-6f3eb68d4c68",
            "journalSha256": "1" * 64, "mountUnitSha256": "2" * 64, "buildahStorageConfigSha256": "3" * 64}


DOUBLE = r'''#!/usr/bin/env python3
import base64,fcntl,json,os,sys
from pathlib import Path
root=Path(os.environ['BUILDER_COORDINATOR_DOUBLE'])
fixture=json.loads((root/'protocol.json').read_text())
args=sys.argv[1:]
action=args[1]
with (root/'calls.jsonl').open('a') as stream: stream.write(json.dumps(action)+'\n')
if os.environ.get('ASSERT_COORDINATOR_LOCK')=='1':
    with (root/'operation.lock').open('rb') as stream:
        try: fcntl.flock(stream,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError: pass
        else: raise SystemExit('original lock was not held during TAT')
if action=='RunCommand':
    assert json.loads(args[args.index('--InstanceIds')+1])==['ins-builder01']
    assert args[args.index('--Timeout')+1]=='900'
    encoded=args[args.index('--Content')+1]
    assert len(encoded)<=60000
    (root/'payload.sh').write_bytes(base64.b64decode(encoded))
    state=json.loads((root/'state.json').read_text())
    assert state['phase']=='submitting' and state['invocationId'] is None
    assert state['payloadSha256']==__import__('hashlib').sha256((root/'payload.sh').read_bytes()).hexdigest()
    if fixture.get('loseSubmission'):
        print('secret-marker',file=sys.stderr)
        raise SystemExit(1)
    print('{"InvocationId":"inv-builder01"}')
elif action=='DescribeInvocationTasks':
    assert json.loads(args[args.index('--Filters')+1])==[{'Name':'invocation-id','Values':['inv-builder01']}]
    marker=root/'observed'
    count=int(marker.read_text()) if marker.exists() else 0
    marker.write_text(str(count+1))
    if count==0 and fixture.get('loseObservation'):
        print('secret-marker',file=sys.stderr)
        raise SystemExit(1)
    output=fixture.get('receipt',{})
    status=fixture.get('status','SUCCESS')
    print(json.dumps({'InvocationTaskSet':[{'InstanceId':'ins-builder01','TaskStatus':status,
                      'TaskResult':{'ExitCode':0 if status=='SUCCESS' else 1,
                                    'Output':base64.b64encode(json.dumps(output).encode()).decode()}}]}))
else: raise SystemExit('unexpected cloud action')
'''


class CoordinatorTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir="/data/tmp")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.root.chmod(0o700)
        self.state = self.root / "state.json"
        self.inventory = FIXTURE.inventory()
        self.inventory_raw = json.dumps(self.inventory, sort_keys=True).encode()
        self.sources = {name: (ROOT / name).read_text() for name in COORD.TOOLS}
        self.protocol = {"receipt": valid_receipt()}
        self.captures = 0
        binaries = self.root / "bin"
        binaries.mkdir()
        cli = binaries / "tccli"
        cli.write_text(DOUBLE)
        cli.chmod(0o755)
        names = ("PATH", "TENCENT_PROFILE", "TENCENT_API_ROOT_DOMAIN", "TAT_POLL_SECONDS", "BUILDER_COORDINATOR_DOUBLE")
        previous = {key: os.environ.get(key) for key in names}
        def restore():
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
        self.addCleanup(restore)
        os.environ.update(PATH=str(binaries) + os.pathsep + os.environ["PATH"], TENCENT_PROFILE="protocol-double",
                          TAT_POLL_SECONDS="0", BUILDER_COORDINATOR_DOUBLE=str(self.root))
        os.environ.pop("TENCENT_API_ROOT_DOMAIN", None)

    def capture(self):
        self.captures += 1
        return FIXTURE.observation(time.time_ns() // 1000000)

    def coordinate(self, **options):
        (self.root / "protocol.json").write_text(json.dumps(self.protocol))
        return COORD.coordinate(self.inventory_raw, self.inventory, REVISION, MANIFEST, self.state,
                                self.capture, self.sources, pause=lambda seconds: self.assertEqual(seconds, 30), **options)

    def calls(self):
        path = self.root / "calls.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def test_exact_intent_precedes_single_submission_and_terminal_output_is_saved(self):
        self.assertEqual(self.coordinate(), valid_receipt())
        state = json.loads(self.state.read_text())
        self.assertEqual(state["phase"], "terminal")
        self.assertEqual(state["receipt"], valid_receipt())
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.calls().count("RunCommand"), 1)
        self.assertEqual(self.captures, 1)
        self.assertFalse(self.coordinate()["storageReady"])
        self.assertEqual(self.calls().count("RunCommand"), 1)
        self.assertEqual(self.captures, 1)

    def test_observation_loss_only_recollects_same_invocation(self):
        self.protocol["loseObservation"] = True
        self.assertEqual(self.coordinate(), valid_receipt())
        self.assertEqual(self.calls().count("RunCommand"), 1)
        self.assertEqual(self.calls().count("DescribeInvocationTasks"), 2)

    def test_ambiguous_submission_is_never_retried_on_restart(self):
        self.protocol["loseSubmission"] = True
        with self.assertRaisesRegex(ValueError, "indeterminate"):
            self.coordinate()
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            self.coordinate()
        self.assertEqual(self.calls(), ["RunCommand"])
        self.assertEqual(json.loads(self.state.read_text())["phase"], "submitting")

    def test_restart_submitted_and_terminal_without_output_collect_original(self):
        self.coordinate()
        for phase in ("submitted", "terminal"):
            state = json.loads(self.state.read_text())
            state.update(phase=phase, receipt=None, terminalStatus="SUCCESS" if phase == "terminal" else None)
            COORD.FILES.write_journal(self.state, state)
            self.assertEqual(self.coordinate(), valid_receipt())
        self.assertEqual(self.calls().count("RunCommand"), 1)
        self.assertEqual(self.captures, 1)

    def test_native_failed_is_persisted_and_never_replayed_implicitly(self):
        self.protocol["status"] = "FAILED"
        for _ in range(2):
            with self.assertRaisesRegex(ValueError, "failed"):
                self.coordinate()
        self.assertEqual(self.calls().count("RunCommand"), 1)
        self.assertEqual(json.loads(self.state.read_text())["terminalStatus"], "FAILED")

    def test_explicit_recheck_requires_collected_terminal_and_recaptures(self):
        with self.assertRaises(ValueError):
            self.coordinate(recheck=True)
        self.coordinate()
        self.assertEqual(self.coordinate(recheck=True), valid_receipt())
        self.assertEqual(self.captures, 2)
        self.assertEqual(self.calls().count("RunCommand"), 2)
        state = json.loads(self.state.read_text())
        state.update(phase="submitted", receipt=None, terminalStatus=None)
        COORD.FILES.write_journal(self.state, state)
        with self.assertRaises(ValueError):
            self.coordinate(recheck=True)

    def test_mismatched_source_inventory_state_and_symlink_never_submit(self):
        self.coordinate()
        original = self.state.read_text()
        for key, replacement in (("inventorySha256", "f" * 64), ("sourceRevision", "c" * 40),
                                 ("sourceManifestSha256", "d" * 64), ("phase", "unknown"),
                                 ("invocationId", "bad"), ("commandName", "wrong")):
            value = json.loads(original)
            value[key] = replacement
            COORD.FILES.write_journal(self.state, value)
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.coordinate()
        self.state.unlink()
        self.state.symlink_to(self.root / "foreign")
        with self.assertRaises(ValueError):
            self.coordinate()
        self.assertEqual(self.calls().count("RunCommand"), 1)

    def test_wrong_receipt_or_readiness_claim_never_admits_builder(self):
        for key, value in (("diskId", "disk-other01"), ("instanceId", "ins-other01"), ("storageReady", True),
                           ("mountVerified", False), ("journalSha256", "bad"), ("extra", "secret-marker")):
            candidate = valid_receipt()
            candidate[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                COORD.receipt(json.dumps(candidate).encode(), self.inventory)

    def test_payload_has_exact_reviewed_closure_and_no_cloud_credentials_or_bulk_dependency(self):
        self.coordinate()
        program = (self.root / "payload.sh").read_text()
        encoded = next(line for line in program.splitlines() if line.startswith("ENCODED="))[8:]
        raw = zlib.decompress(base64.b64decode(ast.literal_eval(encoded)))
        value = json.loads(raw)
        self.assertEqual(set(value), set(COORD.TOOLS) | {"inventory.json", "observation.json"})
        self.assertEqual(value["inventory.json"].encode(), self.inventory_raw)
        for name in COORD.TOOLS:
            self.assertEqual(value[name], self.sources[name])
        self.assertNotIn("TENCENTCLOUD_SECRET", program)
        self.assertNotIn("TENCENT_PROFILE", program)
        self.assertIn('dir="/var/tmp"', program)
        self.assertNotIn("mkdir /data", program)

    def test_stale_observation_and_payload_oversize_fail_before_intent(self):
        observation = FIXTURE.observation(time.time_ns() // 1000000 - 120001)
        with self.assertRaises(ValueError):
            COORD.payload(self.inventory_raw, observation, self.sources)
        sources = copy.deepcopy(self.sources)
        sources[COORD.TOOLS[0]] += "x" * 131072
        with self.assertRaises(ValueError):
            COORD.payload(self.inventory_raw, self.capture(), sources)
        self.assertFalse(self.state.exists())

    def test_real_wrapper_retains_lock_through_submission_and_observation_retry(self):
        self.protocol["loseObservation"] = True
        (self.root / "protocol.json").write_text(json.dumps(self.protocol))
        driver = self.root / "driver.py"
        driver.write_text("import importlib.util,json,os,time\nfrom pathlib import Path\n"
            + "spec=importlib.util.spec_from_file_location('driver_coord'," + repr(str(ROOT / "run-runtime-builder-storage.py")) + ")\n"
            + "m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\n"
            + "r=Path(os.environ['BUILDER_COORDINATOR_DOUBLE'])\nm.lock_observed(r/'operation.lock')\n"
            + "inventory=" + repr(self.inventory) + "\n"
            + "evidence=" + repr(self.capture()) + "\n"
            + "sources={n:(m.ROOT/n).read_text() for n in m.TOOLS}\n"
            + "result=m.coordinate(json.dumps(inventory,sort_keys=True).encode(),inventory,'a'*40,'b'*64,r/'state.json',lambda:evidence,sources,pause=lambda s:m.lock_observed(r/'operation.lock'))\n"
            + "assert result['storageReady'] is False\n")
        env = dict(os.environ, ASSERT_COORDINATOR_LOCK="1", AUTONOMY_CONTROL_LOCK_PATH=str(self.root / "operation.lock"))
        env.pop("AUTONOMY_OPERATION_LOCK_HELD", None)
        result = subprocess.run([str(COORD.FLEET / "operations/with-autonomy-operation-lock.sh"), "--",
                                 sys.executable, str(driver)], env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("secret-marker", result.stdout + result.stderr)
        self.assertEqual(self.calls().count("RunCommand"), 1)
        self.assertEqual(self.calls().count("DescribeInvocationTasks"), 2)
        # The real supervisor releases the lock only after the workflow exits.
        probe = subprocess.run(["flock", "-n", str(self.root / "operation.lock"), "true"], capture_output=True)
        self.assertEqual(probe.returncode, 0)

    def test_reviewed_source_binding_rejects_changes_and_missing_authority(self):
        project = self.root / "project"
        source_root = project / "infra/cells/deploy/tencent/fleet/terraform/create-first/bootstrap"
        source_root.mkdir(parents=True)
        entries = []
        for relative in COORD.AUTHORITY:
            original = (ROOT / relative).resolve()
            destination = (source_root / relative).resolve()
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(original, destination)
            entries.append(hashlib.sha256(destination.read_bytes()).hexdigest() + "  " + destination.relative_to(project).as_posix())
        # Full repository manifests include valid frontend/Unity paths, not
        # just Python-safe names. Only the selected authority is executed.
        entries += ["f" * 64 + "  " + name for name in (
            "frontend/src/routes/ns.$namespace/[...all]/index.tsx", "examples/THIRD PARTY NOTICE.md")]
        identity = project / ".actor-source"
        identity.mkdir()
        (identity / "SOURCE_REVISION").write_text(REVISION + "\n")
        raw = ("\n".join(entries) + "\n").encode()
        (identity / "RELEASE_SHA256SUMS").write_bytes(raw)
        manifest = hashlib.sha256(raw).hexdigest()
        self.assertEqual(COORD.verified_sources(REVISION, manifest, project, source_root), self.sources)
        (source_root / "collect-runtime-builder-storage.py").write_text("tampered")
        with self.assertRaises(ValueError):
            COORD.verified_sources(REVISION, manifest, project, source_root)
        with self.assertRaises(ValueError):
            COORD.verified_sources("c" * 40, manifest, project, source_root)

    def test_missing_execute_flag_is_rejected_before_any_source_or_cloud_work(self):
        result = subprocess.run([sys.executable, str(ROOT / "run-runtime-builder-storage.py"),
            "--inventory", str(self.root / "absent"), "--management-inventory", str(self.root / "absent"),
            "--management-kubeconfig", str(self.root / "absent"), "--source-revision", REVISION,
            "--source-manifest-sha256", MANIFEST], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("--execute", result.stderr)
        self.assertEqual(self.calls(), [])

    def test_wrong_operations_metadata_rejects_without_tat(self):
        curl = self.root / "bin/curl"
        curl.write_text("#!/usr/bin/env bash\nprintf 'ins-other01\\n'\n")
        curl.chmod(0o755)
        with self.assertRaisesRegex(ValueError, "operations host"):
            COORD.operation_host(self.inventory)
        self.assertEqual(self.calls(), [])

    def test_lock_environment_alone_is_not_proof(self):
        script = self.root / "lock-check.py"
        script.write_text("import importlib.util\nfrom pathlib import Path\n"
            + "spec=importlib.util.spec_from_file_location('lock_check'," + repr(str(ROOT / "run-runtime-builder-storage.py")) + ")\n"
            + "m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\n"
            + "try:m.lock_observed(Path(" + repr(str(self.root / "operation.lock")) + "))\n"
            + "except ValueError:raise SystemExit(0)\nraise SystemExit(1)\n")
        (self.root / "operation.lock").touch()
        env = dict(os.environ, AUTONOMY_OPERATION_LOCK_HELD="1")
        result = subprocess.run([sys.executable, str(script)], env=env, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0)

    def test_siblings_with_same_fleet_lock_cannot_race_one_intent(self):
        with self.state.with_suffix(".lock").open("x") as stream:
            self.state.with_suffix(".lock").chmod(0o600)
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.coordinate()
        self.assertEqual(self.captures, 0)
        self.assertEqual(self.calls(), [])
        self.assertFalse(self.state.exists())


if __name__ == "__main__":
    unittest.main()
