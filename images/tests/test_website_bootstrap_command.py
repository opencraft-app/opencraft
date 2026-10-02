"""Offline payload contract tests: synthetic credentials, no cloud or services.

Run with:
    python3 -B images/tests/test_website_bootstrap_command.py

The runuser/id/getent doubles simulate the privilege boundary; they do not
change the local UID or require a real agentuser. Missing builders fail loudly
rather than skipping the regression suite.
"""

import importlib.util
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
BUILDER = ROOT / '.ci/runtime/commands/website_bootstrap_command.py'
DELIMITER = 'VELA_WEBSITE_SKILL_BOOTSTRAP'
BASH = shutil.which('bash')
ENV = shutil.which('env')

# Deliberately retain the legacy hidden parameters and installer-like main
# invocation. Never substitute a real key, run the real installer, or source it.
CREDENTIAL = '''#!/usr/bin/env bash
export WEBSITE_KEY="{{tat-hidden:website_key}}"
export API_BASE="{{api_base}}"
set -euo pipefail
install_credential() {
  printf 'credential\\n' >> "$MOCK_EVENTS"
  printf '%s\\n' "$WEBSITE_KEY" "$API_BASE" > "$MOCK_CREDENTIAL_VALUES"
  return "${MOCK_CREDENTIAL_STATUS:-0}"
}
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  install_credential "$@"
fi
'''

SKILL = '''#!/usr/bin/env bash
set -euo pipefail
[[ "${MOCK_EFFECTIVE_USER:-}" == agentuser ]]
[[ "${WEBSITE_KEY+x}" != x ]]
[[ "${API_BASE+x}" != x ]]
printf 'skill\\n' >> "$MOCK_EVENTS"
printf '%s\\n' 'skill-installed' > "$MOCK_SKILL_MARKER"
'''


class WebsiteBootstrapCommandTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not BUILDER.is_file():
            raise FileNotFoundError(
                f'Waiting for payload builder: {BUILDER}; tests must not implement it'
            )
        spec = importlib.util.spec_from_file_location('website_bootstrap_command', BUILDER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        cls.build_payload = staticmethod(module.build_payload)
        if not BASH or not ENV:
            raise RuntimeError('Offline shell tests require local bash and env')

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='website-bootstrap-test-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        (self.bin / 'python3').symlink_to(sys.executable)
        self.events = self.root / 'events'
        self.values = self.root / 'credential-values'
        self.skill_marker = self.root / 'skill-marker'
        self.runuser_args = self.root / 'runuser-args'
        self.skill_stdin = self.root / 'skill-stdin'
        # PATH is closed: no real runuser, account lookup, installer, cloud CLI,
        # service manager, or inherited shell startup files can be selected.
        (self.bin / 'bash').symlink_to(BASH)
        (self.bin / 'env').symlink_to(ENV)
        self.write_command('id', '''
if [[ "$*" == *agentuser* && "${MOCK_USER_EXISTS}" != 1 ]]; then
  exit 1
fi
case "${1:-}" in
  -un) printf '%s\\n' "${MOCK_EFFECTIVE_USER:-root}" ;;
  -u) printf '1001\\n' ;;
  *) printf 'uid=1001(agentuser) gid=1001(agentuser)\\n' ;;
esac
''')
        self.write_command('getent', '''
[[ "$*" == 'passwd agentuser' && "${MOCK_USER_EXISTS}" == 1 ]] || exit 2
printf 'agentuser:x:1001:1001:Mock:%s:/bin/bash\\n' "$HOME"
''')
        self.write_command('runuser', '''
printf '%s\\n' "$@" > "$MOCK_RUNUSER_ARGS"
[[ "${1:-}" == -u && "${2:-}" == agentuser && "${3:-}" == -- ]] || exit 91
shift 3
[[ "${MOCK_USER_EXISTS}" == 1 ]] || exit 92
[[ "${MOCK_RUNUSER_STATUS:-0}" == 0 ]] || exit "$MOCK_RUNUSER_STATUS"
export MOCK_EFFECTIVE_USER=agentuser
# Record exactly the script passed via stdin, preserving blank lines.
while IFS= read -r line || [[ -n "$line" ]]; do
  printf '%s\\n' "$line" >> "$MOCK_SKILL_STDIN"
done
exec "$@" < "$MOCK_SKILL_STDIN"
''')
        self.env = {
            'PATH': str(self.bin),
            'HOME': str(self.root),
            'LC_ALL': 'C',
            'MOCK_USER_EXISTS': '1',
            'MOCK_EVENTS': str(self.events),
            'MOCK_CREDENTIAL_VALUES': str(self.values),
            'MOCK_SKILL_MARKER': str(self.skill_marker),
            'MOCK_RUNUSER_ARGS': str(self.runuser_args),
            'MOCK_SKILL_STDIN': str(self.skill_stdin),
            'MOCK_EFFECTIVE_USER': 'root',
        }

    def write_command(self, name, body):
        path = self.bin / name
        path.write_text(f'#!{BASH}\nset -euo pipefail\n' + body)
        path.chmod(0o700)

    def execute(self, credential=CREDENTIAL, skill=SKILL, **env):
        payload = self.build_payload(credential, skill)
        self.assertIsInstance(payload, str)
        script = self.root / 'payload.sh'
        script.write_text(payload)
        return subprocess.run(
            [BASH, str(script)], env={**self.env, **env}, text=True,
            capture_output=True, timeout=10,
        )

    def run_cli(self, credential=CREDENTIAL):
        source = self.root / 'immutable-credential-content.sh'
        source.write_text(credential)
        output = self.root / 'bootstrap-output.sh'
        result = subprocess.run(
            [sys.executable, '-B', str(BUILDER), '--credential-content-file',
             str(source), '--output', str(output)],
            env=self.env, text=True, capture_output=True, timeout=10,
        )
        return result, source, output

    def canonical_skill_command(self):
        path = ROOT / 'images/helpers/website_skill_auth_patch.py'
        spec = importlib.util.spec_from_file_location('offline_website_skill_auth_patch', path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.command()

    def assert_success(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def assert_no_skill(self):
        self.assertEqual(self.events.read_text(), 'credential\n')
        self.assertFalse(self.runuser_args.exists())
        self.assertFalse(self.skill_marker.exists())
        self.assertFalse(self.skill_stdin.exists())

    def test_preserves_complete_legacy_credential_prefix(self):
        payload = self.build_payload(CREDENTIAL, SKILL)
        self.assertIsInstance(payload, str)
        self.assertTrue(payload.startswith(CREDENTIAL))
        self.assertEqual(payload[:len(CREDENTIAL)], CREDENTIAL)
        self.assertEqual(payload.count('{{tat-hidden:website_key}}'), 1)
        self.assertEqual(payload.count('{{api_base}}'), 1)

    def test_preserves_credential_without_trailing_newline(self):
        credential = CREDENTIAL.rstrip('\n')
        self.assertTrue(self.build_payload(credential, SKILL).startswith(credential))
        self.assert_success(self.execute(credential=credential))
        self.assertTrue(self.skill_marker.exists())

    def test_preserves_existing_credential_heredoc_and_blank_lines(self):
        credential = CREDENTIAL + '''
read -r -d '' unused <<'LEGACY_CONTENT' || true
{{tat-hidden:website_key}}

installer metadata; $not_expanded
LEGACY_CONTENT
'''
        payload = self.build_payload(credential, SKILL)
        self.assertEqual(payload[:len(credential)], credential)
        self.assert_success(self.execute(credential=credential))

    def test_generated_payload_is_valid_bash(self):
        for credential in (CREDENTIAL, CREDENTIAL.rstrip('\n')):
            with self.subTest(trailing_newline=credential.endswith('\n')):
                result = subprocess.run(
                    [BASH, '-n'], input=self.build_payload(credential, SKILL),
                    env=self.env, text=True, capture_output=True, timeout=10,
                )
                self.assert_success(result)

    def test_fixed_quoted_heredoc(self):
        suffix = self.build_payload(CREDENTIAL, SKILL)[len(CREDENTIAL):]
        self.assertRegex(suffix, r"<<\s*'" + DELIMITER + r"'")
        self.assertEqual(len(re.findall(r'^' + DELIMITER + r'$', suffix, re.M)), 1)

    def test_success_runs_credential_then_skill_exactly_once(self):
        self.assert_success(self.execute())
        self.assertEqual(self.events.read_text(), 'credential\nskill\n')
        self.assertEqual(self.skill_marker.read_text(), 'skill-installed\n')
        self.assertEqual(self.values.read_text(), '{{tat-hidden:website_key}}\n{{api_base}}\n')

    def test_runuser_targets_agentuser_and_clears_environment(self):
        self.assert_success(self.execute())
        self.assertEqual(self.runuser_args.read_text().splitlines(), [
            '-u', 'agentuser', '--', 'env', '-u', 'WEBSITE_KEY',
            '-u', 'API_BASE', 'bash', '-s',
        ])
        # SKILL asserts both variables are absent (not merely empty) and that
        # it executes under the simulated agentuser, not the parent identity.
        self.assertTrue(self.skill_marker.exists())

    def test_skill_source_is_passed_verbatim_without_parent_expansion(self):
        skill = SKILL + '''
printf '%s\\n' '{{tat-hidden:website_key}}' "$MOCK_EFFECTIVE_USER" > "$HOME/literals"
'''
        self.assert_success(self.execute(skill=skill))
        self.assertEqual(self.skill_stdin.read_text(), skill)
        self.assertEqual((self.root / 'literals').read_text(),
                         '{{tat-hidden:website_key}}\nagentuser\n')

    def test_skill_without_final_newline_executes(self):
        self.assert_success(self.execute(skill=SKILL.rstrip('\n')))
        self.assertTrue(self.skill_marker.exists())

    def test_inherited_credential_environment_is_removed(self):
        # These are synthetic markers, never actual key material.
        credential = CREDENTIAL.replace('{{tat-hidden:website_key}}', 'mock-key-only')
        credential = credential.replace('{{api_base}}', 'https://mock.invalid')
        result = self.execute(credential=credential,
                              WEBSITE_KEY='inherited-mock', API_BASE='https://inherited.invalid')
        self.assert_success(result)
        self.assertEqual(self.values.read_text(), 'mock-key-only\nhttps://mock.invalid\n')
        self.assertTrue(self.skill_marker.exists())
        for marker in ('mock-key-only', 'inherited-mock', 'https://mock.invalid',
                       'https://inherited.invalid'):
            self.assertNotIn(marker, result.stdout + result.stderr)

    def test_credential_nonzero_exit_is_preserved_and_blocks_skill(self):
        for status in ('1', '23', '73'):
            with self.subTest(status=status):
                result = self.execute(MOCK_CREDENTIAL_STATUS=status)
                self.assertEqual(result.returncode, int(status), result.stdout + result.stderr)
                self.assertFalse(self.runuser_args.exists())
                self.assertFalse(self.skill_marker.exists())
        self.assertEqual(self.events.read_text(), 'credential\n' * 3)

    def test_explicit_credential_exit_blocks_skill(self):
        credential = CREDENTIAL + 'exit 39\n'
        result = self.execute(credential=credential)
        self.assertEqual(result.returncode, 39, result.stdout + result.stderr)
        self.assert_no_skill()

    def test_credential_failure_under_errexit_blocks_skill(self):
        result = self.execute(credential=CREDENTIAL + 'false\n')
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assert_no_skill()

    def test_skill_nonzero_exit_is_best_effort(self):
        result = self.execute(skill="#!/bin/bash\nprintf 'skill\\n' >> \"$MOCK_EVENTS\"\nexit 47\n")
        self.assert_success(result)
        self.assertEqual(self.events.read_text(), 'credential\nskill\n')
        self.assertFalse(self.skill_marker.exists())

    def test_skill_errexit_is_best_effort(self):
        result = self.execute(skill='#!/bin/bash\nset -euo pipefail\nfalse\n' + SKILL)
        self.assert_success(result)
        self.assertEqual(self.events.read_text(), 'credential\n')
        self.assertTrue(self.runuser_args.exists())
        self.assertFalse(self.skill_marker.exists())

    def test_runuser_failure_is_best_effort(self):
        self.assert_success(self.execute(MOCK_RUNUSER_STATUS='74'))
        self.assertEqual(self.events.read_text(), 'credential\n')
        self.assertTrue(self.runuser_args.exists())
        self.assertFalse(self.skill_marker.exists())

    def test_missing_runuser_skips_skill_without_root_fallback(self):
        (self.bin / 'runuser').unlink()
        self.assert_success(self.execute())
        self.assert_no_skill()

    def test_missing_agentuser_skips_skill_without_invoking_runuser(self):
        self.assert_success(self.execute(MOCK_USER_EXISTS='0'))
        self.assert_no_skill()

    def test_missing_prerequisites_do_not_mask_credential_failure(self):
        (self.bin / 'runuser').unlink()
        result = self.execute(MOCK_USER_EXISTS='0', MOCK_CREDENTIAL_STATUS='29')
        self.assertEqual(result.returncode, 29, result.stdout + result.stderr)
        self.assert_no_skill()

    def test_builder_adds_no_source_eval_or_tracing(self):
        suffix = self.build_payload(CREDENTIAL, SKILL)[len(CREDENTIAL):]
        # Inspect executable wrapper, not the user-supplied Skill body.
        wrapper = suffix.replace(SKILL, '', 1)
        self.assertNotRegex(wrapper, r'(?m)^\s*(?:source|eval|\.)\s')
        self.assertNotRegex(wrapper, r'\bset\s+-[A-Za-z]*x')
        self.assertNotRegex(wrapper, r'\bset\s+-o\s+xtrace\b')
        self.assertNotRegex(wrapper, r'\bbash\s+[^\n]*-[A-Za-z]*x\b')

    def test_skill_cannot_log_parent_credential_values(self):
        credential = CREDENTIAL.replace('{{tat-hidden:website_key}}', 'mock-private-marker')
        credential = credential.replace('{{api_base}}', 'https://mock-api.invalid')
        skill = SKILL + 'printf "child-key=%s child-base=%s\\n" "${WEBSITE_KEY-}" "${API_BASE-}"\n'
        result = self.execute(credential=credential, skill=skill)
        self.assert_success(result)
        self.assertIn('child-key= child-base=', result.stdout)
        self.assertNotIn('mock-private-marker', result.stdout + result.stderr)
        self.assertNotIn('https://mock-api.invalid', result.stdout + result.stderr)

    def test_build_payload_accepts_plain_mock_scripts_without_cli_placeholders(self):
        credential = "set -e\nprintf 'credential\\n' >> \"$MOCK_EVENTS\"\n"
        skill = "printf 'skill\\n' >> \"$MOCK_EVENTS\"\n"
        payload = self.build_payload(credential, skill)
        self.assertTrue(payload.startswith(credential))
        self.assert_success(self.execute(credential=credential, skill=skill))
        self.assertEqual(self.events.read_text(), 'credential\nskill\n')

    def test_cli_preserves_supplied_immutable_content_and_uses_canonical_helper(self):
        # Stand in for a captured historical Content, not today's installer.
        credential = CREDENTIAL + '# mock immutable historical revision: do not replace\n'
        result, source, output = self.run_cli(credential)
        self.assert_success(result)
        payload = output.read_text()
        self.assertTrue(payload.startswith(credential))
        self.assertTrue(self.canonical_skill_command() in payload)
        self.assertEqual(source.read_text(), credential)
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)
        self.assertFalse(self.events.exists())  # CLI prepares; it never installs.
        self.assertNotIn(DELIMITER, result.stdout + result.stderr)
        self.assertNotIn('{{tat-hidden:website_key}}', result.stdout + result.stderr)

    def test_cli_refuses_missing_duplicate_or_wrong_placeholder_exports(self):
        invalid_contents = (
            CREDENTIAL.replace('export WEBSITE_KEY="{{tat-hidden:website_key}}"\n', ''),
            CREDENTIAL.replace('export API_BASE="{{api_base}}"\n', ''),
            CREDENTIAL + 'export WEBSITE_KEY="{{tat-hidden:website_key}}"\n',
            CREDENTIAL + 'export API_BASE="{{api_base}}"\n',
            CREDENTIAL.replace('{{tat-hidden:website_key}}', 'mock-key-only'),
            CREDENTIAL.replace('{{api_base}}', 'https://mock.invalid'),
        )
        for credential in invalid_contents:
            with self.subTest(case=invalid_contents.index(credential)):
                result, _, output = self.run_cli(credential)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(output.exists())
                self.assertFalse(self.events.exists())

    def test_cli_refuses_to_overwrite_existing_output(self):
        output = self.root / 'bootstrap-output.sh'
        output.write_text('existing output must survive\n')
        result, _, _ = self.run_cli()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(output.read_text(), 'existing output must survive\n')
        self.assertFalse(self.events.exists())

    def test_canonical_skill_recognizes_pinned_v1_without_rewriting(self):
        pinned = ROOT / 'images/tests/fixtures/website-auth-fallback-v1.md'
        target = self.root / '.hermes/skills/website-builder/SKILL.md'
        target.parent.mkdir(parents=True)
        original = '# Offline mock Skill\n\n' + pinned.read_text().rstrip('\n') + '\n\n## Offline footer\nKeep me.\n'
        target.write_text(original)
        before = target.stat()
        result = self.execute(skill=self.canonical_skill_command())
        self.assert_success(result)
        self.assertIn('already-pinned-v1', result.stdout)
        self.assertEqual(target.read_text(), original)
        self.assertEqual(target.stat().st_ino, before.st_ino)
        self.assertEqual(target.stat().st_mtime_ns, before.st_mtime_ns)
        self.assertFalse(list(target.parent.glob('*.auth-backup-*')))
        self.assertEqual(self.events.read_text(), 'credential\n')
        self.assertTrue(self.runuser_args.exists())

    def test_rejects_non_string_arguments(self):
        for invalid in (None, 0, False, b'echo mock', [], {}):
            for position in ('credential', 'skill'):
                with self.subTest(position=position, value=repr(invalid)):
                    args = (invalid, SKILL) if position == 'credential' else (CREDENTIAL, invalid)
                    with self.assertRaises((TypeError, ValueError)):
                        self.build_payload(*args)

    def test_rejects_empty_or_whitespace_only_arguments(self):
        for invalid in ('', ' ', '\n\t\n'):
            for args in ((invalid, SKILL), (CREDENTIAL, invalid)):
                with self.subTest(args=args):
                    with self.assertRaises((TypeError, ValueError)):
                        self.build_payload(*args)

    def test_rejects_nul_bytes(self):
        for args in ((CREDENTIAL + '\x00', SKILL), (CREDENTIAL, SKILL + '\x00')):
            with self.subTest(position='credential' if '\x00' in args[0] else 'skill'):
                with self.assertRaises((TypeError, ValueError)):
                    self.build_payload(*args)

    def test_rejects_skill_heredoc_delimiter_collision(self):
        # Valid shell-script inputs make this exercise collision detection,
        # not an unrelated shebang/empty-input validation failure.
        collisions = (
            '#!/bin/bash\n' + DELIMITER,
            '#!/bin/bash\n' + DELIMITER + '\n',
            '#!/bin/bash\necho before\n' + DELIMITER + '\nexit 91\n',
        )
        for skill in collisions:
            with self.subTest(skill=skill):
                with self.assertRaises((TypeError, ValueError)):
                    self.build_payload(CREDENTIAL, skill)


if __name__ == '__main__':
    unittest.main(verbosity=2)
