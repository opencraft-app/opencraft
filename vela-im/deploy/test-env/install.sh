#!/usr/bin/env bash
# Installs the single-host test environment: identity service + Hermes gateway (systemd) + static web proxy (docker).
# Prerequisites: bootstrap.sh done, Hermes default profile has a working model, IM secret at $ROOT/secrets/im-secret.env,
# `npm ci && npm run build` in vela-im/, and the frontend export copied to $ROOT/web.
set -euo pipefail
ROOT=${VELA_TEST_ROOT:-$HOME/vela-test}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
H=$ROOT/hermes-home
PORT=${VELA_PORT:-18787}
ORIGIN=${VELA_PUBLIC_ORIGIN:?set VELA_PUBLIC_ORIGIN, e.g. https://yuehuali.devcloud.woa.com}
USER_NAME=$(id -un)
mkdir -p "$ROOT/data" "$ROOT/web" "$ROOT/proxy"
test -s "$ROOT/secrets/im-secret.env" || { echo "missing $ROOT/secrets/im-secret.env (VELA_IM_SECRET_KEY=...)" >&2; exit 1; }
test -f "$REPO/hermes-plugin/vela_im/_worker/vela-im-worker.mjs" || { echo "run npm run build in $REPO first" >&2; exit 1; }

umask 077
cat > "$ROOT/server.env" <<EOF
VELA_IM_SECRET_FILE=$ROOT/secrets/im-secret.env
VELA_SDK_APP_ID=${VELA_SDK_APP_ID:-1600166071}
VELA_DATA_DIR=$ROOT/data
VELA_HOST=127.0.0.1
VELA_PORT=$PORT
VELA_ALLOWED_ORIGINS=$ORIGIN
VELA_LIGHTVELA_API_CN=https://api.lightvela.com
VELA_AGENT_HOST=local
VELA_HERMES_BIN=$H/hermes-agent/venv/bin/hermes
VELA_HERMES_HOME=$H
VELA_PLUGIN_DIR=$REPO/hermes-plugin
VELA_AGENT_API_URL=http://127.0.0.1:$PORT
VELA_NODE_BIN=$ROOT/node-bin/node
VELA_HERMES_RESTART_COMMAND="sudo -n /usr/bin/systemctl restart vela-hermes-gateway.service"
EOF
umask 022

sudo tee /etc/systemd/system/vela-im.service >/dev/null <<EOF
[Unit]
Description=Vela IM identity service (test env)
After=network-online.target
[Service]
User=$USER_NAME
WorkingDirectory=$REPO/server
EnvironmentFile=$ROOT/server.env
Environment=PATH=$ROOT/node-bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$ROOT/node-bin/node dist/main.js
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/vela-hermes-gateway.service >/dev/null <<EOF
[Unit]
Description=Hermes gateway for Vela IM Agents (test env)
After=network-online.target vela-im.service
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
sudo systemctl enable --now vela-im.service vela-hermes-gateway.service
sudo systemctl restart vela-im.service

cp "$REPO/deploy/test-env/nginx.conf" "$ROOT/proxy/nginx.conf"
docker rm -f vela-web-proxy >/dev/null 2>&1 || true
docker run -d --name vela-web-proxy --network host --restart unless-stopped \
  -v "$ROOT/proxy/nginx.conf:/etc/nginx/nginx.conf:ro" -v "$ROOT/web:/srv/vela-web:ro" nginx:1.28-alpine >/dev/null
sleep 2
curl -fsS "http://127.0.0.1:$PORT/health"; echo
curl -fsS -o /dev/null -w "web proxy %{http_code}\n" http://127.0.0.1:13090/
echo "Point the domain's reverse proxy at http://127.0.0.1:13090 (see README)."
