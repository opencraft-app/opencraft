#!/usr/bin/env python3
"""Send an exact archive through authenticated TAT HTTPS APIs, without SSH/COS."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import time
import uuid


class Tat:
    def __init__(self, instance, region, profile=None):
        if not re.fullmatch(r'(?:ins|lhins)-[a-z0-9]+', instance):
            raise ValueError('Invalid instance ID')
        if not re.fullmatch(r'[a-z]+-[a-z]+', region):
            raise ValueError('Invalid region')
        self.instance, self.region, self.profile = instance, region, profile

    def call(self, action, payload):
        with tempfile.TemporaryDirectory() as folder:
            request = Path(folder) / 'request.json'
            request.write_text(json.dumps(payload))
            request.chmod(0o600)
            args = ['tccli', 'tat', action, '--region', self.region, '--timeout', '30',
                    '--cli-input-json', request.as_uri()]
            if self.profile:
                args += ['--profile', self.profile]
            result = subprocess.run(args, capture_output=True, text=True, timeout=40)
            if result.returncode:
                # Do not print a request or credential-bearing CLI diagnostic.
                raise RuntimeError('TAT ' + action + ' failed; inspect cloud audit records')
            return json.loads(result.stdout)

    def run(self, script, timeout=120):
        content = base64.b64encode(('set -euo pipefail\n' + script).encode()).decode()
        if len(content) > 65536:
            raise ValueError('TAT command exceeds API size limit')
        result = self.call('RunCommand', {'InstanceIds': [self.instance], 'Content': content,
            'CommandName': 'opencraft-relay-deploy', 'CommandType': 'SHELL', 'SaveCommand': False,
            'Username': 'opencraft-deploy', 'Timeout': timeout})
        invocation = result['InvocationId']
        deadline = time.monotonic() + timeout + 60
        while time.monotonic() < deadline:
            tasks = self.call('DescribeInvocationTasks', {'Filters': [
                {'Name': 'invocation-id', 'Values': [invocation]},
                {'Name': 'instance-id', 'Values': [self.instance]}], 'Limit': 1})
            rows = tasks.get('InvocationTaskSet', [])
            if rows:
                task = rows[0]
                state = task['TaskStatus']
                if state == 'SUCCESS':
                    if task.get('TaskResult', {}).get('ExitCode', 0) != 0:
                        raise RuntimeError('TAT command failed: ' + invocation)
                    return
                if state not in ('PENDING', 'DELIVERING', 'DELIVER_DELAYED', 'RUNNING'):
                    raise RuntimeError('TAT command failed: ' + invocation + ' (' + state + ')')
            time.sleep(2)
        # An unknown result must not be automatically replayed.
        raise RuntimeError('TAT result unknown; inspect invocation before retrying: ' + invocation)


def deploy(tat, archive, revision, digest):
    if not re.fullmatch(r'[a-f0-9]{40}', revision) or not re.fullmatch(r'[a-f0-9]{64}', digest):
        raise ValueError('Invalid deployment identity')
    data = Path(archive).read_bytes()
    if not data or len(data) > 64 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != digest:
        raise ValueError('Invalid deployment archive size or checksum')
    directory = '/home/opencraft-deploy/.relay-' + uuid.uuid4().hex
    # Every chunk is idempotent and isolated, never appended to a shared file.
    tat.run('umask 077\nmkdir ' + shlex.quote(directory))
    try:
        for index, offset in enumerate(range(0, len(data), 24000)):
            encoded = base64.b64encode(data[offset:offset + 24000]).decode()
            tat.run("printf '%s' " + shlex.quote(encoded) + ' | base64 -d > ' +
                    shlex.quote(directory + '/' + f'{index:06d}'))
        tat.run('cat ' + shlex.quote(directory) + '/* | sudo -n /usr/local/libexec/opencraft-relay-activate ' +
                revision + ' ' + digest, timeout=180)
    finally:
        # Cleanup cannot turn an ambiguous deployment result into a replay.
        try:
            tat.run('rm -rf -- ' + shlex.quote(directory))
        except Exception:
            print('Remote upload cleanup failed; inspect TAT audit records.', file=sys.stderr)
    print(json.dumps({'status': 'deployed', 'revision': revision, 'transport': 'tat-https'}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('artifact_directory', type=Path)
    parser.add_argument('--profile')
    args = parser.parse_args()
    revision = os.environ['GITHUB_SHA']
    archive = args.artifact_directory / ('opencraft-relay-' + revision + '.tgz')
    digest = Path(str(archive) + '.sha256').read_text().strip()
    deploy(Tat(os.environ['RELAY_INSTANCE_ID'], os.environ['RELAY_REGION'], args.profile), archive, revision, digest)


if __name__ == '__main__':
    main()
