#!/usr/bin/env bash
# Prepare a native Linux x64 runner for the pinned Chromium sysroot and Xvfb probes.
set -euo pipefail

usage() {
  echo "Usage: $0 [--check|--install]"
  echo "Checks by default. --install adds missing system packages on Debian or Ubuntu."
}
mode=${1:---check}
case "$mode" in
  --help|-h) usage; exit 0 ;;
  --check|--install) ;;
  *) usage >&2; exit 2 ;;
esac
if (( $# > 1 )); then usage >&2; exit 2; fi
if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
  echo "This build requires Linux x64." >&2
  exit 1
fi
. /etc/os-release
echo "Electron runner: ${PRETTY_NAME:-$ID} ($(nproc) CPUs)"
case "$ID" in
  ubuntu|debian) ;;
  *) echo "Unsupported package manager for $ID. Use a Debian or Ubuntu build environment." >&2; exit 1 ;;
esac

# GN, Ninja, Clang and the target sysroot are pinned by gclient.
packages=(
  build-essential ca-certificates curl git file pkg-config python3
  bison flex gperf libtool autoconf automake cmake perl rsync unzip zip xz-utils
  libasound2-dev libcups2-dev libdbus-1-dev libdrm-dev libgbm-dev libgtk-3-dev
  libnss3-dev libx11-xcb-dev libxkbcommon-dev libxshmfence-dev
  desktop-file-utils fakeroot squashfs-tools fonts-liberation xauth xvfb
)
missing=()
check_packages() {
  missing=()
  for package in "${packages[@]}"; do
    if [[ $(dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null || true) != installed ]]; then
      missing+=("$package")
    fi
  done
}

check_packages
if (( ${#missing[@]} )); then
  echo "Missing packages: ${missing[*]}" >&2
  if [[ $mode == --check ]]; then exit 1; fi
  elevate=()
  if (( EUID != 0 )); then
    if ! sudo -n true 2>/dev/null; then
      echo "Install the listed packages as root, or run --install with noninteractive sudo." >&2
      exit 1
    fi
    elevate=(sudo -n)
  fi
  # apt drops privileges to _apt for signature checks. Some runners have a
  # private /tmp. Give apt a sticky scratch directory shared only for this run.
  apt_tmp=$("${elevate[@]}" mktemp -d /var/tmp/opencraft-apt.XXXXXXXX)
  trap '"${elevate[@]}" rm -rf -- "$apt_tmp"' EXIT
  "${elevate[@]}" chmod 1777 "$apt_tmp"
  apt=("${elevate[@]}" env "TMPDIR=$apt_tmp" DEBIAN_FRONTEND=noninteractive apt-get)
  "${apt[@]}" -o APT::Update::Error-Mode=any update
  "${apt[@]}" \
    -o DPkg::Lock::Timeout=120 install -y --no-install-recommends "${missing[@]}"
  check_packages
  if (( ${#missing[@]} )); then echo "Still missing: ${missing[*]}" >&2; exit 1; fi
fi
pkg-config --exists gtk+-3.0 nss gbm alsa
xvfb-run -a sh -c 'test -n "$DISPLAY"'
echo "Linux Electron build dependencies and Xvfb are ready."
