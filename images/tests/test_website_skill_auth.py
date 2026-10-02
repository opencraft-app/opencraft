"""Offline credential fallback and auth-only installation contracts (synthetic values)."""
import importlib.util
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SKILL = ROOT / '.agents/skills/website-builder/SKILL.md'
HELPER = ROOT / 'images/helpers/website_skill_auth_patch.py'
FIXTURE = ROOT / 'images/tests/fixtures/website-auth-env-only.md'


def auth_section(text):
    return text.split('## 认证与 API 地址\n', 1)[1].split('\n## ', 1)[0]


class CredentialFallbackTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.credential = self.root / 'credential.env'
        section = auth_section(SKILL.read_text())
        self.script = re.search(r'```bash\n(.*?)\n```', section, re.S).group(1)
        # Only rewrite the fixed credential pathname; never touch /etc or real keys.
        self.script = self.script.replace('/etc/vela/website-credential.env', str(self.credential))

    def run_auth(self, env=None, key='file-fixture', base='https://file.invalid', body=None,
                 trace=False):
        if body is not None:
            self.credential.write_text(body)
        elif key is not None:
            self.credential.write_text(f'VELA_WEBSITE_KEY={key!r}\nVELA_API_BASE={base!r}\n')
        expected = dict(env or {})
        expected_key = expected.get('VELA_WEBSITE_KEY') or key or ''
        expected_base = expected.get('VELA_API_BASE') or base or 'https://api.lightvela.com'
        probe = """
python3 - <<'AUTH_PROBE'
import os
assert os.environ['VELA_WEBSITE_KEY'] == os.environ['EXPECTED_KEY']
assert os.environ['VELA_API_BASE'] == os.environ['EXPECTED_BASE']
print('CHILD_OK')
AUTH_PROBE
"""
        # A child command goes INSIDE the auth example's terminal subshell.
        script = self.script.rstrip()
        if script.endswith(')'):
            script = script[:-1] + probe + ')\n'
        else:
            script += probe
        clean = {k: v for k, v in os.environ.items()
                 if k not in ('VELA_WEBSITE_KEY', 'VELA_API_BASE', 'BASH_ENV', 'ENV', 'SHELLOPTS')}
        clean.update(expected, EXPECTED_KEY=expected_key, EXPECTED_BASE=expected_base)
        return subprocess.run(['bash'] + (['-x'] if trace else []), input=script,
                              env=clean, text=True, capture_output=True)

    def assert_ok(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'CHILD_OK')

    def assert_closed(self, result):
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('CHILD_OK', result.stdout)
        self.assertNotIn('file-fixture', result.stdout + result.stderr)

    def test_environment_wins_and_file_is_not_sourced(self):
        marker = self.root / 'should-not-exist'
        result = self.run_auth({'VELA_WEBSITE_KEY': 'env-fixture', 'VELA_API_BASE': 'https://env.invalid'},
                               body=f'touch {marker}\nfalse\n')
        self.assert_ok(result)
        self.assertFalse(marker.exists())

    def test_file_fallback_is_exported_to_same_command_child(self):
        self.assert_ok(self.run_auth())

    def test_empty_environment_uses_file(self):
        self.assert_ok(self.run_auth({'VELA_WEBSITE_KEY': '', 'VELA_API_BASE': ''}))

    def test_key_environment_wins_when_base_needs_fallback(self):
        self.assert_ok(self.run_auth({'VELA_WEBSITE_KEY': 'env-fixture'}))

    def test_base_environment_wins_when_key_needs_fallback(self):
        self.assert_ok(self.run_auth({'VELA_API_BASE': 'https://env.invalid'}))

    def test_environment_key_works_without_file_and_base_has_default(self):
        self.assert_ok(self.run_auth({'VELA_WEBSITE_KEY': 'env-fixture'}, key=None, base=''))

    def test_missing_file_fails_closed(self):
        self.assert_closed(self.run_auth(key=None))

    def test_empty_key_fails_closed(self):
        self.assert_closed(self.run_auth(key=''))

    def test_unreadable_file_fails_closed(self):
        if os.geteuid() == 0:
            self.skipTest('root bypasses chmod readability; run as unprivileged user')
        self.credential.write_text('VELA_WEBSITE_KEY=file-fixture\n')
        self.credential.chmod(0)
        self.assert_closed(self.run_auth(key=None))

    def test_directory_is_not_a_credential_file(self):
        self.credential.mkdir()
        self.assert_closed(self.run_auth(key=None))

    def test_failed_source_does_not_use_partial_key(self):
        self.assert_closed(self.run_auth(body='VELA_WEBSITE_KEY=file-fixture\nfalse\n'))

    def test_trace_and_source_output_do_not_expose_values(self):
        body = 'VELA_WEBSITE_KEY=file-fixture\nVELA_API_BASE=https://file.invalid\necho file-fixture\n'
        result = self.run_auth(body=body, trace=True)
        self.assert_ok(result)
        self.assertNotIn('file-fixture', result.stdout + result.stderr)

    def test_no_output_of_existing_environment_key_under_trace(self):
        result = self.run_auth({'VELA_WEBSITE_KEY': 'env-fixture'}, trace=True)
        self.assert_ok(result)
        self.assertNotIn('env-fixture', result.stdout + result.stderr)


class AuthPatchTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('auth_patch', HELPER)
        self.helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.helper)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.skill = self.root / 'SKILL.md'
        self.legacy = FIXTURE.read_text()
        self.skill.write_text(self.legacy)
        self.skill.chmod(0o640)

    def test_known_versions_keep_every_other_byte_and_metadata(self):
        for prefix in ('vik_', 'vwk_'):
            with self.subTest(prefix=prefix):
                source = self.legacy.replace('vik_', prefix)
                self.skill.write_text(source)
                before = self.skill.stat()
                result = self.helper.patch(self.skill)
                self.assertEqual(result['status'], 'patched')
                after = self.skill.read_text()
                self.assertEqual(after, source.replace(
                    self.helper.LEGACY_AUTH.replace('vik_', prefix),
                    self.helper.AUTH_SECTION.replace('vik_', prefix), 1))
                backup = Path(result['backup'])
                self.assertEqual(backup.read_text(), source)
                self.assertEqual(stat.S_IMODE(backup.stat().st_mode), 0o600)
                self.assertEqual(stat.S_IMODE(self.skill.stat().st_mode), 0o640)
                self.assertEqual((self.skill.stat().st_uid, self.skill.stat().st_gid),
                                 (before.st_uid, before.st_gid))

    def test_canonical_has_production_marker_exactly_once(self):
        section = auth_section(SKILL.read_text())
        self.assertEqual(section.count(self.helper.AUTH_MARKER), 1)
        self.assertIn(self.helper.AUTH_SECTION, SKILL.read_text())

    def test_exact_pinned_auth_is_already_current_without_rewrite(self):
        pinned = (ROOT / 'images/tests/fixtures/website-auth-fallback-v1.md').read_text().rstrip('\n') + '\n\n'
        source = self.legacy.replace(self.helper.LEGACY_AUTH, pinned)
        self.skill.write_text(source)
        before = self.skill.stat()
        self.assertEqual(self.helper.patch(self.skill)['status'], 'already-pinned-v1')
        self.assertEqual(self.skill.read_text(), source)
        self.assertEqual(self.skill.stat().st_ino, before.st_ino)
        self.assertFalse(list(self.root.glob('*.auth-backup-*')))

    def test_marker_does_not_authorize_unknown_custom_auth(self):
        pinned = (ROOT / 'images/tests/fixtures/website-auth-fallback-v1.md').read_text().rstrip('\n') + '\n\n'
        custom = pinned.replace('读取示例', '定制认证流程')
        self.skill.write_text(self.legacy.replace(self.helper.LEGACY_AUTH, custom))
        source = self.skill.read_text()
        self.assertEqual(self.helper.patch(self.skill)['status'], 'skipped-unknown-auth')
        self.assertEqual(self.skill.read_text(), source)

    def test_previous_canonical_without_marker_can_upgrade(self):
        old_canonical = self.helper.AUTH_SECTION.replace(
            "\n" + self.helper.AUTH_MARKER + "\n", '', 1)
        self.skill.write_text(self.legacy.replace(self.helper.LEGACY_AUTH, old_canonical))
        self.assertEqual(self.helper.patch(self.skill)['status'], 'patched')
        self.assertIn(self.helper.AUTH_MARKER, self.skill.read_text())

    def test_canonical_marker_with_modified_script_is_skipped(self):
        custom = self.helper.AUTH_SECTION.replace('  set +x\n', '  set -x\n', 1)
        self.skill.write_text(self.legacy.replace(self.helper.LEGACY_AUTH, custom))
        self.assertEqual(self.helper.patch(self.skill)['status'], 'skipped-unknown-auth')
        self.assertIn('  set -x\n', self.skill.read_text())

    def test_auth_constant_matches_repository_skill(self):
        self.assertIn(self.helper.AUTH_BODY, auth_section(SKILL.read_text()))

    def test_idempotent_no_backup_or_rewrite_on_second_run(self):
        self.helper.patch(self.skill)
        inode = self.skill.stat().st_ino
        files = sorted(self.root.iterdir())
        self.assertEqual(self.helper.patch(self.skill)['status'], 'already-current')
        self.assertEqual(self.skill.stat().st_ino, inode)
        self.assertEqual(sorted(self.root.iterdir()), files)

    def test_unknown_custom_auth_is_skipped(self):
        source = self.legacy.replace('读取示例', '定制认证流程')
        self.skill.write_text(source)
        self.assertEqual(self.helper.patch(self.skill)['status'], 'skipped-unknown-auth')
        self.assertEqual(self.skill.read_text(), source)
        self.assertFalse(list(self.root.glob('*.auth-backup-*')))

    def test_custom_auth_intro_is_skipped(self):
        source = self.legacy.replace('永久凭据', '定制凭据')
        self.skill.write_text(source)
        self.assertEqual(self.helper.patch(self.skill)['status'], 'skipped-unknown-auth')
        self.assertEqual(self.skill.read_text(), source)

    def test_duplicate_auth_heading_is_skipped(self):
        self.skill.write_text(self.legacy + '\n' + self.legacy)
        self.assertEqual(self.helper.patch(self.skill)['status'], 'skipped-unknown-auth')

    def test_missing_skill_does_not_install_or_create_directories(self):
        path = self.root / 'missing/website-builder/SKILL.md'
        self.assertEqual(self.helper.patch(path)['status'], 'skipped-missing')
        self.assertFalse(path.parent.exists())

    def test_managed_bundle_is_skipped_without_reading_skill_or_manifest(self):
        manifest = self.root / 'bundle.json'
        manifest.write_text('managed metadata must not be read')
        with mock.patch.object(self.helper, 'regular_bytes', side_effect=AssertionError('unexpected read')):
            self.assertEqual(self.helper.patch(self.skill)['status'], 'skipped-managed-bundle')
        self.assertEqual(self.skill.read_text(), self.legacy)
        self.assertFalse(list(self.root.glob('*.auth-backup-*')))

    def test_prior_manual_auth_versions_are_supported(self):
        original = self.helper.LEGACY_AUTH
        for manual in (self.helper.PRIOR_MANUAL_AUTH,
                       self.helper.PRIOR_MANUAL_AUTH.replace('(\n  if ', '(\n  set +x\n  if ', 1)):
            with self.subTest(tracing_disabled='set +x' in manual):
                source = self.legacy.replace(original, manual)
                self.skill.write_text(source)
                self.assertEqual(self.helper.patch(self.skill)['status'], 'patched')
                self.assertEqual(self.skill.read_text(), source.replace(manual, self.helper.AUTH_SECTION, 1))

    def test_patch_reads_only_skill_and_optional_backup(self):
        original_reader = self.helper.regular_bytes
        with mock.patch.object(self.helper, 'regular_bytes', wraps=original_reader) as reader:
            self.helper.patch(self.skill)
        self.assertTrue(reader.call_args_list)
        self.assertTrue(all(call.args[0] == self.skill for call in reader.call_args_list))

    def test_symlink_file_and_ancestor_are_rejected(self):
        link = self.root / 'link'
        link.symlink_to(self.skill)
        with self.assertRaises(ValueError):
            self.helper.patch(link)
        directory = self.root / 'dir-link'
        directory.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.helper.patch(directory / 'SKILL.md')
        self.assertEqual(self.skill.read_text(), self.legacy)

    def test_replace_failure_retains_original_and_backup(self):
        with mock.patch.object(self.helper.os, 'replace', side_effect=OSError('fixture failure')):
            with self.assertRaises(OSError):
                self.helper.patch(self.skill)
        self.assertEqual(self.skill.read_text(), self.legacy)
        backups = list(self.root.glob('*.auth-backup-*'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), self.legacy)
        self.assertFalse(list(self.root.glob('.website-auth-stage-*')))

    def test_preexisting_backup_cannot_be_overwritten(self):
        import hashlib
        backup = self.skill.with_name('SKILL.md.auth-backup-' + hashlib.sha256(self.legacy.encode()).hexdigest())
        backup.write_text('custom backup')
        with self.assertRaises(ValueError):
            self.helper.patch(self.skill)
        self.assertEqual(backup.read_text(), 'custom backup')
        self.assertEqual(self.skill.read_text(), self.legacy)

    def test_generated_command_is_self_contained_and_does_not_read_credentials(self):
        home = self.root / 'home'
        target = home / '.hermes/skills/website-builder/SKILL.md'
        target.parent.mkdir(parents=True)
        target.write_text(self.legacy)
        script = self.helper.command()
        # Installer has no credential file open/source or service restart operation.
        self.assertNotIn('systemctl', script)
        env = dict(os.environ, HOME=str(home))
        result = subprocess.run(['bash'], input=script, text=True, env=env, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('"status": "patched"', result.stdout)
        self.assertIn(self.helper.AUTH_BODY, target.read_text())
        self.assertFalse((home / '.hermes/.env').exists())


if __name__ == '__main__':
    unittest.main()
