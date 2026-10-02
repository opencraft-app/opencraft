#!/usr/bin/env python3

import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(value)
    return value


PRODUCT = module("generation_product_lock", ROOT / "product-lock.py")
CONTRACT = module("generation_image_contract", ROOT / "image_contract.py")
REGISTRY = "example.tencentcloudcr.com"
RUN_ID = "1" * 32


def ref(repository):
    character = format((sum(repository.encode()) % 15) + 1, "x")
    return f"{REGISTRY}/actor-fleet/{repository}@sha256:" + character * 64


class AssembleGenerationTests(unittest.TestCase):
    def prepare(self, directory):
        upstream = CONTRACT.validate_upstream(json.loads((ROOT / "upstream-images.lock.json").read_text()))
        seed_images = []
        for item in upstream["images"]:
            destination = ref(item["repository"])
            seed_images.append({
                "repository": item["repository"],
                "source": item["source"],
                "destination": destination,
                "destinationDigest": destination.rsplit("@", 1)[1],
            })
        seed = {
            "schemaVersion": 1,
            "result": "passed",
            "registry": REGISTRY,
            "namespace": "actor-fleet",
            "platform": "linux/amd64",
            "sourceLockDigest": CONTRACT.digest(upstream),
            "images": seed_images,
        }
        seed_path = directory / "seed.json"
        seed_path.write_text(json.dumps(seed, sort_keys=True) + "\n")
        receipts = directory / "receipts"
        receipts.mkdir(exist_ok=True)
        for repository in PRODUCT.PRODUCT_REPOSITORIES:
            value = PRODUCT.make_receipt(
                repository,
                ref(repository),
                "a" * 40,
                "sha256:" + "b" * 64,
                [
                    {"repository": dependency, "ref": ref(dependency)}
                    for dependency in PRODUCT.DEPENDENCIES[repository]
                ],
            )
            (receipts / f"product-{repository}-{RUN_ID}.json").write_text(
                json.dumps(value, sort_keys=True) + "\n"
            )
        return seed_path, receipts

    def run_gate(self, directory, check=True):
        seed, receipts = self.prepare(directory)
        env = os.environ | {
            "ACTOR_PRODUCT_BUILD_RUN_ID": RUN_ID,
            "ACTOR_PRODUCT_RECEIPT_DIR": str(receipts),
            "ACTOR_IMAGE_SEED_RECEIPT": str(seed),
            "ACTOR_UPSTREAM_IMAGE_LOCK": str(ROOT / "upstream-images.lock.json"),
            "ACTOR_PRODUCT_IMAGE_LOCK": str(directory / "product.json"),
            "ACTOR_IMAGE_INVENTORY": str(directory / "inventory.json"),
            "ACTOR_BUILD_TMPDIR": str(directory),
        }
        return subprocess.run(
            (str(ROOT / "assemble-generation.sh"),), env=env, check=check,
            capture_output=True, text=True,
        )

    def test_assembles_and_resumes_one_exact_generation(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            first = self.run_gate(directory)
            self.assertIn("repositories=28", first.stdout)
            inventory = json.loads((directory / "inventory.json").read_text())
            self.assertEqual(len(inventory["images"]), 28)
            second = self.run_gate(directory)
            self.assertIn(inventory["inventoryDigest"], second.stdout)

    def test_rejects_existing_lock_from_another_generation(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            self.run_gate(directory)
            (directory / "product.json").write_text("{}\n")
            failed = self.run_gate(directory, check=False)
            self.assertNotEqual(failed.returncode, 0)
            self.assertIn("differs", failed.stderr)


if __name__ == "__main__":
    unittest.main()
