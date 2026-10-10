"""Exercise the build submission protocol without cloud credentials or builds."""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent
REVISION = "1" * 40
MANIFEST = "2" * 64
REGISTRY = "fixture.tencentcloudcr.com"


class WorkersAPIBuildSubmissionTest(unittest.TestCase):
    def submit(self, build_base, runtime_base, tag):
        with tempfile.TemporaryDirectory(dir="/data/tmp", prefix="api-build-protocol.") as directory:
            root = Path(directory)
            fleet = root / "fleet"
            (fleet / "workers-api").mkdir(parents=True)
            shutil.copyfile(ROOT / "build-image-via-tat.sh", fleet / "workers-api/build-image-via-tat.sh")
            shutil.copytree(ROOT.parent / "tat", fleet / "tat")
            # The actual TAT submission helpers run against a command-level
            # CLI protocol double. The final download/validator are downstream
            # consumers, not part of this submission identity test.
            download = fleet / "tat/tat-download.sh"
            download.write_text('#!/bin/sh\nprintf "{}\\n" > "$2"\n')
            download.chmod(0o700)
            (fleet / "gitops/image-seed").mkdir(parents=True)
            (fleet / "gitops/image-seed/product-lock.py").write_text('raise SystemExit(0)\n')
            record = root / "requests.jsonl"
            cli = root / "tccli"
            cli.write_text('''#!/usr/bin/env python3
import base64,json,os,sys,time
args=sys.argv[1:]
if args[:2]==['tcr','CreateInstanceToken']:
    print(json.dumps({'Username':'fixture-user','Token':'fixture-token',
        'ExpTime':int((time.time()+3600)*1000),
        'RequestId':'11111111-2222-3333-4444-555555555555'}))
elif args[:2]==['tat','RunCommand']:
    content=args[args.index('--Content')+1]
    name=args[args.index('--CommandName')+1]
    with open(os.environ['API_BUILD_TEST_RECORD'],'a') as stream:
        stream.write(json.dumps({'name':name,'content':content})+'\\n')
    print(json.dumps({'InvocationId':'inv-fixture'}))
elif args[:2]==['tat','DescribeInvocationTasks']:
    print(json.dumps({'InvocationTaskSet':[{'TaskStatus':'SUCCESS',
        'TaskResult':{'ExitCode':0,'Output':''}}]}))
else:
    sys.exit(90)
''')
            cli.chmod(0o700)
            environment = dict(os.environ, PATH=str(root) + os.pathsep + os.environ["PATH"],
                               TCCLI=str(cli), TMPDIR=str(root), API_BUILD_TEST_RECORD=str(record),
                               TENCENTCLOUD_SECRET_ID="fixture-id", TENCENTCLOUD_SECRET_KEY="fixture-key",
                               TAT_INSTANCE_ID="ins-fixture", TENCENT_REGION="ap-beijing",
                               ACTOR_TCR_REGISTRY_ID="tcr-fixture", ACTOR_TCR_HOST=REGISTRY,
                               ACTOR_REMOTE_SOURCE_DIR="/data/actor-build/deploy/api-fixture",
                               ACTOR_BUILD_STATE_DIR=str(root / "state"),
                               ACTOR_BUILD_PYTHON="python3", WORKERS_API_BUILD_BASE=build_base,
                               WORKERS_API_RUNTIME_BASE=runtime_base)
            for name in list(environment):
                if name.startswith("TKE_") or name in ("TENCENT_PROFILE", "TENCENT_API_ROOT_DOMAIN"):
                    environment.pop(name)
            result = subprocess.run(["bash", str(fleet / "workers-api/build-image-via-tat.sh"),
                                     REVISION, MANIFEST, tag, str(root / "receipt.json")],
                                    env=environment, capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            records = [json.loads(line) for line in record.read_text().splitlines()]
            programs = [base64.b64decode(item["content"]).decode() for item in records
                        if item["name"] == "build-workers-api"]
            self.assertEqual(len(programs), 1)
            program = programs[0]
            prefix = "export ACTOR_PRODUCT_BUILD_RECEIPT="
            receipt = next(line[len(prefix):] for line in program.splitlines() if line.startswith(prefix))
            self.assertIn("test ! -e " + receipt, program)
            self.assertLess(program.index("export PYTHONDONTWRITEBYTECODE=1"), program.index('"$PYTHON" -c'))
            self.assertLess(program.index("test ! -e " + receipt),
                            program.index('"$source/infra/cells/deploy/tencent/fleet/workers-api/build-image.sh"'))
            self.assertTrue(any(item["name"] == "remove-workers-api-build-auth" for item in records))
            self.assertFalse(list((root / "state").glob("token.*")))
            return Path(receipt).name

    def test_build_identity_binds_bases_and_tag(self):
        build_base = REGISTRY + "/actor-fleet/base-golang@sha256:" + "3" * 64
        runtime_base = REGISTRY + "/actor-fleet/base-distroless@sha256:" + "4" * 64
        tag = REGISTRY + "/actor-fleet/workers-api:fixture"
        cases = ((build_base, runtime_base, tag),
                 (build_base.replace("3" * 64, "5" * 64), runtime_base, tag),
                 (build_base, runtime_base.replace("4" * 64, "6" * 64), tag),
                 (build_base, runtime_base, tag + "-other"))
        receipts = []
        for inputs in cases:
            with self.subTest(inputs=inputs):
                name = self.submit(*inputs)
                digest = hashlib.sha256(b"".join(value.encode() + b"\0"
                                                for value in (REVISION, MANIFEST, *inputs))).hexdigest()
                self.assertEqual(name, "product-workers-api-" + REVISION + "-" + MANIFEST + "-" + digest + ".json")
                receipts.append(name)
        self.assertEqual(len(set(receipts)), len(cases))
        self.assertEqual(self.submit(*cases[0]), receipts[0])


if __name__ == "__main__":
    unittest.main()
