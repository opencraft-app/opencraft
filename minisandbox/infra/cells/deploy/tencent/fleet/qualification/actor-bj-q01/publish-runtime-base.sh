#!/usr/bin/env bash
set -euo pipefail

[[ $# == 1 ]] || { echo "Usage: publish-runtime-base.sh LOCAL_IMAGE" >&2; exit 2; }
tccli=${TCCLI:-tccli}
registry=lightclaw-bj82.tencentcloudcr.com
repository=$registry/actor-fleet/runtime-base
registry_id=tcr-g7ax6o7q
image_id=$(docker image inspect "$1" --format '{{.Id}}')
[[ $image_id =~ ^sha256:[0-9a-f]{64}$ ]]
target=$repository:sha256-${image_id#sha256:}
namespace=$("$tccli" tcr DescribeNamespaces --region ap-beijing --RegistryId "$registry_id" --NamespaceName actor-fleet)
jq -e '.TotalCount == 1 and .NamespaceList[0].Name == "actor-fleet" and .NamespaceList[0].Public == false' <<<"$namespace" >/dev/null
repositories=$("$tccli" tcr DescribeRepositories --region ap-beijing --RegistryId "$registry_id" --NamespaceName actor-fleet --RepositoryName runtime-base)
count=$(jq -er '.TotalCount' <<<"$repositories")
case "$count" in
0) "$tccli" tcr CreateRepository --region ap-beijing --RegistryId "$registry_id" \
     --NamespaceName actor-fleet --RepositoryName runtime-base --BriefDescription 'Pinned OS-only runtime build base' ;;
1) ;;
*) echo "ambiguous runtime base repository" >&2; exit 2 ;;
esac

temporary=$(mktemp -d /data/tmp/q01-publish-runtime-base.XXXXXX)
chmod 0700 "$temporary"
trap 'rm -rf -- "$temporary"' EXIT INT TERM
"$tccli" tcr CreateInstanceToken --region ap-beijing --RegistryId "$registry_id" \
  --TokenType temp --Desc q01-runtime-base-publication >"$temporary/token.json"
jq -e '.Username | type == "string" and length > 0' "$temporary/token.json" >/dev/null
jq -er '.Token | select(type == "string" and length > 0)' "$temporary/token.json" |
  docker --config "$temporary/docker" login "$registry" \
    --username "$(jq -er .Username "$temporary/token.json")" --password-stdin
docker tag "$image_id" "$target"
docker --config "$temporary/docker" push "$target"
digest=$(docker image inspect "$target" --format '{{json .RepoDigests}}' |
  jq -er --arg prefix "$repository@sha256:" '[.[] | select(startswith($prefix))] | unique | select(length == 1) | .[0]')
docker --config "$temporary/docker" pull "$digest"
test "$(docker image inspect "$digest" --format '{{.Id}}')" = "$image_id"
printf 'runtime_base_publication=passed image=%s local_image_id=%s\n' "$digest" "$image_id"
