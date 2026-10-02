#!/usr/bin/env python3
"""Build minisandbox-compatible, uncompressed EROFS root filesystems."""

from __future__ import annotations

import argparse
import copy
from dataclasses import dataclass
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile
import urllib.request


REPOSITORY = Path(__file__).resolve().parent.parent
BUILD_ROOT = REPOSITORY / "target" / "pvm-linux"
DEBIAN_PROFILE = "trixie-20260713"
DEBIAN_IMAGE = f"minisandbox/debian-rootfs:{DEBIAN_PROFILE}"
EROFS_UTILS_VERSION = "1.8.10"
EROFS_UTILS_SHA256 = (
    "05eb4edebe11decce6ecb34e98d2f80c8cd283c2f2967d8ba7efd58418570514"
)
EROFS_UTILS_URL = (
    "https://launchpad.net/ubuntu/+archive/primary/+sourcefiles/erofs-utils/"
    f"{EROFS_UTILS_VERSION}-1/erofs-utils_{EROFS_UTILS_VERSION}.orig.tar.gz"
)
PMEM_ALIGNMENT = 2 * 1024 * 1024
EROFS_UUID = "00000000-0000-0000-0000-000000000000"
EXT4_UPPER_UUID = "00000000-0000-0000-0000-000000000001"
ACTOR_VOLUME_TEMPLATE_UUID = "00000000-0000-0000-0000-000000000002"
DEFAULT_UPPER_SIZE = 2 * 1024 * 1024 * 1024
DEFAULT_ACTOR_VOLUME_SIZE = DEFAULT_UPPER_SIZE
HERMES_PROFILE = "d66341ab28635d9eecbd30a18d50801d927153b8"
HERMES_SOURCE = REPOSITORY / "target" / "research" / "hermes-agent"
HERMES_BASE_OUTPUT = BUILD_ROOT / f"hermes-base-{HERMES_PROFILE[:12]}-x86_64.erofs"
HERMES_APP_OUTPUT = BUILD_ROOT / f"hermes-app-{HERMES_PROFILE[:12]}-x86_64.erofs"
HERMES_DOCKERFILE_PATCH = "fixed-base-stage+direct-ext4+symbolic-copy-chmod+checked-hash-pyc-v7"
HERMES_BYTECODE_POLICY = "pep552-checked-hash-opt0-v1"
HERMES_BYTECODE_BUILD_STEP = b"""\
# Precompile Python without importing application modules. PEP 552 checked-hash
# headers remain valid after the deterministic EROFS timestamp rewrite, while
# -f replaces timestamp-mode bytecode inherited from dependency wheels.
RUN /opt/hermes/.venv/bin/python -m compileall \\
        --invalidation-mode checked-hash -o 0 -f -q -j 0 \\
        -e /opt/hermes \\
        -x '/(\\.git|\\.venv|node_modules)(/|$)' \\
        /opt/hermes && \\
    /opt/hermes/.venv/bin/python -m compileall \\
        --invalidation-mode checked-hash -o 0 -f -q -j 0 \\
        -e /opt/hermes/.venv \\
        /opt/hermes/.venv
"""


class BuildError(RuntimeError):
    """A rootfs build failed without a useful Python traceback."""


@dataclass(frozen=True)
class TarFile:
    """One trusted file overlaid onto an untrusted merged-rootfs tar."""

    contents: bytes
    mode: int = 0o644


@dataclass(frozen=True)
class TarManifestEntry:
    """Stable metadata and optional content identity for one base tar path."""

    metadata: tuple[object, ...]
    payload_sha256: bytes | None


def run(
    arguments: list[str | os.PathLike[str]],
    description: str,
    *,
    capture: bool = False,
    cwd: Path | None = None,
) -> subprocess.CompletedProcess[str]:
    command = [os.fspath(argument) for argument in arguments]
    print("+", " ".join(command), flush=True)
    result = subprocess.run(
        command,
        check=False,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
        cwd=cwd,
    )
    if result.returncode:
        detail = (result.stderr or "").strip()
        suffix = f": {detail}" if detail else ""
        raise BuildError(f"{description} failed with exit code {result.returncode}{suffix}")
    return result


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download_pinned(url: str, output: Path, expected_sha256: str) -> None:
    if output.is_file():
        actual = sha256(output)
        if actual != expected_sha256:
            raise BuildError(
                f"checksum mismatch for {output}: expected {expected_sha256}, got {actual}"
            )
        return
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.download-{os.getpid()}")
    print(f"+ download {url} -> {output}", flush=True)
    try:
        with urllib.request.urlopen(url, timeout=60) as response, temporary.open("wb") as target:
            shutil.copyfileobj(response, target)
        actual = sha256(temporary)
        if actual != expected_sha256:
            raise BuildError(
                f"checksum mismatch for {url}: expected {expected_sha256}, got {actual}"
            )
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)


def ensure_erofs_tools() -> tuple[Path, Path]:
    BUILD_ROOT.mkdir(parents=True, exist_ok=True)
    archive = BUILD_ROOT / f"erofs-utils_{EROFS_UTILS_VERSION}.orig.tar.gz"
    source = BUILD_ROOT / f"erofs-utils-{EROFS_UTILS_VERSION}"
    build = BUILD_ROOT / "erofs-utils-build"
    mkfs = build / "mkfs" / "mkfs.erofs"
    fsck = build / "fsck" / "fsck.erofs"
    if mkfs.is_file() and fsck.is_file():
        return mkfs, fsck

    download_pinned(EROFS_UTILS_URL, archive, EROFS_UTILS_SHA256)
    if not (source / "configure.ac").is_file():
        if source.exists():
            raise BuildError(f"incomplete source directory; move it aside explicitly: {source}")
        source.mkdir()
        run(
            ["tar", "-xzf", archive, "--strip-components=1", "-C", source],
            "extract pinned erofs-utils",
        )
    if not (source / "configure").is_file():
        run(
            [source / "autogen.sh"],
            "generate erofs-utils configure script",
            cwd=source,
        )
    build.mkdir(exist_ok=True)
    if not (build / "Makefile").is_file():
        run(
            [
                source / "configure",
                "--disable-lz4",
                "--disable-lzma",
                "--without-zlib",
                "--without-libdeflate",
                "--without-libzstd",
                "--without-qpl",
                "--without-xxhash",
                "--disable-fuse",
                "--without-uuid",
                "--without-selinux",
                "--disable-multithreading",
                "--disable-werror",
            ],
            "configure pinned erofs-utils",
            cwd=build,
        )
    run(
        ["make", f"-j{min(os.cpu_count() or 1, 4)}", "-C", build],
        "build pinned erofs-utils",
    )
    if not mkfs.is_file() or not fsck.is_file():
        raise BuildError("erofs-utils build completed without mkfs.erofs and fsck.erofs")
    return mkfs, fsck


def metadata_path(output: Path) -> Path:
    return output.with_name(f"{output.name}.metadata.json")


def write_metadata(output: Path, source: dict[str, object], artifact: dict[str, object]) -> None:
    is_app_layer = source.get("filesystem_role") == "application-version-delta" or source.get(
        "kind"
    ) == "minisandbox-fixed-application-layer"
    metadata = {
        "schema": "minisandbox.erofs-rootfs.v1",
        "source": source,
        "erofs": artifact,
        "oci_compatibility": (
            {
                "preserved": "additive path overrides and numeric file metadata",
                "recorded_not_applied": (
                    "Entrypoint, Cmd, Env, User, WorkingDir, ExposedPorts, labels and stop signal"
                ),
                "not_provided": (
                    "OCI whiteouts, Docker daemon, container namespaces and cgroups"
                ),
            }
            if is_app_layer
            else {
                "preserved": "merged root filesystem and numeric file metadata",
                "recorded_not_applied": (
                    "Entrypoint, Cmd, Env, User, WorkingDir, ExposedPorts, labels and stop signal"
                ),
                "not_provided": (
                    "Docker daemon, overlay writable layer, container namespaces and cgroups"
                ),
            }
        ),
    }
    destination = metadata_path(output)
    temporary = destination.with_name(f".{destination.name}.tmp-{os.getpid()}")
    try:
        temporary.write_text(
            json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def build_erofs(
    source: Path,
    output: Path,
    *,
    input_mode: str,
    source_metadata: dict[str, object],
    all_root: bool = False,
) -> None:
    source = source.resolve()
    output = output.resolve()
    if input_mode == "directory":
        if not source.is_dir():
            raise BuildError(f"EROFS source is not a directory: {source}")
        if output.is_relative_to(source):
            raise BuildError("EROFS output must not be inside its source directory")
    elif input_mode == "merged-rootfs-tar":
        if not source.is_file():
            raise BuildError(f"EROFS source is not a tar file: {source}")
    else:
        raise BuildError(f"unsupported EROFS input mode: {input_mode}")

    mkfs, fsck = ensure_erofs_tools()
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{output.name}.tmp-", dir=output.parent
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    temporary.unlink()
    arguments: list[str | os.PathLike[str]] = [
        mkfs,
        "--quiet",
        "-b4096",
        "-T0",
        "--all-time",
        "--ignore-mtime",
        "--fsalignblks=512",
        "-L",
        "minisandbox",
        "-U",
        EROFS_UUID,
    ]
    if all_root:
        arguments.append("--all-root")
    if input_mode == "merged-rootfs-tar":
        arguments.extend(["--tar=f", "--sort=path"])
    arguments.extend([temporary, source])
    try:
        run(arguments, "build uncompressed EROFS")
        size = temporary.stat().st_size
        if not size or size % PMEM_ALIGNMENT:
            raise BuildError(
                f"EROFS size {size:#x} is not a nonzero {PMEM_ALIGNMENT:#x} multiple"
            )
        run([fsck, temporary], "validate EROFS")
        digest = sha256(temporary)
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)

    artifact = {
        "sha256": digest,
        "size": size,
        "input_mode": input_mode,
        "block_size": 4096,
        "compression": "none",
        "fixed_timestamp": 0,
        "forced_root_ownership": all_root,
        "filesystem_alignment_bytes": PMEM_ALIGNMENT,
        "label": "minisandbox",
        "uuid": EROFS_UUID,
        "erofs_utils_version": EROFS_UTILS_VERSION,
        "erofs_utils_archive_sha256": EROFS_UTILS_SHA256,
    }
    write_metadata(output, source_metadata, artifact)
    print(f"READY {output} ({size} bytes; sha256:{digest})")


def ensure_docker() -> None:
    result = subprocess.run(
        ["docker", "info", "--format", "{{.ServerVersion}}"],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode or not result.stdout.strip():
        detail = result.stderr.strip() or "Docker returned no server version"
        raise BuildError(
            "OCI conversion requires a reachable Docker Engine (Docker Desktop is supported); "
            f"Docker said: {detail}. A daemonless OCI tool can export a merged tar for the "
            "`tar` subcommand instead."
        )


def ensure_buildx() -> None:
    ensure_docker()
    result = subprocess.run(
        ["docker", "buildx", "version"],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode:
        detail = result.stderr.strip()
        raise BuildError(
            "Dockerfile conversion requires Docker Buildx with the tar exporter; "
            f"docker buildx said: {detail}"
        )


def git_checkout_metadata(source: Path) -> dict[str, object]:
    revision = run(
        ["git", "-C", source, "rev-parse", "HEAD"],
        "read source revision",
        capture=True,
    ).stdout.strip()
    status = run(
        ["git", "-C", source, "status", "--porcelain", "--untracked-files=normal"],
        "read source status",
        capture=True,
    ).stdout
    return {
        "repository": run(
            ["git", "-C", source, "config", "--get", "remote.origin.url"],
            "read source repository",
            capture=True,
        ).stdout.strip(),
        "revision": revision,
        "dirty": bool(status.strip()),
    }


def patch_hermes_dockerfile(contents: bytes) -> bytes:
    """Apply the reviewed BuildKit compatibility and bytecode build steps."""

    runtime_stage = b"FROM debian:13.4\n"
    named_runtime_stage = b"FROM debian:13.4 AS minisandbox_hermes_runtime\n"
    if contents.count(runtime_stage) != 1:
        raise BuildError(
            "pinned Hermes Dockerfile no longer has the reviewed final Debian stage; "
            "review the base/application split before updating the build patch"
        )
    contents = contents.replace(runtime_stage, named_runtime_stage)

    original = b"COPY --link --chmod=a+rX,go-w . ."
    replacement = (
        b"FROM minisandbox_hermes_runtime AS minisandbox_hermes_base\n"
        b"FROM minisandbox_hermes_base AS minisandbox_hermes_app\n\n"
        b"COPY --link . .\nRUN chmod -R a+rX,go-w ."
    )
    if contents.count(original) != 1:
        raise BuildError(
            "pinned Hermes Dockerfile no longer has the reviewed symbolic COPY chmod; "
            "review the upstream change before updating the compatibility rewrite"
        )
    contents = contents.replace(original, replacement)

    editable_install = b'RUN uv pip install --no-cache-dir --no-deps -e "."'
    if contents.count(editable_install) != 1:
        raise BuildError(
            "pinned Hermes Dockerfile no longer has the reviewed editable install; "
            "review bytecode generation placement before updating the build patch"
        )
    return contents.replace(
        editable_install,
        editable_install + b"\n\n" + HERMES_BYTECODE_BUILD_STEP.rstrip(),
    )


def inspect_image(image: str, pull_if_missing: bool) -> dict[str, object]:
    result = subprocess.run(
        ["docker", "image", "inspect", image],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode and pull_if_missing:
        run(
            ["docker", "image", "pull", "--platform", "linux/amd64", image],
            "pull linux/amd64 OCI image",
        )
        result = run(["docker", "image", "inspect", image], "inspect OCI image", capture=True)
    elif result.returncode:
        raise BuildError(f"cannot inspect local OCI image {image}: {result.stderr.strip()}")
    try:
        records = json.loads(result.stdout)
        record = records[0]
    except (json.JSONDecodeError, IndexError, KeyError, TypeError) as error:
        raise BuildError(f"Docker returned invalid image-inspect JSON: {error}") from error
    if record.get("Os") != "linux" or record.get("Architecture") != "amd64":
        raise BuildError(
            f"OCI image targets {record.get('Os')}/{record.get('Architecture')}, expected linux/amd64"
        )
    config = record.get("Config") or {}
    if not isinstance(config, dict):
        raise BuildError("OCI image Config is not an object")
    if config.get("Volumes"):
        raise BuildError(
            "OCI image declares VOLUME paths; Docker export omits volume contents, so conversion is refused"
        )
    return record


def normalized_tar_name(name: str) -> str:
    normalized = name.removeprefix("./").rstrip("/")
    parts = Path(normalized).parts
    if (
        not normalized
        or name.startswith("/")
        or any(part in ("", ".", "..") for part in parts)
        or "\0" in normalized
    ):
        raise BuildError(f"unsafe rootfs overlay path: {name!r}")
    return normalized


def replace_tar_files(
    archive: Path,
    replacements: dict[str, bytes | TarFile],
) -> None:
    if not replacements:
        return
    normalized = {
        normalized_tar_name(name): value if isinstance(value, TarFile) else TarFile(value)
        for name, value in replacements.items()
    }
    temporary = archive.with_name(f".{archive.name}.overlay-{os.getpid()}")
    try:
        with tarfile.open(archive, "r:") as source, tarfile.open(temporary, "w:") as target:
            existing_directories: set[str] = set()
            existing_paths: set[str] = set()
            for member in source:
                member_name = member.name.removeprefix("./").rstrip("/")
                existing_paths.add(member_name)
                if member.isdir():
                    existing_directories.add(member_name)
                if member_name in normalized:
                    continue
                payload = source.extractfile(member) if member.isfile() else None
                target.addfile(member, payload)
            required_directories = {
                str(parent)
                for name in normalized
                for parent in Path(name).parents
                if str(parent) not in ("", ".")
            }
            conflicting_parents = (required_directories - existing_directories) & existing_paths
            if conflicting_parents:
                conflicts = ", ".join(repr(path) for path in sorted(conflicting_parents))
                raise BuildError(
                    f"rootfs overlay parent is not a directory ({conflicts}); use its canonical target path"
                )
            for name in sorted(
                required_directories - existing_directories,
                key=lambda value: (value.count("/"), value),
            ):
                member = tarfile.TarInfo(f"{name}/")
                member.type = tarfile.DIRTYPE
                member.mode = 0o755
                member.uid = 0
                member.gid = 0
                member.uname = "root"
                member.gname = "root"
                member.mtime = 0
                target.addfile(member)
            for name, replacement in sorted(normalized.items()):
                member = tarfile.TarInfo(name)
                member.size = len(replacement.contents)
                member.mode = replacement.mode
                member.uid = 0
                member.gid = 0
                member.uname = "root"
                member.gname = "root"
                member.mtime = 0
                target.addfile(member, io.BytesIO(replacement.contents))
        os.replace(temporary, archive)
    finally:
        temporary.unlink(missing_ok=True)


def indexed_tar_members(
    archive: tarfile.TarFile,
) -> tuple[list[tuple[str, tarfile.TarInfo]], dict[str, tarfile.TarInfo]]:
    ordered: list[tuple[str, tarfile.TarInfo]] = []
    indexed: dict[str, tarfile.TarInfo] = {}
    for member in archive:
        raw_name = member.name.removeprefix("./").rstrip("/")
        if raw_name in ("", "."):
            continue
        name = normalized_tar_name(member.name)
        if name in indexed:
            raise BuildError(f"rootfs tar contains duplicate path {name!r}")
        ordered.append((name, member))
        indexed[name] = member
    return ordered, indexed


def stable_pax_headers(member: tarfile.TarInfo) -> dict[str, str]:
    ignored = {"mtime", "atime", "ctime", "LIBARCHIVE.creationtime"}
    return {key: value for key, value in member.pax_headers.items() if key not in ignored}


def tar_member_metadata(member: tarfile.TarInfo) -> tuple[object, ...]:
    return (
        member.type,
        member.mode,
        member.uid,
        member.gid,
        member.size if member.isfile() else 0,
        member.linkname,
        member.devmajor,
        member.devminor,
        stable_pax_headers(member),
    )


def tar_payload_digest(archive: tarfile.TarFile, member: tarfile.TarInfo) -> bytes:
    payload = archive.extractfile(member)
    if payload is None:
        raise BuildError(f"tar entry {member.name!r} has no readable file payload")
    digest = hashlib.sha256()
    for chunk in iter(lambda: payload.read(1024 * 1024), b""):
        digest.update(chunk)
    return digest.digest()


def build_tar_manifest(path: Path) -> dict[str, TarManifestEntry]:
    manifest: dict[str, TarManifestEntry] = {}
    with tarfile.open(path, "r:") as archive:
        ordered, _ = indexed_tar_members(archive)
        for name, member in ordered:
            manifest[name] = TarManifestEntry(
                metadata=tar_member_metadata(member),
                payload_sha256=tar_payload_digest(archive, member) if member.isfile() else None,
            )
    return manifest


def tar_member_matches_manifest(
    archive: tarfile.TarFile,
    member: tarfile.TarInfo,
    expected: TarManifestEntry,
) -> bool:
    if tar_member_metadata(member) != expected.metadata:
        return False
    if member.isfile():
        return tar_payload_digest(archive, member) == expected.payload_sha256
    return True


def hardlink_target(member: tarfile.TarInfo) -> str | None:
    if not member.islnk():
        return None
    raw_name = member.linkname.removeprefix("./").rstrip("/")
    if raw_name in ("", "."):
        raise BuildError(f"hardlink {member.name!r} has invalid target {member.linkname!r}")
    return normalized_tar_name(member.linkname)


def build_app_delta_tar_from_manifest(
    base_manifest: dict[str, TarManifestEntry],
    final_path: Path,
    output: Path,
) -> dict[str, int]:
    """Write the additive final-vs-base tree from a bounded base manifest."""

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.tmp-{os.getpid()}")
    stats: dict[str, int]
    try:
        with tarfile.open(final_path, "r:") as final_archive:
            final_order, final_index = indexed_tar_members(final_archive)
            selected: set[str] = set()
            for name, final_member in final_order:
                base_entry = base_manifest.get(name)
                if base_entry is None or not tar_member_matches_manifest(
                    final_archive, final_member, base_entry
                ):
                    selected.add(name)

            # A hardlink whose target is overridden must move into the app
            # layer too; otherwise its pathname would still reveal the old
            # base inode. Iterate for the (rare) chained-hardlink case.
            changed = True
            while changed:
                changed = False
                for name, member in final_order:
                    target = hardlink_target(member)
                    if target in selected and name not in selected:
                        selected.add(name)
                        changed = True

            required_directories: set[str] = set()
            for name in selected:
                required_directories.update(
                    os.fspath(parent)
                    for parent in Path(name).parents
                    if os.fspath(parent) not in ("", ".")
                )
            selected.update(required_directories)

            with tarfile.open(temporary, "w:", format=tarfile.PAX_FORMAT) as app_archive:
                for name in sorted(required_directories, key=lambda value: (value.count("/"), value)):
                    member = final_index.get(name)
                    if member is None or not member.isdir():
                        raise BuildError(
                            f"application path requires missing directory entry {name!r}"
                        )
                    copied = copy.copy(member)
                    copied.name = name
                    copied.mtime = 0
                    app_archive.addfile(copied)
                for name, member in final_order:
                    if name not in selected or name in required_directories:
                        continue
                    copied = copy.copy(member)
                    copied.name = name
                    copied.mtime = 0
                    payload = None
                    if member.islnk():
                        payload = final_archive.extractfile(member)
                        if payload is None:
                            raise BuildError(f"cannot materialize hardlink {name!r}")
                        target = hardlink_target(member)
                        target_member = final_index.get(target or "")
                        if target_member is None or not target_member.isfile():
                            raise BuildError(
                                f"hardlink {name!r} has missing regular target {target!r}"
                            )
                        copied.type = tarfile.REGTYPE
                        copied.linkname = ""
                        copied.size = target_member.size
                    elif member.isfile():
                        payload = final_archive.extractfile(member)
                        if payload is None:
                            raise BuildError(f"cannot read changed file {name!r}")
                    app_archive.addfile(copied, payload)

            stats = {
                "base_entries": len(base_manifest),
                "final_entries": len(final_index),
                "app_entries": len(selected),
                "base_only_entries_retained": len(set(base_manifest) - set(final_index)),
            }
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    os.replace(temporary, output)
    return stats


def build_app_delta_tar(base_path: Path, final_path: Path, output: Path) -> dict[str, int]:
    """Write the additive final-vs-base tree without extracting either tar."""

    return build_app_delta_tar_from_manifest(build_tar_manifest(base_path), final_path, output)


def oci_to_erofs(
    image: str,
    output: Path,
    *,
    pull_if_missing: bool = True,
    overlay_files: dict[str, bytes] | None = None,
) -> None:
    ensure_docker()
    record = inspect_image(image, pull_if_missing)
    config = record.get("Config") or {}
    BUILD_ROOT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".oci-export-", dir=BUILD_ROOT) as directory:
        rootfs_tar = Path(directory) / "rootfs.tar"
        created = run(
            [
                "docker",
                "container",
                "create",
                "--network",
                "none",
                "--entrypoint",
                "/bin/true",
                image,
            ],
            "create non-running OCI export container",
            capture=True,
        )
        container_id = created.stdout.strip()
        if len(container_id) < 12 or any(character not in "0123456789abcdef" for character in container_id):
            raise BuildError(f"Docker returned an invalid container ID: {container_id!r}")
        try:
            run(
                ["docker", "container", "export", "--output", rootfs_tar, container_id],
                "export merged OCI root filesystem",
            )
        finally:
            removed = subprocess.run(
                ["docker", "container", "rm", "--volumes", container_id],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            if removed.returncode:
                print(
                    f"warning: failed to remove temporary Docker container {container_id}",
                    file=sys.stderr,
                )

        replace_tar_files(rootfs_tar, overlay_files or {})

        selected_config = {
            key: config.get(key)
            for key in (
                "Entrypoint",
                "Cmd",
                "Env",
                "User",
                "WorkingDir",
                "ExposedPorts",
                "Labels",
                "StopSignal",
            )
        }
        source_metadata = {
            "kind": "docker-oci-image",
            "reference": image,
            "image_id": record.get("Id"),
            "repo_digests": record.get("RepoDigests"),
            "platform": "linux/amd64",
            "export_tar_sha256": sha256(rootfs_tar),
            "oci_runtime_config": selected_config,
        }
        build_erofs(
            rootfs_tar,
            output,
            input_mode="merged-rootfs-tar",
            source_metadata=source_metadata,
        )


def dockerfile_to_rootfs_tar(
    context: Path,
    output: Path,
    *,
    dockerfile: Path,
    build_arguments: list[str],
    target: str | None,
    build_network: str | None,
    overlay_files: dict[str, bytes | TarFile] | None = None,
) -> None:
    ensure_buildx()
    context = context.resolve()
    dockerfile = dockerfile.resolve()
    if not context.is_dir():
        raise BuildError(f"Docker build context is not a directory: {context}")
    if not dockerfile.is_file():
        raise BuildError(f"Dockerfile does not exist: {dockerfile}")
    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    command: list[str | os.PathLike[str]] = [
        "docker",
        "buildx",
        "build",
        "--platform",
        "linux/amd64",
        "--file",
        dockerfile,
        "--output",
        f"type=tar,dest={output}",
    ]
    if target:
        command.extend(["--target", target])
    if build_network:
        command.extend(["--network", build_network])
    for argument in build_arguments:
        if not argument or "\0" in argument:
            raise BuildError(f"invalid Docker build argument: {argument!r}")
        command.extend(["--build-arg", argument])
    command.append(context)
    run(command, "build and export Dockerfile root filesystem")
    if not output.is_file():
        raise BuildError("Docker Buildx completed without the rootfs tar exporter output")
    replace_tar_files(output, overlay_files or {})


def dockerfile_to_erofs(
    context: Path,
    output: Path,
    *,
    dockerfile: Path,
    build_arguments: list[str],
    target: str | None,
    build_network: str | None,
    overlay_files: dict[str, bytes | TarFile] | None = None,
    source_metadata: dict[str, object] | None = None,
) -> None:
    BUILD_ROOT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".dockerfile-export-", dir=BUILD_ROOT) as directory:
        rootfs_tar = Path(directory) / "rootfs.tar"
        dockerfile_to_rootfs_tar(
            context,
            rootfs_tar,
            dockerfile=dockerfile,
            build_arguments=build_arguments,
            target=target,
            build_network=build_network,
            overlay_files=overlay_files,
        )
        metadata = {
            "kind": "dockerfile-rootfs",
            "context": str(context),
            "dockerfile": str(dockerfile),
            "dockerfile_sha256": sha256(dockerfile),
            "platform": "linux/amd64",
            "target": target,
            "build_arguments": [argument.split("=", 1)[0] for argument in build_arguments],
            "export_tar_sha256": sha256(rootfs_tar),
        }
        if source_metadata:
            metadata.update(source_metadata)
        build_erofs(
            rootfs_tar,
            output,
            input_mode="merged-rootfs-tar",
            source_metadata=metadata,
        )


def resolve_init_binary(requested: Path | None) -> Path:
    init_binary = requested
    if init_binary is None:
        run(
            [
                "cargo",
                "build",
                "--locked",
                "--release",
                "--target",
                "x86_64-unknown-linux-musl",
                "--package",
                "minisandbox-init",
                "--bin",
                "minisandbox-init",
            ],
            "build standalone minisandbox guest init",
            cwd=REPOSITORY,
        )
        init_binary = (
            REPOSITORY
            / "target"
            / "x86_64-unknown-linux-musl"
            / "release"
            / "minisandbox-init"
        )
    else:
        init_binary = init_binary.resolve()
    validate_static_amd64_elf(init_binary)
    return init_binary


def build_debian(arguments: argparse.Namespace) -> None:
    ensure_docker()
    profile = REPOSITORY / "rootfs" / "debian-minimal"
    init_binary = resolve_init_binary(arguments.init_binary)
    source_name = (
        "debian-snapshot.sources" if arguments.apt_source == "snapshot" else "debian.sources"
    )
    BUILD_ROOT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".debian-context-", dir=BUILD_ROOT) as directory:
        context = Path(directory)
        shutil.copy2(profile / "Dockerfile", context / "Dockerfile")
        shutil.copy2(profile / source_name, context / "debian.sources")
        shutil.copy2(init_binary, context / "minisandbox-init")
        shutil.copy2(profile / "minisandbox-warm", context / "minisandbox-warm")
        shutil.copy2(
            REPOSITORY / "guest" / "pvm-linux" / "python-warm.py",
            context / "python-warm.py",
        )
        shutil.copy2(
            REPOSITORY / "guest" / "pvm-linux" / "block_stress.py",
            context / "block_stress.py",
        )
        command: list[str | os.PathLike[str]] = [
            "docker",
            "build",
            "--platform",
            "linux/amd64",
            "--tag",
            DEBIAN_IMAGE,
            "--label",
            f"io.minisandbox.debian.apt-source={arguments.apt_source}",
            "--file",
            context / "Dockerfile",
        ]
        if arguments.build_network:
            command.extend(["--network", arguments.build_network])
        command.append(context)
        run(command, "build Debian minimal OCI image")
    oci_to_erofs(
        DEBIAN_IMAGE,
        arguments.output,
        pull_if_missing=False,
        overlay_files={"etc/resolv.conf": (profile / "resolv.conf").read_bytes()},
    )


def build_hermes(arguments: argparse.Namespace) -> None:
    profile = REPOSITORY / "rootfs" / "hermes-agent"
    source = arguments.source.resolve()
    required = [
        source / "Dockerfile",
        source / "LICENSE",
        source / "agent",
        source / "hermes_cli",
        source / "package.json",
        source / "pyproject.toml",
    ]
    missing = [path for path in required if not path.exists()]
    if missing:
        missing_text = ", ".join(str(path.relative_to(source)) for path in missing)
        raise BuildError(
            f"Hermes source checkout is incomplete ({missing_text}); clone the complete "
            "repository or run `git sparse-checkout disable`"
        )
    checkout = git_checkout_metadata(source)
    if checkout["revision"] != HERMES_PROFILE:
        raise BuildError(
            f"Hermes source must be pinned to {HERMES_PROFILE}, got {checkout['revision']}"
        )
    if checkout["dirty"] and not arguments.allow_dirty:
        raise BuildError("Hermes source checkout is dirty; commit it or pass --allow-dirty")
    init_binary = resolve_init_binary(arguments.init_binary)
    resolver = (REPOSITORY / "rootfs" / "debian-minimal" / "resolv.conf").read_bytes()
    base_overlay_files: dict[str, bytes | TarFile] = {
        "usr/sbin/minisandbox-init": TarFile(init_binary.read_bytes(), 0o755),
        "opt/minisandbox/minisandbox-warm": TarFile(
            (REPOSITORY / "rootfs" / "debian-minimal" / "minisandbox-warm").read_bytes(),
            0o755,
        ),
        "opt/minisandbox/python-warm.py": TarFile(
            (REPOSITORY / "guest" / "pvm-linux" / "python-warm.py").read_bytes(),
            0o644,
        ),
        "opt/minisandbox/block_stress.py": TarFile(
            (REPOSITORY / "guest" / "pvm-linux" / "block_stress.py").read_bytes(),
            0o644,
        ),
        "etc/resolv.conf": resolver,
    }
    app_overlay_files: dict[str, bytes | TarFile] = {
        "usr/sbin/minisandbox-init": TarFile(init_binary.read_bytes(), 0o755),
        "opt/minisandbox/minisandbox-warm": TarFile(
            (profile / "minisandbox-warm").read_bytes(), 0o755
        ),
        "opt/minisandbox/hermes-warm.py": TarFile(
            (profile / "hermes-warm.py").read_bytes(), 0o644
        ),
        "opt/minisandbox/hermes-invoke.py": TarFile(
            (profile / "hermes-invoke.py").read_bytes(), 0o644
        ),
        "opt/minisandbox/hermes-launch.py": TarFile(
            (profile / "hermes-launch.py").read_bytes(), 0o644
        ),
        "etc/resolv.conf": resolver,
    }
    upstream_dockerfile = source / "Dockerfile"
    patched_dockerfile = patch_hermes_dockerfile(upstream_dockerfile.read_bytes())
    BUILD_ROOT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".hermes-dockerfile-", dir=BUILD_ROOT) as directory:
        dockerfile = Path(directory) / "Dockerfile"
        dockerfile.write_bytes(patched_dockerfile)
        base_tar = Path(directory) / "base.tar"
        final_tar = Path(directory) / "final.tar"
        app_tar = Path(directory) / "app.tar"
        build_arguments = [f"HERMES_GIT_SHA={HERMES_PROFILE}"]
        dockerfile_to_rootfs_tar(
            source,
            base_tar,
            dockerfile=dockerfile,
            build_arguments=build_arguments,
            target="minisandbox_hermes_base",
            build_network=arguments.build_network,
            overlay_files=base_overlay_files,
        )
        base_tar_sha256 = sha256(base_tar)
        base_manifest = build_tar_manifest(base_tar)
        common_metadata: dict[str, object] = {
            "kind": "hermes-agent-git",
            "dockerfile": str(upstream_dockerfile),
            "repository": "https://github.com/NousResearch/hermes-agent.git",
            "revision": HERMES_PROFILE,
            "source_checkout": checkout,
            "license": "MIT",
            "upstream_dockerfile_sha256": sha256(upstream_dockerfile),
            "patched_dockerfile_sha256": sha256(dockerfile),
            "dockerfile_compatibility_patch": HERMES_DOCKERFILE_PATCH,
            "python_bytecode": {
                "policy": HERMES_BYTECODE_POLICY,
                "invalidation_mode": "checked-hash",
                "optimization": 0,
                "forced_rebuild": True,
                "application_root": "/opt/hermes",
                "virtual_environment": "/opt/hermes/.venv",
            },
            "minisandbox_launch": {
                "init": "/sbin/minisandbox-init",
                "program": "/opt/hermes/.venv/bin/hermes",
                "user": "hermes",
                "uid": 10000,
                "gid": 10000,
                "working_directory": "/opt/data",
                "environment": {
                    "HOME": "/opt/data",
                    "HERMES_HOME": "/opt/data",
                    "HERMES_WRITE_SAFE_ROOT": "/opt/data",
                    "HERMES_DISABLE_LAZY_INSTALLS": "1",
                    "HERMES_WEB_DIST": "/opt/hermes/hermes_cli/web_dist",
                    "HERMES_TUI_DIR": "/opt/hermes/ui-tui",
                    "PLAYWRIGHT_BROWSERS_PATH": "/opt/hermes/.playwright",
                    "PYTHONDONTWRITEBYTECODE": "1",
                    "PYTHONUNBUFFERED": "1",
                    "PATH": "/opt/hermes/bin:/opt/hermes/.venv/bin:/opt/data/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                },
                "recommended_memory_mib": 2048,
                "recommended_shm_mib": 1024,
                "writable_paths": ["/opt/data", "/tmp", "/run", "/dev/shm"],
            },
        }
        build_erofs(
            base_tar,
            arguments.base_output,
            input_mode="merged-rootfs-tar",
            source_metadata={
                **common_metadata,
                "filesystem_role": "shared-runtime-base",
                "dockerfile_target": "minisandbox_hermes_base",
                "export_tar_sha256": base_tar_sha256,
            },
        )
        base_tar.unlink()
        dockerfile_to_rootfs_tar(
            source,
            final_tar,
            dockerfile=dockerfile,
            build_arguments=build_arguments,
            target="minisandbox_hermes_app",
            build_network=arguments.build_network,
            overlay_files=app_overlay_files,
        )
        delta_stats = build_app_delta_tar_from_manifest(base_manifest, final_tar, app_tar)
        build_erofs(
            app_tar,
            arguments.app_output,
            input_mode="merged-rootfs-tar",
            source_metadata={
                **common_metadata,
                "filesystem_role": "application-version-delta",
                "dockerfile_target": "minisandbox_hermes_app",
                "base_erofs": str(arguments.base_output.resolve()),
                "base_erofs_sha256": sha256(arguments.base_output.resolve()),
                "base_export_tar_sha256": base_tar_sha256,
                "final_export_tar_sha256": sha256(final_tar),
                "delta": delta_stats,
            },
        )


def validate_static_amd64_elf(path: Path) -> None:
    try:
        binary = path.read_bytes()
    except OSError as error:
        raise BuildError(f"cannot read guest init binary {path}: {error}") from error
    if (
        len(binary) < 64
        or binary[:4] != b"\x7fELF"
        or binary[4] != 2
        or binary[5] != 1
        or int.from_bytes(binary[16:18], "little") not in (2, 3)
        or int.from_bytes(binary[18:20], "little") != 62
    ):
        raise BuildError(f"guest init must be a little-endian ELF64 x86-64 binary: {path}")
    program_offset = struct.unpack_from("<Q", binary, 32)[0]
    entry_size = struct.unpack_from("<H", binary, 54)[0]
    entry_count = struct.unpack_from("<H", binary, 56)[0]
    if entry_size < 56 or not entry_count:
        raise BuildError(f"guest init has an invalid ELF program table: {path}")
    for index in range(entry_count):
        offset = program_offset + index * entry_size
        if offset + 56 > len(binary):
            raise BuildError(f"guest init has a truncated ELF program table: {path}")
        segment_type = struct.unpack_from("<I", binary, offset)[0]
        if segment_type == 3:  # PT_INTERP
            raise BuildError(f"guest init must not contain PT_INTERP: {path}")
        if segment_type != 2:  # PT_DYNAMIC
            continue
        dynamic_offset = struct.unpack_from("<Q", binary, offset + 8)[0]
        dynamic_size = struct.unpack_from("<Q", binary, offset + 32)[0]
        dynamic_end = dynamic_offset + dynamic_size
        if dynamic_end > len(binary) or dynamic_size % 16:
            raise BuildError(f"guest init has an invalid ELF dynamic table: {path}")
        terminated = False
        for entry in range(dynamic_offset, dynamic_end, 16):
            tag = struct.unpack_from("<q", binary, entry)[0]
            if tag == 1:  # DT_NEEDED
                raise BuildError(f"guest init must not contain DT_NEEDED: {path}")
            if tag == 0:  # DT_NULL
                terminated = True
                break
        if not terminated:
            raise BuildError(f"guest init has an unterminated ELF dynamic table: {path}")


def ext4_journal_size_mib(size_mib: int) -> int:
    """Keep small test images valid while capping production journal overhead."""

    return min(32, max(4, size_mib // 64))


def build_upper(arguments: argparse.Namespace) -> None:
    output = arguments.output.resolve()
    if arguments.size_mib < 64:
        raise BuildError("upper image must be at least 64 MiB")
    size = arguments.size_mib * 1024 * 1024
    if output.exists():
        raise BuildError(f"refusing to overwrite existing upper image {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        with output.open("xb") as image:
            image.truncate(size)
        with tempfile.TemporaryDirectory(prefix=".ext4-upper-", dir=output.parent) as directory:
            staging = Path(directory)
            (staging / "upper").mkdir()
            (staging / "work").mkdir()
            os.chmod(staging / "upper", 0o755)
            os.chmod(staging / "work", 0o755)
            run(
                [
                    "mkfs.ext4",
                    "-q",
                    "-F",
                    "-m",
                    "0",
                    "-b",
                    "4096",
                    "-J",
                    f"size={ext4_journal_size_mib(arguments.size_mib)}",
                    "-E",
                    "lazy_itable_init=0,lazy_journal_init=0,assume_storage_prezeroed=1",
                    "-O",
                    "sparse_super2,^64bit,^resize_inode",
                    "-L",
                    "msandbox-upper",
                    "-U",
                    EXT4_UPPER_UUID,
                    "-d",
                    staging,
                    output,
                ],
                "build sparse ext4 upper image",
            )
        run(["e2fsck", "-fn", output], "verify ext4 upper image")
    except BaseException:
        output.unlink(missing_ok=True)
        raise
    allocated = output.stat().st_blocks * 512
    metadata = {
        "kind": "minisandbox-overlay-upper",
        "format": "ext4",
        "logical_size": size,
        "allocated_size": allocated,
        "journal_size_mib": ext4_journal_size_mib(arguments.size_mib),
        "uuid": EXT4_UPPER_UUID,
        "directories": ["upper", "work"],
    }
    output.with_suffix(output.suffix + ".metadata.json").write_text(
        json.dumps(metadata, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"built {output} ({size} logical bytes, {allocated} allocated bytes)")


def build_actor_volume_template(arguments: argparse.Namespace) -> None:
    """Build the sparse ext4 seed imported into a new ActorBlockVolume."""

    output = arguments.output.resolve()
    if arguments.size_mib < 64:
        raise BuildError("ActorVolume template must be at least 64 MiB")
    size = arguments.size_mib * 1024 * 1024
    if output.exists():
        raise BuildError(f"refusing to overwrite existing ActorVolume template {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        with output.open("xb") as image:
            image.truncate(size)
        run(
            [
                "mkfs.ext4",
                "-q",
                "-F",
                "-m",
                "0",
                "-b",
                "4096",
                "-J",
                f"size={ext4_journal_size_mib(arguments.size_mib)}",
                "-E",
                "stride=1024,stripe-width=1024,lazy_itable_init=0,lazy_journal_init=0,assume_storage_prezeroed=1",
                "-O",
                "sparse_super2,^64bit,^resize_inode",
                "-L",
                "ms-workspace",
                "-U",
                ACTOR_VOLUME_TEMPLATE_UUID,
                output,
            ],
            "build immutable ext4 ActorVolume template",
        )
        run(["e2fsck", "-fn", output], "verify ext4 ActorVolume template")
        with tempfile.TemporaryDirectory(
            prefix="minisandbox-ext4-sparse-", dir=output.parent
        ) as directory:
            sparse = Path(directory) / output.name
            run(
                ["cp", "--reflink=never", "--sparse=always", output, sparse],
                "remove zero extents from ActorVolume template",
            )
            os.replace(sparse, output)
        run(["e2fsck", "-fn", output], "verify sparse ext4 ActorVolume template")
    except BaseException:
        output.unlink(missing_ok=True)
        raise
    allocated = output.stat().st_blocks * 512
    metadata = {
        "kind": "minisandbox-actor-volume-template",
        "format": "ext4",
        "logical_size": size,
        "allocated_size": allocated,
        "cos_object_size": 4 * 1024 * 1024,
        "journal_size_mib": ext4_journal_size_mib(arguments.size_mib),
        "uuid": ACTOR_VOLUME_TEMPLATE_UUID,
        "sha256": sha256(output),
    }
    output.with_suffix(output.suffix + ".metadata.json").write_text(
        json.dumps(metadata, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"built {output} ({size} logical bytes, {allocated} allocated bytes)")


def validate_app_layer(source: Path, input_mode: str) -> int:
    """Reject OCI-style whiteouts; the fixed EROFS layer is additive."""

    entry_count = 0

    def validate(path: str) -> None:
        nonlocal entry_count
        if Path(path).name.startswith(".wh."):
            raise BuildError(
                f"application layer contains unsupported OCI whiteout {path!r}; "
                "the fixed app EROFS may add or override paths but does not delete base paths"
            )
        entry_count += 1

    if input_mode == "directory":
        if not source.is_dir():
            raise BuildError(f"application layer source is not a directory: {source}")
        for root, directories, files in os.walk(source, followlinks=False):
            relative_root = Path(root).relative_to(source)
            for name in directories + files:
                validate(os.fspath(relative_root / name))
    elif input_mode == "merged-rootfs-tar":
        if not source.is_file():
            raise BuildError(f"application layer source is not a tar file: {source}")
        with tarfile.open(source, "r:") as archive:
            for member in archive:
                validate(normalized_tar_name(member.name))
    else:
        raise AssertionError(f"unexpected app layer input mode {input_mode}")
    return entry_count


def build_app(arguments: argparse.Namespace) -> None:
    source = arguments.source.resolve()
    input_mode = "directory" if source.is_dir() else "merged-rootfs-tar"
    if arguments.all_root and input_mode != "directory":
        raise BuildError("--all-root is accepted only for an application directory")
    entry_count = validate_app_layer(source, input_mode)
    build_erofs(
        source,
        arguments.output,
        input_mode=input_mode,
        source_metadata={
            "kind": "minisandbox-fixed-application-layer",
            "path": str(source),
            "entry_count": entry_count,
            "semantics": "add-or-override-only; mounted above base.erofs",
        },
        all_root=arguments.all_root,
    )


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build uncompressed, 2 MiB-aligned EROFS images for minisandbox"
    )
    commands = parser.add_subparsers(dest="command", required=True)

    debian = commands.add_parser("debian", help="build the maintained Debian minimal profile")
    debian.add_argument(
        "--output",
        type=Path,
        default=BUILD_ROOT / f"debian-{DEBIAN_PROFILE}-x86_64.erofs",
    )
    debian.add_argument("--apt-source", choices=("live", "snapshot"), default="live")
    debian.add_argument(
        "--build-network",
        metavar="MODE",
        help="pass an explicit Docker build network mode (for example, host)",
    )
    debian.add_argument(
        "--init-binary",
        type=Path,
        help=(
            "use a prebuilt static linux/amd64 minisandbox-init instead of building "
            "target/x86_64-unknown-linux-musl/release/minisandbox-init"
        ),
    )

    oci = commands.add_parser("oci", help="flatten a linux/amd64 OCI image with Docker")
    oci.add_argument("image")
    oci.add_argument("output", type=Path)

    dockerfile = commands.add_parser(
        "dockerfile",
        help="build a Dockerfile and convert its final linux/amd64 root filesystem",
    )
    dockerfile.add_argument("context", type=Path)
    dockerfile.add_argument("output", type=Path)
    dockerfile.add_argument(
        "--file",
        type=Path,
        help="Dockerfile path (defaults to <context>/Dockerfile)",
    )
    dockerfile.add_argument("--build-arg", action="append", default=[])
    dockerfile.add_argument("--target")
    dockerfile.add_argument("--build-network", metavar="MODE")

    hermes = commands.add_parser(
        "hermes",
        help="build pinned Hermes shared-base and application-delta EROFS images",
    )
    hermes.add_argument("--source", type=Path, default=HERMES_SOURCE)
    hermes.add_argument("--base-output", type=Path, default=HERMES_BASE_OUTPUT)
    hermes.add_argument("--app-output", type=Path, default=HERMES_APP_OUTPUT)
    hermes.add_argument("--build-network", metavar="MODE")
    hermes.add_argument("--init-binary", type=Path)
    hermes.add_argument(
        "--allow-dirty",
        action="store_true",
        help="allow a dirty pinned Hermes checkout and record that state in metadata",
    )

    tar = commands.add_parser("tar", help="convert an already-merged rootfs tar directly")
    tar.add_argument("source", type=Path)
    tar.add_argument("output", type=Path)

    directory = commands.add_parser("dir", help="convert an existing rootfs directory")
    directory.add_argument("source", type=Path)
    directory.add_argument("output", type=Path)
    directory.add_argument(
        "--all-root", action="store_true", help="replace every source uid/gid with root"
    )
    app = commands.add_parser(
        "app",
        help="build the fixed additive application EROFS layer from a directory or tar",
    )
    app.add_argument("source", type=Path)
    app.add_argument("output", type=Path)
    app.add_argument(
        "--all-root",
        action="store_true",
        help="replace every source uid/gid with root (directory input only)",
    )
    upper = commands.add_parser("upper", help="build a sparse ext4 OverlayFS upper image")
    upper.add_argument(
        "--output",
        type=Path,
        default=BUILD_ROOT / "minisandbox-upper-2g.ext4",
    )
    upper.add_argument(
        "--size-mib",
        type=int,
        default=DEFAULT_UPPER_SIZE // (1024 * 1024),
    )
    actor_volume_template = commands.add_parser(
        "actor-volume-template",
        help="build a sparse ext4 ActorBlockVolume seed",
    )
    actor_volume_template.add_argument(
        "--output",
        type=Path,
        default=BUILD_ROOT / "actor-volume-template-2g.ext4",
    )
    actor_volume_template.add_argument(
        "--size-mib",
        type=int,
        default=DEFAULT_ACTOR_VOLUME_SIZE // (1024 * 1024),
    )
    return parser.parse_args()


def main() -> int:
    arguments = parse_arguments()
    try:
        if arguments.command == "debian":
            build_debian(arguments)
        elif arguments.command == "hermes":
            build_hermes(arguments)
        elif arguments.command == "oci":
            oci_to_erofs(arguments.image, arguments.output)
        elif arguments.command == "dockerfile":
            context = arguments.context.resolve()
            dockerfile = (
                arguments.file.resolve()
                if arguments.file is not None
                else context / "Dockerfile"
            )
            dockerfile_to_erofs(
                context,
                arguments.output,
                dockerfile=dockerfile,
                build_arguments=arguments.build_arg,
                target=arguments.target,
                build_network=arguments.build_network,
            )
        elif arguments.command == "tar":
            source = arguments.source.resolve()
            build_erofs(
                source,
                arguments.output,
                input_mode="merged-rootfs-tar",
                source_metadata={
                    "kind": "merged-rootfs-tar",
                    "path": str(source),
                    "sha256": sha256(source),
                },
            )
        elif arguments.command == "dir":
            source = arguments.source.resolve()
            build_erofs(
                source,
                arguments.output,
                input_mode="directory",
                source_metadata={"kind": "directory", "path": str(source)},
                all_root=arguments.all_root,
            )
        elif arguments.command == "app":
            build_app(arguments)
        elif arguments.command == "upper":
            build_upper(arguments)
        elif arguments.command == "actor-volume-template":
            build_actor_volume_template(arguments)
        else:
            raise AssertionError(f"unknown command {arguments.command}")
    except (BuildError, OSError) as error:
        print(f"rootfs: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
