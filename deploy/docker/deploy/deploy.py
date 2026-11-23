#!/usr/bin/env python3
"""Docker + Compose v2 + Python 3 only. No host Node or checkout required."""
import json
import os
import re
import socket
import stat
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ROLES = ('gateway', 'brain', 'hands', 'proxy')
DIGEST = re.compile(r'^[a-z0-9][a-z0-9.:-]*/[a-zA-Z0-9._/-]+@sha256:[a-f0-9]{64}$')


def run(args, capture=False, **kwargs):
    return subprocess.run(args, check=True, universal_newlines=True,
                          stdout=subprocess.PIPE if capture else None, **kwargs)


def compose(*args, **kwargs):
    # Do not inherit an arbitrary operator's image/path overrides.
    env = {k: v for k, v in os.environ.items() if not k.startswith(('OPENCRAFT_', 'COMPOSE_'))}
    files = ['-f', str(ROOT / 'compose.yaml')]
    settings = {}
    for line in (ROOT / 'site.env').read_text().splitlines():
        key, sep, value = line.strip().partition('=')
        if sep and key in ('OPENCRAFT_HANDS_ROOT', 'OPENCRAFT_PERSONAL_GIT'):
            if key in settings: raise ValueError('Duplicate deployment flag: ' + key)
            if value not in ('0', '1'): raise ValueError(key + ' must be 0 or 1')
            settings[key] = value
    for key, file in [('OPENCRAFT_HANDS_ROOT', 'compose.root-hands.yaml'),
                      ('OPENCRAFT_PERSONAL_GIT', 'compose.personal-git.yaml')]:
        if settings.get(key) == '1': files += ['-f', str(ROOT / file)]
    return run(['docker', 'compose', '--project-directory', str(ROOT),
                '--env-file', str(ROOT / 'site.env'), '--env-file', str(ROOT / 'images.env'),
                ] + files + list(args), env=env, **kwargs)


def absolute(value):
    path = Path(value)
    if not path.is_absolute() or str(path) == '/' or '..' in path.parts:
        raise ValueError('Expected absolute non-root path: ' + value)
    return path


def validate(config, release):
    services = config['services']
    if set(services) != set(ROLES):
        raise ValueError('Exactly gateway, brain, hands and proxy are required')
    identity = services['gateway']['user']
    if not re.fullmatch(r'[1-9][0-9]*:[1-9][0-9]*', identity) or any(int(v) > 2147483647 for v in identity.split(':')):
        raise ValueError('Use explicit nonroot numeric UID:GID')
    expected = services['hands']['environment']
    for name in ('DATA', 'WORKSPACE', 'EXECUTION', 'LOG'):
        absolute(expected['OPENCRAFT_' + name + '_DIR'])
    if expected['OPENCRAFT_DATA_DIR'] == expected['OPENCRAFT_WORKSPACE_DIR']:
        raise ValueError('State and workspace must be separate')
    shared = {}
    for role in ROLES:
        service = services[role]
        for key in ('OPENCRAFT_HANDS_CPUS', 'OPENCRAFT_HANDS_MEMORY_BYTES'):
            if not expected.get(key) or service['environment'].get(key) != expected[key]:
                raise ValueError('All owners must agree on Hands resource budget: ' + role + '/' + key)
        ref = service['image']
        if not DIGEST.fullmatch(ref) or ref != release['images'][role]:
            raise ValueError('Image must match release registry digest: ' + role)
        if service.get('build') or service.get('privileged') or service['network_mode'] != 'host':
            raise ValueError('Build/privileged/non-host-network not permitted')
        root_hands = role == 'hands' and service['user'] == '0:0'
        if (service['user'] != identity and not root_hands) or service['platform'] != 'linux/amd64':
            raise ValueError('Only Hands may use root; all clients retain the common numeric identity')
        for key in ('DATA', 'EXECUTION', 'WORKSPACE', 'LOG'):
            absolute(service['environment']['OPENCRAFT_' + key + '_DIR'])
        if root_hands:
            root_hands_check(service, identity)
        for volume in service['volumes']:
            absolute(volume['source']); absolute(volume['target'])
            if volume['type'] != 'bind' or volume.get('bind', {}).get('create_host_path'):
                raise ValueError('Explicit initialized bind mounts required')
            if volume['target'] == '/var/run/docker.sock':
                raise ValueError('Docker socket is not a deployment volume')
        for key in ('EXECUTION', 'WORKSPACE'):
            target = service['environment']['OPENCRAFT_' + key + '_DIR']
            if root_hands and key == 'EXECUTION':
                target = service['environment']['OPENCRAFT_HANDS_CLIENT_DIRECTORY']
            mounts = [v for v in service['volumes'] if v['target'] == target]
            if len(mounts) != 1 or mounts[0].get('read_only'):
                raise ValueError('Shared writable mount missing: ' + role + '/' + key)
            if key in shared and shared[key] != mounts[0]['source']:
                raise ValueError('Roles must share the same host ' + key)
            shared[key] = mounts[0]['source']
    personal_git_check(services)
    environment_delivery_check(services)
    command = services['gateway']['command']
    if '--access-control' not in command:
        raise ValueError('Gateway authentication must remain enabled')
    ports = [int(command[command.index('--port') + 1]), int(expected['OPENCRAFT_PROXY_PORT'])]
    if len(set(ports)) != 2 or any(p < 1024 or p > 65535 for p in ports):
        raise ValueError('Use distinct unprivileged Gateway and Proxy ports')
    paths = {v['source'] for service in services.values() for v in service['volumes']}
    return tuple(map(int, identity.split(':'))), sorted(paths, key=len), ports



def personal_git_check(services):
    roles = ('gateway', 'brain', 'hands')
    keys = ('OPENCRAFT_GIT_RUNTIME_DIRECTORY', 'OPENCRAFT_GIT_HOSTS', 'OPENCRAFT_GIT_WORKER_FILE')
    if not any(services[role]['environment'].get(key) for role in roles for key in keys): return
    expected = services['gateway']['environment']
    runtime = str(absolute(expected.get(keys[0], '')))
    hosts = expected.get(keys[1], '').split(',')
    if not hosts or any(not re.fullmatch(r'[a-z0-9.-]{1,253}', host) for host in hosts):
        raise ValueError('Explicit allowed Git hosts required')
    if expected.get(keys[2]) != '/opt/opencraft/runtime/personal-git-worker.mjs':
        raise ValueError('Personal Git must use the packaged worker')
    shared = None
    for role in roles:
        service = services[role]
        if any(service['environment'].get(key) != expected.get(key) for key in keys):
            raise ValueError('Personal Git issuer, Brain and Hands must agree: ' + role)
        mounts = [v for v in service['volumes'] if v['target'] == runtime]
        if len(mounts) != 1 or mounts[0].get('read_only'):
            raise ValueError('Private writable Git IPC mount required: ' + role)
        if shared is not None and shared != mounts[0]['source']:
            raise ValueError('Personal Git roles must share the same host IPC directory')
        shared = mounts[0]['source']
        execution = service['environment']['OPENCRAFT_EXECUTION_DIR']
        if role == 'hands' and service['user'] == '0:0' and (runtime == execution or Path(execution) in Path(runtime).parents):
            raise ValueError('Git IPC must stay outside private root execution state')


ENVIRONMENT_DELIVERY = {'': None, 'opaque': 'opaque', 'vault-owner': 'opaque'}


def environment_delivery_check(services):
    # Opaque account ENV delivery is one decision shared by the Gateway (its vault
    # owner publishes the issuer) and Brain (pins that issuer into DSH, Pi and the
    # Codex AppServer). A half-enabled pair fails at startup or runs unpinned.
    def mode(role):
        value = services[role]['environment'].get('OPENCRAFT_ENVIRONMENT_DELIVERY', '')
        if value not in ENVIRONMENT_DELIVERY:
            raise ValueError('OPENCRAFT_ENVIRONMENT_DELIVERY must be opaque (alias vault-owner) or empty: ' + role)
        return ENVIRONMENT_DELIVERY[value]
    delivery = mode('gateway')
    for role in ROLES:
        if mode(role) != delivery and (role in ('gateway', 'brain') or mode(role) is not None):
            raise ValueError('Gateway and Brain must agree on OPENCRAFT_ENVIRONMENT_DELIVERY: ' + role)
    for role in ROLES:
        env = services[role]['environment']
        issuer = env.get('OPENCRAFT_ENVIRONMENT_ISSUER_FILE', '')
        generation = env.get('OPENCRAFT_ENVIRONMENT_ISSUER_GENERATION', '')
        if delivery is None or mode(role) is None:
            if issuer or generation:
                raise ValueError('The ENV issuer requires OPENCRAFT_ENVIRONMENT_DELIVERY=opaque: ' + role)
            continue
        if env.get('OPENCRAFT_EXECUTION_CONTEXT', 'assets') != 'assets':
            raise ValueError('ENV delivery requires OPENCRAFT_EXECUTION_CONTEXT=assets: ' + role)
        if issuer and str(absolute(issuer)) != str(absolute(env['OPENCRAFT_DATA_DIR']) / 'run' / 'environment-issuer.json'):
            raise ValueError('ENV issuer must be the deployment issuer path: ' + role)
        if generation and not re.fullmatch(r'[A-Za-z0-9._-]{1,64}', generation):
            raise ValueError('Invalid OPENCRAFT_ENVIRONMENT_ISSUER_GENERATION: ' + role)
    if delivery is None: return
    # Brain reads the issuer the Gateway publishes under the shared state directory.
    state = [(services[role]['environment']['OPENCRAFT_DATA_DIR'],
              mounted_path(services[role], services[role]['environment']['OPENCRAFT_DATA_DIR'])) for role in ('gateway', 'brain')]
    if state[0] != state[1] or state[0][1] is None:
        raise ValueError('ENV delivery requires Gateway and Brain to share the same state directory')

def root_hands_check(service, identity):
    env = service['environment']
    uid, gid = identity.split(':')
    if env.get('OPENCRAFT_HANDS_CLIENT_UID') != uid or env.get('OPENCRAFT_HANDS_CLIENT_GID') != gid:
        raise ValueError('Root Hands must retain the declared nonroot client identity')
    if env.get('OPENCRAFT_HANDS_BROWSER_NAME', 'browser') not in ('browser', '.'):
        raise ValueError('Root Hands browser directory must be browser or explicit retained root')
    server = absolute(env.get('OPENCRAFT_ROOT_HANDS_SERVER_DIRECTORY', ''))
    client = absolute(env.get('OPENCRAFT_ROOT_HANDS_CLIENT_DIRECTORY', ''))
    public = absolute(env.get('OPENCRAFT_HANDS_CLIENT_DIRECTORY', ''))
    if env.get('OPENCRAFT_HANDS_BROWSER_DIRECTORY'):
        browser = absolute(env['OPENCRAFT_HANDS_BROWSER_DIRECTORY'])
        if browser == server or server in browser.parents or mounted_path(service, str(browser)) is None:
            raise ValueError('Retained browser profile needs a mounted path outside private root execution state')
    if server == client or server in client.parents or client in server.parents or str(server) != env['OPENCRAFT_EXECUTION_DIR']:
        raise ValueError('Root Hands requires separate server/client IPC directories')
    mounts = service['volumes']
    common = [v for v in mounts if server == Path(v['target']) or Path(v['target']) in server.parents]
    common = sorted(common, key=lambda v: len(v['target']), reverse=True)
    if not common or not (client == Path(common[0]['target']) or Path(common[0]['target']) in client.parents):
        raise ValueError('Root Hands IPC bridge needs one common mount (cross-bind hardlinks are not portable)')
    if mounted_path(service, str(client)) != mounted_path(service, str(public)):
        raise ValueError('Root Hands public client mount must select the same host directory')
    required = {'SYS_ADMIN', 'SETUID', 'SETGID', 'SYS_CHROOT', 'DAC_OVERRIDE', 'CHOWN', 'FOWNER', 'KILL'}
    if set(service.get('cap_drop', [])) != {'ALL'} or set(service.get('cap_add', [])) != required:
        raise ValueError('Root Hands requires its explicit bounded capability set')


def mounted_path(service, target):
    path = Path(target)
    mounts = [v for v in service['volumes'] if path == Path(v['target']) or Path(v['target']) in path.parents]
    if not mounts: return None
    mount = max(mounts, key=lambda v: len(v['target']))
    return str(Path(mount['source']) / path.relative_to(mount['target']))


def directory_plan(services, identity):
    plan = {}
    def add(path, owner):
        if path is None: return
        if path in plan and plan[path] != owner: raise ValueError('Conflicting private directory ownership: ' + path)
        plan[path] = owner
    for role, service in services.items():
        env = service['environment']; owner = tuple(map(int, service['user'].split(':')))
        for key in ('DATA', 'WORKSPACE', 'EXECUTION', 'LOG'):
            add(mounted_path(service, env['OPENCRAFT_' + key + '_DIR']), owner if role == 'hands' and key == 'EXECUTION' else identity)
        add(mounted_path(service, str(Path(env['OPENCRAFT_LOG_DIR']) / role)), owner)
        if env.get('OPENCRAFT_GIT_RUNTIME_DIRECTORY'):
            add(mounted_path(service, env['OPENCRAFT_GIT_RUNTIME_DIRECTORY']), identity)
        if role == 'hands' and owner == (0, 0):
            server = Path(env['OPENCRAFT_ROOT_HANDS_SERVER_DIRECTORY'])
            mount = max([v for v in service['volumes'] if Path(v['target']) in server.parents], key=lambda v: len(v['target']))
            add(mounted_path(service, env['OPENCRAFT_ROOT_HANDS_CLIENT_DIRECTORY']), identity)
    return plan


def probe_args(service):
    args = ['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--user', service['user']]
    # Root needs only DAC read/traverse bypass for private image code. Never give
    # read-only preflight SYS_ADMIN/SETUID/CHOWN or the running service's whole set.
    if service['user'] == '0:0': args += ['--cap-add', 'DAC_OVERRIDE']
    return args


def ensure_directory(path, identity, create=False):
    path = absolute(path)
    # Never follow symlinks into another deployment or silently re-own old data.
    for parent in list(reversed(path.parents)) + [path]:
        if parent.is_symlink():
            raise ValueError('Symlink in deployment directory: ' + str(parent))
    if not path.exists() and create:
        path.mkdir(parents=True, mode=0o700)
        os.chown(str(path), *identity)
    info = path.stat()
    if not stat.S_ISDIR(info.st_mode) or (info.st_uid, info.st_gid) != identity or info.st_mode & 0o077:
        raise ValueError('Directory must be owned by UID:GID and mode 0700 (not modified): ' + str(path))


def image_check(services, identity):
    for role in ROLES:
        image = services[role]['image']
        metadata = json.loads(run(['docker', 'image', 'inspect', image], capture=True).stdout)[0]
        if metadata['Config']['User'] != services[role]['user'] and not (role == 'hands' and services[role]['user'] == '0:0' and metadata['Config']['User'] == '%s:%s' % identity):
            raise ValueError('Runtime UID:GID must match the built image: ' + role)
        if metadata['Os'] != 'linux' or metadata['Architecture'] != 'amd64':
            raise ValueError('Image platform mismatch: ' + role)
    code = '''const fs=require('node:fs'),a=require('node:assert/strict');
for(const f of ['native-hands.mjs','hands-files-owner.mjs','hands-terminal-owner.mjs','container-health.mjs']) fs.accessSync('/opt/opencraft/runtime/'+f);
a.match(fs.readFileSync('/opt/opencraft/runtime/native-hands.mjs','utf8'), /hands-files-owner\\.mjs/);
a.match(fs.readFileSync('/opt/opencraft/runtime/container-health.mjs','utf8'), /fileSystemEndpoint/);
for(const f of ['personal-git-worker.mjs','git-identity-wrapper.mjs','browser/owner.cjs','browser/worker.cjs']) fs.accessSync('/opt/opencraft/runtime/'+f);
a.ok(fs.statSync('/opt/opencraft/bin/git').mode&0o111,'Hands Git command bridge must be executable');
const browserOwner=fs.readFileSync('/opt/opencraft/runtime/browser/owner.cjs','utf8');
a.ok(browserOwner.includes('automationCancellation')&&browserOwner.includes('automationNavigation'),'Hands browser must support cancellable service navigation');
console.log('Hands root/Git/browser/owner contract present');'''
    if services['hands']['user'] == '0:0':
        code += "\na.match(fs.readFileSync('/opt/opencraft/runtime/native-hands.mjs','utf8'), /OPENCRAFT_HANDS_CLIENT_DIRECTORY/, 'Hands image must contain the formal root/client bridge');"
    run(probe_args(services['hands']) + ['--entrypoint', '/opt/opencraft/bin/node', services['hands']['image'], '-e', code])
    if services['gateway']['environment'].get('OPENCRAFT_GIT_RUNTIME_DIRECTORY'):
        for role in ('gateway', 'brain'):
            git = "const fs=require('node:fs'),a=require('node:assert/strict');for(const f of ['personal-git-worker.mjs','git-identity-wrapper.mjs','git-identity-peer-bridge.py','git-identity-shell-env.sh'])fs.accessSync('/opt/opencraft/runtime/'+f);a.ok(fs.statSync('/opt/opencraft/bin/git').mode&0o111);a.ok(fs.readFileSync('/opt/opencraft/runtime/personal-git-worker.mjs','utf8').includes('metadata-only-owner'),'Git execution protocol v2 required');"
            run(probe_args(services[role]) + ['--entrypoint', '/opt/opencraft/bin/node', services[role]['image'], '-e', git])
    proxy = "const fs=require('node:fs'),a=require('node:assert/strict');a.match(fs.readFileSync('/opt/opencraft/runtime/container-health.mjs','utf8'), /owner-handoff/, 'Proxy image must include the standard proxy health protocol');"
    run(probe_args(services['proxy']) + ['--entrypoint', '/opt/opencraft/bin/node', services['proxy']['image'], '-e', proxy])


def retained_workspace_check(services):
    inventory = ROOT / 'retained-workspaces.json'
    if not inventory.exists():
        return  # Fresh deployments have no legacy absolute working directories.
    rows = json.loads(inventory.read_text())
    if not isinstance(rows, list) or not rows:
        raise ValueError('Retained workspace inventory must be a nonempty list')
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get('readablePaths', []), list):
            raise ValueError('Invalid retained workspace inventory')
        absolute(row.get('cwd', ''))
        for path in row.get('readablePaths', []):
            absolute(path)
    code = (ROOT / 'workspace-preflight.mjs').read_text()
    for role in ROLES:
        service = services[role]
        args = probe_args(service) + ['-i', '--entrypoint', '/opt/opencraft/bin/node']
        # Exact rendered mounts include retained paths and ancestor configuration.
        for mount in service['volumes']:
            args += ['--mount', 'type=bind,source=' + mount['source'] + ',target=' + mount['target']
                     + (',readonly' if mount.get('read_only') else '')]
        args += [service['image'], '--input-type=module', '-e', code, '--', '--retained-workspace-probe']
        try:
            run(args, input=json.dumps(rows))
        except subprocess.CalledProcessError as error:
            raise ValueError('Retained workspace preflight failed for ' + role) from error


def verify():
    ids = compose('ps', '--all', '-q', capture=True).stdout.split()
    if len(ids) != 4:
        raise ValueError('Expected exactly four deployment containers')
    containers = json.loads(run(['docker', 'inspect'] + ids, capture=True).stdout)
    expected_config = json.loads(compose('config', '--format', 'json', capture=True).stdout)
    for container in containers:
        role = container['Config']['Labels']['com.docker.compose.service']
        if container['Config'].get('User') != expected_config['services'][role]['user']:
            raise ValueError('Running role identity differs from deployment: ' + role)
        if container['State'].get('Health', {}).get('Status') != 'healthy':
            raise ValueError('Unhealthy container: ' + role)
        expected = json.loads((ROOT / 'release.json').read_text())['images'][role]
        image = json.loads(run(['docker', 'image', 'inspect', expected], capture=True).stdout)[0]
        if container['Image'] != image['Id']:
            raise ValueError('Running image differs from release: ' + role)
    code = (ROOT / 'files-smoke.mjs').read_text()
    # Cross-container RPC proves mount sharing; Gateway has no files-owner child.
    for role in ('hands', 'gateway'):
        compose('exec', '-T', role, '/opt/opencraft/bin/node', '--input-type=module', input=code)
    compose('exec', '-T', 'gateway', '/opt/opencraft/bin/node', '--input-type=module', '-e', '''
const port=process.argv[1];
const h=await fetch('http://127.0.0.1:'+port+'/health'); if(!h.ok||!(await h.json()).ok)process.exit(1);
const r=await fetch('http://127.0.0.1:'+port+'/'); if(r.status!==401)throw Error('Unauthenticated access must be rejected: '+r.status);
console.log('Gateway health OK; unauthenticated root returns 401');''', str(PORTS[0]))
    print('Verified four immutable images, health, files RPC from Hands/Gateway and authentication.')


def main():
    global PORTS
    if len(sys.argv) != 2 or sys.argv[1] not in ('config', 'init', 'pull', 'check', 'up', 'verify', 'stop'):
        raise ValueError('Usage: python3 deploy.py config|init|pull|check|up|verify|stop')
    action = sys.argv[1]
    config = json.loads(compose('config', '--format', 'json', capture=True).stdout)
    identity, paths, PORTS = validate(config, json.loads((ROOT / 'release.json').read_text()))
    if action == 'config':
        print(json.dumps(config, indent=2)); return
    if action == 'pull':
        compose('pull'); return
    if action == 'stop':
        compose('stop'); return  # Deliberately no down -v / prune command.
    plan = directory_plan(config['services'], identity)
    for path, owner in sorted(plan.items(), key=lambda row: len(row[0])):
        ensure_directory(path, owner, create=action == 'init')
    for path in paths:
        if path not in plan:
            # Retained migration mounts are inspected, never chmod/chown'd or created.
            info = Path(path).lstat()
            if stat.S_ISLNK(info.st_mode) or not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
                raise ValueError('Invalid retained mount: ' + path)
    if action == 'init':
        print('Initialized private deployment directories; existing ownership preserved.'); return
    image_check(config['services'], identity)
    retained_workspace_check(config['services'])
    if action == 'check':
        print('Deployment preflight passed.'); return
    if action == 'up':
        if not compose('ps', '--status', 'running', '-q', capture=True).stdout.strip():
            for port in PORTS:
                with socket.socket() as probe:
                    probe.bind(('0.0.0.0', port))
        compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '240')
    verify()


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print('Deployment failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
