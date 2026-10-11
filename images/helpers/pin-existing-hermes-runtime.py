#!/usr/bin/env python3
"""Pin an existing Hermes source package while preserving profiles and sessions."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import time
import urllib.request


def checked_members(archive: tarfile.TarFile):
    members = archive.getmembers()
    for member in members:
        path = PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] != 'hermes-agent':
            raise ValueError('unexpected archive path')
        if not (member.isfile() or member.isdir()):
            raise ValueError('archive contains unsupported links or devices')
    return members


def source_version(path: Path) -> str:
    text = path.read_text()
    project = re.search(r'(?ms)^\[project\]\s*\n(.*?)(?=^\[|\Z)', text)
    match = re.search(r'(?m)^version\s*=\s*[\"\x27]([^\"\x27]+)', project.group(1)) if project else None
    if not match:
        raise ValueError('source version missing')
    return match.group(1)


def runtime_command(account, args, **kwargs):
    return subprocess.run(['sudo', '-u', account.pw_name, '-H', *args], check=True, **kwargs)


def identity_version(path: Path) -> str | None:
    text = path.read_text() if path.exists() else ''
    match = re.search(r'(?m)^runtime_version:\s*(.*?)\s*$', text)
    return match.group(1).strip('\"\x27') if match else None


def versions(account, runtime_dir: Path, identity: Path):
    result = {'cliVersion': None, 'importVersion': None, 'distributionVersion': None, 'identityVersion': identity_version(identity)}
    try:
        cli = runtime_command(account, ['/usr/local/bin/hermes', '--version'], capture_output=True, text=True, timeout=40)
        match = re.search(r'(?m)^Hermes Agent v(\d+\.\d+(?:\.\d+)?)', cli.stdout)
        result['cliVersion'] = match.group(1) if match else None
        code = 'import json,importlib.metadata as m,hermes_cli;print(json.dumps({"importVersion":getattr(hermes_cli,"__version__",None),"distributionVersion":m.version("hermes-agent")}))'
        package = runtime_command(account, [str(runtime_dir / 'venv/bin/python'), '-c', code], capture_output=True, text=True, timeout=40)
        package_versions = json.loads(package.stdout)
        result.update({key: package_versions.get(key) for key in ('importVersion', 'distributionVersion')})
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    return result


def active_gateway_units(account):
    runtime_env = ['env', f'XDG_RUNTIME_DIR=/run/user/{account.pw_uid}', 'systemctl', '--user']
    result = subprocess.run(['sudo', '-u', account.pw_name, '-H', *runtime_env, 'list-units', '--type=service', '--state=active', '--no-legend', '--plain'], capture_output=True, text=True, timeout=20)
    if result.returncode:
        # A VM with no user manager cannot have an active user gateway.
        if not Path(f'/run/user/{account.pw_uid}/bus').exists():
            return runtime_env, []
        raise RuntimeError('gateway unit discovery failed')
    units = [line.split()[0] for line in result.stdout.splitlines() if line.split() and re.fullmatch(r'hermes-gateway[A-Za-z0-9@_.-]*\.service', line.split()[0])]
    return runtime_env, units


def environment_checks(account):
    root = Path(account.pw_dir)
    result = {}
    for kind, relative in [('pip', '.config/pip/pip.conf'), ('uv', '.config/uv/uv.toml')]:
        path = root / relative
        result[kind + 'MirrorConfigured'] = path.is_file() and 'https://mirrors.tencent.com/pypi/simple' in path.read_text()
    result['systemdUserPermissionsValid'] = all((root / relative).is_dir() and (root / relative).stat().st_uid == account.pw_uid and stat.S_IMODE((root / relative).stat().st_mode) == 0o700 for relative in ('.config', '.config/systemd', '.config/systemd/user'))
    identity = Path('/etc/acli/identity.yaml').read_text()
    result['identityRuntimeMatches'] = bool(re.search(r'(?m)^runtime:\s*hermes\s*$', identity))
    result['identityRunAsMatches'] = bool(re.search(r'(?m)^run_as:\s*agentuser\s*$', identity))
    return result


def install_pin(account, archive_path: Path, expected: str, log, identity: Path | None = None):
    runtime_home = Path(account.pw_dir)
    data_home = runtime_home / '.hermes'
    runtime_dir = data_home / 'hermes-agent'
    identity = identity if identity is not None else Path('/etc/acli/identity.yaml')
    before = versions(account, runtime_dir, identity)
    if all(value == expected for value in before.values()):
        return dict(before, changed=False)
    if not runtime_dir.is_dir() or runtime_dir.is_symlink():
        raise RuntimeError('existing managed runtime directory missing or symlinked')
    if shutil.disk_usage(data_home).free < 1024 ** 3:
        raise RuntimeError('insufficient space for preserved runtime backup')
    identity_before = identity.read_bytes()
    stage = Path(tempfile.mkdtemp(prefix='.hermes-runtime-stage-', dir=data_home))
    backup_root = data_home / '.runtime-backups'
    backup_root.mkdir(mode=0o700, exist_ok=True)
    backup_root.chmod(0o700)
    backup = backup_root / ('hermes-agent-' + str(time.time_ns()))
    switched = False
    runtime_env, units = active_gateway_units(account)
    stopped = []
    try:
        with tarfile.open(archive_path, 'r:gz') as archive:
            archive.extractall(stage, members=checked_members(archive))
        new_dir = stage / 'hermes-agent'
        if source_version(new_dir / 'pyproject.toml') != expected:
            raise RuntimeError('pinned archive source version differs from expected version')
        installer = new_dir / 'scripts/install.sh'
        if not installer.is_file() or installer.is_symlink():
            raise RuntimeError('pinned installer missing or symlinked')
        for unit in units:
            runtime_command(account, [*runtime_env, 'stop', unit], stdout=log, stderr=log, timeout=60)
            stopped.append(unit)
        runtime_dir.rename(backup)
        new_dir.rename(runtime_dir)
        switched = True
        shutil.chown(runtime_dir, user=account.pw_uid, group=account.pw_gid)
        subprocess.run(['chown', '-R', f'{account.pw_uid}:{account.pw_gid}', str(runtime_dir)], check=True, stdout=log, stderr=log)
        for stage_name in ('venv', 'python-deps', 'node-deps'):
            runtime_command(account, ['bash', str(runtime_dir / 'scripts/install.sh'), '--skip-setup', '--dir', str(runtime_dir), '--hermes-home', str(data_home), '--non-interactive', '--stage', stage_name], stdout=log, stderr=log, timeout=600)
        uv = runtime_home / '.local/bin/uv'
        if not uv.is_file():
            raise RuntimeError('runtime uv executable missing')
        python = runtime_dir / 'venv/bin/python'
        runtime_command(account, [str(uv), 'pip', 'install', '--python', str(python), '--no-deps', '--reinstall-package', 'hermes-agent', '-e', str(runtime_dir)], stdout=log, stderr=log, timeout=180)
        runtime_command(account, [str(uv), 'pip', 'install', '--python', str(python), '--index-url', 'https://mirrors.tencent.com/pypi/simple', '--extra-index-url', 'https://mirrors.cloud.tencent.com/pypi/simple', 'lark-oapi==1.5.3', 'qrcode==7.4.2'], stdout=log, stderr=log, timeout=180)
        after = versions(account, runtime_dir, identity)
        if any(after[key] != expected for key in ('cliVersion', 'importVersion', 'distributionVersion')):
            raise RuntimeError('installed runtime version verification failed')
        checks = environment_checks(account)
        if not all(checks.values()):
            raise RuntimeError('runtime environment checks failed')
        identity_text = identity_before.decode()
        identity_text, count = re.subn(r'(?m)^runtime_version:.*$', 'runtime_version: ' + expected, identity_text)
        if not count:
            identity_text += '\nruntime_version: ' + expected + '\n'
        identity.write_text(identity_text)
        for unit in stopped:
            runtime_command(account, [*runtime_env, 'start', unit], stdout=log, stderr=log, timeout=60)
            runtime_command(account, [*runtime_env, 'is-active', '--quiet', unit], stdout=log, stderr=log, timeout=20)
        after = versions(account, runtime_dir, identity)
        if any(value != expected for value in after.values()):
            raise RuntimeError('final version verification failed')
        return dict(after, changed=True, gatewayUnitsRestored=len(stopped), previousSourcePreserved=True, **checks)
    except BaseException:
        if switched:
            for unit in stopped:
                subprocess.run(['sudo', '-u', account.pw_name, '-H', *runtime_env, 'stop', unit], stdout=log, stderr=log, timeout=60)
            failed = backup_root / ('failed-' + str(time.time_ns()))
            runtime_dir.rename(failed)
            backup.rename(runtime_dir)
            identity.write_bytes(identity_before)
        elif backup.exists() and not runtime_dir.exists():
            backup.rename(runtime_dir)
        for unit in stopped:
            subprocess.run(['sudo', '-u', account.pw_name, '-H', *runtime_env, 'start', unit], stdout=log, stderr=log, timeout=60)
        raise
    finally:
        shutil.rmtree(stage)


def main():
    expected = os.environ['HERMES_PIN_SRC_VERSION']
    url = os.environ['HERMES_PIN_ARCHIVE_URL']
    checksum = os.environ['HERMES_PIN_SHA256']
    if not re.fullmatch(r'\d+\.\d+\.\d+', expected) or not re.fullmatch(r'[0-9a-f]{64}', checksum):
        raise ValueError('invalid pinned version or checksum')
    if not url.startswith('https://hermes-code-1325194254.cos.ap-guangzhou.myqcloud.com/hermes/'):
        raise ValueError('unexpected archive origin')
    account = pwd.getpwnam('agentuser')
    runtime_dir = Path(account.pw_dir) / '.hermes/hermes-agent'
    before = versions(account, runtime_dir, Path('/etc/acli/identity.yaml'))
    report = {'probe': 'hermes-runtime-pin', 'expectedVersion': expected, 'before': before}
    if all(value == expected for value in before.values()):
        checks = environment_checks(account)
        if not all(checks.values()):
            raise RuntimeError('runtime environment checks failed')
        report.update(before, changed=False, passed=True, **checks)
        print(json.dumps(report))
        return
    with tempfile.TemporaryDirectory(prefix='hermes-runtime-pin-') as scratch:
        root = Path(scratch)
        archive = root / 'source.tar.gz'
        with urllib.request.urlopen(url, timeout=120) as response, archive.open('wb') as target:
            shutil.copyfileobj(response, target)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != checksum:
            raise RuntimeError('archive checksum mismatch')
        log_path = root / 'install.log'
        with log_path.open('w') as log:
            report.update(install_pin(account, archive, expected, log))
        checks = environment_checks(account)
        if not all(checks.values()):
            raise RuntimeError('runtime environment checks failed')
        report.update(checks)
        report['passed'] = True
        print(json.dumps(report))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Installer output may contain runtime credentials; never return it to CI.
        print(json.dumps({'probe': 'hermes-runtime-pin', 'passed': False, 'errorType': type(error).__name__, 'reason': str(error) if isinstance(error, (ValueError, RuntimeError)) else 'runtime pin failed; raw output withheld'}))
        raise SystemExit(1)
