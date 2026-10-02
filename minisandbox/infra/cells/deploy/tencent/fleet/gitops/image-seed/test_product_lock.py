#!/usr/bin/env python3

import copy
import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("product_lock", ROOT / "product-lock.py")
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)
CONTRACT_SPEC = importlib.util.spec_from_file_location("product_image_contract", ROOT / "image_contract.py")
CONTRACT = importlib.util.module_from_spec(CONTRACT_SPEC)
assert CONTRACT_SPEC.loader is not None
CONTRACT_SPEC.loader.exec_module(CONTRACT)
REGISTRY = "example.tencentcloudcr.com"
DIGEST = "sha256:" + "a" * 64


def ref(repository):
    return f"{REGISTRY}/actor-fleet/{repository}@{DIGEST}"


def receipt(repository):
    return MODULE.make_receipt(
        repository,
        ref(repository),
        "b" * 40,
        "sha256:" + "c" * 64,
        [{"repository": dependency, "ref": ref(dependency)} for dependency in MODULE.DEPENDENCIES[repository]],
    )


def inventory():
    upstream = CONTRACT.validate_upstream(CONTRACT.load(ROOT / "upstream-images.lock.json"))
    seed = {
        "schemaVersion": 1,
        "result": "passed",
        "registry": REGISTRY,
        "namespace": "actor-fleet",
        "platform": upstream["platform"],
        "sourceLockDigest": CONTRACT.digest(upstream),
        "images": [
            {
                "repository": item["repository"],
                "source": item["source"],
                "destination": ref(item["repository"]),
                "destinationDigest": DIGEST,
            }
            for item in upstream["images"]
        ],
    }
    products = {
        "schemaVersion": 1,
        "registry": REGISTRY,
        "namespace": "actor-fleet",
        "images": [
            {
                "repository": repository,
                "ref": ref(repository),
                "sourceRevision": "b" * 40,
                "sourceManifestDigest": "sha256:" + "c" * 64,
                "buildReceiptDigest": "sha256:" + "d" * 64,
            }
            for repository in sorted(MODULE.PRODUCT_REPOSITORIES)
        ],
    }
    return CONTRACT.assemble(upstream, seed, products)


class ProductLockTests(unittest.TestCase):
    def test_cli_exports_the_single_repository_contract(self):
        result = subprocess.run(
            (str(ROOT / "product-lock.py"), "required-repositories"),
            check=True, capture_output=True, text=True,
        )
        self.assertEqual(result.stdout.splitlines(), sorted(MODULE.PRODUCT_REPOSITORIES))

    def write_all(self, directory):
        paths = []
        for repository in sorted(MODULE.PRODUCT_REPOSITORIES):
            path = directory / f"{repository}.json"
            path.write_text(json.dumps(receipt(repository), sort_keys=True) + "\n")
            paths.append(path)
        return paths

    def test_assembles_exact_dependency_closed_product_inventory(self):
        with tempfile.TemporaryDirectory() as value:
            paths = self.write_all(Path(value))
            result = MODULE.assemble(paths)
            self.assertEqual(len(result["images"]), 11)
            self.assertEqual({item["repository"] for item in result["images"]}, MODULE.PRODUCT_REPOSITORIES)
            self.assertTrue(all(item["buildReceiptDigest"].startswith("sha256:") for item in result["images"]))
            CONTRACT.validate_product(result, REGISTRY, "actor-fleet")

    def test_rejects_dependency_from_another_base_digest(self):
        with tempfile.TemporaryDirectory() as value:
            directory = Path(value)
            paths = self.write_all(directory)
            path = directory / "workers-api.json"
            changed = json.loads(path.read_text())
            changed["dependencies"][0]["ref"] = changed["dependencies"][0]["ref"][:-1] + "d"
            path.write_text(json.dumps(changed) + "\n")
            with self.assertRaisesRegex(ValueError, "outside the assembled"):
                MODULE.assemble(paths)

    def test_rejects_missing_or_extra_dependency(self):
        changed = copy.deepcopy(receipt("rivet-runtime"))
        changed["dependencies"] = []
        with self.assertRaisesRegex(ValueError, "dependency set"):
            MODULE.validate_receipt(changed)

    def test_rejects_receipt_without_registry_pull_proof(self):
        changed = copy.deepcopy(receipt("git-service"))
        changed["registryPullVerified"] = False
        with self.assertRaisesRegex(ValueError, "pull verification"):
            MODULE.validate_receipt(changed)

    def test_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as value:
            output = Path(value) / "receipt.json"
            output.write_text("keep\n")
            with self.assertRaisesRegex(ValueError, "new absolute"):
                MODULE.write_new(output, receipt("git-service"))
            self.assertEqual(output.read_text(), "keep\n")

    def test_promotes_leaf_receipts_without_rebuilding_the_generation(self):
        with tempfile.TemporaryDirectory() as value:
            directory = Path(value)
            before = inventory()
            paths = []
            for repository in ("actor-fleet-controller", "workers-api"):
                changed = receipt(repository)
                changed["ref"] = changed["ref"].replace("a" * 64, "e" * 64)
                path = directory / f"{repository}.json"
                path.write_text(json.dumps(changed, sort_keys=True) + "\n")
                paths.append(path)
            after = MODULE.promote(before, paths)
            self.assertNotEqual(after["inventoryDigest"], before["inventoryDigest"])
            self.assertEqual(CONTRACT.validate_inventory(after), after)
            changed = {item["repository"] for item in after["images"] if item != next(
                old for old in before["images"] if old["repository"] == item["repository"]
            )}
            self.assertEqual(changed, {"actor-fleet-controller", "workers-api"})

    def test_promotion_rejects_cross_registry_and_stale_dependencies(self):
        with tempfile.TemporaryDirectory() as value:
            directory = Path(value)
            cross = receipt("git-service")
            cross["ref"] = cross["ref"].replace(REGISTRY, "other.tencentcloudcr.com")
            path = directory / "cross.json"
            path.write_text(json.dumps(cross) + "\n")
            with self.assertRaisesRegex(ValueError, "target differs"):
                MODULE.promote(inventory(), [path])

            stale = receipt("workers-api")
            stale["dependencies"][0]["ref"] = stale["dependencies"][0]["ref"][:-1] + "e"
            path = directory / "stale.json"
            path.write_text(json.dumps(stale) + "\n")
            with self.assertRaisesRegex(ValueError, "dependency differs"):
                MODULE.promote(inventory(), [path])

    def test_promotion_refuses_foundation_products(self):
        with tempfile.TemporaryDirectory() as value:
            path = Path(value) / "base-golang.json"
            path.write_text(json.dumps(receipt("base-golang")) + "\n")
            with self.assertRaisesRegex(ValueError, "complete generation rebuild"):
                MODULE.promote(inventory(), [path])


if __name__ == "__main__":
    unittest.main()
