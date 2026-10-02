#!/usr/bin/env python3

import importlib.util
import json
import os
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
INSTALLER = ROOT / "install-pull-credential.sh"


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


RENDER_TEST = load("pull_bootstrap_e2e_fixture", ROOT.parent / "test-render-cell-assets.py")


def management():
    return {
        "schemaVersion": 1,
        "managementId": "actor-bj-c01",
        "region": "ap-beijing",
        "availabilityMode": "production-multi-zone",
        "network": {"vpcId": "vpc-management1"},
        "kubernetes": {"clusterId": "cls-management1"},
        "registry": {
            "id": "tcr-test0001",
            "host": "example.tencentcloudcr.com",
            "namespace": "actor-fleet",
            "accessIp": "10.160.0.11",
        },
        "storage": {
            "codePlaneBackupBucket": "actor-fdb-backup-prod-bj-c01-nv1-1234567890",
            "qualificationEvidenceBucket": "actor-qualification-evidence-prod-bj-c01-nv1-1234567890",
            "workerCodeBucket": "actor-worker-code-prod-bj-c01-nv1-1234567890",
        },
    }


class PullCredentialInstallerE2E(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir="/data/tmp")
        self.root = Path(self.temporary.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.state = self.root / "mock-state"
        self.state.mkdir()
        self.inventory = self.root / "management.json"
        self.images = self.root / "images.json"
        self.kubeconfig = self.root / "kubeconfig"
        self.credential_parent = self.root / "credentials"
        self.receipts = self.root / "receipts"
        self.credential_parent.mkdir()
        self.receipts.mkdir()
        self.inventory.write_text(json.dumps(management()))
        self.images.write_text(json.dumps(RENDER_TEST.image_inventory()))
        self.kubeconfig.write_text("mock")
        self.kubeconfig.chmod(0o600)
        self._write_mock("tccli", self._tccli())
        self._write_mock("kubectl", self._kubectl())
        self._write_mock("getent", "#!/bin/sh\necho '10.160.0.11 STREAM example.tencentcloudcr.com'\n")

    def tearDown(self):
        self.temporary.cleanup()

    def _write_mock(self, name: str, body: str) -> None:
        path = self.bin / name
        path.write_text(body)
        path.chmod(0o755)

    @staticmethod
    def _tccli() -> str:
        return textwrap.dedent("""\
            #!/usr/bin/env python3
            import json,os,sys,time
            root=os.environ["MOCK_STATE"]
            args=sys.argv[1:]
            action=args[1]
            if action == "DescribeClusters":
                print(json.dumps({"Clusters":[{"ClusterId":"cls-management1","ClusterStatus":"Running","ClusterNetworkSettings":{"VpcId":"vpc-management1"}}]}))
            elif action == "DescribeInternalEndpoints":
                print(json.dumps({"AccessVpcSet":[{"VpcId":"vpc-management1","Status":"Running","AccessIp":"10.160.0.11"}]}))
            elif action == "DescribeRepositories":
                images=json.load(open(os.environ["MOCK_IMAGES"]))
                namespace=images["namespace"]
                print(json.dumps({"RepositoryList":[{"Name":namespace+"/"+item["repository"],"Public":False} for item in images["images"]]}))
            elif action == "DescribeInstanceToken":
                path=os.path.join(root,"cloud-token.json")
                if os.path.exists(path):
                    token=json.load(open(path))
                    print(json.dumps({"Tokens":[{"Id":token["TokenId"],"Desc":token["Desc"],"Enabled":True}]}))
                else:
                    print('{"Tokens":[]}')
            elif action == "CreateInstanceToken":
                description=args[args.index("--Desc")+1]
                token={"Username":"1000000000","Token":"high-entropy-token","TokenId":"token-test1","ExpTime":int(time.time()*1000)+700*86400000,"Desc":description}
                json.dump(token,open(os.path.join(root,"cloud-token.json"),"w"))
                print(json.dumps(token))
            else:
                raise SystemExit("unknown tccli action: "+action)
        """)

    @staticmethod
    def _kubectl() -> str:
        return textwrap.dedent("""\
            #!/usr/bin/env python3
            import base64,json,os,sys
            root=os.environ["MOCK_STATE"]
            path=os.path.join(root,"kube.json")
            state=json.load(open(path)) if os.path.exists(path) else {"namespaces":{},"secrets":{}}
            args=sys.argv[1:]
            if args[:2] == ["--kubeconfig", args[1]]:
                args=args[2:]
            namespace=None
            if args[:1] == ["-n"]:
                namespace,args=args[1],args[2:]
            def save():
                json.dump(state,open(path,"w"),sort_keys=True)
            if args[:3] == ["get","namespace","kube-system"]:
                print("cluster-uid-1",end="")
            elif args[:2] == ["create","namespace"]:
                name=args[2]
                print(json.dumps({"apiVersion":"v1","kind":"Namespace","metadata":{"name":name,"labels":{}}}))
            elif args[0] == "apply":
                document=json.load(sys.stdin)
                name=document["metadata"]["name"]
                state["namespaces"][name]={"uid":"namespace-"+name,"document":document}
                save()
            elif namespace and args[:3] == ["create","secret","generic"]:
                name=args[3]
                source=next(value.split("=",2)[2] for value in args if value.startswith("--from-file=.dockerconfigjson="))
                encoded=base64.b64encode(open(source,"rb").read()).decode()
                print(json.dumps({"apiVersion":"v1","kind":"Secret","metadata":{"name":name,"namespace":namespace},"type":"kubernetes.io/dockerconfigjson","data":{".dockerconfigjson":encoded}}))
            elif namespace and args[:2] == ["get","secret"]:
                key=namespace+"/"+args[2]
                if key not in state["secrets"]:
                    raise SystemExit(1)
                print(json.dumps(state["secrets"][key]))
            elif args[:2] == ["create","-f"]:
                document=json.load(open(args[2]))
                ns=document["metadata"]["namespace"]
                name=document["metadata"]["name"]
                document["metadata"]["uid"]="secret-"+ns
                state["secrets"][ns+"/"+name]=document
                save()
            elif args[:2] == ["get","namespace"]:
                print(state["namespaces"][args[2]]["uid"],end="")
            else:
                raise SystemExit("unknown kubectl args: "+repr(args))
        """)

    def run_installer(self):
        env = dict(
            os.environ,
            PATH=str(self.bin) + os.pathsep + os.environ["PATH"],
            MOCK_STATE=str(self.state),
            MOCK_IMAGES=str(self.images),
            ACTOR_TERRAFORM_INVENTORY=str(self.inventory),
            ACTOR_IMAGE_INVENTORY=str(self.images),
            ACTOR_BOOTSTRAP_ROLE="management",
            ACTOR_CLUSTER_KUBECONFIG=str(self.kubeconfig),
            ACTOR_PULL_CREDENTIAL_STATE_DIR=str(self.credential_parent / "actor-bj-c01"),
            ACTOR_PULL_CREDENTIAL_RECEIPT=str(self.receipts / "pull.json"),
            TENCENTCLOUD_SECRET_ID="protected-id",
            TENCENTCLOUD_SECRET_KEY="protected-key",
        )
        return subprocess.run([str(INSTALLER)], env=env, text=True, capture_output=True)

    def test_initial_install_and_restart_are_identical_and_token_free(self):
        first = self.run_installer()
        self.assertEqual(first.returncode, 0, first.stderr)
        receipt_path = self.receipts / "pull.json"
        first_bytes = receipt_path.read_bytes()
        receipt = json.loads(first_bytes)
        self.assertEqual(receipt["verdict"], "passed")
        self.assertEqual(len(receipt["namespaces"]), 7)
        self.assertNotIn("high-entropy-token", first_bytes.decode())
        credential = self.credential_parent / "actor-bj-c01" / "actor-bj-c01-tcr-pull-v1.json"
        self.assertEqual(credential.stat().st_mode & 0o777, 0o600)

        second = self.run_installer()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(receipt_path.read_bytes(), first_bytes)

    def test_existing_cloud_token_without_local_half_fails_closed(self):
        (self.state / "cloud-token.json").write_text(json.dumps({
            "Username":"u", "Token":"lost", "TokenId":"token-lost",
            "ExpTime":9999999999999, "Desc":"actor-bj-c01-cls-management1-image-pull-v1",
        }))
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("protected local credential is missing", result.stderr)
        self.assertFalse((self.receipts / "pull.json").exists())

    def test_rebuilt_cluster_does_not_adopt_previous_cluster_token(self):
        (self.state / "cloud-token.json").write_text(json.dumps({
            "Username": "u", "Token": "previous-cluster-token", "TokenId": "token-old",
            "ExpTime": 9999999999999, "Desc": "actor-bj-c01-cls-previous-image-pull-v1",
        }))
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        token = json.loads((self.state / "cloud-token.json").read_text())
        self.assertEqual(token["Desc"], "actor-bj-c01-cls-management1-image-pull-v1")
        self.assertNotEqual(token["TokenId"], "token-old")


if __name__ == "__main__":
    unittest.main()
