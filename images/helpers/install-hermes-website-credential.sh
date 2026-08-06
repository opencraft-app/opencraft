#!/usr/bin/env bash
# install-hermes-website-credential.sh
#
# Runs on a target Hermes CVM via Tencent Cloud TAT as root.
# Receives WEBSITE_KEY and API_BASE from environment variables
# (set by TAT parameter substitution from {{tat-hidden:website_key}} and {{api_base}}).
#
# Actions:
#   1. Validate the token format (vwk_<key_id>_<secret>)
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

# Command prefix for running systemctl --user as the runtime user.
# In tests this can be overridden to just "systemctl --user".
SYSTEMCTL_USER_CMD="${SYSTEMCTL_USER_CMD:-runuser -u ${RUNTIME_USER} -- systemctl --user}"

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
  # Format: vwk_<key_id>_<secret>
  # key_id and secret are base64url (no padding): [A-Za-z0-9_-]
  [[ "$token" =~ ^vwk_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$ ]] || return 1
  # Extract parts: strip vwk_ prefix, split on first _
  local rest="${token#vwk_}"
  local key_id="${rest%%_*}"
  local secret="${rest#*_}"
  # key_id = base64url(16 bytes) ≈ 22 chars, secret = base64url(32 bytes) ≈ 43 chars
  # Be lenient: require reasonable minimums
  [[ ${#key_id} -ge 16 ]] || return 1
  [[ ${#secret} -ge 32 ]] || return 1
  return 0
}

write_credential_file() {
  local token="$1"
  local api_base="$2"
  CREDENTIAL_DIR="$(dirname "$CREDENTIAL_FILE")"
  mkdir -p "$CREDENTIAL_DIR"
  local tmp_file
  tmp_file="$(mktemp "${CREDENTIAL_DIR}/.website-credential.XXXXXX")"
  printf 'VELA_WEBSITE_KEY=%s\n' "$token" >"$tmp_file"
  printf 'VELA_API_BASE=%s\n' "$api_base" >>"$tmp_file"
  chmod 0440 "$tmp_file"
  chown root:"$RUNTIME_USER" "$tmp_file" 2>/dev/null || {
    # In test environments where chown may fail, continue but warn
    log "WARN: chown failed, file permissions still set"
  }
  mv -f "$tmp_file" "$CREDENTIAL_FILE"
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
    listed="$($SYSTEMCTL_USER_CMD list-units --type=service --no-legend 2>/dev/null \
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
  mkdir -p "$dropin_dir"
  local dropin_file="${dropin_dir}/vela-website-credential.conf"
  printf '[Service]\nEnvironmentFile=%s\n' "$CREDENTIAL_FILE" >"$dropin_file"
  chown -R "$RUNTIME_USER":"$RUNTIME_USER" "$dropin_dir" 2>/dev/null || true
}

restart_service() {
  local unit="$1"
  $SYSTEMCTL_USER_CMD daemon-reload
  $SYSTEMCTL_USER_CMD restart "$unit"
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

  validate_token "$token" || fail "invalid token format (expected vwk_<key_id>_<secret>)"

  write_credential_file "$token" "$api_base"

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
        log "WARN: multiple gateway units found, set HERMES_GATEWAY_UNIT to pick one"
        ;;
      *)
        log "WARN: no gateway unit found; credential file written but service not restarted"
        ;;
    esac
  fi

  if [[ -n "$unit" ]]; then
    add_dropin "$unit"
    restart_service "$unit"
    log "service restarted: $unit"
  fi

  verify_credential || fail "credential verification failed"

  echo "OK: website credential installed"
  # Never print the token value
}

# Run main only when executed directly (not sourced for testing)
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
