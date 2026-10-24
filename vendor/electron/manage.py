#!/usr/bin/env python3
"""Materialize and build the repository-owned Electron source fork."""

import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


HERE = Path(__file__).resolve().parent


def run(args, cwd=None, capture=False, env=None):
    return subprocess.run(
        [str(arg) for arg in args], cwd=cwd, env=env, check=True,
        text=True, stdout=subprocess.PIPE if capture else None,
    ).stdout


class Fork:
    def __init__(self, directory=HERE, root=None):
        self.directory = Path(directory).resolve()
        self.root = Path(root or self.directory / '.work').resolve()
        self.source = self.root / 'src' / 'electron'
        self.lock = json.loads((self.directory / 'fork.json').read_text())
        if self.lock.get('schemaVersion') != 1:
            raise ValueError('unsupported fork manifest version')
        if not re.fullmatch(r'[a-f0-9]{40}', self.lock['revision']):
            raise ValueError('upstream revision must be a full Git SHA')
        self.patches = []
        for entry in self.lock['patches']:
            path = (self.directory / entry['path']).resolve()
            if not path.is_relative_to(self.directory / 'patches'):
                raise ValueError('patch path escapes the patch directory')
            if hashlib.sha256(path.read_bytes()).hexdigest() != entry['sha256']:
                raise ValueError(f'patch checksum mismatch: {entry["path"]}')
            if path in self.patches:
                raise ValueError('duplicate patch')
            self.patches.append(path)

    def git(self, *args, capture=True, env=None):
        return run(['git', '-C', self.source, *args], capture=capture, env=env)

    def expected_tree(self):
        with tempfile.TemporaryDirectory(prefix='opencraft-electron-index-') as tmp:
            env = dict(os.environ, GIT_INDEX_FILE=str(Path(tmp) / 'index'))
            self.git('read-tree', self.lock['revision'], env=env)
            for patch in self.patches:
                self.git('apply', '--cached', '--whitespace=error', patch, env=env)
            tree = self.git('write-tree', env=env).strip()
            # An outer Electron patch can be valid while the Chromium patch it
            # creates has corrupt hunk counts. Validate the actual nested files
            # before checkout changes any branch or sync starts Chromium hooks.
            changed = self.git('diff', '--name-only', '--diff-filter=ACM', self.lock['revision'], tree,
                               '--', 'patches/chromium', env=env).splitlines()
            for path in changed:
                if path.endswith('.patch'):
                    payload = self.git('show', f'{tree}:{path}', env=env)
                    subprocess.run(['git', 'apply', '--numstat'], input=payload,
                                   text=True, stdout=subprocess.DEVNULL, check=True)
            return tree

    def verify(self):
        if not (self.source / '.git').exists():
            raise ValueError('source missing; run checkout first')
        if Path(self.git('rev-parse', '--show-toplevel').strip()).resolve() != self.source:
            raise ValueError('source is not its own Git checkout')
        if self.git('status', '--porcelain', '--untracked-files=all').strip():
            raise ValueError('source checkout is dirty; no files were reset')
        self.git('merge-base', '--is-ancestor', self.lock['revision'], 'HEAD')
        expected = self.expected_tree()
        if self.git('rev-parse', 'HEAD^{tree}').strip() != expected:
            raise ValueError('source tree differs from the pinned upstream + patches')
        return {
            'electronVersion': self.lock['version'],
            'chromiumVersion': self.lock['chromiumVersion'],
            'upstreamRevision': self.lock['revision'],
            'forkRevision': self.git('rev-parse', 'HEAD').strip(),
            'forkTree': expected,
            'patchCount': len(self.patches),
            'sourceVerified': True,
        }

    def checkout(self):
        self.source.parent.mkdir(parents=True, exist_ok=True)
        if not self.source.exists():
            run(['git', 'clone', '--no-checkout', '--filter=blob:none',
                 '--depth=1', '--branch', self.lock['tag'],
                 self.lock['repository'], self.source])
            # Check the immutable SHA before materializing or applying patches.
            if self.git('rev-parse', 'HEAD').strip() != self.lock['revision']:
                raise ValueError('upstream tag no longer matches the pinned revision')
            self.git('checkout', '--detach', self.lock['revision'], capture=False)
        if self.git('rev-parse', 'HEAD').strip() != self.lock['revision']:
            return self.verify()
        if self.git('status', '--porcelain', '--untracked-files=all').strip():
            raise ValueError('source checkout is dirty; no files were reset')
        # Validate the entire series before changing the source branch.
        expected = self.expected_tree()
        branch = 'opencraft/' + self.lock['tag']
        self.git('switch', '-c', branch, capture=False)
        identity = {
            'GIT_AUTHOR_NAME': 'OpenCraft Electron',
            'GIT_AUTHOR_EMAIL': 'electron-build@localhost',
            'GIT_COMMITTER_NAME': 'OpenCraft Electron',
            'GIT_COMMITTER_EMAIL': 'electron-build@localhost',
            'GIT_AUTHOR_DATE': self.lock['patchDate'],
            'GIT_COMMITTER_DATE': self.lock['patchDate'],
        }
        env = dict(os.environ, **identity)
        for patch in self.patches:
            self.git('apply', '--index', '--whitespace=error', patch, capture=False)
            self.git('-c', 'commit.gpgsign=false', 'commit', '-m',
                     'OpenCraft Electron: ' + patch.stem, capture=False, env=env)
        result = self.verify()
        if result['forkTree'] != expected:
            raise ValueError('fork tree changed during checkout')
        return result

    def sync(self):
        self.verify()
        if not shutil.which('gclient'):
            raise ValueError('gclient missing; install Chromium depot_tools and add it to PATH')
        config = (
            'solutions = [{"name": "src/electron", "managed": False, '
            f'"url": {self.lock["repository"]!r}, "deps_file": "DEPS", '
            '"custom_deps": {}, "custom_vars": {}}]\n'
        )
        path = self.root / '.gclient'
        if path.exists() and path.read_text() != config:
            raise ValueError('existing .gclient differs; it was not overwritten')
        if not path.exists():
            path.write_text(config)
        run(['gclient', 'sync', '--no-history', '--with_branch_heads', '--with_tags'],
            cwd=self.root)
        return self.verify()

    def build(self, jobs):
        result = self.verify()
        if sys.platform != 'linux':
            raise ValueError('the initial build command supports Linux; other targets are not validated')
        if not (self.root / 'src' / 'DEPS').exists():
            raise ValueError('Chromium source missing; run sync first')
        for tool in ['gn', 'ninja']:
            if not shutil.which(tool):
                raise ValueError(f'{tool} missing from PATH')
        out = 'out/OpenCraft'
        gn_args = (self.directory / 'args.gn').read_text()
        run(['gn', 'gen', out, '--args=' + gn_args], cwd=self.root / 'src')
        run(['ninja', '-C', out, '-j', str(jobs), 'electron'], cwd=self.root / 'src')
        result.update(executable=str(self.root / 'src' / out / 'electron'),
                      compiled=True, nativeProbePassed=False)
        return result


@contextlib.contextmanager
def operation_lock(root):
    root.mkdir(parents=True, exist_ok=True)
    path = root / '.opencraft-operation.lock'
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        raise ValueError(f'another operation owns {path}; inspect it before retrying') from None
    try:
        with os.fdopen(fd, 'w') as output:
            output.write(str(os.getpid()) + '\n')
        yield
    finally:
        path.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['status', 'checkout', 'verify', 'sync', 'build'])
    parser.add_argument('--root', type=Path, help='isolated gclient root (default: .work)')
    parser.add_argument('--jobs', type=int, default=16)
    args = parser.parse_args()
    if not 1 <= args.jobs <= 256:
        parser.error('--jobs must be between 1 and 256')
    try:
        fork = Fork(root=args.root)
        if args.action == 'status' and not fork.source.exists():
            result = {'sourceVerified': False, 'sourceMissing': True,
                      'electronVersion': fork.lock['version']}
        elif args.action in ['status', 'verify']:
            result = fork.verify()
        else:
            with operation_lock(fork.root):
                if args.action == 'checkout':
                    result = fork.checkout()
                elif args.action == 'sync':
                    result = fork.sync()
                else:
                    result = fork.build(args.jobs)
        print(json.dumps(result, indent=2))
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f'Electron fork: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
