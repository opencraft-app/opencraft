#!/bin/sh
# First installation of the managed IM client. Credentials and runtime startup
# remain owned by the existing Bot/Collaboration control plane.
set -eu
umask 077
binary_url= checksum= version=
install_root=${VELA_IM_INSTALL_ROOT:-"$HOME/.local/share/lightvela/im-client"}
bin_dir=${VELA_IM_BIN_DIR:-"$HOME/.local/bin"}
fail() { echo "IM client install: $*" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || fail "missing argument value"
  case "$1" in
    --binary-url) binary_url=$2;;
    --sha256) checksum=$2;;
    --version) version=$2;;
    *) fail "unknown argument";;
  esac
  shift 2
done
case "$binary_url" in https://*) ;; *) fail "HTTPS binary URL required";; esac
printf '%s\n' "$checksum" | grep -Eq '^[0-9a-f]{64}$' || fail "invalid checksum"
printf '%s\n' "$version" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9]+)*$' || fail "invalid version"
[ "$(uname -s)-$(uname -m)" = Linux-x86_64 ] || fail "Linux AMD64 required"
case "$install_root:$bin_dir" in /*:/*) ;; *) fail "absolute installation paths required";; esac
for tool in curl sha256sum flock; do command -v "$tool" >/dev/null 2>&1 || fail "missing $tool"; done
mkdir -p "$install_root" "$bin_dir"
exec 9>"$install_root/install.lock"
flock -w 120 9 || fail "another installation is still running"
destination="$install_root/vela-computer"
link="$bin_dir/vela-computer"
if [ -e "$link" ] || [ -L "$link" ]; then
  [ -L "$link" ] && [ "$(readlink "$link")" = "$destination" ] || fail "existing vela-computer entry preserved"
fi
verify() {
  [ -f "$1" ] && [ ! -L "$1" ] || return 1
  printf '%s  %s\n' "$checksum" "$1" | sha256sum -c - >/dev/null 2>&1 || return 1
  [ "$("$1" version --json)" = "{\"mode\":\"vela\",\"name\":\"vela-computer\",\"version\":\"$version\"}" ]
}
if [ -e "$destination" ] || [ -L "$destination" ]; then
  verify "$destination" || fail "existing client differs; first installation does not upgrade it"
else
  stage=$(mktemp -d "$install_root/.install.XXXXXX")
  trap 'rm -rf "$stage"' EXIT HUP INT TERM
  echo 'VELA_IM_INSTALL_PROGRESS 20 downloading'
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 15 --max-time 180 --retry 2 --output "$stage/vela-computer" "$binary_url"
  printf '%s  %s\n' "$checksum" "$stage/vela-computer" | sha256sum -c - >/dev/null || fail "checksum mismatch"
  chmod 0755 "$stage/vela-computer"
  verify "$stage/vela-computer" || fail "binary version mismatch"
  echo 'VELA_IM_INSTALL_PROGRESS 80 installing'
  mv "$stage/vela-computer" "$destination"
fi
[ -L "$link" ] || ln -s "$destination" "$link"
echo "VELA_IM_CLIENT_INSTALLED $version"
