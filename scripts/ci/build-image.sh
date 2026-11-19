#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(git rev-parse --show-toplevel)"
[[ -z "$(git status --porcelain)" ]] || { echo 'A clean committed fork is required' >&2; exit 1; }
roles=(gateway brain proxy)
case "${1:-all}" in
  gateway-brain|control) targets=(gateway brain proxy) ;;
  all|hands)
    : "${OPENCRAFT_BROWSER_ELECTRON_DISTRIBUTION:?Supply the verified Linux x64 Electron distribution directory for Hands}"
    export JOIN_BROWSER="$(cd "$OPENCRAFT_BROWSER_ELECTRON_DISTRIBUTION" && pwd -P)"
    if [[ ${1:-all} == hands ]]; then
      targets=(--allow="fs.read=$JOIN_BROWSER" hands)
      roles=(hands)
    else
      targets=(--allow="fs.read=$JOIN_BROWSER" gateway brain hands proxy full)
      roles+=(hands)
    fi
    ;;
  *) echo 'Usage: build-image.sh [control|gateway-brain|hands|all]' >&2; exit 2 ;;
esac
revision="$(git rev-parse HEAD)"
source_dir="$PWD"
node scripts/ci/source-identity.mjs >/dev/null
mkdir -p .local/ci
receipt="$(mktemp -d .local/ci/image.XXXXXX)"
trap 'rm -rf -- "$receipt"' EXIT
node scripts/ci/source-identity.mjs > "$receipt/source.json"
if [[ ${1:-all} == hands || ${1:-all} == all ]]; then
  node "$source_dir/scripts/remote-browser-artifact.mjs" "$JOIN_BROWSER" "$source_dir/vendor/electron/fork.json"
fi
export JOIN_SOURCE="$source_dir" JOIN_REVISION="$revision"
docker buildx bake --file docker/join-bake.hcl --load "${targets[@]}"
check_runtime_python() {
  docker run --rm --network none --platform linux/amd64 --entrypoint /usr/bin/python3 \
    "$1" -c 'import email, fcntl, json, smtplib, ssl; assert ssl.create_default_context().get_ca_certs(), "Runtime CA certificates are missing"'
}
for role in "${roles[@]}"; do
  tag="opencraft-join:$role-$revision"
  metadata="$(docker image inspect --format '{{.Os}}/{{.Architecture}} {{index .Config.Labels "org.opencontainers.image.revision"}} {{index .Config.Labels "app.opencraft.distribution"}} {{index .Config.Labels "org.opencraft.role"}} {{join .Config.Entrypoint " "}}' "$tag")"
  [[ "$metadata" == "linux/amd64 $revision join $role /opt/opencraft/bin/node /opt/opencraft/runtime/container-service.mjs $role" ]] || {
    echo "Unexpected $role image configuration: $metadata" >&2; exit 1;
  }
  docker run --rm --network none --platform linux/amd64 --entrypoint /opt/opencraft/bin/node \
    "$tag" -e "const present = require('node:fs').existsSync('runtime/browser/electron/electron'); if (present !== (process.argv[1] === 'hands')) process.exit(1)" "$role"
  check_runtime_python "$tag"
  role_image_id="$(docker image inspect --format '{{.Id}}' "$tag")"
  [[ "$role_image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo "Invalid $role image ID" >&2; exit 1; }
  printf '%s\n' "$role_image_id" > "$receipt/$role.iid"
done
if [[ ${1:-all} == hands || ${1:-all} == all ]]; then
  bash .ci/check-hands-image.sh "$(cat "$receipt/hands.iid")" "$revision" "$source_dir/vendor/electron/fork.json"
fi
if [[ ${1:-all} == hands ]]; then
  node scripts/ci/source-identity.mjs --check "$receipt/source.json"
  cp "$receipt/hands.iid" ".local/ci/$revision-hands.iid"
  trap - EXIT
  printf 'Image receipt: %s\n' "$receipt"
  exit 0
fi
image_id="$(cat "$receipt/gateway.iid")"
docker run -i --rm --network none --platform linux/amd64 --entrypoint /opt/opencraft/bin/node \
  "$image_id" --input-type=module - "$revision" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const json = path => JSON.parse(readFileSync(path));
const revision = process.argv[2];
const version = json('web/version.json');
assert.equal(version.sourceRevision, revision);
assert.equal(version.buildId, 'git-' + revision + '-join-ci');
assert.equal(version.headlessServer, true);
for (const entry of ['assistant-extension.mjs','assistant-server.mjs','orchestration-runtime-worker.mjs','runtime-plugin-executor.mjs','runtime-plugin-admin.mjs']) {
  if (!readFileSync('runtime/' + entry).length) throw new Error('Missing Join runtime sidecar: ' + entry);
}
const manifest = json('manifest.json');
assert.equal(manifest.buildId, version.buildId);
assert.equal(manifest.productPlugins.inventorySha256,
  createHash('sha256').update(readFileSync('runtime/product-plugins/inventory.json')).digest('hex'));
assert.match(readFileSync('runtime/container-gateway.mjs', 'utf8'), /wecom-channel-sync\.json/);
JS
if [[ "${1:-all}" == all ]]; then
  check_runtime_python "opencraft-join:full-$revision"
fi
node scripts/ci/source-identity.mjs --check "$receipt/source.json"
for role in "${roles[@]}"; do
  cp "$receipt/$role.iid" ".local/ci/$revision-$role.iid"
done
if [[ "${1:-all}" == all ]]; then
  docker image inspect --format '{{.Id}}' "opencraft-join:full-$revision" > "$receipt/full.iid"
  cp "$receipt/full.iid" ".local/ci/$revision.iid"
fi
trap - EXIT
printf 'Image receipt: %s\n' "$receipt"
