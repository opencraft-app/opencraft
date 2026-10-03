#!/usr/bin/env python3
"""Exercise collectors and the real TAT helper with local protocol processes."""
import ast
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest


ROOT = Path(__file__).resolve().parent
SCRIPT = ROOT / "collect-runtime-builder-storage.py"
GUEST = ROOT / "collect-runtime-builder-guest.py"
SPEC = importlib.util.spec_from_file_location("builder_storage_fixture", ROOT / "test_validate_runtime_builder_storage.py")
FIXTURE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FIXTURE)


DOUBLE = r'''#!/usr/bin/env python3
import base64,json,os,subprocess,sys
from pathlib import Path
root=Path(os.environ['BUILDER_PROTOCOL_DOUBLE'])
fixture=json.loads((root/'fixture.json').read_text())
name=Path(sys.argv[0]).name
args=sys.argv[1:]
with (root/'calls.ndjson').open('a') as calls:
    calls.write(json.dumps([name,args])+'\n')
if name=='curl':
    assert args[-1]=='http://metadata.tencentyun.com/latest/meta-data/instance-id'
    print(fixture['guest']['instanceId'])
elif name=='readlink':
    print(fixture['guest']['byId'][args[-1]])
elif name=='stat':
    assert args==['--format=%F','/dev/vdc']
    print('block special file')
elif name=='lsblk':
    assert args==['--bytes','--json','--output','NAME,TYPE,SERIAL,SIZE,FSTYPE,UUID,MOUNTPOINT']
    print(json.dumps(fixture['guest']['lsblk']))
elif name=='wipefs':
    assert args==['--json','--no-act','/dev/vdc']
    print(json.dumps({'signatures':fixture['guest']['wipefs']['signatures']}))
elif name=='kubectl':
    assert args==['--kubeconfig',str(root/'kubeconfig'),'get','nodes','-o','json']
    print(json.dumps(fixture['managementNodes']))
elif name=='tccli':
    service,action=args[:2]
    if action=='DescribeInstances': print(json.dumps(fixture['instances']))
    elif action=='DescribeDisks': print(json.dumps(fixture['disks']))
    elif action=='DescribeClusters':
        print(json.dumps({'RequestId':'be890c34-8e3e-427f-ad4c-f4955f9c7a31','TotalCount':1,
                          'Clusters':[{'ClusterId':'cls-test01','ClusterStatus':'Running',
                                       'ClusterNetworkSettings':{'VpcId':'vpc-test01'}}]}))
    elif action=='RunCommand':
        assert json.loads(args[args.index('--InstanceIds')+1])==['ins-builder01']
        source=base64.b64decode(args[args.index('--Content')+1]).decode()
        (root/'guest-payload.sh').write_text(source)
        result=subprocess.run(['bash'],input=source,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        (root/'tat-result.json').write_text(json.dumps({'exit':result.returncode,'output':result.stdout}))
        print('{"InvocationId":"inv-test01"}')
    elif action=='DescribeInvocationTasks':
        result=json.loads((root/'tat-result.json').read_text())
        print(json.dumps({'InvocationTaskSet':[{'TaskStatus':'SUCCESS' if result['exit']==0 else 'FAILED',
                          'TaskResult':{'ExitCode':result['exit'],'Output':base64.b64encode(result['output'].encode()).decode()}}]}))
    else: raise SystemExit('unexpected action')
else: raise SystemExit('unexpected command')
'''


class BuilderStorageCollectorTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir="/data/tmp")
        self.directory = Path(self.temporary.name)
        binaries = self.directory / "bin"
        binaries.mkdir()
        for name in ("tccli", "kubectl", "curl", "readlink", "stat", "lsblk", "wipefs"):
            executable = binaries / name
            executable.write_text(textwrap.dedent(DOUBLE))
            executable.chmod(0o755)
        self.inventory = self.directory / "inventory.json"
        self.management = self.directory / "management.json"
        self.kubeconfig = self.directory / "kubeconfig"
        self.inventory.write_text(json.dumps(FIXTURE.inventory()))
        self.management.write_text(json.dumps({"schemaVersion": 1, "managementId": "actor-bj-c01",
            "region": "ap-beijing", "network": {"vpcId": "vpc-test01"},
            "kubernetes": {"bootstrapInstanceId": "ins-control01", "clusterId": "cls-test01"}}))
        self.kubeconfig.write_text("protocol-double")
        self.kubeconfig.chmod(0o600)
        self.fixture = FIXTURE.observation()
        self.fixture["managementNodes"]["items"][0]["metadata"] = {
            "name": "10.160.0.4", "uid": "be68b31b-0010-4f75-a02c-601301984e69"}
        self.fixture["instances"]["InstanceSet"][0]["Tags"].append({"Key": "not-needed", "Value": "secret-marker"})
        self.fixture["instances"]["InstanceSet"][0]["LoginSettings"] = {"not-needed": "secret-marker"}
        self.environment = dict(os.environ, BUILDER_PROTOCOL_DOUBLE=str(self.directory),
                                TENCENT_PROFILE="storage-protocol-double", TAT_POLL_SECONDS="0",
                                PATH=str(binaries) + os.pathsep + os.environ["PATH"])
        for key in ("TENCENT_API_ROOT_DOMAIN", "TCCLI"):
            self.environment.pop(key, None)

    def tearDown(self):
        self.temporary.cleanup()

    def capture(self):
        (self.directory / "fixture.json").write_text(json.dumps(self.fixture))
        return subprocess.run([sys.executable, str(SCRIPT), "--inventory", str(self.inventory),
            "--management-inventory", str(self.management), "--management-kubeconfig", str(self.kubeconfig)],
            env=self.environment, capture_output=True, text=True, check=False)

    def test_real_tat_shell_helper_collects_matching_disk_without_credentials(self):
        result = self.capture()
        self.assertEqual(result.returncode, 0, result.stderr)
        evidence = json.loads(result.stdout)
        self.assertEqual(evidence["guest"]["byId"], {"/dev/disk/by-id/virtio-disk-builder01": "/dev/vdc"})
        self.assertEqual(evidence["managementNodes"]["clusterId"], "cls-test01")
        self.assertNotIn("secret-marker", result.stdout + result.stderr)
        self.assertIn("builder_guest_invocation=inv-test01", result.stderr)
        payload = (self.directory / "guest-payload.sh").read_text()
        for forbidden in ("TENCENTCLOUD_SECRET", "TENCENT_PROFILE", "mkfs", "madvise", "mount "):
            self.assertNotIn(forbidden, payload)
        plan = FIXTURE.VALIDATE.validate(FIXTURE.inventory(), evidence, time.time_ns() // 1000000)
        self.assertFalse(plan["storageReady"])

    def test_metadata_mismatch_never_probes_disk(self):
        self.fixture["guest"]["instanceId"] = "ins-other01"
        result = self.capture()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        calls = (self.directory / "calls.ndjson").read_text()
        self.assertNotIn('["readlink"', calls)
        self.assertNotIn('["wipefs"', calls)

    def test_used_disk_is_observed_but_never_initializes_or_passes(self):
        self.fixture["guest"]["lsblk"]["blockdevices"][2]["fstype"] = "ext4"
        result = self.capture()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertNotIn("Traceback", result.stderr)

    def test_wrong_management_inventory_rejects_before_cloud_or_tat(self):
        value = json.loads(self.management.read_text())
        value["kubernetes"]["bootstrapInstanceId"] = "ins-other01"
        self.management.write_text(json.dumps(value))
        result = self.capture()
        self.assertEqual(result.returncode, 1)
        self.assertFalse((self.directory / "calls.ndjson").exists())

    def test_kubernetes_builder_membership_rejects_before_tat(self):
        self.fixture["managementNodes"]["items"][0]["spec"]["providerID"] = "qcloud:///1/ins-builder01"
        result = self.capture()
        self.assertEqual(result.returncode, 1)
        self.assertNotIn('RunCommand', (self.directory / "calls.ndjson").read_text())

    def test_guest_source_accepts_stock_python36_syntax(self):
        ast.parse(GUEST.read_text(), feature_version=(3, 6))


if __name__ == "__main__":
    unittest.main()
