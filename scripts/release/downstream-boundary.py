#!/usr/bin/env python3
"""Audit a downstream fork against upstream: every committed difference needs an explicit disposition.

A downstream product built on OpenCraft as a Git downstream should only add its
own assembly under private product roots. This tool compares two committed
trees (upstream vs downstream), classifies every differing path as approved or
pending according to a policy file, fails closed on anything unclassified, and
reports convergence metrics. It never fetches, merges, checks out or writes Git
state. See docs/develop/downstream-products.md.
"""
import argparse
import difflib
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import shutil
import subprocess

SCHEMA = 1
POLICY_KEYS = {'schema', 'product_roots', 'core_source_globs', 'core_duplicate_globs',
               'private_only_prefixes', 'pinned_differences'}
OPTIONAL_POLICY_KEYS = {'require_pinned_upstream'}
PIN_KEYS = {'path', 'upstream_entry', 'downstream_entry', 'reason'}
OPTIONAL_PIN_KEYS = {'upstream'}
UPSTREAM_LINK = re.compile(r'^(https://\S+|none: \S.*)$')
GIT_ENTRY = re.compile(r'^(100644|100755|120000) blob [0-9a-f]{40,64}$|^160000 commit [0-9a-f]{40,64}$')
DEFAULT_UPSTREAM_REF = 'upstream/main'

JS_SUFFIXES = ('.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts')
LANGUAGE_SUFFIXES = (
    (JS_SUFFIXES, 'js'),
    (('.py',), 'python'),
    (('.sh', '.bash'), 'shell'),
    (('.yml', '.yaml'), 'yaml'),
)
TOOLING_DIRS = {'scripts', 'tests'}
TEST_DIRS = {'tests', 'test', '__tests__'}
GENERATED = re.compile(r'(?:^|/)migrations/|\.generated\.[^/]+$|(?:^|/)[^/]*-lock\.ya?ml$')
# import/export ... from '<s>', bare import '<s>', import('<s>'), require('<s>')
RELATIVE_SPECIFIER = re.compile(
    r'''(?:\bfrom\s*|\bimport\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(['"])(\.{1,2}/[^'"\n]*)\1''')
DUPLICATE_RATIO = 0.8
DUPLICATE_MIN_TOKENS = 150


# --- Git ---------------------------------------------------------------------

def git(repo, *args):
    executable = shutil.which('git', path=os.defpath) or shutil.which('git')
    if executable is None:
        raise ValueError('Git executable is unavailable')
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM='1',
               GIT_NO_REPLACE_OBJECTS='1', GIT_TERMINAL_PROMPT='0')
    p = subprocess.run([executable, '-C', str(repo), *args], capture_output=True, env=env)
    if p.returncode:
        raise ValueError(f'git {args[0]} failed: ' + p.stderr.decode(errors='replace').strip())
    return p.stdout


def commit_of(repo, revision):
    return git(repo, 'rev-parse', '--verify', '--end-of-options', revision + '^{commit}').decode().strip()


def tree(repo, revision):
    """Committed entries of a revision as {path: 'MODE TYPE OID'}; the working tree is never read."""
    commit = commit_of(repo, revision)
    entries = {}
    for row in filter(None, git(repo, 'ls-tree', '-r', '-z', '--full-tree', commit).split(b'\0')):
        meta, _, path = row.partition(b'\t')
        entries[path.decode()] = meta.decode()
    return commit, entries


def resolve_upstream(repo, downstream, upstream_ref=DEFAULT_UPSTREAM_REF):
    """Default base: the newest upstream commit the downstream history really contains.

    Upstream work that has not been merged yet is therefore not reported as a
    downstream difference; `upstream_ahead` says how much of the ref is unmerged.
    """
    down, ref = commit_of(repo, downstream), commit_of(repo, upstream_ref)
    try:
        bases = git(repo, 'merge-base', '--all', down, ref).decode().split()
    except ValueError:  # git exits 1 when the histories share no commit
        bases = []
    if len(bases) != 1:
        raise ValueError(f'Expected exactly one merge base of {downstream} and {upstream_ref}, found {len(bases)}; '
                         'pass --upstream <commit> explicitly')
    ahead = int(git(repo, 'rev-list', '--count', f'{down}..{ref}').decode())
    return bases[0], dict(mode='merge-base', upstream_ref=upstream_ref, upstream_ref_commit=ref,
                          merge_base=bases[0], upstream_ahead=ahead)


class Blobs:
    """Reads committed blob text by entry, cached; binary blobs read as None."""

    def __init__(self, repo):
        self.repo, self.cache = repo, {}

    def text(self, entry):
        oid = entry.split()[2]
        if oid not in self.cache:
            data = git(self.repo, 'cat-file', 'blob', oid)
            self.cache[oid] = None if b'\0' in data else data.decode(errors='replace')
        return self.cache[oid]


# --- Policy ------------------------------------------------------------------

def clean_path(value, prefix=False):
    """Exact repository-relative path, or a rooted directory prefix ending in '/'."""
    if not isinstance(value, str):
        raise ValueError('Policy paths must be strings')
    raw = value[:-1] if prefix and value.endswith('/') else value
    p = PurePosixPath(raw)
    if (not raw or raw == '.' or p.is_absolute() or str(p) != raw or
            any(part in ('.', '..', '.git') for part in p.parts) or
            any(ord(c) < 32 or c in '*?[]\\' for c in raw) or
            (prefix and not value.endswith('/'))):
        raise ValueError(f'Policy must use exact paths or rooted directory prefixes: {value!r}')
    return value


def clean_glob(value):
    """Rooted glob: '*' and '?' match within one segment, a whole '**' segment matches any depth."""
    if not isinstance(value, str) or not value or value.startswith('/') or value.endswith('/'):
        raise ValueError(f'Invalid policy glob: {value!r}')
    parts = value.split('/')
    if (any(part in ('', '.', '..', '.git') for part in parts) or
            any(ord(c) < 32 or c in '[]\\' for c in value) or
            any('**' in part and part != '**' for part in parts)):
        raise ValueError(f'Invalid policy glob: {value!r}')
    return value


def glob_regex(pattern):
    if pattern == '**':
        return re.compile('^.*$')
    out, parts = [], pattern.split('/')
    for i, part in enumerate(parts):
        last = i == len(parts) - 1
        if part == '**':
            # A trailing '**' also matches the directory itself ('a/**' matches 'a').
            out.append('(?:/.*)?' if last else '(?:[^/]+/)*')
            continue
        segment = ''.join('[^/]*' if c == '*' else '[^/]' if c == '?' else re.escape(c) for c in part)
        out.append(segment + ('' if last else '/'))
    regex = ''.join(out)
    # Remove the separator before a trailing '**' group: 'a/' + '(?:/.*)?' -> 'a(?:/.*)?'.
    regex = regex.replace('/(?:/.*)?', '(?:/.*)?')
    return re.compile('^' + regex + '$')


class Globs:
    def __init__(self, patterns):
        self.patterns = [glob_regex(p) for p in patterns]

    def match(self, path):
        return any(p.match(path) for p in self.patterns)


def validate(policy):
    if not isinstance(policy, dict) or not POLICY_KEYS <= set(policy) <= POLICY_KEYS | OPTIONAL_POLICY_KEYS:
        raise ValueError(f'Policy keys must be {sorted(POLICY_KEYS)} plus optional {sorted(OPTIONAL_POLICY_KEYS)}')
    if policy['schema'] != SCHEMA:
        raise ValueError(f'Unknown policy schema {policy["schema"]!r}')
    require_upstream = policy.get('require_pinned_upstream', False)
    if not isinstance(require_upstream, bool):
        raise ValueError('require_pinned_upstream must be a boolean')
    for key in ('product_roots', 'core_source_globs', 'core_duplicate_globs',
                'private_only_prefixes', 'pinned_differences'):
        if not isinstance(policy[key], list):
            raise ValueError(f'{key} must be a list')
    roots = [clean_path(root, True) for root in policy['product_roots']]
    if len(set(roots)) != len(roots):
        raise ValueError('Duplicate product root')
    for key in ('core_source_globs', 'core_duplicate_globs'):
        globs = [clean_glob(g) for g in policy[key]]
        if len(set(globs)) != len(globs):
            raise ValueError(f'Duplicate glob in {key}')
    seen = set()
    for rule in policy['private_only_prefixes']:
        if (not isinstance(rule, dict) or set(rule) != {'prefix', 'reason'} or
                not isinstance(rule['reason'], str) or not rule['reason'].strip()):
            raise ValueError('Each private prefix needs exactly a prefix and a reason')
        prefix = clean_path(rule['prefix'], True)
        if prefix in seen:
            raise ValueError('Duplicate private prefix')
        seen.add(prefix)
    seen = set()
    for rule in policy['pinned_differences']:
        if (not isinstance(rule, dict) or not PIN_KEYS <= set(rule) <= PIN_KEYS | OPTIONAL_PIN_KEYS or
                not isinstance(rule['reason'], str) or not rule['reason'].strip()):
            raise ValueError('Pinned differences require a path, both exact Git entries and a reason')
        for side in ('upstream_entry', 'downstream_entry'):
            if rule[side] is not None and not (isinstance(rule[side], str) and GIT_ENTRY.match(rule[side])):
                raise ValueError(f'{side} must be "MODE TYPE OID" as git ls-tree prints it, or null')
        if rule['upstream_entry'] == rule['downstream_entry']:
            raise ValueError('A pinned difference must pin two different entries')
        if 'upstream' in rule and not (isinstance(rule['upstream'], str) and UPSTREAM_LINK.match(rule['upstream'])):
            raise ValueError('Pinned upstream must be an https PR URL or "none: <reason>"')
        if require_upstream and 'upstream' not in rule:
            raise ValueError('require_pinned_upstream: every pinned difference needs an upstream field')
        path = clean_path(rule['path'])
        if path in seen:
            raise ValueError('Duplicate pinned difference')
        seen.add(path)


# --- Classification of files -------------------------------------------------

def language(path):
    name = posixpath.basename(path)
    if name == 'Dockerfile' or name.startswith('Dockerfile.') or name.endswith('.Dockerfile'):
        return 'dockerfile'
    return next((lang for suffixes, lang in LANGUAGE_SUFFIXES if name.endswith(suffixes)), None)


def is_regular_blob(entry):
    mode, kind, _ = entry.split()
    return kind == 'blob' and mode in ('100644', '100755')


def is_test(path):
    parts = path.split('/')
    name = parts[-1]
    return (bool(TEST_DIRS & set(parts[:-1])) or '.test.' in name or '.spec.' in name or
            (name.endswith('.py') and (name.startswith('test_') or name.endswith('_test.py'))))


def under(path, prefixes):
    return next((p for p in prefixes if path.startswith(p)), None)


def private_scope(policy):
    """Prefixes that are product-owned, never core, even when a core glob would match them."""
    return policy['product_roots'] + [r['prefix'] for r in policy['private_only_prefixes']]


def product_sources(policy, entries):
    roots = policy['product_roots']
    return sorted(path for path, entry in entries.items()
                  if under(path, roots) and language(path) and is_regular_blob(entry)
                  and not GENERATED.search(path))


# --- Metrics -----------------------------------------------------------------

def core_deep_imports(policy, blobs, entries):
    """Relative JS/TS specifiers in product code that resolve into core package internals."""
    core = Globs(policy['core_source_globs'])
    private = private_scope(policy)
    sites = []
    for path in product_sources(policy, entries):
        if language(path) != 'js' or TOOLING_DIRS & set(path.split('/')[:-1]):
            continue
        text = blobs.text(entries[path]) or ''
        for match in RELATIVE_SPECIFIER.finditer(text):
            target = posixpath.normpath(posixpath.join(posixpath.dirname(path), match.group(2)))
            if not target.startswith('../') and core.match(target) and not under(target + '/', private):
                sites.append(dict(path=path, specifier=match.group(2), target=target))
    return sites


def private_product_lines(policy, blobs, entries):
    """Committed private source size: the downstream assembly that should stay small."""
    totals = dict(code=0, tests=0)
    for path in product_sources(policy, entries):
        text = blobs.text(entries[path])
        if text is not None:
            totals['tests' if is_test(path) else 'code'] += text.count('\n')
    return totals


C_COMMENTS = re.compile(r'/\*.*?\*/|//[^\n]*', re.S)
HASH_COMMENTS = re.compile(r'(?:^|(?<=\s))#[^\n]*')


def tokens(text, lang):
    """Lexical tokens without comments, quote style or separators, so a reformatted copy still matches."""
    text = (C_COMMENTS if lang == 'js' else HASH_COMMENTS).sub('', text).replace('"', "'")
    return [t for t in re.findall(r"\w+|[^\s\w]", text) if t not in (';', ',')]


def similarity(mine, theirs):
    matcher = difflib.SequenceMatcher(None, mine, theirs, autojunk=False)
    if matcher.real_quick_ratio() < DUPLICATE_RATIO or matcher.quick_ratio() < DUPLICATE_RATIO:
        return 0.0
    return matcher.ratio()


def core_near_duplicates(policy, blobs, entries):
    """Product files that are mostly a copy of a core file with the same name and language."""
    scope = Globs(policy['core_duplicate_globs'])
    excluded = private_scope(policy)
    core = {}
    for path, entry in entries.items():
        if (scope.match(path) and language(path) and is_regular_blob(entry)
                and not under(path, excluded) and not GENERATED.search(path)):
            core.setdefault(posixpath.basename(path), []).append(path)
    token_cache = {}

    def tokens_of(path):
        if path not in token_cache:
            text = blobs.text(entries[path])
            token_cache[path] = None if text is None else tokens(text, language(path))
        return token_cache[path]

    sites = []
    for path in product_sources(policy, entries):
        candidates = [c for c in core.get(posixpath.basename(path), ()) if language(c) == language(path)]
        if not candidates:
            continue
        mine = tokens_of(path)
        if mine is None or len(mine) < DUPLICATE_MIN_TOKENS:
            continue
        best = max(((similarity(mine, theirs), other) for other in sorted(candidates)
                    if (theirs := tokens_of(other)) is not None), default=(0.0, None))
        if best[0] >= DUPLICATE_RATIO:
            sites.append(dict(path=path, core=best[1], language=language(path), similarity=round(best[0], 2)))
    return sites


def metrics(policy, approved, pending, deep_imports, lines, duplicates):
    prefixes = [r['prefix'] for r in policy['private_only_prefixes']]
    per_prefix = {prefix: 0 for prefix in prefixes}
    outside = 0
    for row in approved + pending:
        if row['status'] != 'downstream-only':
            continue
        prefix = under(row['path'], prefixes)
        if prefix is None:
            outside += 1
        else:
            per_prefix[prefix] += 1
    return dict(pinned_shared_file_exceptions=sum(1 for row in approved if row.get('pinned')),
                private_prefix_files=per_prefix,
                core_deep_imports=len(deep_imports),
                downstream_only_outside_private_prefixes=outside,
                private_product_lines=lines,
                core_near_duplicates=len(duplicates))


# --- Audit -------------------------------------------------------------------

def classify(policy, left, right):
    pinned = {r['path']: r for r in policy['pinned_differences']}
    approved, pending = [], []
    for path in sorted(set(left) | set(right)):
        a, b = left.get(path), right.get(path)
        if a == b:
            continue
        row = dict(path=path, upstream_entry=a, downstream_entry=b,
                   status='downstream-only' if a is None else 'upstream-only' if b is None else 'modified')
        reason = None
        if a is None:  # a private prefix never exempts a path upstream also has
            reason = next((r['reason'] for r in policy['private_only_prefixes'] if path.startswith(r['prefix'])), None)
        rule = pinned.get(path)
        if rule and (a, b) == (rule['upstream_entry'], rule['downstream_entry']):
            reason, row['pinned'] = rule['reason'], True
            if 'upstream' in rule:
                row['upstream_link'] = rule['upstream']
        if reason:
            row['reason'] = reason
            approved.append(row)
        else:
            pending.append(row)
    return approved, pending


def audit(repo, upstream, downstream, policy):
    validate(policy)
    up, left = tree(repo, upstream)
    down, right = tree(repo, downstream)
    approved, pending = classify(policy, left, right)
    blobs = Blobs(repo)
    deep = core_deep_imports(policy, blobs, right)
    lines = private_product_lines(policy, blobs, right)
    duplicates = core_near_duplicates(policy, blobs, right)
    stale_pins = sorted(set(r['path'] for r in policy['pinned_differences']) -
                        set(row['path'] for row in approved if row.get('pinned')))
    return dict(schema=SCHEMA,
                policy_sha256=hashlib.sha256(json.dumps(policy, sort_keys=True).encode()).hexdigest(),
                upstream=up, downstream=down, clean_except_approved=not pending,
                total_differences=len(approved) + len(pending), approved_count=len(approved),
                pending_count=len(pending), unused_pins=stale_pins,
                metrics=metrics(policy, approved, pending, deep, lines, duplicates),
                approved=approved, pending=pending, core_deep_import_sites=deep,
                core_near_duplicate_sites=duplicates)


DETAIL_KEYS = ('approved', 'pending', 'core_deep_import_sites', 'core_near_duplicate_sites')


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--repo', default='.', help='Repository holding both commits (default: %(default)s)')
    p.add_argument('--policy', required=True, help='Policy JSON (see scripts/release/downstream-boundary.example.json)')
    p.add_argument('--upstream', help='Exact upstream commit. When omitted, use the merge base of '
                   '--downstream and --upstream-ref.')
    p.add_argument('--upstream-ref', default=DEFAULT_UPSTREAM_REF,
                   help='Upstream branch for the merge-base default (default: %(default)s)')
    p.add_argument('--downstream', default='HEAD', help='Downstream commit (default: %(default)s)')
    p.add_argument('--report', help='Write the full JSON report here; it lists private paths, keep it private')
    args = p.parse_args(argv)
    try:
        policy = json.loads(Path(args.policy).read_text(encoding='utf-8'))
        if args.upstream:
            upstream, selection = args.upstream, dict(mode='explicit', upstream=args.upstream)
        else:
            upstream, selection = resolve_upstream(args.repo, args.downstream, args.upstream_ref)
        report = audit(args.repo, upstream, args.downstream, policy)
        report['upstream_selection'] = selection
        if args.report:
            Path(args.report).write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(json.dumps({k: v for k, v in report.items() if k not in DETAIL_KEYS}, ensure_ascii=False))
        return 0 if report['clean_except_approved'] else 1
    except (ValueError, OSError, KeyError, TypeError) as error:
        p.exit(2, f'downstream-boundary: {error}\n')


if __name__ == '__main__':
    raise SystemExit(main())
