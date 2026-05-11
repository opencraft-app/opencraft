from __future__ import annotations

import argparse
import mimetypes
import os
import re
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from uuid import uuid4


DEFAULT_PREVIEW_DOMAIN = "preview.lightclaw.tech"
DEFAULT_API_URL = f"https://staticpages-api.{DEFAULT_PREVIEW_DOMAIN}/api/upload"
DEFAULT_REPOSITORY = "wisp/mono2"
BRANCH_PREFIX = "frontsandbox/"
DNS_SAFE_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
INTL_PREVIEW_PREFIX = "intl-"
ARCHIVE_MEDIA_TYPE = "application/vnd.lightvela.staticpages.archive.v1.tar+gzip"
PROGRESS_MIN_INTERVAL_SECONDS = 2.0
PROGRESS_MIN_INTERVAL_BYTES = 8 * 1024 * 1024


class UploadTransportError(RuntimeError):
    pass


def format_bytes(value: int) -> str:
    if value < 1024:
        return f"{value} B"
    if value < 1024 * 1024:
        return f"{value / 1024:.1f} KiB"
    if value < 1024 * 1024 * 1024:
        return f"{value / 1024 / 1024:.1f} MiB"
    return f"{value / 1024 / 1024 / 1024:.1f} GiB"


class UploadProgressReader:
    def __init__(
        self,
        raw,
        *,
        total_bytes: int,
        enabled: bool,
        label: str,
        output=sys.stdout,
        now=time.monotonic,
    ) -> None:
        self.raw = raw
        self.total_bytes = total_bytes
        self.enabled = enabled and total_bytes > 0
        self.label = label
        self.output = output
        self.now = now
        self.uploaded_bytes = 0
        self.last_report_time = 0.0
        self.last_report_bytes = 0
        self.started = False
        self.finished = False

    def read(self, size: int = -1) -> bytes:
        chunk = self.raw.read(size)
        if chunk:
            self.uploaded_bytes += len(chunk)
            self.report(force=False)
        else:
            self.finish()
        return chunk

    def __len__(self) -> int:
        return self.total_bytes

    def __getattr__(self, name: str):
        return getattr(self.raw, name)

    def report(self, *, force: bool) -> None:
        if not self.enabled:
            return
        current_time = self.now()
        if not self.started:
            self.started = True
            self.last_report_time = current_time
            self.last_report_bytes = self.uploaded_bytes
            self.write_progress()
            return

        if not force:
            elapsed = current_time - self.last_report_time
            advanced = self.uploaded_bytes - self.last_report_bytes
            if elapsed < PROGRESS_MIN_INTERVAL_SECONDS and advanced < PROGRESS_MIN_INTERVAL_BYTES:
                return

        self.last_report_time = current_time
        self.last_report_bytes = self.uploaded_bytes
        self.write_progress()

    def finish(self) -> None:
        if self.finished:
            return
        self.finished = True
        if self.enabled:
            self.uploaded_bytes = max(self.uploaded_bytes, self.total_bytes)
            if not self.started or self.last_report_bytes < self.total_bytes:
                self.report(force=True)

    def write_progress(self) -> None:
        percent = min(100.0, (self.uploaded_bytes / self.total_bytes) * 100)
        prefix = f"{self.label} " if self.label else ""
        print(
            f"{prefix}上传进度：{percent:5.1f}% "
            f"({format_bytes(self.uploaded_bytes)} / {format_bytes(self.total_bytes)})",
            file=self.output,
            flush=True,
        )


def normalize_preview_name(source_branch: str) -> str:
    branch = source_branch.strip()
    if branch.startswith(BRANCH_PREFIX):
        branch = branch[len(BRANCH_PREFIX) :]
    branch = branch.lower()
    branch = re.sub(r"[^a-z0-9-]+", "-", branch)
    branch = re.sub(r"-+", "-", branch).strip("-")
    if not branch:
        raise ValueError(f"cannot derive preview name from branch {source_branch!r}")
    if len(branch) > 63:
        branch = branch[:63].rstrip("-")
    if not DNS_SAFE_RE.fullmatch(branch):
        raise ValueError(f"preview name is not DNS-safe: {branch!r}")
    return branch


def preview_name_for_variant(source_branch: str, variant: str) -> str:
    base = normalize_preview_name(source_branch)
    if base.startswith(INTL_PREVIEW_PREFIX):
        base = base[len(INTL_PREVIEW_PREFIX) :]
    if not base:
        raise ValueError(f"cannot derive preview name from branch {source_branch!r}")

    if variant == "cn":
        preview_name = base
    elif variant == "intl":
        preview_name = f"{INTL_PREVIEW_PREFIX}{base}"
    else:
        raise ValueError(f"unsupported preview variant: {variant!r}")

    if len(preview_name) > 63:
        preview_name = preview_name[:63].rstrip("-")
    if not DNS_SAFE_RE.fullmatch(preview_name):
        raise ValueError(f"preview name is not DNS-safe: {preview_name!r}")
    return preview_name


def staticpages_sha_for_variant(source_sha: str, variant: str) -> str:
    sha = source_sha.strip()
    if not sha:
        raise ValueError("missing source sha")
    if variant == "cn":
        return sha
    if variant == "intl":
        return f"{sha}-intl"
    raise ValueError(f"unsupported preview variant: {variant!r}")


def iter_files(artifact_dir: Path) -> list[Path]:
    files = [path for path in artifact_dir.rglob("*") if path.is_file()]
    if not files:
        raise ValueError(f"artifact directory is empty: {artifact_dir}")
    return sorted(files)


def write_multipart_body(body_path: Path, artifact_dir: Path, files: list[Path], boundary: str) -> None:
    with body_path.open("wb") as out:
        for path in files:
            rel = path.relative_to(artifact_dir).as_posix()
            content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            out.write(f"--{boundary}\r\n".encode())
            out.write(
                (
                    f'Content-Disposition: form-data; name="files[{rel}]"; '
                    f'filename="{path.name}"\r\n'
                ).encode()
            )
            out.write(f"Content-Type: {content_type}\r\n\r\n".encode())
            with path.open("rb") as f:
                while chunk := f.read(1024 * 1024):
                    out.write(chunk)
            out.write(b"\r\n")
        out.write(f"--{boundary}--\r\n".encode())


def write_tar_gzip_archive(archive_path: Path, artifact_dir: Path, files: list[Path]) -> None:
    with tarfile.open(archive_path, "w:gz") as archive:
        for path in files:
            rel = path.relative_to(artifact_dir).as_posix()
            archive.add(path, arcname=rel, recursive=False)


def upload_body(
    *,
    api_url: str,
    body_path: Path,
    headers: dict[str, str],
    timeout_seconds: int,
    progress: bool,
    progress_label: str,
) -> None:
    size = body_path.stat().st_size
    with body_path.open("rb") as raw:
        data = UploadProgressReader(raw, total_bytes=size, enabled=progress, label=progress_label)
        request = urllib.request.Request(api_url, data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
                data.finish()
                print(response.read().decode("utf-8", errors="replace"))
        except urllib.error.HTTPError as exc:
            data.finish()
            error_body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"StaticPages upload failed: http={exc.code} body={error_body}") from exc
        except (urllib.error.URLError, OSError) as exc:
            data.finish()
            raise UploadTransportError(f"StaticPages upload transport failed: {exc}") from exc


def upload(args: argparse.Namespace) -> int:
    token = args.token or os.environ.get("STATICPAGES_UPLOAD_TOKEN", "")
    if not token or token.startswith("${{"):
        raise ValueError("missing STATICPAGES_UPLOAD_TOKEN")

    preview_name = args.preview_name or preview_name_for_variant(args.source_branch, args.variant)
    sha = staticpages_sha_for_variant(args.sha, args.variant)

    artifact_dir = Path(args.artifact_dir).resolve() if args.artifact_dir else None
    archive_file = Path(args.archive_file).resolve() if args.archive_file else None

    if archive_file is None:
        if artifact_dir is None or not artifact_dir.is_dir():
            raise ValueError(f"artifact directory does not exist: {artifact_dir}")
        files = iter_files(artifact_dir)
    else:
        if not archive_file.is_file():
            raise ValueError(f"archive file does not exist: {archive_file}")
        files = []

    upload_mode = args.upload_mode
    if archive_file is not None:
        upload_mode = "archive"

    if upload_mode == "archive":
        if archive_file is not None:
            _upload_archive(args, token, preview_name, sha, archive_file, 0)
            return 0

        with tempfile.NamedTemporaryFile(prefix="staticpages-upload-", suffix=".tar.gz") as body:
            body_path = Path(body.name)
            write_tar_gzip_archive(body_path, artifact_dir, files)
            body.flush()
            try:
                _upload_archive(args, token, preview_name, sha, body_path, len(files))
                return 0
            except UploadTransportError as exc:
                print(f"StaticPages tar.gz 上传出现连接级错误，自动回退 multipart：{exc}", file=sys.stderr)

    boundary = f"----staticpages-{uuid4().hex}"
    with tempfile.NamedTemporaryFile(prefix="staticpages-upload-", suffix=".multipart") as body:
        body_path = Path(body.name)
        write_multipart_body(body_path, artifact_dir, files, boundary)
        body.flush()
        _upload_multipart(args, token, preview_name, sha, body_path, boundary, len(files))
    return 0


def _common_headers(args: argparse.Namespace, token: str, preview_name: str, sha: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "X-StaticPages-Repository": args.repository,
        "X-StaticPages-Branch": preview_name,
        "X-StaticPages-SHA": sha,
        "X-StaticPages-Environment": preview_name,
    }


def _print_upload_decision(
    args: argparse.Namespace,
    *,
    preview_name: str,
    sha: str,
    mode: str,
    file_count: int,
    size: int,
) -> None:
    print("============================================================")
    print("frontend 预览发布决策：上传静态产物到 StaticPages")
    print(f"源分支：{args.source_branch}")
    print(f"源 revision：{args.sha.strip()}")
    print(f"StaticPages revision：{sha}")
    print(f"产物版本：{args.variant}")
    print(f"预览名：{preview_name}")
    print(f"目标域名：https://{preview_name}.{DEFAULT_PREVIEW_DOMAIN}")
    print(f"上传模式：{mode}")
    if file_count:
        print(f"上传文件数：{file_count}")
    print(f"上传体积：{size} bytes")
    print(f"StaticPages API：{args.api_url}")
    print("============================================================")


def _upload_archive(
    args: argparse.Namespace,
    token: str,
    preview_name: str,
    sha: str,
    body_path: Path,
    file_count: int,
) -> None:
    size = body_path.stat().st_size
    _print_upload_decision(args, preview_name=preview_name, sha=sha, mode="tar.gz", file_count=file_count, size=size)
    headers = _common_headers(args, token, preview_name, sha)
    headers.update(
        {
            "Content-Type": ARCHIVE_MEDIA_TYPE,
            "Content-Length": str(size),
            "X-StaticPages-Upload-Format": "tar.gz",
        }
    )
    upload_body(
        api_url=args.api_url,
        body_path=body_path,
        headers=headers,
        timeout_seconds=args.timeout_seconds,
        progress=not args.no_progress,
        progress_label=f"{args.variant}/tar.gz",
    )


def _upload_multipart(
    args: argparse.Namespace,
    token: str,
    preview_name: str,
    sha: str,
    body_path: Path,
    boundary: str,
    file_count: int,
) -> None:
    size = body_path.stat().st_size
    _print_upload_decision(args, preview_name=preview_name, sha=sha, mode="multipart", file_count=file_count, size=size)
    headers = _common_headers(args, token, preview_name, sha)
    headers.update(
        {
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(size),
        }
    )
    upload_body(
        api_url=args.api_url,
        body_path=body_path,
        headers=headers,
        timeout_seconds=args.timeout_seconds,
        progress=not args.no_progress,
        progress_label=f"{args.variant}/multipart",
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Upload frontend preview artifacts to StaticPages.")
    parser.add_argument("--artifact-dir")
    parser.add_argument("--archive-file", default="", help="Upload an existing .tar.gz archive instead of building one from --artifact-dir.")
    parser.add_argument("--upload-mode", choices=("archive", "multipart"), default=os.environ.get("STATICPAGES_UPLOAD_MODE", "archive"))
    parser.add_argument("--api-url", default=os.environ.get("STATICPAGES_API_URL", DEFAULT_API_URL))
    parser.add_argument("--repository", default=os.environ.get("STATICPAGES_REPOSITORY", DEFAULT_REPOSITORY))
    parser.add_argument("--source-branch", required=True)
    parser.add_argument("--preview-name", default="")
    parser.add_argument("--variant", choices=("cn", "intl"), default="cn")
    parser.add_argument("--sha", required=True)
    parser.add_argument("--token", default="")
    parser.add_argument("--timeout-seconds", type=int, default=300)
    parser.add_argument("--no-progress", action="store_true", help="Disable upload progress logs.")
    return parser.parse_args()


def main() -> int:
    return upload(parse_args())
