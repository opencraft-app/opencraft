#!/usr/bin/env python3
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_objects: dict[str, bytes] = {}
_lock = threading.Lock()


def _crc64_ecma(data: bytes) -> int:
    polynomial = 0xC96C5795D7870F42
    mask = (1 << 64) - 1
    crc = mask
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = ((crc >> 1) ^ polynomial if crc & 1 else crc >> 1) & mask
    return crc ^ mask


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        return

    def do_HEAD(self):
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_PUT(self):
        length = int(self.headers.get("Content-Length", "0"))
        content = self.rfile.read(length)
        with _lock:
            if self.path in _objects:
                body = b"<Error><Code>FileAlreadyExists</Code></Error>"
                self.send_response(409)
                self.send_header("Content-Type", "application/xml")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if self.headers.get("x-cos-forbid-overwrite") != "true":
                body = b"conditional write required"
                self.send_response(400)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            _objects[self.path] = content
        self.send_response(200)
        self.send_header("x-cos-hash-crc64ecma", str(_crc64_ecma(content)))
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if self.path == "/__count":
            with _lock:
                content = str(len(_objects)).encode()
        else:
            with _lock:
                content = _objects.get(self.path)
            if content is None:
                self.send_response(404)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
        self.send_response(200)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)


ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
