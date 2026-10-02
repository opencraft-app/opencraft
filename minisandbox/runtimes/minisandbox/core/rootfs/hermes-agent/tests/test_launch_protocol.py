from __future__ import annotations

from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import struct
import sys
import tempfile
import threading
import unittest
from unittest import mock


PROFILE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "minisandbox_hermes_launch", PROFILE / "hermes-launch.py"
)
assert SPEC is not None and SPEC.loader is not None
LAUNCH = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = LAUNCH
SPEC.loader.exec_module(LAUNCH)


class LaunchProtocolTests(unittest.TestCase):
    def test_launch_forwards_named_environment_and_waits_for_running(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            socket_path = root / "agent.sock"
            status_path = root / "gateway_state.json"
            status_path.write_text(
                json.dumps({"gateway_state": "running", "pid": os.getpid()}),
                encoding="utf-8",
            )
            ready = threading.Event()
            received: list[dict[str, object]] = []

            def server() -> None:
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
                    listener.bind(str(socket_path))
                    listener.listen(1)
                    ready.set()
                    connection, _ = listener.accept()
                    with connection:
                        (length,) = struct.unpack("!I", LAUNCH.read_exact(connection, 4))
                        request = json.loads(LAUNCH.read_exact(connection, length))
                        received.append(request)
                        payload = json.dumps(
                            {"accepted": True, "pid": os.getpid()}, separators=(",", ":")
                        ).encode()
                        connection.sendall(struct.pack("!I", len(payload)) + payload)
                replacement = status_path.with_suffix(".new")
                replacement.write_text(
                    json.dumps({"gateway_state": "running", "pid": os.getpid()}),
                    encoding="utf-8",
                )
                replacement.replace(status_path)

            worker = threading.Thread(target=server)
            worker.start()
            self.assertTrue(ready.wait(timeout=2))
            output = io.StringIO()
            with (
                mock.patch.object(LAUNCH, "SOCKET_PATH", str(socket_path)),
                mock.patch.object(LAUNCH, "STATUS_PATH", status_path),
                mock.patch.object(sys, "argv", ["hermes-launch.py", "--env", "API_KEY"]),
                mock.patch.dict("os.environ", {"API_KEY": "clone-secret"}, clear=True),
                redirect_stdout(output),
            ):
                self.assertEqual(LAUNCH.main(), 0)
            worker.join(timeout=2)
            self.assertFalse(worker.is_alive())
            self.assertEqual(
                received,
                [
                    {
                        "operation": "gateway",
                        "environment": {"API_KEY": "clone-secret"},
                    }
                ],
            )
            self.assertIn("MINISANDBOX_HERMES_GATEWAY_READY", output.getvalue())

    def test_missing_named_environment_fails_before_connect(self) -> None:
        error = io.StringIO()
        with (
            mock.patch.object(sys, "argv", ["hermes-launch.py", "--env", "MISSING"]),
            mock.patch.dict("os.environ", {}, clear=True),
            redirect_stderr(error),
        ):
            self.assertEqual(LAUNCH.main(), 2)
        self.assertIn("environment is missing", error.getvalue())


if __name__ == "__main__":
    unittest.main()
