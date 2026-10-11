#!/usr/bin/env python3
"""Beijing-only CI pinning, canary, terminal-state and version verification."""
from __future__ import annotations

import base64
import collections
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time

ROOT = Path(__file__).resolve().parents[3]
OUTPUT = Path('/tmp/lightclaw-ci') / ('hermes-beijing-runtime-' + os.environ.get('BK_CI_BUILD_ID', 'unknown'))
TERMINAL = {'SUCCESS', 'FAILED', 'TIMEOUT', 'TASK_TIMEOUT', 'START_FAILED', 'DELIVER_FAILED', 'CANCELLED', 'TERMINATED'}


def cloud(service, action, **params):
    args = ['tccli', service, action, '--region', 'ap-beijing', '--output', 'json']
    for key, value in params.items():
        args += ['--' + key, json.dumps(value) if not isinstance(value, str) else value]
    result = subprocess.run(args, capture_output=True, text=True, timeout=90)
    if result.returncode:
        raise RuntimeError(f'{service}.{action} failed; raw response withheld')
    data = json.loads(result.stdout)
    return data.get('Response', data)


def task_results(command):
    results = []
    offset = 0
    while True:
        data = cloud('tat', 'DescribeInvocationTasks', Filters=[{'Name': 'command-id', 'Values': [command]}], Limit=100, Offset=offset, HideOutput=False)
        page = data.get('InvocationTaskSet', [])
        for task in page:
            safe = {key: task.get(key) for key in ('InstanceId', 'InvocationTaskId', 'TaskStatus')}
            safe['ExitCode'] = task.get('TaskResult', {}).get('ExitCode')
            output = base64.b64decode(task.get('TaskResult', {}).get('Output', '')).decode(errors='replace')
            safe['probe'] = None
            for line in output.splitlines():
                try:
                    candidate = json.loads(line)
                    if isinstance(candidate, dict) and candidate.get('probe') == 'hermes-runtime-pin':
                        safe['probe'] = candidate
                except ValueError:
                    pass
            results.append(safe)
        offset += len(page)
        if not page or offset >= data.get('TotalCount', 0):
            return results


def task_verified(row, expected):
    probe = row.get('probe') or {}
    return row['TaskStatus'] == 'SUCCESS' and row['ExitCode'] == 0 and probe.get('passed') is True and probe.get('expectedVersion') == expected and all(probe.get(key) == expected for key in ('cliVersion', 'importVersion', 'distributionVersion', 'identityVersion'))


def wait_verified(command, instances, expected):
    deadline = time.monotonic() + 1800
    while True:
        rows = task_results(command)
        selected = {row['InstanceId']: row for row in rows if row['InstanceId'] in instances}
        failed = [row for row in selected.values() if row['TaskStatus'] in TERMINAL and not task_verified(row, expected)]
        (OUTPUT / 'tasks.json').write_text(json.dumps(rows, indent=2))
        if failed:
            raise RuntimeError(f'{len(failed)} runtime tasks failed verification; see protected CI proof')
        if len(selected) == len(instances) and all(task_verified(row, expected) for row in selected.values()):
            return rows
        if time.monotonic() >= deadline:
            raise RuntimeError('runtime verification timed out')
        print(json.dumps({'phase': 'verify', 'states': dict(collections.Counter(row['TaskStatus'] for row in selected.values())), 'expected': len(instances)}), flush=True)
        time.sleep(15)


def inventory():
    env = dict(os.environ, HERMES_POOL_VM_LIST_ENVS='beijing-sandbox:ap-beijing:kubeconfig_beijing_sandbox', HERMES_LEGACY_POOL_IDS='pool-c2,pool-c3,pool-c4,pool-c5')
    result = subprocess.run(['bash', '.ci/runtime/commands/list_hermes_pool_vms.sh'], cwd=ROOT, env=env, capture_output=True, text=True, timeout=90)
    if result.returncode:
        raise RuntimeError('Beijing inventory query failed; raw response withheld')
    return [json.loads(line) for line in result.stdout.splitlines() if line.strip()]


def invoke(command, instances):
    receipts = []
    for offset in range(0, len(instances), 5):
        batch = instances[offset:offset + 5]
        data = cloud('tat', 'InvokeCommand', CommandId=command, InstanceIds=batch, Timeout=1200)
        receipts.append({'InvocationId': data['InvocationId'], 'InstanceIds': batch})
        with (OUTPUT / 'invocations.jsonl').open('a') as target:
            target.write(json.dumps(receipts[-1]) + '\n')
    return receipts


def run():
    os.umask(0o077)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    trigger = json.loads((ROOT / 'images/hermes-beijing-runtime-trigger').read_text())
    if trigger['region'] != 'ap-beijing' or trigger['environment'] != 'beijing-sandbox':
        raise RuntimeError('Beijing-only scope required')
    if not re.fullmatch(r'img-[a-z0-9]+', trigger['image_id']):
        raise ValueError('invalid target image')
    if not re.fullmatch(r'\d+\.\d+\.\d+', trigger['src_version']) or not re.fullmatch(r'[0-9a-f]{64}', trigger['archive_sha256']):
        raise ValueError('invalid target version or checksum')
    if not trigger['archive_url'].startswith('https://hermes-code-1325194254.cos.ap-guangzhou.myqcloud.com/hermes/'):
        raise ValueError('unexpected archive origin')
    deadline = time.monotonic() + 1800
    while True:
        rows = inventory()
        if not rows:
            raise RuntimeError('empty Beijing inventory')
        if any(row['pool_base_image'] != trigger['image_id'] for row in rows):
            raise RuntimeError('Beijing pool image differs from pin target')
        pending = [row for row in rows if row['state'] not in ('CLEAN', 'ALLOCATED', 'PAUSED')]
        if not pending:
            break
        if time.monotonic() >= deadline:
            raise RuntimeError('inventory reset convergence timed out')
        print(json.dumps({'phase': 'wait-inventory', 'pending': len(pending)}), flush=True)
        time.sleep(15)
    deferred = [row for row in rows if row['state'] == 'PAUSED']
    targets = [row for row in rows if row['state'] != 'PAUSED']
    if len({row['cloud_id'] for row in targets}) != len(targets):
        raise RuntimeError('duplicate cloud IDs in target inventory')
    (OUTPUT / 'scope.json').write_text(json.dumps({'targets': targets, 'deferredPaused': deferred}, indent=2))
    ids = [row['cloud_id'] for row in targets]
    if not ids:
        raise RuntimeError('no running runtime targets')
    current = []
    agents = []
    for offset in range(0, len(ids), 100):
        current += cloud('cvm', 'DescribeInstances', InstanceIds=ids[offset:offset + 100], Limit=100).get('InstanceSet', [])
        agents += cloud('tat', 'DescribeAutomationAgentStatus', InstanceIds=ids[offset:offset + 100], Limit=100).get('AutomationAgentSet', [])
    online = {agent['InstanceId'] for agent in agents if str(agent.get('AgentStatus', '')).lower() == 'online'}
    if not set(ids).issubset(online):
        raise RuntimeError('target VM TAT agent not online')
    vm_by_id = {vm['InstanceId']: vm for vm in current}
    for row in targets:
        vm = vm_by_id.get(row['cloud_id'], {})
        if vm.get('InstanceState') != 'RUNNING':
            raise RuntimeError('target VM is not running')
        if row['state'] == 'CLEAN' and vm.get('ImageId') != trigger['image_id']:
            raise RuntimeError('CLEAN VM has not adopted target image')
    source = (ROOT / 'images/helpers/pin-existing-hermes-runtime.py').read_text()
    shell = '#!/usr/bin/env bash\nset -euo pipefail\n'
    for key, value in [('HERMES_PIN_SRC_VERSION', trigger['src_version']), ('HERMES_PIN_ARCHIVE_URL', trigger['archive_url']), ('HERMES_PIN_SHA256', trigger['archive_sha256'])]:
        # Immutable checked-in non-secret values; shell quoting is explicit.
        shell += 'export ' + key + "='" + value.replace("'", "'\\''") + "'\n"
    shell += "python3 - <<'HERMES_PIN_PY'\n" + source + '\nHERMES_PIN_PY\n'
    digest = hashlib.sha256(shell.encode()).hexdigest()
    command_file = OUTPUT / 'command.json'
    if command_file.exists():
        checkpoint = json.loads(command_file.read_text())
        if checkpoint.get('trigger') != trigger or checkpoint.get('sourceSha256') != digest:
            raise RuntimeError('TAT checkpoint source or target differs from current build')
        command = checkpoint['CommandId']
    else:
        created = cloud('tat', 'CreateCommand', CommandName='hermes-beijing-runtime-' + os.environ.get('BK_CI_BUILD_NUM', str(int(time.time()))), Description='CI Beijing runtime pin; preserve paused VMs and user data; verify actual versions', Content=base64.b64encode(shell.encode()).decode(), CommandType='SHELL', Username='root', WorkingDirectory='/tmp', Timeout=1200)
        command = created['CommandId']
        command_file.write_text(json.dumps({'CommandId': command, 'trigger': trigger, 'sourceSha256': digest}))
    accepted = set()
    receipt_file = OUTPUT / 'invocations.jsonl'
    if receipt_file.exists():
        content = receipt_file.read_text()
        lines = content.splitlines()
        for index, line in enumerate(lines):
            try:
                accepted.update(json.loads(line)['InstanceIds'])
            except (ValueError, KeyError):
                if index != len(lines) - 1 or content.endswith('\n'):
                    raise RuntimeError('TAT receipt checkpoint is malformed')
    if not accepted.issubset(ids):
        raise RuntimeError('accepted TAT scope differs from current inventory')
    # Read provider receipts too: an API success may precede a local checkpoint crash.
    accepted.update(row['InstanceId'] for row in task_results(command))
    # Upgrade one allocated VM first; a bad installer must not reach the fleet.
    canary = next((row['cloud_id'] for row in targets if row['state'] == 'ALLOCATED'), ids[0])
    if canary not in accepted:
        invoke(command, [canary])
        accepted.add(canary)
    wait_verified(command, [canary], trigger['src_version'])
    invoke(command, [instance for instance in ids if instance not in accepted])
    verified = wait_verified(command, ids, trigger['src_version'])
    report = {'passed': True, 'verifiedCount': len(ids), 'deferredPausedCount': len(deferred), 'changedCount': sum(bool((row['probe'] or {}).get('changed')) for row in verified), 'version': trigger['src_version'], 'commandId': command}
    (OUTPUT / 'summary.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report), flush=True)


def main():
    try:
        run()
        return 0
    except Exception as error:
        print(json.dumps({'passed': False, 'reason': str(error) if isinstance(error, (RuntimeError, ValueError)) else type(error).__name__}), flush=True)
        return 1
