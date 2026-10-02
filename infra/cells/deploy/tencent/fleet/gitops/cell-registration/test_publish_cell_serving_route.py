import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("publish_cell_serving_route", ROOT / "publish-cell-serving-route.py")
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def identity() -> dict:
    return {
        "schema": "actor-cell-route-publication/v2", "verdict": "passed",
        "pool": {"name": "actor-beijing-kubernetes", "uid": "pool-uid-1"},
        "cell": {"name": "actor-bj-a01", "uid": "cell-uid-1"},
        "datacenter": "default",
    }


def endpoint(schema: str, component: str, port: int, address: str) -> dict:
    suffix = "engine-private" if component == "engine" else "stateless-executor-private"
    return {
        "schema": schema, "verdict": "passed",
        "cell": {"name": "actor-bj-a01", "uid": "cell-uid-1"}, "datacenter": "default",
        "endpoint": f"http://{address}:{port}",
        "service": {"name": f"actor-bj-a01-{suffix}", "uid": f"service-{component}-uid"},
    }


class ServingRouteTests(unittest.TestCase):
    def route(self, revision: int = 1) -> dict:
        return MODULE.build_route(
            identity(), endpoint("actor-engine-private-endpoint/v1", "engine", 6420, "10.161.0.12"),
            endpoint("actor-stateless-private-endpoint/v1", "stateless", 19084, "10.161.0.14"),
            "ap-beijing", revision, "2026-09-23T10:00:00Z",
        )

    def test_builds_complete_digest_bound_route(self) -> None:
        route = self.route()
        self.assertEqual(route["schema"], "actor-cell-serving-route/v1")
        self.assertEqual(route["actor_gateway_authority"], "http://10.161.0.12:6420")
        self.assertEqual(route["stateless_executor_authority"], "http://10.161.0.14:19084")
        self.assertEqual(route["revision"], 1)
        manifest = route.pop("manifest_sha256")
        self.assertEqual(manifest, MODULE.sha256_bytes(MODULE.canonical(route)))

    def test_rejects_identity_and_public_endpoint_mismatch(self) -> None:
        wrong = endpoint("actor-stateless-private-endpoint/v1", "stateless", 19084, "10.161.0.14")
        wrong["cell"]["uid"] = "replacement-cell"
        with self.assertRaisesRegex(ValueError, "identity differs"):
            MODULE.build_route(
                identity(), endpoint("actor-engine-private-endpoint/v1", "engine", 6420, "10.161.0.12"),
                wrong, "ap-beijing", 1, "2026-09-23T10:00:00Z",
            )
        public = endpoint("actor-engine-private-endpoint/v1", "engine", 6420, "8.8.8.8")
        with self.assertRaisesRegex(ValueError, "private"):
            MODULE.build_route(identity(), public, endpoint("actor-stateless-private-endpoint/v1", "stateless", 19084, "10.161.0.14"), "ap-beijing", 1, "2026-09-23T10:00:00Z")

    def test_transition_is_create_or_exact_monotonic_cas(self) -> None:
        first = self.route(1)
        self.assertEqual(MODULE.verify_transition(None, first, None), "create")
        existing = MODULE.configmap(first, "workers-api-system")
        existing["metadata"].update({"uid": "route-uid", "resourceVersion": "19"})
        self.assertEqual(MODULE.verify_transition(existing, first, None), "verify")
        self.assertEqual(MODULE.verify_transition(existing, self.route(2), "19"), "19")
        for revision, resource_version, message in ((2, None, "exact live"), (3, "19", "exactly one")):
            with self.subTest(revision=revision, resource_version=resource_version):
                with self.assertRaisesRegex(ValueError, message):
                    MODULE.verify_transition(existing, self.route(revision), resource_version)

    def test_receipt_writer_never_overwrites(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            path = Path(raw) / "route.json"
            MODULE.publish_new(path, {"ok": True})
            self.assertEqual(json.loads(path.read_text()), {"ok": True})
            with self.assertRaisesRegex(ValueError, "new absolute"):
                MODULE.publish_new(path, {"ok": False})

    def test_receipt_replay_verifies_exact_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            path = Path(raw) / "route.json"
            self.assertEqual(MODULE.publish_or_verify(path, {"ok": True}), "published")
            self.assertEqual(MODULE.publish_or_verify(path, {"ok": True}), "verified")
            with self.assertRaisesRegex(ValueError, "differs"):
                MODULE.publish_or_verify(path, {"ok": False})


if __name__ == "__main__":
    unittest.main()
