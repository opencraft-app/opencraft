#!/usr/bin/env python3
"""Restore a native CI archive with its separately uploaded probe inventory."""
import argparse
import importlib.util
from pathlib import Path
import shutil

HERE = Path(__file__).resolve().parent


def restore(directory, distribution, kind):
    marker = 'opencraft-electron-' + ('desktop-artifact.json' if kind == 'desktop' else 'artifact.json')
    # upload-artifact's common root can include nested evidence directories.
    candidates = [path for path in directory.rglob(marker) if (path.parent / 'dist.zip').is_file()]
    if len(candidates) != 1:
        raise ValueError('Expected exactly one dist.zip and ' + marker + ' from a successful native build')
    source = candidates[0]
    spec = importlib.util.spec_from_file_location('desktop_artifact', HERE / 'prepare-desktop-artifact.py')
    extractor = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(extractor)
    extractor.extract_archive(source.parent / 'dist.zip', distribution)
    shutil.copy2(source, distribution / marker)
    # The consumer MUST verify fork identity, native probes and complete bytes
    # with remote-browser-artifact.mjs or electron-distribution.mjs before use.


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--distribution', type=Path, required=True)
    parser.add_argument('--kind', choices=['browser', 'desktop'], required=True)
    args = parser.parse_args()
    restore(args.directory, args.distribution, args.kind)
