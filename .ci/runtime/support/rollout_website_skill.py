#!/usr/bin/env python3
"""Prepare and roll out only the website Skill. No CTL client or credential API."""
import argparse
import base64
from collections import Counter
import csv
import fcntl
import hashlib
from functools import lru_cache
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[3]
REGIONS = {
    'beijing-sandbox': ('ap-beijing',),
    'seoul-sandbox': ('ap-seoul',),
    'shprod': ('ap-shanghai',),
    'sgprod': ('ap-singapore', 'ap-johorbahru'),
}
RUNNING = {'PENDING', 'DELIVERING', 'DELIVER_DELAYED', 'RUNNING', 'CANCELLING'}


class RolloutError(ValueError):
    """Only fixed, non-sensitive operator diagnostics belong in this exception."""



@lru_cache(maxsize=1)
def load_bundle():
    source = ROOT / 'images/helpers/website_skill_bundle.py'
    if not source.is_file():
        raise RolloutError('complete source checkout is required for Skill rollout')
    spec = importlib.util.spec_from_file_location('website_skill_bundle', source)
    bundle = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bundle)
    return bundle


def digest(value):
    return hashlib.sha256(load_bundle().canonical(value)).hexdigest()


def inventory(path, environment, region=None):
    region = region or REGIONS[environment][0]
    if region not in REGIONS[environment]:
        raise RolloutError('region does not belong to environment')
    if path.is_symlink() or path.stat().st_mode & 0o077:
        raise RolloutError('inventory must be a private regular file (0600)')
    if time.time() - path.stat().st_mtime > 86400:
        raise RolloutError('inventory older than 24h; refresh the read-only inventory')
    with path.open(newline='') as stream:
        reader = csv.DictReader(stream)
        required = {'user_id', 'business_instance_id', 'sandbox_id', 'cvm_instance_id', 'environment', 'region', 'status', 'sandbox_instance_state', 'eligible'}
        if not required.issubset(reader.fieldnames or []):
            raise RolloutError('inventory missing required columns')
        rows = list(reader)
    # Exclude ALL members of a duplicate mapping, including noneligible rows.
    clouds = Counter(row['cvm_instance_id'] for row in rows if row['cvm_instance_id'])
    ids = Counter((row['environment'], row['business_instance_id']) for row in rows)
    selected, excluded = [], Counter()
    for row in rows:
        if row['environment'] != environment:
            continue
        reason = None
        if clouds[row['cvm_instance_id']] != 1 or ids[(environment, row['business_instance_id'])] != 1:
            reason = 'duplicate_mapping'
        elif row['region'] != region:
            reason = 'region_mismatch'
        elif row.get('deleted_at') or row['status'] != 'Running' or row['sandbox_instance_state'] != 'ALLOCATED' or row['eligible'].lower() != 'true':
            reason = 'not_running_allocated_eligible'
        elif not re.fullmatch(r'ins-[A-Za-z0-9]+', row['cvm_instance_id']) or any(not re.fullmatch(r'[A-Za-z0-9_-]+', row[key]) for key in ('user_id', 'business_instance_id', 'sandbox_id')):
            reason = 'invalid_mapping'
        if reason:
            excluded[reason] += 1
        else:
            selected.append(row['cvm_instance_id'])
    if not selected:
        raise RolloutError('no eligible targets')
    return selected, dict(excluded)


class TAT:
    def __init__(self, region):
        self.region = region

    def call(self, action, **params):
        cmd = ['tccli', 'tat', action, '--region', self.region]
        for key, value in params.items():
            cmd += ['--' + key, value if isinstance(value, str) else json.dumps(value)]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=45)
        # Never echo cloud CLI stderr, request parameters or remote script output.
        if result.returncode:
            raise RolloutError('TAT CLI failed; inspect protected local diagnostics separately')
        data = json.loads(result.stdout)
        data = data.get('Response', data)
        if data.get('Error'):
            raise RolloutError('TAT API rejected request')
        return data

    def verify_command(self, command_id, content):
        commands = self.call('DescribeCommands', CommandIds=[command_id]).get('CommandSet', [])
        if len(commands) != 1:
            raise RolloutError('command not found')
        command = commands[0]
        if (command.get('CommandId') != command_id or command.get('Content') != content
                or command.get('Username') != 'agentuser' or command.get('WorkingDirectory') != '/home/agentuser'
                or command.get('CommandType') != 'SHELL' or command.get('EnableParameter') is not False
                or command.get('Timeout') != 300):
            raise RolloutError('remote command differs from pinned local Skill command')

    def tasks(self, invocation):
        return self.call('DescribeInvocationTasks', Filters=[{'Name': 'invocation-id', 'Values': [invocation]}], Limit=100, HideOutput=False).get('InvocationTaskSet', [])


def accepted(task, version, action):
    result = task.get('TaskResult') or {}
    if task.get('TaskStatus') != 'SUCCESS' or result.get('ExitCode') != 0 or result.get('Dropped', 0):
        return False
    try:
        output = base64.b64decode(result.get('Output', ''), validate=True).decode()
        records = [json.loads(line.split('=', 1)[1]) for line in output.splitlines() if line.startswith('WEBSITE_SKILL_RESULT=')]
        if len(records) != 1 or records[0].get('action') != action:
            return False
        return records[0].get('active') == version if action == 'install' else records[0].get('from') == version and bool(records[0].get('active'))
    except (ValueError, UnicodeError):
        return False


def wait(tat, state, save, invocation, command_id, version, action, timeout):
    expected = {cloud for cloud, row in state['rows'].items() if row.get('invocation') == invocation and row['status'] != 'SUCCESS'}
    deadline = time.monotonic() + timeout
    while expected:
        for task in tat.tasks(invocation):
            cloud = task.get('InstanceId')
            if cloud not in expected:
                continue
            if task.get('InvocationId') != invocation or task.get('CommandId') != command_id:
                raise RolloutError('task identity mismatch')
            status = task.get('TaskStatus')
            if not status or status in RUNNING:
                continue
            state['rows'][cloud]['status'] = 'SUCCESS' if accepted(task, version, action) else 'FAILED'
            save()
            expected.remove(cloud)
        if expected:
            if time.monotonic() >= deadline:
                raise RolloutError('poll timeout; invocation retained for resume, do not reinvoke')
            time.sleep(2)


def execute(args, targets, config, content, tat):
    path = args.state_file
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink() or (path.exists() and path.stat().st_mode & 0o077):
        raise RolloutError('state must be private non-symlink file')
    fd = os.open(str(path) + '.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = json.loads(path.read_text()) if path.exists() else {'config': config, 'rows': {}, 'canary': args.canary}
        if state['config'] != config:
            raise RolloutError('state is bound to a different inventory, bundle, environment or command')
        if not state.get('canary') or state['canary'] not in targets:
            raise RolloutError('first execution requires one eligible --canary')
        if args.canary and args.canary != state['canary']:
            raise RolloutError('cannot replace an existing canary')
        ack = digest({'config': config, 'canary': state['canary']})
        if not args.canary:
            if args.resume_after_canary != ack or state['rows'].get(state['canary'], {}).get('status') != 'SUCCESS':
                raise RolloutError('verified canary plus exact --resume-after-canary acknowledgment required')
        save = lambda: load_bundle().write_json(path, state)
        save()
        tat.verify_command(args.command_id, content)
        # Associate a lost InvokeCommand response only after operator reconciliation.
        for item in args.reconcile:
            cloud, invocation = item.split('=', 1)
            row = state['rows'].get(cloud, {})
            if row.get('status') != 'INVOKING' or not re.fullmatch(r'inv-[A-Za-z0-9]+', invocation):
                raise RolloutError('reconcile requires an ambiguous target and valid invocation ID')
            found = [t for t in tat.tasks(invocation) if t.get('InstanceId') == cloud and t.get('InvocationId') == invocation and t.get('CommandId') == args.command_id]
            if len(found) != 1:
                raise RolloutError('reconciled invocation does not match target and command')
            row.update(status='DELIVERING', invocation=invocation)
            save()
        selected = [state['canary']] if args.canary else targets
        # Reconcile known in-flight tasks before new mutations; no blind retries.
        for invocation in sorted({state['rows'][c]['invocation'] for c in selected if state['rows'].get(c, {}).get('status') == 'DELIVERING'}):
            wait(tat, state, save, invocation, args.command_id, config['version'], config['action'], args.poll_timeout)
        if any(state['rows'].get(c, {}).get('status') == 'INVOKING' for c in selected):
            raise RolloutError('ambiguous invocation: inspect TAT then use --reconcile CVM=INV; no automatic retry')
        if any(state['rows'].get(c, {}).get('status') == 'FAILED' for c in selected) and not args.retry_failed:
            raise RolloutError('failed targets require investigation and explicit --retry-failed')
        pending = [c for c in selected if state['rows'].get(c, {}).get('status') != 'SUCCESS'][:args.limit]
        for offset in range(0, len(pending), args.batch_size):
            batch = pending[offset:offset + args.batch_size]
            for cloud in batch:
                state['rows'][cloud] = {'status': 'INVOKING'}
            save()  # Durable fence precedes the non-idempotent external API.
            invocation = tat.call('InvokeCommand', CommandId=args.command_id, InstanceIds=batch).get('InvocationId', '')
            if not re.fullmatch(r'inv-[A-Za-z0-9]+', invocation):
                raise RolloutError('ambiguous invocation response; reconcile before resuming')
            for cloud in batch:
                state['rows'][cloud].update(status='DELIVERING', invocation=invocation)
            save()
            wait(tat, state, save, invocation, args.command_id, config['version'], config['action'], args.poll_timeout)
            if any(state['rows'][c]['status'] != 'SUCCESS' for c in batch):
                raise RolloutError('batch contains failed verification; rollout stopped')
        counts = Counter(state['rows'].get(c, {}).get('status', 'PENDING') for c in targets)
        return {'counts': dict(counts), 'canary_ack': ack, 'version': config['version']}
    finally:
        os.close(fd)


def _main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT / '.agents/skills/website-builder')
    parser.add_argument('--action', choices=['install', 'rollback'], default='install')
    parser.add_argument('--prepare-command', type=Path, help='write CreateCommand JSON locally; no cloud calls')
    parser.add_argument('--csv', type=Path)
    parser.add_argument('--environment', choices=REGIONS)
    parser.add_argument('--region', choices=sorted({region for regions in REGIONS.values() for region in regions}))
    parser.add_argument('--state-file', type=Path)
    parser.add_argument('--command-id')
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--canary')
    parser.add_argument('--resume-after-canary')
    parser.add_argument('--reconcile', action='append', default=[])
    parser.add_argument('--retry-failed', action='store_true')
    parser.add_argument('--limit', type=int, default=100)
    parser.add_argument('--batch-size', type=int, default=10)
    parser.add_argument('--poll-timeout', type=int, default=360)
    args = parser.parse_args(argv)
    bundle = load_bundle()
    data = bundle.build(args.source)
    script = bundle.command(data, args.action)
    content = base64.b64encode(script.encode()).decode()
    if args.prepare_command:
        if args.execute:
            parser.error('command preparation cannot execute')
        request = dict(CommandName=f'website-skill-{args.action}-{data["version"][:16]}', Description='Versioned credential-free website Skill', Content=content, CommandType='SHELL', Username='agentuser', WorkingDirectory='/home/agentuser', Timeout=300, EnableParameter=False)
        fd = os.open(args.prepare_command, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'w') as out:
            json.dump(request, out)
        print(json.dumps({'version': data['version'], 'prepared': True}))
        return 0
    if not args.csv or not args.environment or not 1 <= args.limit <= 100 or not 1 <= args.batch_size <= 100 or args.poll_timeout <= 0:
        parser.error('require --csv, --environment, limit/batch-size 1..100 and positive timeout')
    region = args.region or REGIONS[args.environment][0]
    targets, excluded = inventory(args.csv, args.environment, region)
    config = dict(version=data['version'], action=args.action, environment=args.environment, region=region, inventory=hashlib.sha256(args.csv.read_bytes()).hexdigest(), script_sha256=hashlib.sha256(script.encode()).hexdigest(), command_id=args.command_id)
    if not args.execute:
        print(json.dumps({'dry_run': True, 'eligible': len(targets), 'excluded': excluded, 'region': region, 'version': data['version']}))
        return 0
    if not args.state_file or not args.command_id or bool(args.canary) == bool(args.resume_after_canary):
        parser.error('execute requires state, command ID and exactly one canary/resume option')
    print(json.dumps(execute(args, targets, config, content, TAT(region))))
    return 0


def main(argv=None):
    try:
        return _main(argv)
    except RolloutError as exc:
        print('Skill rollout stopped: ' + str(exc), file=sys.stderr)
        return 1
    except (ValueError, OSError, subprocess.SubprocessError):
        # Fixed failure text prevents unexpected API/CSV/payload data reaching shared logs.
        print('Skill rollout stopped. Inspect private state and invocation status; no blind retry.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
