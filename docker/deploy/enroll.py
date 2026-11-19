#!/usr/bin/env python3
"""Offline, independently keyed Join Hub bootstrap. Gateway must be stopped."""
import argparse
import json
import os
import shutil
import tempfile
from pathlib import Path
from urllib.parse import urlsplit
from deploy import ROOT, compose, validate, ensure_directory, run


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--relay', required=True)
    parser.add_argument('--origin', required=True)
    parser.add_argument('--ca', required=True, type=Path, help='Trusted public Hub CA, never the private server key')
    parser.add_argument('--name', required=True)
    args = parser.parse_args()
    for url in (args.relay, args.origin):
        parsed = urlsplit(url)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.path or parsed.query or parsed.fragment:
            raise ValueError('Use an exact HTTPS origin without path or credentials')
    config = json.loads(compose('config', '--format', 'json', capture=True).stdout)
    identity, paths, _ = validate(config, json.loads((ROOT / 'release.json').read_text()))
    for path in paths:
        ensure_directory(path, identity)
    if compose('ps', '--status', 'running', '-q', 'gateway', capture=True).stdout.strip():
        raise ValueError('Stop only this deployment Gateway before offline Hub enrollment')
    gateway = config['services']['gateway']
    target = gateway['environment']['OPENCRAFT_DATA_DIR']
    data = next(v['source'] for v in gateway['volumes'] if v['target'] == target)
    state = Path(data) / 'hub-network.json'
    if state.exists():
        value = json.loads(state.read_text())
        if value.get('origin') and value['origin'] != args.origin:
            raise ValueError('Existing identity belongs to another origin; no enrollment changes made')
        if value.get('authority') and value.get('origin') == args.origin:
            if not any(peer.get('endpoint') == args.relay for peer in value.get('peers', [])):
                raise ValueError('Existing identity belongs to another Hub')
            print('This independent instance is already enrolled; no changes made.'); return
    with tempfile.TemporaryDirectory(prefix='.hub-bootstrap-', dir=str(ROOT)) as temporary:
        directory = Path(temporary)
        ca = directory / 'ca.pem'; shutil.copyfile(str(args.ca.resolve(strict=True)), str(ca)); ca.chmod(0o600)
        os.chown(str(directory), *identity); os.chown(str(ca), *identity)
        commands = [
            {'action': 'configure', 'name': args.name, 'accepting': False, 'forwarding': False, 'endpoint': '', 'origin': ''},
            {'action': 'connect', 'relay': args.relay, 'publishOrigin': args.origin, 'trustIdentity': True, 'caFile': '/bootstrap/ca.pem'},
        ]
        for command in commands:
            path = directory / 'command.json'; path.write_text(json.dumps(command)); path.chmod(0o600); os.chown(str(path), *identity)
            # Only this instance's state and an ephemeral private command directory.
            # No kubeconfig, live instance secrets or registry credentials enter it.
            run(['docker', 'run', '--rm', '--network', 'host', '--user', '%s:%s' % identity,
                 '--mount', 'type=bind,source=' + data + ',target=' + target,
                 '--mount', 'type=bind,source=' + str(directory) + ',target=/bootstrap,readonly',
                 '--entrypoint', '/opt/opencraft/bin/node', gateway['image'],
                 '/opt/opencraft/runtime/hub-admin.mjs', target + '/hub-network.json', '/bootstrap/command.json'], capture=True)
    value = json.loads(state.read_text())
    if value.get('origin') != args.origin or 'tencentoa' not in value.get('authority', {}).get('providers', []):
        raise ValueError('Hub enrollment did not establish the requested instance identity')
    print('Independent Hub enrollment completed; Tencent OA authority accepted for ' + args.origin)


if __name__ == '__main__':
    main()
