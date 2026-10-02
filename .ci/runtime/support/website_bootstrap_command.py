#!/usr/bin/env python3
"""Build a credential-compatible bootstrap; no cloud calls or credential values."""
import argparse
import os
from pathlib import Path
import re

DELIMITER = 'VELA_WEBSITE_SKILL_BOOTSTRAP'


def build_payload(credential_content: str, skill_content: str) -> str:
    """Preserve the credential installer and append an unprivileged best-effort patch."""
    if not isinstance(credential_content, str) or not isinstance(skill_content, str):
        raise TypeError('expected shell script strings')
    if not credential_content.strip() or not skill_content.strip() or '\x00' in credential_content + skill_content:
        raise ValueError('empty or invalid shell scripts')
    if DELIMITER in (credential_content + skill_content).splitlines():
        raise ValueError('heredoc collision')
    if re.search(r'vik_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}', credential_content + skill_content):
        raise ValueError('embedded credential forbidden')
    suffix = '''
# Skill-only work runs after successful credential installation, never as root.
# This command is for the existing NEW-instance credential hook, not fleet repair.
set +x
if command -v runuser >/dev/null 2>&1 && id -u agentuser >/dev/null 2>&1; then
  if runuser -u agentuser -- env -u WEBSITE_KEY -u API_BASE bash -s <<'VELA_WEBSITE_SKILL_BOOTSTRAP'
'''
    suffix += skill_content.rstrip('\n') + '\n' + DELIMITER + '\n'
    suffix += '''  then
    printf '%s\\n' '[website-bootstrap] skill auth patch finished'
  else
    printf '%s\\n' '[website-bootstrap] skill auth patch skipped; credential installation succeeded' >&2
  fi
else
  printf '%s\\n' '[website-bootstrap] skill auth patch skipped; runtime user/tool unavailable' >&2
fi
'''
    payload = credential_content + suffix
    if len(payload.encode()) > 64000:
        raise ValueError('command exceeds TAT size budget')
    return payload


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--credential-content-file', type=Path, required=True,
                        help='placeholder-only Content captured from the immutable previous TAT command')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    import importlib.util
    helper = Path(__file__).resolve().parents[3] / 'images/helpers/website_skill_auth_patch.py'
    spec = importlib.util.spec_from_file_location('website_skill_auth_patch', helper)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    content = args.credential_content_file.read_text()
    if content.count('export WEBSITE_KEY="{{tat-hidden:website_key}}"') != 1 or content.count('export API_BASE="{{api_base}}"') != 1:
        raise ValueError('credential command parameter contract mismatch')
    payload = build_payload(content, module.command())
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        output.write(payload)
    print('website bootstrap payload prepared; no cloud mutation')


if __name__ == '__main__':
    main()
