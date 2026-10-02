import argparse
import datetime
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.request


PATH = pathlib.Path(__file__).parent / "qualify.py"
SPEC = importlib.util.spec_from_file_location("command_ack_disconnect_qualify", PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class CommandAckDisconnectQualificationTest(unittest.TestCase):
    def test_explicit_registry_endpoint_does_not_require_cluster_dns(self):
        args = argparse.Namespace(registry_endpoint="http://127.0.0.1:8080/")
        with MODULE.reachable_registry(args) as endpoint:
            self.assertEqual(endpoint, "http://127.0.0.1:8080")

    def test_registry_service_name_cannot_select_another_resource(self):
        args = argparse.Namespace(registry_endpoint=None, registry_service="../pods/engine")
        with self.assertRaisesRegex(ValueError, "Kubernetes Service name"):
            with MODULE.reachable_registry(args):
                self.fail("invalid service reached the callback")

    def test_registry_service_and_endpoint_are_mutually_exclusive(self):
        result = subprocess.run(
            [sys.executable, str(PATH), "--registry-endpoint", "http://127.0.0.1:8080",
             "--registry-service", "worker-registry"],
            capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("not allowed with argument --registry-endpoint", result.stderr)

    def test_registry_forward_uses_hub_service_and_cleans_up_on_success_and_error(self):
        with tempfile.TemporaryDirectory(prefix="ack-registry-forward.", dir="/data/tmp") as raw:
            root = pathlib.Path(raw)
            kubectl = root / "kubectl"
            shutil.copy2(PATH.parent / "fixtures" / "kubectl-port-forward.py", kubectl)
            kubectl.chmod(0o700)
            for mode in ("success", "error"):
                with self.subTest(mode=mode):
                    result = subprocess.run(
                        [sys.executable, str(pathlib.Path(__file__).resolve()), "--registry-forward-probe", str(root / "hub.kubeconfig"), mode],
                        env={**os.environ, "PATH": str(root) + os.pathsep + os.environ["PATH"]},
                        text=True, capture_output=True, timeout=45,
                    )
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    evidence = json.loads(result.stdout)
                    self.assertEqual(evidence["kubeconfig"], str(root / "hub.kubeconfig"))
                    self.assertEqual(evidence["namespace"], "worker-registry-system")
                    self.assertEqual(evidence["service"], "service/worker-registry")
                    self.assertTrue(evidence["closed"])
                    self.assertEqual(evidence["callbackFailed"], mode == "error")

    def test_extracts_latest_text_envoy_connection(self):
        logs = "\n".join(
            [
                "2026-10-01T00:00:00Z INFO envoy_key=old envoy websocket connection ready",
                "2026-10-01T00:00:01Z INFO envoy_key=current envoy websocket connection ready",
            ]
        )
        observed = MODULE.extract_envoy_key(logs, "envoy websocket connection ready")
        self.assertEqual("current", observed[1])
        self.assertEqual(
            datetime.datetime(2026, 10, 1, 0, 0, 1, tzinfo=datetime.timezone.utc),
            observed[0],
        )

    def test_extracts_structured_envoy_connection(self):
        logs = (
            '2026-10-01T00:00:00Z {"fields":{"message":"workerd envoy host connected",'
            '"envoy_key":"envoy-a"}}'
        )
        observed = MODULE.extract_envoy_key(logs, "workerd envoy host connected")
        self.assertEqual("envoy-a", observed[1])

    def test_filters_one_envoy_before_selecting_latest_connection(self):
        logs = "\n".join(
            [
                "2026-10-01T00:00:00Z INFO envoy_key=target envoy websocket connection ready",
                "2026-10-01T00:00:01Z INFO envoy_key=other envoy websocket connection ready",
            ]
        )
        observed = MODULE.extract_envoy_key(
            logs, "envoy websocket connection ready", expected_key="target"
        )
        self.assertEqual("target", observed[1])

    def test_matches_exact_structured_checkpoint(self):
        line = (
            '2026-10-01T00:00:00Z {"fields":{"message":"processed durable command",'
            '"actor_id":"actor-a","generation":7,"index":19,"command_kind":"stop"}}'
        )
        self.assertTrue(
            MODULE.line_has_event(
                line, "processed durable command", "actor-a", 7, 19, "stop"
            )
        )
        self.assertFalse(
            MODULE.line_has_event(
                line, "processed durable command", "actor-a", 7, 20, "stop"
            )
        )

    def test_matches_quoted_text_command_kind(self):
        line = (
            "2026-10-01T00:00:00Z INFO actor_id=actor-a generation=7 index=19 "
            'command_kind="stop" processed durable command'
        )
        self.assertTrue(
            MODULE.line_has_event(
                line, "processed durable command", "actor-a", 7, 19, "stop"
            )
        )

    def test_container_identity_requires_runtime_digest(self):
        pod = {
            "spec": {"containers": [{"name": "engine", "image": "repo/runtime:v1"}]},
            "status": {
                "containerStatuses": [
                    {"name": "engine", "imageID": "repo/runtime@sha256:abc"}
                ]
            },
        }
        self.assertEqual(
            {
                "image": "repo/runtime:v1",
                "imageId": "repo/runtime@sha256:abc",
            },
            MODULE.container_identity(pod, "engine"),
        )
        with self.assertRaises(RuntimeError):
            MODULE.container_identity({"spec": {}, "status": {}}, "engine")

    def test_remote_removal_is_narrow(self):
        class Kube:
            def __init__(self):
                self.args = None

            def run(self, *args):
                self.args = args

        kube = Kube()
        MODULE.remove_remote(
            kube,
            "engine-0",
            "/tmp/rivet-command-ack-disconnect-deadbeef.fired.json",
        )
        self.assertEqual("rm", kube.args[-4])
        with self.assertRaises(ValueError):
            MODULE.remove_remote(kube, "engine-0", "/tmp/../unsafe")


def probe_registry_forward(kubeconfig, mode):
    args = argparse.Namespace(registry_endpoint=None, registry_service="worker-registry",
                              registry_namespace="worker-registry-system", hub_kubeconfig=kubeconfig)
    evidence = {"callbackFailed": False}
    try:
        with MODULE.reachable_registry(args) as endpoint:
            with urllib.request.urlopen(endpoint + "/readyz", timeout=1) as response:
                evidence.update(json.load(response))
            if mode == "error":
                raise ValueError("intentional qualification callback failure")
    except ValueError:
        if mode != "error":
            raise
        evidence["callbackFailed"] = True
    try:
        urllib.request.urlopen(endpoint + "/readyz", timeout=1)
    except urllib.error.URLError:
        evidence["closed"] = True
    else:
        raise AssertionError("Registry port-forward survived qualification exit")
    print(json.dumps(evidence))


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--registry-forward-probe":
        probe_registry_forward(sys.argv[2], sys.argv[3])
    else:
        unittest.main()
