#!/usr/bin/env python3
"""One content-addressed website Skill for image builds and credential-free TAT delivery."""
import argparse
import base64
import contextlib
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import stat
import tempfile
import uuid
import zlib

FILES = ('SKILL.md', 'scripts/package_fullstack.py')
HEX = re.compile(r'[0-9a-f]{64}')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def regular(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError('expected regular non-symlink bundle file')
    return path.read_bytes()


def build(source):
    source = Path(source)
    if source.is_symlink() or (source / 'scripts').is_symlink():
        raise ValueError('symlink source directory')
    files = {name: base64.b64encode(regular(source / name)).decode() for name in FILES}
    return {'version': hashlib.sha256(canonical(files)).hexdigest(), 'files': files}


def validate(data):
    if set(data) != {'version', 'files'} or set(data['files']) != set(FILES):
        raise ValueError('invalid bundle manifest')
    if data['version'] != hashlib.sha256(canonical(data['files'])).hexdigest():
        raise ValueError('bundle digest mismatch')
    for value in data['files'].values():
        raw = base64.b64decode(value, validate=True)
        if not raw or len(raw) > 1024 * 1024:
            raise ValueError('invalid bundle file size')
    return data


def encode(data):
    return base64.b64encode(zlib.compress(canonical(validate(data)), 9)).decode()


def decode(value):
    return validate(json.loads(zlib.decompress(base64.b64decode(value, validate=True))))


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_json(path, value):
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix='.receipt-')
    try:
        with os.fdopen(fd, 'wb') as out:
            out.write(canonical(value))
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, path)
        sync_dir(path.parent)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


@contextlib.contextmanager
def paths(home):
    home = Path(home).absolute()
    # Never traverse a redirected Hermes/skills directory, including for root image builds.
    for path in (home, home / '.hermes', home / '.hermes/skills', home / '.hermes/.lightvela'):
        if path.is_symlink():
            raise ValueError('symlink installation ancestor')
        path.mkdir(exist_ok=True)
    parent = home / '.hermes/skills'
    store = home / '.hermes/.lightvela/website-builder-releases'
    if store.is_symlink():
        raise ValueError('symlink release store')
    store.mkdir(mode=0o700, exist_ok=True)
    fd = os.open(store / '.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError('invalid lock')
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield parent / 'website-builder', store
    finally:
        os.close(fd)


def verify(target, expected):
    target = target.resolve(strict=True)
    manifest = json.loads(regular(target / 'bundle.json'))
    validate(manifest)
    if manifest['version'] != expected or build(target) != manifest:
        raise ValueError('installed bundle digest mismatch')
    return manifest


def exchange(left, right):
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == 'linux':
        rename = getattr(libc, 'renameat2', None)
        result = rename(-100, os.fsencode(left), -100, os.fsencode(right), 2) if rename else -1
    elif sys.platform == 'darwin':
        rename = getattr(libc, 'renamex_np', None)
        result = rename(os.fsencode(left), os.fsencode(right), 2) if rename else -1
    else:
        result = -1
    if result != 0:
        raise ValueError('atomic directory exchange unavailable; refusing non-atomic update')
    sync_dir(left.parent)
    sync_dir(right.parent)


def install(data, home):
    validate(data)
    version = data['version']
    with paths(home) as (active, store):
        target = store / version
        if target.is_symlink():
            raise ValueError('symlink version directory')
        if not target.exists():
            stage = Path(tempfile.mkdtemp(prefix='.stage-', dir=store))
            (stage / 'scripts').mkdir()
            for name, content in data['files'].items():
                path = stage / name
                with path.open('xb') as out:
                    out.write(base64.b64decode(content, validate=True))
                    out.flush()
                    os.fsync(out.fileno())
                path.chmod(0o644)
            write_json(stage / 'bundle.json', data)
            sync_dir(stage / 'scripts')
            sync_dir(stage)
            os.rename(stage, target)
            sync_dir(store)
        verify(target, version)
        if active.is_symlink() or (active.exists() and not active.is_dir()):
            raise ValueError('Skill target must be a real directory')
        if (active / 'bundle.json').exists():
            current = json.loads(regular(active / 'bundle.json'))['version']
            verify(active, current)
            if current == version:
                return {'active': version, 'action': 'install'}
        else:
            current = 'legacy' if active.exists() else None
        # A real directory stays discoverable to Hermes rglob and image curation.
        # Stage+exchange is atomic even for a legacy nonempty Skill directory.
        stage = store / ('.previous-' + uuid.uuid4().hex)
        shutil.copytree(target, stage)
        for name in (*FILES, 'bundle.json'):
            with (stage / name).open('rb') as stream:
                os.fsync(stream.fileno())
        sync_dir(stage / 'scripts')
        sync_dir(stage)
        write_json(store / (version + '.receipt.json'), {
            'version': version, 'previous': stage.name if current else None,
            'previous_version': current,
        })
        if active.exists():
            exchange(stage, active)
        else:
            os.replace(stage, active)
            sync_dir(active.parent)
            sync_dir(store)
        verify(active, version)
        return {'active': version, 'action': 'install'}


def rollback(expected, home):
    if not HEX.fullmatch(expected):
        raise ValueError('invalid expected version')
    with paths(home) as (active, store):
        if active.is_symlink() or not active.is_dir():
            raise ValueError('rollback current-version precondition failed')
        verify(active, expected)
        receipt = json.loads(regular(store / (expected + '.receipt.json')))
        previous = receipt.get('previous')
        previous_version = receipt.get('previous_version')
        if receipt.get('version') != expected or not previous or Path(previous).name != previous:
            raise ValueError('no prior Skill to restore')
        target = store / previous
        if target.is_symlink() or not target.is_dir():
            raise ValueError('previous Skill unavailable')
        if previous_version != 'legacy':
            verify(target, previous_version)
        elif not previous.startswith('.previous-') or not (target / 'SKILL.md').is_file():
            raise ValueError('invalid legacy backup')
        exchange(active, target)
        return {'active': previous_version, 'action': 'rollback', 'from': expected}


def command(data, action='install'):
    # Self-contained, compressed; no credentials, external download or mutable URL.
    validate(data)
    helper = base64.b64encode(zlib.compress(Path(__file__).read_bytes(), 9)).decode()
    entry = 'install(decode(PAYLOAD), Path.home())' if action == 'install' else 'rollback(decode(PAYLOAD)["version"], Path.home())'
    script = '#!/usr/bin/env bash\nset -euo pipefail\numask 077\npython3 - <<\'WEBSITE_SKILL_PY\'\n'
    script += 'import base64,zlib,json\n'
    script += f'ns = {{"__name__": "website_bundle"}}\nexec(compile(zlib.decompress(base64.b64decode({helper!r})), "website_skill_bundle", "exec"), ns)\n'
    script += f'ns["PAYLOAD"] = {encode(data)!r}\n'
    script += f'result = eval({entry!r}, ns)\n'
    script += 'print("WEBSITE_SKILL_RESULT=" + json.dumps(result, sort_keys=True))\nWEBSITE_SKILL_PY\n'
    if len(script.encode()) > 64000:
        raise ValueError('TAT command content exceeds conservative size budget')
    return script


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--home', type=Path)
    parser.add_argument('--command-output', type=Path)
    parser.add_argument('--action', choices=['install', 'rollback'], default='install')
    args = parser.parse_args()
    data = build(args.source)
    if args.home and args.command_output:
        parser.error('select install or command preparation, not both')
    if args.home:
        result = install(data, args.home) if args.action == 'install' else rollback(data['version'], args.home)
    elif args.command_output:
        with args.command_output.open('x') as out:
            out.write(command(data, args.action))
        args.command_output.chmod(0o600)
        result = {'version': data['version'], 'action': args.action}
    else:
        result = {'version': data['version']}
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    main()
