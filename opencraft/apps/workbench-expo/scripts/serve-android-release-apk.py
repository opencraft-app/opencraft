#!/usr/bin/env python3
"""Serve only the local LightVela Android release APK over HTTP."""

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


RELEASE_DIR = Path(__file__).resolve().parents[1] / "release"
APK = RELEASE_DIR / "LightVela-com.tencent.vela-android-release.apk"
DOWNLOAD_PATH = "/LightVela-com.tencent.vela.apk"


class ApkHandler(BaseHTTPRequestHandler):
    def do_HEAD(self):  # noqa: N802 - BaseHTTPRequestHandler API
        self._send_apk(include_body=False)

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler API
        self._send_apk(include_body=True)

    def _send_apk(self, *, include_body: bool):
        if self.path != DOWNLOAD_PATH:
            self.send_error(404)
            return
        if not APK.is_file():
            self.send_error(404, "APK has not been built")
            return

        self.send_response(200)
        self.send_header("Content-Type", "application/vnd.android.package-archive")
        self.send_header("Content-Disposition", f'attachment; filename="{APK.name}"')
        self.send_header("Content-Length", str(APK.stat().st_size))
        self.end_headers()
        if include_body:
            try:
                with APK.open("rb") as source:
                    while chunk := source.read(1024 * 1024):
                        self.wfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--edition", choices=("cn", "intl"), default="cn")
    args = parser.parse_args()
    package = "com.tencent.vela" if args.edition == "cn" else "com.tencent.vela.intl"
    global APK, DOWNLOAD_PATH
    APK = RELEASE_DIR / f"LightVela-{package}-android-release.apk"
    DOWNLOAD_PATH = f"/LightVela-{package}.apk"
    if not APK.is_file():
        parser.error(f"Build the APK first: {APK}")
    server = ThreadingHTTPServer((args.bind, args.port), ApkHandler)
    print(f"Serving {APK.name} on {args.bind}:{args.port}{DOWNLOAD_PATH}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
