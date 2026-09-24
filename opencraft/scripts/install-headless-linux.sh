#!/usr/bin/env bash
set -euo pipefail

# Installs the separate Linux server tar. WebUI, /appserver and /apphost all use
# one directly bound port; there is no Nginx or other application proxy.

usage() {
  cat <<'USAGE'
Usage: install-headless-linux.sh --archive FILE --sha256 HEX \
  --allow-unauthenticated-public [--port 80] [--state-name opencraft-server]

Install a verified headless Linux amd64 tar as a reboot-persistent systemd
service listening directly on 0.0.0.0:80. The static WebUI and both
WebSocket paths share that port. No TLS or access control is configured.

DANGER: Everyone who can reach the port can use the server's Codex accounts
and Host file/terminal capabilities. The explicit flag is an acknowledgement,
not a security control.

--render-dir DIR renders only the unit without root or server changes.
The installer refuses occupied ports and existing unit/current-release targets.
It never stops an existing preview or migrates its state automatically.
USAGE
}

die() { printf 'OpenCraft installer: %s\n' "$*" >&2; exit 1; }

archive=''
expected_sha=''
port=80
state_name=opencraft-server
render_dir=''
allow_public=0

while (($#)); do
  case "$1" in
    --archive|--sha256|--port|--state-name|--render-dir)
      (($# >= 2)) || die "$1 requires a value"
      case "$1" in
        --archive) archive=$2 ;;
        --sha256) expected_sha=$2 ;;
        --port) port=$2 ;;
        --state-name) state_name=$2 ;;
        --render-dir) render_dir=$2 ;;
      esac
      shift 2
      ;;
    --allow-unauthenticated-public) allow_public=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ $port =~ ^[0-9]{1,5}$ ]] || die 'invalid --port'
port=$((10#$port))
((port >= 1 && port <= 65535)) || die 'invalid --port'
[[ $state_name =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ ]] || die 'invalid --state-name'
((allow_public == 1)) || die 'public access requires --allow-unauthenticated-public'

install_root=/opt/opencraft-server
unit_path=/etc/systemd/system/opencraft-server.service

render_unit() {
  local bind_capability=''
  if ((port < 1024)); then
    bind_capability=$'AmbientCapabilities=CAP_NET_BIND_SERVICE\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE'
  fi
  cat <<EOF
[Unit]
Description=OpenCraft headless WebUI
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
DynamicUser=yes
StateDirectory=$state_name
StateDirectoryMode=0700
WorkingDirectory=$install_root/current
Environment=HOME=/var/lib/$state_name
ExecStart=$install_root/current/bin/opencraft-server --host 0.0.0.0 --port $port --data-dir /var/lib/$state_name --allow-unauthenticated-public
Restart=on-failure
RestartSec=3s
UMask=0077
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
$bind_capability

[Install]
WantedBy=multi-user.target
EOF
}

if [[ -n $render_dir ]]; then
  [[ -d $render_dir && ! -L $render_dir ]] || die '--render-dir must be an existing directory, not a symlink'
  [[ ! -e $render_dir/opencraft-server.service && ! -L $render_dir/opencraft-server.service ]] \
    || die '--render-dir already contains installer output'
  render_unit > "$render_dir/opencraft-server.service"
  printf 'Rendered OpenCraft unit in %s\n' "$render_dir"
  exit 0
fi

[[ $(uname -s) == Linux ]] || die 'installation requires Linux'
((EUID == 0)) || die 'installation requires root; use sudo'
[[ -n $archive && -f $archive && ! -L $archive ]] || die '--archive must name a regular tar file'
[[ $expected_sha =~ ^[0-9a-fA-F]{64}$ ]] || die '--sha256 must contain 64 hex digits'
expected_sha=${expected_sha,,}

for executable in curl flock python3 sha256sum ss systemctl tar; do
  command -v "$executable" >/dev/null || die "$executable is required"
done
exec 9>/run/lock/opencraft-server-install.lock
flock -n 9 || die 'another OpenCraft installation is running'
[[ ! -e $unit_path && ! -L $unit_path ]] || die "unit already exists: $unit_path"
[[ ! -e $install_root/current && ! -L $install_root/current ]] || die 'OpenCraft current release already exists'
if ss -H -ltn | awk -v port="$port" '$4 ~ (":" port "$") { found=1 } END { exit !found }'; then
  die "port $port is already occupied"
fi
printf '%s  %s\n' "$expected_sha" "$archive" | sha256sum --check --status - \
  || die 'archive SHA-256 does not match'

python3 - "$archive" <<'PY' || die 'archive contains an invalid path or link'
import posixpath
import sys
import tarfile

seen = set()
with tarfile.open(sys.argv[1], "r:gz") as archive:
    for member in archive:
        name = member.name.rstrip("/")
        if name in seen or not (name == "opencraft-server" or name.startswith("opencraft-server/")):
            raise ValueError("Duplicate or escaping archive path")
        seen.add(name)
        if ".." in name.split("/") or member.mode & 0o6000:
            raise ValueError("Unsafe archive path or mode")
        if member.issym():
            if member.linkname.startswith("/"):
                raise ValueError("Absolute archive link")
            target = posixpath.normpath(posixpath.join(posixpath.dirname(name), member.linkname))
            if target != "opencraft-server" and not target.startswith("opencraft-server/"):
                raise ValueError("Escaping archive link")
        elif not (member.isfile() or member.isdir()):
            raise ValueError("Unsupported archive entry")
if "opencraft-server" not in seen:
    raise ValueError("Missing archive root")
PY

umask 022
install -d -m 0755 "$install_root" "$install_root/releases"
stage=$(mktemp -d "$install_root/.staging.XXXXXXXX")
unit_installed=0
current_installed=0

cleanup() {
  local result=$?
  trap - EXIT
  if ((result != 0)); then
    if ((unit_installed)); then
      systemctl disable --now opencraft-server.service >/dev/null 2>&1 || true
      rm -f -- "$unit_path"
      systemctl daemon-reload >/dev/null 2>&1 || true
    fi
    if ((current_installed)); then rm -f -- "$install_root/current"; fi
    printf 'Installation failed; release files and state data were retained for inspection.\n' >&2
  fi
  if [[ -n ${stage:-} && $stage == "$install_root/.staging."* && -d $stage ]]; then
    rm -rf -- "$stage"
  fi
  exit "$result"
}
trap cleanup EXIT

tar --no-same-owner --no-same-permissions -xzf "$archive" -C "$stage"
package=$stage/opencraft-server
[[ -f $package/manifest.json && -x $package/bin/node && -x $package/bin/opencraft-server ]] \
  || die 'archive is missing the server manifest or launcher'

python3 - "$package" <<'PY'
import hashlib
import json
import os
import stat
import sys

root = os.path.realpath(sys.argv[1])
with open(os.path.join(root, "manifest.json"), encoding="utf-8") as source:
    manifest = json.load(source)
if (manifest.get("schemaVersion") != 1 or manifest.get("platform") != "linux" or
        manifest.get("architecture") != "amd64" or not isinstance(manifest.get("files"), list)):
    raise ValueError("Invalid headless server manifest")
for entry in manifest["files"]:
    name = entry.get("path")
    if not isinstance(name, str) or os.path.isabs(name):
        raise ValueError("Invalid manifest path")
    file = os.path.abspath(os.path.join(root, name))
    if os.path.commonpath((root, file)) != root or file == root:
        raise ValueError("Escaping manifest path")
    info = os.lstat(file)
    if "sha256" in entry:
        if not stat.S_ISREG(info.st_mode) or os.path.commonpath((root, os.path.realpath(file))) != root:
            raise ValueError("Invalid package file")
        digest = hashlib.sha256()
        with open(file, "rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != entry["sha256"]:
            raise ValueError("Package checksum mismatch: " + name)
    elif "link" in entry:
        if not stat.S_ISLNK(info.st_mode) or os.readlink(file) != entry["link"]:
            raise ValueError("Invalid package symlink")
        if os.path.commonpath((root, os.path.realpath(file))) != root:
            raise ValueError("Escaping package symlink")
    else:
        raise ValueError("Invalid manifest entry")
with open(os.path.join(root, "web/version.json"), encoding="utf-8") as source:
    version = json.load(source)
if manifest["buildId"] != version["buildId"]:
    raise ValueError("Web and server build IDs differ")
PY

"$package/bin/opencraft-server" --help | grep -F -- '--host' >/dev/null \
  || die 'archive does not support direct public binding; rebuild the headless tar'

release=$install_root/releases/${expected_sha:0:16}
[[ ! -e $release && ! -L $release ]] || die "release already exists: $release"
render_unit > "$stage/opencraft-server.service"
mv -- "$package" "$release"
ln -s "$release" "$install_root/.current.${expected_sha:0:16}"
mv -T -- "$install_root/.current.${expected_sha:0:16}" "$install_root/current"
current_installed=1
install -m 0644 "$stage/opencraft-server.service" "$unit_path"
unit_installed=1
systemctl daemon-reload
systemctl enable --now opencraft-server.service

healthy=0
for _ in {1..30}; do
  if curl --fail --silent --max-time 2 "http://127.0.0.1:$port/__opencraft_health" | grep -q '"ok":true'; then
    healthy=1
    break
  fi
  sleep 1
done
((healthy == 1)) || die 'OpenCraft health check failed'
ss -H -ltn | awk -v port="$port" '$4 == "0.0.0.0:" port { found=1 } END { exit !found }' \
  || die 'OpenCraft did not bind 0.0.0.0'

printf 'OpenCraft service: opencraft-server.service (enabled)\n'
printf 'WebUI and WebSockets: http://SERVER_IP:%s (NO TLS OR ACCESS CONTROL)\n' "$port"
printf 'Persistent state: /var/lib/%s\n' "$state_name"
