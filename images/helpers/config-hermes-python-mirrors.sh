#!/usr/bin/env bash
set -euo pipefail

user="${LIGHTCLAW_RUNTIME_USER:-agentuser}"
home="$(getent passwd "$user" | cut -d: -f6 || true)"
[ -n "$home" ] || { echo "skip: user not found: $user" >&2; exit 0; }
mkdir -p "$home/.config/pip" "$home/.config/uv"
printf '[global]\nindex-url = https://mirrors.tencent.com/pypi/simple\nextra-index-url =\n    https://mirrors.cloud.tencent.com/pypi/simple\ntimeout = 300\ndisable-pip-version-check = true\n' >"$home/.config/pip/pip.conf"
printf 'index-url = "https://mirrors.tencent.com/pypi/simple"\nextra-index-url = ["https://mirrors.cloud.tencent.com/pypi/simple"]\n' >"$home/.config/uv/uv.toml"
chown -R "$user:$user" "$home/.config/pip" "$home/.config/uv" 2>/dev/null || true
echo "configured Python mirrors for $user at $home"
