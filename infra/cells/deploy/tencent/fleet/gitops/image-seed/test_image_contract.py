#!/usr/bin/env python3

import copy
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import image_contract as contract


ROOT = Path(__file__).resolve().parent
UPSTREAM = contract.validate_upstream(contract.load(ROOT / "upstream-images.lock.json"))
REGISTRY = "example.tencentcloudcr.com"
NAMESPACE = "actor-fleet"


def seed_receipt():
    return {
        "schemaVersion": 1,
        "result": "passed",
        "registry": REGISTRY,
        "namespace": NAMESPACE,
        "platform": UPSTREAM["platform"],
        "sourceLockDigest": contract.digest(UPSTREAM),
        "images": [
            {
                "repository": item["repository"],
                "source": item["source"],
                "destination": f"{REGISTRY}/{NAMESPACE}/{item['repository']}@sha256:" + "b" * 64,
                "destinationDigest": "sha256:" + "b" * 64,
            }
            for item in UPSTREAM["images"]
        ],
    }


def product_lock():
    return {
        "schemaVersion": 1,
        "registry": REGISTRY,
        "namespace": NAMESPACE,
        "images": [
            {
                "repository": repository,
                "ref": f"{REGISTRY}/{NAMESPACE}/{repository}@sha256:" + "c" * 64,
                "sourceRevision": "d" * 40,
                "sourceManifestDigest": "sha256:" + "e" * 64,
                "buildReceiptDigest": "sha256:" + "f" * 64,
            }
            for repository in sorted(contract.PRODUCT_REPOSITORIES)
        ],
    }


class ImageContractTests(unittest.TestCase):
    def test_reviewed_upstream_lock_is_complete_and_digest_pinned(self):
        self.assertEqual({item["repository"] for item in UPSTREAM["images"]}, contract.UPSTREAM_REPOSITORIES)
        self.assertTrue(all("@sha256:" in item["source"] for item in UPSTREAM["images"]))

    def test_mutable_latest_is_rejected_even_with_a_digest(self):
        changed = copy.deepcopy(UPSTREAM)
        changed["images"][0]["source"] = "docker.io/library/busybox:latest@sha256:" + "a" * 64
        with self.assertRaisesRegex(ValueError, "latest"):
            contract.validate_upstream(changed)

    def test_seed_receipt_must_bind_exact_source(self):
        changed = seed_receipt()
        changed["images"][0]["source"] = "docker.io/library/busybox:1@sha256:" + "a" * 64
        with self.assertRaisesRegex(ValueError, "source differs"):
            contract.validate_seed(changed, UPSTREAM)

    def test_product_lock_must_cover_every_build_repository(self):
        changed = product_lock()
        changed["images"].pop()
        with self.assertRaisesRegex(ValueError, "does not cover"):
            contract.validate_product(changed, REGISTRY, NAMESPACE)

    def test_assembled_lock_covers_exact_terraform_inventory(self):
        result = contract.assemble(UPSTREAM, seed_receipt(), product_lock())
        self.assertEqual({item["repository"] for item in result["images"]}, contract.ALL_REPOSITORIES)
        self.assertEqual(len(result["images"]), 28)
        self.assertRegex(result["inventoryDigest"], r"^sha256:[0-9a-f]{64}$")

    def test_standalone_inventory_rejects_tampering(self):
        result = contract.assemble(UPSTREAM, seed_receipt(), product_lock())
        contract.validate_inventory(result)
        result["images"][0]["ref"] = result["images"][0]["ref"][:-1] + "a"
        with self.assertRaisesRegex(ValueError, "digest mismatch"):
            contract.validate_inventory(result)

    def test_resolve_returns_only_the_inventory_bound_reference_and_provenance(self):
        result = contract.assemble(UPSTREAM, seed_receipt(), product_lock())
        item = contract.resolve(result, "rivet-runtime")
        self.assertEqual(item["ref"], f"{REGISTRY}/{NAMESPACE}/rivet-runtime@sha256:" + "c" * 64)
        self.assertEqual(item["provenance"]["sourceRevision"], "d" * 40)
        with self.assertRaisesRegex(ValueError, "unknown"):
            contract.resolve(result, "not-a-repository")

    def test_cli_resolves_ref_and_product_source_identity(self):
        with tempfile.TemporaryDirectory() as value:
            lock = Path(value) / "inventory.json"
            lock.write_text(json.dumps(contract.assemble(UPSTREAM, seed_receipt(), product_lock())))
            base = (str(ROOT / "image-lock.py"), "resolve", "--lock", str(lock), "--repository")
            ref = subprocess.run(base + ("workers-api",), check=True, capture_output=True, text=True)
            self.assertEqual(ref.stdout.strip(), f"{REGISTRY}/{NAMESPACE}/workers-api@sha256:" + "c" * 64)
            revision = subprocess.run(
                base + ("rivet-runtime", "--field", "source-revision"),
                check=True,
                capture_output=True,
                text=True,
            )
            self.assertEqual(revision.stdout.strip(), "d" * 40)
            upstream = subprocess.run(
                base + ("nats", "--field", "source-revision"),
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(upstream.returncode, 0)

    def test_shell_binding_derives_values_and_rejects_override(self):
        with tempfile.TemporaryDirectory() as value:
            lock = Path(value) / "inventory.json"
            lock.write_text(json.dumps(contract.assemble(UPSTREAM, seed_receipt(), product_lock())))
            helper = ROOT / "bind-inventory.sh"
            command = f"""
set -euo pipefail
ACTOR_IMAGE_INVENTORY={lock!s}
ACTOR_IMAGE_LOCK_TOOL={ROOT / 'image-lock.py'!s}
source {helper!s}
actor_image_inventory_require
actor_image_inventory_bind TEST_IMAGE worker-registry
actor_image_inventory_bind_build_identity TEST_REVISION TEST_MANIFEST workers-api
printf '%s\\n%s\\n%s\\n' "$TEST_IMAGE" "$TEST_REVISION" "$TEST_MANIFEST"
"""
            result = subprocess.run(("bash", "-c", command), check=True, capture_output=True, text=True)
            self.assertEqual(
                result.stdout.splitlines(),
                [
                    f"{REGISTRY}/{NAMESPACE}/worker-registry@sha256:" + "c" * 64,
                    "d" * 40,
                    "e" * 64,
                ],
            )
            mismatch = subprocess.run(
                (
                    "bash",
                    "-c",
                    command.replace(
                        "actor_image_inventory_bind TEST_IMAGE worker-registry",
                        "TEST_IMAGE=wrong actor_image_inventory_bind TEST_IMAGE worker-registry",
                    ),
                ),
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(mismatch.returncode, 0)
            self.assertIn("differs from complete image inventory", mismatch.stderr)

    def test_semantic_candidate_is_exactly_bound_to_qualified_runtime(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as value:
            directory = Path(value)
            lock = directory / "inventory.json"
            lock.write_text(json.dumps(contract.assemble(UPSTREAM, seed_receipt(), product_lock())))
            receipt = directory / "actor-bj-q01-semantic-failure-candidate-test.json"
            qualified = f"{REGISTRY}/{NAMESPACE}/rivet-runtime@sha256:" + "c" * 64
            candidate = f"{REGISTRY}/{NAMESPACE}/rivet-runtime@sha256:" + "a" * 64
            payload = {
                "schema": "actor-bj-q01-semantic-failure-candidate/v1",
                "verdict": "passed",
                "intentionallyNotProduction": True,
                "baseRuntimeImage": qualified,
                "candidateRuntimeImage": candidate,
                "sourceRevision": "d" * 40,
                "baseSourceManifestSHA256": "e" * 64,
                "candidateSourceManifestSHA256": "9" * 64,
                "faultPatchSHA256": "8" * 64,
            }
            receipt.write_text(json.dumps(payload))
            helper = ROOT / "bind-inventory.sh"
            command = f"""
set -euo pipefail
ACTOR_IMAGE_INVENTORY={lock!s}
ACTOR_IMAGE_LOCK_TOOL={ROOT / 'image-lock.py'!s}
AUTONOMY_CONTROL_TEST_MODE=1
AUTONOMY_CONTROL_QUALIFICATION_RECEIPT_ROOT={directory!s}
AUTONOMY_CONTROL_QUALIFICATION_CANDIDATE_RECEIPT={receipt!s}
TEST_IMAGE={candidate}
TEST_REVISION={'d' * 40}
TEST_MANIFEST={'9' * 64}
source {helper!s}
actor_image_inventory_require
actor_image_inventory_bind_runtime_release TEST_IMAGE TEST_REVISION TEST_MANIFEST rivet-runtime
printf '%s\n%s\n%s\n' "$TEST_IMAGE" "$TEST_REVISION" "$TEST_MANIFEST"
"""
            result = subprocess.run(
                ("bash", "-c", command), check=True, capture_output=True, text=True
            )
            self.assertEqual(result.stdout.splitlines(), [candidate, "d" * 40, "9" * 64])

            payload["baseRuntimeImage"] = (
                f"{REGISTRY}/{NAMESPACE}/rivet-runtime@sha256:" + "7" * 64
            )
            receipt.write_text(json.dumps(payload))
            mismatch = subprocess.run(
                ("bash", "-c", command), check=False, capture_output=True, text=True
            )
            self.assertNotEqual(mismatch.returncode, 0)
            self.assertIn("does not bind the qualified inventory", mismatch.stderr)

            payload["baseRuntimeImage"] = qualified
            receipt.write_text(json.dumps(payload))
            linked = directory / "actor-bj-q01-semantic-failure-candidate-linked.json"
            linked.symlink_to(receipt)
            symlink_command = command.replace(str(receipt), str(linked))
            symlinked = subprocess.run(
                ("bash", "-c", symlink_command), check=False, capture_output=True, text=True
            )
            self.assertNotEqual(symlinked.returncode, 0)
            self.assertIn("exact regular receipt", symlinked.stderr)

    def test_cli_refuses_to_overwrite_final_inventory(self):
        with tempfile.TemporaryDirectory() as value:
            directory = Path(value)
            seed = directory / "seed.json"
            product = directory / "product.json"
            output = directory / "output.json"
            seed.write_text(json.dumps(seed_receipt()))
            product.write_text(json.dumps(product_lock()))
            output.write_text("do-not-replace\n")
            result = subprocess.run(
                (
                    str(ROOT / "image-lock.py"), "assemble",
                    "--upstream-lock", str(ROOT / "upstream-images.lock.json"),
                    "--seed-receipt", str(seed),
                    "--product-lock", str(product),
                    "--output", str(output),
                ),
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(output.read_text(), "do-not-replace\n")

    def test_seed_script_uses_isolated_storage_and_emits_valid_receipt(self):
        with tempfile.TemporaryDirectory() as value:
            directory = Path(value)
            log = directory / "buildah.log"
            fake = directory / "buildah"
            fake.write_text(
                """#!/usr/bin/env python3
import hashlib,os,pathlib,sys
args=sys.argv[1:]
with open(os.environ["FAKE_BUILDAH_LOG"],"a") as stream:
    stream.write(" ".join(args)+"\\n")
command=next((item for item in args if item in {"pull","tag","push"}),None)
if command == "pull":
    print("sha256:"+"1"*64)
elif command == "push":
    path=pathlib.Path(args[args.index("--digestfile")+1])
    destination=args[-1]
    path.write_text("sha256:"+hashlib.sha256(destination.encode()).hexdigest()+"\\n")
elif command != "tag":
    raise SystemExit(2)
"""
            )
            fake.chmod(0o755)
            auth = directory / "auth.json"
            auth.write_text("{}\n")
            auth.chmod(0o600)
            receipt = directory / "seed.json"
            env = dict(
                os.environ,
                BUILDAH=str(fake),
                FAKE_BUILDAH_LOG=str(log),
                IMAGE_SEED_REGISTRY=REGISTRY,
                REGISTRY_AUTH_FILE=str(auth),
                IMAGE_SEED_RECEIPT=str(receipt),
            )
            subprocess.run((str(ROOT / "seed-tcr.sh"),), env=env, check=True, capture_output=True, text=True)
            contract.validate_seed(contract.load(receipt), UPSTREAM)
            calls = log.read_text()
            self.assertIn("--root /data/tmp/actor-image-seed.", calls)
            self.assertEqual(calls.count(" push "), len(contract.UPSTREAM_REPOSITORIES))
            self.assertEqual(calls.count(" pull "), 2 * len(contract.UPSTREAM_REPOSITORIES))
            lines = calls.splitlines()
            destination_pulls = [
                line for line in lines
                if " pull " in line and f"docker://{REGISTRY}/{NAMESPACE}/" in line
            ]
            self.assertEqual(len(destination_pulls), len(contract.UPSTREAM_REPOSITORIES))
            self.assertEqual(
                len({line.split(" --runroot ", 1)[0] for line in destination_pulls}),
                len(contract.UPSTREAM_REPOSITORIES),
            )
            self.assertTrue(all("/verify-" in line for line in destination_pulls))
            self.assertIn(
                "docker://quay.io/argoproj/argocd@sha256:"
                "e2aadfae709d904e87f46ba4aa49601d827b3022db22cd4d03aae816a2e7097b",
                calls,
            )
            self.assertNotIn(
                "docker://quay.io/argoproj/argocd:v3.5.2@sha256:", calls
            )
            self.assertIn("seed-" + "e2aadfae709d904e87f46ba4aa49601d827b3022db22cd4d03aae816a2e7097b", calls)


if __name__ == "__main__":
    unittest.main()
