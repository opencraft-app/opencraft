#!/usr/bin/env python3

import json
import os
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
INSTALLER = ROOT / "install-storage-credentials.sh"
INSTALLER_SOURCE = INSTALLER.read_text()


def load(name: str, path: Path):
    import importlib.util
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


FIXTURE = load("storage_installer_fixture", ROOT.parent / "test-render-cell-assets.py")
INPUTS = load("storage_installer_inputs", ROOT / "test_validate_storage_inputs.py")


class StorageCredentialInstallerE2E(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir="/data/tmp")
        self.root = Path(self.temporary.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.state = self.root / "state.json"
        self.inventory = self.root / "inventory.json"
        self.images = self.root / "images.json"
        self.sensitive = self.root / "sensitive.json"
        self.kubeconfig = self.root / "kubeconfig"
        self.pull = self.root / "pull.json"
        self.receipt = self.root / "storage.json"
        self.inventory.write_text(json.dumps(FIXTURE.inventory()))
        self.images.write_text(json.dumps(FIXTURE.image_inventory()))
        self.sensitive.write_text(json.dumps(INPUTS.sensitive()))
        self.sensitive.chmod(0o600)
        self.kubeconfig.write_text(INPUTS.KUBECONFIG)
        self.kubeconfig.chmod(0o600)
        self.pull.write_text(json.dumps(INPUTS.pull_receipt()))
        self._write_mock("kubectl", self._kubectl())

    def tearDown(self):
        self.temporary.cleanup()

    def _write_mock(self, name: str, body: str) -> None:
        path = self.bin / name
        path.write_text(body)
        path.chmod(0o755)

    @staticmethod
    def _kubectl() -> str:
        return textwrap.dedent("""\
            #!/usr/bin/env python3
            import base64,json,os,sys
            path=os.environ["MOCK_STATE"]
            state=json.load(open(path)) if os.path.exists(path) else {"secrets":{}}
            args=sys.argv[1:]
            if args[:1] == ["--kubeconfig"]:
                args=args[2:]
            namespace=None
            if args[:1] == ["-n"]:
                namespace,args=args[1],args[2:]
            def save():
                json.dump(state,open(path,"w"),sort_keys=True)
            if args[:3] == ["get","namespace","kube-system"]:
                print("cluster-uid-1",end="")
            elif args[:3] == ["get","namespace","actor-fdb-cell-system"]:
                print("namespace-fdb",end="")
            elif namespace and args[:3] == ["get","secret","actor-fleet-tcr"]:
                print("pull-secret-uid",end="")
            elif namespace and args[:3] == ["create","secret","generic"]:
                name=args[3]
                data={}
                for value in args:
                    if value.startswith("--from-file="):
                        key,source=value.removeprefix("--from-file=").split("=",1)
                        data[key]=base64.b64encode(open(source,"rb").read()).decode()
                print(json.dumps({"apiVersion":"v1","kind":"Secret","metadata":{"name":name,"namespace":namespace},"type":"Opaque","data":data}))
            elif namespace and args[:2] == ["get","secret"]:
                key=namespace+"/"+args[2]
                if key not in state["secrets"]:
                    raise SystemExit(1)
                print(json.dumps(state["secrets"][key]))
            elif args[:2] == ["create","-f"]:
                document=json.load(open(args[2]))
                key=document["metadata"]["namespace"]+"/"+document["metadata"]["name"]
                document["metadata"]["uid"]="uid-"+document["metadata"]["name"]
                state["secrets"][key]=document
                save()
            else:
                raise SystemExit("unknown kubectl args: "+repr(args))
        """)

    def run_installer(self):
        env = dict(
            os.environ,
            PATH=str(self.bin) + os.pathsep + os.environ["PATH"],
            MOCK_STATE=str(self.state),
            ACTOR_TERRAFORM_INVENTORY=str(self.inventory),
            ACTOR_IMAGE_INVENTORY=str(self.images),
            ACTOR_TERRAFORM_SENSITIVE_BOOTSTRAP=str(self.sensitive),
            ACTOR_CLUSTER_KUBECONFIG=str(self.kubeconfig),
            ACTOR_PULL_CREDENTIAL_RECEIPT=str(self.pull),
            ACTOR_STORAGE_CREDENTIAL_RECEIPT=str(self.receipt),
        )
        return subprocess.run([str(INSTALLER)], env=env, text=True, capture_output=True)

    def test_install_and_restart_are_identical_and_receipt_is_secret_free(self):
        first = self.run_installer()
        self.assertEqual(first.returncode, 0, first.stderr)
        first_bytes = self.receipt.read_bytes()
        receipt = json.loads(first_bytes)
        self.assertEqual(receipt["verdict"], "passed")
        self.assertEqual({item["role"] for item in receipt["secrets"]}, {"cold", "backup"})
        for forbidden in ("cold-secret-example-0001", "backup-secret-example-01", "AKID-cold-example-0001"):
            self.assertNotIn(forbidden, first_bytes.decode())
            self.assertNotIn(forbidden, first.stdout + first.stderr)
        second = self.run_installer()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(self.receipt.read_bytes(), first_bytes)

    def test_secret_values_never_enter_process_arguments(self):
        self.assertNotIn('--arg secret "$(jq', INSTALLER_SOURCE)
        self.assertNotIn('--arg key "$(jq', INSTALLER_SOURCE)
        self.assertIn("jq -jr '.credentials.cold.secretAccessKey'", INSTALLER_SOURCE)
        self.assertEqual(INSTALLER_SOURCE.count('.type="Opaque" | .immutable=true'), 2)

    def test_divergent_existing_secret_is_not_overwritten(self):
        first = self.run_installer()
        self.assertEqual(first.returncode, 0, first.stderr)
        state = json.loads(self.state.read_text())
        secret = state["secrets"]["actor-fdb-cell-system/actor-bj-k02-runtime-cos"]
        secret["data"]["AWS_SECRET_ACCESS_KEY"] = "ZGlmZmVyZW50"
        self.state.write_text(json.dumps(state))
        self.receipt.unlink()
        second = self.run_installer()
        self.assertNotEqual(second.returncode, 0)
        self.assertIn("live immutable storage Secret differs", second.stderr)


if __name__ == "__main__":
    unittest.main()
