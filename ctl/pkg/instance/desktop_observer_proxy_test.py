"""Opt-in Linux native proof test; no systemd, sudo, installed units or real X.

Only systemd's PID discovery is substituted. Processes, /proc ownership, socket
tuples, X11 peer credentials, identity signing and stream forwarding are real.
"""
import hashlib
import hmac
import json
import os
import pwd
import socket
import subprocess
import select
import sys
import threading
import time
import unittest

import desktop_observer_proxy as proxy


class ObserverNativeTest(unittest.TestCase):
    def setUp(self):
        self.processes = []
        self.closers = []
        self.addCleanup(self.cleanup)
        self.uid = os.getuid()
        self.launch_identity = {}
        if self.uid == 0:
            # Exercise the production root-verifier / non-root-desktop split
            # without creating users or touching agentuser/system units.
            account = pwd.getpwnam("nobody")
            self.uid = account.pw_uid
            self.launch_identity = {"user": account.pw_uid, "group": account.pw_gid, "extra_groups": []}
        read, write = os.pipe()
        args = ["-displayfd", str(write), "-screen", "0", "128x96x24", "-nolisten", "tcp", "-ac"]
        self.xvfb = subprocess.Popen(["/usr/bin/Xvfb"] + args, pass_fds=(write,),
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **self.launch_identity)
        self.processes.append(self.xvfb)
        os.close(write)
        with os.fdopen(read) as source:
            self.display = ":" + source.readline().strip()
        if not self.display[1:].isdigit():
            self.fail("isolated display unavailable")
        self.xvfb_args = args
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            self.port = reservation.getsockname()[1]
        self.args = ["-norc", "-display", self.display, "-rfbport", str(self.port),
                     "-localhost", "-no6", "-nopw", "-viewonly", "-nosel", "-noremote",
                     "-nocmds", "-novncconnect", "-forever", "-shared", "-noxdamage",
                     "-wait", "20", "-defer", "20"]
        self.vnc = subprocess.Popen(["/usr/bin/x11vnc"] + self.args,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **self.launch_identity)
        self.processes.append(self.vnc)
        deadline = time.monotonic() + 5
        while True:
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=0.1):
                    break
            except OSError:
                if self.vnc.poll() is not None or time.monotonic() > deadline:
                    self.fail("isolated observer unavailable")
                time.sleep(0.01)
        self.runtime = proxy.Runtime.__new__(proxy.Runtime)
        self.runtime.uid = self.uid
        self.runtime.observer = self.vnc.pid
        self.runtime.xvfb = self.xvfb.pid
        self.runtime.observer_invocation = "test-observer-unit"
        self.runtime.xvfb_invocation = "test-xvfb-unit"
        self.runtime.observer_args = self.args
        self.runtime.xvfb_args = self.xvfb_args
        self.runtime.display = self.display
        self.runtime.port = self.port
        self.key = bytes(range(32)) # Synthetic test material, never a machine key.

    def cleanup(self):
        for close in self.closers:
            close()
        for process in reversed(self.processes):
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)

    def viewer(self, request=None):
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        client = socket.create_connection(listener.getsockname(), timeout=5)
        server, _ = listener.accept()
        listener.close()
        thread = threading.Thread(target=proxy.serve_viewer, args=(server, self.runtime, self.key), daemon=True)
        thread.start()
        self.closers.append(client.close)
        nonce = "1" * 64
        client.sendall(json.dumps(request or {"nonce": nonce}).encode() + b"\n")
        return client, thread, nonce

    def test_connection_identity_and_ordered_rfb(self):
        identity = self.runtime.identity()
        observed, upstream = self.runtime.connect()
        self.assertEqual(observed, identity)
        upstream.close()
        client, thread, nonce = self.viewer()
        source = client.makefile("rb")
        self.closers.append(source.close)
        header = json.loads(source.readline(512))
        self.assertEqual(header["incarnation"], identity)
        self.assertIs(header["readOnly"], True)
        message = ("opencraft-desktop-observer/v1\0" + nonce + "\0" + identity).encode()
        self.assertTrue(hmac.compare_digest(header["mac"], hmac.new(self.key, message, hashlib.sha256).hexdigest()))
        self.assertEqual(source.read(12), b"RFB 003.008\n")
        client.sendall(b"RFB 003.008\n")
        self.assertEqual(source.read(2), b"\x01\x01")
        client.sendall(b"\x01")
        self.assertEqual(source.read(4), b"\x00" * 4)
        client.sendall(b"\x01")
        init = source.read(24)
        self.assertEqual(init[:4], b"\x00\x80\x00\x60")
        name_size = int.from_bytes(init[20:], "big")
        self.assertLess(name_size, 4096)
        source.read(name_size)
        # Input attempts traverse this proxy; native viewonly/nosel is the gate.
        client.sendall(b"\x04\x01\x00\x00\x00\x00\x00a" + b"\x05\x01\x00\x01\x00\x01")
        self.vnc.terminate()
        self.vnc.wait(timeout=3)
        self.assertEqual(source.read(1), b"")
        thread.join(timeout=3)
        self.assertFalse(thread.is_alive())

    def test_changed_runtime_retires_connected_viewer(self):
        client, thread, _ = self.viewer()
        source = client.makefile("rb")
        self.closers.append(source.close)
        json.loads(source.readline(512))
        source.read(12)
        self.runtime.observer_invocation = "replacement"
        self.assertEqual(source.read(1), b"")
        thread.join(timeout=3)
        self.assertFalse(thread.is_alive())

    def test_connected_socket_cannot_belong_to_another_process(self):
        with socket.socket() as other:
            other.bind(("127.0.0.1", 0))
            other.listen(1)
            upstream = socket.create_connection(other.getsockname())
            accepted, _ = other.accept()
            try:
                if self.uid != os.getuid():
                    with self.assertRaises(proxy.Unavailable):
                        proxy.owns_connected_socket(self.vnc.pid, self.uid, upstream)
                else:
                    self.assertFalse(proxy.owns_connected_socket(self.vnc.pid, self.uid, upstream))
            finally:
                accepted.close()
                upstream.close()

    def test_policy_mismatch_sends_no_identity_or_media(self):
        self.vnc.terminate()
        self.vnc.wait(timeout=3)
        unsafe_args = [a for a in self.args if a != "-viewonly"]
        unsafe = subprocess.Popen(["/usr/bin/x11vnc"] + unsafe_args,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **self.launch_identity)
        self.processes.append(unsafe)
        self.runtime.observer = unsafe.pid
        # Keep the production policy: the actual unsafe process must fail it.
        deadline = time.monotonic() + 3
        while True:
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=0.1):
                    break
            except OSError:
                if unsafe.poll() is not None or time.monotonic() > deadline:
                    self.fail("negative control unavailable")
                time.sleep(0.01)
        client, thread, _ = self.viewer()
        self.assertEqual(client.recv(1), b"")
        thread.join(timeout=3)
        self.assertFalse(thread.is_alive())

    def test_nonce_is_not_a_target_or_command(self):
        for request in [{"nonce": "1" * 64, "port": 5900}, {"nonce": "not-a-nonce"}]:
            client, thread, _ = self.viewer(request)
            self.assertEqual(client.recv(1), b"")
            thread.join(timeout=3)
            self.assertFalse(thread.is_alive())


if __name__ == "__main__":
    if sys.argv[1:] == ["--bridge"]:
        # Cross-service native acceptance. Only the systemd PID lookup is
        # substituted; the actual production Python verifier serves real RFB.
        fixture = ObserverNativeTest()
        try:
            fixture.setUp()
            with socket.socket() as listener:
                listener.bind(("127.0.0.1", 0))
                listener.listen(4)
                print(json.dumps({"port": listener.getsockname()[1]}), flush=True)
                while True:
                    readable, _, _ = select.select([listener, sys.stdin], [], [])
                    if sys.stdin in readable and not sys.stdin.buffer.read(1):
                        break
                    if listener in readable:
                        client, _ = listener.accept()
                        fixture.closers.append(client.close)
                        threading.Thread(target=proxy.serve_viewer,
                                         args=(client, fixture.runtime, fixture.key), daemon=True).start()
        finally:
            fixture.doCleanups()
    else:
        unittest.main()
