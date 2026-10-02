#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
temporary=$(mktemp -d /data/tmp/qualification-cache-test.XXXXXX)
trap 'rm -rf -- "$temporary"' EXIT INT TERM
mkdir -p "$temporary/receipts" "$temporary/bin"
touch "$temporary/kubeconfig"
cat >"$temporary/bin/kubectl" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
state=${FAKE_KUBE_STATE:?}
args=" $* "
if [[ $args == *" get configmap "* ]]; then
  [[ -s $state ]] || exit 1
  cat "$state"
elif [[ $args == *" get configmaps "* ]]; then
  if [[ ! -s $state ]]; then
    echo '{"items":[]}'
  elif jq -e 'type == "array"' "$state" >/dev/null; then
    jq '{items:.}' "$state"
  else
    jq -n --slurpfile item "$state" '{items:$item}'
  fi
elif [[ $args == *" create configmap "* && $args == *" --dry-run=client "* ]]; then
  name=""
  source=""
  for ((i=1; i<=$#; i++)); do
    value=${!i}
    [[ $value == configmap ]] && { j=$((i+1)); name=${!j}; }
    [[ $value == --from-file=receipt.json.gz=* ]] && source=${value#--from-file=receipt.json.gz=}
  done
  jq -n --arg name "$name" --rawfile receipt "$source" \
    '{apiVersion:"v1",kind:"ConfigMap",metadata:{name:$name,labels:{},annotations:{}},data:{"receipt.json.gz":$receipt}}'
elif [[ $args == *" create -f - "* ]]; then
  [[ ! -e $state ]] || exit 1
  tee "$state" >/dev/null
else
  echo "unexpected fake kubectl invocation: $*" >&2
  exit 2
fi
FAKE
chmod 0755 "$temporary/bin/kubectl"

receipt=$temporary/receipts/actor-bj-q01-agent-arrival-20260907T031937Z.json
printf '{"cell":"actor-bj-q01","verdict":"pass","value":7}\n' >"$receipt"
touch -d '@1700000000' "$receipt"
expected_sha=$(sha256sum "$receipt" | cut -d' ' -f1)
export FAKE_KUBE_STATE=$temporary/configmap.json
common=(
  CELL=actor-bj-q01 CELL_NAMESPACE=actor-fdb-cell-system
  KUBECONFIG_PATH=$temporary/kubeconfig KUBECTL=$temporary/bin/kubectl
  QUALIFICATION_RECEIPT_DIR=$temporary/receipts
)
if env -u CELL CELL_NAMESPACE=actor-fdb-cell-system \
  KUBECONFIG_PATH=$temporary/kubeconfig KUBECTL=$temporary/bin/kubectl \
  QUALIFICATION_RECEIPT_DIR=$temporary/receipts \
  "$script_dir/cache-qualification-receipt.sh" "$receipt" >/dev/null 2>&1; then
  echo "receipt cache accepted an implicit q01 Cell identity" >&2
  exit 1
fi
if env -u CELL CELL_NAMESPACE=actor-fdb-cell-system \
  KUBECONFIG_PATH=$temporary/kubeconfig KUBECTL=$temporary/bin/kubectl \
  QUALIFICATION_RECEIPT_DIR=$temporary/receipts \
  "$script_dir/hydrate-qualification-receipts.sh" >/dev/null 2>&1; then
  echo "receipt hydration accepted an implicit q01 Cell identity" >&2
  exit 1
fi
echo 'qualification receipt cache identity: pass'
env "${common[@]}" "$script_dir/cache-qualification-receipt.sh" "$receipt" >/dev/null
env "${common[@]}" "$script_dir/cache-qualification-receipt.sh" "$receipt" >/dev/null
rm "$receipt"
env "${common[@]}" "$script_dir/hydrate-qualification-receipts.sh" >/dev/null
[[ $(sha256sum "$receipt" | cut -d' ' -f1) == "$expected_sha" ]]
[[ $(stat -c %Y "$receipt") == 1700000000 ]]

jq '.binaryData["receipt.json.gz"] = ("tampered\n" | @base64)' \
  "$temporary/configmap.json" >"$temporary/tampered.json"
mv "$temporary/tampered.json" "$temporary/configmap.json"
rm "$receipt"
if env "${common[@]}" "$script_dir/hydrate-qualification-receipts.sh" >/dev/null 2>&1; then
  echo "tampered cached receipt was accepted" >&2
  exit 1
fi
echo 'qualification receipt cache: pass'

# The qualification publisher caches its autonomy decision under the
# autonomy-control-<cell>- prefix. Writer and hydrator must accept the same
# bounded namespace or the first activation poisons every later audit.
rm "$temporary/configmap.json"
control_receipt=$temporary/receipts/autonomy-control-actor-bj-q01-20260908T065224Z.json
printf '{"cell":"actor-bj-q01","verdict":"passed","control":"allow"}\n' >"$control_receipt"
touch -d '@1700000050' "$control_receipt"
control_sha=$(sha256sum "$control_receipt" | cut -d' ' -f1)
env "${common[@]}" "$script_dir/cache-qualification-receipt.sh" "$control_receipt" >/dev/null
rm "$control_receipt"
env "${common[@]}" "$script_dir/hydrate-qualification-receipts.sh" >/dev/null
[[ $(sha256sum "$control_receipt" | cut -d' ' -f1) == "$control_sha" ]]
[[ $(stat -c %Y "$control_receipt") == 1700000050 ]]
echo 'autonomy control receipt hydration: pass'

# An incompressible receipt above Linux MAX_ARG_STRLEN must survive publication
# and recovery while remaining below the ConfigMap payload limit.
rm "$temporary/configmap.json"
payload=$temporary/payload
head -c 200000 /dev/urandom | base64 -w0 >"$payload"
jq -n --rawfile payload "$payload" '{cell:"actor-bj-q01",verdict:"pass",payload:$payload}' >"$receipt"
expected_sha=$(sha256sum "$receipt" | cut -d' ' -f1)
env "${common[@]}" "$script_dir/cache-qualification-receipt.sh" "$receipt" >/dev/null
env "${common[@]}" "$script_dir/cache-qualification-receipt.sh" "$receipt" >/dev/null
rm "$receipt"
env "${common[@]}" "$script_dir/hydrate-qualification-receipts.sh" >/dev/null
[[ $(sha256sum "$receipt" | cut -d' ' -f1) == "$expected_sha" ]]

# A false expanded length must fail without replacing an existing receipt.
jq '.metadata.annotations["evidence.actor.dev/bytes"] = "64"' \
  "$temporary/configmap.json" >"$temporary/short.json"
mv "$temporary/short.json" "$temporary/configmap.json"
if env "${common[@]}" "$script_dir/hydrate-qualification-receipts.sh" >/dev/null 2>&1; then
  echo "false expanded length was accepted" >&2
  exit 1
fi
[[ $(sha256sum "$receipt" | cut -d' ' -f1) == "$expected_sha" ]]
[[ -z $(find "$temporary/receipts" -name '.hydrate.*' -print) ]]
echo 'large receipt and bounded hydration: pass'

# Historical retries may share one basename while retaining distinct immutable
# cache objects.  Hydration verifies both and restores the newest source-mtime.
retry_base=actor-bj-q01-user-transparent-rollback-retried.json
old_dir=$temporary/old
new_dir=$temporary/new
mkdir -p "$old_dir" "$new_dir"
old_receipt=$old_dir/$retry_base
new_receipt=$new_dir/$retry_base
printf '{"cell":"actor-bj-q01","verdict":"failed","attempt":1}\n' >"$old_receipt"
printf '{"cell":"actor-bj-q01","verdict":"passed","attempt":2}\n' >"$new_receipt"
touch -d '@1700000100' "$old_receipt"
touch -d '@1700000200' "$new_receipt"
old_config=$temporary/old-configmap.json
new_config=$temporary/new-configmap.json
export FAKE_KUBE_STATE=$old_config
QUALIFICATION_RECEIPT_DIR=$old_dir env "${common[@]:0:4}" \
  "$script_dir/cache-qualification-receipt.sh" "$old_receipt" >/dev/null
export FAKE_KUBE_STATE=$new_config
QUALIFICATION_RECEIPT_DIR=$new_dir env "${common[@]:0:4}" \
  "$script_dir/cache-qualification-receipt.sh" "$new_receipt" >/dev/null
multi_state=$temporary/multi-configmaps.json
jq -s '.' "$old_config" "$new_config" >"$multi_state"
export FAKE_KUBE_STATE=$multi_state
canonical=$temporary/receipts/$retry_base
rm -f "$canonical"
env "${common[@]}" "$script_dir/hydrate-qualification-receipts.sh" >/dev/null
[[ $(jq -r '.attempt' "$canonical") == 2 ]]
[[ $(stat -c %Y "$canonical") == 1700000200 ]]

# A local file not represented by any immutable cache object is still treated
# as tampering, even when multiple known historical versions exist.
printf '{"cell":"actor-bj-q01","verdict":"passed","attempt":999}\n' >"$canonical"
if env "${common[@]}" "$script_dir/hydrate-qualification-receipts.sh" >/dev/null 2>&1; then
  echo "unknown local retry receipt was accepted" >&2
  exit 1
fi

# Equal source mtimes with different payloads have no safe winner.
jq '.[1].metadata.annotations["evidence.actor.dev/source-mtime-epoch"] = "1700000100"' \
  "$multi_state" >"$temporary/tied-configmaps.json"
export FAKE_KUBE_STATE=$temporary/tied-configmaps.json
if env "${common[@]}" "$script_dir/hydrate-qualification-receipts.sh" >/dev/null 2>&1; then
  echo "ambiguous retry receipts were accepted" >&2
  exit 1
fi
echo 'retried immutable receipt hydration: pass'

# A Cell-class proof is deliberately not owned by the qualification Cell.  It
# is keyed by the exact immutable StorageProfile digest and must be hydratable
# into every matching Cell without rewriting the signed payload.
class_digest=$(printf 'd%.0s' {1..64})
class_receipt=$temporary/receipts/actor-cell-class-qualification-${class_digest}.json
printf '{"schema":"actor-cell-class-qualification/v1","verdict":"passed","scope":{"profileDigest":"sha256:%s"},"evidenceSha256":"%s"}\n' \
  "$class_digest" "$(printf 'e%.0s' {1..64})" >"$class_receipt"
touch -d '@1700000300' "$class_receipt"
class_sha=$(sha256sum "$class_receipt" | cut -d' ' -f1)
export FAKE_KUBE_STATE=$temporary/class-configmap.json
env "${common[@]}" "$script_dir/cache-qualification-receipt.sh" "$class_receipt" >/dev/null
rm "$class_receipt"
env "${common[@]}" "$script_dir/hydrate-qualification-receipts.sh" >/dev/null
[[ $(sha256sum "$class_receipt" | cut -d' ' -f1) == "$class_sha" ]]
[[ $(stat -c %Y "$class_receipt") == 1700000300 ]]
echo 'Cell-class qualification receipt hydration: pass'

# Runtime release evolution is also qualified once per exact immutable image
# set and hydrated into every matching Cell.
release_digest=$(printf '1%.0s' {1..64})
release_receipt=$temporary/receipts/actor-runtime-release-qualification-${release_digest}.json
printf '{"schema":"actor-runtime-release-qualification/v1","verdict":"passed","scope":{"artifactDigest":"sha256:%s"},"evidenceSha256":"%s"}\n' \
  "$release_digest" "$(printf '2%.0s' {1..64})" >"$release_receipt"
touch -d '@1700000400' "$release_receipt"
release_sha=$(sha256sum "$release_receipt" | cut -d' ' -f1)
export FAKE_KUBE_STATE=$temporary/release-configmap.json
env "${common[@]}" "$script_dir/cache-qualification-receipt.sh" "$release_receipt" >/dev/null
rm "$release_receipt"
env "${common[@]}" "$script_dir/hydrate-qualification-receipts.sh" >/dev/null
[[ $(sha256sum "$release_receipt" | cut -d' ' -f1) == "$release_sha" ]]
[[ $(stat -c %Y "$release_receipt") == 1700000400 ]]
echo 'Runtime-release qualification receipt hydration: pass'
