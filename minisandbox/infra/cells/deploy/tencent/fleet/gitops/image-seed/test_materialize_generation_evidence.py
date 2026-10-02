#!/usr/bin/env python3

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
SPEC = importlib.util.spec_from_file_location("materialize_generation_evidence", ROOT / "materialize-generation-evidence.py")
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)
import image_contract as contract
product_lock = MODULE.product_lock


class MaterializeGenerationEvidenceTests(unittest.TestCase):
    def fixture(self, root: Path):
        upstream = {
            "schemaVersion": 1, "platform": "linux/amd64", "images": [
                {"component": repository, "repository": repository,
                 "source": f"registry.invalid/{repository}@sha256:" + f"{index + 1:064x}"}
                for index, repository in enumerate(sorted(contract.UPSTREAM_REPOSITORIES))
            ],
        }
        registry = "example.tencentcloudcr.com"
        seed = {
            "schemaVersion": 1, "result": "passed", "registry": registry,
            "namespace": "actor-fleet", "platform": "linux/amd64",
            "sourceLockDigest": contract.digest(upstream), "images": [],
        }
        for index, item in enumerate(upstream["images"], 100):
            digest = "sha256:" + f"{index:064x}"
            seed["images"].append({
                "repository": item["repository"], "source": item["source"],
                "destination": f"{registry}/actor-fleet/{item['repository']}@{digest}",
                "destinationDigest": digest,
            })
        refs = {
            repository: f"{registry}/actor-fleet/{repository}@sha256:" + f"{index + 200:064x}"
            for index, repository in enumerate(sorted(contract.PRODUCT_REPOSITORIES))
        }
        receipts = {}
        for repository in sorted(contract.PRODUCT_REPOSITORIES):
            receipts[repository] = product_lock.make_receipt(
                repository, refs[repository], "a" * 40, "sha256:" + "b" * 64,
                [{"repository": dependency, "ref": refs[dependency]}
                 for dependency in sorted(product_lock.DEPENDENCIES[repository])],
            )
        product = {
            "schemaVersion": 1, "registry": registry, "namespace": "actor-fleet",
            "images": [{
                "repository": repository, "ref": refs[repository],
                "sourceRevision": "a" * 40, "sourceManifestDigest": "sha256:" + "b" * 64,
                "buildReceiptDigest": MODULE.sha256(MODULE.encoded(receipts[repository])),
            } for repository in sorted(receipts)],
        }
        inventory = contract.assemble(upstream, seed, product)
        inventory_path, upstream_path = root / "inventory.json", root / "upstream.json"
        inventory_path.write_text(json.dumps(inventory))
        upstream_path.write_text(json.dumps(upstream))
        return inventory_path, upstream_path

    def test_materializes_exact_generation_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            inventory, upstream = self.fixture(root)
            output = root / "evidence"
            result = MODULE.materialize(inventory, upstream, output, "1" * 32)
            self.assertEqual(json.loads(Path(result["receipt"]).read_text())["verdict"], "passed")
            product_receipts = [
                path for path in output.glob("product-*-" + "1" * 32 + ".json")
                if not path.name.startswith("product-images-")
            ]
            self.assertEqual(len(product_receipts), 11)
            MODULE.materialize(inventory, upstream, output, "1" * 32)

    def test_rejects_a_non_preimage_product_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            inventory_path, upstream = self.fixture(root)
            inventory = json.loads(inventory_path.read_text())
            product = next(item for item in inventory["images"] if item["repository"] == "workers-api")
            product["provenance"]["buildReceiptDigest"] = "sha256:" + "0" * 64
            unsigned = dict(inventory)
            unsigned.pop("inventoryDigest")
            inventory["inventoryDigest"] = contract.digest(unsigned)
            inventory_path.write_text(json.dumps(inventory))
            with self.assertRaisesRegex(ValueError, "differs for workers-api"):
                MODULE.materialize(inventory_path, upstream, root / "evidence", "2" * 32)


if __name__ == "__main__":
    unittest.main()
