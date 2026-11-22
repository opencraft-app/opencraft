#!/usr/bin/env python3
"""Run inside a disposable E2B build VM, with operator-pinned kernel artifacts.

Usage: sudo python3 install-guest-nfs.py ARCHIVE MANIFEST ARCHIVE_SHA256 KERNEL
The common Hands image supplies nfs-common; install kmod before this adapter.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile


def install(archive, manifest_file, expected_sha, kernel):
    if not __debug__:
        raise RuntimeError("Kernel artifact validation requires Python assertions enabled")
    assert os.geteuid() == 0, 'Run inside the build guest as root'
    assert os.uname().release == kernel, 'Modules must match the running guest kernel'
    assert len(expected_sha) == 64 and all(c in '0123456789abcdef' for c in expected_sha)
    manifest = json.loads(Path(manifest_file).read_text())
    assert manifest['kernel'] == kernel
    assert manifest['archiveSha256'] == expected_sha
    with Path(archive).open('rb') as handle:
        assert hashlib.file_digest(handle, 'sha256').hexdigest() == expected_sha
    prefix = 'usr/lib/modules/' + kernel + '/'
    expected = {entry['path'].lstrip('/'): entry for entry in manifest['modules']}
    assert len(expected) == len(manifest['modules']) and expected
    payload = {}
    with tarfile.open(archive) as tar:
        for item in tar.getmembers():
            assert item.isfile() and item.name.startswith(prefix)
            assert '..' not in Path(item.name).parts and item.name not in payload
            assert item.name in expected or item.name in {prefix + 'modules.builtin', prefix + 'modules.builtin.modinfo'}
            payload[item.name] = tar.extractfile(item).read()
    for name, entry in expected.items():
        assert name.startswith(prefix + 'kernel/') and name.endswith('.ko')
        assert len(payload[name]) == entry['bytes']
        assert hashlib.sha256(payload[name]).hexdigest() == entry['sha256']
    # Validate every member before writing any module into the guest.
    for name, data in payload.items():
        target = Path('/') / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        target.chmod(0o644)
    (Path('/usr/lib/modules') / kernel / 'modules.order').write_text(
        ''.join(name.removeprefix(prefix) + '\n' for name in expected))
    subprocess.run(['depmod', '-a', kernel], check=True)
    for module in ['nfsv3', 'nfsv4']:
        subprocess.run(['modprobe', module], check=True)
    filesystems = Path('/proc/filesystems').read_text().split()
    assert 'nfs' in filesystems and 'nfs4' in filesystems
    subprocess.run(['mount.nfs', '-V'], check=True, capture_output=True)
    provenance = Path('/usr/local/share/e2b-volume')
    provenance.mkdir(parents=True, exist_ok=True)
    (provenance / 'nfs-modules.json').write_text(json.dumps(manifest, indent=2) + '\n')
    Path('/etc/modules-load.d/e2b-nfs.conf').write_text('nfsv3\nnfsv4\n')
    dropin = Path('/etc/systemd/system/envd.service.d')
    dropin.mkdir(parents=True, exist_ok=True)
    (dropin / 'nfs-client.conf').write_text(
        '[Unit]\nWants=systemd-modules-load.service\nAfter=systemd-modules-load.service\n')
    subprocess.run(['systemctl', 'daemon-reload'], check=True)
    os.sync()
    print('GUEST_NFS_CLIENT_READY')


if __name__ == '__main__':
    assert len(sys.argv) == 5, __doc__
    install(*sys.argv[1:])
