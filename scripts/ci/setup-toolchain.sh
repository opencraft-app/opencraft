#!/usr/bin/env bash
# One Linux toolchain for GitHub runners and Claude Code cloud sessions.
#
#   setup-toolchain.sh system   apt packages the tests need (acl, openssh-client)
#   setup-toolchain.sh node     Node from .nvmrc; prints the bin directory to use
#   setup-toolchain.sh deps     npm ci, skipped while the manifests are unchanged
#   setup-toolchain.sh all      all three, in that order
#
# CI keeps actions/setup-node (it caches) and calls `system`. Cloud sessions
# call `all` from .claude/hooks/session-start.sh. Versions live in .nvmrc and in
# SYSTEM_PACKAGES below, nowhere else.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SYSTEM_PACKAGES=(acl openssh-client)
SYSTEM_COMMANDS=(setfacl ssh-keygen)

log() { echo "setup-toolchain: $*" >&2; }

as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

ensure_system() {
  local missing=0 command
  for command in "${SYSTEM_COMMANDS[@]}"; do command -v "$command" >/dev/null || missing=1; done
  [ "$missing" -eq 0 ] && return 0
  # apt verifies signatures as the unprivileged _apt user, which needs a
  # world-writable /tmp. Cloud session VMs ship /tmp as 0700, so keep apt as root there.
  local apt=(apt-get -qq)
  [ "$(stat -c %a /tmp)" = 1777 ] || apt+=(-o APT::Sandbox::User=root)
  log "installing ${SYSTEM_PACKAGES[*]}"
  as_root "${apt[@]}" update
  as_root env DEBIAN_FRONTEND=noninteractive "${apt[@]}" install -y --no-install-recommends "${SYSTEM_PACKAGES[@]}" >/dev/null
}

# Prints the directory holding the wanted node binary.
ensure_node() {
  local version current arch dir
  version="$(tr -d '[:space:]v' < "$root/.nvmrc")"
  current="$(node -v 2>/dev/null || true)"
  if [ "$current" = "v$version" ]; then dirname "$(command -v node)"; return 0; fi
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) log "unsupported architecture $(uname -m)"; return 1 ;;
  esac
  dir="${OPENCRAFT_TOOLCHAIN_DIR:-$HOME/.cache/opencraft-toolchain}/node-v$version-linux-$arch"
  if [ ! -x "$dir/bin/node" ]; then
    log "installing Node v$version (found ${current:-none})"
    mkdir -p "$dir.partial"
    curl -fsSL "https://nodejs.org/dist/v$version/node-v$version-linux-$arch.tar.xz" \
      | tar -xJ -C "$dir.partial" --strip-components=1
    rm -rf "$dir" && mv "$dir.partial" "$dir"
  fi
  echo "$dir/bin"
}

# Everything npm ci reads that can change what it installs.
manifests() {
  cd "$root"
  { echo .nvmrc; echo .npmrc; echo package-lock.json; echo scripts/ci/setup-toolchain.sh
    git ls-files -- package.json 'apps/*/package.json' 'packages/*/package.json' 'plugins/*/package.json'
  } | sort -u
}

ensure_deps() {
  local stamp="$root/node_modules/.setup-toolchain.sha256" current
  current="$(manifests | (cd "$root" && xargs sha256sum); node -v)"
  if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$current" ]; then return 0; fi
  rm -f "$stamp"
  log "running npm ci"
  (cd "$root" && npm ci --no-audit --no-fund --loglevel=error >&2)
  printf '%s' "$current" > "$stamp"
}

case "${1:-}" in
  system) ensure_system ;;
  node) ensure_node ;;
  deps) ensure_deps ;;
  all)
    ensure_system
    bin="$(ensure_node)"
    export PATH="$bin:$PATH"
    ensure_deps
    echo "$bin"
    ;;
  *) echo "usage: $0 system|node|deps|all" >&2; exit 2 ;;
esac
