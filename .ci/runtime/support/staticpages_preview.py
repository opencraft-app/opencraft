from __future__ import annotations

import argparse
import mimetypes
import os
import re
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from uuid import uuid4


DEFAULT_API_URL = "https://staticpages-api.sandbox.lightclaw.tech/api/upload"
DEFAULT_REPOSITORY = "wisp/mono2"
BRANCH_PREFIX = "frontsandbox/"
DNS_SAFE_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")


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


def upload(args: argparse.Namespace) -> int:
    artifact_dir = Path(args.artifact_dir).resolve()
    if not artifact_dir.is_dir():
        raise ValueError(f"artifact directory does not exist: {artifact_dir}")

    token = args.token or os.environ.get("STATICPAGES_UPLOAD_TOKEN", "")
    if not token or token.startswith("${{"):
        raise ValueError("missing STATICPAGES_UPLOAD_TOKEN")

    preview_name = args.preview_name or normalize_preview_name(args.source_branch)
    sha = args.sha.strip()
    if not sha:
        raise ValueError("missing source sha")

    files = iter_files(artifact_dir)
    boundary = f"----staticpages-{uuid4().hex}"

    with tempfile.NamedTemporaryFile(prefix="staticpages-upload-", suffix=".multipart") as body:
        body_path = Path(body.name)
        write_multipart_body(body_path, artifact_dir, files, boundary)
        body.flush()

        size = body_path.stat().st_size
        print("============================================================")
        print("frontend 预览发布决策：上传静态产物到 StaticPages")
        print(f"源分支：{args.source_branch}")
        print(f"预览名：{preview_name}")
        print(f"目标域名：https://{preview_name}.sandbox.lightclaw.tech")
        print(f"上传文件数：{len(files)}")
        print(f"上传体积：{size} bytes")
        print(f"StaticPages API：{args.api_url}")
        print("============================================================")

        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(size),
            "X-StaticPages-Repository": args.repository,
            "X-StaticPages-Branch": preview_name,
            "X-StaticPages-SHA": sha,
            "X-StaticPages-Environment": preview_name,
        }
        with body_path.open("rb") as data:
            request = urllib.request.Request(args.api_url, data=data, headers=headers, method="POST")
            try:
                with urllib.request.urlopen(request, timeout=args.timeout_seconds) as response:
                    print(response.read().decode("utf-8", errors="replace"))
            except urllib.error.HTTPError as exc:
                error_body = exc.read().decode("utf-8", errors="replace")
                raise RuntimeError(f"StaticPages upload failed: http={exc.code} body={error_body}") from exc
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Upload frontend preview artifacts to StaticPages.")
    parser.add_argument("--artifact-dir", required=True)
    parser.add_argument("--api-url", default=os.environ.get("STATICPAGES_API_URL", DEFAULT_API_URL))
    parser.add_argument("--repository", default=os.environ.get("STATICPAGES_REPOSITORY", DEFAULT_REPOSITORY))
    parser.add_argument("--source-branch", required=True)
    parser.add_argument("--preview-name", default="")
    parser.add_argument("--sha", required=True)
    parser.add_argument("--token", default="")
    parser.add_argument("--timeout-seconds", type=int, default=300)
    return parser.parse_args()


def main() -> int:
    return upload(parse_args())
