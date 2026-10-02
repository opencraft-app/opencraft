"""One-shot launcher for the checkpointed Hermes gateway bootstrap."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import socket
import struct
import sys
import time


SOCKET_PATH = "/run/minisandbox-hermes/agent.sock"
STATUS_PATH = Path("/opt/data/gateway_state.json")
MAX_FRAME_BYTES = 1024 * 1024
READY_STATES = {"running", "degraded"}
TERMINAL_STATES = {"startup_failed", "stopped"}


def read_exact(connection: socket.socket, length: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < length:
        chunk = connection.recv(length - len(chunks))
        if not chunk:
            raise RuntimeError("short Hermes bootstrap response")
        chunks.extend(chunk)
    return bytes(chunks)


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--env",
        action="append",
        default=[],
        metavar="NAME",
        help="copy one environment variable into the long-lived gateway",
    )
    parser.add_argument("--timeout", type=float, default=60.0)
    return parser.parse_args()


def load_status() -> dict[str, object] | None:
    try:
        value = json.loads(STATUS_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    return value if isinstance(value, dict) else None


def status_signature() -> tuple[int, int, int] | None:
    try:
        status = STATUS_PATH.stat()
    except OSError:
        return None
    return status.st_ino, status.st_mtime_ns, status.st_size


def main() -> int:
    arguments = parse_arguments()
    if not 0 < arguments.timeout <= 300:
        print("Hermes gateway timeout must be in (0, 300] seconds", file=sys.stderr)
        return 2
    environment: dict[str, str] = {}
    for name in arguments.env:
        if name in environment:
            print(f"duplicate Hermes gateway environment name: {name}", file=sys.stderr)
            return 2
        value = os.environ.get(name)
        if value is None:
            print(f"Hermes gateway environment is missing: {name}", file=sys.stderr)
            return 2
        environment[name] = value
    request = {"operation": "gateway", "environment": environment}
    payload = json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode()
    if not 1 <= len(payload) <= 64 * 1024:
        print("Hermes gateway launch request is too large", file=sys.stderr)
        return 2
    previous_status = status_signature()
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.connect(SOCKET_PATH)
        connection.sendall(struct.pack("!I", len(payload)) + payload)
        (length,) = struct.unpack("!I", read_exact(connection, 4))
        if not 1 <= length <= MAX_FRAME_BYTES:
            raise RuntimeError("invalid Hermes bootstrap response length")
        response = json.loads(read_exact(connection, length))
    if (
        not isinstance(response, dict)
        or set(response) != {"accepted", "pid"}
        or response.get("accepted") is not True
        or not isinstance(response.get("pid"), int)
        or response["pid"] <= 1
    ):
        raise RuntimeError(f"Hermes gateway launch was rejected: {response!r}")
    peer_pid = response["pid"]

    deadline = time.monotonic() + arguments.timeout
    while time.monotonic() < deadline:
        current_status = status_signature()
        if current_status is None or current_status == previous_status:
            time.sleep(0.025)
            continue
        status = load_status()
        if status is None or status.get("pid") != peer_pid:
            time.sleep(0.025)
            continue
        state = status.get("gateway_state")
        if state in READY_STATES:
            print(f"MINISANDBOX_HERMES_GATEWAY_READY state={state}")
            return 0
        if state in TERMINAL_STATES:
            reason = status.get("exit_reason")
            print(f"Hermes gateway failed to start: state={state} reason={reason}", file=sys.stderr)
            return 1
        time.sleep(0.025)
    print("Hermes gateway did not become ready before the deadline", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
