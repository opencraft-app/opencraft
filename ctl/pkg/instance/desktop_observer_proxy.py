#!/usr/bin/python3
"""Backend-only, immutable observation. Not an authorization or input executor.

The root-owned service checks the *accepted* upstream connection's process,
not just a listening port. Only a bounded identity header precedes raw RFB;
no client command, configurable target or protocol input parser is exposed.
"""
import hashlib
import hmac
import json
import os
import pathlib
import pwd
import select
import socket
import stat
import struct
import subprocess
import threading
import time


OBSERVER_ARGS = ["-norc", "-display", ":1", "-rfbport", "5901", "-localhost",
                 "-no6", "-nopw", "-viewonly", "-nosel", "-noremote", "-nocmds",
                 "-novncconnect", "-forever", "-shared", "-noxdamage", "-wait", "20",
                 "-defer", "20"]
XVFB_ARGS = [":1", "-screen", "0", "1440x900x24", "-nolisten", "tcp"]


class Unavailable(Exception):
    pass


def unit_process(unit):
    result = subprocess.run(["/usr/bin/systemctl", "show", unit, "--no-pager",
                             "--property=MainPID,InvocationID,ActiveState"],
                            check=True, capture_output=True, timeout=1)
    if len(result.stdout) > 2048:
        raise Unavailable()
    fields = dict(line.split("=", 1) for line in result.stdout.decode().splitlines())
    invocation = fields.get("InvocationID", "")
    if fields.get("ActiveState") != "active" or len(invocation) != 32:
        raise Unavailable()
    int(invocation, 16)
    pid = int(fields["MainPID"])
    if pid <= 0:
        raise Unavailable()
    return pid, invocation


def process(pid, uid, executable, args):
    root = pathlib.Path("/proc") / str(pid)
    target = pathlib.Path(executable).resolve(strict=True)
    metadata = target.stat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o022:
        raise Unavailable()
    raw = (root / "cmdline").read_bytes()
    if len(raw) > 8192 or raw.split(b"\0")[:-1] != [s.encode() for s in [executable] + args]:
        raise Unavailable()
    if root.stat().st_uid != uid or (root / "exe").resolve(strict=True) != target:
        raise Unavailable()
    status = (root / "stat").read_text()
    fields = status[status.rindex(")") + 2:].split()
    if fields[0] == "Z":
        raise Unavailable()
    return [pid, fields[19], metadata.st_dev, metadata.st_ino]


def tcp_endpoint(address):
    host, port = address
    return socket.inet_aton(host)[::-1].hex().upper() + ":" + format(port, "04X")


def owns_connected_socket(pid, uid, upstream):
    # The server-side tuple is the inverse of our established client socket.
    local, remote = tcp_endpoint(upstream.getpeername()), tcp_endpoint(upstream.getsockname())
    inode = None
    with open("/proc/net/tcp", encoding="ascii") as rows:
        for line in rows:
            fields = line.split()
            if len(fields) >= 10 and fields[1:4] == [local, remote, "01"]:
                # A completed TCP handshake can still be queued for accept.
                # Until an inode exists there is no owning process to verify.
                if fields[9] == "0":
                    return False
                if int(fields[7]) != uid:
                    raise Unavailable()
                inode = fields[9]
                break
    if inode is None:
        return False
    for fd in (pathlib.Path("/proc") / str(pid) / "fd").iterdir():
        try:
            if os.readlink(fd) == "socket:[" + inode + "]":
                return True
        except FileNotFoundError:
            continue
    return False


class Runtime:
    def __init__(self):
        self.uid = pwd.getpwnam("agentuser").pw_uid
        if self.uid == 0:
            raise Unavailable()
        self.observer, self.observer_invocation = unit_process("vela-desktop-observer.service")
        self.xvfb, self.xvfb_invocation = unit_process("vela-xvfb.service")
        self.observer_args = OBSERVER_ARGS
        self.xvfb_args = XVFB_ARGS
        self.display = ":1"
        self.port = 5901

    def identity(self):
        observer = process(self.observer, self.uid, "/usr/bin/x11vnc", self.observer_args)
        xvfb = process(self.xvfb, self.uid, "/usr/bin/Xvfb", self.xvfb_args)
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as x:
            x.settimeout(1)
            x.connect("/tmp/.X11-unix/X" + self.display[1:])
            peer = struct.unpack("3i", x.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if peer[0] != self.xvfb or peer[1] != self.uid:
                raise Unavailable()
        boot = pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        # Boot + process start ticks + systemd invocation, never CTL job epoch.
        value = [boot, observer, self.observer_invocation, xvfb, self.xvfb_invocation]
        return hashlib.sha256(json.dumps(value, separators=(",", ":")).encode()).hexdigest()

    def connect(self):
        identity = self.identity()
        upstream = socket.create_connection(("127.0.0.1", self.port), timeout=3)
        try:
            deadline = time.monotonic() + 3
            while not owns_connected_socket(self.observer, self.uid, upstream):
                if time.monotonic() >= deadline:
                    raise Unavailable()
                time.sleep(0.01)
            if self.identity() != identity:
                raise Unavailable()
            return identity, upstream
        except Exception:
            upstream.close()
            raise


def serve_viewer(client, runtime, key):
    upstream = None
    try:
        client.settimeout(3)
        challenge = bytearray()
        challenge_deadline = time.monotonic() + 3
        while len(challenge) <= 256:
            remaining = challenge_deadline - time.monotonic()
            if remaining <= 0:
                raise Unavailable()
            client.settimeout(remaining)
            byte = client.recv(1)
            if byte == b"\n":
                break
            if not byte:
                raise Unavailable()
            challenge.extend(byte)
        else:
            raise Unavailable()
        request = json.loads(challenge)
        if not isinstance(request, dict) or set(request) != {"nonce"}:
            raise Unavailable()
        nonce = request["nonce"]
        if not isinstance(nonce, str) or len(nonce) != 64 or any(c not in "0123456789abcdef" for c in nonce):
            raise Unavailable()
        identity, upstream = runtime.connect()
        client.settimeout(3)
        message = ("opencraft-desktop-observer/v1\0" + nonce + "\0" + identity).encode()
        header = {"protocol": "opencraft-desktop-observer", "version": 1,
                  "readOnly": True, "incarnation": identity, "nonce": nonce,
                  "mac": hmac.new(key, message, hashlib.sha256).hexdigest()}
        client.sendall(json.dumps(header, separators=(",", ":")).encode() + b"\n")
        client.setblocking(False)
        upstream.setblocking(False)
        pending = {client: bytearray(), upstream: bytearray()}
        peers = {client: upstream, upstream: client}
        checked = time.monotonic()
        progressed = checked
        while True:
            now = time.monotonic()
            if now - checked >= 1:
                if runtime.identity() != identity:
                    return
                checked = now
            # Bounded buffers, no dropped RFB bytes; stalled peers retire.
            if any(pending.values()) and now - progressed >= 30:
                return
            reads = [s for s in peers if len(pending[peers[s]]) < 65536]
            writes = [s for s in peers if pending[s]]
            readable, writable, errors = select.select(reads, writes, list(peers), 0.25)
            if errors:
                return
            for source in readable:
                try:
                    data = source.recv(65536 - len(pending[peers[source]]))
                except BlockingIOError:
                    continue
                if not data:
                    return
                pending[peers[source]].extend(data)
                progressed = time.monotonic()
            for target in writable:
                try:
                    count = target.send(pending[target])
                except BlockingIOError:
                    continue
                if not count:
                    return
                del pending[target][:count]
                progressed = time.monotonic()
    except (Unavailable, OSError, ValueError, subprocess.SubprocessError):
        # Never log payloads or command output. Failure sends no identity/media.
        pass
    finally:
        if upstream is not None:
            upstream.close()
        client.close()


def main():
    if os.geteuid() != 0:
        raise Unavailable()
    # There are deliberately no environment/argv target or privilege overrides.
    slots = threading.BoundedSemaphore(32)
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", 5902))
        listener.listen(32)
        # systemd creates this root-only RuntimeDirectory. An unprivileged
        # replacement of 5902 cannot forge a fresh challenge response.
        directory = pathlib.Path("/run/opencraft-desktop-observer")
        metadata = directory.lstat()
        if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o077:
            raise Unavailable()
        key = os.urandom(32)
        fd = os.open(str(directory / "key"), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as output:
            output.write(key)
        def handle(client):
            try:
                serve_viewer(client, Runtime(), key)
            except (Unavailable, OSError, ValueError, KeyError, subprocess.SubprocessError):
                client.close()
            finally:
                slots.release()
        while True:
            client, _ = listener.accept()
            if not slots.acquire(blocking=False):
                client.close()
                continue
            threading.Thread(target=handle, args=(client,), daemon=True).start()


if __name__ == "__main__":
    main()
