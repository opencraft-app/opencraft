#!/usr/bin/env bash

if [ "${LIGHTCLAW_SSH_LIB_LOADED:-0}" = "1" ]; then
  return 0
fi
LIGHTCLAW_SSH_LIB_LOADED=1

sshlib_log_info() {
  if declare -F log_info >/dev/null 2>&1; then
    log_info "$@"
  else
    echo "INFO: $*"
  fi
}

sshlib_log_warn() {
  if declare -F log_warn >/dev/null 2>&1; then
    log_warn "$@"
  else
    echo "WARN: $*" >&2
  fi
}

sshlib_log_error() {
  if declare -F log_error >/dev/null 2>&1; then
    log_error "$@"
  else
    echo "ERROR: $*" >&2
  fi
}

sshlib_require_init() {
  if [ -z "${SSHLIB_REMOTE_HOST:-}" ] || [ -z "${SSHLIB_PORT:-}" ]; then
    sshlib_log_error "sshlib_init must be called before using SSH helpers"
    return 1
  fi
}

sshlib_init() {
  SSHLIB_REMOTE_HOST="$1"
  SSHLIB_PORT="${2:-22}"
  SSHLIB_REMOTE_USER="${SSHLIB_REMOTE_HOST%@*}"
  if [ "${SSHLIB_REMOTE_USER}" = "${SSHLIB_REMOTE_HOST}" ]; then
    SSHLIB_REMOTE_USER=""
  fi
  SSHLIB_KNOWN_HOST_TARGET="${SSHLIB_REMOTE_HOST#*@}"
  SSHLIB_COMMON_OPTS=(
    -o StrictHostKeyChecking=accept-new
    -o UserKnownHostsFile="${HOME}/.ssh/known_hosts"
  )
  if [ -n "${LIGHTCLAW_SSH_IDENTITY_FILE:-}" ]; then
    SSHLIB_COMMON_OPTS+=(
      -i "${LIGHTCLAW_SSH_IDENTITY_FILE}"
      -o IdentitiesOnly=yes
    )
  fi
}

sshlib_cleanup_known_host() {
  sshlib_require_init || return 1
  ssh-keygen -R "[${SSHLIB_KNOWN_HOST_TARGET}]:${SSHLIB_PORT}" >/dev/null 2>&1 || true
  ssh-keygen -R "${SSHLIB_KNOWN_HOST_TARGET}" >/dev/null 2>&1 || true
}

sshlib_is_host_key_failure() {
  local text="$1"
  grep -Eq "REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed" <<<"${text}"
}

sshlib_is_transport_failure() {
  local text="$1"
  grep -Eq "Connection closed by|kex_exchange_identification|Connection reset by peer|Broken pipe|Operation timed out|Connection timed out" <<<"${text}"
}

sshlib_run_raw_internal() {
  local tty_mode="$1"
  local retry_policy="$2"
  shift 2

  sshlib_require_init || return 1

  local attempts=1
  local delay_s="${SSHLIB_RETRY_DELAY_SECONDS:-5}"
  local try_num=1
  local err_file=""
  local stderr_text=""

  if [ "${retry_policy}" = "transport_safe" ]; then
    attempts="${SSHLIB_RETRY_ATTEMPTS:-4}"
  fi

  while [ "${try_num}" -le "${attempts}" ]; do
    err_file="$(mktemp)"
    if [ "${tty_mode}" = "true" ]; then
      if ssh "${SSHLIB_COMMON_OPTS[@]}" -t -p "${SSHLIB_PORT}" "${SSHLIB_REMOTE_HOST}" "$@" 2> >(tee "${err_file}" >&2); then
        rm -f "${err_file}"
        return 0
      fi
    else
      if ssh "${SSHLIB_COMMON_OPTS[@]}" -p "${SSHLIB_PORT}" "${SSHLIB_REMOTE_HOST}" "$@" 2> >(tee "${err_file}" >&2); then
        rm -f "${err_file}"
        return 0
      fi
    fi

    stderr_text="$(cat "${err_file}")"
    rm -f "${err_file}"

    if sshlib_is_host_key_failure "${stderr_text}"; then
      sshlib_log_info "detected changed host key for ${SSHLIB_KNOWN_HOST_TARGET}:${SSHLIB_PORT}, refreshing known_hosts entry"
      sshlib_cleanup_known_host
      continue
    fi

    if [ "${retry_policy}" = "transport_safe" ] && sshlib_is_transport_failure "${stderr_text}" && [ "${try_num}" -lt "${attempts}" ]; then
      sshlib_log_warn "ssh transport failed (attempt ${try_num}/${attempts}), retrying in ${delay_s}s"
      sleep "${delay_s}"
      try_num=$((try_num + 1))
      continue
    fi

    return 1
  done

  return 1
}

sshlib_run_raw() {
  sshlib_run_raw_internal false never "$@"
}

sshlib_run_raw_retry_transport_safe() {
  sshlib_run_raw_internal false transport_safe "$@"
}

sshlib_run_raw_tty() {
  sshlib_run_raw_internal true never "$@"
}

sshlib_run_raw_tty_retry_transport_safe() {
  sshlib_run_raw_internal true transport_safe "$@"
}

sshlib_exec() {
  local escaped
  escaped="$(printf '%q' "$1")"
  sshlib_run_raw "bash -lc ${escaped}"
}

sshlib_exec_retry_transport_safe() {
  local escaped
  escaped="$(printf '%q' "$1")"
  sshlib_run_raw_retry_transport_safe "bash -lc ${escaped}"
}

sshlib_exec_tty() {
  local escaped
  escaped="$(printf '%q' "$1")"
  sshlib_run_raw_tty "bash -lc ${escaped}"
}

sshlib_exec_tty_retry_transport_safe() {
  local escaped
  escaped="$(printf '%q' "$1")"
  sshlib_run_raw_tty_retry_transport_safe "bash -lc ${escaped}"
}

sshlib_exec_with_timeout() {
  local timeout_s="$1"
  local escaped
  shift
  escaped="$(printf '%q' "$1")"
  sshlib_require_init || return 1
  timeout "${timeout_s}" \
    ssh "${SSHLIB_COMMON_OPTS[@]}" -p "${SSHLIB_PORT}" "${SSHLIB_REMOTE_HOST}" "bash -lc ${escaped}"
}

sshlib_upload_file() {
  local local_path="$1"
  local remote_path="$2"
  local use_sudo="${3:-false}"

  sshlib_require_init || return 1

  if [ ! -f "${local_path}" ]; then
    sshlib_log_error "local file not found: ${local_path}"
    return 1
  fi

  if [ "${use_sudo}" = "true" ]; then
    sshlib_run_raw_retry_transport_safe \
      "sudo mkdir -p \"$(dirname "${remote_path}")\" && sudo tee \"${remote_path}\" >/dev/null" < "${local_path}"
    return $?
  fi

  sshlib_run_raw_retry_transport_safe \
    "mkdir -p \"$(dirname "${remote_path}")\" && cat > \"${remote_path}\"" < "${local_path}"
}

sshlib_ensure_ready() {
  sshlib_require_init || return 1

  local attempts="${SSH_READY_ATTEMPTS:-6}"
  local delay_s="${SSH_READY_DELAY_SECONDS:-5}"
  local try_num=1

  while [ "${try_num}" -le "${attempts}" ]; do
    if sshlib_run_raw_retry_transport_safe "true" >/dev/null; then
      return 0
    fi

    if [ "${try_num}" -ge "${attempts}" ]; then
      sshlib_log_error "SSH preflight failed after ${attempts} attempts"
      return 1
    fi

    sshlib_log_warn "initial ssh readiness check failed (attempt ${try_num}/${attempts}), retrying in ${delay_s}s"
    sleep "${delay_s}"
    try_num=$((try_num + 1))
  done

  return 1
}
