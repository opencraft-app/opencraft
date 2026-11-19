#!/usr/bin/env python3
"""Native Linux x64 Electron builder with an explicit persistent workspace."""
import argparse
import datetime
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import uuid

HERE = Path(__file__).resolve().parent


def mounted_workspace(path, mountinfo=None):
    if not path.is_absolute() or path == Path('/'):
        raise ValueError('Workspace must be an absolute dedicated mount')
    root = path.resolve()
    text = mountinfo if mountinfo is not None else Path('/proc/self/mountinfo').read_text()
    for line in text.splitlines():
        fields = line.split()
        if len(fields) < 6:
            continue
        target = re.sub(r'\\([0-7]{3})', lambda match: chr(int(match[1], 8)), fields[4])
        if target == str(root) and 'rw' in fields[5].split(','):
            return root
    raise ValueError('Mount a writable workspace; refusing the container writable layer')


def workspace_environment(root):
    home = root / 'home' / str(os.getuid())
    cache = root / 'cache'
    values = {
        'HOME': home, 'TMPDIR': root / 'tmp', 'XDG_CACHE_HOME': cache / 'xdg',
        'GIT_CACHE_PATH': cache / 'git', 'VPYTHON_VIRTUALENV_ROOT': cache / 'vpython',
        'CIPD_CACHE_DIR': cache / 'cipd', 'npm_config_cache': cache / 'npm',
        'DEPOT_TOOLS_GSUTIL_BIN_DIR': cache / 'gsutil',
    }
    for directory in values.values():
        directory.mkdir(parents=True, exist_ok=True)
    return {**os.environ, **{key: str(value) for key, value in values.items()},
            'DEPOT_TOOLS_UPDATE': '0', 'DEPOT_TOOLS_METRICS': '0'}


class Build:
    def __init__(self, root, jobs):
        self.root, self.jobs = root, jobs
        self.definition = (HERE / 'fork.json').read_bytes()
        self.identity = hashlib.sha256(self.definition).hexdigest()
        self.source = root / 'source' / self.identity
        self.output = root / 'artifacts' / self.identity
        self.environment = workspace_environment(root)
        self.run_id = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8]
        self.log = root / 'logs' / (self.run_id + '.log')
        self.receipt = root / 'logs' / (self.run_id + '.json')
        self.log.parent.mkdir(exist_ok=True)
        self.child = None
        self.state = {'schemaVersion': 1, 'runId': self.run_id,
                      'forkDefinitionSha256': self.identity, 'jobs': jobs,
                      'sourceRoot': str(self.source), 'log': str(self.log)}

    def prepare_depot_tools(self, installation=Path('/opt/depot_tools')):
        # CIPD and vpython bootstrap beside depot_tools, even with updates off.
        # Keep the warmed image immutable and give each workspace its own copy.
        revision = json.loads((HERE / 'container-inputs.json').read_text())['depotToolsRevision']
        destination = self.root / 'cache' / 'depot-tools' / revision
        if not destination.exists():
            destination.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(dir=destination.parent, prefix=revision + '.tmp-') as temporary:
                staged = Path(temporary) / 'tools'
                # Image-owned client executables can be execute-only; bootstrap
                # the checksum-verified client as this user and recreate locks.
                shutil.copytree(installation, staged, symlinks=True,
                                ignore=shutil.ignore_patterns('.lock', '.cipd_client'))
                staged.rename(destination)
        actual = subprocess.check_output(['git', '-C', str(destination), 'rev-parse', 'HEAD'], text=True).strip()
        if actual != revision:
            raise ValueError('Workspace depot_tools does not match the pinned revision')
        self.environment['PATH'] = str(destination) + os.pathsep + self.environment.get('PATH', '')
        self.state.update(depotToolsRevision=revision, depotToolsRoot=str(destination))

    def record(self, phase, **extra):
        self.state.update(phase=phase, updatedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(), **extra)
        temporary = self.receipt.with_suffix('.tmp')
        temporary.write_text(json.dumps(self.state, indent=2) + '\n')
        temporary.replace(self.receipt)

    def command(self, *arguments):
        with self.log.open('ab') as log:
            self.child = subprocess.Popen([str(value) for value in arguments], env=self.environment,
                                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                for line in self.child.stdout:
                    log.write(line)
                    log.flush()
                    sys.stdout.buffer.write(line)
                    sys.stdout.buffer.flush()
                status = self.child.wait()
                if status:
                    raise subprocess.CalledProcessError(status, arguments)
            finally:
                if self.child.poll() is None:
                    os.killpg(self.child.pid, signal.SIGTERM)
                    self.child.wait()
                self.child = None

    def stage(self, action):
        self.record(action)
        if action == 'preflight':
            self.command(sys.executable, HERE / 'ci.py', 'preflight', '--target', 'linux-x64', '--root', self.root)
            self.command('node', '-e', "if(typeof require(process.argv[1]).initializeNativeFocus !== 'function') throw new Error('Native probe focus helper missing')",
                         HERE.parents[1] / 'scripts/remote-browser/focus.cjs')
            self.command('gclient', '--version')
            self.command('cipd', 'version')
            self.command('gsutil.py', 'version', '-l')
        elif action in ('checkout', 'verify', 'sync', 'build'):
            arguments = [sys.executable, HERE / 'manage.py', action, '--root', self.source]
            if action == 'build':
                arguments += ['--jobs', self.jobs]
            self.command(*arguments)
        else:
            self.prepare_browser()

    def prepare_browser(self):
        if (HERE / 'fork.json').read_bytes() != self.definition:
            raise ValueError('Fork definition changed during the build')
        archive = self.source / 'src/out/OpenCraft/dist.zip'
        if not archive.is_file():
            raise ValueError('Build dist.zip before preparing the browser artifact')
        # Reuse the validated archive extractor; browser and desktop inventories
        # are independently stamped on separate fresh distributions.
        spec = importlib.util.spec_from_file_location('desktop_artifact', HERE / 'prepare-desktop-artifact.py')
        extractor = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(extractor)
        destination = self.output / self.run_id
        distribution = destination / 'browser'
        evidence = destination / 'evidence'
        extractor.extract_archive(archive, distribution)
        self.command(sys.executable, HERE / 'prepare-artifact.py', '--distribution', distribution,
                     '--source-root', self.source, '--evidence', evidence)
        marker = json.loads((distribution / 'opencraft-electron-artifact.json').read_text())
        if marker.get('forkDefinitionSha256') != self.identity:
            raise ValueError('Artifact does not match this build definition')
        provenance = {'schemaVersion': 1, 'forkDefinitionSha256': self.identity,
                      'containerInputs': json.loads((HERE / 'container-inputs.json').read_text()),
                      'distribution': str(distribution), 'evidence': str(evidence),
                      'runtimeArchive': str(archive)}
        (destination / 'build.json').write_text(json.dumps(provenance, indent=2) + '\n')
        shutil.copy2(HERE.parents[1] / 'os-packages.txt', destination / 'os-packages.txt')
        self.record('browser-artifact', artifact=str(destination))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['preflight', 'checkout', 'verify', 'sync', 'build', 'browser-artifact', 'all', 'resume'], nargs='?', default='preflight')
    parser.add_argument('--workspace', type=Path, default=Path(os.environ.get('OPENCRAFT_ELECTRON_WORKSPACE', '/workspace')))
    parser.add_argument('--jobs', type=int, default=4)
    args = parser.parse_args()
    if not 1 <= args.jobs <= 256:
        parser.error('--jobs must be between 1 and 256')
    if sys.platform != 'linux' or os.uname().machine != 'x86_64':
        parser.error('This builder supports native Linux x64 only')
    build = None
    try:
        root = mounted_workspace(args.workspace)
        with (root / '.electron-build.lock').open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                print('Another Electron build owns this workspace', file=sys.stderr)
                return 75
            build = Build(root, args.jobs)
            print(json.dumps({'runId': build.run_id, 'receipt': str(build.receipt)}), flush=True)
            def interrupted(_signal, _frame):
                raise KeyboardInterrupt
            signal.signal(signal.SIGTERM, interrupted)
            build.record('preparing-depot-tools')
            build.prepare_depot_tools()
            stages = {
                'all': ['preflight', 'checkout', 'sync', 'build', 'browser-artifact'],
                'resume': ['verify', 'build', 'browser-artifact'],
            }.get(args.action, [args.action])
            for stage in stages:
                build.stage(stage)
            build.record('succeeded')
    except KeyboardInterrupt:
        if build:
            build.record('interrupted')
        return 130
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        if build:
            build.record('failed', error=str(error))
        print('Electron builder: ' + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
