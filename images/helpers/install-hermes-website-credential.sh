#!/usr/bin/env bash
# install-hermes-website-credential.sh
#
# Runs on a target Hermes CVM via Tencent Cloud TAT as root.
# Receives WEBSITE_KEY and API_BASE from environment variables
# (set by TAT parameter substitution from {{tat-hidden:website_key}} and {{api_base}}).
#
# Actions:
#   1. Validate the token format (vik_<key_id>_<secret>)
#   2. Atomically write /etc/vela/website-credential.env (root:agentuser 0440)
#   3. Discover one gateway unit (or all units with an explicit opt-in)
#   4. Add a drop-in with EnvironmentFile= to every selected unit
#   5. Reload and restart selected user services, rolling back on failure
#   6. Verify VELA_WEBSITE_KEY is present (without printing its value)

set -euo pipefail

DESTDIR="${DESTDIR:-}"
CREDENTIAL_FILE="${DESTDIR}/etc/vela/website-credential.env"
CREDENTIAL_DIR=""
RUNTIME_USER="${RUNTIME_USER:-agentuser}"

# Optional command override for running systemctl --user as the runtime user.
# The default is assembled by run_systemctl_user so it can include the user's
# runtime directory and D-Bus address in non-login TAT sessions.
SYSTEMCTL_USER_CMD="${SYSTEMCTL_USER_CMD:-}"

# Optional explicit unit override
HERMES_GATEWAY_UNIT="${HERMES_GATEWAY_UNIT:-}"

# Unit patterns to search for
UNIT_PATTERNS=('hermes-gateway*.service' 'openclaw-gateway*.service')

log() {
  printf '[install-website-credential] %s\n' "$*" >&2
}

fail() {
  printf '[install-website-credential] ERROR: %s\n' "$*" >&2
  exit 1
}

validate_token() {
  local token="$1"
  # key_id and secret are base64url, where '_' is legal data. Match their
  # fixed encoded lengths instead of splitting on the first underscore.
  [[ "$token" =~ ^vik_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}$ ]]
}

run_systemctl_user() {
  if [[ -n "$SYSTEMCTL_USER_CMD" ]]; then
    $SYSTEMCTL_USER_CMD "$@"
    return
  fi

  local runtime_uid
  runtime_uid="$(id -u "$RUNTIME_USER")" || fail "cannot resolve uid for $RUNTIME_USER"
  runuser -u "$RUNTIME_USER" -- env \
    "XDG_RUNTIME_DIR=/run/user/${runtime_uid}" \
    "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${runtime_uid}/bus" \
    systemctl --user "$@"
}

write_credential_file() {
  local token="$1"
  local api_base="$2"
  CREDENTIAL_DIR="$(dirname "$CREDENTIAL_FILE")"
  mkdir -p "$CREDENTIAL_DIR" || return 1
  local tmp_file
  tmp_file="$(mktemp "${CREDENTIAL_DIR}/.website-credential.XXXXXX")" || return 1
  if ! printf 'VELA_WEBSITE_KEY=%s\n' "$token" >"$tmp_file" ||
    ! printf 'VELA_API_BASE=%s\n' "$api_base" >>"$tmp_file" ||
    ! chmod 0440 "$tmp_file" ||
    ! chown root:"$RUNTIME_USER" "$tmp_file" 2>/dev/null; then
    rm -f "$tmp_file"
    return 1
  fi
  if ! mv -f "$tmp_file" "$CREDENTIAL_FILE"; then
    rm -f "$tmp_file"
    return 1
  fi
}

get_user_home() {
  local user="$1"
  getent passwd "$user" 2>/dev/null | cut -d: -f6 || true
}

list_gateway_units() {
  local user_home
  user_home="$(get_user_home "$RUNTIME_USER")"
  [[ -n "$user_home" ]] || return 1

  local systemd_dir="${user_home}/.config/systemd/user"
  [[ -d "$systemd_dir" ]] || return 1

  local found=()
  local pattern
  for pattern in "${UNIT_PATTERNS[@]}"; do
    local f
    while IFS= read -r f; do
      [[ -n "$f" ]] && found+=("$(basename "$f")")
    done < <(find "$systemd_dir" -maxdepth 1 -type f -name "$pattern" 2>/dev/null || true)
  done

  # Include loaded units even if unit files exist. Otherwise an additional
  # runtime unit can be silently skipped in explicit all-gateway mode.
  local listed
  listed="$(run_systemctl_user list-units --type=service --no-legend 2>/dev/null \
    | grep -oE '(hermes-gateway|openclaw-gateway)[^ ]*\.service' || true)"
  while IFS= read -r line; do
    [[ -n "$line" ]] && found+=("$line")
  done <<<"$listed"

  # Deduplicate
  local unique=()
  local u
  for u in "${found[@]:-}"; do
    [[ -n "$u" ]] || continue
    local seen=0
    local ex
    for ex in "${unique[@]:-}"; do
      [[ "$u" == "$ex" ]] && seen=1 && break
    done
    [[ $seen -eq 0 ]] && unique+=("$u")
  done

  ((${#unique[@]} > 0)) || return 1
  printf '%s\n' "${unique[@]}"
}

discover_gateway_unit() {
  local -a unique=()
  local candidate
  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] && unique+=("$candidate")
  done < <(list_gateway_units)
  if [[ ${#unique[@]} -eq 1 ]]; then
    printf '%s\n' "${unique[0]}"
  elif [[ ${#unique[@]} -gt 1 ]]; then
    log "Multiple gateway units found: ${unique[*]}"
    log "Set HERMES_GATEWAY_UNIT to select one explicitly"
    return 2
  else
    return 1
  fi
}

add_dropin() {
  local unit="$1"
  local user_home
  user_home="$(get_user_home "$RUNTIME_USER")"
  [[ -n "$user_home" ]] || fail "cannot resolve home directory for $RUNTIME_USER"

  local dropin_dir="${user_home}/.config/systemd/user/${unit}.d"
  mkdir -p "$dropin_dir" || return 1
  local dropin_file="${dropin_dir}/vela-website-credential.conf"
  printf '[Service]\nEnvironmentFile=%s\n' "$CREDENTIAL_FILE" >"$dropin_file" || return 1
  chown -R "$RUNTIME_USER":"$RUNTIME_USER" "$dropin_dir" 2>/dev/null || return 1
}

verify_credential() {
  [[ -f "$CREDENTIAL_FILE" ]] || return 1
  grep -q '^VELA_WEBSITE_KEY=' "$CREDENTIAL_FILE" || return 1
  grep -q '^VELA_API_BASE=' "$CREDENTIAL_FILE" || return 1
}

main() (
  local token="${WEBSITE_KEY:-}"
  local api_base="${API_BASE:-}"

  [[ -n "$token" ]] || fail "WEBSITE_KEY environment variable is required"
  [[ -n "$api_base" ]] || fail "API_BASE environment variable is required"

  validate_token "$token" || fail "invalid token format (expected vik_<key_id>_<secret>)"

  local -a units=()
  case "${HERMES_GATEWAY_MODE:-}" in
    all)
      [[ -z "$HERMES_GATEWAY_UNIT" ]] || fail "gateway unit override conflicts with all mode"
      local candidate
      while IFS= read -r candidate; do
        [[ -n "$candidate" ]] && units+=("$candidate")
      done < <(list_gateway_units)
      ((${#units[@]} > 0)) || fail "no gateway unit found"
      ((${#units[@]} <= 16)) || fail "too many gateway units"
      ;;
    '')
      local unit="$HERMES_GATEWAY_UNIT"
      if [[ -z "$unit" ]]; then
        local discover_rc=0
        unit="$(discover_gateway_unit 2>/dev/null)" || discover_rc=$?
        case "$discover_rc" in
          0) ;;
          2) fail "multiple gateway units found; set HERMES_GATEWAY_UNIT to pick one" ;;
          *) fail "no gateway unit found" ;;
        esac
      fi
      units=("$unit")
      ;;
    *) fail "unsupported gateway mode" ;;
  esac
  local unit
  for unit in "${units[@]}"; do
    [[ "$unit" =~ ^(hermes-gateway|openclaw-gateway)[A-Za-z0-9@_.-]*\.service$ ]] || fail "invalid gateway unit"
  done

  local user_home
  user_home="$(get_user_home "$RUNTIME_USER")"
  [[ -n "$user_home" ]] || fail "cannot resolve home directory for $RUNTIME_USER"
  [[ ! -L "$CREDENTIAL_FILE" ]] || fail "credential path must not be a symlink"

  local backup_dir
  backup_dir="$(mktemp -d "${TMPDIR:-/tmp}/website-credential-backup.XXXXXX")"
  local had_credential=false transaction_started=false transaction_committed=false
  local -a dropin_files=() had_dropin=()
  CREDENTIAL_DIR="$(dirname "$CREDENTIAL_FILE")"

  # Keep the backups until verification completes. This trap also handles a
  # TAT timeout or an unexpected exit between writing and restarting units.
  # main is a subshell so its local backup metadata remains available at EXIT.
  cleanup_transaction() {
    local exit_status="$1" restore_failed=false restore_tmp="" index unit
    trap - EXIT INT TERM
    set +e
    if [[ "$transaction_started" == "true" && "$transaction_committed" != "true" ]]; then
      if [[ "$had_credential" == "true" ]]; then
        mkdir -p "$CREDENTIAL_DIR" || restore_failed=true
        if [[ "$restore_failed" == "false" ]]; then
          restore_tmp="$(mktemp "${CREDENTIAL_DIR}/.website-credential.rollback.XXXXXX")" || restore_failed=true
        fi
        if [[ "$restore_failed" == "false" ]]; then
          cp -p "${backup_dir}/credential.env" "$restore_tmp" && mv -f "$restore_tmp" "$CREDENTIAL_FILE" || restore_failed=true
        fi
        [[ -z "$restore_tmp" ]] || rm -f "$restore_tmp"
      else
        rm -f "$CREDENTIAL_FILE" || restore_failed=true
      fi
      for ((index=0; index<${#units[@]}; index++)); do
        if [[ "${had_dropin[$index]}" == "true" ]]; then
          mkdir -p "$(dirname "${dropin_files[$index]}")" &&
            cp -p "${backup_dir}/dropin-${index}.conf" "${dropin_files[$index]}" || restore_failed=true
        else
          rm -f "${dropin_files[$index]}" || restore_failed=true
        fi
      done
      run_systemctl_user daemon-reload >/dev/null 2>&1 || restore_failed=true
      for unit in "${units[@]}"; do
        run_systemctl_user restart "$unit" >/dev/null 2>&1 || restore_failed=true
      done
      if [[ "$restore_failed" == "false" ]]; then
        log "credential installation failed; previous configuration restored"
      else
        log "credential installation failed; rollback incomplete, protected backup retained for recovery"
      fi
    fi
    if [[ "$restore_failed" == "false" ]]; then
      rm -rf -- "$backup_dir" || restore_failed=true
    fi
    if [[ "$restore_failed" == "true" ]]; then
      exit 1
    fi
    exit "$exit_status"
  }
  trap 'cleanup_transaction "$?"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  if [[ -f "$CREDENTIAL_FILE" ]]; then
    cp -p "$CREDENTIAL_FILE" "${backup_dir}/credential.env"
    had_credential=true
  fi
  local index=0
  for unit in "${units[@]}"; do
    local dropin_file="${user_home}/.config/systemd/user/${unit}.d/vela-website-credential.conf"
    [[ ! -L "$dropin_file" ]] || fail "gateway drop-in path must not be a symlink"
    dropin_files+=("$dropin_file")
    if [[ -f "$dropin_file" ]]; then
      cp -p "$dropin_file" "${backup_dir}/dropin-${index}.conf"
      had_dropin+=(true)
    else
      had_dropin+=(false)
    fi
    index=$((index + 1))
  done

  transaction_started=true
  local apply_ok=true
  write_credential_file "$token" "$api_base" || apply_ok=false
  if [[ "$apply_ok" == "true" ]]; then
    for unit in "${units[@]}"; do
      add_dropin "$unit" || { apply_ok=false; break; }
    done
  fi
  if [[ "$apply_ok" == "true" ]]; then
    run_systemctl_user daemon-reload || apply_ok=false
  fi
  if [[ "$apply_ok" == "true" ]]; then
    for unit in "${units[@]}"; do
      run_systemctl_user restart "$unit" && run_systemctl_user is-active --quiet "$unit" || { apply_ok=false; break; }
    done
  fi

  [[ "$apply_ok" == "true" ]] || fail "credential installation failed"
  verify_credential || fail "credential verification failed"
  transaction_committed=true
  log "gateway services restarted and active: ${#units[@]}"

  echo "OK: website credential installed"
  # Never print the token value
)

# Run main only when executed directly (not sourced for testing)
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
