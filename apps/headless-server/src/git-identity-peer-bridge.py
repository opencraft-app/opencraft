#!/usr/bin/env python3
"""Unix IPC framing and kernel peer identity; the parent owns all vault policy.

stdin/stdout are private anonymous pipes to the parent, never a logging stream.
"""
import asyncio
import json
import os
import socket
import struct
import sys

MAXIMUM = 32768


async def main():
    path = sys.argv[1]
    os.umask(0o077)
    pending = {}
    serial = 0
    stdin = asyncio.StreamReader(limit=MAXIMUM)
    protocol = asyncio.StreamReaderProtocol(stdin)
    await asyncio.get_running_loop().connect_read_pipe(lambda: protocol, sys.stdin.buffer)

    async def responses():
        while line := await stdin.readline():
            value = json.loads(line)
            waiter = pending.pop(value['id'], None)
            if waiter and not waiter.done():
                waiter.set_result(value['response'])
        for waiter in pending.values():
            if not waiter.done():
                waiter.set_result({'status': 'unavailable'})
        server.close()

    async def accept(reader, writer):
        nonlocal serial
        request_id = None
        try:
            if len(pending) >= 64:
                raise ValueError()
            sock = writer.get_extra_info('socket')
            pid, uid, _gid = struct.unpack('3i', sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if uid != os.getuid():
                raise ValueError()
            line = await asyncio.wait_for(reader.readline(), timeout=5)
            if len(line) > MAXIMUM:
                raise ValueError()
            request = json.loads(line)
            serial += 1
            request_id = serial
            future = asyncio.get_running_loop().create_future()
            pending[request_id] = future
            sys.stdout.write(json.dumps({'id': request_id, 'peer': {'pid': pid, 'uid': uid}, 'request': request}) + '\n')
            sys.stdout.flush()
            result = await asyncio.wait_for(future, timeout=10)
            writer.write((json.dumps(result) + '\n').encode())
            await writer.drain()
        except Exception:
            writer.write(b'{"status":"unavailable"}\n')
        finally:
            if request_id is not None:
                pending.pop(request_id, None)
            writer.close()
            await writer.wait_closed()

    # The service owner supplies a fresh private runtime directory. Never unlink an unknown socket.
    server = await asyncio.start_unix_server(accept, path=path, limit=MAXIMUM)
    os.chmod(path, 0o600)
    sys.stdout.write('{"ready":true}\n')
    sys.stdout.flush()
    task = asyncio.create_task(responses())
    async with server:
        try:
            await server.serve_forever()
        except asyncio.CancelledError:
            pass
    task.cancel()


if __name__ == '__main__':
    asyncio.run(main())
