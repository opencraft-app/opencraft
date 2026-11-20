"""Run with python3 -m unittest discover -s scripts/tests -p test_contribute_upstream.py."""
import importlib.util
from pathlib import Path
import tempfile
import contextlib
import hashlib
import io
import json
import os
import shutil
import types
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('contribute', Path(__file__).resolve().parents[1] / 'contribute-upstream.py')
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class ContributionTests(unittest.TestCase):
    def test_exact_public_file_paths(self):
        for value in ('scripts/helper.py', 'docs/contribution.md', 'packages/core/src/index.ts'):
            self.assertEqual(module.safe_path(value), value)

    def test_private_and_ambiguous_paths_rejected(self):
        for value in ('', '.', '../secret', '/etc/passwd', 'a/../b', './a', 'a//b',
                      '.git/config', 'a/.git/config', 'products/private.ts',
                      'docs/internal-distribution/config.md', '.ci/private.py',
                      '.env', '.env.production', '.ssh/id_rsa', 'secrets/key', 'credentials/token',
                      'key.pem', 'a\\b', 'a\nb', ':(glob)**', '*.ts'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                module.safe_path(value)

    def test_repo_option_injection_rejected(self):
        for value in ('--help', 'https://example.com/repo', '../repo', 'a/b/c', 'a/b\nx'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                module.slug(value)

    def test_git_environment_does_not_inherit_object_or_config_overrides(self):
        import subprocess
        with patch.dict(module.os.environ, {'GIT_OBJECT_DIRECTORY': '/wrong', 'GIT_CONFIG_COUNT': '1'}), patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, b'ok', b'')) as call:
            self.assertEqual(module.run(['git', 'version']), b'ok')
            env = call.call_args.kwargs['env']
            self.assertNotIn('GIT_OBJECT_DIRECTORY', env)
            self.assertNotIn('GIT_CONFIG_COUNT', env)
            self.assertEqual(env['GIT_TERMINAL_PROMPT'], '0')

    def test_no_secret_stdout_on_failure(self):
        import subprocess
        with patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, b'private stdout', b'failed')):
            with self.assertRaisesRegex(ValueError, 'failed') as error:
                module.run(['git', 'diff'])
            self.assertNotIn('private stdout', str(error.exception))


class PublicationGuardTests(unittest.TestCase):
    def test_approval_binds_every_public_target_and_candidate_field(self):
        receipt = dict(schema=2, repo='owner/repo', branch='contrib/test',
                       upstream_branch='main', upstream='a'*40, commit='b'*40,
                       expected_remote='', review_sha256='c'*64)
        digest = module.approval_digest(receipt)
        for field in receipt:
            modified = dict(receipt)
            modified[field] = str(modified[field]) + 'changed'
            with self.subTest(field=field):
                self.assertNotEqual(module.approval_digest(modified), digest)

    def test_only_contribution_branches_allowed(self):
        for branch in ('main', 'master', 'release/v1', 'refs/heads/contrib/a'):
            with self.subTest(branch=branch), self.assertRaises(ValueError):
                module.contribution_branch(branch, 'main')

    def test_closed_merged_and_wrong_base_prs_refused(self):
        receipt = dict(repo='owner/repo', branch='contrib/test', upstream_branch='main')
        row = dict(number=1, url='unused', state='OPEN', baseRefName='main',
                   headRefName='contrib/test', headRefOid='a'*40, isCrossRepository=False)
        for changes in (dict(state='CLOSED'), dict(state='MERGED'), dict(baseRefName='release')):
            with self.subTest(changes=changes), patch.object(module, 'run', return_value=json.dumps([dict(row, **changes)]).encode()):
                with self.assertRaises(ValueError):
                    module.matching_prs(receipt)


class TransactionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='upstream-export-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.native = module.run
        self.scanner = os.environ.get('GITLEAKS_TEST_BIN') or shutil.which('gitleaks')
        if not self.scanner:
            self.skipTest('Set GITLEAKS_TEST_BIN to run real scanner/transaction regressions')
        self.remote = self.root / 'upstream.git'
        self.source = self.root / 'source'
        self.native(['git', 'init', '--bare', '--initial-branch=main', str(self.remote)])
        self.native(['git', 'init', '--initial-branch=main', str(self.source)])
        self.g(self.source, 'config', 'user.name', 'Source Contributor')
        self.g(self.source, 'config', 'user.email', 'source@example.test')
        (self.source / 'shared.txt').write_text('base\n')
        self.g(self.source, 'add', '.')
        self.g(self.source, 'commit', '-m', 'public base')
        self.base = self.g(self.source, 'rev-parse', 'HEAD').decode().strip()
        self.g(self.source, 'push', str(self.remote), 'main')
        (self.source / 'shared.txt').write_text('feature v1\n')
        self.g(self.source, 'commit', '-am', 'native contribution')
        self.pr_rows = []
        self.pr_creates = 0
        self.race = False
        self.patcher = patch.object(module, 'run', side_effect=self.transport)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def g(self, repo, *args):
        return self.native(['git', '-C', str(repo), *args])

    def transport(self, args, **kwargs):
        if args[0] == 'gh':
            if args[1:3] == ['pr', 'list']:
                return json.dumps(self.pr_rows).encode()
            self.pr_creates += 1
            oid = self.g(self.remote, 'rev-parse', 'refs/heads/contrib/test').decode().strip()
            self.pr_rows = [dict(number=1, url='https://example.invalid/pr/1', state='OPEN',
                                baseRefName='main', headRefName='contrib/test',
                                headRefOid=oid, isCrossRepository=False)]
            return b'https://example.invalid/pr/1\n'
        args = [str(self.remote) if a == 'https://github.com/owner/repo.git' else a for a in args]
        if 'push' in args and self.race:
            self.race = False
            # A writer moves the remote after the earlier tip check.
            tree = self.g(self.source, 'rev-parse', 'HEAD^{tree}').decode().strip()
            oid = self.g(self.source, 'commit-tree', tree, '-p', self.base, '-m', 'concurrent writer').decode().strip()
            self.g(self.source, 'push', '--force', str(self.remote), oid + ':refs/heads/contrib/test')
        result = self.native(args, **kwargs)
        if 'push' in args and self.pr_rows:
            self.pr_rows[0]['headRefOid'] = self.g(self.remote, 'rev-parse', 'refs/heads/contrib/test').decode().strip()
        return result

    def prepare(self, name, previous=None, paths=None, message='public contribution'):
        args = types.SimpleNamespace(source=str(self.source), base=self.base, head='HEAD',
            destination=str(self.root/name), repo='owner/repo', branch='contrib/test',
            upstream_branch='main', gitleaks=self.scanner, name='Maintainer',
            email='maintainer@example.test', message=message, path=paths or ['shared.txt'],
            previous_receipt=str(previous) if previous else None,
            co_author=['Source Contributor <source@example.test>'])
        with contextlib.redirect_stdout(io.StringIO()):
            module.prepare(args)
        return self.root/(name+'.contribution.json')

    def publish(self, path, approved=None):
        receipt = json.loads(path.read_text())
        args = types.SimpleNamespace(receipt=str(path), approve_sha256=approved or receipt['approval_sha256'],
                                     title='Contribution', body_file='unused', gitleaks=self.scanner)
        with contextlib.redirect_stdout(io.StringIO()) as output:
            module.publish(args)
        return output.getvalue().strip()

    def test_initial_publish_update_retry_and_merge_back(self):
        first = self.prepare('first')
        self.publish(first)
        (self.source/'shared.txt').write_text('feature v2\n')
        self.g(self.source, 'commit', '-am', 'native review followup')
        second = self.prepare('second', first)
        receipt = json.loads(second.read_text())
        self.assertEqual(self.publish(second), 'https://example.invalid/pr/1')
        self.assertEqual(self.publish(second), 'https://example.invalid/pr/1')
        self.assertEqual(self.pr_creates, 1)
        self.assertEqual(self.g(self.remote, 'rev-parse', 'refs/heads/contrib/test').decode().strip(), receipt['commit'])
        message = self.g(self.root/'second', 'show', '-s', '--format=%B', 'HEAD').decode()
        self.assertIn('Co-authored-by: Source Contributor <source@example.test>', message)
        self.assertFalse((self.root/'second/.git/objects/info/alternates').exists())
        # Model a squash merge onto upstream, then a normal downstream merge.
        public = self.root/'second'
        tree = self.g(public, 'rev-parse', 'HEAD^{tree}').decode().strip()
        squash = self.g(public, '-c', 'user.name=Integrator', '-c', 'user.email=integrator@example.test',
                        'commit-tree', tree, '-p', self.base, '-m', 'accepted upstream').decode().strip()
        self.g(public, 'push', str(self.remote), squash+':refs/heads/main')
        self.g(self.source, 'fetch', str(self.remote), 'main')
        self.g(self.source, 'merge', '--no-edit', 'FETCH_HEAD')
        self.assertEqual((self.source/'shared.txt').read_text(), 'feature v2\n')
        self.assertEqual(self.g(self.source, 'rev-parse', 'HEAD^{tree}').decode().strip(), tree)

    def test_source_scan_config_cannot_hide_fixture(self):
        (self.source/'.gitleaks.toml').write_text('[extend]\nuseDefault = true\n[allowlist]\nregexes = [".*"]\n')
        token = 'ghp_' + hashlib.sha256(b'never-valid-synthetic-fixture').hexdigest()[:36]
        (self.source/'shared.txt').write_text('token = '+token+' # gitleaks:allow\n')
        self.g(self.source, 'add', '.')
        self.g(self.source, 'commit', '-m', 'scanner fixture')
        with self.assertRaises(ValueError):
            self.prepare('blocked', paths=['shared.txt', '.gitleaks.toml'])
        self.assertFalse((self.root/'blocked.contribution.json').exists())

    def test_commit_message_scanned(self):
        message = 'token = ghp_' + hashlib.sha256(b'fake-message-fixture').hexdigest()[:36]
        with self.assertRaises(ValueError):
            self.prepare('blocked-message', message=message)

    def test_changed_approval_target_refused(self):
        first = self.prepare('first')
        receipt = json.loads(first.read_text())
        approved = receipt['approval_sha256']
        receipt['repo'] = 'other/repo'
        first.write_text(json.dumps(receipt))
        with self.assertRaisesRegex(ValueError, 'Approval mismatch'):
            self.publish(first, approved)
        self.assertEqual(self.g(self.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/contrib/'), b'')

    def test_remote_writer_cannot_be_overwritten(self):
        first = self.prepare('first')
        self.publish(first)
        second = self.prepare('second', first, message='reviewed second candidate')
        self.race = True
        with self.assertRaises(ValueError):
            self.publish(second)
        expected = json.loads(second.read_text())['commit']
        self.assertNotEqual(self.g(self.remote, 'rev-parse', 'refs/heads/contrib/test').decode().strip(), expected)

    def test_closed_pr_refused_before_push(self):
        first = self.prepare('first')
        self.publish(first)
        old = self.g(self.remote, 'rev-parse', 'refs/heads/contrib/test')
        second = self.prepare('second', first)
        self.pr_rows[0]['state'] = 'CLOSED'
        with self.assertRaisesRegex(ValueError, 'closed/merged'):
            self.publish(second)
        self.assertEqual(self.g(self.remote, 'rev-parse', 'refs/heads/contrib/test'), old)

    def test_update_requires_matching_previous_receipt(self):
        first = self.prepare('first')
        self.publish(first)
        with self.assertRaisesRegex(ValueError, 'previous-receipt'):
            self.prepare('unapproved-update')



if __name__ == '__main__':
    unittest.main()
