import datetime
import importlib.util
import pathlib
import unittest


PATH = pathlib.Path(__file__).parent / "qualify.py"
SPEC = importlib.util.spec_from_file_location("command_ack_disconnect_qualify", PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class CommandAckDisconnectQualificationTest(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
