#!/usr/bin/env bash
set -euo pipefail

# Test: TAT credential delivery scripts for Hermes website instance keys.
# Validates create command, invoke command, and install script behavior.
# Uses env-var-based stubs — no real cloud calls, no sed/printf escaping.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEST_TMP="$(mktemp -d)"
trap 'rm -rf "${TEST_TMP}"' EXIT

PASS=0
FAIL=0

assert() {
  local desc="$1"
  local condition="$2"
  if eval "$condition"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s\n' "$desc" >&2
  fi
}

get_file_mode() {
  stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1" 2>/dev/null || true
}

# ========================================================================
# Part 1: Syntax check
# ========================================================================

test_syntax() {
  bash -n "${ROOT_DIR}/images/helpers/install-hermes-website-credential.sh"
  bash -n "${ROOT_DIR}/.ci/runtime/commands/create_hermes_website_credential_command.sh"
  bash -n "${ROOT_DIR}/.ci/runtime/commands/invoke_hermes_website_credential_command.sh"
}

# ========================================================================
# Part 2: create_hermes_website_credential_command.sh
# ========================================================================

test_create_command() {
  local tccli_log="${TEST_TMP}/tccli-create.log"
  mkdir -p "${TEST_TMP}/bin"

  # Stub reads TCCLI_LOG env var at runtime (no heredoc expansion needed)
  cat >"${TEST_TMP}/bin/tccli" <<'STUB'
#!/usr/bin/env bash
printf '%s\0' "$@" >>"$TCCLI_LOG"
printf '{"CommandId":"cmd-test-cred-001"}'
STUB
  chmod +x "${TEST_TMP}/bin/tccli"
  export PATH="${TEST_TMP}/bin:${PATH}"

  local output
  output="$(TCCLI_LOG="${tccli_log}" \
    HERMES_TAT_REGION=ap-shanghai \
    bash "${ROOT_DIR}/.ci/runtime/commands/create_hermes_website_credential_command.sh" 2>/dev/null)" || true

  local args
  args="$(tr '\0' '\n' <"${tccli_log}")"

  assert "create: returns CommandId" \
    '[[ "$output" == *"cmd-test-cred-001"* ]]'

  assert "create: EnableParameter passed" \
    'echo "$args" | grep -q "EnableParameter"'
  assert "create: EnableParameter true" \
    'echo "$args" | grep -A1 "EnableParameter" | grep -qi "true"'

  assert "create: SHELL type" \
    'echo "$args" | grep -q "SHELL"'

  # Extract Content value and decode
  local content_b64
  content_b64="$(echo "$args" | sed -n '/--Content/{n;p;}' || true)"
  [[ -z "$content_b64" ]] && content_b64="$(echo "$args" | grep -A1 '^Content$' | tail -1 || true)"

  if [[ -n "$content_b64" ]]; then
    local content_decoded
    content_decoded="$(echo "$content_b64" | base64 -d 2>/dev/null || true)"
    assert "create: content has hidden website_key placeholder" \
      'echo "$content_decoded" | grep -q "{{tat-hidden:website_key}}"'
    assert "create: content has api_base placeholder" \
      'echo "$content_decoded" | grep -q "{{api_base}}"'
    assert "create: content sources install script" \
      'echo "$content_decoded" | grep -q "install-hermes-website-credential"'
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: create: could not extract Content from tccli args\n' >&2
  fi

  assert "create: no vwk_ token in tccli log" \
    '! grep -q "vwk_" "${tccli_log}"'
  assert "create: no vwk_ token in stdout" \
    '! echo "$output" | grep -q "vwk_"'
  assert "create: no DefaultParameters" \
    '! echo "$args" | grep -qi "DefaultParameters"'
}

# ========================================================================
# Part 3: invoke_hermes_website_credential_command.sh
# ========================================================================

test_invoke_command() {
  local tccli_log="${TEST_TMP}/tccli-invoke.log"
  mkdir -p "${TEST_TMP}/bin"

  cat >"${TEST_TMP}/bin/tccli" <<'STUB'
#!/usr/bin/env bash
printf '%s\0' "$@" >>"$TCCLI_LOG"
printf '{"InvocationId":"inv-test-001"}'
STUB
  chmod +x "${TEST_TMP}/bin/tccli"
  export PATH="${TEST_TMP}/bin:${PATH}"

  local input_file="${TEST_TMP}/instances.jsonl"
  cat >"$input_file" <<'JSONL'
{"cloud_id":"ins-aaa111","website_key":"vwk_AAAAAAAAAAAAAAAAAAAA_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
{"cloud_id":"ins-bbb222","website_key":"vwk_CCCCCCCCCCCCCCCCCCCCCC_DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"}
JSONL

  local output
  output="$(TCCLI_LOG="${tccli_log}" \
    HERMES_TAT_COMMAND_ID=cmd-test-cred-001 \
    HERMES_TAT_REGION=ap-shanghai \
    HERMES_TAT_API_BASE="https://api.example.com" \
    HERMES_TAT_INPUT_FILE="$input_file" \
    HERMES_TAT_OUTPUT_DIR="${TEST_TMP}" \
    bash "${ROOT_DIR}/.ci/runtime/commands/invoke_hermes_website_credential_command.sh" 2>/dev/null)" || true

  local invoke_count
  invoke_count="$(tr '\0' '\n' <"${tccli_log}" 2>/dev/null | grep -c 'InvokeCommand' || echo 0)"
  assert "invoke: called InvokeCommand twice (one per instance)" \
    '[[ "$invoke_count" -eq 2 ]]'

  local args
  args="$(tr '\0' '\n' <"${tccli_log}")"

  assert "invoke: ins-aaa111 in invocation" \
    'echo "$args" | grep -q "ins-aaa111"'
  assert "invoke: ins-bbb222 in invocation" \
    'echo "$args" | grep -q "ins-bbb222"'

  assert "invoke: Parameters contains website_key" \
    'echo "$args" | grep -q "website_key"'
  assert "invoke: Parameters contains api_base" \
    'echo "$args" | grep -q "api_base"'

  assert "invoke: no key in stdout" \
    '! echo "$output" | grep -q "vwk_AAAA"'
  assert "invoke: no key in stdout (2)" \
    '! echo "$output" | grep -q "vwk_CCCC"'

  assert "invoke: result JSONL exists" \
    'ls "${TEST_TMP}"/website-credential-invoke-*.jsonl 2>/dev/null | head -1 | grep -q .'
}

# ========================================================================
# Part 4: install-hermes-website-credential.sh
# ========================================================================

test_install_script() {
  local script="${ROOT_DIR}/images/helpers/install-hermes-website-credential.sh"
  local fake_root="${TEST_TMP}/fakeroot"
  mkdir -p "${fake_root}/etc/vela"

  mkdir -p "${TEST_TMP}/bin"

  # Stub runuser: strip flags and pass through
  cat >"${TEST_TMP}/bin/runuser" <<'STUB'
#!/usr/bin/env bash
shift; shift; shift
"$@"
STUB
  chmod +x "${TEST_TMP}/bin/runuser"

  # Stub systemctl: capture calls via SYSTEMCTL_LOG env var
  local systemctl_log="${TEST_TMP}/systemctl.log"
  cat >"${TEST_TMP}/bin/systemctl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$SYSTEMCTL_LOG"
exit 0
STUB
  chmod +x "${TEST_TMP}/bin/systemctl"

  # Stub getent: return fake home dir for agentuser
  cat >"${TEST_TMP}/bin/getent" <<'STUB'
#!/usr/bin/env bash
if [[ "$1" == "passwd" && "$2" == "agentuser" ]]; then
  printf 'agentuser:x:1000:1000::%s/agentuser:/bin/bash\n' "$FAKE_HOME_ROOT"
else
  /usr/bin/getent "$@" 2>/dev/null || true
fi
STUB
  chmod +x "${TEST_TMP}/bin/getent"

  export PATH="${TEST_TMP}/bin:${PATH}"

  # Create a fake systemd user directory with one gateway unit
  local user_systemd="${fake_root}/home/agentuser/.config/systemd/user"
  mkdir -p "$user_systemd"
  cat >"${user_systemd}/hermes-gateway-test.service" <<'SVC'
[Unit]
Description=Hermes Gateway

[Service]
ExecStart=/bin/true
SVC

  local valid_token="vwk_AAAAAAAAAAAAAAAAAAAA_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
  local api_base="https://api.example.com"

  local install_stdout
  install_stdout="$(DESTDIR="$fake_root" \
    WEBSITE_KEY="$valid_token" \
    API_BASE="$api_base" \
    RUNTIME_USER="agentuser" \
    SYSTEMCTL_USER_CMD="systemctl --user" \
    SYSTEMCTL_LOG="${systemctl_log}" \
    FAKE_HOME_ROOT="${fake_root}/home" \
    bash "$script" 2>"${TEST_TMP}/install-stderr.log")" || true

  assert "install: credential file created" \
    '[[ -f "${fake_root}/etc/vela/website-credential.env" ]]'

  assert "install: credential file has VELA_WEBSITE_KEY" \
    'grep -q "^VELA_WEBSITE_KEY=" "${fake_root}/etc/vela/website-credential.env"'

  assert "install: credential file has VELA_API_BASE" \
    'grep -q "^VELA_API_BASE=" "${fake_root}/etc/vela/website-credential.env"'

  local mode
  mode="$(get_file_mode "${fake_root}/etc/vela/website-credential.env")"
  assert "install: file mode is 0440" \
    '[[ "$mode" == "440" ]]'

  local dropin="${user_systemd}/hermes-gateway-test.service.d/vela-website-credential.conf"
  assert "install: drop-in created" \
    '[[ -f "${dropin}" ]]'
  assert "install: drop-in has EnvironmentFile" \
    'grep -q "EnvironmentFile=" "${dropin}"'

  assert "install: systemctl daemon-reload called" \
    'grep -q "daemon-reload" "${systemctl_log}"'
  assert "install: systemctl restart called" \
    'grep -q "restart" "${systemctl_log}"'

  assert "install: token not in stderr" \
    '! grep -q "vwk_AAAA" "${TEST_TMP}/install-stderr.log"'
  assert "install: token not in stdout" \
    '! echo "$install_stdout" | grep -q "vwk_AAAA"'
  assert "install: token not in systemctl log" \
    '! grep -q "vwk_AAAA" "${systemctl_log}"'

  # Test: invalid token rejected
  local invalid_result=0
  DESTDIR="$fake_root" \
  WEBSITE_KEY="invalid_token" \
  API_BASE="$api_base" \
  RUNTIME_USER="agentuser" \
  SYSTEMCTL_USER_CMD="systemctl --user" \
  SYSTEMCTL_LOG="${systemctl_log}" \
  FAKE_HOME_ROOT="${fake_root}/home" \
  bash "$script" 2>/dev/null || invalid_result=$?
  assert "install: invalid token rejected" \
    '[[ $invalid_result -ne 0 ]]'

  # Test: missing API_BASE rejected
  local missing_api_result=0
  DESTDIR="$fake_root" \
  WEBSITE_KEY="$valid_token" \
  API_BASE="" \
  RUNTIME_USER="agentuser" \
  SYSTEMCTL_USER_CMD="systemctl --user" \
  SYSTEMCTL_LOG="${systemctl_log}" \
  FAKE_HOME_ROOT="${fake_root}/home" \
  bash "$script" 2>/dev/null || missing_api_result=$?
  assert "install: missing API_BASE rejected" \
    '[[ $missing_api_result -ne 0 ]]'
}

# ========================================================================
# Main
# ========================================================================

main() {
  echo "=== Syntax check ==="
  test_syntax
  echo "PASS: syntax check"

  echo "=== Create command test ==="
  test_create_command
  echo "PASS: create command test"

  echo "=== Invoke command test ==="
  test_invoke_command
  echo "PASS: invoke command test"

  echo "=== Install script test ==="
  test_install_script
  echo "PASS: install script test"

  echo ""
  echo "================================"
  echo "Results: ${PASS} passed, ${FAIL} failed"
  echo "================================"
  [[ $FAIL -eq 0 ]] || exit 1
}

main "$@"
