#!/usr/bin/env bash
# Runs gateway-dashboard (the LightVela admin console) on the dev machine at /admin/gateway, for its 「IM 群聊」 page.
# There is no AI Gateway here: dev-admin-auth.mjs checks the admin login token instead, and only the IM page works.
# Prerequisites: install.sh done (collaboration with --admin-token-file).
set -euo pipefail
ROOT=${VELA_TEST_ROOT:-$HOME/vela-test}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
MONO=$(cd "$REPO/.." && pwd)
ENV_DIR=$REPO/deploy/test-env
S=$ROOT/secrets
DASHBOARD=$MONO/gateway-dashboard
COLLAB_PORT=${VELA_COLLAB_PORT:-18791}
USER_NAME=$(id -un)
export PATH=$ROOT/node-bin:$PATH
test -s "$S/collab-admin-token" || { echo "run install.sh first (missing $S/collab-admin-token)" >&2; exit 1; }

umask 077
test -s "$S/dashboard-admin-token" || head -c 24 /dev/urandom | base64 | tr -d '/+=' > "$S/dashboard-admin-token"
test -s "$S/dashboard-session-secret" || head -c 32 /dev/urandom | base64 -w0 > "$S/dashboard-session-secret"
cat > "$S/admin-dashboard.env" <<EOF
PORT=13000
HOSTNAME=127.0.0.1
GATEWAY_API_URL=http://127.0.0.1:18990
ADMIN_TOKEN=$(cat "$S/dashboard-admin-token")
ADMIN_SESSION_SECRET=$(cat "$S/dashboard-session-secret")
COLLABORATION_API_URL=http://127.0.0.1:$COLLAB_PORT
COLLABORATION_ADMIN_TOKEN=$(cat "$S/collab-admin-token")
EOF
umask 022

(cd "$DASHBOARD" && { test -d node_modules || npm install --no-audit --no-fund; } && npx next build)
# Same layout as the production image: the standalone server serves its static assets and public files.
rm -rf "$DASHBOARD/.next/standalone/.next/static" "$DASHBOARD/.next/standalone/public"
cp -r "$DASHBOARD/.next/static" "$DASHBOARD/.next/standalone/.next/static"
cp -r "$DASHBOARD/public" "$DASHBOARD/.next/standalone/public"

sudo tee /etc/systemd/system/vela-admin-auth.service >/dev/null <<EOF
[Unit]
Description=Dev stand-in for ai-gateway admin token check (test env)
After=network-online.target
[Service]
User=$USER_NAME
Environment=ADMIN_TOKEN_FILE=$S/dashboard-admin-token
ExecStart=$ROOT/node-bin/node $ENV_DIR/dev-admin-auth.mjs
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/vela-admin-dashboard.service >/dev/null <<EOF
[Unit]
Description=gateway-dashboard admin console (test env)
After=network-online.target vela-admin-auth.service vela-collaboration.service
[Service]
User=$USER_NAME
WorkingDirectory=$DASHBOARD/.next/standalone
EnvironmentFile=$S/admin-dashboard.env
ExecStart=$ROOT/node-bin/node server.js
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable vela-admin-auth.service vela-admin-dashboard.service >/dev/null
sudo systemctl restart vela-admin-auth.service vela-admin-dashboard.service

cp "$ENV_DIR/nginx.conf" "$ROOT/proxy/nginx.conf"
docker restart vela-web-proxy >/dev/null
for _ in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:13090/admin/gateway/login 2>/dev/null && break; sleep 1; done
curl -sS -o /dev/null -w "admin console via nginx %{http_code}\n" http://127.0.0.1:13090/admin/gateway/login
echo "Admin token: $S/dashboard-admin-token"
