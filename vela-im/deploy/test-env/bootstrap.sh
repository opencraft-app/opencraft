#!/usr/bin/env bash
# Node 22 (via nvm, without changing the default) + Hermes from the LightVela COS release, in an isolated HERMES_HOME.
set -euo pipefail
ROOT=${VELA_TEST_ROOT:-$HOME/vela-test}
HERMES_HOME=$ROOT/hermes-home
mkdir -p "$ROOT" "$HERMES_HOME"
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
export NVM_NODEJS_ORG_MIRROR=${NVM_NODEJS_ORG_MIRROR:-https://mirrors.tencent.com/nodejs-release/}
nvm install 22 >/dev/null
ln -sfn "$(dirname "$(nvm which 22)")" "$ROOT/node-bin"
echo "node: $("$ROOT/node-bin/node" -v)"
META=$(curl -fsSL https://hermes-code-1325194254.cos.ap-guangzhou.myqcloud.com/hermes/latest.json)
URL=$(printf '%s' "$META" | python3 -c 'import json,sys;print(json.load(sys.stdin)["cos_url"])')
if [ ! -f "$HERMES_HOME/hermes-agent/pyproject.toml" ]; then
  TMP=$(mktemp -d); curl -fsSL "$URL" -o "$TMP/hermes.tgz"; tar -xzf "$TMP/hermes.tgz" -C "$TMP"
  TOP=$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -1); rm -rf "$HERMES_HOME/hermes-agent"; mv "$TOP" "$HERMES_HOME/hermes-agent"; rm -rf "$TMP"
fi
export PATH="$ROOT/node-bin:$PATH"
# Same installer stages as images/build.sh, minus the shell PATH stage.
for stage in venv python-deps node-deps config; do
  echo "== installer stage $stage"
  bash "$HERMES_HOME/hermes-agent/scripts/install.sh" --skip-setup --dir "$HERMES_HOME/hermes-agent" --hermes-home "$HERMES_HOME" --non-interactive --stage "$stage"
done
"$HERMES_HOME/hermes-agent/venv/bin/hermes" --version
echo "Next: configure the default profile's model in $HERMES_HOME/config.yaml and provider key in $HERMES_HOME/.env"
