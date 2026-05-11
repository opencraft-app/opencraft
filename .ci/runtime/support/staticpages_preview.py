from __future__ import annotations

import argparse
import mimetypes
import os
import re
import tarfile
import tempfile
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
) -> None:
    with body_path.open("rb") as data:
        request = urllib.request.Request(api_url, data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
                print(response.read().decode("utf-8", errors="replace"))
        except urllib.error.HTTPError as exc:
            error_body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"StaticPages upload failed: http={exc.code} body={error_body}") from exc


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
            _upload_archive(args, token, preview_name, sha, body_path, len(files))
            return 0

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
    upload_body(api_url=args.api_url, body_path=body_path, headers=headers, timeout_seconds=args.timeout_seconds)


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
    upload_body(api_url=args.api_url, body_path=body_path, headers=headers, timeout_seconds=args.timeout_seconds)


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
    return parser.parse_args()


def main() -> int:
    return upload(parse_args())
