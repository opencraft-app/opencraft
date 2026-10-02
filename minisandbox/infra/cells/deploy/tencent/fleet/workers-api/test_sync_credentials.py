#!/usr/bin/env python3
from __future__ import annotations

import base64
import hashlib
import json
import os
import pathlib
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parent
SYNC = ROOT / "sync-credentials.sh"


def token(byte: int) -> str:
    return base64.b64encode(bytes([byte]) * 32).decode()


def sha(value: str) -> str:
    return "sha256:" + hashlib.sha256(base64.b64decode(value)).hexdigest()


class SyncCredentialTests(unittest.TestCase):
    def test_sync_publishes_versioned_secret_without_mutating_legacy_and_recovers_prior_aba(self) -> None:
        with tempfile.TemporaryDirectory(dir="/data/tmp") as raw:
            root = pathlib.Path(raw)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            state_dir = root / "state"
            state_dir.mkdir()
            fake = fake_bin / "kubectl"
            fake.write_text("""#!/usr/bin/env python3
import json,os,pathlib,sys
args=sys.argv[1:]
state=pathlib.Path(os.environ["FAKE_KUBE_STATE"])
kube=pathlib.Path(args[args.index("--kubeconfig")+1]).name
if "create" in args and "namespace" in args:
    print('apiVersion: v1\\nkind: Namespace\\nmetadata:\\n  name: workers-api-system')
    raise SystemExit(0)
if "apply" in args:
    sys.stdin.read(); raise SystemExit(0)
if "create" in args and "-f" in args:
    value=json.load(open(args[args.index("-f")+1]))
    value.setdefault("metadata",{}).update({"namespace":"workers-api-system","uid":"versioned-uid","resourceVersion":"9"})
    (state/"created.json").write_text(json.dumps(value))
    print('secret/'+value["metadata"]["name"]+' created')
    raise SystemExit(0)
if "get" not in args:
    raise SystemExit("unsupported fake kubectl invocation: "+repr(args))
kind=args[args.index("get")+1]; name=args[args.index("get")+2]
inventory=json.load(open(state/"inventory.json"))
if kube=="hub.kubeconfig" and kind=="secret":
    if name=="workers-api-internal-token": value=inventory["hubLegacy"]
    elif (state/"created.json").exists() and json.load(open(state/"created.json"))["metadata"]["name"]==name:
        value=json.load(open(state/"created.json"))
    else: raise SystemExit(1)
elif kube in ("a.kubeconfig","b.kubeconfig"):
    cell="a" if kube.startswith("a") else "b"
    value=inventory[cell][kind+":"+name]
else: raise SystemExit("unknown fake object")
print(json.dumps(value,separators=(",",":")))
""")
            fake.chmod(0o755)

            kubeconfigs = {}
            for name in ("hub", "a", "b"):
                path = root / f"{name}.kubeconfig"
                path.write_text("test\n")
                kubeconfigs[name] = path

            cells = {
                "a": {"name": "actor-test-a", "uid": "cell-a", "engine": token(2), "base": 10},
                "b": {"name": "actor-test-b", "uid": "cell-b", "engine": token(6), "base": 20},
            }
            inventory: dict[str, object] = {}
            inputs: dict[str, pathlib.Path] = {}
            for letter, cell in cells.items():
                values = {
                    "executor-token": token(cell["base"]),
                    "object-router-token": token(cell["base"] + 1),
                    "workerd-token": token(cell["base"] + 2),
                }
                route = root / f"route-{letter}.json"
                route.write_text(json.dumps({
                    "schema": "actor-cell-route-publication/v2", "verdict": "passed",
                    "cell": {"name": cell["name"], "uid": cell["uid"]},
                }))
                auth = root / f"auth-{letter}.json"
                auth.write_text(json.dumps({
                    "schema": "actor-stateless-auth/v1", "verdict": "passed",
                    "cell": {"name": cell["name"], "uid": cell["uid"]},
                    "credential": {
                        "name": f"{cell['name']}-stateless-auth", "uid": f"auth-{letter}",
                        "resourceVersion": "1",
                        "capabilities": list(values),
                        "fingerprints": {key: sha(value) for key, value in values.items()},
                    },
                }))
                inputs[f"route_{letter}"] = route
                inputs[f"auth_{letter}"] = auth
                inventory[letter] = {
                    f"rivetcell:{cell['name']}": {"metadata": {"name": cell["name"], "uid": cell["uid"]}},
                    f"secret:{cell['name']}-runtime-auth": {
                        "metadata": {"labels": {"fleet.actor.dev/cell-name": cell["name"]}},
                        "data": {"token": cell["engine"]},
                    },
                    f"secret:{cell['name']}-stateless-auth": {
                        "metadata": {
                            "name": f"{cell['name']}-stateless-auth", "uid": f"auth-{letter}",
                            "resourceVersion": "1",
                        },
                        "immutable": True, "data": values,
                    },
                }
            legacy_data = {
                "registry-token": token(1),
                "engine-a-token": cells["a"]["engine"],
                "engine-b-token": cells["b"]["engine"],
            }
            inventory["hubLegacy"] = {
                "metadata": {
                    "name": "workers-api-internal-token", "namespace": "workers-api-system",
                    "uid": "legacy-uid", "resourceVersion": "3",
                },
                "immutable": True, "data": legacy_data,
            }
            inventory_path = state_dir / "inventory.json"
            inventory_path.write_text(json.dumps(inventory))

            common = {
                **os.environ,
                "PATH": str(fake_bin) + os.pathsep + os.environ["PATH"],
                "FAKE_KUBE_STATE": str(state_dir),
                "HUB_KUBECONFIG": str(kubeconfigs["hub"]),
                "ACTOR_WORKERS_API_CELL_A_KUBECONFIG": str(kubeconfigs["a"]),
                "ACTOR_WORKERS_API_CELL_B_KUBECONFIG": str(kubeconfigs["b"]),
                "ACTOR_WORKERS_API_CELL_A_ROUTE_RECEIPT": str(inputs["route_a"]),
                "ACTOR_WORKERS_API_CELL_B_ROUTE_RECEIPT": str(inputs["route_b"]),
                "ACTOR_WORKERS_API_CELL_A_STATELESS_AUTH_RECEIPT": str(inputs["auth_a"]),
                "ACTOR_WORKERS_API_CELL_B_STATELESS_AUTH_RECEIPT": str(inputs["auth_b"]),
                "ACTOR_WORKERS_API_ALLOW_BOOTSTRAP_CREDENTIAL_REPLACEMENT": "true",
            }
            first_receipt = root / "first.json"
            subprocess.run(
                (str(SYNC),), check=True, env={**common, "ACTOR_WORKERS_API_CREDENTIAL_RECEIPT": str(first_receipt)},
                capture_output=True, text=True,
            )
            first = json.loads(first_receipt.read_text())
            created = json.loads((state_dir / "created.json").read_text())
            self.assertRegex(first["credential"]["name"], r"^workers-api-internal-token-[0-9a-f]{12}$")
            self.assertEqual(first["credential"]["name"], created["metadata"]["name"])
            self.assertEqual(first["bootstrapReplacement"]["priorUid"], "legacy-uid")
            self.assertFalse(first["bootstrapReplacement"]["replacedInPlace"])
            self.assertEqual(inventory["hubLegacy"]["data"], legacy_data)

            inventory["hubLegacy"] = {
                **inventory["hubLegacy"],
                "metadata": {**inventory["hubLegacy"]["metadata"], "uid": "bad-recreated-uid", "resourceVersion": "4"},
                "data": created["data"],
            }
            inventory_path.write_text(json.dumps(inventory))
            broken_receipt = root / "broken.json"
            broken_receipt.write_text(json.dumps({
                "schema": "actor-workers-api-credential-sync/v1", "verdict": "passed",
                "credential": {"name": "workers-api-internal-token", "uid": "bad-recreated-uid"},
                "bootstrapReplacement": {"priorUid": "legacy-uid"},
            }))
            recovery_receipt = root / "recovery.json"
            subprocess.run(
                (str(SYNC),), check=True,
                env={
                    **common,
                    "ACTOR_WORKERS_API_CREDENTIAL_RECEIPT": str(recovery_receipt),
                    "ACTOR_WORKERS_API_RECOVERY_CREDENTIAL_RECEIPT": str(broken_receipt),
                },
                capture_output=True, text=True,
            )
            recovered = json.loads(recovery_receipt.read_text())
            self.assertEqual(recovered["credential"]["uid"], "versioned-uid")
            self.assertEqual(recovered["bootstrapReplacement"]["priorUid"], "legacy-uid")
            self.assertEqual(recovered["bootstrapReplacement"]["sourceCredentialUid"], "bad-recreated-uid")
            self.assertTrue(recovered["bootstrapReplacement"]["recoveredFromSameNameReplacement"])


if __name__ == "__main__":
    unittest.main()
