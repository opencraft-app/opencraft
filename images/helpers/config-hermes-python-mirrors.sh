#!/usr/bin/env bash
set -euo pipefail

user="${LIGHTCLAW_RUNTIME_USER:-agentuser}"
home="$(getent passwd "$user" | cut -d: -f6 || true)"
[ -n "$home" ] || { echo "skip: user not found: $user" >&2; exit 0; }
config_dir="$home/.config"
mkdir -p "$config_dir/pip" "$config_dir/uv" "$config_dir/systemd/user"
printf '[global]\nindex-url = https://mirrors.tencent.com/pypi/simple\nextra-index-url =\n    https://mirrors.cloud.tencent.com/pypi/simple\ntimeout = 300\ndisable-pip-version-check = true\n' >"$home/.config/pip/pip.conf"
printf 'index-url = "https://mirrors.tencent.com/pypi/simple"\nextra-index-url = ["https://mirrors.cloud.tencent.com/pypi/simple"]\n' >"$home/.config/uv/uv.toml"
chown "$user:$user" "$config_dir" "$config_dir/systemd" "$config_dir/systemd/user" 2>/dev/null || true
chmod 0700 "$config_dir" "$config_dir/systemd" "$config_dir/systemd/user" 2>/dev/null || true
chown -R "$user:$user" "$config_dir/pip" "$config_dir/uv" 2>/dev/null || true
echo "configured Python mirrors for $user at $home"
