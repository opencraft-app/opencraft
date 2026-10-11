"""Explicit Singapore failure recovery via CI, with per-instance terminal checks."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time

ROOT = Path(__file__).resolve().parents[3]
TERMINAL = {'SUCCESS', 'FAILED', 'TIMEOUT', 'TASK_TIMEOUT', 'START_FAILED', 'DELIVER_FAILED', 'CANCELLED', 'TERMINATED'}


def validate_plan(plan):
    if plan.get('region') != 'ap-singapore' or plan.get('environment') != 'sgprod':
        raise ValueError('this recovery is scoped to Singapore production')
    ids = plan.get('instances', [])
    if not 1 <= len(ids) <= 5 or len(set(ids)) != len(ids) or any(not re.fullmatch(r'ins-[a-z0-9]+', x) for x in ids):
        raise ValueError('one to five explicit unique instance IDs required')
    for key, pattern in [('image_id', r'img-[a-z0-9]+'), ('previous_command', r'cmd-[a-z0-9]+'), ('source_build', r'b-[a-z0-9]+')]:
        if not re.fullmatch(pattern, plan.get(key, '')):
            raise ValueError('invalid recovery provenance')


def cloud(action, **params):
    service = params.pop('_service', 'tat')
    args = ['tccli', service, action, '--region', 'ap-singapore', '--output', 'json']
    for key, value in params.items():
        args += ['--' + key, json.dumps(value) if not isinstance(value, str) else value]
    r = subprocess.run(args, capture_output=True, text=True, timeout=90)
    if r.returncode:
        raise RuntimeError(f'{action} failed; raw response withheld')
    data = json.loads(r.stdout)
    return data.get('Response', data)


def tasks(command):
    result = []
    offset = 0
    while True:
        data = cloud('DescribeInvocationTasks', Filters=[{'Name': 'command-id', 'Values': [command]}], Limit=100, Offset=offset, HideOutput=False)
        page = data.get('InvocationTaskSet', [])
        for task in page:
            output = task.get('TaskResult') or {}
            probe = {}
            for line in base64.b64decode(output.get('Output', '')).decode(errors='replace').splitlines():
                try:
                    value = json.loads(line)
                except ValueError:
                    continue
                if isinstance(value, dict) and value.get('probe') == 'hermes-production-recovery':
                    probe = value
            result.append({'instance': task['InstanceId'], 'status': task['TaskStatus'], 'exit': output.get('ExitCode'),
                           'created': task.get('CreatedTime') or '', 'invocation': task['InvocationId'], 'probe': probe})
        offset += len(page)
        if not page or offset >= data.get('TotalCount', 0):
            return result


def verified(row):
    p = row.get('probe') or {}
    return (row.get('status') == 'SUCCESS' and row.get('exit') == 0 and p.get('passed') is True
            and p.get('gatewayActive') is True and p.get('upgradeCompleted') is True
            and p.get('expectedVersion') == '0.21.5' and all(p.get(k) == '0.21.5' for k in
            ('cliVersion', 'importVersion', 'distributionVersion', 'identityVersion')))


def preflight(plan):
    env = dict(os.environ, HERMES_POOL_VM_LIST_ENVS='sgprod:ap-singapore:kubeconfig_sgprod', HERMES_LEGACY_POOL_IDS='')
    r = subprocess.run(['bash', '.ci/runtime/commands/list_hermes_pool_vms.sh'], cwd=ROOT, env=env,
                       capture_output=True, text=True, timeout=300)
    if r.returncode:
        raise RuntimeError('inventory query failed; raw response withheld')
    rows = [json.loads(line) for line in r.stdout.splitlines() if line.strip()]
    selected = [x for x in rows if x.get('cloud_id') in plan['instances']]
    if len(selected) != len(plan['instances']) or {x['cloud_id'] for x in selected} != set(plan['instances']):
        raise RuntimeError('target absent or duplicated in Singapore inventory')
    if any(x['state'] != 'ALLOCATED' or x['pool_base_image'] != plan['image_id'] for x in selected):
        raise RuntimeError('target state or regional pool image changed')
    previous = {x['instance']: x for x in sorted(tasks(plan['previous_command']), key=lambda x: x['created'])}
    if any(i not in previous or previous[i]['status'] not in TERMINAL - {'SUCCESS'} for i in plan['instances']):
        raise RuntimeError('every recovery target must have a confirmed terminal failed task')
    cvms = cloud('DescribeInstances', _service='cvm', InstanceIds=plan['instances']).get('InstanceSet', [])
    if {x['InstanceId'] for x in cvms} != set(plan['instances']) or any(x['InstanceState'] != 'RUNNING' for x in cvms):
        raise RuntimeError('every target must exist and be running')
    return selected


def payload():
    sources = {name: base64.b64encode((ROOT / 'images/helpers' / name).read_bytes()).decode() for name in
               ['recover-hermes-runtime.py', 'pin-existing-hermes-runtime.py']}
    python = ('import base64,json,pathlib,subprocess,tempfile\n'
              f'sources=json.loads({json.dumps(json.dumps(sources))})\n'
              'with tempfile.TemporaryDirectory(prefix="hermes-ci-recovery-") as d:\n'
              ' for name,body in sources.items(): pathlib.Path(d,name).write_bytes(base64.b64decode(body))\n'
              ' subprocess.run(["python3",str(pathlib.Path(d,"recover-hermes-runtime.py"))],check=True)\n')
    return '#!/bin/bash\nset -euo pipefail\npython3 - <<\'RECOVERY_PY\'\n' + python + 'RECOVERY_PY\n'


def ensure_invoked(command, instance, out):
    existing = [r for r in tasks(command) if r['instance'] == instance]
    if len(existing) > 1:
        raise RuntimeError('multiple recovery tasks found; manual reconciliation required')
    if existing:
        return
    intent = out / (instance + '.invoke-intent')
    if intent.exists():
        raise RuntimeError('previous invocation outcome unknown; reconcile before retry')
    # Persist intent before the request. An uncertain network result must not
    # turn into a second forced upgrade on the next CI retry.
    with intent.open('x') as f:
        f.write(command)
        f.flush()
        os.fsync(f.fileno())
    receipt = cloud('InvokeCommand', CommandId=command, InstanceIds=[instance], Timeout=2400)
    with (out / 'invocations.jsonl').open('a') as f:
        f.write(json.dumps({'instance': instance, 'invocation': receipt['InvocationId']}) + '\n')


def run(execute=False):
    os.umask(0o077)
    plan = json.loads((ROOT / 'images/hermes-production-recovery-targets.json').read_text())
    validate_plan(plan)
    preflight(plan)
    print(json.dumps({'phase': 'preflight', 'region': plan['region'], 'targets': plan['instances']}), flush=True)
    if not execute:
        return
    build = os.environ.get('BK_CI_BUILD_ID', '')
    if not re.fullmatch(r'b-[a-z0-9]+', build):
        raise RuntimeError('a real CI build ID is required')
    out = Path('/tmp/lightclaw-ci') / ('hermes-production-recovery-' + build)
    out.mkdir(parents=True, exist_ok=True)
    state_file = out / 'command.json'
    content = payload()
    digest = hashlib.sha256(content.encode()).hexdigest()
    if state_file.exists():
        saved = json.loads(state_file.read_text())
        if saved['plan'] != plan or saved.get('payload_sha256') != digest:
            raise RuntimeError('recovery plan or payload differs from checkpoint')
        command = saved['command']
    else:
        command = cloud('CreateCommand', CommandName='hermes-production-recovery-' + build[-12:],
                        CommandType='SHELL', Content=base64.b64encode(content.encode()).decode(), Timeout=2400)['CommandId']
        state_file.write_text(json.dumps({'command': command, 'plan': plan, 'payload_sha256': digest}))
    for instance in plan['instances']:
        ensure_invoked(command, instance, out)
        deadline = time.monotonic() + 2500
        while True:
            found = [r for r in tasks(command) if r['instance'] == instance]
            (out / (instance + '.json')).write_text(json.dumps(found))
            if len(found) == 1 and verified(found[0]):
                print(json.dumps({'instance': instance, 'verified': True}), flush=True)
                break
            if any(r['status'] in TERMINAL for r in found) or time.monotonic() >= deadline:
                raise RuntimeError('recovery did not verify; retained command checkpoint prevents replay')
            print(json.dumps({'instance': instance, 'states': [r['status'] for r in found]}), flush=True)
            time.sleep(15)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    run(args.execute)
    return 0
