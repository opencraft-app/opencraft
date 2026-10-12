#!/usr/bin/env bash
# Backend smoke test against real Tencent IM, isolated from the running test env: its own SQLite and HERMES_HOME (fake
# `hermes profile create`) under $ROOT/smoke, spare ports. State persists so reruns reuse the same two Tencent accounts
# (trial IM apps allow only 100). Exercises the dev gateway, Bot provisioning and delivery, the Bot credential
# exchange, the worker + vela_im CLI, and platform groups. Requests skip the LightVela login by sending what the
# gateway would send (internal bearer + X-Lightclaw-User-ID), so no real account token is needed.
# Prerequisites: install.sh prerequisites (IM secret, `npm run build` in vela-im) and Go.
set -euo pipefail
ROOT=${VELA_TEST_ROOT:-$HOME/vela-test}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
ENV_DIR=$REPO/deploy/test-env
PY=$ROOT/hermes-home/hermes-agent/venv/bin/python
NODE=$ROOT/node-bin/node
COLLAB=127.0.0.1:${SMOKE_COLLAB_PORT:-18891}
GATEWAY=127.0.0.1:${SMOKE_GATEWAY_PORT:-18886}
USER_ID=${SMOKE_USER_ID:-usr_vela_smoke}
T=$ROOT/smoke
PIDS=()
cleanup() { for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done; wait 2>/dev/null || true; }
trap cleanup EXIT
step() { printf '\n== %s\n' "$*"; }
json() { "$PY" -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1], {}, {'d': d}))" "$1"; }

umask 077
mkdir -p "$T/secrets" "$T/hermes/profiles" "$T/bin"
sed -n 's/^VELA_IM_SECRET_KEY=//p' "$ROOT/secrets/im-secret.env" | tr -d '\r\n' > "$T/secrets/im-secret-key"
for name in jwt identity gateway; do test -s "$T/secrets/$name" || head -c 32 /dev/urandom | base64 -w0 > "$T/secrets/$name"; done
umask 022
ln -sfn "$ROOT/hermes-home/hermes-agent" "$T/hermes/hermes-agent"
cat > "$T/bin/hermes" <<'EOF'
#!/bin/sh
[ "$1 $2" = "profile create" ] && mkdir -p "$HERMES_HOME/profiles/$3"
EOF
chmod +x "$T/bin/hermes"
GATEWAY_TOKEN=$(cat "$T/secrets/gateway")

step "build and start collaboration, dev gateway"
(cd "$REPO/../collaboration" && go build -o "$T/bin/chatserver" ./cmd/chatserver)
HERMES_HOME=$T/hermes VELA_HERMES_BIN=$T/bin/hermes VELA_PLUGIN_DIR=$REPO/hermes-plugin \
  "$T/bin/chatserver" serve --collaboration-only --database "$T/collaboration.sqlite" --listen "$COLLAB" \
  --jwt-key-file "$T/secrets/jwt" --lightvela-gateway-token-file "$T/secrets/gateway" \
  --im-sdk-app-id "${VELA_SDK_APP_ID:-1600166071}" --im-admin-user-id administrator \
  --im-secret-key-file "$T/secrets/im-secret-key" --im-identity-key-file "$T/secrets/identity" \
  --bot-host-command "$ENV_DIR/bot-host.sh" --bot-runtime-api-url "http://$COLLAB/v1" > "$T/collaboration.log" 2>&1 &
PIDS+=($!)
GATEWAY_LISTEN=$GATEWAY COLLABORATION_URL=http://$COLLAB GATEWAY_TOKEN_FILE=$T/secrets/gateway \
  "$NODE" "$ENV_DIR/dev-gateway.mjs" > "$T/gateway.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 60); do curl -fsS "http://$COLLAB/readyz" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "http://$COLLAB/readyz" >/dev/null || { cat "$T/collaboration.log"; exit 1; }

human() { # method path [body]
  curl -sS -X "$1" "http://$COLLAB/v1$2" -H "Authorization: Bearer $GATEWAY_TOKEN" -H "X-Lightclaw-User-ID: $USER_ID" \
    -H 'Content-Type: application/json' ${3:+--data "$3"} -w '\n%{http_code}'
}
expect() { # expected-status response
  local status=${2##*$'\n'}
  [ "$status" = "$1" ] || { echo "expected HTTP $1, got $status: ${2%$'\n'*}" >&2; tail -20 "$T/collaboration.log" >&2; exit 1; }
  printf '%s' "${2%$'\n'*}"
}

step "dev gateway rejects requests without a LightVela session"
status=$(curl -sS -o /dev/null -w '%{http_code}' "http://$GATEWAY/v1/collaboration/me/bots" -H 'X-Lightclaw-User-ID: usr_forged')
[ "$status" = 401 ] && echo "401 ok" || { echo "gateway returned $status"; exit 1; }

step "human UserSig exchange"
# The first sighting of an account queues its Tencent import; the exchange answers 503 until that finishes.
for _ in $(seq 1 30); do response=$(human POST /me/im/session); [ "${response##*$'\n'}" = 503 ] || break; sleep 1; done
session=$(expect 200 "$response")
HUMAN_IM=$(json 'd["userId"]' <<< "$session")
echo "human IM user $HUMAN_IM, UserSig expires $(json 'd["expiresAt"]' <<< "$session")"

step "provision a Bot (verify, import, deliver)"
bot=$(expect 200 "$(human POST /me/bots '{"instanceId":"ins-smoke","botId":"ins-smoke","displayName":"Smoke Bot"}')")
BOT_ID=$(json 'd["id"]' <<< "$bot"); BOT_IM=$(json 'd["userId"]' <<< "$bot")
echo "bot $BOT_ID state=$(json 'd["state"]' <<< "$bot") im=$BOT_IM"
PROFILE=$(ls -d "$T"/hermes/profiles/vb-*)
DATA=$PROFILE/plugin-data/vela-im
echo "credential mode $(stat -c %a "$DATA/credential"), config $(cat "$DATA/config.json")"
grep -q vela-im "$PROFILE/config.yaml" && test -f "$PROFILE/plugins/vela-im/plugin.yaml" && echo "plugin enabled in profile"
again=$(expect 200 "$(human POST /me/bots '{"instanceId":"ins-smoke","botId":"ins-smoke","displayName":"Smoke Bot"}')")
[ "$(json 'd["id"]' <<< "$again")" = "$BOT_ID" ] && echo "re-provision is idempotent"

step "Bot credential -> runtime session"
CREDENTIAL=$(cat "$DATA/credential")
runtime=$(curl -sS -X POST "http://$COLLAB/v1/runtime/bot/session" -H "Authorization: BotCredential $CREDENTIAL" -w '\n%{http_code}')
runtime=$(expect 200 "$runtime")
echo "bot runtime identity: $(json 'd["bot"]["userId"]' <<< "$runtime"), owners $(json 'd["bot"]["ownerUserIds"]' <<< "$runtime")"
status=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "http://$COLLAB/v1/runtime/bot/session" -H "Authorization: BotCredential vbc_x.y.1.AAAA")
[ "$status" = 401 ] && echo "forged credential rejected (401)"

step "worker + vela_im CLI"
VELA_API_URL=http://$COLLAB/v1 VELA_BOT_CREDENTIAL_FILE=$DATA/credential VELA_WORKER_DIR=$DATA \
  "$NODE" --disable-warning=ExperimentalWarning "$REPO/hermes-plugin/vela_im/_worker/vela-im-worker.mjs" > "$T/worker.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 30); do grep -q '"ready": *true' "$DATA/worker.json" 2>/dev/null && break; sleep 1; done
vela_im() { HERMES_HOME=$PROFILE PYTHONPATH=$REPO/python-sdk "$PY" -m vela_im "$@"; }
vela_im whoami

step "platform group: human creates with the Bot, changes reply mode, Bot reads it"
GROUP_ID=$("$PY" -c 'import sys; sys.path.insert(0, sys.argv[1]); from vela_im.client import uuid7; print(uuid7())' "$REPO/python-sdk")
group=$(expect 200 "$(human POST /me/groups "{\"groupId\":\"$GROUP_ID\",\"name\":\"smoke\",\"memberUserIds\":[\"$BOT_IM\"],\"replyMode\":\"mention\"}")")
echo "group $(json 'd["tencentGroupId"]' <<< "$group") members=$(json 'len(d["members"])' <<< "$group") mode=$(json 'd["effectiveReplyMode"]' <<< "$group")"
group=$(expect 200 "$(human PATCH "/me/groups/$GROUP_ID" '{"replyMode":"all"}')")
echo "reply mode now $(json 'd["replyMode"]' <<< "$group")"
vela_im group info "$GROUP_ID"
vela_im send --to "$(json 'd["tencentGroupId"]' <<< "$group")" --group --text "smoke test message"

step "cleanup: dismiss group, delete Bot (kicks and revokes the credential)"
expect 204 "$(human DELETE "/me/groups/$GROUP_ID")" >/dev/null && echo "group dismissed"
expect 204 "$(human DELETE "/me/bots/$BOT_ID")" >/dev/null && echo "bot deleted"
test ! -e "$DATA/credential" && echo "credential removed from profile"
status=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "http://$COLLAB/v1/runtime/bot/session" -H "Authorization: BotCredential $CREDENTIAL")
[ "$status" = 401 ] && echo "old credential rejected after delete (401)" || { echo "old credential still accepted: HTTP $status"; exit 1; }
echo; echo "SMOKE OK"
