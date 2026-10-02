import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import render
import yaml


def image_inputs(root: Path) -> tuple[Path, Path]:
    contract, product = render.CONTRACT, render.PRODUCT
    registry = "example.tencentcloudcr.com"
    image_digest = "sha256:" + "2" * 64

    def ref(repository: str) -> str:
        return f"{registry}/actor-fleet/{repository}@{image_digest}"

    product_paths = []
    for repository in sorted(contract.PRODUCT_REPOSITORIES):
        receipt = product.make_receipt(
            repository, ref(repository), "a" * 40, "sha256:" + "b" * 64,
            [{"repository": name, "ref": ref(name)} for name in product.DEPENDENCIES[repository]],
        )
        product_paths.append(write(root / f"{repository}.json", receipt))
    upstream = contract.validate_upstream(contract.load(render.CONTRACT_PATH.parent / "upstream-images.lock.json"))
    seed = {
        "schemaVersion": 1, "result": "passed", "registry": registry,
        "namespace": "actor-fleet", "platform": "linux/amd64",
        "sourceLockDigest": contract.digest(upstream),
        "images": [
            {
                "repository": item["repository"], "source": item["source"],
                "destination": ref(item["repository"]), "destinationDigest": image_digest,
            }
            for item in upstream["images"]
        ],
    }
    inventory = contract.assemble(upstream, seed, product.assemble(product_paths))
    return write(root / "inventory.json", inventory), root / "workers-api.json"


def write(path: Path, value: dict) -> Path:
    path.write_text(json.dumps(value))
    return path


def endpoint(cell: str, uid: str, dc: str, address: str) -> dict:
    return {
        "schema": "actor-engine-private-endpoint/v1", "verdict": "passed",
        "cell": {"name": cell, "uid": uid}, "datacenter": dc,
        "endpoint": f"http://{address}:6420",
        "network": {"subnetId": "subnet-test", "hubSourceCidrs": ["10.160.0.0/16"]},
        "service": {"namespace": "actor-fdb-cell-system", "name": cell + "-engine-private", "uid": "service-" + uid, "resourceVersion": "1"},
    }


def stateless_endpoint(
    cell: str, uid: str, dc: str, address: str, ready_endpoint_count: int = 3,
) -> dict:
    return {
        "schema": "actor-stateless-private-endpoint/v1", "verdict": "passed",
        "cell": {"name": cell, "uid": uid}, "datacenter": dc,
        "endpoint": f"http://{address}:19084",
        "network": {"subnetId": "subnet-test", "hubSourceCidrs": ["10.160.0.0/16"]},
        "service": {
            "namespace": "actor-stateless-system",
            "name": cell + "-stateless-executor-private",
            "uid": "stateless-service-" + uid,
            "resourceVersion": "1",
            "readyEndpointCount": ready_endpoint_count,
            "listenerPort": 19084,
            "targetPort": "executor",
            "externalTrafficPolicy": "Cluster",
        },
    }


def route(cell: str, uid: str, dc: str) -> dict:
    return {
        "schema": "actor-cell-route-publication/v2", "verdict": "passed",
        "convergenceReceiptDigest": "sha256:" + "1" * 64,
        "qualificationChainReceiptDigest": "sha256:" + "2" * 64,
        "activationReceiptDigest": "sha256:" + "3" * 64,
        "adoptionReceiptDigest": "sha256:" + "4" * 64,
        "pool": {"name": "actor-beijing-kubernetes", "uid": "pool-uid"},
        "cell": {"name": cell, "uid": uid}, "datacenter": dc,
        "routeConfigMap": {"name": "actor-cell-route-" + cell, "uid": "route-" + uid, "resourceVersion": "1"},
    }


def credential() -> dict:
    keys = [
        "engine-a-token", "engine-b-token", "object-router-a-token",
        "object-router-b-token", "registry-token", "stateless-a-token",
        "stateless-b-token",
    ]
    return {
        "schema": "actor-workers-api-credential-sync/v1", "verdict": "passed",
        "cells": [
            {"name": "actor-bj-a01", "uid": "uid-a"},
            {"name": "actor-bj-b01", "uid": "uid-b"},
        ],
        "credential": {
            "namespace": "workers-api-system", "name": "workers-api-internal-token-0123456789ab",
            "uid": "credential-uid", "resourceVersion": "7", "immutable": True,
            "keys": keys, "fingerprints": {key: "sha256:" + "7" * 64 for key in keys},
        },
    }


def serving_route(path: Path, identity_path: Path, endpoint_path: Path, stateless_path: Path) -> Path:
    identity = json.loads(identity_path.read_text())
    endpoint_value = json.loads(endpoint_path.read_text())
    stateless_value = json.loads(stateless_path.read_text())
    cell, pool = identity["cell"], identity["pool"]
    unsigned = {
        "schema": "actor-cell-serving-route/v1", "region": "ap-beijing",
        "pool_name": pool["name"], "pool_uid": pool["uid"],
        "cell_name": cell["name"], "cell_uid": cell["uid"],
        "datacenter": identity["datacenter"],
        "actor_gateway_authority": endpoint_value["endpoint"],
        "actor_gateway_service_uid": endpoint_value["service"]["uid"],
        "stateless_executor_authority": stateless_value["endpoint"],
        "stateless_executor_service_uid": stateless_value["service"]["uid"],
        "service_identity": "actor-cell/" + cell["uid"],
        "revision": 1, "published_at": "2026-09-23T10:00:00Z",
    }
    canonical = (json.dumps(unsigned, sort_keys=True, separators=(",", ":")) + "\n").encode()
    snapshot = {**unsigned, "manifest_sha256": "sha256:" + hashlib.sha256(canonical).hexdigest()}
    def digest(source: Path) -> str:
        return "sha256:" + hashlib.sha256(source.read_bytes()).hexdigest()
    return write(path, {
        "schema": "actor-cell-serving-route-publication/v1", "verdict": "passed",
        "route": snapshot,
        "evidence": {
            "identityRouteReceiptDigest": digest(identity_path),
            "engineEndpointReceiptDigest": digest(endpoint_path),
            "statelessEndpointReceiptDigest": digest(stateless_path),
        },
        "configMap": {
            "name": "actor-cell-serving-route-" + cell["name"],
            "uid": "serving-route-" + cell["uid"], "resourceVersion": "1",
        },
    })


class RenderTest(unittest.TestCase):
    def test_stateless_endpoint_accepts_hpa_scaled_backend_count(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            path = write(
                Path(raw) / "stateless.json",
                stateless_endpoint("actor-bj-a01", "uid-a", "actor-bj-a01", "10.161.0.14", 7),
            )
            self.assertEqual(render.validate_stateless_endpoint(path)["cell"], "actor-bj-a01")

    def test_stateless_endpoint_rejects_backend_count_below_ha_floor(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            path = write(
                Path(raw) / "stateless.json",
                stateless_endpoint("actor-bj-a01", "uid-a", "actor-bj-a01", "10.161.0.14", 2),
            )
            with self.assertRaisesRegex(ValueError, "Service identity differs"):
                render.validate_stateless_endpoint(path)

    def test_render_binds_two_exact_cell_routes(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            inventory_path, product_path = image_inputs(root)
            credential_path = write(root / "credential.json", credential())
            endpoints = [
                write(root / "endpoint-b.json", endpoint("actor-bj-b01", "uid-b", "actor-bj-b01", "10.162.0.12")),
                write(root / "endpoint-a.json", endpoint("actor-bj-a01", "uid-a", "actor-bj-a01", "10.161.0.12")),
            ]
            stateless_endpoints = [
                write(root / "stateless-b.json", stateless_endpoint("actor-bj-b01", "uid-b", "actor-bj-b01", "10.162.0.14")),
                write(root / "stateless-a.json", stateless_endpoint("actor-bj-a01", "uid-a", "actor-bj-a01", "10.161.0.14")),
            ]
            routes = [
                write(root / "route-a.json", route("actor-bj-a01", "uid-a", "actor-bj-a01")),
                write(root / "route-b.json", route("actor-bj-b01", "uid-b", "actor-bj-b01")),
            ]
            serving_routes = [
                serving_route(root / "serving-a.json", routes[0], endpoints[1], stateless_endpoints[1]),
                serving_route(root / "serving-b.json", routes[1], endpoints[0], stateless_endpoints[0]),
            ]
            encoded, evidence = render.render(
                inventory_path, product_path, credential_path, endpoints, stateless_endpoints, routes,
                serving_routes,
                "actor-beijing-kubernetes",
            )
        self.assertNotIn(b"http://10.161.0.12:6420", encoded)
        self.assertNotIn(b"http://10.162.0.12:6420", encoded)
        self.assertNotIn(b"http://10.161.0.14:19084", encoded)
        self.assertNotIn(b"http://10.162.0.14:19084", encoded)
        self.assertIn(b"engine-cell-uid-a: uid-a", encoded)
        self.assertIn(b"engine-cell-uid-b: uid-b", encoded)
        self.assertIn(b"placement-pool-uid: pool-uid", encoded)
        self.assertNotIn(b"__", encoded)
        self.assertEqual([item["cell"] for item in evidence["cells"]], ["actor-bj-a01", "actor-bj-b01"])
        documents = [item for item in yaml.safe_load_all(encoded) if item]
        deployment = next(item for item in documents if item["kind"] == "Deployment")
        hpa = next(item for item in documents if item["kind"] == "HorizontalPodAutoscaler")
        args = deployment["spec"]["template"]["spec"]["containers"][0]["args"]
        secret_refs = {
            item["valueFrom"]["secretKeyRef"]["name"]
            for item in deployment["spec"]["template"]["spec"]["containers"][0]["env"]
            if "secretKeyRef" in item.get("valueFrom", {})
        }
        self.assertEqual(secret_refs, {"workers-api-internal-token-0123456789ab"})
        self.assertEqual(evidence["credentialReceipt"]["name"], "workers-api-internal-token-0123456789ab")
        self.assertFalse(any(item.startswith("--engine-url=") for item in args))
        self.assertFalse(any(item.startswith("--stateless-executor-url=") for item in args))
        self.assertIn("--serving-route-refresh-interval=1s", args)
        self.assertEqual(
            {
                "prometheus.io/scrape": "true",
                "prometheus.io/port": "8080",
                "prometheus.io/path": "/metrics",
            },
            {
                key: deployment["spec"]["template"]["metadata"]["annotations"][key]
                for key in ("prometheus.io/scrape", "prometheus.io/port", "prometheus.io/path")
            },
        )
        self.assertEqual(
            deployment["spec"]["template"]["metadata"]["annotations"]["fleet.actor.dev/routing-config-digest"],
            evidence["routingConfigDigest"],
        )
        self.assertEqual(hpa["spec"]["minReplicas"], 3)
        self.assertEqual(hpa["spec"]["maxReplicas"], 30)
        self.assertEqual(
            {item["pods"]["metric"]["name"] for item in hpa["spec"]["metrics"] if item["type"] == "Pods"},
            {"workers_api_routing_requests_per_second", "workers_api_routing_requests_in_flight"},
        )

    def test_object_router_bootstrap_is_explicit_and_has_no_stateless_dispatch_capability(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            inventory_path, product_path = image_inputs(root)
            credential_path = write(root / "credential.json", credential())
            endpoints = [
                write(root / "endpoint-a.json", endpoint("actor-bj-a01", "uid-a", "actor-bj-a01", "10.161.0.12")),
                write(root / "endpoint-b.json", endpoint("actor-bj-b01", "uid-b", "actor-bj-b01", "10.162.0.12")),
            ]
            routes = [
                write(root / "route-a.json", route("actor-bj-a01", "uid-a", "actor-bj-a01")),
                write(root / "route-b.json", route("actor-bj-b01", "uid-b", "actor-bj-b01")),
            ]
            encoded, evidence = render.render(
                inventory_path, product_path, credential_path, endpoints, [], routes, [],
                "actor-beijing-kubernetes", "object-router-bootstrap",
            )
        documents = [item for item in yaml.safe_load_all(encoded) if item]
        deployment = next(item for item in documents if item["kind"] == "Deployment")
        container = deployment["spec"]["template"]["spec"]["containers"][0]
        self.assertEqual(evidence["phase"], "object-router-bootstrap")
        self.assertEqual(
            deployment["spec"]["template"]["metadata"]["annotations"]["fleet.actor.dev/release-phase"],
            "object-router-bootstrap",
        )
        self.assertIn("--internal-listen-address=:8081", container["args"])
        self.assertEqual(
            sum(item.startswith("--object-router-token=") for item in container["args"]), 2,
        )
        self.assertFalse(any(item.startswith("--stateless-executor-token=") for item in container["args"]))
        self.assertNotIn("STATELESS_A_TOKEN", {item["name"] for item in container["env"]})
        self.assertNotIn("STATELESS_B_TOKEN", {item["name"] for item in container["env"]})
        self.assertEqual(
            {
                item["valueFrom"]["secretKeyRef"]["name"]
                for item in container["env"] if "secretKeyRef" in item.get("valueFrom", {})
            },
            {"workers-api-internal-token-0123456789ab"},
        )
        self.assertFalse(any("statelessEndpoint" in item for item in evidence["cells"]))

    def test_bootstrap_rejects_stateless_route_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            inventory_path, product_path = image_inputs(root)
            credential_path = write(root / "credential.json", credential())
            endpoints = [
                write(root / "endpoint-a.json", endpoint("actor-bj-a01", "uid-a", "actor-bj-a01", "10.161.0.12")),
                write(root / "endpoint-b.json", endpoint("actor-bj-b01", "uid-b", "actor-bj-b01", "10.162.0.12")),
            ]
            routes = [
                write(root / "route-a.json", route("actor-bj-a01", "uid-a", "actor-bj-a01")),
                write(root / "route-b.json", route("actor-bj-b01", "uid-b", "actor-bj-b01")),
            ]
            stateless = [write(root / "stateless.json", stateless_endpoint("actor-bj-a01", "uid-a", "actor-bj-a01", "10.161.0.14"))]
            with self.assertRaisesRegex(ValueError, "must not consume"):
                render.render(
                    inventory_path, product_path, credential_path, endpoints, stateless, routes, [],
                    "actor-beijing-kubernetes", "object-router-bootstrap",
                )

    def test_render_rejects_endpoint_route_uid_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            inventory_path, product_path = image_inputs(root)
            credential_path = write(root / "credential.json", credential())
            endpoints = [
                write(root / "endpoint-a.json", endpoint("actor-bj-a01", "uid-a", "actor-bj-a01", "10.161.0.12")),
                write(root / "endpoint-b.json", endpoint("actor-bj-b01", "uid-b", "actor-bj-b01", "10.162.0.12")),
            ]
            stateless_endpoints = [
                write(root / "stateless-a.json", stateless_endpoint("actor-bj-a01", "uid-a", "actor-bj-a01", "10.161.0.14")),
                write(root / "stateless-b.json", stateless_endpoint("actor-bj-b01", "uid-b", "actor-bj-b01", "10.162.0.14")),
            ]
            bad = route("actor-bj-b01", "another-uid", "actor-bj-b01")
            routes = [write(root / "route-a.json", route("actor-bj-a01", "uid-a", "actor-bj-a01")), write(root / "route-b.json", bad)]
            serving_routes = [
                serving_route(root / "serving-a.json", routes[0], endpoints[0], stateless_endpoints[0]),
                serving_route(root / "serving-b.json", routes[1], endpoints[1], stateless_endpoints[1]),
            ]
            with self.assertRaisesRegex(ValueError, "differs"):
                render.render(
                    inventory_path, product_path, credential_path, endpoints, stateless_endpoints, routes,
                    serving_routes,
                    "actor-beijing-kubernetes",
                )

    def test_render_rejects_stateless_endpoint_identity_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            inventory_path, product_path = image_inputs(root)
            credential_path = write(root / "credential.json", credential())
            endpoints = [
                write(root / "endpoint-a.json", endpoint("actor-bj-a01", "uid-a", "actor-bj-a01", "10.161.0.12")),
                write(root / "endpoint-b.json", endpoint("actor-bj-b01", "uid-b", "actor-bj-b01", "10.162.0.12")),
            ]
            stateless_endpoints = [
                write(root / "stateless-a.json", stateless_endpoint("actor-bj-a01", "wrong-uid", "actor-bj-a01", "10.161.0.14")),
                write(root / "stateless-b.json", stateless_endpoint("actor-bj-b01", "uid-b", "actor-bj-b01", "10.162.0.14")),
            ]
            routes = [
                write(root / "route-a.json", route("actor-bj-a01", "uid-a", "actor-bj-a01")),
                write(root / "route-b.json", route("actor-bj-b01", "uid-b", "actor-bj-b01")),
            ]
            serving_routes = [
                serving_route(root / "serving-a.json", routes[0], endpoints[0], stateless_endpoints[0]),
                serving_route(root / "serving-b.json", routes[1], endpoints[1], stateless_endpoints[1]),
            ]
            with self.assertRaisesRegex(ValueError, "differs"):
                render.render(
                    inventory_path, product_path, credential_path, endpoints, stateless_endpoints, routes,
                    serving_routes,
                    "actor-beijing-kubernetes",
                )


class ImageBindingCliTest(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.inventory, self.product = image_inputs(self.root)
        self.credentials = write(self.root / "credentials.json", credential())
        self.endpoints, self.routes, self.stateless, self.serving = [], [], [], []
        for suffix, address in (("a", "10.161.0.12"), ("b", "10.162.0.12")):
            cell, uid = f"actor-bj-{suffix}01", f"uid-{suffix}"
            engine = write(self.root / f"engine-{suffix}.json", endpoint(cell, uid, cell, address))
            identity = write(self.root / f"route-{suffix}.json", route(cell, uid, cell))
            stateless = write(self.root / f"stateless-{suffix}.json", stateless_endpoint(cell, uid, cell, address))
            self.endpoints.append(engine)
            self.routes.append(identity)
            self.stateless.append(stateless)
            self.serving.append(serving_route(self.root / f"serving-{suffix}.json", identity, engine, stateless))

    def run_cli(self, phase: str) -> tuple[subprocess.CompletedProcess, Path, Path]:
        output = self.root / f"{phase}.yaml"
        receipt = self.root / f"{phase}.json"
        command = [
            sys.executable, str(render.ROOT / "render.py"),
            "--inventory", str(self.inventory), "--workers-api-product-receipt", str(self.product),
            "--credential-receipt", str(self.credentials), "--pool", "actor-beijing-kubernetes",
            "--phase", phase, "--output", str(output), "--receipt", str(receipt),
        ]
        for flag, paths in (("--engine-endpoint-receipt", self.endpoints), ("--cell-route-receipt", self.routes)):
            for path in paths:
                command.extend([flag, str(path)])
        if phase == "serving":
            for flag, paths in (("--stateless-endpoint-receipt", self.stateless), ("--cell-serving-route-receipt", self.serving)):
                for path in paths:
                    command.extend([flag, str(path)])
        return subprocess.run(command, capture_output=True, text=True, timeout=30), output, receipt

    def assert_rejected(self, message: str) -> None:
        for phase in ("object-router-bootstrap", "serving"):
            with self.subTest(phase=phase):
                result, output, receipt = self.run_cli(phase)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertFalse(output.exists())
                self.assertFalse(receipt.exists())

    def change_product(self, field: str, value: str) -> None:
        product = json.loads(self.product.read_text())
        product[field] = value
        render.PRODUCT.validate_receipt(product)
        write(self.product, product)

    def test_exact_product_renders_in_both_phases(self) -> None:
        inventory = render.CONTRACT.validate_inventory(json.loads(self.inventory.read_text()))
        self.assertEqual(len(inventory["images"]), 28)
        expected = render.CONTRACT.resolve(inventory, "workers-api")["ref"]
        for phase in ("object-router-bootstrap", "serving"):
            with self.subTest(phase=phase):
                result, output, receipt = self.run_cli(phase)
                self.assertEqual(result.returncode, 0, result.stderr)
                evidence = json.loads(receipt.read_text())
                deployment = next(item for item in yaml.safe_load_all(output.read_text()) if item and item["kind"] == "Deployment")
                self.assertEqual(deployment["spec"]["template"]["spec"]["containers"][0]["image"], expected)
                self.assertEqual(evidence["workersApiImage"], expected)
                self.assertEqual(evidence["imageInventory"]["digest"], inventory["inventoryDigest"])
                self.assertEqual(evidence["workersApiProductReceipt"]["sha256"], render.sha256(self.product))

    def test_same_foundations_do_not_authorize_a_different_product_image(self) -> None:
        image = json.loads(self.product.read_text())["ref"].replace("2" * 64, "3" * 64)
        self.change_product("ref", image)
        self.assert_rejected("Workers API image differs from the complete image inventory")

    def test_same_image_does_not_authorize_a_different_source_revision(self) -> None:
        self.change_product("sourceRevision", "c" * 40)
        self.assert_rejected("Workers API sourceRevision differs from the complete image inventory")

    def test_same_image_does_not_authorize_a_different_source_manifest(self) -> None:
        self.change_product("sourceManifestDigest", "sha256:" + "c" * 64)
        self.assert_rejected("Workers API sourceManifestDigest differs from the complete image inventory")

    def test_semantically_identical_receipt_requires_its_original_bytes(self) -> None:
        self.product.write_text(json.dumps(json.loads(self.product.read_text()), indent=2, sort_keys=True) + "\n")
        self.assert_rejected("Workers API build receipt digest differs from the complete image inventory")

    def test_self_consistent_inventory_with_a_different_receipt_digest_is_rejected(self) -> None:
        inventory = json.loads(self.inventory.read_text())
        render.CONTRACT.resolve(inventory, "workers-api")["provenance"]["buildReceiptDigest"] = "sha256:" + "c" * 64
        inventory.pop("inventoryDigest")
        inventory["inventoryDigest"] = render.CONTRACT.digest(inventory)
        render.CONTRACT.validate_inventory(inventory)
        write(self.inventory, inventory)
        self.assert_rejected("Workers API build receipt digest differs from the complete image inventory")

    def test_dependency_closure_remains_required(self) -> None:
        product = json.loads(self.product.read_text())
        product["dependencies"][0]["ref"] = product["dependencies"][0]["ref"].replace("2" * 64, "3" * 64)
        render.PRODUCT.validate_receipt(product)
        write(self.product, product)
        self.assert_rejected("Workers API build foundations differ from the complete image inventory")


if __name__ == "__main__":
    unittest.main()
