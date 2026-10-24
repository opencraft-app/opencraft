#!/usr/bin/env python3
"""Fail-closed release validation and the secure-release kit v1 npm adapter.

Definition:
  Validate immutable Git release identity, extract committed changelog notes,
  create/verify a canonical SHA-256 manifest, and package/publish/smoke one npm
  package. CI copies this file into the target repository; it never loads a
  agent skill at runtime.

Parameters:
  Run ``secure_release.py <command> --help`` for command-specific parameters.

Outputs:
  Commands write only explicitly requested notes, artifacts, or manifests.
  Success summaries go to stdout; actionable failures go to stderr with exit 1.

Examples:
  python3 secure_release.py source --tag v1.2.3 --version 1.2.3 --primary-ref origin/main
  python3 secure_release.py manifest-verify --manifest release/manifest.json --directory release
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import Request, urlopen
from pathlib import Path
from typing import Any, Sequence


STABLE_TAG = re.compile(r"^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
MANIFEST_SCHEMA = "https://mason-skills.example/secure-release/manifest/v1"


class ReleaseError(RuntimeError):
    """Expected invalid input or release-state error."""


def run(command: Sequence[str], *, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command,
            cwd=cwd,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError as exc:
        raise ReleaseError(f"could not execute {command[0]}: {exc}") from exc


def checked(command: Sequence[str], *, cwd: Path | None = None) -> str:
    result = run(command, cwd=cwd)
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip()
        raise ReleaseError(f"command failed ({' '.join(command)}): {detail}")
    return result.stdout.strip()


def parse_tag(tag: str) -> str:
    match = STABLE_TAG.fullmatch(tag)
    if match is None:
        raise ReleaseError(f"tag must be a stable vX.Y.Z value: {tag}")
    return tag[1:]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def regular_file(path: Path) -> None:
    try:
        mode = path.lstat().st_mode
    except OSError as exc:
        raise ReleaseError(f"cannot inspect artifact {path}: {exc}") from exc
    if not stat.S_ISREG(mode):
        raise ReleaseError(f"artifact must be a regular file, not a symlink or directory: {path}")


def source(args: argparse.Namespace) -> None:
    expected = parse_tag(args.tag)
    if args.version != expected:
        raise ReleaseError(f"declared version {args.version} does not match tag {args.tag}")
    tag_commit = checked(("git", "rev-parse", "--verify", f"refs/tags/{args.tag}^{{commit}}"))
    primary_commit = checked(("git", "rev-parse", "--verify", f"{args.primary_ref}^{{commit}}"))
    ancestry = run(("git", "merge-base", "--is-ancestor", tag_commit, primary_commit))
    if ancestry.returncode != 0:
        raise ReleaseError(f"tag commit {tag_commit} is not reachable from {args.primary_ref}")
    head_commit = checked(("git", "rev-parse", "HEAD^{commit}"))
    if head_commit != tag_commit:
        raise ReleaseError(f"HEAD {head_commit} is not the exact tag commit {tag_commit}")
    print(f"source ok: tag={args.tag} version={args.version} commit={tag_commit}")


def changelog(args: argparse.Namespace) -> None:
    parse_tag(args.tag)
    content = args.changelog.read_text(encoding="utf-8")
    if not content.startswith("# Changelog\n"):
        raise ReleaseError("changelog must start with '# Changelog'")
    marker = f"## {args.tag}\n"
    start = content.find(marker)
    if start < 0 or (start > 0 and content[start - 1] != "\n"):
        raise ReleaseError(f"changelog has no exact section for {args.tag}")
    end = content.find("\n## ", start + len(marker))
    notes = content[start:] if end < 0 else content[start : end + 1]
    if not notes.strip().splitlines()[1:]:
        raise ReleaseError(f"changelog section for {args.tag} is empty")
    args.notes.parent.mkdir(parents=True, exist_ok=True)
    args.notes.write_text(notes.rstrip() + "\n", encoding="utf-8")
    print(f"changelog ok: tag={args.tag} notes={args.notes}")


def build_manifest(tag: str, version: str, artifacts: Sequence[Path], output: Path) -> None:
    parse_tag(tag)
    if version != tag[1:]:
        raise ReleaseError(f"manifest version {version} does not match tag {tag}")
    if not artifacts:
        raise ReleaseError("at least one artifact is required")
    names: set[str] = set()
    records: list[dict[str, Any]] = []
    for artifact in artifacts:
        regular_file(artifact)
        if artifact.name in names or artifact.name == output.name:
            raise ReleaseError(f"duplicate or reserved artifact filename: {artifact.name}")
        names.add(artifact.name)
        records.append(
            {"name": artifact.name, "sha256": sha256(artifact), "size": artifact.stat().st_size}
        )
    commit = checked(("git", "rev-parse", "HEAD^{commit}"))
    payload = {
        "schema": MANIFEST_SCHEMA,
        "tag": tag,
        "version": version,
        "commit": commit,
        "artifacts": sorted(records, key=lambda item: item["name"]),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"manifest created: path={output} artifacts={len(records)} commit={commit}")


def manifest_create(args: argparse.Namespace) -> None:
    build_manifest(args.tag, args.version, args.artifact, args.output)


def load_manifest(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ReleaseError(f"cannot read valid manifest {path}: {exc}") from exc
    if not isinstance(value, dict) or value.get("schema") != MANIFEST_SCHEMA:
        raise ReleaseError("manifest has an unknown schema")
    return value


def manifest_verify(args: argparse.Namespace) -> None:
    manifest = load_manifest(args.manifest)
    tag = manifest.get("tag")
    version = manifest.get("version")
    commit = manifest.get("commit")
    records = manifest.get("artifacts")
    if not isinstance(tag, str) or not isinstance(version, str) or version != parse_tag(tag):
        raise ReleaseError("manifest tag and version are invalid or inconsistent")
    if args.tag is not None and tag != args.tag:
        raise ReleaseError(f"manifest tag {tag} does not match expected {args.tag}")
    if args.version is not None and version != args.version:
        raise ReleaseError(f"manifest version {version} does not match expected {args.version}")
    if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40,64}", commit):
        raise ReleaseError("manifest commit is invalid")
    if checked(("git", "rev-parse", "HEAD^{commit}")) != commit:
        raise ReleaseError("manifest commit does not match checked-out HEAD")
    if not isinstance(records, list) or not records:
        raise ReleaseError("manifest artifacts must be a non-empty array")
    expected: set[str] = set()
    for record in records:
        if not isinstance(record, dict):
            raise ReleaseError("manifest contains an invalid artifact record")
        name, digest, size = record.get("name"), record.get("sha256"), record.get("size")
        if (
            not isinstance(name, str)
            or Path(name).name != name
            or name in expected
            or not isinstance(digest, str)
            or SHA256.fullmatch(digest) is None
            or not isinstance(size, int)
            or size < 0
        ):
            raise ReleaseError("manifest contains an unsafe or invalid artifact record")
        expected.add(name)
        artifact = args.directory / name
        regular_file(artifact)
        if artifact.stat().st_size != size or sha256(artifact) != digest:
            raise ReleaseError(f"artifact size or SHA-256 mismatch: {name}")
    actual = {
        path.name
        for path in args.directory.iterdir()
        if path.name != args.manifest.name
    }
    if actual != expected:
        raise ReleaseError(f"artifact set mismatch: expected={sorted(expected)} actual={sorted(actual)}")
    print(f"manifest verified: tag={tag} artifacts={len(expected)} commit={commit}")


def read_package(package_dir: Path) -> tuple[str, str]:
    try:
        value = json.loads((package_dir / "package.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ReleaseError(f"cannot read package.json: {exc}") from exc
    if not isinstance(value, dict):
        raise ReleaseError("package.json must contain a JSON object")
    name, version = value.get("name"), value.get("version")
    if not isinstance(name, str) or not name or not isinstance(version, str) or not version:
        raise ReleaseError("package.json must contain non-empty name and version")
    return name, version


def npm_pack_record(payload: Any, *, context: str) -> dict[str, Any]:
    if isinstance(payload, list):
        records = payload
    elif isinstance(payload, dict):
        records = list(payload.values())
    else:
        records = []
    if len(records) != 1 or not isinstance(records[0], dict):
        raise ReleaseError(f"{context} must produce exactly one package")
    return records[0]


def npm_pack(args: argparse.Namespace) -> None:
    _, version = read_package(args.package_dir)
    if version != parse_tag(args.tag):
        raise ReleaseError(f"package version {version} does not match tag {args.tag}")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="secure-release-pack-") as temporary:
        result = run(
            (args.npm, "pack", "--json", "--pack-destination", temporary), cwd=args.package_dir
        )
        if result.returncode != 0:
            raise ReleaseError(f"npm pack failed: {result.stderr.strip() or result.stdout.strip()}")
        try:
            payload = json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            raise ReleaseError("npm pack did not return valid JSON") from exc
        filename = npm_pack_record(payload, context="npm pack").get("filename")
        if not isinstance(filename, str) or Path(filename).name != filename:
            raise ReleaseError("npm pack returned an unsafe filename")
        source_path = Path(temporary) / filename
        regular_file(source_path)
        destination = args.output_dir / filename
        if destination.exists():
            raise ReleaseError(f"refusing to overwrite existing artifact: {destination}")
        shutil.move(source_path, destination)
    build_manifest(args.tag, version, (destination,), args.manifest)
    print(f"npm pack ok: artifact={destination}")


def npm_absent(args: argparse.Namespace) -> None:
    result = run((args.npm, "view", f"{args.package}@{args.version}", "version", "--registry", args.registry))
    if result.returncode == 0:
        raise ReleaseError(f"npm version already exists: {args.package}@{args.version}")
    combined = f"{result.stdout}\n{result.stderr}"
    if re.search(r"^npm (?:ERR!|error) code E404\s*$", combined, re.MULTILINE) is None:
        raise ReleaseError("npm lookup failed without a recognized E404; absence is unproven")
    print(f"npm registry absence verified: {args.package}@{args.version}")


def npm_existing(args: argparse.Namespace) -> None:
    regular_file(args.artifact)
    exact = f"{args.package}@{args.version}"
    with tempfile.TemporaryDirectory(prefix="secure-release-existing-") as temporary:
        result = run(
            (
                args.npm,
                "pack",
                exact,
                "--json",
                "--ignore-scripts",
                "--pack-destination",
                temporary,
                "--registry",
                args.registry,
            )
        )
        if result.returncode != 0:
            raise ReleaseError(
                "cannot download the existing npm version for byte comparison: "
                f"{result.stderr.strip() or result.stdout.strip()}"
            )
        try:
            payload = json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            raise ReleaseError("npm pack for the existing version did not return valid JSON") from exc
        filename = npm_pack_record(
            payload, context="existing npm version resolution"
        ).get("filename")
        if not isinstance(filename, str) or Path(filename).name != filename:
            raise ReleaseError("existing npm version returned an unsafe filename")
        downloaded = Path(temporary) / filename
        regular_file(downloaded)
        if downloaded.stat().st_size != args.artifact.stat().st_size or sha256(downloaded) != sha256(args.artifact):
            raise ReleaseError(f"existing npm bytes differ from intended artifact: {exact}")
    print(f"npm existing version reconciled: {exact} bytes=identical")


def npm_publish(args: argparse.Namespace) -> None:
    regular_file(args.artifact)
    command = [
        args.npm,
        "publish",
        str(args.artifact),
        "--access",
        args.access,
        "--tag",
        args.dist_tag,
        "--provenance" if args.provenance == "true" else "--provenance=false",
        "--registry",
        args.registry,
    ]
    checked(command)
    print(f"npm publish completed: artifact={args.artifact} registry={args.registry}")


def npm_version_metadata(args: argparse.Namespace) -> str | None:
    """Read a public registry's exact-version API without its cached packument.

    This opt-in path sends no npm credentials. The default npm CLI lookup
    remains available for authenticated or nonstandard registries.
    """
    url = f"{args.registry.rstrip('/')}/{quote(args.package, safe='@')}/{quote(args.version, safe='')}"
    request = Request(url, headers={"Accept": "application/json", "Cache-Control": "no-cache"})
    try:
        with urlopen(request, timeout=15) as response:
            print(f"npm version API: status={response.status} cache={response.headers.get('CF-Cache-Status', 'unspecified')} age={response.headers.get('Age', 'unspecified')}", flush=True)
            metadata = json.load(response)
    except HTTPError as exc:
        status = exc.code
        exc.close()
        print(f"npm version API: status={status}", flush=True)
        if status == 404:
            return None
        raise ReleaseError(f"npm version API lookup failed: HTTP {status}") from exc
    except (URLError, OSError, ValueError) as exc:
        raise ReleaseError(f"npm version API lookup failed: {exc}") from exc
    if not isinstance(metadata, dict) or metadata.get('name') != args.package or metadata.get('version') != args.version:
        raise ReleaseError("npm version API returned a different package or version")
    return metadata['version']


def npm_smoke(args: argparse.Namespace) -> None:
    exact = f"{args.package}@{args.version}"
    if args.metadata_retries < 0 or not math.isfinite(args.metadata_retry_delay) or args.metadata_retry_delay < 0:
        raise ReleaseError("metadata retry settings must be finite and nonnegative")
    started = time.monotonic()
    for attempt in range(args.metadata_retries + 1):
        if args.metadata_source == 'version-api':
            observed = npm_version_metadata(args)
            detail = "npm version API returned HTTP 404"
        else:
            result = run((args.npm, "view", exact, "version", "--registry", args.registry,
                          "--prefer-online", "--fetch-retries=0", "--fetch-timeout=15000"))
            observed = result.stdout.strip() if result.returncode == 0 else None
            detail = result.stderr.strip() or result.stdout.strip()
            if result.returncode and re.search(r"^npm (?:ERR!|error) code E404\s*$", detail, re.MULTILINE) is None:
                raise ReleaseError(f"npm metadata lookup failed for {exact}: {detail}")
        if observed is not None:
            break
        # Registry writes can precede public metadata propagation. Retry only
        # recognized absence; credentials, network and malformed replies fail.
        if attempt == args.metadata_retries:
            raise ReleaseError(f"npm metadata lookup failed for {exact}: {detail}")
        print(f"npm metadata not visible yet: {exact}; retry {attempt + 1}/{args.metadata_retries}", flush=True)
        time.sleep(args.metadata_retry_delay)
    if observed.strip().strip('"') != args.version:
        raise ReleaseError(f"registry returned version {observed!r}, expected {args.version}")
    print(f"npm metadata verified: {exact} elapsed={time.monotonic() - started:.1f}s", flush=True)
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="secure-release-smoke-") as temporary:
        consumer = Path(temporary)
        checked((args.npm, "init", "--yes"), cwd=consumer)
        for attempt in range(args.metadata_retries + 1):
            result = run((args.npm, "install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-online", exact, "--registry", args.registry), cwd=consumer)
            if result.returncode == 0:
                break
            detail = result.stderr.strip() or result.stdout.strip()
            # The install CLI performs its own metadata lookup. Only an
            # absent *requested* version may be retried after API confirmation.
            missing = (re.search(r"^npm (?:ERR!|error) code ETARGET\s*$", detail, re.MULTILINE)
                       and f"No matching version found for {exact}." in detail)
            if args.metadata_source != 'version-api' or not missing or attempt == args.metadata_retries:
                raise ReleaseError(f"npm clean install failed for {exact}: {detail}")
            print(f"npm install metadata not visible yet: {exact}; retry {attempt + 1}/{args.metadata_retries}", flush=True)
            time.sleep(args.metadata_retry_delay)
        package_json = consumer / "node_modules" / Path(*args.package.split("/")) / "package.json"
        name, installed = read_package(package_json.parent)
        if name != args.package or installed != args.version:
            raise ReleaseError(f"installed package {name}@{installed} does not match {exact}")
    print(f"npm smoke ok: installed={exact} elapsed={time.monotonic() - started:.1f}s")


OIDC_CLAIM_ALLOWLIST = (
    "iss", "aud", "repository", "repository_id", "repository_owner_id",
    "job_workflow_ref", "ref", "environment", "sub",
)
JWT_SHAPE = re.compile(r"^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]*$")
JWTISH_SPAN = re.compile(r"[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_.-]*)?")


def _redact_secrets_text(text: str) -> str:
    """Drop credential shapes from any printed string. JWTs first, then bearer forms."""
    redacted = JWTISH_SPAN.sub("[redacted]", text)
    redacted = redacted.replace("Bearer ", "Bearer [redacted] ")
    return redacted


def _decode_checked_id_token(id_token: str) -> dict[str, Any]:
    if not JWT_SHAPE.fullmatch(id_token) or id_token.count(".") != 2:
        raise ReleaseError("GitHub OIDC mint did not return a JWT-shaped id token")
    payload = id_token.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    try:
        claims = json.loads(base64.urlsafe_b64decode(payload))
    except (ValueError, json.JSONDecodeError) as exc:
        raise ReleaseError("GitHub OIDC payload did not decode") from exc
    if not isinstance(claims, dict):
        raise ReleaseError("GitHub OIDC payload did not decode to an object")
    return claims


def _mint_github_id_token(registry: str, npm_version: str) -> str:
    request_url = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_URL")
    request_token = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN")
    if not request_url or not request_token:
        raise ReleaseError("OIDC probe requires ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN")
    audience = f"npm:{urlsplit(registry).hostname}"
    mint_url = request_url + ("&" if "?" in request_url else "?") + "audience=" + quote(audience, safe="")
    mint_request = Request(mint_url, headers={
        "Accept": "application/json",
        "Authorization": f"Bearer {request_token}",
        "User-Agent": f"npm/{npm_version} node/v{platform.python_version()} {sys.platform} x64 workspaces/false ci/github-actions",
    })
    try:
        with urlopen(mint_request, timeout=15) as response:
            mint_body = json.load(response)
    except HTTPError as exc:
        raise ReleaseError(f"GitHub OIDC mint failed: HTTP {exc.code}") from exc
    except (URLError, OSError) as exc:
        raise ReleaseError(f"GitHub OIDC mint unreachable: {exc}") from exc
    id_token = mint_body.get("value") if isinstance(mint_body, dict) else None
    if not isinstance(id_token, str) or not id_token:
        raise ReleaseError("GitHub OIDC mint returned no id token")
    return id_token


def oidc_probe(args: argparse.Namespace) -> None:
    """Handwritten trusted-publisher exchange under the caller's job identity.

    Contrast only: this is not the pinned npm CLI. It mints the same audience
    and repeats the exchange path/headers, but its User-Agent puts
    platform.python_version() in node/v and ends at ci/github-actions. The
    native diagnosis is oidc-dry-run. Only an allowlist is printed. Nothing
    publishes.
    """
    id_token = _mint_github_id_token(args.registry, args.npm_version)
    claims = _decode_checked_id_token(id_token)
    for key in OIDC_CLAIM_ALLOWLIST:
        if key in claims:
            value = claims[key]
            text = value if isinstance(value, str) else json.dumps(value)
            print(f"claim {key}: {_redact_secrets_text(text)}")
    escaped = args.package.replace("/", "%2f")
    exchange_url = f"{args.registry.rstrip('/')}/-/npm/v1/oidc/token/exchange/package/{escaped}"
    exchange_request = Request(exchange_url, method="POST", headers={
        "Authorization": f"Bearer {id_token}",
        "npm-command": "publish",
        "npm-auth-type": "web",
        "Accept": "*/*",
        "User-Agent": f"npm/{args.npm_version} node/v{platform.python_version()} {sys.platform} x64 workspaces/false ci/github-actions",
    })
    try:
        with urlopen(exchange_request, timeout=15) as response:
            status, headers = response.status, response.headers
            payload = json.load(response)
    except HTTPError as exc:
        status, headers = exc.code, exc.headers
        try:
            payload = json.loads(exc.read().decode(errors="replace"))
        except (ValueError, OSError):
            payload = None
        finally:
            exc.close()
    except (URLError, OSError) as exc:
        raise ReleaseError(f"npm OIDC exchange unreachable: {exc}") from exc
    print(f"exchange HTTP status: {status}")
    for header in ("npm-request-id", "cf-ray"):
        value = headers.get(header) if headers is not None else None
        if isinstance(value, str) and value:
            print(f"{header}: {_redact_secrets_text(value)}")
    issued = isinstance(payload, dict) and isinstance(payload.get("token"), str) and bool(payload["token"])
    if issued:
        print("exchange verdict: token issued (withheld)")
        return
    fields: dict[str, str] = {}
    if isinstance(payload, dict):
        for key in ("code", "error", "message", "error_code"):
            value = payload.get(key)
            if isinstance(value, str) and value:
                fields[key] = _redact_secrets_text(value[:300])
    if fields:
        print("exchange verdict: no token issued; registry fields:", json.dumps(fields, ensure_ascii=False))
    else:
        print("exchange verdict: no token issued; body withheld")


# npm/cli v11.18.0 logs two HTTP shapes:
#   mint (oidc.js / make-fetch-happen):  http fetch METHOD URL STATUS ...
#   exchange (npm-registry-fetch 19.1.1/lib/check-response.js):
#     http fetch METHOD STATUS URL ...
# A registry body message is not an HTTP status.
OIDC_HTTP_PREFIX = r"^(?:npm http fetch|http fetch)\s+"
OIDC_HTTP_METHOD_URL_STATUS = re.compile(
    OIDC_HTTP_PREFIX + r"(GET|POST|PUT|DELETE)\s+(https?://\S+|/[\S]*)\s+(\d{3})\b",
    re.MULTILINE | re.IGNORECASE,
)
OIDC_HTTP_METHOD_STATUS_URL = re.compile(
    OIDC_HTTP_PREFIX + r"(GET|POST|PUT|DELETE)\s+(\d{3})\s+(\S+)",
    re.MULTILINE | re.IGNORECASE,
)
OIDC_EXCHANGE_FAIL = re.compile(
    r"verbose oidc Failed token exchange request with body message: (.+)$",
    re.MULTILINE,
)
OIDC_EXCHANGE_OK = re.compile(
    r"verbose oidc Successfully retrieved and set token\s*$",
    re.MULTILINE,
)
OIDC_SKIPPED = re.compile(
    r"verbose oidc (Skipped because .+|Failed to fetch id_token from GitHub: .+)$",
    re.MULTILINE,
)
NPM_USER_AGENT_LINE = re.compile(
    r"^(?:npm )?verbose cli (npm/\S+ node/\S+ \S+ \S+ workspaces/\S+(?: ci/\S+)?)\s*$",
    re.MULTILINE,
)
EXCHANGE_PATH_MARKER = "/-/npm/v1/oidc/token/exchange/package/"
PUBLISH_PUT_MARKER = "/-/npm/v1/packages/"


def _combined_cli_text(result: subprocess.CompletedProcess[str]) -> str:
    return f"{result.stdout}\n{result.stderr}"


def _oidc_http_events(text: str) -> list[tuple[str, str, str]]:
    """Return (method, url, status) from either npm 11.18.0 HTTP log order."""
    events: list[tuple[int, str, str, str]] = []
    for match in OIDC_HTTP_METHOD_STATUS_URL.finditer(text):
        method, status, url = match.groups()
        events.append((match.start(), method.upper(), url, status))
    occupied = {start for start, *_ in events}
    for match in OIDC_HTTP_METHOD_URL_STATUS.finditer(text):
        if match.start() in occupied:
            continue
        method, url, status = match.groups()
        if url.isdigit():
            continue
        events.append((match.start(), method.upper(), url, status))
    events.sort(key=lambda item: item[0])
    return [(method, url, status) for _, method, url, status in events]


def _exchange_status(text: str) -> str:
    statuses = [status for method, url, status in _oidc_http_events(text)
                if method == "POST" and EXCHANGE_PATH_MARKER in url]
    return statuses[-1] if statuses else "unknown"


def _redact_cli_allowlist(text: str) -> str:
    return _redact_secrets_text(text)


def oidc_dry_run(args: argparse.Namespace) -> None:
    """Pinned npm CLI publish --dry-run against one exact tarball.

    npm/cli v11.18.0 publish.js calls oidc() before the dry-run/auth check and
    only calls libpub inside if (!dryRun). ignore-scripts is required so a
    directory publish path cannot run lifecycle scripts. The handwritten
    oidc-probe is not treated as equivalent. Exit 0 from npm is not an
    authentication success.
    """
    regular_file(args.artifact)
    userconfig = Path(args.userconfig)
    userconfig.parent.mkdir(parents=True, exist_ok=True)
    userconfig.write_text(f"registry={args.registry.rstrip('/')}/\n", encoding="utf-8")
    isolated_home = userconfig.parent / "home"
    isolated_home.mkdir(parents=True, exist_ok=True)
    environment = dict(os.environ)
    environment.pop("NPM_ID_TOKEN", None)
    environment["HOME"] = str(isolated_home)
    environment["NPM_CONFIG_USERCONFIG"] = str(userconfig)
    environment["NPM_CONFIG_LOGLEVEL"] = "verbose"
    command = [
        args.npm,
        "publish",
        str(args.artifact),
        "--dry-run",
        "--ignore-scripts",
        "--access",
        args.access,
        "--tag",
        args.dist_tag,
        "--provenance" if args.provenance == "true" else "--provenance=false",
        "--registry",
        args.registry,
        "--loglevel",
        "verbose",
        "--userconfig",
        str(userconfig),
    ]
    if command[1:4] != ["publish", str(args.artifact), "--dry-run"] or "--ignore-scripts" not in command:
        raise ReleaseError("internal: diagnosis command omitted dry-run or ignore-scripts")
    result = subprocess.run(
        command,
        cwd=None,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=environment,
    )
    text = _combined_cli_text(result)
    redacted = _redact_cli_allowlist(text)
    if PUBLISH_PUT_MARKER in text and any(
        method == "PUT" for method, url, _status in _oidc_http_events(text)
        if PUBLISH_PUT_MARKER in url
    ):
        raise ReleaseError("native OIDC diagnosis issued a package write; aborting")
    print(f"native npm exit: {result.returncode}")
    print("native npm dry-run: true")
    print(f"native npm ignore-scripts: true")
    print(f"native npm id-token-env: {'present' if 'NPM_ID_TOKEN' in environment else 'absent'}")
    print(f"native npm actions-oidc-mint: {'present' if os.environ.get('ACTIONS_ID_TOKEN_REQUEST_URL') and os.environ.get('ACTIONS_ID_TOKEN_REQUEST_TOKEN') else 'absent'}")
    agent = NPM_USER_AGENT_LINE.search(redacted)
    if agent:
        print(f"native npm user-agent: {agent.group(1)}")
    for method, url, status in _oidc_http_events(redacted):
        if EXCHANGE_PATH_MARKER in url or "audience=" in url or "/idtoken" in url.lower():
            path = urlsplit(url).path or url
            if EXCHANGE_PATH_MARKER in url:
                path = urlsplit(url).path
            print(f"native npm http: {method} {path} {status}")
    exchange_status = _exchange_status(text)
    print(f"native npm exchange HTTP status: {exchange_status}")
    skipped = OIDC_SKIPPED.search(redacted)
    if skipped:
        print(f"native npm oidc skipped: {_redact_secrets_text(skipped.group(1).strip()[:300])}")
    fail = OIDC_EXCHANGE_FAIL.search(redacted)
    if fail:
        print(f"native npm exchange verdict: no token issued; registry fields: {json.dumps({'message': _redact_secrets_text(fail.group(1).strip()[:300])}, ensure_ascii=False)}")
        raise ReleaseError("native npm OIDC exchange did not issue a token")
    if OIDC_EXCHANGE_OK.search(text):
        print("native npm exchange verdict: token issued (withheld)")
        return
    if exchange_status not in ("unknown", "201", "200"):
        print("native npm exchange verdict: no token issued; body withheld")
        raise ReleaseError(f"native npm OIDC exchange HTTP {exchange_status}")
    print("native npm exchange verdict: unproven; CLI produced no OIDC success or failure signal")
    raise ReleaseError("native npm OIDC exchange signal missing; dry-run exit is not authentication")


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(
        description="Secure release kit v1: common validators and the implemented npm adapter.",
        epilog=(
            "Outputs:\n"
            "  Writes only explicitly named release artifacts, manifests, or notes.\n"
            "  All validation and adapter failures exit nonzero.\n\n"
            "Examples:\n"
            "  %(prog)s source --tag v1.2.3 --version 1.2.3 --primary-ref origin/main\n"
            "  %(prog)s npm-pack --tag v1.2.3 --package-dir . --output-dir release "
            "--manifest release/manifest.json"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    commands = root.add_subparsers(dest="command", required=True)

    command = commands.add_parser("source", help="Validate stable tag, version, HEAD, and primary ancestry.")
    command.add_argument("--tag", required=True)
    command.add_argument("--version", required=True)
    command.add_argument("--primary-ref", required=True)
    command.set_defaults(handler=source)

    command = commands.add_parser("changelog", help="Extract an exact committed changelog section.")
    command.add_argument("--tag", required=True)
    command.add_argument("--changelog", required=True, type=Path)
    command.add_argument("--notes", required=True, type=Path)
    command.set_defaults(handler=changelog)

    command = commands.add_parser("manifest-create", help="Create a canonical manifest for release files.")
    command.add_argument("--tag", required=True)
    command.add_argument("--version", required=True)
    command.add_argument("--artifact", required=True, action="append", type=Path)
    command.add_argument("--output", required=True, type=Path)
    command.set_defaults(handler=manifest_create)

    command = commands.add_parser("manifest-verify", help="Verify identity and the exact artifact set.")
    command.add_argument("--manifest", required=True, type=Path)
    command.add_argument("--directory", required=True, type=Path)
    command.add_argument("--tag")
    command.add_argument("--version")
    command.set_defaults(handler=manifest_verify)

    command = commands.add_parser("npm-pack", help="Build exactly one npm tarball and its manifest.")
    command.add_argument("--tag", required=True)
    command.add_argument("--package-dir", required=True, type=Path)
    command.add_argument("--output-dir", required=True, type=Path)
    command.add_argument("--manifest", required=True, type=Path)
    command.add_argument("--npm", default="npm")
    command.set_defaults(handler=npm_pack)

    for name, help_text, handler in (
        ("npm-absent", "Require a recognized npm E404 for the exact version.", npm_absent),
        ("npm-smoke", "Resolve and clean-install the exact npm version.", npm_smoke),
    ):
        command = commands.add_parser(name, help=help_text)
        command.add_argument("--package", required=True)
        command.add_argument("--version", required=True)
        command.add_argument("--registry", default="https://registry.npmjs.org/")
        command.add_argument("--npm", default="npm")
        if handler is npm_smoke:
            command.add_argument("--metadata-source", choices=("npm", "version-api"), default="npm",
                                 help="version-api uses the public exact-version HTTP API without npm credentials")
            command.add_argument("--metadata-retries", type=int, default=30)
            command.add_argument("--metadata-retry-delay", type=float, default=10)
        command.set_defaults(handler=handler)

    command = commands.add_parser(
        "npm-existing", help="Require an existing npm version to have identical tarball bytes."
    )
    command.add_argument("--package", required=True)
    command.add_argument("--version", required=True)
    command.add_argument("--artifact", required=True, type=Path)
    command.add_argument("--registry", default="https://registry.npmjs.org/")
    command.add_argument("--npm", default="npm")
    command.set_defaults(handler=npm_existing)

    command = commands.add_parser("npm-publish", help="Publish one exact tarball with an explicit provenance policy.")
    command.add_argument("--provenance", choices=("true", "false"), default="true")
    command.add_argument("--artifact", required=True, type=Path)
    command.add_argument("--registry", default="https://registry.npmjs.org/")
    command.add_argument("--access", choices=("public", "restricted"), default="public")
    command.add_argument("--dist-tag", default="latest")
    command.add_argument("--npm", default="npm")
    command.set_defaults(handler=npm_publish)

    command = commands.add_parser(
        "oidc-probe",
        help="Handwritten trusted-publisher exchange contrast; not the pinned npm CLI.",
    )
    command.add_argument("--package", required=True, help="Published package name; its slash is npa-escaped for the exchange path.")
    command.add_argument("--registry", default="https://registry.npmjs.org/")
    command.add_argument("--npm-version", default="11.18.0", help="Pinned CLI version mirrored in the User-Agent and mint audience policy.")
    command.set_defaults(handler=oidc_probe)

    command = commands.add_parser(
        "oidc-dry-run",
        help="Pinned npm publish --dry-run against one tarball; never writes the package.",
    )
    command.add_argument("--artifact", required=True, type=Path)
    command.add_argument("--registry", default="https://registry.npmjs.org/")
    command.add_argument("--access", choices=("public", "restricted"), default="public")
    command.add_argument("--dist-tag", default="latest")
    command.add_argument("--provenance", choices=("true", "false"), default="true")
    command.add_argument("--npm", default="npm")
    command.add_argument("--userconfig", required=True, type=Path, help="Isolated npmrc path; diagnosis never reads the runner userconfig.")
    command.set_defaults(handler=oidc_dry_run)
    return root


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        args.handler(args)
    except (ReleaseError, OSError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
