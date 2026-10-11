#!/usr/bin/env python3
"""Bounded official-upgrade recovery; no source replacement or credential edits."""
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import subprocess

spec = importlib.util.spec_from_file_location('runtime_checks', Path(__file__).with_name('pin-existing-hermes-runtime.py'))
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)
EXPECTED = '0.21.5'
REGISTRY = 'https://registry.npmjs.org'


def identity_valid(text, home):
    required = {'runtime': 'hermes', 'run_as': 'agentuser', 'runtime_home': str(home / '.hermes')}
    for key, expected in required.items():
        match = re.search(r'^' + key + r':\s*(.*?)\s*$', text, re.M)
        if not match or match.group(1).strip('\"\x27') != expected:
            return False
    return True


def upgrade_command():
    return ['/usr/local/bin/acli', 'backend', 'upgrade-start', '--blueprint-id', 'lhbp-7wrz1nyu',
            '--cos-version', 'hermes-agent-v20260928', '--display-version', '2026.9.24',
            '--wait=true', '--force=true']


def completed(status, versions):
    return status == 'COMPLETED:2026.9.24' and all(versions.get(k) == EXPECTED for k in
        ('cliVersion', 'importVersion', 'distributionVersion', 'identityVersion'))


def main():
    os.umask(0o077)
    if os.geteuid() != 0:
        raise RuntimeError('recovery requires root TAT execution')
    account = pwd.getpwnam('agentuser')
    home = Path(account.pw_dir)
    identity = Path('/etc/acli/identity.yaml')
    if not identity_valid(identity.read_text(), home):
        raise RuntimeError('identity runtime, home or run_as mismatch')
    state = Path('/etc/acli/hermes')
    pid_file = state / 'upgrade_pid'
    if pid_file.exists():
        pid = pid_file.read_text().strip()
        if pid.isdigit() and Path('/proc', pid).exists():
            raise RuntimeError('an upgrade process may still be active')
    runtime = home / '.hermes/hermes-agent'
    before = checks.versions(account, runtime, identity)
    status_file = state / 'upgrade_status'
    status = status_file.read_text().strip() if status_file.exists() else ''
    runtime_env, active_units = checks.active_gateway_units(account)
    changed = not completed(status, before)
    if changed:
        state.mkdir(parents=True, exist_ok=True)
        with (state / 'ci-recovery.log').open('w') as log:
            checks.runtime_command(account, ['acli', 'bundle-update'], stdout=log, stderr=log, timeout=180)
            if not identity_valid(identity.read_text(), home):
                raise RuntimeError('bundle refresh changed runtime identity')
            # The capability requires root. Calling ACLI as root retains this
            # explicit registry override; non-root ACLI's sudo allowlist drops it.
            # Runtime ownership/home still come from the verified agentuser identity.
            env = dict(os.environ, ACLI_NPM_REGISTRY=REGISTRY, ACLI_NPM_BINARY_MIRROR_BASE='off',
                       ACLI_IDENTITY_PATH=str(identity), ACLI_DISABLE_IDENTITY_SELF_HEAL='1')
            subprocess.run(upgrade_command(), env=env, stdout=log, stderr=log, check=True, timeout=1900)
    after = checks.versions(account, runtime, identity)
    if not completed(status_file.read_text().strip(), after):
        raise RuntimeError('official upgrade did not complete at the expected version')
    for unit in sorted(set(active_units + ['hermes-gateway.service'])):
        checks.runtime_command(account, [*runtime_env, 'is-active', '--quiet', unit], capture_output=True, timeout=20)
    if not all(checks.environment_checks(account).values()):
        raise RuntimeError('runtime environment verification failed')
    print(json.dumps(dict(probe='hermes-production-recovery', expectedVersion=EXPECTED,
                          passed=True, gatewayActive=True, upgradeCompleted=True, changed=changed, **after)))


if __name__ == '__main__':
    main()
