#!/usr/bin/env python3
"""Stamp a native Electron fork distribution after a real desktop probe.

The script is intentionally runnable only on the native runner that built the
distribution. It records the exact fork definition, runtime versions, probe
result and every shipped file so electron-builder cannot silently use a stock
runtime or a stale artifact.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile


MARKER = 'opencraft-electron-desktop-artifact.json'


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def target_platform():
    if sys.platform == 'win32':
        return 'win32'
    if sys.platform == 'darwin':
        return 'darwin'
    if sys.platform.startswith('linux'):
        return 'linux'
    raise ValueError('Unsupported native runner: ' + sys.platform)


def target_arch():
    value = platform.machine().lower()
    if value in ('amd64', 'x86_64', 'x64'):
        return 'x64'
    if value in ('arm64', 'aarch64'):
        return 'arm64'
    raise ValueError('Unsupported native runner architecture: ' + value)


def executable_relative(platform_name):
    if platform_name == 'darwin':
        return Path('Electron.app/Contents/MacOS/Electron')
    if platform_name == 'win32':
        return Path('electron.exe')
    return Path('electron')


def probe_json(stdout):
    decoder = json.JSONDecoder()
    for offset, character in enumerate(stdout):
        if character != '{':
            continue
        try:
            value, _ = decoder.raw_decode(stdout[offset:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and value.get('nativeProbePassed') is True:
            return value
    raise ValueError('Native desktop probe did not emit a JSON result')


def inventory(distribution):
    entries = []
    for path in sorted(distribution.rglob('*')):
        relative = path.relative_to(distribution).as_posix()
        if relative == MARKER:
            continue
        if path.is_symlink():
            entries.append({'path': relative, 'type': 'symlink', 'target': os.readlink(path)})
        elif path.is_file():
            entries.append({'path': relative, 'type': 'file', 'size': path.stat().st_size, 'sha256': sha(path)})
        elif not path.is_dir():
            raise ValueError('Unsupported distribution entry: ' + relative)
    return entries


def extract_archive(archive, distribution):
    """Preserve executable bits and macOS framework links in Electron dist.zip.

    Validate before writing, and create links last so no archive entry can write
    through a link. A failed extraction leaves the destination untouched.
    """
    if archive.is_symlink():
        raise ValueError('distribution archive must not be a symlink')
    if distribution.is_symlink():
        raise ValueError('distribution directory must not be a symlink')
    archive = archive.resolve()
    distribution = distribution.resolve()
    if not archive.is_file():
        raise ValueError('distribution archive does not exist: ' + str(archive))
    if distribution.exists() and any(distribution.iterdir()):
        raise ValueError('archive extraction requires a fresh distribution directory')
    distribution.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as source:
        entries = {}
        for member in source.infolist():
            name = member.filename.rstrip('/')
            # ZIP paths are POSIX even on Windows. Reject Windows aliases too.
            if (not name or name.startswith('/') or '\\' in name or ':' in name
                    or any(p in ('', '.', '..') for p in name.split('/'))):
                raise ValueError('distribution archive contains an escaping path: ' + member.filename)
            if name.casefold() in entries:
                raise ValueError('distribution archive contains duplicate paths: ' + name)
            mode = member.external_attr >> 16 if member.create_system == 3 else 0
            kind = stat.S_IFMT(mode)
            if kind not in (0, stat.S_IFREG, stat.S_IFDIR, stat.S_IFLNK):
                raise ValueError('unsupported distribution archive entry: ' + name)
            link = source.read(member).decode('utf-8') if kind == stat.S_IFLNK else None
            if link is not None and (not link or '\\' in link or ':' in link or link.startswith('/')):
                raise ValueError('distribution archive contains an escaping link: ' + name)
            entries[name.casefold()] = (name, member, mode, link)
        for name, member, mode, link in entries.values():
            parts = name.split('/')
            for i in range(1, len(parts)):
                ancestor = entries.get('/'.join(parts[:i]).casefold())
                if ancestor and not ancestor[1].is_dir():
                    raise ValueError('distribution archive has a non-directory ancestor: ' + name)
        with tempfile.TemporaryDirectory(prefix='.electron-extract-', dir=distribution.parent) as temp:
            staging = Path(temp) / 'distribution'
            staging.mkdir()
            directories = []
            for name, member, mode, link in entries.values():
                destination = staging / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                if link is not None:
                    continue
                if member.is_dir():
                    destination.mkdir(exist_ok=True)
                    directories.append((destination, mode))
                else:
                    with source.open(member) as src, destination.open('wb') as dst:
                        shutil.copyfileobj(src, dst)
                    if mode:
                        destination.chmod(mode & 0o777)
            for name, member, mode, link in entries.values():
                if link is not None:
                    (staging / name).symlink_to(link)
            # Resolve the complete link graph (including cycles and chained
            # escapes), not just each link's immediate target.
            for name, member, mode, link in entries.values():
                if link is not None:
                    try:
                        target = (staging / name).resolve(strict=True)
                    except (OSError, RuntimeError) as error:
                        raise ValueError('invalid distribution archive link: ' + name) from error
                    if not target.is_relative_to(staging):
                        raise ValueError('distribution archive contains an escaping link: ' + name)
            for directory, mode in reversed(directories):
                if mode:
                    directory.chmod(mode & 0o777)
            if distribution.exists():
                distribution.rmdir()  # only the already-checked empty directory
            staging.rename(distribution)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--distribution', type=Path, required=True)
    parser.add_argument('--archive', type=Path,
                        help='Electron out/OpenCraft/dist.zip to extract into --distribution')
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--fork-definition', type=Path)
    parser.add_argument('--probe', type=Path)
    parser.add_argument('--probe-arg', action='append', default=[])
    args = parser.parse_args()

    here = Path(__file__).resolve().parent
    if args.distribution.is_symlink():
        raise ValueError('distribution directory must not be a symlink')
    distribution = args.distribution.resolve()
    source_root = args.source_root.resolve()
    definition = (args.fork_definition or (here / 'fork.json')).resolve()
    probe = (args.probe or (here / 'probe-desktop-distribution.cjs')).resolve()
    if ((not args.archive and not distribution.is_dir())
            or (args.archive and distribution.exists() and not distribution.is_dir())
            or not definition.is_file() or not probe.is_file()):
        raise ValueError('distribution, fork definition and probe must exist')
    marker_path = distribution / MARKER
    if marker_path.exists():
        raise ValueError('Use a fresh distribution directory, not an existing stamped artifact')
    if args.archive:
        extract_archive(args.archive, distribution)

    platform_name = target_platform()
    arch = target_arch()
    executable = distribution / executable_relative(platform_name)
    if not executable.is_file():
        raise ValueError('Missing native Electron executable: ' + str(executable))

    definition_bytes = definition.read_bytes()
    definition_sha256 = hashlib.sha256(definition_bytes).hexdigest()
    fork = json.loads(definition_bytes)
    verified = subprocess.run([
        sys.executable, str(here / 'manage.py'), 'verify', '--root', str(source_root),
    ], check=True, text=True, capture_output=True)
    source = json.loads(verified.stdout)

    environment = {key: value for key, value in os.environ.items()
                   if key not in ('ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH')}
    command = [str(executable), *args.probe_arg, str(probe)]
    completed = subprocess.run(command, env=environment, text=True, capture_output=True, timeout=180)
    args.evidence.mkdir(parents=True, exist_ok=True)
    (args.evidence / 'native-desktop.stdout.log').write_text(completed.stdout)
    (args.evidence / 'native-desktop.stderr.log').write_text(completed.stderr)
    completed.check_returncode()
    result = probe_json(completed.stdout)
    versions = result.get('versions') or {}
    if result.get('nativeProbePassed') is not True:
        raise ValueError('Native desktop probe did not pass')
    if versions.get('electron') != fork['version'] or versions.get('chrome') != fork['chromiumVersion']:
        raise ValueError('Native desktop runtime version does not match fork')

    final_verified = subprocess.run([
        sys.executable, str(here / 'manage.py'), 'verify', '--root', str(source_root),
    ], check=True, text=True, capture_output=True)
    if definition.read_bytes() != definition_bytes or json.loads(final_verified.stdout) != source:
        raise ValueError('Fork definition or verified source changed during artifact preparation')

    files = inventory(distribution)
    marker = {
        'schemaVersion': 1,
        'platform': platform_name,
        'arch': arch,
        'executable': executable.relative_to(distribution).as_posix(),
        'executableSha256': sha(executable),
        'forkDefinitionSha256': definition_sha256,
        'electronVersion': fork['version'],
        'chromiumVersion': fork['chromiumVersion'],
        'nativeProbePassed': True,
        'probe': result,
        'source': source,
        'files': files,
    }
    marker_path.write_text(json.dumps(marker, indent=2) + '\n')
    (args.evidence / 'native-desktop-result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({
        'artifactVerified': True,
        'platform': platform_name,
        'arch': arch,
        'files': len(files),
        'markerSha256': sha(marker_path),
    }))


if __name__ == '__main__':
    main()
