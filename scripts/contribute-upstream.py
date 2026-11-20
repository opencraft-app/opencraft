#!/usr/bin/env python3
"""Export explicitly selected downstream changes to a clean public PR branch."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tempfile


def run(args, cwd=None, data=None):
    env = {k: v for k, v in os.environ.items() if not k.startswith(('GIT_', 'GITLEAKS_'))}
    env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null', GIT_TERMINAL_PROMPT='0')
    if args[0] == 'git':
        native_git = shutil.which('git', path=os.defpath)
        if native_git is None:
            raise ValueError('Git executable is unavailable')
        args = [native_git, *args[1:]]
    p = subprocess.run(args, cwd=cwd, input=data, capture_output=True, env=env)
    if p.returncode:
        raise ValueError(f'{args[0]} {args[1]} failed: ' + p.stderr.decode(errors='replace'))
    return p.stdout


def git(repo, *args, data=None):
    return run(['git', '-C', str(repo), *args], data=data)


def safe_path(value):
    path = PurePosixPath(value)
    if (not value or value == '.' or path.is_absolute() or str(path) != value or
            any(p in ('.', '..', '.git') for p in path.parts) or
            any(ord(c) < 32 or c in '\\:*?[' for c in value)):
        raise ValueError('Expected an exact repository-relative file path')
    lowered = value.lower()
    if (lowered.startswith(('products/', 'docs/internal', '.ci/')) or
            any(p.lower().startswith('.env') or p.lower() in ('.ssh', 'secrets', 'credentials', 'id_rsa', 'id_ed25519') for p in path.parts) or
            lowered.endswith(('.pem', '.key', '.p12'))):
        raise ValueError('Private/configuration path cannot be exported')
    return value


def slug(value):
    if (not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]*/[A-Za-z0-9_][A-Za-z0-9_.-]*', value)):
        raise ValueError('Expected owner/repository')
    return value


def contribution_branch(value, upstream_branch):
    if not value.startswith('contrib/') or value == upstream_branch:
        raise ValueError('Only contrib/* branches may be published')
    run(['git', 'check-ref-format', '--branch', value])
    return value


def approval_digest(receipt):
    # Private source IDs/paths remain local. Public target, candidate and lease
    # are part of the explicit approval, not just the textual diff.
    fields = ('schema', 'repo', 'branch', 'upstream_branch', 'upstream',
              'commit', 'expected_remote', 'review_sha256')
    return hashlib.sha256(json.dumps({k: receipt[k] for k in fields},
                                    sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def remote_tip(destination, branch, repo):
    rows = git(destination, 'ls-remote', '--heads', 'https://github.com/' + slug(repo) + '.git',
               'refs/heads/' + branch).decode().splitlines()
    if len(rows) > 1:
        raise ValueError('Ambiguous remote branch')
    return rows[0].split()[0] if rows else ''


def scan_candidate(destination, upstream, scanner):
    changed = git(destination, 'diff', '--name-only', '-z', upstream, 'HEAD').split(b'\0')
    with tempfile.TemporaryDirectory(prefix='public-contribution-scan-') as temp:
        root = Path(temp)
        target = root / 'payload'
        target.mkdir()
        for value in filter(None, changed):
            name = safe_path(value.decode())
            if git(destination, 'ls-files', '--stage', '--', name):
                output = target / 'files' / name
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_bytes(git(destination, 'show', 'HEAD:' + name))
        (target / 'commit-message.txt').write_bytes(git(destination, 'show', '-s', '--format=%B', 'HEAD'))
        # Neither a candidate config, a local ignore file nor inline allow
        # comments can redefine the approval gate. The policy lives outside payload.
        config = root / 'trusted.toml'
        config.write_text('[extend]\nuseDefault = true\n')
        ignore = root / 'empty-ignore'
        ignore.write_text('')
        run([str(Path(scanner).resolve()), 'dir', str(target), '--config', str(config),
             '--gitleaks-ignore-path', str(ignore), '--ignore-gitleaks-allow',
             '--redact', '--no-banner'])


def matching_prs(receipt):
    rows = json.loads(run(['gh', 'pr', 'list', '--repo', receipt['repo'],
                          '--head', receipt['branch'], '--state', 'all', '--limit', '100',
                          '--json', 'number,url,state,baseRefName,headRefName,headRefOid,isCrossRepository']))
    matches = [row for row in rows if row['headRefName'] == receipt['branch']
               and not row['isCrossRepository']]
    if any(row['baseRefName'] != receipt['upstream_branch'] for row in matches):
        raise ValueError('Existing PR targets a different base branch')
    if any(row['state'] != 'OPEN' for row in matches):
        raise ValueError('Branch has a closed/merged PR; choose a new contrib branch')
    if len(matches) > 1:
        raise ValueError('Ambiguous existing PR')
    return matches


def prepare(args):
    paths = sorted(set(safe_path(p) for p in args.path))
    source = Path(args.source).resolve()
    base = git(source, 'rev-parse', '--verify', '--end-of-options', args.base + '^{commit}').decode().strip()
    head = git(source, 'rev-parse', '--verify', '--end-of-options', args.head + '^{commit}').decode().strip()
    git(source, 'merge-base', '--is-ancestor', base, head)
    for revision in (base, head):
        rows = git(source, 'ls-tree', '-z', revision, '--', *paths).split(b'\0')
        for row in filter(None, rows):
            mode, kind, _ = row.partition(b'\t')[0].split()
            if mode not in (b'100644', b'100755') or kind != b'blob':
                raise ValueError('Only regular files may be exported')
    patch = git(source, 'diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames',
                base, head, '--', *paths)
    if not patch:
        raise ValueError('No selected changes')
    repo = slug(args.repo)
    destination = Path(args.destination).resolve()
    if destination.exists():
        raise ValueError('Destination must not exist')
    contribution_branch(args.branch, args.upstream_branch)
    run(['git', 'clone', '--single-branch', '--branch', args.upstream_branch,
         'https://github.com/' + repo + '.git', str(destination)])
    upstream = git(destination, 'rev-parse', 'HEAD').decode().strip()
    expected_remote = remote_tip(destination, args.branch, repo)
    previous_path = getattr(args, 'previous_receipt', None)
    if expected_remote:
        if not previous_path:
            raise ValueError('Existing branch requires --previous-receipt for an explicit update')
        previous = json.loads(Path(previous_path).read_text())
        if (previous['repo'] != repo or previous['branch'] != args.branch or
                previous['upstream_branch'] != args.upstream_branch or
                previous['commit'] != expected_remote):
            raise ValueError('Previous receipt does not match the remote head; do not overwrite others')
    elif previous_path:
        raise ValueError('Previous branch no longer exists; choose a new contribution')
    git(destination, 'switch', '-c', args.branch)
    git(destination, 'apply', '--index', '--binary', '-', data=patch)
    changed = git(destination, 'diff', '--cached', '--name-only', '-z').split(b'\0')
    if any(p.decode() not in paths for p in filter(None, changed)):
        raise ValueError('Patch changed a path outside the explicit selection')
    message = args.message
    for author in getattr(args, 'co_author', []) or []:
        if not re.fullmatch(r'[^<>\r\n]+ <[^<>\s]+@[^<>\s]+>', author):
            raise ValueError('Expected co-author as Name <email>; review consent before publication')
        message += '\n\nCo-authored-by: ' + author
    git(destination, '-c', 'user.name=' + args.name, '-c', 'user.email=' + args.email,
        'commit', '-m', message)
    scan_candidate(destination, upstream, args.gitleaks)
    commit = git(destination, 'rev-parse', 'HEAD').decode().strip()
    review = git(destination, 'diff', '--binary', upstream, commit)
    receipt = dict(schema=2, repo=repo, destination=str(destination), branch=args.branch,
                   upstream_branch=args.upstream_branch, upstream=upstream, commit=commit,
                   source_base=base, source_head=head, paths=paths,
                   review_sha256=hashlib.sha256(review).hexdigest(), secret_scan='passed',
                   expected_remote=expected_remote)
    receipt['approval_sha256'] = approval_digest(receipt)
    receipt_path = destination.parent / (destination.name + '.contribution.json')
    fd = os.open(receipt_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(receipt, stream, indent=2)
    print(json.dumps(dict(receipt=str(receipt_path), **receipt), indent=2))


def publish(args):
    receipt = json.loads(Path(args.receipt).read_text())
    destination = Path(receipt['destination'])
    repo = slug(receipt['repo'])
    if receipt.get('schema') != 2 or receipt.get('secret_scan') != 'passed':
        raise ValueError('Prepare a new schema-2 receipt with the hardened scan gate')
    contribution_branch(receipt['branch'], receipt['upstream_branch'])
    digest = approval_digest(receipt)
    if digest != receipt['approval_sha256'] or digest != args.approve_sha256:
        raise ValueError('Approval mismatch: target, candidate or lease changed')
    if git(destination, 'status', '--porcelain').strip():
        raise ValueError('Public checkout has uncommitted changes')
    if git(destination, 'rev-parse', 'HEAD').decode().strip() != receipt['commit']:
        raise ValueError('Candidate commit changed')
    review = git(destination, 'diff', '--binary', receipt['upstream'], receipt['commit'])
    if hashlib.sha256(review).hexdigest() != receipt['review_sha256']:
        raise ValueError('Review digest mismatch')
    if git(destination, 'rev-list', '--parents', '-1', 'HEAD').decode().split() != [receipt['commit'], receipt['upstream']]:
        raise ValueError('Candidate must have exactly the clean public base parent')
    git(destination, 'fetch', '--no-tags', 'https://github.com/' + repo + '.git',
        'refs/heads/' + receipt['upstream_branch'])
    git(destination, 'merge-base', '--is-ancestor', receipt['upstream'], 'FETCH_HEAD')
    # Never rely on a writable receipt's scan flag alone at the network boundary.
    scan_candidate(destination, receipt['upstream'], args.gitleaks)
    rows = matching_prs(receipt)
    tip = remote_tip(destination, receipt['branch'], repo)
    if tip not in (receipt['expected_remote'], receipt['commit']):
        raise ValueError('Remote branch changed since preparation; preserve contributor work')
    if rows and rows[0]['headRefOid'] not in (receipt['expected_remote'], receipt['commit']):
        raise ValueError('PR head changed; fetch and review before updating')
    if tip != receipt['commit']:
        git(destination, '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
            'push', '--force-with-lease=refs/heads/' + receipt['branch'] + ':' + receipt['expected_remote'],
            'https://github.com/' + repo + '.git',
            receipt['commit'] + ':refs/heads/' + receipt['branch'])
    # Recheck state after publication, including interrupted create recovery.
    rows = matching_prs(receipt)
    if rows:
        print(rows[0]['url'])
    else:
        print(run(['gh', 'pr', 'create', '--repo', repo, '--base', receipt['upstream_branch'],
                   '--head', receipt['branch'], '--title', args.title,
                   '--body-file', args.body_file]).decode().strip())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    p = sub.add_parser('prepare')
    for name in ('source', 'base', 'head', 'destination', 'branch', 'repo', 'gitleaks', 'name', 'email', 'message'):
        p.add_argument('--' + name, required=True)
    p.add_argument('--path', action='append', required=True)
    p.add_argument('--upstream-branch', default='main')
    p.add_argument('--previous-receipt')
    p.add_argument('--co-author', action='append', default=[])
    p = sub.add_parser('publish')
    for name in ('receipt', 'approve-sha256', 'title', 'body-file', 'gitleaks'):
        p.add_argument('--' + name, required=True)
    args = parser.parse_args()
    try:
        (prepare if args.action == 'prepare' else publish)(args)
    except (ValueError, OSError) as error:
        parser.exit(1, str(error) + '\n')


if __name__ == '__main__':
    main()
