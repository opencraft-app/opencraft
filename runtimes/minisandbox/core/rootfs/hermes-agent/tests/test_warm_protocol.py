from __future__ import annotations

import importlib.util
from pathlib import Path
import socket
import struct
import sys
import unittest


PROFILE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("minisandbox_hermes_warm", PROFILE / "hermes-warm.py")
assert SPEC is not None and SPEC.loader is not None
WARM = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = WARM
SPEC.loader.exec_module(WARM)


def request() -> dict[str, object]:
    return {
        "prompt": "hello",
        "provider": "openrouter",
        "model": "minisandbox-e2e",
        "credential_env": "OPENROUTER_API_KEY",
        "credential": "not-a-secret",
        "base_url": "http://192.0.2.1:1234/v1",
    }


class WarmProtocolTests(unittest.TestCase):
    def test_canonical_request_is_accepted(self) -> None:
        self.assertEqual(
            WARM.validate_request(request()),
            (
                "hello",
                "openrouter",
                "minisandbox-e2e",
                "OPENROUTER_API_KEY",
                "not-a-secret",
                "http://192.0.2.1:1234/v1",
            ),
        )

    def test_unknown_field_is_rejected(self) -> None:
        hostile = request()
        hostile["extra"] = "ignored-by-lax-decoders"
        with self.assertRaisesRegex(ValueError, "not canonical"):
            WARM.validate_request(hostile)

    def test_provider_credential_pair_is_rejected(self) -> None:
        hostile = request()
        hostile["credential_env"] = "OPENAI_API_KEY"
        with self.assertRaisesRegex(ValueError, "not allowlisted"):
            WARM.validate_request(hostile)

    def test_base_url_override_is_openrouter_only(self) -> None:
        hostile = request()
        hostile["provider"] = "anthropic"
        hostile["credential_env"] = "ANTHROPIC_API_KEY"
        with self.assertRaisesRegex(ValueError, "base URL override"):
            WARM.validate_request(hostile)

    def test_gateway_launch_environment_is_accepted(self) -> None:
        self.assertEqual(
            WARM.validate_gateway_request(
                {
                    "operation": "gateway",
                    "environment": {
                        "OPENROUTER_API_KEY": "clone-secret",
                        "HTTPS_PROXY": "http://192.0.2.1:8080",
                    },
                }
            ),
            {
                "OPENROUTER_API_KEY": "clone-secret",
                "HTTPS_PROXY": "http://192.0.2.1:8080",
            },
        )

    def test_gateway_launch_rejects_bootstrap_environment_override(self) -> None:
        with self.assertRaisesRegex(ValueError, "environment name"):
            WARM.validate_gateway_request(
                {"operation": "gateway", "environment": {"PYTHONPATH": "/tmp/hostile"}}
            )

    def test_gateway_launch_rejects_unknown_field(self) -> None:
        with self.assertRaisesRegex(ValueError, "not canonical"):
            WARM.validate_gateway_request(
                {"operation": "gateway", "environment": {}, "extra": True}
            )

    def test_request_frame_round_trips(self) -> None:
        reader, writer = socket.socketpair()
        self.addCleanup(reader.close)
        self.addCleanup(writer.close)
        payload = b'{"prompt":"hello"}'
        writer.sendall(struct.pack("!I", len(payload)) + payload)
        self.assertEqual(WARM.read_frame(reader), {"prompt": "hello"})

    def test_oversized_request_frame_fails_before_body_read(self) -> None:
        reader, writer = socket.socketpair()
        self.addCleanup(reader.close)
        self.addCleanup(writer.close)
        writer.sendall(struct.pack("!I", WARM.MAX_REQUEST_BYTES + 1))
        with self.assertRaisesRegex(ValueError, "request length"):
            WARM.read_frame(reader)

    def test_oversized_response_becomes_bounded_error(self) -> None:
        reader, writer = socket.socketpair()
        self.addCleanup(reader.close)
        self.addCleanup(writer.close)
        WARM.write_frame(
            writer,
            {"exit_code": 0, "stdout": "x" * (WARM.MAX_RESPONSE_BYTES + 1), "stderr": ""},
        )
        (length,) = struct.unpack("!I", WARM.read_exact(reader, 4))
        self.assertLess(length, 1024)
        self.assertIn(b"exceeded limit", WARM.read_exact(reader, length))


if __name__ == "__main__":
    unittest.main()
