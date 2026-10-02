#!/usr/bin/env python3
"""Persistent, local-only Tencent COS protocol double for the code Registry."""

import hashlib
import os
import secrets
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


ROOT = Path(os.environ.get("LOCAL_COS_ROOT", "/data/objects"))
MAX_OBJECT_BYTES = 4 << 20
CRC64_POLYNOMIAL = 0xC96C5795D7870F42
CRC64_MASK = (1 << 64) - 1


def _crc64_table() -> tuple[int, ...]:
    table = []
    for value in range(256):
        crc = value
        for _ in range(8):
            crc = (crc >> 1) ^ CRC64_POLYNOMIAL if crc & 1 else crc >> 1
        table.append(crc & CRC64_MASK)
    return tuple(table)


CRC64_TABLE = _crc64_table()


def _crc64_ecma(data: bytes) -> int:
    crc = CRC64_MASK
    for byte in data:
        crc = CRC64_TABLE[(crc ^ byte) & 0xFF] ^ (crc >> 8)
    return crc ^ CRC64_MASK


def _object_path(request_path: str) -> Path:
    path = urlsplit(request_path).path
    if path in ("", "/"):
        raise ValueError("bucket root is not an object")
    digest = hashlib.sha256(path.encode("utf-8")).hexdigest()
    return ROOT / digest[:2] / digest[2:]


def _send(handler: BaseHTTPRequestHandler, status: int, body: bytes = b"", content_type: str | None = None) -> None:
    handler.send_response(status)
    if content_type:
        handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    if body and handler.command != "HEAD":
        handler.wfile.write(body)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args) -> None:
        return

    def do_HEAD(self) -> None:
        path = urlsplit(self.path).path
        if path in ("", "/"):
            _send(self, 200)
            return
        try:
            object_path = _object_path(self.path)
        except ValueError:
            _send(self, 400)
            return
        if not object_path.is_file():
            _send(self, 404)
            return
        self.send_response(200)
        self.send_header("Content-Length", str(object_path.stat().st_size))
        self.end_headers()

    def do_PUT(self) -> None:
        if self.headers.get("x-cos-forbid-overwrite") != "true":
            _send(self, 400, b"conditional write required")
            return
        try:
            length = int(self.headers.get("Content-Length", "-1"))
            object_path = _object_path(self.path)
        except (ValueError, OverflowError):
            _send(self, 400)
            return
        if length < 0 or length > MAX_OBJECT_BYTES:
            _send(self, 413)
            return
        content = self.rfile.read(length)
        if len(content) != length:
            _send(self, 400)
            return

        object_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = object_path.with_name(f".{object_path.name}.{secrets.token_hex(8)}.tmp")
        try:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                with os.fdopen(descriptor, "wb", closefd=True) as output:
                    output.write(content)
                    output.flush()
                    os.fsync(output.fileno())
                try:
                    os.link(temporary, object_path)
                except FileExistsError:
                    body = b"<Error><Code>FileAlreadyExists</Code></Error>"
                    _send(self, 409, body, "application/xml")
                    return
                directory = os.open(object_path.parent, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
            finally:
                temporary.unlink(missing_ok=True)
        except OSError:
            _send(self, 500)
            return

        self.send_response(200)
        self.send_header("x-cos-hash-crc64ecma", str(_crc64_ecma(content)))
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        if urlsplit(self.path).path == "/__count":
            count = sum(1 for path in ROOT.glob("*/*") if path.is_file()) if ROOT.exists() else 0
            _send(self, 200, str(count).encode("ascii"))
            return
        try:
            object_path = _object_path(self.path)
        except ValueError:
            _send(self, 400)
            return
        try:
            content = object_path.read_bytes()
        except FileNotFoundError:
            _send(self, 404)
            return
        if len(content) > MAX_OBJECT_BYTES:
            _send(self, 500)
            return
        _send(self, 200, content, "application/json")


def main() -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()


if __name__ == "__main__":
    main()
