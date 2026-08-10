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
printf '{"Response":{"CommandId":"cmd-test-cred-001","RequestId":"req-create-001"}}'
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
case "${2:-}" in
  InvokeCommand)
    request_uri=""
    previous=""
    for arg in "$@"; do
      if [[ "$previous" == "--cli-input-json" ]]; then
        request_uri="$arg"
        break
      fi
      previous="$arg"
    done
    [[ "$request_uri" == file://* ]] || exit 2
    request_file="${request_uri#file://}"
    request_mode="$(stat -c %a "$request_file" 2>/dev/null || stat -f %Lp "$request_file" 2>/dev/null || true)"
    [[ "$request_mode" == "600" ]] || exit 3
    instance_id="$(python3 - "$request_file" <<'PY'
import json
import sys

with open(sys.argv[1]) as f:
    request = json.load(f)
assert request["CommandId"] == "cmd-test-cred-001"
assert len(request["InstanceIds"]) == 1
parameters = json.loads(request["Parameters"])
assert parameters["website_key"].startswith("vwk_")
assert parameters["api_base"] == "https://api.example.com"
print(request["InstanceIds"][0])
PY
)" || exit 4
    printf '%s|%s\n' "$instance_id" "$request_mode" >>"${TCCLI_REQUEST_LOG:-/dev/null}"
    printf '{"Response":{"InvocationId":"inv-%s","RequestId":"req-invoke-%s"}}' "$instance_id" "$instance_id"
    ;;
  DescribeInvocationTasks)
    invocation_id=""
    previous=""
    for arg in "$@"; do
      if [[ "$previous" == "--Filters" ]]; then
        invocation_id="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])[0]["Values"][0])' "$arg")"
        break
      fi
      previous="$arg"
    done
    instance_id="${invocation_id#inv-}"
    final_status="${TAT_STUB_FINAL_STATUS:-SUCCESS}"
    exit_code=0
    [[ "$final_status" == "SUCCESS" ]] || exit_code=1
    printf '{"Response":{"InvocationTaskSet":[{"InvocationId":"%s","InstanceId":"%s","TaskStatus":"%s","TaskResult":{"ExitCode":%s}}],"RequestId":"req-poll-%s"}}' \
      "$invocation_id" "$instance_id" "$final_status" "$exit_code" "$instance_id"
    ;;
  *)
    printf '{"Response":{"RequestId":"req-unknown"}}'
    ;;
esac
STUB
  chmod +x "${TEST_TMP}/bin/tccli"
  export PATH="${TEST_TMP}/bin:${PATH}"

  local input_file="${TEST_TMP}/instances.jsonl"
  local request_log="${TEST_TMP}/tccli-request.log"
  cat >"$input_file" <<'JSONL'
{"cloud_id":"ins-aaa111","website_key":"vwk_AAAAAAAAAAAAAAAAAAAA_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
{"cloud_id":"ins-bbb222","website_key":"vwk_CCCCCCCCCCCCCCCCCCCCCC_DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"}
JSONL

  local output
  output="$(TCCLI_LOG="${tccli_log}" \
    TCCLI_REQUEST_LOG="${request_log}" \
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

  local poll_count
  poll_count="$(tr '\0' '\n' <"${tccli_log}" 2>/dev/null | awk '$0 == "DescribeInvocationTasks" { count++ } END { print count + 0 }')"
  assert "invoke: polls each invocation to a terminal task status" \
    '[[ "$poll_count" -eq 2 ]]'

  local args
  args="$(tr '\0' '\n' <"${tccli_log}")"

  assert "invoke: uses owner-only cli input file for ins-aaa111" \
    'grep -q "^ins-aaa111|600$" "$request_log"'
  assert "invoke: uses owner-only cli input file for ins-bbb222" \
    'grep -q "^ins-bbb222|600$" "$request_log"'
  assert "invoke: uses cli-input-json" \
    'echo "$args" | grep -q -- "--cli-input-json"'
  assert "invoke: tccli argv contains no website key" \
    '! echo "$args" | grep -q "vwk_"'
  assert "invoke: tccli argv contains no parameter payload" \
    '! echo "$args" | grep -q "website_key"'

  assert "invoke: no key in stdout" \
    '! echo "$output" | grep -q "vwk_AAAA"'
  assert "invoke: no key in stdout (2)" \
    '! echo "$output" | grep -q "vwk_CCCC"'

  assert "invoke: result JSONL exists" \
    'ls "${TEST_TMP}"/website-credential-invoke-*.jsonl 2>/dev/null | head -1 | grep -q .'

  local result_jsonl result_json summary_json
  result_jsonl="$(ls "${TEST_TMP}"/website-credential-invoke-*.jsonl 2>/dev/null | head -1)"
  result_json="$(ls "${TEST_TMP}"/website-credential-invoke-*.json 2>/dev/null | grep -v '\.summary\.json$' | head -1)"
  summary_json="$(ls "${TEST_TMP}"/website-credential-invoke-*.summary.json 2>/dev/null | head -1)"
  assert "invoke: detailed results do not retain website_key field" \
    '! grep -q '"'"'website_key'"'"' "$result_jsonl" "$result_json" "$summary_json"'
  assert "invoke: detailed results do not retain token value" \
    '! grep -q '"'"'vwk_'"'"' "$result_jsonl" "$result_json" "$summary_json"'
  assert "invoke: records final SUCCESS status, not mere acceptance" \
    'grep -q '"'"'"task_status":"SUCCESS"'"'"' "$result_jsonl" && ! grep -q '"'"'"invoke_status":"INVOKED"'"'"' "$result_jsonl"'
  assert "invoke: result files are owner-only" \
    '[[ "$(get_file_mode "$result_jsonl")" == "600" && "$(get_file_mode "$result_json")" == "600" && "$(get_file_mode "$summary_json")" == "600" ]]'

  local failed_output_dir="${TEST_TMP}/failed-results"
  local failed_result=0
  TCCLI_LOG="${TEST_TMP}/tccli-invoke-failed.log" \
  TAT_STUB_FINAL_STATUS=FAILED \
  HERMES_TAT_COMMAND_ID=cmd-test-cred-001 \
  HERMES_TAT_REGION=ap-shanghai \
  HERMES_TAT_API_BASE="https://api.example.com" \
  HERMES_TAT_OUTPUT_DIR="$failed_output_dir" \
    bash "${ROOT_DIR}/.ci/runtime/commands/invoke_hermes_website_credential_command.sh" \
      <<<"$(head -1 "$input_file")" >"${TEST_TMP}/invoke-failed.stdout" 2>"${TEST_TMP}/invoke-failed.stderr" || failed_result=$?
  assert "invoke: terminal FAILED exits non-zero" \
    '[[ $failed_result -ne 0 ]]'
  assert "invoke: terminal FAILED is retained without credential" \
    'grep -q '"'"'"task_status":"FAILED"'"'"' "$failed_output_dir"/*.jsonl && ! grep -q '"'"'vwk_'"'"' "$failed_output_dir"/*'

  local invalid_cloud_log="${TEST_TMP}/tccli-invalid-cloud.log"
  local invalid_cloud_result=0
  TCCLI_LOG="$invalid_cloud_log" \
  HERMES_TAT_COMMAND_ID=cmd-test-cred-001 \
  HERMES_TAT_REGION=ap-shanghai \
  HERMES_TAT_API_BASE="https://api.example.com" \
  HERMES_TAT_OUTPUT_DIR="${TEST_TMP}/invalid-cloud-results" \
    bash "${ROOT_DIR}/.ci/runtime/commands/invoke_hermes_website_credential_command.sh" \
      <<'JSONL' >"${TEST_TMP}/invalid-cloud.stdout" 2>"${TEST_TMP}/invalid-cloud.stderr" || invalid_cloud_result=$?
{"cloud_id":"ins-../../escape","website_key":"vwk_AAAAAAAAAAAAAAAAAAAAAA_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
JSONL
  assert "invoke: rejects cloud_id outside the CVM ID format" \
    '[[ $invalid_cloud_result -ne 0 ]]'
  assert "invoke: invalid cloud_id is rejected during JSONL validation" \
    'grep -q "input JSONL validation failed" "${TEST_TMP}/invalid-cloud.stderr"'
  assert "invoke: invalid cloud_id never reaches tccli" \
    '[[ ! -e "$invalid_cloud_log" ]]'
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
printf 'XDG_RUNTIME_DIR=%s DBUS_SESSION_BUS_ADDRESS=%s %s\n' \
  "${XDG_RUNTIME_DIR:-}" "${DBUS_SESSION_BUS_ADDRESS:-}" "$*" >>"$SYSTEMCTL_LOG"
if [[ "${SYSTEMCTL_FAIL_RESTART:-false}" == "true" && "$*" == *"restart"* ]]; then
  exit 1
fi
exit 0
STUB
  chmod +x "${TEST_TMP}/bin/systemctl"

  # Stub id: the runtime user's user manager lives under /run/user/1000.
  cat >"${TEST_TMP}/bin/id" <<'STUB'
#!/usr/bin/env bash
if [[ "$1" == "-u" && "$2" == "agentuser" ]]; then
  printf '1000\n'
else
  /usr/bin/id "$@"
fi
STUB
  chmod +x "${TEST_TMP}/bin/id"

  cat >"${TEST_TMP}/bin/chown" <<'STUB'
#!/usr/bin/env bash
if [[ "${CHOWN_FAIL_DROPIN:-false}" == "true" && "$*" == *".service.d"* ]]; then
  exit 1
fi
exit 0
STUB
  chmod +x "${TEST_TMP}/bin/chown"

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

  local valid_token="vwk_AAAAAAAAAAAAAAAAAAAAAA_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
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

  # Base64url key IDs may legally contain underscores. Validation must use
  # fixed token-part lengths instead of splitting on the first underscore.
  local underscore_token="vwk_AAAAAAAAAA_AAAAAAAAAAA_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
  local underscore_result=0
  DESTDIR="$fake_root" \
  WEBSITE_KEY="$underscore_token" \
  API_BASE="$api_base" \
  RUNTIME_USER="agentuser" \
  SYSTEMCTL_LOG="${systemctl_log}" \
  FAKE_HOME_ROOT="${fake_root}/home" \
  bash "$script" >"${TEST_TMP}/install-underscore.stdout" 2>"${TEST_TMP}/install-underscore.stderr" || underscore_result=$?
  assert "install: key ID containing underscore accepted" \
    '[[ $underscore_result -eq 0 ]]'
  assert "install: default systemctl command sets runtime directory" \
    'grep -q "XDG_RUNTIME_DIR=/run/user/1000" "${systemctl_log}"'
  assert "install: default systemctl command sets bus address" \
    'grep -q "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus" "${systemctl_log}"'

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

  local no_unit_root="${TEST_TMP}/no-unit-root"
  mkdir -p "${no_unit_root}/home/agentuser/.config/systemd/user"
  local no_unit_result=0
  DESTDIR="$no_unit_root" \
  WEBSITE_KEY="$valid_token" \
  API_BASE="$api_base" \
  RUNTIME_USER="agentuser" \
  SYSTEMCTL_USER_CMD="systemctl --user" \
  SYSTEMCTL_LOG="${TEST_TMP}/no-unit-systemctl.log" \
  FAKE_HOME_ROOT="${no_unit_root}/home" \
    bash "$script" >"${TEST_TMP}/no-unit.stdout" 2>"${TEST_TMP}/no-unit.stderr" || no_unit_result=$?
  assert "install: no gateway unit is a hard failure" \
    '[[ $no_unit_result -ne 0 && ! -e "$no_unit_root/etc/vela/website-credential.env" ]]'

  local multiple_root="${TEST_TMP}/multiple-unit-root"
  local multiple_systemd="${multiple_root}/home/agentuser/.config/systemd/user"
  mkdir -p "$multiple_systemd"
  : >"${multiple_systemd}/hermes-gateway-a.service"
  : >"${multiple_systemd}/hermes-gateway-b.service"
  local multiple_result=0
  DESTDIR="$multiple_root" \
  WEBSITE_KEY="$valid_token" \
  API_BASE="$api_base" \
  RUNTIME_USER="agentuser" \
  SYSTEMCTL_USER_CMD="systemctl --user" \
  SYSTEMCTL_LOG="${TEST_TMP}/multiple-systemctl.log" \
  FAKE_HOME_ROOT="${multiple_root}/home" \
    bash "$script" >"${TEST_TMP}/multiple.stdout" 2>"${TEST_TMP}/multiple.stderr" || multiple_result=$?
  assert "install: multiple gateway units are a hard failure" \
    '[[ $multiple_result -ne 0 && ! -e "$multiple_root/etc/vela/website-credential.env" ]]'

  local old_credential
  old_credential="$(cat "${fake_root}/etc/vela/website-credential.env")"
  local replacement_token="vwk_CCCCCCCCCCCCCCCCCCCCCC_DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"
  local rollback_result=0
  DESTDIR="$fake_root" \
  WEBSITE_KEY="$replacement_token" \
  API_BASE="$api_base" \
  RUNTIME_USER="agentuser" \
  SYSTEMCTL_USER_CMD="systemctl --user" \
  SYSTEMCTL_FAIL_RESTART=true \
  SYSTEMCTL_LOG="${systemctl_log}" \
  FAKE_HOME_ROOT="${fake_root}/home" \
    bash "$script" >"${TEST_TMP}/rollback.stdout" 2>"${TEST_TMP}/rollback.stderr" || rollback_result=$?
  assert "install: restart failure is reported" \
    '[[ $rollback_result -ne 0 ]]'
  assert "install: restart failure restores previous credential" \
    '[[ "$(cat "${fake_root}/etc/vela/website-credential.env")" == "$old_credential" ]]'
  assert "install: failed replacement token is not retained" \
    '! grep -q '"'"'vwk_CCCC'"'"' "${fake_root}/etc/vela/website-credential.env"'

  local chown_failure_result=0
  DESTDIR="$fake_root" \
  WEBSITE_KEY="$replacement_token" \
  API_BASE="$api_base" \
  RUNTIME_USER="agentuser" \
  SYSTEMCTL_USER_CMD="systemctl --user" \
  CHOWN_FAIL_DROPIN=true \
  SYSTEMCTL_LOG="${systemctl_log}" \
  FAKE_HOME_ROOT="${fake_root}/home" \
    bash "$script" >"${TEST_TMP}/chown-failure.stdout" 2>"${TEST_TMP}/chown-failure.stderr" || chown_failure_result=$?
  assert "install: drop-in chown failure is reported" \
    '[[ $chown_failure_result -ne 0 ]]'
  assert "install: drop-in chown failure restores previous credential" \
    '[[ "$(cat "${fake_root}/etc/vela/website-credential.env")" == "$old_credential" ]]'
  assert "install: ownership failure reports the installation rollback" \
    'grep -q "credential installation failed; previous configuration restored" "${TEST_TMP}/chown-failure.stderr"'
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
