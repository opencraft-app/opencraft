"""Remove generated Hermes state only after its gateway is stopped for image capture.

Not an instance repair tool: the caller must reject provisioned credentials first.
Skills, installed dependencies and runtime configuration are intentionally retained.
"""
from pathlib import Path
import shutil
import sys

FILES = (
    'install_id', '.install_id.lock', 'gateway.lock', 'gateway.sock', 'gateway.pid',
    'gateway_state.json', 'gateway-starts.log', 'channel_directory.json',
    'state.db', 'state.db-wal', 'state.db-shm', 'shared-state.db',
    'shared-state.db-wal', 'shared-state.db-shm', 'kanban.db', 'kanban.db-wal',
    'kanban.db-shm', 'kanban.db.dispatch.lock', 'kanban.db.init.lock',
    'state.db.auto-maintenance.lock', 'state.db.fts_rebuild.lock', 'auth.lock',
)
DIRECTORIES = (
    'sessions', 'logs', 'cache', 'image_cache', 'audio_cache', 'pending_messages',
    'pairing', 'backups',
)


def clean_runtime(home):
    home = Path(home)
    if not home.is_absolute() or home == Path('/') or home.is_symlink():
        raise ValueError('invalid runtime home')
    root = home / '.hermes'
    if root.is_symlink():
        raise ValueError('runtime root must not be a symlink')
    # Validate the whole removal set before modifying any entry.
    for name in FILES + DIRECTORIES:
        path = root / name
        if path.is_symlink():
            raise ValueError('runtime cleanup target must not be a symlink')
        if path.exists() and ((name in DIRECTORIES) != path.is_dir()):
            raise ValueError('unexpected runtime cleanup target type')
    for name in FILES:
        (root / name).unlink(missing_ok=True)
    for name in DIRECTORIES:
        path = root / name
        if path.exists():
            shutil.rmtree(path)


def clean_identity(root):
    """Clear builder identity at capture time; root permits isolated fixture testing."""
    root = Path(root)
    if not root.is_absolute() or root.is_symlink():
        raise ValueError('invalid image root')
    machine = root / 'etc/machine-id'
    dbus = root / 'var/lib/dbus/machine-id'
    keys = list((root / 'etc/ssh').glob('ssh_host_*'))
    authorized = [root / 'root/.ssh/authorized_keys']
    authorized += list((root / 'home').glob('*/.ssh/authorized_keys'))
    targets = [machine] + keys + authorized
    if dbus.is_symlink():
        if str(dbus.readlink()) not in ('/etc/machine-id', '../../../etc/machine-id'):
            raise ValueError('unexpected dbus machine-id link')
    else:
        targets.append(dbus)
    for path in targets:
        if path.is_symlink() or (path.exists() and not path.is_file()):
            raise ValueError('unexpected identity target type')
        for parent in path.parents:
            if parent == root:
                break
            if parent.is_symlink():
                raise ValueError('identity parent must not be a symlink')
    for path in [machine, *authorized]:
        if path.exists():
            path.write_text('')
    if not dbus.is_symlink() and dbus.exists():
        dbus.write_text('')
    for path in keys:
        path.unlink()


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('usage: hermes_capture_cleanup.py ABSOLUTE_RUNTIME_HOME')
    clean_runtime(sys.argv[1])
    clean_identity(Path('/'))
