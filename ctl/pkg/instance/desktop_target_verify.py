#!/usr/bin/env python3
"""Prove the physical identity of the desktop before any viewer lease is issued.

Runs inside the sandbox under root. The observer key never leaves this process:
this script reads it locally, challenges the loopback observer proxy, verifies
the HMAC itself, and prints only the resulting incarnation. Anything less would
let a sandbox-local process squat on the port and replay a stale proof.

Output on stdout is a single JSON line: {"verified": true, "incarnation": ...}
or {"verified": false, "reason": ...} with a non-zero exit status.
"""

import hashlib
import hmac
import json
import os
import pathlib
import socket
import sys
import time

KEY_PATH = "/run/opencraft-desktop-observer/key"
PROXY_ADDRESS = ("127.0.0.1", 5902)
MAC_PREFIX = "opencraft-desktop-observer/v1\x00"
NONCE_HEX = 64
TIMEOUT_SECONDS = 3.0
MAX_HEADER_BYTES = 4096


def fail(reason):
    print(json.dumps({"verified": False, "reason": reason}, separators=(",", ":")), flush=True)
    sys.exit(1)


def read_key():
    try:
        key = pathlib.Path(KEY_PATH).read_bytes()
    except OSError:
        fail("observer key unavailable")
    if len(key) != 32:
        fail("observer key is malformed")
    return key


def challenge(key, nonce):
    try:
        client = socket.create_connection(PROXY_ADDRESS, timeout=TIMEOUT_SECONDS)
    except OSError:
        fail("observer proxy unavailable")
    try:
        client.settimeout(TIMEOUT_SECONDS)
        client.sendall((json.dumps({"nonce": nonce}, separators=(",", ":")) + "\n").encode())
        buffer = bytearray()
        deadline = time.monotonic() + TIMEOUT_SECONDS
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                fail("observer proxy timed out")
            client.settimeout(remaining)
            chunk = client.recv(4096)
            if not chunk:
                fail("observer proxy closed")
            buffer.extend(chunk)
            if len(buffer) > MAX_HEADER_BYTES:
                fail("observer proxy sent an oversized header")
            if b"\n" in buffer:
                break
        return json.loads(bytes(buffer.split(b"\n", 1)[0]))
    except (OSError, ValueError):
        fail("observer proxy response is unusable")
    finally:
        try:
            client.close()
        except OSError:
            pass


def main():
    key = read_key()
    nonce = os.urandom(NONCE_HEX // 2).hex()
    header = challenge(key, nonce)

    if header.get("protocol") != "opencraft-desktop-observer" or header.get("version") != 1:
        fail("observer proxy announced an unexpected protocol")
    if header.get("readOnly") is not True:
        fail("observer proxy lost its read-only guarantee")
    # A replayed header answers a different nonce.
    if header.get("nonce") != nonce:
        fail("observer proxy answered a different nonce")
    incarnation = header.get("incarnation")
    if not isinstance(incarnation, str) or len(incarnation) != 64:
        fail("observer proxy returned a malformed incarnation")
    if any(character not in "0123456789abcdef" for character in incarnation):
        fail("observer proxy returned a malformed incarnation")

    message = (MAC_PREFIX + nonce + "\x00" + incarnation).encode()
    expected = hmac.new(key, message, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(str(header.get("mac", "")), expected):
        fail("observer proxy proof failed verification")

    print(json.dumps({"verified": True, "incarnation": incarnation,
                      "readOnly": True}, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    main()
