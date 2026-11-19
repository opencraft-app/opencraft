#!/usr/bin/env bash
set -Eeuo pipefail
image=${1:?image ID required}
rev=${2:?fork source revision required}
fork=$(sha256sum "${3:?fork.json required}" | cut -d' ' -f1)
docker run --rm --network none --entrypoint /opt/opencraft/bin/node "$image" -e '
const fs=require("node:fs"), assert=require("node:assert/strict");
const m=JSON.parse(fs.readFileSync("runtime/browser/electron/opencraft-electron-artifact.json"));
assert.equal(m.forkDefinitionSha256,process.argv[2]);
assert(m.nativeCopyProbePassed&&m.nativeInputCausalityProbePassed&&m.nativeImeFocusIdentityProbePassed);
assert.equal(JSON.parse(fs.readFileSync("web/version.json")).sourceRevision,process.argv[1]);
for (const file of ["native-hands.mjs","hands-files-owner.mjs","hands-terminal-owner.mjs"]) fs.accessSync("runtime/"+file);
assert.match(fs.readFileSync("runtime/native-hands.mjs","utf8"), /hands-files-owner\.mjs/);
fs.accessSync("runtime/browser/electron/electron",fs.constants.X_OK);' "$rev" "$fork"
identity=$(docker image inspect -f '{{.Config.User}}' "$image")
[[ "$identity" =~ ^([1-9][0-9]*):([1-9][0-9]*)$ ]] || { echo 'Hands image requires numeric nonroot UID:GID' >&2; exit 1; }
uid=${BASH_REMATCH[1]} gid=${BASH_REMATCH[2]}
name="join-hands-check-${rev:0:12}-$$"
trap 'docker rm -f "$name" >/dev/null 2>&1 || :' EXIT
docker run -d --name "$name" --init --network none --cpus=2 --memory=2g --pids-limit=4096 \
  --cap-drop ALL --cap-add SYS_ADMIN --cap-add SETUID --cap-add SETGID --cap-add SYS_CHROOT \
  --tmpfs /state:uid=$uid,gid=$gid,mode=0700 --tmpfs /ws:uid=$uid,gid=$gid,mode=0700 \
  -e OPENCRAFT_DATA_DIR=/state -e OPENCRAFT_WORKSPACE_DIR=/ws -e OPENCRAFT_LOG_DIR=/state/log \
  -e OPENCRAFT_EXECUTION_DIR=/state/execution -e OPENCRAFT_BROWSER_DATA_DIR=/state/execution/browser \
  -e OPENCRAFT_HANDS_EXECUTION_SOCKET=/state/execution/exec-owner.sock -e OPENCRAFT_HANDS_EXECUTION_TOKEN=/state/execution/exec-owner.token \
  -e OPENCRAFT_CODEX_EXECUTABLE=/opt/opencraft/runtime/codex/bin/codex -e OPENCRAFT_HANDS_CPUS=2 \
  -e OPENCRAFT_HANDS_MEMORY_BYTES=2147483648 -e HOME=/state/execution "$image"
for i in {1..60}; do
  if docker exec "$name" /opt/opencraft/bin/opencraft-health hands >/dev/null 2>&1; then break; fi
  [[ "$(docker inspect -f '{{.State.Running}}' "$name")" == true ]] || { docker logs --tail 20 "$name"; exit 1; }
  sleep 2
done
docker exec "$name" /opt/opencraft/bin/opencraft-health hands

docker exec -i "$name" /opt/opencraft/bin/node --input-type=module < docker/deploy/files-smoke.mjs
