#!/usr/bin/env python3
"""Upgrade via official ACLI with a fixed COS target and verify actual runtime."""
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


def install_pin(account, archive_path: Path, expected: str, log, *, blueprint: str, cos_version: str, display_version: str):
    runtime_dir = Path(account.pw_dir) / '.hermes/hermes-agent'
    identity = Path('/etc/acli/identity.yaml')
    before = versions(account, runtime_dir, identity)
    if all(value == expected for value in before.values()):
        return dict(before, changed=False)
    with tarfile.open(archive_path, 'r:gz') as archive:
        checked_members(archive)
        project = archive.extractfile('hermes-agent/pyproject.toml').read().decode()
        section = re.search(r'(?ms)^\[project\]\s*\n(.*?)(?=^\[|\Z)', project)
        match = re.search(r'(?m)^version\s*=\s*["\x27]([^"\x27]+)', section.group(1)) if section else None
        if not match or match.group(1) != expected:
            raise RuntimeError('pinned archive source version differs from expected version')
    runtime_env, units = active_gateway_units(account)
    # An available backend command may still carry stale blueprint -> COS mappings.
    # Refresh before starting the official transaction; pass the fixed COS target
    # explicitly so a missing mapping cannot silently select its default package.
    runtime_command(account, ['acli', 'bundle-update'], stdout=log, stderr=log, timeout=180)
    runtime_command(account, ['acli', 'backend', 'upgrade-start', '--blueprint-id', blueprint,
                    '--cos-version', cos_version, '--display-version', display_version,
                    '--wait=true', '--force=true'], stdout=log, stderr=log, timeout=1100)
    after = versions(account, runtime_dir, identity)
    if any(value != expected for value in after.values()):
        raise RuntimeError('official upgrade completed but actual runtime version differs from target')
    for unit in units:
        runtime_command(account, [*runtime_env, 'is-active', '--quiet', unit], stdout=log, stderr=log, timeout=20)
    checks = environment_checks(account)
    if not all(checks.values()):
        raise RuntimeError('runtime environment checks failed')
    return dict(after, changed=True, gatewayUnitsVerified=len(units), officialBackendUpgrade=True, **checks)


def main():
    expected = os.environ['HERMES_PIN_SRC_VERSION']
    url = os.environ['HERMES_PIN_ARCHIVE_URL']
    checksum = os.environ['HERMES_PIN_SHA256']
    if not re.fullmatch(r'\d+\.\d+\.\d+', expected) or not re.fullmatch(r'[0-9a-f]{64}', checksum):
        raise ValueError('invalid pinned version or checksum')
    if not url.startswith('https://hermes-code-1325194254.cos.ap-guangzhou.myqcloud.com/hermes/'):
        raise ValueError('unexpected archive origin')
    blueprint = os.environ['HERMES_PIN_BLUEPRINT_ID']
    cos_version = os.environ['HERMES_PIN_COS_VERSION']
    display_version = os.environ['HERMES_PIN_DISPLAY_VERSION']
    if not re.fullmatch(r'lhbp-[A-Za-z0-9]+', blueprint) or not re.fullmatch(r'hermes-agent-v[0-9]{8}', cos_version) or not re.fullmatch(r'[0-9]+(?:\.[0-9]+){2}', display_version):
        raise ValueError('invalid official backend target')
    if not url.endswith('/' + cos_version + '/hermes-agent.tar.gz'):
        raise ValueError('COS package differs from pinned archive')
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
            report.update(install_pin(account, archive, expected, log, blueprint=blueprint, cos_version=cos_version, display_version=display_version))
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
