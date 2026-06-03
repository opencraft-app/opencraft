#!/usr/bin/env bash
set -euo pipefail

user="${LIGHTCLAW_RUNTIME_USER:-agentuser}"
home="$(getent passwd "$user" | cut -d: -f6 || true)"
[ -n "$home" ] || { echo "skip: user not found: $user" >&2; exit 0; }
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || pwd)"
blueprint_id_file="${HERMES_BACKEND_BLUEPRINT_ID_FILE:-$script_dir/../hermes-backend-blueprint-id}"
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
  [ -r "$blueprint_id_file" ] || { echo "missing Hermes backend blueprint id file: $blueprint_id_file" >&2; exit 1; }
  blueprint_id="$(tr -d '[:space:]' < "$blueprint_id_file")"
fi
[[ "$blueprint_id" =~ ^lhbp-[A-Za-z0-9_-]+$ ]] || { echo "invalid Hermes backend blueprint id: ${blueprint_id:-<empty>}" >&2; exit 1; }

printf -v blueprint_id_escaped '%q' "$blueprint_id"
upgrade_cmd="acli backend upgrade-start --blueprint-id ${blueprint_id_escaped} --wait=true"
if [ "$(id -un)" = "$user" ]; then
  bash -lc "$upgrade_cmd"
else
  sudo -u "$user" -H bash -lc "$upgrade_cmd"
fi
echo "upgraded Hermes backend blueprint for $user: $blueprint_id"
