#!/usr/bin/env python3
"""Fail-closed release validation for OpenCraft app releases (kit v1).

Definition:
  Extract the committed changelog section for a release tag, and create or
  verify the canonical SHA-256 manifest that binds every release asset to the
  release tag and the exact source commit. CI runs this file from the checkout;
  it never loads an agent skill at runtime.

Parameters:
  Run ``secure_release.py <command> --help`` for command-specific parameters.

Outputs:
  Commands write only explicitly requested notes or manifests.
  Success summaries go to stdout; actionable failures go to stderr with exit 1.

Examples:
  python3 secure_release.py changelog --tag v1.2.3 --changelog CHANGELOG.md --notes notes.md
  python3 secure_release.py manifest-verify --manifest release/manifest.json --directory release
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import stat
import subprocess
import sys
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


def manifest_version(tag: str, prerelease: bool) -> str:
    if prerelease:
        base, separator, number = tag.partition("-beta.")
        parse_tag(base)
        if not separator or re.fullmatch(r"[1-9][0-9]*", number) is None:
            raise ReleaseError(f"prerelease tag must be vX.Y.Z-beta.N: {tag}")
        return tag[1:]
    return parse_tag(tag)


def build_manifest(tag: str, version: str, artifacts: Sequence[Path], output: Path, *, prerelease: bool = False) -> None:
    if version != manifest_version(tag, prerelease):
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
    build_manifest(args.tag, args.version, args.artifact, args.output, prerelease=args.prerelease)


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
    if not isinstance(tag, str) or not isinstance(version, str) or version != manifest_version(tag, args.prerelease):
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


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(
        description="Secure release kit v1: changelog notes and release manifests.",
        epilog=(
            "Outputs:\n"
            "  Writes only explicitly named manifests or notes.\n"
            "  All validation failures exit nonzero.\n\n"
            "Examples:\n"
            "  %(prog)s manifest-create --tag v1.2.3-beta.4 --version 1.2.3-beta.4 --prerelease "
            "--artifact app.dmg --output release-manifest.json"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    commands = root.add_subparsers(dest="command", required=True)

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
    command.add_argument("--prerelease", action="store_true", help="The tag is vX.Y.Z-beta.N.")
    command.set_defaults(handler=manifest_create)

    command = commands.add_parser("manifest-verify", help="Verify identity and the exact artifact set.")
    command.add_argument("--manifest", required=True, type=Path)
    command.add_argument("--directory", required=True, type=Path)
    command.add_argument("--tag")
    command.add_argument("--version")
    command.add_argument("--prerelease", action="store_true", help="The tag is vX.Y.Z-beta.N.")
    command.set_defaults(handler=manifest_verify)
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
