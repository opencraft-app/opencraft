"""Input gateway framing tests: proof that default-deny survives coalescing.

The dangerous case is a single recv holding a control message followed by an
input message, e.g. [FramebufferUpdateRequest][KeyEvent]. Relaying the remainder
after a variable-length control frame would smuggle that KeyEvent through while
input is ungranted, so every non-input type must have a real size.
"""
import base64
import ctypes
import ctypes.util
import hashlib
import io
import json
import os
from pathlib import Path
import select
import shutil
import socket
import struct
import subprocess
import tempfile
import threading
import time
import unittest
from unittest import mock

import desktop_input_proxy as proxy


class FakeUpstream:
    def __init__(self):
        self.written = bytearray()

    def sendall(self, data):
        self.written += data


def key_event(down=True, key=0x41):
    return bytes([proxy.KEY_EVENT, 1 if down else 0, 0, 0]) + key.to_bytes(4, "big")


def pointer_event():
    return bytes([proxy.POINTER_EVENT, 1, 0, 100, 0, 200])


def set_pixel_format():
    return bytes([proxy.SET_PIXEL_FORMAT]) + bytes(19)


def framebuffer_update_request():
    return bytes([proxy.FRAMEBUFFER_UPDATE_REQUEST, 0]) + bytes(8)


def set_encodings(count=1):
    return bytes([proxy.SET_ENCODINGS, 0]) + count.to_bytes(2, "big") + bytes(4 * count)


class DrainInputTest(unittest.TestCase):
    def test_coalesced_key_event_after_control_message_is_dropped(self):
        for control in (framebuffer_update_request(), set_pixel_format(), set_encodings()):
            with self.subTest(control=control[0]):
                upstream = FakeUpstream()
                payload = control + key_event()
                _, held, ok = proxy.drain_input(bytearray(payload), upstream, False, set())
                self.assertTrue(ok)
                # Control message passes; the smuggled key press must not.
                self.assertEqual(bytes(upstream.written), control)
                self.assertEqual(held, set())

    def test_coalesced_pointer_event_after_control_message_is_dropped(self):
        upstream = FakeUpstream()
        control = framebuffer_update_request()
        proxy.drain_input(bytearray(control + pointer_event()), upstream, False, set())
        self.assertEqual(bytes(upstream.written), control)

    def test_input_passes_while_granted(self):
        upstream = FakeUpstream()
        payload = framebuffer_update_request() + key_event()
        _, held, ok = proxy.drain_input(bytearray(payload), upstream, True, set())
        self.assertTrue(ok)
        self.assertEqual(bytes(upstream.written), payload)
        self.assertEqual(held, {0x41})

    def test_key_release_removes_from_held(self):
        upstream = FakeUpstream()
        _, held, _ = proxy.drain_input(bytearray(key_event(down=True)), upstream, True, set())
        self.assertEqual(held, {0x41})
        _, held, _ = proxy.drain_input(bytearray(key_event(down=False)), upstream, True, held)
        self.assertEqual(held, set())

    def test_split_message_is_reassembled_not_half_relayed(self):
        upstream = FakeUpstream()
        message = key_event()
        buf = bytearray()
        for index in range(len(message)):
            buf.append(message[index])
            buf, held, ok = proxy.drain_input(buf, upstream, True, set())
            self.assertTrue(ok)
        self.assertEqual(bytes(upstream.written), message)

    def test_unknown_message_type_fails_closed(self):
        upstream = FakeUpstream()
        buf, _, ok = proxy.drain_input(bytearray([0x7F, 0, 0, 0]), upstream, True, set())
        self.assertFalse(ok, "unknown type must not be relayed past")
        self.assertEqual(bytes(upstream.written), b"")

    def test_oversized_cut_text_fails_closed(self):
        upstream = FakeUpstream()
        header = bytes([proxy.CLIENT_CUT_TEXT, 0, 0, 0]) + (proxy.MAX_MESSAGE).to_bytes(4, "big")
        _, _, ok = proxy.drain_input(bytearray(header), upstream, True, set())
        self.assertFalse(ok)

    def test_client_cut_text_is_input(self):
        upstream = FakeUpstream()
        text = b"hello"
        message = bytes([proxy.CLIENT_CUT_TEXT, 0, 0, 0]) + len(text).to_bytes(4, "big") + text
        proxy.drain_input(bytearray(message), upstream, False, set())
        self.assertEqual(bytes(upstream.written), b"")
        proxy.drain_input(bytearray(message), upstream, True, set())
        self.assertEqual(bytes(upstream.written), message)


class GrantLifecycleTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        patch = mock.patch.object(proxy, "GRANT_PATH", str(Path(self.temp.name) / "grant"))
        patch.start()
        self.addCleanup(patch.stop)
        self.a = "00000000-0000-4000-8000-000000000001"
        self.b = "00000000-0000-4000-8000-000000000002"
        self.expiry = int(time.time() * 1000) + 60_000
        self.ticket = base64.urlsafe_b64encode(bytes(range(32))).decode().rstrip("=")
        self.digest = hashlib.sha256(bytes(range(32))).hexdigest()
        self.generation = "00000000-0000-4000-8000-000000000003"
        self.incarnation = "ab" * 32
        self.assertTrue(proxy.activate_epoch(self.generation, "-", self.incarnation))

    def grant(self, identity=None):
        return proxy.update_grant("grant", identity or self.a, self.expiry, self.digest,
                                  self.generation, self.incarnation)

    def test_clock_skew_admission_boundary_and_local_lifetime(self):
        for offset, accepted in ((-30_000, True), (0, True), (30_000, True), (30_001, False)):
            with self.subTest(offset=offset), mock.patch.object(proxy.time, "time", return_value=1000), \
                    mock.patch.object(proxy.time, "monotonic", return_value=500):
                Path(proxy.GRANT_PATH).unlink(missing_ok=True)
                self.expiry = 1_300_000 + offset
                self.assertEqual(self.grant(), accepted)
                if accepted:
                    grant = proxy.read_grant()
                    self.assertEqual(grant["expiresAt"], self.expiry)
                    self.assertEqual(grant.get("deadlineMonotonic"), 500 + min(300, (self.expiry - 1_000_000) / 1000))

    def test_rollback_and_repeated_install_cannot_extend_local_deadline(self):
        with mock.patch.object(proxy.time, "time", return_value=1000), \
                mock.patch.object(proxy.time, "monotonic", return_value=500):
            self.expiry = 1_300_000
            self.assertTrue(self.grant())
        with mock.patch.object(proxy.time, "time", return_value=999), \
                mock.patch.object(proxy.time, "monotonic", return_value=799):
            self.assertTrue(self.grant())
            self.assertIsNotNone(proxy.read_grant())
        with mock.patch.object(proxy.time, "time", return_value=999), \
                mock.patch.object(proxy.time, "monotonic", return_value=800):
            self.assertIsNone(proxy.read_grant())
            self.assertFalse(self.grant(), "expired local deadline must not be reinstalled")

    def test_expired_record_replacement_cannot_reset_first_deadline(self):
        with mock.patch.object(proxy.time, "time", return_value=1000), \
                mock.patch.object(proxy.time, "monotonic", return_value=500) as monotonic:
            self.expiry = 1_300_000
            self.assertTrue(self.grant())
            monotonic.return_value = 800
            self.assertTrue(self.grant(self.b))
            self.assertTrue(proxy.update_grant("revoke", self.b, self.expiry))
            self.assertFalse(self.grant())

    def test_forward_then_rollback_does_not_revive_retired_identity(self):
        with mock.patch.object(proxy.time, "time", return_value=1000) as wall:
            self.expiry = 1_010_000
            self.assertTrue(self.grant())
            self.assertIsNotNone(proxy.consume_grant(self.a, self.ticket))
            wall.return_value = 1020
            self.expiry = 1_080_000
            self.assertTrue(self.grant(self.b))
            self.assertTrue(proxy.update_grant("revoke", self.b, self.expiry))
            wall.return_value = 1000
            self.expiry = 1_010_000
            self.assertFalse(self.grant())

    def test_absolute_expiry_still_applies_before_monotonic_deadline(self):
        with mock.patch.object(proxy.time, "time", return_value=1000), \
                mock.patch.object(proxy.time, "monotonic", return_value=500):
            self.expiry = 1_060_000
            self.assertTrue(self.grant())
        with mock.patch.object(proxy.time, "time", return_value=1060), \
                mock.patch.object(proxy.time, "monotonic", return_value=501):
            self.assertIsNone(proxy.read_grant())

    def test_revoke_accepts_far_future_expiry_and_fences_late_grant(self):
        with mock.patch.object(proxy.time, "time", return_value=1000):
            self.expiry = 1_060_000
            self.assertTrue(self.grant())
            self.assertTrue(proxy.update_grant("revoke", self.a, 2_000_000))
            self.assertIsNone(proxy.read_grant())
            self.assertFalse(self.grant())
            self.assertEqual(json.loads(Path(proxy.GRANT_PATH).with_name("revoked").read_text())[self.a], 2_000_000)

    def test_revoke_preserves_original_expiry_after_local_deadline(self):
        with mock.patch.object(proxy.time, "time", return_value=1000), \
                mock.patch.object(proxy.time, "monotonic", return_value=500):
            self.expiry = 1_300_000
            self.assertTrue(self.grant())
        with mock.patch.object(proxy.time, "time", return_value=1001), \
                mock.patch.object(proxy.time, "monotonic", return_value=800):
            self.assertTrue(proxy.update_grant("revoke", self.a, 1_010_000))
            self.assertEqual(json.loads(Path(proxy.GRANT_PATH).with_name("revoked").read_text())[self.a], self.expiry)
        with mock.patch.object(proxy.time, "time", return_value=1020):
            self.assertFalse(self.grant())

    def test_revoke_rejects_malformed_action_identity_and_expiry(self):
        for action, identity, expiry in (("other", self.a, self.expiry), ("revoke", "bad", self.expiry),
                                         ("revoke", self.a, True), ("revoke", self.a, float("inf")),
                                         ("revoke", self.a, -1), ("revoke", self.a, 0)):
            with self.subTest(action=action, identity=identity, expiry=expiry):
                self.assertFalse(proxy.update_grant(action, identity, expiry))

    def test_old_revoke_cannot_clear_new_grant(self):
        self.assertTrue(self.grant(self.b))
        self.assertTrue(proxy.update_grant("revoke", self.a, self.expiry))
        self.assertEqual(proxy.read_grant()["attachmentId"], self.b)

    def test_revoke_fences_a_command_that_arrives_late(self):
        self.assertTrue(proxy.update_grant("revoke", self.a, self.expiry))
        self.assertFalse(self.grant())
        self.assertIsNone(proxy.read_grant())

    def test_new_grant_does_not_take_over_existing_writer(self):
        self.assertTrue(self.grant())
        self.assertFalse(self.grant(self.b))
        self.assertEqual(proxy.read_grant()["attachmentId"], self.a)

    def test_attach_requires_ticket_and_consumes_it_once(self):
        self.assertTrue(self.grant())
        self.assertIsNone(proxy.consume_grant(self.a, "wrong"))
        self.assertIsNone(proxy.consume_grant(self.b, self.ticket))
        self.assertIsNotNone(proxy.consume_grant(self.a, self.ticket))
        self.assertIsNone(proxy.consume_grant(self.a, self.ticket))
        self.assertTrue(self.grant(), "idempotent grant must preserve consumed state")
        self.assertIsNone(proxy.consume_grant(self.a, self.ticket))

    def test_malformed_or_expired_grant_fails_closed(self):
        for payload in ([], None, {"expiresAt": float("inf")}, {"expiresAt": True}):
            Path(proxy.GRANT_PATH).write_text(json.dumps(payload))
            self.assertIsNone(proxy.read_grant())
        self.assertFalse(proxy.update_grant("grant", self.a, 1, self.digest))

    def test_cli_uses_the_same_conditional_protocol(self):
        with mock.patch.object(proxy.sys, "argv", ["proxy", "--grant", self.a, str(self.expiry), self.digest,
                                                   self.generation, self.incarnation]):
            self.assertEqual(proxy.main(), 0)
        with mock.patch.object(proxy.sys, "argv", ["proxy", "--revoke", self.a, str(self.expiry)]):
            self.assertEqual(proxy.main(), 0)
        with mock.patch.object(proxy.sys, "argv", ["proxy", "--grant", self.a, str(self.expiry), self.digest,
                                                   self.generation, self.incarnation]):
            self.assertEqual(proxy.main(), 1)

    def test_binding_cannot_inherit_another_grant(self):
        self.assertTrue(self.grant())
        binding = proxy.consume_grant(self.a, self.ticket)
        self.assertTrue(proxy.grant_active(binding))
        self.assertTrue(proxy.update_grant("revoke", self.a, self.expiry))
        self.assertTrue(self.grant(self.b))
        self.assertFalse(proxy.grant_active(binding))

    def test_serve_retires_connection_when_runtime_changes(self):
        self.test_serve_completes_handshake_then_releases_and_disconnects_on_revoke(change_runtime=True)

    def test_serve_completes_handshake_then_releases_and_disconnects_on_revoke(self, change_runtime=False):
        self.assertTrue(self.grant())
        client, gateway_client = socket.socketpair()
        upstream, gateway_upstream = socket.socketpair()
        for sock in (client, gateway_client, upstream, gateway_upstream):
            self.addCleanup(sock.close)
        client.settimeout(3)
        upstream.settimeout(3)
        def receive(sock, size):
            data = b""
            while len(data) < size:
                chunk = sock.recv(size - len(data))
                if not chunk:
                    break
                data += chunk
            return data
        runtime = mock.Mock()
        runtime.identity.return_value = self.incarnation
        with mock.patch.object(proxy.socket, "create_connection", return_value=gateway_upstream), \
                mock.patch.object(proxy, "load_runtime", return_value=runtime, create=True):
            worker = threading.Thread(target=proxy.serve, args=(gateway_client,), daemon=True)
            worker.start()
            try:
                attach = {"event": "desktop/attach", "version": 1, "attachmentId": self.a, "ticket": self.ticket}
                client.sendall(json.dumps(attach).encode() + b"\n")
                upstream.sendall(b"RFB 003.008\n")
                self.assertEqual(receive(client, 12), b"RFB 003.008\n")
                client.sendall(b"RFB 003.")
                client.sendall(b"008\n")
                self.assertEqual(receive(upstream, 12), b"RFB 003.008\n")
                upstream.sendall(b"\x01\x01")
                self.assertEqual(receive(client, 2), b"\x01\x01")
                client.sendall(b"\x01")
                self.assertEqual(receive(upstream, 1), b"\x01")
                upstream.sendall(bytes(4))
                self.assertEqual(receive(client, 4), bytes(4))
                client.sendall(b"\x01" + framebuffer_update_request() + key_event())
                self.assertEqual(receive(upstream, 19), b"\x01" + framebuffer_update_request() + key_event())
                upstream.sendall(b"display-data")
                self.assertEqual(receive(client, 12), b"display-data")
                if change_runtime:
                    runtime.identity.return_value = "cd" * 32
                else:
                    self.assertTrue(proxy.update_grant("revoke", self.a, self.expiry))
                self.assertTrue(select.select([upstream], [], [], 2)[0], "input retirement must release held keys")
                released = receive(upstream, 14)
                self.assertEqual(released, key_event(False) + bytes([5, 0, 0, 0, 0, 0]))
                self.assertEqual(client.recv(1), b"")
            finally:
                client.close()
                upstream.close()
                worker.join(4)
                self.assertFalse(worker.is_alive(), "gateway must not retain the old connection")


class RuntimeBindingTest(unittest.TestCase):
    setUp = GrantLifecycleTest.setUp
    grant = GrantLifecycleTest.grant

    def test_runtime_loader_rejects_untrusted_file_before_execution(self):
        path = Path(self.temp.name) / "observer.py"
        path.write_text("raise AssertionError('untrusted code executed')")
        for mode, uid in ((0o100664, 0), (0o100644, 1000), (0o040755, 0)):
            with self.subTest(mode=mode, uid=uid), path.open("rb") as source:
                info = mock.Mock(st_mode=mode, st_uid=uid, st_size=path.stat().st_size)
                with mock.patch.object(proxy.os, "open", return_value=os.dup(source.fileno())) as opened, \
                        mock.patch.object(proxy.os, "fstat", return_value=info):
                    with self.assertRaises(ValueError):
                        proxy.load_runtime()
                self.assertEqual(opened.call_args.args[0], "/usr/local/libexec/opencraft/desktop-observer.py")
                self.assertTrue(opened.call_args.args[1] & os.O_NOFOLLOW)

    def test_runtime_loader_executes_only_verified_descriptor(self):
        path = Path(self.temp.name) / "observer.py"
        path.write_text("class Runtime: pass")
        with path.open("rb") as source:
            info = mock.Mock(st_mode=0o100644, st_uid=0, st_size=path.stat().st_size)
            with mock.patch.object(proxy.os, "open", return_value=os.dup(source.fileno())), \
                    mock.patch.object(proxy.os, "fstat", return_value=info):
                self.assertEqual(type(proxy.load_runtime()).__name__, "Runtime")

    def test_identity_probe_errors_fail_closed(self):
        runtime = mock.Mock()
        for error in (OSError(), ValueError(), RuntimeError()):
            runtime.identity.side_effect = error
            self.assertFalse(proxy.runtime_matches(runtime, {"incarnation": self.incarnation}))

    def test_changed_runtime_fails_before_attach_connect_or_handshake(self):
        for checks in range(3):
            with self.subTest(checks=checks):
                binding = {"incarnation": self.incarnation}
                runtime = mock.Mock()
                runtime.identity.side_effect = [self.incarnation] * checks + ["cd" * 32]
                with mock.patch.object(proxy, "load_runtime", return_value=runtime, create=True), \
                        mock.patch.object(proxy, "authenticate_client", return_value=binding), \
                        mock.patch.object(proxy.socket, "create_connection") as connect, \
                        mock.patch.object(proxy, "relay_handshake") as handshake, \
                        mock.patch.object(proxy, "grant_active", return_value=False):
                    proxy.serve(mock.Mock())
                self.assertEqual(runtime.identity.call_count, checks + 1)
                self.assertEqual(connect.call_count, int(checks > 0))
                self.assertEqual(handshake.call_count, int(checks > 1))

    def test_runtime_failure_closes_client_without_upstream(self):
        with mock.patch.object(proxy, "load_runtime", side_effect=RuntimeError, create=True), \
                mock.patch.object(proxy, "authenticate_client", return_value={"incarnation": self.incarnation}), \
                mock.patch.object(proxy.socket, "create_connection") as connect, \
                mock.patch.object(proxy, "relay_handshake"), \
                mock.patch.object(proxy, "grant_active", return_value=False):
            client = mock.Mock()
            proxy.serve(client)
            connect.assert_not_called()
            client.close.assert_called_once()


class EpochProtocolTest(unittest.TestCase):
    def setUp(self):
        GrantLifecycleTest.setUp(self)
        self.generation = "00000000-0000-4000-8000-000000000003"
        self.next_generation = "00000000-0000-4000-8000-000000000004"
        self.incarnation = "ab" * 32
        self.epoch_path = Path(proxy.GRANT_PATH).with_name("epoch")
        self.epoch_path.unlink(missing_ok=True)

    def cli(self, *args):
        with mock.patch.object(proxy.sys, "argv", ["proxy", *args]), \
                mock.patch.object(proxy.sys, "stdout", new_callable=io.StringIO) as output:
            return proxy.main(), output.getvalue()

    def activate(self, generation=None, expected="-", incarnation=None):
        return self.cli("--activate", generation or self.generation, expected, incarnation or self.incarnation)[0]

    def install(self, generation=None, incarnation=None):
        return self.cli("--grant", self.a, str(self.expiry), self.digest,
                        generation or self.generation, incarnation or self.incarnation)[0]

    def test_epoch_starts_empty_and_activation_is_persistent(self):
        self.assertEqual(self.cli("--epoch"), (0, '{"generation": ""}\n'))
        self.assertEqual(self.activate(), 0)
        self.assertEqual(json.loads(self.cli("--epoch")[1]), {"generation": self.generation})
        self.assertEqual(json.loads(self.epoch_path.read_text()),
                         {"generation": self.generation, "incarnation": self.incarnation})
        self.assertEqual(self.epoch_path.stat().st_mode & 0o777, 0o600)

    def test_activation_is_cas_and_idempotent_only_for_same_incarnation(self):
        self.assertEqual(self.activate(), 0)
        self.assertEqual(self.activate(), 0)
        self.assertEqual(self.activate(expected=self.generation, incarnation="cd" * 32), 1)
        self.assertEqual(self.activate(self.next_generation, self.generation), 0)
        self.assertEqual(self.activate(expected="-"), 1)
        self.assertEqual(self.activate(self.a, self.generation), 1)
        self.assertEqual(json.loads(self.cli("--epoch")[1]), {"generation": self.next_generation})

    def test_grant_requires_matching_epoch_and_rejects_legacy_cli(self):
        self.assertEqual(self.install(), 1)
        self.assertEqual(self.activate(), 0)
        self.assertEqual(self.cli("--grant", self.a, str(self.expiry), self.digest)[0], 1)
        self.assertEqual(self.install(generation=self.next_generation), 1)
        self.assertEqual(self.install(incarnation="cd" * 32), 1)
        self.assertEqual(self.install(), 0)

    def test_epoch_change_invalidates_binding_and_fences_old_commands(self):
        self.assertEqual(self.activate(), 0)
        self.assertEqual(self.install(), 0)
        binding = proxy.consume_grant(self.a, self.ticket)
        self.assertTrue(proxy.grant_active(binding))
        self.assertEqual(self.activate(self.next_generation, self.generation), 0)
        self.assertFalse(proxy.grant_active(binding))
        self.assertFalse(Path(proxy.GRANT_PATH).exists())
        self.assertEqual(self.install(), 1)
        self.assertEqual(self.install(self.next_generation), 0)
        self.assertFalse(proxy.grant_active(binding), "matching identity/ticket/expiry cannot inherit new epoch")
        self.assertIsNotNone(proxy.consume_grant(self.a, self.ticket))

    def test_epoch_is_written_before_old_grant_cleanup(self):
        self.assertEqual(self.activate(), 0)
        self.assertEqual(self.install(), 0)
        binding = proxy.consume_grant(self.a, self.ticket)
        with mock.patch.object(Path, "unlink", side_effect=PermissionError):
            self.assertEqual(self.activate(self.next_generation, self.generation), 1)
        self.assertTrue(Path(proxy.GRANT_PATH).exists())
        self.assertFalse(proxy.grant_active(binding))
        self.assertEqual(self.activate(self.next_generation, self.generation), 0)
        self.assertEqual(self.install(self.next_generation), 0)

    def test_malformed_epoch_denies_read_activation_and_grant(self):
        for payload in ([], None, {}, {"generation": ""},
                        {"generation": self.generation, "incarnation": "invalid"}):
            with self.subTest(payload=payload):
                self.epoch_path.write_text(json.dumps(payload))
                self.epoch_path.chmod(0o600)
                self.assertEqual(self.cli("--epoch")[0], 1)
                self.assertEqual(self.activate(), 1)
                self.assertEqual(self.install(), 1)
                self.assertIsNone(proxy.read_grant())

    def test_epoch_permission_errors_and_symlinks_fail_closed(self):
        self.assertEqual(self.activate(), 0)
        self.assertEqual(self.install(), 0)
        self.epoch_path.chmod(0o644)
        self.assertEqual(self.cli("--epoch")[0], 1)
        self.assertEqual(self.activate(), 1)
        self.assertIsNone(proxy.read_grant())
        self.epoch_path.unlink()
        self.epoch_path.symlink_to(Path(proxy.GRANT_PATH))
        self.assertEqual(self.cli("--epoch")[0], 1)
        self.assertEqual(self.activate(), 1)
        self.assertIsNone(proxy.read_grant())

    def test_binding_compares_generation_and_incarnation(self):
        self.assertEqual(self.activate(), 0)
        self.assertEqual(self.install(), 0)
        binding = proxy.consume_grant(self.a, self.ticket)
        for field, value in (("generation", self.next_generation), ("incarnation", "cd" * 32)):
            with self.subTest(field=field):
                self.assertFalse(proxy.grant_active(dict(binding, **{field: value})))

    def test_invalid_activation_arguments_are_rejected(self):
        for args in (("bad", "-", self.incarnation), (self.generation, "bad", self.incarnation),
                     (self.generation, "-", "invalid"), (self.generation, "-")):
            self.assertEqual(self.cli("--activate", *args)[0], 1)
        self.assertEqual(self.cli("--epoch", "extra")[0], 1)
        self.assertFalse(self.epoch_path.exists())


@unittest.skipUnless(shutil.which("Xvfb") and shutil.which("x11vnc") and ctypes.util.find_library("X11"),
                     "requires Xvfb, x11vnc and libX11")
class RealDesktopTest(GrantLifecycleTest):
    def test_isolated_desktop_framebuffer_input_and_revocation(self):
        def stop(process):
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)
        read_fd, write_fd = os.pipe()
        try:
            xvfb = subprocess.Popen([shutil.which("Xvfb"), "-displayfd", str(write_fd),
                                     "-screen", "0", "64x48x24", "-nolisten", "tcp"],
                                    pass_fds=(write_fd,), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            self.addCleanup(stop, xvfb)
            os.close(write_fd)
            write_fd = -1
            self.assertTrue(select.select([read_fd], [], [], 5)[0], "isolated Xvfb failed to start")
            display_name = b":" + os.read(read_fd, 32).strip()
        finally:
            os.close(read_fd)
            if write_fd != -1:
                os.close(write_fd)
        with socket.socket() as port_socket:
            port_socket.bind(("127.0.0.1", 0))
            port = port_socket.getsockname()[1]
        x11vnc = subprocess.Popen([shutil.which("x11vnc"), "-norc", "-display", display_name.decode(),
                                  "-rfbport", str(port), "-localhost", "-no6", "-nopw", "-forever",
                                  "-nevershared", "-dontdisconnect", "-noremote", "-nocmds", "-novncconnect"],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(stop, x11vnc)
        deadline = time.monotonic() + 5
        while True:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                    break
            except OSError:
                if time.monotonic() >= deadline:
                    self.fail("isolated x11vnc failed to listen")
                time.sleep(0.02)
        lib = ctypes.CDLL(ctypes.util.find_library("X11"))
        lib.XOpenDisplay.argtypes = [ctypes.c_char_p]
        lib.XOpenDisplay.restype = ctypes.c_void_p
        lib.XCloseDisplay.argtypes = [ctypes.c_void_p]
        lib.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        lib.XKeysymToKeycode.restype = ctypes.c_ubyte
        lib.XQueryKeymap.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        lib.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
        lib.XDefaultRootWindow.restype = ctypes.c_ulong
        lib.XQueryPointer.argtypes = [ctypes.c_void_p, ctypes.c_ulong,
                                     ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong),
                                     ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int),
                                     ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int),
                                     ctypes.POINTER(ctypes.c_uint)]
        display = lib.XOpenDisplay(display_name)
        self.assertTrue(display)
        self.addCleanup(lib.XCloseDisplay, display)
        keycode = lib.XKeysymToKeycode(display, 0x61)
        def key_is_down():
            keys = ctypes.create_string_buffer(32)
            lib.XQueryKeymap(display, keys)
            return bool(keys.raw[keycode // 8] & (1 << (keycode % 8)))
        def wait_key(down):
            deadline = time.monotonic() + 3
            while key_is_down() != down:
                if time.monotonic() >= deadline:
                    self.fail("real X11 key state did not become %s" % down)
                time.sleep(0.01)
        def wait_pointer(down, position=None):
            deadline = time.monotonic() + 3
            while True:
                root, child = ctypes.c_ulong(), ctypes.c_ulong()
                x, y, win_x, win_y = (ctypes.c_int() for _ in range(4))
                mask = ctypes.c_uint()
                lib.XQueryPointer(display, lib.XDefaultRootWindow(display), ctypes.byref(root), ctypes.byref(child),
                                  ctypes.byref(x), ctypes.byref(y), ctypes.byref(win_x), ctypes.byref(win_y), ctypes.byref(mask))
                if bool(mask.value & 256) == down and (position is None or (x.value, y.value) == position):
                    return
                if time.monotonic() >= deadline:
                    self.fail("real X11 pointer state did not match requested input")
                time.sleep(0.01)
        import desktop_observer_proxy as observer
        runtime = observer.Runtime.__new__(observer.Runtime)
        runtime.uid = os.getuid()
        runtime.observer, runtime.xvfb = x11vnc.pid, xvfb.pid
        runtime.observer_args, runtime.xvfb_args = x11vnc.args[1:], xvfb.args[1:]
        runtime.observer_invocation = "isolated-input-test"
        runtime.xvfb_invocation = "isolated-xvfb-test"
        runtime.display = display_name.decode()
        self.incarnation = runtime.identity()
        self.assertTrue(proxy.activate_epoch(self.b, self.generation, self.incarnation))
        self.generation = self.b
        self.assertTrue(self.grant())
        client, gateway_client = socket.socketpair()
        self.addCleanup(client.close)
        self.addCleanup(gateway_client.close)
        client.settimeout(5)
        def receive(size):
            data = b""
            while len(data) < size:
                part = client.recv(size - len(data))
                self.assertTrue(part, "RFB connection closed early")
                data += part
            return data
        with mock.patch.object(proxy, "UPSTREAM_ADDRESS", ("127.0.0.1", port)), \
                mock.patch.object(proxy, "load_runtime", return_value=runtime):
            worker = threading.Thread(target=proxy.serve, args=(gateway_client,), daemon=True)
            worker.start()
            try:
                client.sendall(json.dumps({"event": "desktop/attach", "version": 1,
                                         "attachmentId": self.a, "ticket": self.ticket}).encode() + b"\n")
                self.assertEqual(receive(12), b"RFB 003.008\n")
                client.sendall(b"RFB 003.008\n")
                self.assertEqual(receive(2), b"\x01\x01")
                client.sendall(b"\x01")
                self.assertEqual(receive(4), bytes(4))
                client.sendall(b"\x01")
                init = receive(24)
                self.assertEqual(struct.unpack("!HH", init[:4]), (64, 48))
                receive(int.from_bytes(init[20:24], "big"))
                client.sendall(bytes([2, 0, 0, 1]) + bytes(4))
                client.sendall(struct.pack("!BBHHHH", 3, 0, 0, 0, 64, 48))
                update = receive(4)
                self.assertEqual(update[0], 0)
                self.assertGreater(int.from_bytes(update[2:4], "big"), 0)
                for _ in range(int.from_bytes(update[2:4], "big")):
                    rect = receive(12)
                    _, _, width, height, encoding = struct.unpack("!HHHHi", rect)
                    self.assertEqual(encoding, 0)
                    receive(width * height * (init[4] // 8))
                client.sendall(key_event(True, 0x61))
                wait_key(True)
                client.sendall(struct.pack("!BBHH", 5, 1, 20, 15))
                wait_pointer(True, (20, 15))
                self.assertTrue(proxy.update_grant("revoke", self.a, self.expiry))
                wait_key(False)
                wait_pointer(False)
                self.assertEqual(client.recv(1), b"")
            finally:
                client.close()
                worker.join(4)
                self.assertFalse(worker.is_alive())
        self.assertTrue(self.grant(self.b))
        stop(x11vnc)
        replacement = subprocess.Popen(x11vnc.args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(stop, replacement)
        deadline = time.monotonic() + 5
        while True:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                    break
            except OSError:
                if time.monotonic() >= deadline:
                    self.fail("replacement x11vnc failed to listen")
                time.sleep(0.02)
        runtime.observer = replacement.pid
        self.assertNotEqual(runtime.identity(), self.incarnation)
        with mock.patch.object(proxy, "load_runtime", return_value=runtime):
            old_client, old_gateway = socket.socketpair()
            self.addCleanup(old_client.close)
            self.addCleanup(old_gateway.close)
            old_client.settimeout(3)
            old_client.sendall(json.dumps({"event": "desktop/attach", "version": 1,
                                          "attachmentId": self.b, "ticket": self.ticket}).encode() + b"\n")
            with mock.patch.object(proxy.socket, "create_connection") as connect:
                proxy.serve(old_gateway)
                connect.assert_not_called()
            self.assertEqual(old_client.recv(1), b"")


if __name__ == "__main__":
    unittest.main()
