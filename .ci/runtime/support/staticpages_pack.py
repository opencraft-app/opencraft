from __future__ import annotations

import gzip
import hashlib
import mimetypes
import tarfile
import zlib
from dataclasses import dataclass
from pathlib import Path


DEFAULT_PACK_TARGET_BYTES = 32 * 1024 * 1024
DEFAULT_PACK_MAX_BYTES = 48 * 1024 * 1024


@dataclass(frozen=True)
class ReleaseBundle:
    manifest: dict[str, object]
    pack_paths: list[Path]


@dataclass(frozen=True)
class ArtifactFile:
    source: Path
    relative_path: str
    size: int
    sha256: str
    content_type: str
    compressed_size_estimate: int


def iter_files(artifact_dir: Path) -> list[Path]:
    candidates = list(artifact_dir.rglob("*"))
    symlinks = [path for path in candidates if path.is_symlink()]
    if symlinks:
        raise ValueError(f"artifact directory contains a symbolic link: {symlinks[0]}")
    files = [path for path in candidates if path.is_file()]
    if not files:
        raise ValueError(f"artifact directory is empty: {artifact_dir}")
    return sorted(files)


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _estimate_gzip_size(path: Path) -> int:
    compressor = zlib.compressobj(level=6, wbits=31)
    size = 0
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            size += len(compressor.compress(chunk))
    return size + len(compressor.flush())


def _artifact_files(artifact_dir: Path) -> list[ArtifactFile]:
    result = []
    for source in iter_files(artifact_dir):
        relative_path = source.relative_to(artifact_dir).as_posix()
        result.append(
            ArtifactFile(
                source=source,
                relative_path=relative_path,
                size=source.stat().st_size,
                sha256=_hash_file(source),
                content_type=mimetypes.guess_type(source.name)[0] or "application/octet-stream",
                compressed_size_estimate=_estimate_gzip_size(source),
            )
        )
    return result


def _initial_pack_groups(files: list[ArtifactFile], target_bytes: int) -> list[list[ArtifactFile]]:
    groups: list[list[ArtifactFile]] = []
    current: list[ArtifactFile] = []
    current_size = 0
    for file in files:
        if current and current_size + file.compressed_size_estimate > target_bytes:
            groups.append(current)
            current = []
            current_size = 0
        current.append(file)
        current_size += file.compressed_size_estimate
    if current:
        groups.append(current)
    return groups


def _write_deterministic_pack(path: Path, files: list[ArtifactFile]) -> None:
    with path.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, compresslevel=6, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
                for file in files:
                    info = tarfile.TarInfo(file.relative_path)
                    info.size = file.size
                    info.mode = file.source.stat().st_mode & 0o777 or 0o644
                    info.mtime = 0
                    info.uid = 0
                    info.gid = 0
                    info.uname = ""
                    info.gname = ""
                    with file.source.open("rb") as source:
                        archive.addfile(info, source)


def build_release_packs(
    artifact_dir: Path,
    output_dir: Path,
    *,
    target_bytes: int = DEFAULT_PACK_TARGET_BYTES,
    max_bytes: int = DEFAULT_PACK_MAX_BYTES,
) -> ReleaseBundle:
    if target_bytes <= 0 or max_bytes <= 0 or target_bytes > max_bytes:
        raise ValueError("pack size limits must satisfy 0 < target_bytes <= max_bytes")

    artifact_dir = artifact_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=False)
    files = _artifact_files(artifact_dir)
    emitted: list[tuple[Path, list[ArtifactFile], bool]] = []

    def emit(group: list[ArtifactFile]) -> None:
        candidate = output_dir / f"candidate-{len(emitted):04d}.tar.gz"
        _write_deterministic_pack(candidate, group)
        size = candidate.stat().st_size
        if size > max_bytes and len(group) > 1:
            candidate.unlink()
            midpoint = len(group) // 2
            emit(group[:midpoint])
            emit(group[midpoint:])
            return
        emitted.append((candidate, group, size > max_bytes))

    for group in _initial_pack_groups(files, target_bytes):
        emit(group)

    pack_paths: list[Path] = []
    pack_entries: list[dict[str, object]] = []
    file_entries: list[dict[str, object]] = []
    for index, (candidate, group, oversized) in enumerate(emitted, start=1):
        digest = _hash_file(candidate)
        name = f"pack-{index:04d}-{digest[:16]}.tar.gz"
        pack_path = candidate.with_name(name)
        candidate.rename(pack_path)
        pack_paths.append(pack_path)
        pack_entries.append(
            {
                "name": name,
                "compressed_size": pack_path.stat().st_size,
                "sha256": digest,
                "file_count": len(group),
                "oversized_single_file": oversized,
            }
        )
        for file in group:
            file_entries.append(
                {
                    "path": file.relative_path,
                    "size": file.size,
                    "sha256": file.sha256,
                    "content_type": file.content_type,
                    "pack": name,
                }
            )

    manifest: dict[str, object] = {
        "format_version": 1,
        "file_count": len(file_entries),
        "total_uncompressed_bytes": sum(file.size for file in files),
        "packs": pack_entries,
        "files": sorted(file_entries, key=lambda entry: str(entry["path"])),
    }
    return ReleaseBundle(manifest=manifest, pack_paths=pack_paths)
