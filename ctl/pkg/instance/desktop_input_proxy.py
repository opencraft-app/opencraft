#!/usr/bin/env python3
"""Writable desktop input gateway (runs inside the sandbox under root).

The browser reaches this gateway over the instance-scoped TAT tunnel and never
learns any RFB password: authentication is the TAT session, and authorization is
the grant file written by CTL.

Why a gateway at all instead of exposing the writable endpoint directly:
  - Input is denied by default. RFB input messages (KeyEvent / PointerEvent /
    ClientCutText) are dropped unless a grant is currently valid.
  - A bounded, single-use attach binds this connection to its grant. Revocation
    or a changed grant closes the connection and releases held keys/buttons.
  - One client holds input; additional viewers use the separate read-only port.
    Grant/revoke use conditional updates and tombstones to fence late commands.

Frame handling is deliberately narrow: only the client-to-server message stream
is parsed, and only to classify input. Everything else is relayed verbatim.
"""

import base64
import fcntl
import hashlib
import hmac
import importlib.util
import json
import math
import os
import pathlib
import select
import socket
import stat
import sys
import tempfile
import time
import uuid
from contextlib import contextmanager

LISTEN_ADDRESS = ("127.0.0.1", 5904)
UPSTREAM_ADDRESS = ("127.0.0.1", 5903)
GRANT_PATH = "/run/opencraft-desktop-input/grant"
POLL_SECONDS = 0.2
GRANT_CHECK_INTERVAL = 0.5
CONNECT_TIMEOUT = 3.0
MAX_BUFFER = 1 << 20
MAX_GRANT_TTL_MS = 300_000
CLOCK_SKEW_MS = 30_000

# RFB client-to-server message types (RFC 6143 §7.5+).
SET_PIXEL_FORMAT = 0
SET_ENCODINGS = 2
FRAMEBUFFER_UPDATE_REQUEST = 3
KEY_EVENT = 4
POINTER_EVENT = 5
CLIENT_CUT_TEXT = 6
ENABLE_CONTINUOUS_UPDATES = 150

# Input messages are the only ones subject to authorization.
INPUT_TYPES = frozenset((KEY_EVENT, POINTER_EVENT, CLIENT_CUT_TEXT))

# Fixed-size messages. SET_ENCODINGS and CLIENT_CUT_TEXT are variable length and
# carry their own count/length field.
FIXED_SIZE = {
    SET_PIXEL_FORMAT: 20,
    FRAMEBUFFER_UPDATE_REQUEST: 10,
    KEY_EVENT: 8,
    POINTER_EVENT: 6,
    ENABLE_CONTINUOUS_UPDATES: 10,
}

# Single client message ceiling; anything larger means we lost framing.
MAX_MESSAGE = 1 << 20


def valid_identity(identity):
    try:
        return isinstance(identity, str) and str(uuid.UUID(identity)) == identity
    except ValueError:
        return False


def valid_expiry(value):
    try:
        return type(value) in (int, float) and math.isfinite(value) and value > 0
    except OverflowError:
        return False


def valid_digest(value):
    try:
        return isinstance(value, str) and len(value) == 64 and len(bytes.fromhex(value)) == 32
    except ValueError:
        return False


def read_epoch_locked():
    """Missing is initial state; malformed or unsafe state must never reset it."""
    try:
        fd = os.open(pathlib.Path(GRANT_PATH).with_name("epoch"), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    with os.fdopen(fd, "r") as source:
        info = os.fstat(source.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 4096):
            raise ValueError("unsafe desktop epoch")
        payload = json.load(source)
    if (not isinstance(payload, dict) or not valid_identity(payload.get("generation"))
            or not valid_digest(payload.get("incarnation"))):
        raise ValueError("invalid desktop epoch")
    return payload


def read_grant_record():
    try:
        payload = json.loads(pathlib.Path(GRANT_PATH).read_text())
        if (not isinstance(payload, dict) or not valid_identity(payload.get("attachmentId"))
                or not valid_expiry(payload.get("expiresAt"))
                or not valid_expiry(payload.get("deadlineMonotonic"))
                or not valid_digest(payload.get("ticketDigest"))
                or not valid_identity(payload.get("generation"))
                or not valid_digest(payload.get("incarnation"))):
            return None
        return payload
    except (OSError, ValueError):
        return None


def read_grant_locked():
    payload = read_grant_record()
    if (not payload or payload["expiresAt"] <= time.time() * 1000
            or payload["deadlineMonotonic"] <= time.monotonic()):
        return None
    epoch = read_epoch_locked()
    if not epoch or any(payload[key] != epoch[key] for key in ("generation", "incarnation")):
        return None
    return payload


def read_grant():
    try:
        with grant_lock():
            return read_grant_locked()
    except (OSError, ValueError):
        return None


@contextmanager
def grant_lock():
    directory = pathlib.Path(GRANT_PATH).parent
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    with open(directory / "lock", "a+b") as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield directory


def atomic_json(path, payload):
    fd, temporary = tempfile.mkstemp(prefix=".grant-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            json.dump(payload, output, allow_nan=False)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def activate_epoch(generation, expected, incarnation):
    if (not valid_identity(generation) or (expected != "-" and not valid_identity(expected))
            or not valid_digest(incarnation)):
        return False
    with grant_lock() as directory:
        current = read_epoch_locked()
        if current and current["generation"] == generation:
            return hmac.compare_digest(current["incarnation"], incarnation)
        if (current["generation"] if current else "-") != expected:
            return False
        atomic_json(directory / "epoch", {"generation": generation, "incarnation": incarnation})
        pathlib.Path(GRANT_PATH).unlink(missing_ok=True)
        return True


def update_grant(action, identity, expires_at, digest="", generation="", incarnation=""):
    """Conditional updates and revocation tombstones share a stable file lock."""
    if action not in ("grant", "revoke") or not valid_identity(identity) or not valid_expiry(expires_at):
        return False
    with grant_lock() as directory:
        now = time.time() * 1000
        clock_path = directory / "clock"
        try:
            high_water = json.loads(clock_path.read_text())
            if not valid_expiry(high_water):
                return False
        except FileNotFoundError:
            high_water = now
        high_water = max(now, high_water)
        atomic_json(clock_path, high_water)
        tombstone_path = directory / "revoked"
        try:
            tombstones = json.loads(tombstone_path.read_text())
        except FileNotFoundError:
            tombstones = {}
        if not isinstance(tombstones, dict):
            return False
        tombstones = {key: value for key, value in tombstones.items()
                      if valid_expiry(value) and value > now}
        record = read_grant_record()
        if action == "revoke":
            matching = record and record["attachmentId"] == identity
            tombstones[identity] = max(expires_at, tombstones.get(identity, 0),
                                      record["expiresAt"] if matching else 0)
            atomic_json(tombstone_path, tombstones)
            if matching:
                pathlib.Path(GRANT_PATH).unlink(missing_ok=True)
            return True
        if (expires_at <= high_water or expires_at > now + MAX_GRANT_TTL_MS + CLOCK_SKEW_MS
                or identity in tombstones or len(tombstones) >= 4096 or not valid_digest(digest)
                or not valid_identity(generation) or not valid_digest(incarnation)):
            return False
        epoch = read_epoch_locked()
        if not epoch or epoch["generation"] != generation or epoch["incarnation"] != incarnation:
            return False
        current = read_grant_locked()
        if (record and record["attachmentId"] == identity and record["generation"] == generation
                and record["incarnation"] == incarnation):
            return bool(current and record["expiresAt"] == expires_at
                        and hmac.compare_digest(record["ticketDigest"], digest))
        # A consumed grant no longer holds the write slot. Its owner has already
        # attached, so a successor may take over; the tombstone below fences the
        # old attachment from any late command. Without this, a reconnect whose
        # previous connection died holding a "used" grant could never be granted
        # again within the same TTL and stayed read-only.
        if current is not None and current.get("used") is True:
            current = None
        if current:
            return False
        if record and record["expiresAt"] > now and record["attachmentId"] != identity:
            tombstones[record["attachmentId"]] = max(record["expiresAt"], tombstones.get(record["attachmentId"], 0))
        atomic_json(tombstone_path, tombstones)
        atomic_json(pathlib.Path(GRANT_PATH), {"attachmentId": identity,
                    "expiresAt": expires_at, "ticketDigest": digest, "used": False,
                    "generation": generation, "incarnation": incarnation,
                    "deadlineMonotonic": time.monotonic() + min(MAX_GRANT_TTL_MS, expires_at - now) / 1000})
        return True


def consume_grant(identity, ticket):
    if not valid_identity(identity) or not isinstance(ticket, str) or len(ticket) != 43:
        return None
    try:
        raw = base64.b64decode(ticket + "=", altchars=b"-_", validate=True)
    except ValueError:
        return None
    if len(raw) != 32:
        return None
    with grant_lock():
        grant = read_grant_locked()
        if (not grant or grant.get("used") is not False or grant["attachmentId"] != identity
                or not hmac.compare_digest(grant["ticketDigest"], hashlib.sha256(raw).hexdigest())):
            return None
        grant["used"] = True
        atomic_json(pathlib.Path(GRANT_PATH), grant)
        return grant


def grant_active(binding):
    current = read_grant()
    return bool(current and binding and all(current[key] == binding.get(key)
                for key in ("attachmentId", "ticketDigest", "expiresAt", "generation", "incarnation")))


def receive_exact(sock, size, deadline):
    data = bytearray()
    while len(data) < size:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("desktop handshake timed out")
        sock.settimeout(remaining)
        chunk = sock.recv(size - len(data))
        if not chunk:
            raise ConnectionError("desktop handshake closed")
        data += chunk
    return bytes(data)


def authenticate_client(client, deadline):
    line = bytearray()
    while len(line) < 4096:
        byte = receive_exact(client, 1, deadline)
        if byte == b"\n":
            frame = json.loads(line)
            if not isinstance(frame, dict) or frame.get("event") != "desktop/attach" or frame.get("version") != 1:
                return None
            return consume_grant(frame.get("attachmentId"), frame.get("ticket"))
        line += byte
    return None


def relay_handshake(client, upstream, deadline):
    """Relay RFB 3.3/3.7/3.8 None-security negotiation before normal frames."""
    versions = (b"RFB 003.003\n", b"RFB 003.007\n", b"RFB 003.008\n")
    offered = receive_exact(upstream, 12, deadline)
    if offered not in versions:
        raise ValueError("unsupported RFB server version")
    client.sendall(offered)
    chosen = receive_exact(client, 12, deadline)
    if chosen not in versions or chosen > offered:
        raise ValueError("unsupported RFB client version")
    upstream.sendall(chosen)
    if chosen == versions[0]:
        security = receive_exact(upstream, 4, deadline)
        if security != b"\x00\x00\x00\x01":
            raise ValueError("RFB endpoint is not passwordless")
        client.sendall(security)
    else:
        count = receive_exact(upstream, 1, deadline)[0]
        security = receive_exact(upstream, count, deadline)
        if 1 not in security:
            raise ValueError("RFB endpoint does not offer None security")
        client.sendall(b"\x01\x01")
        if receive_exact(client, 1, deadline) != b"\x01":
            raise ValueError("unsupported RFB security selection")
        upstream.sendall(b"\x01")
        if chosen == versions[2]:
            result = receive_exact(upstream, 4, deadline)
            if result != bytes(4):
                raise ValueError("RFB security negotiation failed")
            client.sendall(result)
    shared = receive_exact(client, 1, deadline)
    if shared not in (b"\x00", b"\x01"):
        raise ValueError("invalid RFB ClientInit")
    upstream.sendall(shared)


def release_keys(upstream, held_keys):
    """Best-effort release of every key the client was holding down."""
    for key in sorted(held_keys):
        try:
            upstream.sendall(bytes([KEY_EVENT, 0, 0, 0]) + key.to_bytes(4, "big"))
        except OSError:
            return
    try:
        # Button mask 0 releases every mouse button.
        upstream.sendall(bytes([POINTER_EVENT, 0, 0, 0, 0, 0]))
    except OSError:
        pass


def message_frame(buf, index):
    """Frame the next client message.

    Returns (size, is_input, known).
      - size is None when the message is still incomplete: wait for more bytes.
      - known is False for an unrecognized type: its boundary cannot be derived,
        so the caller must fail closed rather than relay past it.

    Why every non-input type needs a real size: TCP coalesces messages, so a
    single recv can hold e.g. [FramebufferUpdateRequest][KeyEvent]. Relaying the
    remainder after a variable-length control message would smuggle that
    KeyEvent straight through while input is ungranted.
    """
    available = len(buf) - index
    msg_type = buf[index]
    if msg_type == SET_ENCODINGS:
        if available < 4:
            return None, False, True
        count = int.from_bytes(buf[index + 2:index + 4], "big")
        size = 4 + count * 4
    elif msg_type == CLIENT_CUT_TEXT:
        if available < 8:
            return None, True, True
        # RFB ExtendedClipboard 用负 length 标记扩展消息，实际载荷长度是 abs(length)
        # （noVNC lib/rfb.js 的 clientCutText: toUnsigned32bit(-data.length)）。可写端点
        # 没有 -nosel，x11vnc 会主动发能力通告，客户端必然回一条这样的消息；按无符号读
        # 会得到约 4GiB 并被误判为流失序，连接刚协商好就被关闭。
        length = abs(int.from_bytes(buf[index + 4:index + 8], "big", signed=True))
        size = 8 + length
    elif msg_type in FIXED_SIZE:
        size = FIXED_SIZE[msg_type]
    else:
        return None, False, False
    if size > MAX_MESSAGE:
        return None, msg_type in INPUT_TYPES, False
    if available < size:
        return None, msg_type in INPUT_TYPES, True
    return size, msg_type in INPUT_TYPES, True


def drain_input(client_buf, upstream, granted, held_keys):
    """Forward everything, dropping input messages unless granted.

    Returns (remaining_buffer, updated_held_keys, framing_ok).
    framing_ok is False when the stream desynchronized: the caller must close.
    """
    out = bytearray()
    index = 0
    while index < len(client_buf):
        size, is_input, known = message_frame(client_buf, index)
        if not known:
            return bytearray(client_buf[index:]), held_keys, False
        if size is None:
            break
        message = bytes(client_buf[index:index + size])
        msg_type = message[0]
        index += size
        if msg_type == KEY_EVENT:
            down = message[1] != 0
            key = int.from_bytes(message[4:8], "big")
            if down and not granted:
                # Never let a dropped press stay logically held.
                held_keys.discard(key)
                continue
            if down:
                held_keys.add(key)
            else:
                held_keys.discard(key)
        if is_input and not granted:
            continue
        out += message

    if out:
        upstream.sendall(bytes(out))
    return bytearray(client_buf[index:]), held_keys, True


def load_runtime():
    path = "/usr/local/libexec/opencraft/desktop-observer.py"
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0
                or info.st_mode & 0o022 or info.st_size > MAX_BUFFER):
            raise ValueError("unsafe desktop observer")
        spec = importlib.util.spec_from_file_location("opencraft_desktop_observer", path)
        module = importlib.util.module_from_spec(spec)
        exec(compile(source.read(MAX_BUFFER + 1), path, "exec"), module.__dict__)
    return module.Runtime()


def runtime_matches(runtime, binding):
    try:
        return hmac.compare_digest(runtime.identity(), binding["incarnation"])
    except Exception:
        return False


def serve(client):
    upstream = None
    held_keys = set()
    ready = False
    try:
        deadline = time.monotonic() + 10.0
        binding = authenticate_client(client, deadline)
        if not binding:
            return
        try:
            runtime = load_runtime()
        except Exception:
            return
        if not runtime_matches(runtime, binding):
            return
        upstream = socket.create_connection(UPSTREAM_ADDRESS, timeout=CONNECT_TIMEOUT)
        if not runtime_matches(runtime, binding):
            return
        relay_handshake(client, upstream, deadline)
        ready = True
        if not runtime_matches(runtime, binding):
            return
        checked = time.monotonic()
        # sendall must not lose the unsent tail under backpressure. Bound blocking
        # writes so an unresponsive peer cannot indefinitely delay revocation.
        client.settimeout(POLL_SECONDS)
        upstream.settimeout(POLL_SECONDS)
        client_buf = bytearray()
        while grant_active(binding):
            readable, _, errored = select.select([client, upstream], [], [client, upstream], POLL_SECONDS)
            if errored or not grant_active(binding):
                break
            now = time.monotonic()
            if now - checked >= 1:
                if not runtime_matches(runtime, binding):
                    return
                checked = now
            for sock in readable:
                data = sock.recv(65536)
                if not data:
                    return
                if sock is client:
                    client_buf += data
                    if len(client_buf) > MAX_BUFFER or not grant_active(binding):
                        return
                    client_buf, held_keys, framing_ok = drain_input(
                        client_buf, upstream, True, held_keys)
                    if not framing_ok:
                        return
                else:
                    client.sendall(data)
    except (OSError, ValueError):
        return
    finally:
        if upstream is not None and ready:
            release_keys(upstream, held_keys)
        for sock in (client, upstream):
            if sock is not None:
                sock.close()


def main():
    if len(sys.argv) > 1:
        try:
            if sys.argv[1] == "--epoch" and len(sys.argv) == 2:
                with grant_lock():
                    epoch = read_epoch_locked()
                    print(json.dumps({"generation": epoch["generation"] if epoch else ""}))
                return 0
            if sys.argv[1] == "--activate" and len(sys.argv) == 5:
                return 0 if activate_epoch(sys.argv[2], sys.argv[3], sys.argv[4]) else 1
            if sys.argv[1] == "--grant" and len(sys.argv) == 7:
                return 0 if update_grant("grant", sys.argv[2], int(sys.argv[3]), sys.argv[4],
                                        sys.argv[5], sys.argv[6]) else 1
            if sys.argv[1] == "--revoke" and len(sys.argv) == 4:
                return 0 if update_grant("revoke", sys.argv[2], int(sys.argv[3])) else 1
        except (OSError, ValueError):
            return 1
        return 1
    pathlib.Path(GRANT_PATH).parent.mkdir(mode=0o700, exist_ok=True)
    os.chmod(pathlib.Path(GRANT_PATH).parent, 0o700)
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(LISTEN_ADDRESS)
    listener.listen(4)
    while True:
        try:
            client, _ = listener.accept()
        except OSError:
            time.sleep(POLL_SECONDS)
            continue
        serve(client)


if __name__ == "__main__":
    sys.exit(main())
