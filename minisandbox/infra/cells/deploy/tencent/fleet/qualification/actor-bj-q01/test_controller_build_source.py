"""Validate exact controller source selection before touching any credentials."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("build-controller-via-tat.sh")
REVISION = "1" * 40
MANIFEST = "2" * 64
REGISTRY = "registry-test.tencentcloudcr.com"


class ControllerBuildSourceTest(unittest.TestCase):
    def full_mock_build(self, build_base, runtime_base, tag):
        # Model the whole credential/TAT wrapper without any cloud calls or
        # executing the submitted remote programs. All authority is fake.
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            root = Path(temporary)
            record = root / "remote-programs.jsonl"
            cli = root / "tccli"
            cli.write_text("""#!/usr/bin/env python3
import base64,json,os,sys,time
args=sys.argv[1:]
if args[:2]==['tcr','CreateInstanceToken']:
    print(json.dumps({'Username':'example-user','Token':'example-temp-token',
        'ExpTime':int((time.time()+3600)*1000),
        'RequestId':'11111111-2222-3333-4444-555555555555'}))
elif args[:2]==['tat','RunCommand']:
    content=args[args.index('--Content')+1]
    name=args[args.index('--CommandName')+1]
    with open(os.environ['CONTROLLER_TEST_RECORD'],'a') as f:
        f.write(json.dumps({'name':name,'script':base64.b64decode(content).decode()})+'\\n')
    print(json.dumps({'InvocationId':'inv-fixture'}))
elif args[:2]==['tat','DescribeInvocationTasks']:
    print(json.dumps({'InvocationTaskSet':[{'TaskStatus':'SUCCESS',
        'TaskResult':{'ExitCode':0,'Output':''}}]}))
else:
    sys.exit(90)
""")
            cli.chmod(0o700)
            env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ["PATH"],
                       TCCLI=str(cli), TMPDIR=str(root), CONTROLLER_TEST_RECORD=str(record),
                       TENCENTCLOUD_SECRET_ID="example-id", TENCENTCLOUD_SECRET_KEY="example-key",
                       TAT_INSTANCE_ID="ins-fixture", TENCENT_REGION="ap-beijing",
                       QUALIFICATION_SOURCE_LINK="/data/actor-build/deploy/controller-src-" + REVISION + "-" + MANIFEST,
                       QUALIFICATION_STATE_DIR=str(root / "state"),
                       QUALIFICATION_TCR_HOST=REGISTRY, QUALIFICATION_TCR_REGISTRY_ID="tcr-fixture",
                       ACTOR_FLEET_BUILD_BASE=build_base, ACTOR_FLEET_RUNTIME_BASE=runtime_base)
            # Test-only hermetic CLI selection; do not consume configured
            # profiles/OIDC bindings from the test runner.
            for name in list(env):
                if name.startswith("TKE_") or name in ("TENCENT_PROFILE", "TENCENT_API_ROOT_DOMAIN"):
                    env.pop(name)
            result = subprocess.run(["bash", str(SCRIPT), REVISION, MANIFEST, tag],
                                    env=env, text=True, capture_output=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            records = [json.loads(line) for line in record.read_text().splitlines()]
            programs = [item["script"] for item in records if item["name"] == "q01-build-controller"]
            self.assertEqual(len(programs), 1)
            program = programs[0]
            export = "export ACTOR_PRODUCT_BUILD_RECEIPT="
            receipt = next(line[len(export):] for line in program.splitlines() if line.startswith(export))
            self.assertIn("test ! -e " + receipt, program)
            self.assertLess(program.index("test ! -e " + receipt), program.index('"$source/infra/cells/deploy/tencent/fleet/controller/build-image.sh"'))
            self.assertLess(program.index("export PYTHONDONTWRITEBYTECODE=1"), program.index('"$PYTHON" -c'))
            self.assertEqual(list((root / "state").iterdir()), [])
            self.assertTrue(any(item["name"] == "q01-remove-build-auth" for item in records))
            return receipt

    def test_build_receipt_identity_includes_bases_and_tag(self):
        build_base = REGISTRY + "/actor-fleet/base-golang@sha256:" + "3" * 64
        runtime_base = REGISTRY + "/actor-fleet/base-distroless@sha256:" + "4" * 64
        tag = REGISTRY + "/actor-fleet/actor-fleet-controller:fixture"
        cases = ((build_base, runtime_base, tag),
                 (build_base.replace("3" * 64, "5" * 64), runtime_base, tag),
                 (build_base, runtime_base.replace("4" * 64, "6" * 64), tag),
                 (build_base, runtime_base, tag + "-other"))
        receipts = []
        for bases in cases:
            with self.subTest(inputs=bases):
                actual = self.full_mock_build(*bases)
                inputs = (REVISION, MANIFEST, *bases)
                digest = hashlib.sha256(b"".join(item.encode() + b"\0" for item in inputs)).hexdigest()
                expected = "/data/actor-build/product-receipts/actor-fleet-controller-" + REVISION + "-" + MANIFEST + "-" + digest + ".json"
                self.assertEqual(actual, expected)
                receipts.append(actual)
        self.assertEqual(len(set(receipts)), len(cases))
        self.assertEqual(self.full_mock_build(build_base, runtime_base, tag), receipts[0])

    def invoke(self, source):
        # The CLI double always terminates at the first credential action.
        # No real registry token, TAT command or remote source is used.
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            root = Path(temporary)
            marker = root / "credential-action"
            cli = root / "tccli-double"
            cli.write_text("#!/bin/sh\n: > \"$CONTROLLER_TEST_MARKER\"\nexit 88\n")
            cli.chmod(0o700)
            env = dict(os.environ, TCCLI=str(cli), CONTROLLER_TEST_MARKER=str(marker),
                       TENCENTCLOUD_SECRET_ID="example-id", TENCENTCLOUD_SECRET_KEY="example-key",
                       TAT_INSTANCE_ID="ins-fixture", QUALIFICATION_SOURCE_LINK=source,
                       QUALIFICATION_STATE_DIR=str(root / "state"),
                       QUALIFICATION_TCR_HOST=REGISTRY, QUALIFICATION_TCR_REGISTRY_ID="tcr-fixture",
                       ACTOR_FLEET_BUILD_BASE=REGISTRY + "/actor-fleet/base-golang@sha256:" + "3" * 64,
                       ACTOR_FLEET_RUNTIME_BASE=REGISTRY + "/actor-fleet/base-distroless@sha256:" + "4" * 64)
            result = subprocess.run(["bash", str(SCRIPT), REVISION, MANIFEST,
                                     REGISTRY + "/actor-fleet/actor-fleet-controller:fixture"],
                                    env=env, text=True, capture_output=True, timeout=10)
            return result, marker.exists()

    def test_accepts_only_exact_bound_source_paths(self):
        for source in (
            "/data/actor-build/deploy/controller-src-" + REVISION + "-" + MANIFEST,
            "/var/lib/actor-build/deploy/q01-src-" + REVISION + "-" + MANIFEST,
            "/var/lib/actor-build/deploy/actor-bj-q01-current",
        ):
            with self.subTest(source=source):
                result, credential_action = self.invoke(source)
                self.assertEqual(result.returncode, 88, result.stderr)
                self.assertTrue(credential_action)

    def test_rejects_unbound_source_before_credential_actions(self):
        exact = "/data/actor-build/deploy/controller-src-" + REVISION + "-" + MANIFEST
        for source in (
            "/data/actor-build/deploy/current", "/tmp/controller-source",
            exact + "/nested", exact + "/../other", exact + "\n",
            "/data/actor-build/deploy/controller-src-" + "5" * 40 + "-" + MANIFEST,
            "/data/actor-build/deploy/controller-src-" + REVISION + "-" + "6" * 64,
        ):
            with self.subTest(source=source):
                result, credential_action = self.invoke(source)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse(credential_action)
                self.assertIn("exact immutable source", result.stderr)


if __name__ == "__main__":
    unittest.main()
