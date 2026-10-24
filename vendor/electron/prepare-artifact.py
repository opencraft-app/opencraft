#!/usr/bin/env python3
"""Probe an owned Linux distribution and inventory the exact shipped bytes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys


def sha(path):
    result = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--distribution', type=Path, required=True)
    parser.add_argument('--strip-unneeded', action='store_true', help='Strip nonessential ELF symbols before probing and inventorying')
    parser.add_argument('--source-root', type=Path, required=True,
                        help='The verified source workspace containing src/electron')
    parser.add_argument('--evidence', type=Path, required=True)
    args = parser.parse_args()
    here = Path(__file__).resolve().parent
    distribution = args.distribution.resolve()
    definition = here / 'fork.json'
    lock = json.loads(definition.read_text())
    if sys.platform != 'linux':
        raise ValueError('Only the Linux owned distribution is validated')
    marker = distribution / 'opencraft-electron-artifact.json'
    if marker.exists():
        raise ValueError('Use a fresh distribution directory, not an existing stamped artifact')
    for name in ['electron', 'LICENSE', 'LICENSES.chromium.html']:
        if not (distribution / name).is_file():
            raise ValueError('Incomplete distribution: ' + name)
    verified = subprocess.run([sys.executable, str(here / 'manage.py'), 'verify', '--root', str(args.source_root)],
                              check=True, text=True, capture_output=True)
    source = json.loads(verified.stdout)
    stripped = None
    if args.strip_unneeded:
        tool = args.source_root.resolve() / 'src/third_party/llvm-build/Release+Asserts/bin/llvm-strip'
        count = 0
        for path in sorted(distribution.rglob('*')):
            if path.is_symlink():
                raise ValueError('Owned distribution must contain regular files')
            if path.is_file():
                with path.open('rb') as stream:
                    elf = stream.read(4) == b'\x7fELF'
                if elf:
                    subprocess.run([str(tool), '--strip-unneeded', str(path)], check=True)
                    count += 1
        stripped = dict(toolSha256=sha(tool), flags=['--strip-unneeded'], files=count)

    environment = {key: value for key, value in os.environ.items()
                   if key not in ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'DISPLAY', 'WAYLAND_DISPLAY']}
    probe = subprocess.run([str(distribution / 'electron'), '--no-sandbox', '--ozone-platform=headless',
                            str(here / 'probe-native-clipboard.cjs')], env=environment,
                           text=True, capture_output=True, timeout=90)
    args.evidence.mkdir(parents=True, exist_ok=True)
    (args.evidence / 'native-copy.stdout.log').write_text(probe.stdout)
    (args.evidence / 'native-copy.stderr.log').write_text(probe.stderr)
    probe.check_returncode()
    result = json.loads(probe.stdout)
    if result.get('nativeCopyProbePassed') is not True or not result.get('cases') or not all(case.get('passed') is True for case in result['cases']):
        raise ValueError('Native copy probe did not pass')
    if result['versions']['electron'] != lock['version'] or result['versions']['chrome'] != lock['chromiumVersion']:
        raise ValueError('Distribution runtime version does not match fork')
    files = []
    for path in sorted(distribution.rglob('*')):
        if path.is_symlink():
            raise ValueError('Distribution inventory requires regular files: ' + str(path))
        if path.is_file():
            files.append(dict(path=path.relative_to(distribution).as_posix(),
                              size=path.stat().st_size, sha256=sha(path)))
    value = dict(schemaVersion=1, platform='linux', arch={'x86_64': 'x64', 'aarch64': 'arm64'}[os.uname().machine],
                 forkDefinitionSha256=sha(definition), electronVersion=lock['version'],
                 chromiumVersion=lock['chromiumVersion'], nativeCopyProbePassed=True,
                 source=source, files=files)
    if stripped is not None:
        value['elfStripping'] = stripped
    marker.write_text(json.dumps(value, indent=2) + '\n')
    (args.evidence / 'native-copy-result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(dict(artifactVerified=True, nativeCopyProbePassed=True,
                         files=len(files), markerSha256=sha(marker))))


if __name__ == '__main__':
    main()
