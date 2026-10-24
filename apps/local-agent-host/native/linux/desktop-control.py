#!/usr/bin/python3
"""Private, single-owner XTest executor. No network, shell, clipboard or target API.

The existing observer remains view-only. A connection holds a three-second
renewable lease on the verified physical desktop; every retirement releases
held keys/buttons and restores temporary Unicode key mappings.
"""
import ctypes as C
import hashlib
import importlib.util
import json
import os
import pathlib
import selectors
import signal
import socket
import stat
import struct
import time


def observer_runtime():
    path = pathlib.Path('/usr/local/libexec/opencraft/desktop-observer.py')
    for parent in [path, *path.parents]:
        info = parent.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
            raise RuntimeError('Untrusted observer installation')
    spec = importlib.util.spec_from_file_location('verified_observer', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.Runtime()


class Input:
    def __init__(self, durable=False):
        self.runtime = observer_runtime()
        self.incarnation = self.runtime.identity()
        # Observation can restart without replacing the X server. Cleanup must
        # still undo OUR injections on that unchanged physical display.
        self.display_incarnation = hashlib.sha256(json.dumps([
            pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
            self.runtime.xvfb, self.runtime.xvfb_invocation], separators=(',', ':')).encode()).hexdigest()
        self.x = C.CDLL('libX11.so.6')
        self.test = C.CDLL('libXtst.so.6')
        self.x.XOpenDisplay.argtypes = [C.c_char_p]
        self.x.XOpenDisplay.restype = C.c_void_p
        self.x.XCloseDisplay.argtypes = [C.c_void_p]
        self.x.XFlush.argtypes = [C.c_void_p]
        self.x.XSync.argtypes = [C.c_void_p, C.c_int]
        self.x.XKeysymToKeycode.argtypes = [C.c_void_p, C.c_ulong]
        self.x.XKeysymToKeycode.restype = C.c_uint
        self.x.XDisplayKeycodes.argtypes = [C.c_void_p, C.POINTER(C.c_int), C.POINTER(C.c_int)]
        self.x.XGetKeyboardMapping.argtypes = [C.c_void_p, C.c_uint, C.c_int, C.POINTER(C.c_int)]
        self.x.XGetKeyboardMapping.restype = C.POINTER(C.c_ulong)
        self.x.XChangeKeyboardMapping.argtypes = [C.c_void_p, C.c_int, C.c_int, C.POINTER(C.c_ulong), C.c_int]
        self.x.XFree.argtypes = [C.c_void_p]
        self.test.XTestQueryExtension.argtypes = [C.c_void_p, *([C.POINTER(C.c_int)] * 4)]
        self.test.XTestFakeKeyEvent.argtypes = [C.c_void_p, C.c_uint, C.c_int, C.c_ulong]
        self.test.XTestFakeButtonEvent.argtypes = [C.c_void_p, C.c_uint, C.c_int, C.c_ulong]
        self.test.XTestFakeMotionEvent.argtypes = [C.c_void_p, C.c_int, C.c_int, C.c_int, C.c_ulong]
        # The verified private binding owns the display and its X authority.
        if hasattr(self.runtime, 'xauthority'):
            os.environ['XAUTHORITY'] = self.runtime.xauthority
        self.display = self.x.XOpenDisplay(getattr(self.runtime, 'display', ':1').encode())
        if not self.display:
            raise RuntimeError('Desktop unavailable')
        query = [C.c_int() for _ in range(4)]
        if not self.test.XTestQueryExtension(self.display, *[C.byref(v) for v in query]):
            raise RuntimeError('Input unavailable')
        if self.runtime.identity() != self.incarnation:
            raise RuntimeError('Desktop changed')
        self.keys = {}
        self.buttons = 0
        self.temporary = {}
        self.journal = pathlib.Path('/run/opencraft-desktop-control/held.json') if durable else None
        if self.journal and self.journal.exists():
            descriptor = os.open(str(self.journal), os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(descriptor, 'rb') as stored:
                metadata = os.fstat(stored.fileno())
                if metadata.st_uid != 0 or metadata.st_mode & 0o077 or not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 65536:
                    raise RuntimeError('Invalid input journal')
                state = json.load(stored)
            if (type(state) is not dict or set(state) not in (
                    {'incarnation', 'keys', 'buttons', 'temporary'},
                    {'incarnation', 'displayIncarnation', 'keys', 'buttons', 'temporary'})
                    or type(state['keys']) is not dict or len(state['keys']) > 64
                    or type(state['temporary']) is not dict or len(state['temporary']) > 64
                    or type(state['buttons']) is not int or not 0 <= state['buttons'] <= 255
                    or any(type(code) is not int or not 8 <= code <= 255 for code in state['keys'].values())
                    or any(not code.isdigit() or not 8 <= int(code) <= 255 or type(row) is not list
                           or not 1 <= len(row) <= 32 or any(type(v) is not int or not 0 <= v <= 0xffffffff for v in row)
                           for code, row in state['temporary'].items())):
                raise RuntimeError('Invalid input journal')
            if state.get('displayIncarnation', state['incarnation']) == (
                    self.display_incarnation if 'displayIncarnation' in state else self.incarnation):
                self.keys = {int(symbol): code for symbol, code in state['keys'].items()}
                self.buttons = state['buttons']
                self.temporary = {int(code): row for code, row in state['temporary'].items()}
                self.release()
            else:
                self.persist()

    def persist(self):
        if self.journal is None:
            return
        temporary = str(self.journal) + '.new'
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'w') as stored:
            json.dump({'incarnation': self.incarnation, 'displayIncarnation': self.display_incarnation, 'keys': self.keys,
                       'buttons': self.buttons, 'temporary': self.temporary}, stored, separators=(',', ':'))
            stored.flush()
        os.replace(temporary, self.journal)

    def valid(self, incarnation):
        return incarnation == self.incarnation and self.runtime.identity() == self.incarnation

    def keycode(self, symbol):
        code = self.x.XKeysymToKeycode(self.display, symbol)
        if code:
            return code
        if not (0x01000000 <= symbol <= 0x0110ffff):
            raise ValueError('Unsupported key')
        low, high, width = C.c_int(), C.c_int(), C.c_int()
        self.x.XDisplayKeycodes(self.display, C.byref(low), C.byref(high))
        mapping = self.x.XGetKeyboardMapping(self.display, low.value, high.value - low.value + 1, C.byref(width))
        try:
            for candidate in range(high.value, low.value - 1, -1):
                row = [mapping[(candidate - low.value) * width.value + i] for i in range(width.value)]
                if not any(row) and candidate not in self.temporary:
                    self.temporary[candidate] = row
                    self.persist() # Original mapping is recoverable even after executor crash.
                    values = (C.c_ulong * width.value)(symbol, *([0] * (width.value - 1)))
                    self.x.XChangeKeyboardMapping(self.display, candidate, width.value, values, 1)
                    self.x.XSync(self.display, 0)
                    return candidate
        finally:
            self.x.XFree(mapping)
        raise ValueError('No available key mapping')

    def restore(self, code):
        row = self.temporary.pop(code, None)
        if row is not None:
            self.x.XChangeKeyboardMapping(self.display, code, len(row), (C.c_ulong * len(row))(*row), 1)

    def key(self, symbol, down):
        if type(symbol) is not int or not 0 < symbol <= 0xffffffff or type(down) is not bool:
            raise ValueError('Invalid key')
        if down:
            if len(self.keys) >= 64 and symbol not in self.keys:
                raise ValueError('Too many held keys')
            code = self.keys.get(symbol) or self.keycode(symbol)
            self.keys[symbol] = code
            self.persist() # Journal BEFORE injection; recovery may harmlessly release an unsent key.
        else:
            code = self.keys.pop(symbol, None)
            if code is None:
                return
        self.test.XTestFakeKeyEvent(self.display, code, int(down), 0)
        if not down:
            self.restore(code)
        self.x.XFlush(self.display)
        if not down:
            self.x.XSync(self.display, 0)
            self.persist()

    def pointer(self, x, y, mask):
        if any(type(v) is not int for v in (x, y, mask)) or not (0 <= x < 1440 and 0 <= y < 900 and 0 <= mask <= 255):
            raise ValueError('Invalid pointer')
        changed = mask != self.buttons
        previous = self.buttons
        self.buttons = previous | mask # Retain pending releases until X server acknowledgement.
        if changed:
            self.persist()
        self.test.XTestFakeMotionEvent(self.display, -1, x, y, 0)
        for bit in range(8):
            if (mask ^ previous) & (1 << bit):
                self.test.XTestFakeButtonEvent(self.display, bit + 1, int(bool(mask & (1 << bit))), 0)
        self.buttons = mask
        self.x.XFlush(self.display)
        if changed:
            self.x.XSync(self.display, 0)
            self.persist()

    def release(self):
        for code in self.keys.values():
            self.test.XTestFakeKeyEvent(self.display, code, 0, 0)
        self.keys.clear()
        for bit in range(8):
            if self.buttons & (1 << bit):
                self.test.XTestFakeButtonEvent(self.display, bit + 1, 0, 0)
        self.buttons = 0
        for code in list(self.temporary):
            self.restore(code)
        self.x.XSync(self.display, 0)
        self.persist()


def main():
    if os.geteuid() != 0:
        raise RuntimeError('Private backend only')
    directory = pathlib.Path('/run/opencraft-desktop-control')
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise RuntimeError('Private runtime required')
    executor = Input(durable=True)
    selector = selectors.DefaultSelector()
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    endpoint = directory / 'control.sock'
    if endpoint.exists():
        metadata = endpoint.lstat()
        if not stat.S_ISSOCK(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o077:
            raise RuntimeError('Invalid private endpoint')
        # systemd owns the sole executor; a live endpoint is never replaced.
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
            try:
                probe.connect(str(endpoint))
            except ConnectionRefusedError:
                endpoint.unlink()
            else:
                raise RuntimeError('Executor already running')
    listener.bind(str(endpoint))
    os.chmod(directory / 'control.sock', 0o600)
    listener.listen(32)
    listener.setblocking(False)
    selector.register(listener, selectors.EVENT_READ)
    clients, owner, deadline = {}, None, 0
    def stop(_signum, _frame):
        raise SystemExit()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    def retire(client):
        nonlocal owner
        if owner is client:
            executor.release()
            owner = None
        selector.unregister(client)
        clients.pop(client, None)
        client.close()

    try:
        while True:
            if owner is not None and time.monotonic() >= deadline:
                retire(owner)
            for event, _ in selector.select(0.1):
                client = event.fileobj
                if client is listener:
                    connection, _ = listener.accept()
                    _, uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                    if uid != 0 or len(clients) >= 32:
                        connection.close()
                        continue
                    connection.setblocking(False)
                    clients[connection] = [bytearray(), time.monotonic() + 3]
                    selector.register(connection, selectors.EVENT_READ)
                    continue
                try:
                    data = client.recv(4096)
                    state = clients[client]
                    if not data or len(state[0]) + len(data) > 65536:
                        raise ValueError('Retired')
                    state[0].extend(data)
                    while b'\n' in state[0]:
                        raw, _, rest = state[0].partition(b'\n')
                        state[0] = bytearray(rest)
                        if len(raw) > 1024:
                            raise ValueError('Invalid command')
                        message = json.loads(raw)
                        if type(message) is not dict or type(message.get('id')) is not int:
                            raise ValueError('Invalid command')
                        op = message.get('op')
                        fields = {'probe': {'id', 'op'}, 'acquire': {'id', 'op', 'incarnation'},
                                  'renew': {'id', 'op'}, 'release': {'id', 'op'},
                                  'key': {'id', 'op', 'symbol', 'down'}, 'pointer': {'id', 'op', 'x', 'y', 'mask'}}
                        if op not in fields or set(message) != fields[op]:
                            raise ValueError('Invalid command')
                        if op == 'probe':
                            if owner is client or not executor.valid(executor.incarnation):
                                raise ValueError('Unavailable')
                        elif op == 'acquire':
                            if owner is not None or not executor.valid(message['incarnation']):
                                raise ValueError('Unavailable')
                            owner = client
                            deadline = time.monotonic() + 3
                        else:
                            if owner is not client or time.monotonic() >= deadline:
                                raise ValueError('No grant')
                            if op == 'renew':
                                if not executor.valid(executor.incarnation):
                                    raise ValueError('Desktop changed')
                                deadline = time.monotonic() + 3
                            elif op == 'release':
                                executor.release()
                                owner = None
                            elif op == 'key':
                                executor.key(message['symbol'], message['down'])
                            elif op == 'pointer':
                                executor.pointer(message['x'], message['y'], message['mask'])
                        reply = {'id': message['id'], 'ok': True}
                        if op in ('probe', 'acquire'):
                            reply.update(protocol='opencraft-desktop-control', version=1, incarnation=executor.incarnation)
                        # A stalled backend is retired, not given an unbounded output queue.
                        encoded = json.dumps(reply, separators=(',', ':')).encode() + b'\n'
                        if client.send(encoded) != len(encoded):
                            raise ValueError('Stalled')
                        state[1] = time.monotonic() + 3
                except (OSError, ValueError, KeyError, TypeError, RuntimeError):
                    retire(client)
            for client, state in list(clients.items()):
                if client is not owner and time.monotonic() >= state[1]:
                    retire(client)
    finally:
        executor.release()
        for client in list(clients):
            retire(client)
        listener.close()
        executor.x.XCloseDisplay(executor.display)


if __name__ == '__main__':
    main()
