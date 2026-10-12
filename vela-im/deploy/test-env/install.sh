#!/usr/bin/env bash
# Installs the single-host test environment: collaboration (SQLite) + dev gateway + Hermes gateway (systemd) and the
# static web proxy (docker). Prerequisites: bootstrap.sh done, Hermes default profile has a working model, IM secret at
# $ROOT/secrets/im-secret.env, `npm ci && npm run build` in vela-im/, and the frontend export copied to $ROOT/web.
set -euo pipefail
ROOT=${VELA_TEST_ROOT:-$HOME/vela-test}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
MONO=$(cd "$REPO/.." && pwd)
ENV_DIR=$REPO/deploy/test-env
H=$ROOT/hermes-home
S=$ROOT/secrets
COLLAB_PORT=${VELA_COLLAB_PORT:-18791}
GATEWAY_PORT=${VELA_GATEWAY_PORT:-18786}
SDK_APP_ID=${VELA_SDK_APP_ID:-1600166071}
USER_NAME=$(id -un)
RESTART_COMMAND="sudo -n /usr/bin/systemctl restart vela-hermes-gateway.service"
test -s "$S/im-secret.env" || { echo "missing $S/im-secret.env (VELA_IM_SECRET_KEY=...)" >&2; exit 1; }
test -f "$REPO/hermes-plugin/vela_im/_worker/vela-im-worker.mjs" || { echo "run npm run build in $REPO first" >&2; exit 1; }
mkdir -p "$ROOT/bin" "$ROOT/web" "$ROOT/proxy" "$ROOT/retired-profiles"

# Secrets: generated once and kept; the identity key derives every IM UserID, so it must never change.
umask 077
mkdir -p "$ROOT/collab-data"
sed -n 's/^VELA_IM_SECRET_KEY=//p' "$S/im-secret.env" | tr -d '\r\n' > "$S/im-secret-key"
for name in collab-jwt-key collab-identity-key collab-gateway-token; do
  test -s "$S/$name" || head -c 32 /dev/urandom | base64 -w0 > "$S/$name"
done
umask 022

(cd "$MONO/collaboration" && go build -o "$ROOT/bin/chatserver" ./cmd/chatserver)

# Profiles of the retired identity service carry its old plugin and token; park them out of the gateway.
for profile in "$H"/profiles/vela-*; do
  [ -d "$profile" ] || continue
  mv "$profile" "$ROOT/retired-profiles/$(basename "$profile")-$(date +%Y%m%d%H%M%S)"
  echo "retired old profile $(basename "$profile")"
done
if systemctl list-unit-files vela-im.service >/dev/null 2>&1; then
  sudo systemctl disable --now vela-im.service >/dev/null 2>&1 || true
fi

sudo tee /etc/systemd/system/vela-collaboration.service >/dev/null <<EOF
[Unit]
Description=LightVela collaboration with Vela IM bots and groups (test env)
After=network-online.target
[Service]
User=$USER_NAME
WorkingDirectory=$ROOT
Environment=PATH=$H/hermes-agent/venv/bin:$ROOT/node-bin:/usr/local/bin:/usr/bin:/bin
Environment=HERMES_HOME=$H
Environment=VELA_PLUGIN_DIR=$REPO/hermes-plugin
Environment="VELA_HERMES_RESTART_COMMAND=$RESTART_COMMAND"
Environment=VELA_DEV_ALLOWED_ACCOUNTS=${VELA_DEV_ALLOWED_ACCOUNTS:-}
ExecStart=$ROOT/bin/chatserver serve --collaboration-only \\
  --database $ROOT/collab-data/collaboration.sqlite \\
  --listen 127.0.0.1:$COLLAB_PORT \\
  --jwt-key-file $S/collab-jwt-key \\
  --lightvela-gateway-token-file $S/collab-gateway-token \\
  --im-sdk-app-id $SDK_APP_ID \\
  --im-admin-user-id administrator \\
  --im-secret-key-file $S/im-secret-key \\
  --im-identity-key-file $S/collab-identity-key \\
  --bot-host-command $ENV_DIR/bot-host.sh \\
  --bot-runtime-api-url http://127.0.0.1:$COLLAB_PORT/v1
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/vela-collab-gateway.service >/dev/null <<EOF
[Unit]
Description=Dev stand-in for service-gateway /v1/collaboration (test env)
After=network-online.target vela-collaboration.service
[Service]
User=$USER_NAME
Environment=GATEWAY_LISTEN=127.0.0.1:$GATEWAY_PORT
Environment=COLLABORATION_URL=http://127.0.0.1:$COLLAB_PORT
Environment=LIGHTVELA_AUTH_URL=${LIGHTVELA_AUTH_URL:-https://api.lightvela.com}
Environment=GATEWAY_TOKEN_FILE=$S/collab-gateway-token
ExecStart=$ROOT/node-bin/node $ENV_DIR/dev-gateway.mjs
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/vela-hermes-gateway.service >/dev/null <<EOF
[Unit]
Description=Hermes gateway for Vela IM Agents (test env)
After=network-online.target vela-collaboration.service
StartLimitIntervalSec=0
[Service]
User=$USER_NAME
Type=simple
WorkingDirectory=$H
ExecStart=$H/hermes-agent/venv/bin/python -m hermes_cli.main gateway run
Environment=PATH=$H/hermes-agent/venv/bin:$H/hermes-agent/node_modules/.bin:$ROOT/node-bin:/usr/local/bin:/usr/bin:/bin
Environment=VIRTUAL_ENV=$H/hermes-agent/venv
Environment=HERMES_HOME=$H
Environment=HERMES_SUPERVISED_CHILD=1
Environment=VELA_NODE_BIN=$ROOT/node-bin/node
Restart=always
RestartSec=5
RestartForceExitStatus=75
SuccessExitStatus=75
RestartPreventExitStatus=78
KillMode=mixed
KillSignal=SIGTERM
ExecStop=-$H/hermes-agent/venv/bin/python -m gateway.systemd_stop_mark
ExecStopPost=-$H/hermes-agent/venv/bin/python -m gateway.cgroup_cleanup
TimeoutStopSec=70
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable vela-collaboration.service vela-collab-gateway.service vela-hermes-gateway.service >/dev/null
sudo systemctl restart vela-collaboration.service vela-collab-gateway.service vela-hermes-gateway.service

cp "$ENV_DIR/nginx.conf" "$ROOT/proxy/nginx.conf"
docker rm -f vela-web-proxy >/dev/null 2>&1 || true
docker run -d --name vela-web-proxy --network host --restart unless-stopped \
  -v "$ROOT/proxy/nginx.conf:/etc/nginx/nginx.conf:ro" -v "$ROOT/web:/srv/vela-web:ro" nginx:1.28-alpine >/dev/null

for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$COLLAB_PORT/readyz" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS -o /dev/null -w "collaboration readyz %{http_code}\n" "http://127.0.0.1:$COLLAB_PORT/readyz"
curl -fsS -o /dev/null -w "dev gateway %{http_code}\n" "http://127.0.0.1:$GATEWAY_PORT/healthz"
curl -sS -o /dev/null -w "unauthenticated /v1/collaboration/me/bots via nginx %{http_code} (expect 401)\n" \
  http://127.0.0.1:13090/v1/collaboration/me/bots
curl -fsS -o /dev/null -w "web proxy %{http_code}\n" http://127.0.0.1:13090/
