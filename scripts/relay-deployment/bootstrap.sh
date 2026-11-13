#!/usr/bin/env bash
# Operator-run bootstrap for a dedicated Ubuntu relay. No registration/Agent runtime.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run as the server operator through sudo.' >&2; exit 1; }
endpoint="${1:?HTTPS hostname or public IPv4}"
deploy_key="${2:?Dedicated deploy public key file}"
source_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
python3 - "$endpoint" <<'PY'
import ipaddress,re,sys
value=sys.argv[1]
try:ipaddress.IPv4Address(value)
except ValueError:
 if not re.fullmatch(r'[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?',value):raise SystemExit('Invalid TLS endpoint')
PY
[[ $(cat "$deploy_key") =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ .*)?$ ]] || exit 1
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl xz-utils openssl python3 sudo
if [[ ! -x /opt/opencraft-node/bin/node ]]; then
  node_version=26.7.0
  node_archive="node-v${node_version}-linux-x64.tar.xz"
  node_temp="$(mktemp -d)"
  trap 'rm -rf "$node_temp"' EXIT
  curl --fail --silent --show-error --location "https://nodejs.org/dist/v${node_version}/${node_archive}" -o "$node_temp/$node_archive"
  curl --fail --silent --show-error --location "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt" -o "$node_temp/checksums"
  (cd "$node_temp"; awk -v name="$node_archive" '$2==name' checksums | sha256sum -c - >/dev/null)
  mkdir -p /opt/opencraft-node
  tar -xJf "$node_temp/$node_archive" --strip-components=1 -C /opt/opencraft-node
  rm -rf "$node_temp"; trap - EXIT
fi
getent passwd opencraft-relay >/dev/null || useradd --system --home-dir /var/lib/opencraft-relay --shell /usr/sbin/nologin opencraft-relay
getent passwd opencraft-deploy >/dev/null || useradd --create-home --shell /bin/bash opencraft-deploy
install -d -m 0755 /opt/opencraft-relay /opt/opencraft-relay/releases /usr/local/libexec
install -d -m 0700 /opt/opencraft-relay/incoming
install -d -m 0750 -o opencraft-relay -g opencraft-relay /var/lib/opencraft-relay /etc/opencraft-relay
install -m 0755 "$source_dir/receive.py" /usr/local/libexec/opencraft-relay-activate
install -m 0755 "$source_dir/ssh-receive.sh" /usr/local/libexec/opencraft-relay-ssh
install -d -m 0700 -o opencraft-deploy -g opencraft-deploy /home/opencraft-deploy/.ssh
printf 'restrict,command="/usr/local/libexec/opencraft-relay-ssh" %s\n' "$(cat "$deploy_key")" > /home/opencraft-deploy/.ssh/authorized_keys
chmod 0600 /home/opencraft-deploy/.ssh/authorized_keys
chown opencraft-deploy:opencraft-deploy /home/opencraft-deploy/.ssh/authorized_keys
printf '%s\n' 'opencraft-deploy ALL=(root) NOPASSWD: /usr/local/libexec/opencraft-relay-activate' > /etc/sudoers.d/opencraft-relay-deploy
chmod 0440 /etc/sudoers.d/opencraft-relay-deploy
visudo -cf /etc/sudoers.d/opencraft-relay-deploy >/dev/null
if [[ ! -f /etc/opencraft-relay/server.pem ]]; then
  umask 077
  openssl req -x509 -newkey rsa:3072 -nodes -days 3650 -subj '/CN=OpenCraft Relay private CA' \
    -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' \
    -keyout /etc/opencraft-relay/ca-key.pem -out /etc/opencraft-relay/ca.pem 2>/dev/null
  openssl req -new -newkey rsa:3072 -nodes -subj "/CN=$endpoint" \
    -keyout /etc/opencraft-relay/server-key.pem -out /etc/opencraft-relay/server.csr 2>/dev/null
  if [[ "$endpoint" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then san="IP:$endpoint"; else san="DNS:$endpoint"; fi
  printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:FALSE\n' "$san" > /etc/opencraft-relay/server.ext
  openssl x509 -req -in /etc/opencraft-relay/server.csr -CA /etc/opencraft-relay/ca.pem \
    -CAkey /etc/opencraft-relay/ca-key.pem -CAcreateserial -days 365 \
    -extfile /etc/opencraft-relay/server.ext -out /etc/opencraft-relay/server.pem 2>/dev/null
fi
chown opencraft-relay:opencraft-relay /etc/opencraft-relay/server-key.pem /etc/opencraft-relay/server.pem /etc/opencraft-relay/ca.pem
chmod 0600 /etc/opencraft-relay/server-key.pem /etc/opencraft-relay/server.pem /etc/opencraft-relay/ca.pem
printf 'https://%s\n' "$endpoint" > /etc/opencraft-relay/endpoint
chmod 0600 /etc/opencraft-relay/endpoint
python3 - <<'PY'
from pathlib import Path
import json,secrets,pwd,os
root=Path('/etc/opencraft-relay');identity=pwd.getpwnam('opencraft-relay')
operator=root/'operator.json'
if not operator.exists():
 operator.write_text(json.dumps({'credential':secrets.token_urlsafe(32)}));operator.chmod(0o600);os.chown(operator,identity.pw_uid,identity.pw_gid)
config=root/'relay.json'
if not config.exists():
 config.write_text(json.dumps({'schemaVersion':1,'host':'127.0.0.1','port':18090,'routes':[], 'hubNetwork':{'stateFile':'/var/lib/opencraft-relay/hub-network.json','operatorCredentialFile':str(operator),'caFile':str(root/'ca.pem'),'tlsCertFile':str(root/'server.pem'),'tlsKeyFile':str(root/'server-key.pem'),'port':443}},indent=2))
 config.chmod(0o600);os.chown(config,identity.pw_uid,identity.pw_gid)
PY
cat > /etc/systemd/system/opencraft-relay.service <<'UNIT'
[Unit]
Description=OpenCraft authenticated transit Hub
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=opencraft-relay
Group=opencraft-relay
WorkingDirectory=/var/lib/opencraft-relay
ExecStart=/opt/opencraft-node/bin/node /opt/opencraft-relay/current/relay.mjs /etc/opencraft-relay/relay.json
Restart=on-failure
RestartSec=3
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ReadWritePaths=/var/lib/opencraft-relay
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
RestrictSUIDSGID=true
[Install]
WantedBy=multi-user.target
UNIT
# The receiver starts the service only after the first verified artifact arrives.
systemctl daemon-reload
systemctl enable opencraft-relay.service >/dev/null
printf '%s\n' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' > /etc/ssh/sshd_config.d/20-opencraft-relay.conf
sshd -t
systemctl reload ssh.service
printf '%s\n' 'Relay bootstrap complete. Awaiting an identified release.'
