"""Bounded client for the clone-local Hermes warm daemon."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import socket
import struct
import sys


SOCKET_PATH = "/run/minisandbox-hermes/agent.sock"
MAX_FRAME_BYTES = 1024 * 1024


def read_exact(connection: socket.socket, length: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < length:
        chunk = connection.recv(length - len(chunks))
        if not chunk:
            raise RuntimeError("short Hermes daemon response")
        chunks.extend(chunk)
    return bytes(chunks)


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--provider", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--credential-env", required=True)
    parser.add_argument("--base-url", default="")
    return parser.parse_args()


def main() -> int:
    arguments = parse_arguments()
    credential = os.environ.get(arguments.credential_env, "")
    if not credential:
        print("Hermes credential environment is empty", file=sys.stderr)
        return 2
    request = {
        "prompt": arguments.prompt,
        "provider": arguments.provider,
        "model": arguments.model,
        "credential_env": arguments.credential_env,
        "credential": credential,
        "base_url": arguments.base_url,
    }
    payload = json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode()
    if not 1 <= len(payload) <= 64 * 1024:
        print("Hermes daemon request is too large", file=sys.stderr)
        return 2
    if not Path(SOCKET_PATH).is_socket():
        print("Hermes warm daemon socket is unavailable", file=sys.stderr)
        return 1
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.connect(SOCKET_PATH)
        connection.sendall(struct.pack("!I", len(payload)) + payload)
        (length,) = struct.unpack("!I", read_exact(connection, 4))
        if not 1 <= length <= MAX_FRAME_BYTES:
            raise RuntimeError("invalid Hermes daemon response length")
        response = json.loads(read_exact(connection, length))
    if not isinstance(response, dict) or set(response) != {"exit_code", "stdout", "stderr"}:
        raise RuntimeError("invalid Hermes daemon response")
    exit_code = response["exit_code"]
    stdout = response["stdout"]
    stderr = response["stderr"]
    if not isinstance(exit_code, int) or not 0 <= exit_code <= 255:
        raise RuntimeError("invalid Hermes daemon exit code")
    if not isinstance(stdout, str) or not isinstance(stderr, str):
        raise RuntimeError("invalid Hermes daemon output")
    sys.stdout.write(stdout)
    sys.stderr.write(stderr)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
