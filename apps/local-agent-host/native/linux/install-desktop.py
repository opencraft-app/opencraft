#!/usr/bin/python3
"""Explicit operator installation; observes an existing desktop, never starts one.

Run from a verified release's runtime/native-desktop directory. Does not change
legacy VNC, source display services, application configuration or network ingress.
"""
import argparse
import json
import os
import re
from pathlib import Path
import shutil
import socket
import stat
import struct
import subprocess
import sys
import tempfile


def check_directory(path):
    for item in [path, *path.parents]:
        info = item.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
            raise RuntimeError('Untrusted installation path')


def quote(value):
    if any(c in value for c in '\0\n\r'):
        raise ValueError('Invalid service argument')
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%').replace('$', '$$') + '"'


def binding(source_unit, display, xauthority):
    if not re.fullmatch(r'[A-Za-z0-9_.@:\-]+\.service', source_unit) or len(source_unit) > 200:
        raise ValueError('Invalid source unit')
    if not display.startswith(':') or not display[1:].isdigit() or len(display) > 4:
        raise ValueError('Invalid display')
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.connect('/tmp/.X11-unix/X' + display[1:])
        pid, uid, _ = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    if uid <= 0:
        raise RuntimeError('Expected an existing non-root desktop')
    proc = Path('/proc') / str(pid)
    executable = str((proc / 'exe').resolve(strict=True))
    if executable not in ['/usr/bin/Xvnc', '/usr/bin/Xtigervnc', '/usr/bin/Xvfb']:
        raise RuntimeError('Unsupported display server')
    metadata = Path(executable).stat()
    if metadata.st_uid != 0 or metadata.st_mode & 0o022:
        raise RuntimeError('Untrusted display executable')
    fields = subprocess.run(['/usr/bin/systemctl', 'show', source_unit,
                             '--property=ActiveState,ControlGroup'], check=True, capture_output=True).stdout.decode()
    state = dict(line.split('=', 1) for line in fields.splitlines())
    group = state.get('ControlGroup', '')
    if state.get('ActiveState') != 'active' or not group or not any(
            line.split(':', 2)[-1] == group or line.split(':', 2)[-1].startswith(group + '/')
            for line in (proc / 'cgroup').read_text().splitlines()):
        raise RuntimeError('Display is not owned by the selected active service')
    args = (proc / 'cmdline').read_bytes().decode().split('\0')[:-1]
    if not args or str(Path(args[0]).resolve()) != executable or display not in args:
        raise RuntimeError('Unexpected display command')
    authority = Path(xauthority).resolve(strict=True)
    if not authority.is_file() or authority.stat().st_uid not in [0, uid] or authority.stat().st_mode & 0o022:
        raise RuntimeError('Untrusted X authority')
    return dict(display=display, sourceUnit=source_unit, executable=executable, args=args[1:], uid=uid, xauthority=str(authority))


def replace(path, content, mode):
    if path.exists() and path.is_symlink():
        raise RuntimeError('Refusing symlink destination')
    if path.exists() and path.read_bytes() == content and stat.S_IMODE(path.stat().st_mode) == mode:
        return False
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as temporary:
        temporary.write(content)
        os.fchmod(temporary.fileno(), mode)
        pending = temporary.name
    os.replace(pending, path)
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-unit', required=True)
    parser.add_argument('--display', required=True)
    parser.add_argument('--xauthority', required=True)
    parser.add_argument('--control', action='store_true')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError('Operator installation requires root')
    if not Path('/usr/bin/x11vnc').is_file():
        raise RuntimeError('Install x11vnc before native desktop setup')
    configuration = binding(args.source_unit, args.display, args.xauthority)
    source = Path(__file__).resolve().parent
    destination = Path('/usr/local/libexec/opencraft')
    destination.mkdir(mode=0o755, parents=True, exist_ok=True)
    check_directory(destination)
    settings = Path('/etc/opencraft')
    settings.mkdir(mode=0o755, parents=True, exist_ok=True)
    check_directory(settings)
    changed = replace(settings / 'desktop.json', (json.dumps(configuration, sort_keys=True) + '\n').encode(), 0o600)
    for name in ['desktop-observer.py', 'desktop-control.py']:
        changed = replace(destination / name, (source / name).read_bytes(), 0o755) or changed
    # Import only the checked, installed observation primitive, not a product provider.
    import importlib.util
    spec = importlib.util.spec_from_file_location('observer', destination / 'desktop-observer.py')
    observer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(observer)
    unit = ('[Unit]\nDescription=OpenCraft immutable view-only desktop channel\n'
            'Requires=' + args.source_unit + '\nAfter=' + args.source_unit + '\n\n'
            '[Service]\nType=simple\nUser=' + str(configuration['uid']) + '\n'
            'ExecStart=' + ' '.join(quote(x) for x in ['/usr/bin/x11vnc', *observer.observer_arguments(configuration)]) + '\n'
            'NoNewPrivileges=true\nPrivateTmp=false\nProtectSystem=strict\nProtectHome=read-only\n'
            'Restart=on-failure\nRestartSec=3\n')
    units = Path('/etc/systemd/system')
    changed = replace(units / 'opencraft-desktop-observation.service', unit.encode(), 0o644) or changed
    for name in ['opencraft-desktop-observer-proxy.service', 'opencraft-desktop-control.service']:
        changed = replace(units / name, (source / name).read_bytes(), 0o644) or changed
    subprocess.run(['/usr/bin/systemctl', 'daemon-reload'], check=True)
    names = ['opencraft-desktop-observation.service', 'opencraft-desktop-observer-proxy.service']
    if args.control:
        names.append('opencraft-desktop-control.service')
    # Restarts affect only this added channel and its grants; never the source
    # X server, VNC, application or Agent. Unchanged installs preserve viewers.
    subprocess.run(['/usr/bin/systemctl', 'restart' if changed else 'start', *names], check=True)
    for name in names:
        subprocess.run(['/usr/bin/systemctl', 'is-active', '--quiet', name], check=True)
    observer.Runtime().identity()
    print(json.dumps({'installed': True, 'control': args.control, 'sourcePreserved': True}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Configuration contains X authority paths; do not export raw exceptions.
        print('Native desktop setup failed; no source desktop was restarted.', file=sys.stderr)
        sys.exit(1)
