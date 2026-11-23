"""Run with python3 -B -m unittest discover -s scripts/tests -p test_downstream_boundary.py."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'release' / 'downstream-boundary.py'
EXAMPLE = SCRIPT.with_name('downstream-boundary.example.json')
SPEC = importlib.util.spec_from_file_location('downstream_boundary', SCRIPT)
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)

CORE_GLOBS = ['apps/*/src/**', 'packages/*/src/**', 'plugins/*/src/**']


def policy(**overrides):
    base = dict(schema=1, product_roots=['products/'], core_source_globs=list(CORE_GLOBS),
                core_duplicate_globs=CORE_GLOBS + ['tests/**', 'deploy/**'],
                private_only_prefixes=[dict(prefix='products/', reason='Private product')],
                pinned_differences=[])
    base.update(overrides)
    return base


class GitRepoTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.g('init', '--initial-branch=main')
        self.g('config', 'user.name', 'Boundary Test')
        self.g('config', 'user.email', 'test@example.test')
        self.g('config', 'commit.gpgsign', 'false')
        self.write('shared.txt', 'base')
        self.write('products/shared.txt', 'upstream owned')
        self.up = self.commit()
        self.policy = policy()

    def g(self, *args):
        env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
        env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM='1')
        p = subprocess.run([shutil.which('git'), '-C', str(self.repo), *args], capture_output=True, text=True, env=env)
        self.assertEqual(p.returncode, 0, p.stderr)
        return p.stdout.strip()

    def write(self, name, content):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    def commit(self):
        self.g('add', '-A')
        self.g('commit', '--allow-empty', '-m', 'test commit')
        return self.g('rev-parse', 'HEAD')

    def audit(self, upstream=None, downstream='HEAD', rules=None):
        return m.audit(self.repo, upstream or self.up, downstream, rules or self.policy)

    def entries(self, revision):
        return m.tree(self.repo, revision)[1]


class ClassificationTests(GitRepoTest):
    def test_identical_tree_clean(self):
        report = self.audit()
        self.assertTrue(report['clean_except_approved'])
        self.assertEqual(report['total_differences'], 0)

    def test_private_addition_allowed(self):
        self.write('products/private.txt', 'private')
        self.commit()
        report = self.audit()
        self.assertTrue(report['clean_except_approved'])
        self.assertEqual(report['approved_count'], 1)

    def test_shared_file_under_private_prefix_not_exempt(self):
        self.write('products/shared.txt', 'changed')
        self.commit()
        report = self.audit()
        self.assertEqual(report['pending_count'], 1)
        self.assertFalse(report['clean_except_approved'])

    def test_unknown_addition_and_deletion_pending(self):
        self.write('new-runtime.ts', 'new')
        (self.repo / 'shared.txt').unlink()
        self.commit()
        self.assertEqual({r['status'] for r in self.audit()['pending']}, {'downstream-only', 'upstream-only'})

    def test_uncommitted_files_not_used_as_evidence(self):
        self.write('shared.txt', 'dirty')
        self.write('stray.txt', 'untracked')
        self.assertTrue(self.audit()['clean_except_approved'])

    def test_file_mode_change_is_not_hidden(self):
        (self.repo / 'shared.txt').chmod(0o755)
        self.commit()
        self.assertEqual(self.audit()['pending_count'], 1)

    def test_pinned_pair_expires_when_content_changes(self):
        self.write('shared.txt', 'private hook')
        self.commit()
        a, b = self.entries(self.up), self.entries('HEAD')
        self.policy['pinned_differences'] = [dict(path='shared.txt', upstream_entry=a['shared.txt'],
                                                  downstream_entry=b['shared.txt'], reason='Reviewed hook')]
        report = self.audit()
        self.assertTrue(report['clean_except_approved'])
        self.assertEqual((report['metrics']['pinned_shared_file_exceptions'], report['unused_pins']), (1, []))
        self.write('shared.txt', 'unreviewed second hook')
        self.commit()
        report = self.audit()
        self.assertFalse(report['clean_except_approved'])
        self.assertEqual(report['unused_pins'], ['shared.txt'])

    def test_pinned_deletion_uses_null_entry(self):
        a = self.entries(self.up)
        (self.repo / 'shared.txt').unlink()
        self.commit()
        self.policy['pinned_differences'] = [dict(path='shared.txt', upstream_entry=a['shared.txt'],
                                                  downstream_entry=None, reason='Reviewed removal')]
        self.assertTrue(self.audit()['clean_except_approved'])

    def test_product_roots_are_configurable(self):
        rules = policy(product_roots=['assembly/site/'],
                       private_only_prefixes=[dict(prefix='assembly/', reason='Private assembly')])
        self.write('assembly/site/main.ts', 'export const x = 1;\n')
        self.write('products/elsewhere.ts', 'export const y = 1;\n')
        self.commit()
        report = self.audit(rules=rules)
        self.assertEqual([r['path'] for r in report['pending']], ['products/elsewhere.ts'])
        self.assertEqual(report['metrics']['private_product_lines'], dict(code=1, tests=0))
        self.assertEqual(report['metrics']['private_prefix_files'], {'assembly/': 1})


class PolicyTests(unittest.TestCase):
    def test_example_policy_is_valid(self):
        m.validate(json.loads(EXAMPLE.read_text()))

    def test_unsafe_or_unexplained_policy_rejected(self):
        for prefix in ('../', '/', 'packages/*/', 'a//b/', 'packages', '.git/', 'a\\b/'):
            with self.subTest(prefix=prefix), self.assertRaises(ValueError):
                m.validate(policy(private_only_prefixes=[dict(prefix=prefix, reason='Invalid')]))
            with self.subTest(root=prefix), self.assertRaises(ValueError):
                m.validate(policy(product_roots=[prefix]))
        with self.assertRaises(ValueError):
            m.validate(policy(private_only_prefixes=[dict(prefix='products/', reason=' ')]))
        for key in ('product_roots', 'core_source_globs', 'core_duplicate_globs'):
            bad = policy()
            del bad[key]
            with self.subTest(missing=key), self.assertRaises(ValueError):
                m.validate(bad)
        with self.assertRaises(ValueError):
            m.validate(policy(unknown_rule=True))
        with self.assertRaises(ValueError):
            m.validate(policy(schema=2))

    def test_globs_validated(self):
        for glob in ('', '/apps/**', 'apps/', '../x/**', 'apps/**src', 'apps/[a]/**', 'a//b'):
            with self.subTest(glob=glob), self.assertRaises(ValueError):
                m.validate(policy(core_source_globs=[glob]))

    def test_glob_semantics(self):
        globs = m.Globs(['packages/*/src/**', '**/Dockerfile', 'tests/*.py'])
        for path in ('packages/core/src', 'packages/core/src/a.ts', 'packages/core/src/deep/a.ts',
                     'Dockerfile', 'deploy/docker/Dockerfile', 'tests/a.py'):
            with self.subTest(path=path):
                self.assertTrue(globs.match(path))
        for path in ('packages/core/srcx/a.ts', 'packages/core/lib/a.ts', 'packages/a/b/src/a.ts',
                     'Dockerfile.prod', 'tests/deep/a.py'):
            with self.subTest(path=path):
                self.assertFalse(globs.match(path))
        self.assertTrue(m.Globs(['**']).match('any/thing'))

    def test_pin_entries_and_upstream_link_validated(self):
        entry = '100644 blob ' + '1' * 40
        pin = dict(path='shared.txt', upstream_entry=entry, downstream_entry='100755 blob ' + '1' * 40, reason='Reviewed')
        m.validate(policy(pinned_differences=[pin]))
        for bad in ('x', '100644 blob short', '100644 tree ' + '1' * 40):
            with self.subTest(entry=bad), self.assertRaises(ValueError):
                m.validate(policy(pinned_differences=[dict(pin, downstream_entry=bad)]))
        with self.assertRaises(ValueError):
            m.validate(policy(pinned_differences=[dict(pin, downstream_entry=entry)]))
        with self.assertRaises(ValueError):
            m.validate(policy(require_pinned_upstream=True, pinned_differences=[pin]))
        for link in ('https://example.test/org/repo/pull/1', 'none: private product feature'):
            with self.subTest(link=link):
                m.validate(policy(require_pinned_upstream=True, pinned_differences=[dict(pin, upstream=link)]))
        for link in ('', 'none:', 'none: ', 'TODO', 'http://example.test/pr/1', None):
            with self.subTest(link=link), self.assertRaises(ValueError):
                m.validate(policy(pinned_differences=[dict(pin, upstream=link)]))
        with self.assertRaises(ValueError):
            m.validate(policy(require_pinned_upstream='yes'))


def js_body(name='value'):
    return '\n'.join(f"export const {name}{i} = compute({i}, 'name');" for i in range(30)) + '\n'


def py_body():
    return '\n'.join(f"def handler_{i}(event):\n    return dispatch(event, '{i}', retries={i})\n" for i in range(20))


def yaml_body():
    return 'services:\n' + ''.join(
        f"  svc{i}:\n    image: 'registry.example.test/app:{i}'\n    restart: always  # keep\n"
        f"    ports: ['{8000 + i}:80']\n" for i in range(15))


def shell_body():
    return '#!/bin/sh\nset -eu\n' + ''.join(f'install_part "{i}" --target "$ROOT/{i}" || exit {i}\n' for i in range(25))


def docker_body():
    return 'FROM node:22-slim AS build\nWORKDIR /app\n' + ''.join(
        f'RUN apt-get install -y package{i} && echo layer-{i}\n' for i in range(20)) + 'CMD ["node", "server.js"]\n'


class MetricTests(GitRepoTest):
    def test_metrics_count_pins_prefixes_and_outside_additions(self):
        self.write('shared.txt', 'private hook')
        self.write('products/a.txt', 'a')
        self.write('products/b.txt', 'b')
        self.write('stray.txt', 'unclassified')
        self.commit()
        a, b = self.entries(self.up), self.entries('HEAD')
        self.policy['private_only_prefixes'].append(dict(prefix='docs/private/', reason='Empty prefix'))
        self.policy['pinned_differences'] = [dict(path='shared.txt', upstream_entry=a['shared.txt'],
                                                  downstream_entry=b['shared.txt'], reason='Reviewed hook')]
        report = self.audit()
        self.assertEqual(report['metrics'], dict(
            pinned_shared_file_exceptions=1,
            private_prefix_files={'products/': 2, 'docs/private/': 0},
            core_deep_imports=0,
            downstream_only_outside_private_prefixes=1,
            private_product_lines=dict(code=0, tests=0),
            core_near_duplicates=0))
        self.assertEqual(report['pending_count'], 1)

    def test_product_size_and_js_near_duplicates(self):
        body = js_body()
        self.write('packages/core/src/runtime.ts', body)
        up = self.commit()
        # A reformatted copy (quotes, spacing, a few edits) still counts as a duplicate.
        copy = body.replace("'", '"').replace(' = ', '=').replace('value3 ', 'renamed3 ')
        self.write('products/app/runtime.ts', copy)
        self.write('products/app/other.ts', body)
        self.write('products/app/shim.ts', "export * from '@scope/core/runtime';\n")
        self.write('products/tests/runtime.test.ts', body)
        self.write('products/storage/migrations/0001.ts', body)
        self.commit()
        report = self.audit(upstream=up)
        self.assertEqual(report['metrics']['private_product_lines'], dict(code=61, tests=30))
        site, = report['core_near_duplicate_sites']
        self.assertEqual((site['path'], site['core'], site['language']),
                         ('products/app/runtime.ts', 'packages/core/src/runtime.ts', 'js'))
        self.assertGreaterEqual(site['similarity'], 0.8)

    def test_near_duplicates_cover_core_tests_and_deploy_languages(self):
        files = {
            'tests/server/session-store.test.ts': js_body('check'),
            'deploy/docker/handlers.py': py_body(),
            'deploy/docker/compose.yaml': yaml_body(),
            'deploy/docker/install.sh': shell_body(),
            'deploy/docker/Dockerfile': docker_body(),
            'packages/core/src/config/compose.yaml': yaml_body(),
        }
        for path, body in files.items():
            self.write(path, body)
        up = self.commit()
        self.write('products/tests/session-store.test.ts', files['tests/server/session-store.test.ts'].replace("'", '"'))
        self.write('products/deploy/handlers.py', '# product copy\n' + py_body().replace("'", '"'))
        self.write('products/deploy/compose.yaml', yaml_body().replace('  # keep', ''))
        self.write('products/deploy/install.sh', shell_body() + '# trailing note\n')
        self.write('products/deploy/Dockerfile', docker_body().replace('slim', 'bookworm'))
        # Same basename but a different language, and a small file below the token floor, are not copies.
        self.write('products/deploy/handlers.ts', js_body())
        self.write('products/deploy/tiny/Dockerfile', 'FROM node:22-slim\n')
        self.commit()
        rules = policy(core_duplicate_globs=['tests/**', 'deploy/**'])
        sites = {s['path']: (s['core'], s['language']) for s in self.audit(upstream=up, rules=rules)['core_near_duplicate_sites']}
        self.assertEqual(sites, {
            'products/tests/session-store.test.ts': ('tests/server/session-store.test.ts', 'js'),
            'products/deploy/handlers.py': ('deploy/docker/handlers.py', 'python'),
            'products/deploy/compose.yaml': ('deploy/docker/compose.yaml', 'yaml'),
            'products/deploy/install.sh': ('deploy/docker/install.sh', 'shell'),
            'products/deploy/Dockerfile': ('deploy/docker/Dockerfile', 'dockerfile'),
        })
        # Only configured roots are compared: package sources alone miss the test and deploy copies.
        narrow = policy(core_duplicate_globs=list(CORE_GLOBS))
        sites = [(s['path'], s['core']) for s in self.audit(upstream=up, rules=narrow)['core_near_duplicate_sites']]
        self.assertEqual(sites, [('products/deploy/compose.yaml', 'packages/core/src/config/compose.yaml')])

    def test_core_deep_imports_counted_from_committed_tree(self):
        self.write('products/app/x/entry.ts', '\n'.join([
            "import { a } from '../../../packages/core/src/a';",
            "export * from \"../../../apps/server/src/b.ts\";",
            "import '../../../plugins/im/src/side-effect';",
            "const c = await import('../../../packages/core/src/c');",
            "const d = require('../../../apps/server/src');",
            "import { pub } from '../../../packages/core/index';",
            "import { own } from '../plugins/x/src/own';",
            "import { pkg } from '@scope/core/src/not-relative';",
            "import { up } from '../../../../outside/packages/core/src/x';",
            "import {",
            "  e,",
            "} from '../../../packages/core/src/e';",
        ]))
        self.write('products/app/tests/t.test.ts', "import '../../../packages/core/src/a';")
        self.write('products/app/scripts/s.mjs', "import '../../../packages/core/src/a';")
        self.write('products/app/notes.md', "from '../../packages/core/src/a'")
        self.commit()
        self.write('products/app/x/dirty.ts', "import '../../../packages/core/src/a';")
        report = self.audit()
        self.assertEqual(report['metrics']['core_deep_imports'], 6)
        self.assertEqual({s['target'] for s in report['core_deep_import_sites']}, {
            'packages/core/src/a', 'apps/server/src/b.ts', 'plugins/im/src/side-effect',
            'packages/core/src/c', 'apps/server/src', 'packages/core/src/e'})

    def test_deep_imports_follow_configured_core_globs(self):
        self.write('products/app/entry.ts', "import '../../lib/core/internal/a';\nimport '../../packages/x/src/b';\n")
        self.commit()
        rules = policy(core_source_globs=['lib/*/internal/**'])
        self.assertEqual([s['target'] for s in self.audit(rules=rules)['core_deep_import_sites']],
                         ['lib/core/internal/a'])


class UpstreamSelectionTests(GitRepoTest):
    def fork(self):
        self.g('switch', '-c', 'product')
        self.write('products/private.txt', 'private')
        self.commit()

    def test_default_base_is_merge_base_with_upstream_ref(self):
        self.fork()
        self.g('switch', 'main')
        self.write('shared.txt', 'newer upstream work')
        newer = self.commit()
        self.g('switch', 'product')
        base, selection = m.resolve_upstream(self.repo, 'HEAD', 'main')
        self.assertEqual(base, self.up)
        self.assertEqual(selection, dict(mode='merge-base', upstream_ref='main', upstream_ref_commit=newer,
                                         merge_base=self.up, upstream_ahead=1))
        # Unmerged upstream work is not a downstream difference against the merge base ...
        self.assertTrue(self.audit(upstream=base)['clean_except_approved'])
        # ... but is pending against the upstream tip until it is merged.
        self.assertFalse(self.audit(upstream='main')['clean_except_approved'])
        self.g('merge', '--no-edit', 'main')
        base, selection = m.resolve_upstream(self.repo, 'HEAD', 'main')
        self.assertEqual((base, selection['upstream_ahead']), (newer, 0))

    def test_squashed_copy_without_shared_history_is_refused(self):
        self.g('switch', '--orphan', 'unrelated')
        self.write('shared.txt', 'squashed copy')
        self.commit()
        with self.assertRaises(ValueError):
            m.resolve_upstream(self.repo, 'HEAD', 'main')

    def test_cli_exit_codes_and_upstream_selection(self):
        self.fork()
        policy_file = self.repo.parent / f'{self.repo.name}-policy.json'
        policy_file.write_text(json.dumps(self.policy))
        self.addCleanup(policy_file.unlink)

        def run(*args, policy_path=policy_file):
            p = subprocess.run([sys.executable, '-B', str(SCRIPT), '--repo', str(self.repo),
                                '--policy', str(policy_path), *args], capture_output=True, text=True)
            return p.returncode, json.loads(p.stdout) if p.stdout else p.stderr

        code, summary = run('--upstream-ref', 'main')
        self.assertEqual(code, 0)
        self.assertEqual((summary['upstream'], summary['upstream_selection']['mode']), (self.up, 'merge-base'))
        self.assertNotIn('approved', summary)
        code, summary = run('--upstream', self.up)
        self.assertEqual((code, summary['upstream_selection']), (0, dict(mode='explicit', upstream=self.up)))
        self.write('stray.txt', 'unclassified')
        self.commit()
        report_file = self.repo.parent / f'{self.repo.name}-report.json'
        self.addCleanup(lambda: report_file.unlink(missing_ok=True))
        code, summary = run('--upstream-ref', 'main', '--report', str(report_file))
        self.assertEqual((code, summary['pending_count']), (1, 1))
        self.assertEqual(json.loads(report_file.read_text())['pending'][0]['path'], 'stray.txt')
        self.assertEqual(run('--upstream-ref', 'missing/main')[0], 2)
        policy_file.write_text(json.dumps(dict(self.policy, product_roots='products/')))
        self.assertEqual(run('--upstream-ref', 'main')[0], 2)
        policy_file.write_text('{not json')
        self.assertEqual(run('--upstream-ref', 'main')[0], 2)


if __name__ == '__main__':
    unittest.main()
