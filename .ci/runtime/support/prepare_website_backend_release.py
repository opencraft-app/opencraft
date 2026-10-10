#!/usr/bin/env python3
"""Render offline, opt-in website-runtime final-overlay consumer patches. Never apply or read secrets.

Inputs contain regional endpoint/provenance and Secret references, not secret values.
Default preparation keeps new fullstack creation disabled. Enable is a separate explicit
phase and still requires normal migration/runtime acceptance and release authorization.
"""
from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

PRODUCTION = {'shprod', 'sgprod'}
TARGETS = {
    'shprod': [('ctl', 'ctl', 'ctl-api', 'api', 'deploy'),
               ('ctl', 'ctl', 'ctl-service', 'service', 'deploy'),
               ('website-deployer', 'ctl', 'website-deployer', 'website-deployer', 'deploy'),
               ('site-gateway', 'ctl', 'site-gateway', 'site-gateway', 'invoke')],
    'sgprod': [('ctl', 'ctl', 'ctl-api', 'api', 'deploy'),
               ('ctl', 'ctl', 'ctl-service', 'service', 'deploy'),
               ('website-deployer', 'ctl', 'website-deployer', 'website-deployer', 'deploy'),
               ('site-gateway', 'ctl', 'site-gateway', 'site-gateway', 'invoke')],
    'beijing-sandbox': [('ctl', 'ctl', 'ctl-api-cloudbase', 'api', 'deploy'),
                        ('website-deployer', 'temporal-workers', 'website-deployer', 'website-deployer', 'deploy'),
                        ('site-gateway', 'ctl', 'site-gateway-website-readiness', 'site-gateway', 'invoke')],
    'seoul-sandbox': [('ctl', 'ctl', 'ctl-api-website-readiness', 'api', 'deploy'),
                      ('ctl', 'ctl', 'ctl-service-website-readiness', 'service', 'deploy'),
                      ('website-deployer', 'ctl', 'website-deployer-readiness', 'worker', 'deploy'),
                      ('site-gateway', 'ctl', 'site-gateway-website-readiness', 'site-gateway', 'invoke')],
}
CA_PATH = '/etc/website-runtime-tls/ca-bundle.pem'
PRIVATE_NETWORKS = [ipaddress.ip_network(n) for n in ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7']]


def mapping(value, keys: set[str], label: str):
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError(label + ' must contain exactly the declared fields; values are not echoed')
    return value


def secret_ref(value, label: str):
    reference = mapping(value, {'name', 'key'}, label)
    name, key = reference['name'], reference['key']
    if not isinstance(name, str) or len(name) > 253 or not all(
        len(part) <= 63 and re.fullmatch(r'[a-z0-9](?:[a-z0-9-]*[a-z0-9])?', part)
        for part in name.split('.')
    ):
        raise ValueError(label + ' has invalid Secret name')
    if not isinstance(key, str) or len(key) > 253 or not re.fullmatch(r'[A-Za-z0-9._-]+', key) or key in {'.', '..'}:
        raise ValueError(label + ' has invalid Secret key')
    return {'name': name, 'key': key}


def endpoint(value):
    if not isinstance(value, str) or value != value.strip():
        raise ValueError('runtime base URL is required')
    try:
        url = urlsplit(value)
        hostname = url.hostname or ''
        port = url.port
    except ValueError:
        raise ValueError('runtime URL requires a private HTTPS origin') from None
    # Accept only canonical Kubernetes Service FQDNs, not arbitrary DNS names.
    # Certificate SAN verification remains the live consumer's responsibility.
    labels = hostname.split('.')
    service_dns = (len(labels) == 5 and labels[2:] == ['svc', 'cluster', 'local']
                   and all(len(part) <= 63 and re.fullmatch(
                       r'[a-z0-9](?:[a-z0-9-]*[a-z0-9])?', part)
                       for part in labels[:2]))
    try:
        address = ipaddress.ip_address(hostname)
        private_ip = any(address.version == network.version and address in network
                         for network in PRIVATE_NETWORKS)
    except ValueError:
        private_ip = False
    if (url.scheme != 'https' or url.username is not None or url.password is not None
            or url.path not in {'', '/'} or url.query or url.fragment
            or (port is not None and not 1 <= port <= 65535)
            or not (private_ip or service_dns)):
        raise ValueError('runtime URL requires a private HTTPS origin without credentials or extra paths')
    return value.rstrip('/')


def prepare(config, phase='prepare'):
    if not isinstance(config, dict) or type(config.get('schema_version')) is not int or config['schema_version'] not in {1, 2, 3}:
        raise ValueError('unsupported release config schema')
    schema = config['schema_version']
    fields = {'schema_version', 'environment', 'source_tree_sha256', 'runtime'}
    cfg = mapping(config, fields | ({'beta_users'} if schema < 3 else set()) | ({'data_enabled'} if schema >= 2 else set()), 'release config')
    data_requested = cfg['data_enabled'] if schema >= 2 else False
    if type(data_requested) is not bool:
        raise ValueError('data_enabled must be an explicit boolean')
    env = cfg['environment']
    if not isinstance(env, str) or env not in TARGETS:
        raise ValueError('unsupported release environment')
    if phase not in {'prepare', 'enable'}:
        raise ValueError('phase must be prepare or explicit enable')
    sha = cfg['source_tree_sha256']
    if not isinstance(sha, str) or not re.fullmatch(r'[a-f0-9]{64}', sha):
        raise ValueError('fixed source tree SHA256 is required')
    runtime_fields = {'environment', 'base_url', 'ca', 'deploy_token', 'invoke_token'}
    runtime = mapping(cfg['runtime'], runtime_fields | ({'driver'} if schema >= 2 else set()), 'runtime binding')
    driver = runtime['driver'] if schema >= 2 else 'runsc'
    if not isinstance(driver, str) or driver not in {'runsc', 'minisandbox'}:
        raise ValueError('unsupported regional runtime driver')
    if data_requested and driver != 'minisandbox':
        raise ValueError('persistent data requires the qualified minisandbox driver')
    if runtime['environment'] != env:
        raise ValueError('runtime provenance environment does not match release environment')
    base = endpoint(runtime['base_url'])
    refs = {role: secret_ref(runtime[role], role) for role in ['ca', 'deploy_token', 'invoke_token']}
    if refs['deploy_token'] == refs['invoke_token']:
        raise ValueError('deploy and invoke must use separate Secret key references')
    if refs['ca'] in [refs['deploy_token'], refs['invoke_token']]:
        raise ValueError('CA reference must not mount an execution credential')
    # Old reference-only inputs remain readable, but their owner list is never
    # used for authorization. Schema3 removes that field entirely.
    if schema < 3:
        users = cfg['beta_users']
        if not isinstance(users, list) or len(users) > 1000 or any(
            not isinstance(user, str) or not re.fullmatch(r'usr[-_][A-Za-z0-9-]+', user) for user in users
        ) or len(users) != len(set(users)):
            raise ValueError('invalid legacy beta_users input')
    data_enabled = phase == 'enable' and data_requested
    service_patches = {}
    for service, namespace, name, container, role in TARGETS[env]:
        own = 'WEBSITE_RUNTIME_' + role.upper() + '_TOKEN'
        opposite = 'WEBSITE_RUNTIME_' + ('DEPLOY' if role == 'invoke' else 'INVOKE') + '_TOKEN'
        variables = [
            {'name': 'WEBSITE_RUNTIME_BASE_URL', 'value': base, 'valueFrom': None},
            {'name': 'SSL_CERT_FILE', 'value': CA_PATH, 'valueFrom': None},
            {'name': own, 'value': None, 'valueFrom': {
                'secretKeyRef': refs[role + '_token'], 'configMapKeyRef': None,
                'fieldRef': None, 'resourceFieldRef': None}},
            # env overrides envFrom; deletion would expose a legacy inherited credential.
            {'name': opposite, 'value': '', 'valueFrom': None},
        ]
        if service == 'ctl':
            variables.append({'name': 'WEBSITE_BACKEND_ENABLED', 'value': '1' if phase == 'enable' else '0', 'valueFrom': None})
            # Explicit values override stale envFrom gates, including legacy schema1 inputs.
            variables.append({'name': 'WEBSITE_BACKEND_DATA_ENABLED', 'value': '1' if data_enabled else '0', 'valueFrom': None})
        elif service == 'site-gateway':
            variables.append({'name': 'SITE_GATEWAY_BACKEND_SHARED_READ', 'value': 'true' if data_enabled else 'false', 'valueFrom': None})
        patch = {
            'apiVersion': 'apps/v1', 'kind': 'Deployment',
            'metadata': {'name': name, 'namespace': namespace},
            'spec': {'template': {
                'metadata': {'annotations': {'website.lightvela.com/source-tree-sha256': sha}},
                'spec': {
                    'containers': [{'name': container, 'env': variables,
                                    'volumeMounts': [{'name': 'website-runtime-ca',
                                                      'mountPath': '/etc/website-runtime-tls', 'readOnly': True}]}],
                    'volumes': [{'name': 'website-runtime-ca', 'secret': {
                        'secretName': refs['ca']['name'], 'defaultMode': 0o444,
                        'items': [{'key': refs['ca']['key'], 'path': 'ca-bundle.pem'}]}}],
                },
            }},
        }
        service_patches.setdefault(service, []).append({
            'target': {'group': 'apps', 'version': 'v1', 'kind': 'Deployment', 'namespace': namespace, 'name': name},
            'patch': json.dumps(patch, sort_keys=True),
        })
    return {'schema_version': schema, 'environment': env, 'phase': phase, 'source_tree_sha256': sha,
            'runtime_driver': driver, 'data_enabled': data_enabled,
            'production_environment': env in PRODUCTION, 'apply_executed': False,
            'secret_values_read': False,
            'integration_method': 'append-to-final-source-overlay-patches',
            'service_patches': service_patches}


def write_candidate(candidate, output: Path):
    output = Path(output)
    if output.exists() or output.is_symlink():
        raise ValueError('candidate output must be a new directory')
    output.parent.mkdir(parents=True, exist_ok=True)
    output.mkdir(exist_ok=False, mode=0o700)
    hashes = {}
    for service, patches in sorted(candidate['service_patches'].items()):
        directory = output / service
        directory.mkdir(mode=0o700)
        # Append these entries AFTER existing overlay patches, not as a Component:
        # source overlays contain index-based JSON patches whose order must be retained.
        path = directory / 'overlay-patches.json'
        content = json.dumps(patches, sort_keys=True, indent=2) + '\n'
        path.write_text(content)
        hashes[str(path.relative_to(output))] = hashlib.sha256(content.encode()).hexdigest()
    manifest = {k: v for k, v in candidate.items() if k != 'service_patches'}
    manifest['files'] = hashes
    (output / 'manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
    return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--phase', choices=['prepare', 'enable'], default='prepare')
    args = parser.parse_args(argv)
    try:
        config = json.loads(args.input.read_text())
        candidate = prepare(config, phase=args.phase)
        manifest = write_candidate(candidate, args.output)
    except (ValueError, OSError):
        parser.exit(2, 'Invalid release input or output; values are not echoed; no apply was performed.\n')
    print(json.dumps(manifest, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
