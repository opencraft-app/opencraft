#!/usr/bin/env python3
"""Serve one short-lived URL that transfers a local session into the browser."""

from __future__ import annotations

import argparse
import http.server
import os
import re
import signal
import stat
import threading
import time
from pathlib import Path
from urllib.parse import quote, urlsplit


class BootstrapState:
    def __init__(self, token: str) -> None:
        self._token = token
        self._lock = threading.Lock()
        self.used = False

    def take(self) -> str:
        with self._lock:
            token = self._token
            self._token = ""
            return token

    def consume(self) -> bool:
        with self._lock:
            if self.used:
                return False
            self.used = True
            self._token = ""
            return True


class ReusableHTTPServer(http.server.ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--listen-host", required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--public-host", required=True)
    parser.add_argument("--frontend-url", required=True)
    parser.add_argument("--nonce", required=True)
    parser.add_argument("--token-file", required=True)
    parser.add_argument("--ready-file", required=True)
    parser.add_argument("--ttl-seconds", type=int, default=120)
    return parser.parse_args()


def read_private_token(path: Path) -> str:
    try:
        mode = stat.S_IMODE(path.stat().st_mode)
        if mode & 0o077:
            raise SystemExit("token file must not be accessible by group or other users")
        token = path.read_text(encoding="utf-8").strip()
    finally:
        path.unlink(missing_ok=True)
    if not token or "\n" in token or "\r" in token:
        raise SystemExit("token file is empty or malformed")
    return token


def validate_args(args: argparse.Namespace) -> None:
    if not re.fullmatch(r"[A-Za-z0-9_-]{24,128}", args.nonce):
        raise SystemExit("nonce must be 24-128 URL-safe characters")
    if not 0 <= args.port <= 65535:
        raise SystemExit("port is outside the valid range")
    if not 10 <= args.ttl_seconds <= 600:
        raise SystemExit("ttl must be between 10 and 600 seconds")
    parsed = urlsplit(args.frontend_url)
    if (
        parsed.scheme not in ("http", "https")
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        raise SystemExit("frontend URL must be an HTTP(S) URL without credentials or fragment")


def write_ready(path: Path, url: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}")
    temporary.write_text(url + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def main() -> None:
    args = parse_args()
    validate_args(args)
    token = read_private_token(Path(args.token_file))
    state = BootstrapState(token)
    nonce_path = f"/{args.nonce}"
    redirect_url = f"{args.frontend_url}#session_token={quote(token, safe='')}"

    class Handler(http.server.BaseHTTPRequestHandler):
        def setup(self) -> None:
            super().setup()
            self.request.settimeout(2)

        def log_message(self, _format: str, *_args: object) -> None:
            return

        def do_GET(self) -> None:  # noqa: N802 - stdlib callback name
            if self.path != nonce_path:
                self.send_response(http.HTTPStatus.NOT_FOUND)
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return
            if not state.consume():
                self.send_response(http.HTTPStatus.GONE)
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return
            self.send_response(http.HTTPStatus.SEE_OTHER)
            self.send_header("Location", redirect_url)
            self.send_header("Cache-Control", "no-store, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Referrer-Policy", "no-referrer")
            self.end_headers()

    server = ReusableHTTPServer((args.listen_host, args.port), Handler)
    server.timeout = 0.25
    stopped = False

    def stop(_signum: int, _frame: object) -> None:
        nonlocal stopped
        stopped = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    public_url = f"http://{args.public_host}:{server.server_port}/{args.nonce}"
    ready_path = Path(args.ready_file)
    write_ready(ready_path, public_url)
    deadline = time.monotonic() + args.ttl_seconds
    try:
        while not stopped and not state.used and time.monotonic() < deadline:
            server.handle_request()
    finally:
        state.take()
        ready_path.unlink(missing_ok=True)
        server.server_close()


if __name__ == "__main__":
    main()
