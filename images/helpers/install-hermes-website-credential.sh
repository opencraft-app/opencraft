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
#   3. Discover the single Hermes gateway systemd user unit
#   4. Add a drop-in with EnvironmentFile= pointing to the credential file
#   5. Reload and restart the user service
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

discover_gateway_unit() {
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

  # Also check loaded units via systemctl
  if [[ ${#found[@]} -eq 0 ]]; then
    local listed
    listed="$(run_systemctl_user list-units --type=service --no-legend 2>/dev/null \
      | grep -oE '(hermes-gateway|openclaw-gateway)[^ ]*\.service' || true)"
    while IFS= read -r line; do
      [[ -n "$line" ]] && found+=("$line")
    done <<<"$listed"
  fi

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

  if [[ ${#unique[@]} -eq 1 ]]; then
    printf '%s\n' "${unique[0]}"
    return 0
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

restart_service() {
  local unit="$1"
  run_systemctl_user daemon-reload || return 1
  run_systemctl_user restart "$unit" || return 1
  run_systemctl_user is-active --quiet "$unit" || return 1
}

verify_credential() {
  [[ -f "$CREDENTIAL_FILE" ]] || return 1
  grep -q '^VELA_WEBSITE_KEY=' "$CREDENTIAL_FILE" || return 1
  grep -q '^VELA_API_BASE=' "$CREDENTIAL_FILE" || return 1
}

main() {
  local token="${WEBSITE_KEY:-}"
  local api_base="${API_BASE:-}"

  [[ -n "$token" ]] || fail "WEBSITE_KEY environment variable is required"
  [[ -n "$api_base" ]] || fail "API_BASE environment variable is required"

  validate_token "$token" || fail "invalid token format (expected vik_<key_id>_<secret>)"

  local unit="$HERMES_GATEWAY_UNIT"
  if [[ -z "$unit" ]]; then
    local discover_rc=0
    local discover_out
    discover_out="$(discover_gateway_unit 2>/dev/null)" || discover_rc=$?
    case "$discover_rc" in
      0)
        unit="$discover_out"
        ;;
      2)
        fail "multiple gateway units found; set HERMES_GATEWAY_UNIT to pick one"
        ;;
      *)
        fail "no gateway unit found"
        ;;
    esac
  fi

  local user_home
  user_home="$(get_user_home "$RUNTIME_USER")"
  [[ -n "$user_home" ]] || fail "cannot resolve home directory for $RUNTIME_USER"

  local dropin_dir="${user_home}/.config/systemd/user/${unit}.d"
  local dropin_file="${dropin_dir}/vela-website-credential.conf"
  local backup_dir
  backup_dir="$(mktemp -d "${TMPDIR:-/tmp}/website-credential-backup.XXXXXX")"
  local had_credential=false
  local had_dropin=false
  if [[ -f "$CREDENTIAL_FILE" ]]; then
    cp -p "$CREDENTIAL_FILE" "${backup_dir}/credential.env"
    had_credential=true
  fi
  if [[ -f "$dropin_file" ]]; then
    cp -p "$dropin_file" "${backup_dir}/dropin.conf"
    had_dropin=true
  fi

  local apply_ok=true
  write_credential_file "$token" "$api_base" || apply_ok=false
  if [[ "$apply_ok" == "true" ]]; then
    add_dropin "$unit" || apply_ok=false
  fi
  if [[ "$apply_ok" == "true" ]]; then
    restart_service "$unit" || apply_ok=false
  fi

  if [[ "$apply_ok" != "true" ]]; then
    if [[ "$had_credential" == "true" ]]; then
      local restore_tmp
      restore_tmp="$(mktemp "${CREDENTIAL_DIR}/.website-credential.rollback.XXXXXX")"
      cp -p "${backup_dir}/credential.env" "$restore_tmp"
      mv -f "$restore_tmp" "$CREDENTIAL_FILE"
    else
      rm -f "$CREDENTIAL_FILE"
    fi
    if [[ "$had_dropin" == "true" ]]; then
      mkdir -p "$dropin_dir"
      cp -p "${backup_dir}/dropin.conf" "$dropin_file"
    else
      rm -f "$dropin_file"
    fi
    run_systemctl_user daemon-reload >/dev/null 2>&1 || true
    run_systemctl_user restart "$unit" >/dev/null 2>&1 || true
    rm -rf "$backup_dir"
    fail "credential installation failed; previous configuration restored"
  fi

  rm -rf "$backup_dir"
  log "service restarted and active: $unit"

  verify_credential || fail "credential verification failed"

  echo "OK: website credential installed"
  # Never print the token value
}

# Run main only when executed directly (not sourced for testing)
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
