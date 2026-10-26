#!/usr/bin/env python3
"""Plan native Actions jobs and check the actual runner before Chromium sync."""
import argparse
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys


TARGETS = {
    'linux-x64': ('ubuntu-24.04', 'python3', 'linux', 'x64', ['--linux', 'AppImage', '--x64']),
    'windows-x64': ('windows-latest', 'python', 'win32', 'x64', ['--win', 'nsis', '--x64']),
    'macos-arm64': ('macos-15', 'python3', 'darwin', 'arm64', ['--mac', 'dmg', '--arm64']),
    'macos-x64': ('macos-15-intel', 'python3', 'darwin', 'x64', ['--mac', 'dmg', '--x64']),
}


def plan(target, mode, environment):
    if target != 'all' and target not in TARGETS:
        raise ValueError('Unknown native target: ' + target)
    rows = []
    for name, (hosted, python, system, arch, package) in TARGETS.items():
        if target not in ('all', name):
            continue
        key = 'ELECTRON_BUILD_RUNNER_' + name.upper().replace('-', '_')
        runner = environment.get(key, '')
        if mode == 'build':
            if not runner:
                raise ValueError('Configure repository variable ' + key + ' as JSON runner labels; '
                                 'full Chromium builds require a provisioned large runner')
            try:
                runner = json.loads(runner)
            except json.JSONDecodeError as error:
                raise ValueError(key + ' must contain JSON runner labels') from error
            if not (isinstance(runner, str) and runner.strip()
                    or isinstance(runner, list) and runner
                    and all(isinstance(label, str) and label.strip() for label in runner)):
                raise ValueError(key + ' must be a nonempty string or array of runner labels')
        rows.append({'id': name, 'hosted': hosted, 'python': python,
                     'runner': runner or hosted, 'platform': system, 'arch': arch,
                     'marker': f'OPENCRAFT_ELECTRON_DISTRIBUTION_{system.upper()}_{arch.upper()}'})
    return {'include': rows}


def check_platform(target):
    _, _, system, arch, _ = TARGETS[target]
    actual_arch = {'amd64': 'x64', 'x86_64': 'x64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(platform.machine().lower())
    if sys.platform != system or actual_arch != arch:
        raise ValueError(f'{target} requires {system}/{arch}; runner is {sys.platform}/{actual_arch}')


def preflight(target, root):
    check_platform(target)
    free = shutil.disk_usage(root).free // (1024 ** 3)
    if free < 200:
        raise ValueError(f'Chromium needs at least 200 GiB free scratch space; found {free} GiB')
    # Provisioned images own OS packages, Xcode / Visual Studio and SDKs.
    # This check deliberately does not install packages or elevate privileges.
    required = ['git', 'node', 'npm']
    required += ['xcodebuild'] if sys.platform == 'darwin' else []
    required += ['pkg-config', 'xvfb-run'] if sys.platform == 'linux' else []
    for command in required:
        if not shutil.which(command):
            raise ValueError('Provision build runner with ' + command)
    print(json.dumps({'target': target, 'freeGiB': free, 'platformVerified': True}))


def package(target, distribution):
    check_platform(target)
    _, _, system, arch, arguments = TARGETS[target]
    root = Path(__file__).resolve().parents[2]
    environment = dict(os.environ)
    environment[f'OPENCRAFT_ELECTRON_DISTRIBUTION_{system.upper()}_{arch.upper()}'] = str(Path(distribution).resolve())
    environment['CSC_IDENTITY_AUTO_DISCOVERY'] = 'false'
    # Invoke Node directly: no POSIX env-assignment syntax or MSYS paths reach
    # Windows electron-builder. The wrapper verifies the full fork inventory.
    subprocess.run(['node', str(root / 'scripts/package-electron-desktop.mjs'), *arguments],
                   cwd=root, env=environment, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['plan', 'platform', 'preflight', 'package'])
    parser.add_argument('--target', choices=['all', *TARGETS], default='all')
    parser.add_argument('--mode', choices=['validate', 'build'], default='validate')
    parser.add_argument('--root', type=Path, default=Path.cwd())
    parser.add_argument('--distribution', type=Path)
    args = parser.parse_args()
    if args.action == 'plan':
        result = json.dumps(plan(args.target, args.mode, os.environ), separators=(',', ':'))
        if os.environ.get('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as output:
                output.write('matrix=' + result + '\n')
        print(result)
    elif args.target == 'all':
        parser.error('This action requires one native target')
    elif args.action == 'platform':
        check_platform(args.target)
    elif args.action == 'preflight':
        preflight(args.target, args.root)
    elif not args.distribution:
        parser.error('package requires --distribution')
    else:
        package(args.target, args.distribution)


if __name__ == '__main__':
    main()
