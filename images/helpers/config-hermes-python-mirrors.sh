#!/usr/bin/env bash
set -euo pipefail

user="${LIGHTCLAW_RUNTIME_USER:-agentuser}"
home="$(getent passwd "$user" | cut -d: -f6 || true)"
[ -n "$home" ] || { echo "skip: user not found: $user" >&2; exit 0; }
acli_install_url="${HERMES_ACLI_INSTALL_URL:-${ACLI_INSTALL_URL:-https://acli-1325194254.cos.accelerate.myqcloud.com/acli/install.sh}}"

run_as_target_user() {
  local command="$1"
  if [ "$(id -un)" = "$user" ]; then
    HOME="$home" bash -lc "$command"
  else
    sudo -u "$user" -H bash -lc "$command"
  fi
}

acli_supports_backend() {
  run_as_target_user 'command -v acli >/dev/null 2>&1 && acli backend --help >/dev/null 2>&1'
}

ensure_acli_backend() {
  local tmp_install=""
  if acli_supports_backend; then
    return 0
  fi

  echo "acli backend command unavailable for $user; attempting acli bundle-update"
  run_as_target_user 'command -v acli >/dev/null 2>&1 && acli bundle-update >/dev/null 2>&1' || true
  if acli_supports_backend; then
    echo "ensured acli backend command for $user via bundle-update"
    return 0
  fi

  command -v curl >/dev/null 2>&1 || { echo "missing curl; cannot install acli with backend command" >&2; exit 1; }
  tmp_install="$(mktemp "${TMPDIR:-/tmp}/acli-install.XXXXXX")"
  curl -fsSL "$acli_install_url" -o "$tmp_install"
  ACLI_PRODUCT=lightvela ACLI_RUN_AS="$user" bash "$tmp_install"
  rm -f "$tmp_install"

  if ! acli_supports_backend; then
    echo "acli backend command is still unavailable after install: $acli_install_url" >&2
    run_as_target_user 'acli --help' >&2 || true
    exit 1
  fi
  echo "ensured acli backend command for $user via installer"
}

config_dir="$home/.config"
mkdir -p "$config_dir/pip" "$config_dir/uv" "$config_dir/systemd/user"
printf '[global]\nindex-url = https://mirrors.tencent.com/pypi/simple\nextra-index-url =\n    https://mirrors.cloud.tencent.com/pypi/simple\ntimeout = 300\ndisable-pip-version-check = true\n' >"$home/.config/pip/pip.conf"
printf 'index-url = "https://mirrors.tencent.com/pypi/simple"\nextra-index-url = ["https://mirrors.cloud.tencent.com/pypi/simple"]\n' >"$home/.config/uv/uv.toml"
chown "$user:$user" "$config_dir" "$config_dir/systemd" "$config_dir/systemd/user" 2>/dev/null || true
chmod 0700 "$config_dir" "$config_dir/systemd" "$config_dir/systemd/user" 2>/dev/null || true
chown -R "$user:$user" "$config_dir/pip" "$config_dir/uv" 2>/dev/null || true
echo "configured Python mirrors for $user at $home"

blueprint_id="${HERMES_BACKEND_BLUEPRINT_ID:-}"
if [ -z "$blueprint_id" ]; then
  echo "missing HERMES_BACKEND_BLUEPRINT_ID; resolve it before invoking this repair script" >&2
  exit 1
fi
[[ "$blueprint_id" =~ ^lhbp-[A-Za-z0-9_-]+$ ]] || { echo "invalid Hermes backend blueprint id: ${blueprint_id:-<empty>}" >&2; exit 1; }

printf -v blueprint_id_escaped '%q' "$blueprint_id"
upgrade_cmd="acli backend upgrade-start --blueprint-id ${blueprint_id_escaped} --wait=true --force=true"
ensure_acli_backend
run_as_target_user "$upgrade_cmd"
echo "upgraded Hermes backend blueprint for $user: $blueprint_id"
