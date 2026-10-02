#!/usr/bin/env python3

import json
import os
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent


FAKE_KUBECTL = r'''#!/usr/bin/env python3
import base64
import json
import os
import sys
from pathlib import Path

args = sys.argv[1:]
if args[:1] == ["--kubeconfig"]:
    args = args[2:]
namespace = "default"
if args[:1] == ["-n"]:
    namespace, args = args[1], args[2:]
state = Path(os.environ["FAKE_KUBE_STATE"])
state.mkdir(exist_ok=True)
if args[:2] == ["get", "namespace"]:
    print(json.dumps({"metadata": {"name": args[2], "uid": "namespace-uid"}}))
elif args[:2] == ["create", "secret"] and "generic" in args:
    name = args[args.index("generic") + 1]
    data = {}
    for argument in args:
        if argument.startswith("--from-file="):
            key, path = argument.removeprefix("--from-file=").split("=", 1)
            data[key] = base64.b64encode(Path(path).read_bytes()).decode()
    print(json.dumps({"apiVersion": "v1", "kind": "Secret", "metadata": {"name": name, "namespace": namespace}, "data": data}))
elif args[:2] == ["get", "secret"]:
    path = state / f"{namespace}--{args[2]}.json"
    if not path.exists():
        raise SystemExit(1)
    print(path.read_text())
elif args[:2] == ["create", "-f"]:
    value = json.loads(Path(args[2]).read_text())
    value["metadata"]["uid"] = "secret-uid-" + value["metadata"]["name"]
    path = state / f'{value["metadata"]["namespace"]}--{value["metadata"]["name"]}.json'
    if path.exists():
        raise SystemExit(1)
    path.write_text(json.dumps(value))
else:
    raise SystemExit("unsupported fake kubectl arguments: " + repr(args))
'''


class CellTlsBootstrapTests(unittest.TestCase):
    def test_creation_replay_and_divergence(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            root = Path(temporary)
            bin_dir = root / "bin"
            bin_dir.mkdir()
            kubectl = bin_dir / "kubectl"
            kubectl.write_text(textwrap.dedent(FAKE_KUBECTL), encoding="utf-8")
            kubectl.chmod(0o755)
            kubeconfig = root / "cell.kubeconfig"
            kubeconfig.write_text("not-read-by-fake\n", encoding="utf-8")
            tls = root / "tls"
            receipt = root / "receipt.json"
            state = root / "state"
            environment = os.environ.copy()
            environment.update(
                PATH=f"{bin_dir}:{environment['PATH']}",
                FAKE_KUBE_STATE=str(state),
                ACTOR_CELL_KUBECONFIG=str(kubeconfig),
                ACTOR_CELL_ID="actor-bj-k02",
                ACTOR_FDB_TLS_DIRECTORY=str(tls),
                ACTOR_FDB_TLS_RECEIPT=str(receipt),
            )
            command = [ROOT / "bootstrap-cell-tls.sh"]
            first = subprocess.run(command, env=environment, text=True, capture_output=True, check=False)
            self.assertEqual(first.returncode, 0, first.stderr)
            value = json.loads(receipt.read_text())
            self.assertEqual(value["schema"], "actor-fdb-tls-bootstrap/v1")
            self.assertEqual(value["cellId"], "actor-bj-k02")
            self.assertEqual(len(value["secrets"]), 3)
            self.assertNotIn("data", json.dumps(value))
            for secret in state.glob("*.json"):
                stored = json.loads(secret.read_text())
                self.assertTrue(stored["immutable"])
                self.assertEqual(stored["metadata"]["labels"]["fleet.actor.dev/cell"], "actor-bj-k02")
            original_receipt = receipt.read_bytes()
            replay = subprocess.run(command, env=environment, text=True, capture_output=True, check=False)
            self.assertEqual(replay.returncode, 0, replay.stderr)
            self.assertEqual(receipt.read_bytes(), original_receipt)
            cell_secret = state / "actor-fdb-cell-system--actor-bj-k02-fdb-tls.json"
            divergent = json.loads(cell_secret.read_text())
            divergent["data"]["cert.pem"] = "dGFtcGVyZWQ="
            cell_secret.write_text(json.dumps(divergent))
            rejected = subprocess.run(command, env=environment, text=True, capture_output=True, check=False)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn("live immutable TLS Secret differs", rejected.stderr)


if __name__ == "__main__":
    unittest.main()
