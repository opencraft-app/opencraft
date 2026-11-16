#!/usr/bin/env python3
"""Root-owned fixed deployment receiver; runtime artifacts never execute as root."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

ROOT = Path('/opt/opencraft-relay')
SERVICE = 'opencraft-relay.service'
MAX_BYTES = 64 * 1024 * 1024
FILES = {'README.md', 'access-admin.mjs', 'hub-admin.mjs', 'package.json', 'relay.mjs'}


def verify_archive(archive, revision, digest):
    if not re.fullmatch(r'[a-f0-9]{40}', revision) or not re.fullmatch(r'[a-f0-9]{64}', digest):
        raise ValueError('Invalid deployment identity')
    if hashlib.sha256(Path(archive).read_bytes()).hexdigest() != digest:
        raise ValueError('Archive checksum mismatch')
    with tarfile.open(archive, 'r:gz') as source:
        members = []
        for member in source:
            members.append(member)
            if len(members) > len(FILES) + 1:
                raise ValueError('Too many archive members')
        if (len(members) != len(FILES) + 1 or {m.name for m in members} != FILES | {'build-manifest.json'}
                or any(not m.isfile() or m.size > MAX_BYTES for m in members)
                or sum(m.size for m in members) > MAX_BYTES):
            raise ValueError('Unsafe deployment archive')
        data = {m.name: source.extractfile(m).read() for m in members}
    manifest = json.loads(data['build-manifest.json'])
    if (manifest.get('schemaVersion') != 1 or manifest.get('application') != 'opencraft-relay'
            or manifest.get('sourceRevision') != revision or set(manifest.get('files', {})) != FILES):
        raise ValueError('Deployment manifest identity mismatch')
    for name in FILES:
        if hashlib.sha256(data[name]).hexdigest() != manifest['files'][name]:
            raise ValueError('Payload checksum mismatch')
    return data


def health(revision):
    for _ in range(40):
        try:
            with urllib.request.urlopen('http://127.0.0.1:18090/__opencraft_relay/health', timeout=2) as response:
                body = json.load(response)
            if body.get('ok') is True and body.get('sourceRevision') == revision:
                return
        except (OSError, ValueError):
            pass
        time.sleep(.5)
    raise RuntimeError('Expected relay revision did not become healthy')


def initialize_hub(config_root=Path('/etc/opencraft-relay'), management_origin='http://127.0.0.1:18090'):
    credential = json.loads((config_root / 'operator.json').read_text())['credential']
    endpoint = (config_root / 'endpoint').read_text().strip()
    url = management_origin + '/__opencraft_hub/operator'
    headers = {'Authorization': 'Bearer ' + credential, 'Content-Type': 'application/json'}
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=10) as response:
        snapshot = json.load(response)
    command = {'action': 'configure', 'revision': snapshot['revision'], 'name': 'OpenCraft Relay',
               'endpoint': endpoint, 'origin': '', 'accepting': True, 'forwarding': True}
    with urllib.request.urlopen(urllib.request.Request(url, data=json.dumps(command).encode(), headers=headers), timeout=10) as response:
        result = json.load(response)
    if result.get('conflict') or not result.get('snapshot', {}).get('accepting'):
        raise RuntimeError('Initial Hub configuration failed')


def replace_link(target):
    temporary = ROOT / 'current.new'
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(target)
    os.replace(temporary, ROOT / 'current')


def activate(archive, revision, digest):
    data = verify_archive(archive, revision, digest)
    with (ROOT / '.deployment.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        release = ROOT / 'releases' / (revision + '-' + digest[:16])
        if release.exists():
            if any((release / name).read_bytes() != body for name, body in data.items()):
                raise ValueError('An immutable release changed')
        else:
            staging = Path(tempfile.mkdtemp(prefix='.candidate-', dir=ROOT / 'releases'))
            try:
                for name, body in data.items():
                    (staging / name).write_bytes(body)
                    (staging / name).chmod(0o644)
                staging.chmod(0o755)
                subprocess.run(['/opt/opencraft-node/bin/node', '--check', str(staging / 'relay.mjs')], check=True, stdout=subprocess.DEVNULL)
                staging.rename(release)
            finally:
                if staging.exists():
                    shutil.rmtree(staging)
        current = ROOT / 'current'
        previous = current.resolve() if current.is_symlink() else None
        if previous is not None and previous.parent != (ROOT / 'releases').resolve():
            raise ValueError('Invalid previous release')
        replace_link(release)
        try:
            subprocess.run(['systemctl', 'restart', SERVICE], check=True)
            health(revision)
            if previous is None:
                initialize_hub()
        except Exception as error:
            if previous is not None:
                replace_link(previous)
                subprocess.run(['systemctl', 'restart', SERVICE], check=True)
                health(json.loads((previous / 'build-manifest.json').read_text())['sourceRevision'])
            else:
                subprocess.run(['systemctl', 'stop', SERVICE], check=True)
                current.unlink(missing_ok=True)
            raise RuntimeError('Candidate failed (' + type(error).__name__ + '); previous release restored or first deployment stopped')
    print(json.dumps({'status': 'deployed', 'revision': revision}))


def main():
    if len(sys.argv) != 3:
        raise ValueError('Expected revision and archive checksum')
    revision, digest = sys.argv[1:]
    archive = None
    try:
        with tempfile.NamedTemporaryFile(dir=ROOT / 'incoming', delete=False) as output:
            archive = Path(output.name)
            size = 0
            while True:
                chunk = sys.stdin.buffer.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_BYTES:
                    raise ValueError('Deployment exceeds archive limit')
                output.write(chunk)
        activate(archive, revision, digest)
    finally:
        if archive is not None:
            archive.unlink(missing_ok=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Relay deployment failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
