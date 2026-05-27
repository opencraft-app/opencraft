#!/usr/bin/env bash
set -euo pipefail

src_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dst_root="${1:-$src_root}"

if [[ "$dst_root" != "$src_root" ]]; then
  mkdir -p "$dst_root"
  tar -C "$src_root" -cf - . | tar -C "$dst_root" -xf -
fi

config_dir="$dst_root/config"
mkdir -p "$config_dir"

template="$config_dir/config.jsonnet.example"
config="$config_dir/config.jsonnet"
if [[ ! -f "$template" ]]; then
  echo "missing template: $template" >&2
  exit 1
fi

sed "s#/path/to/wisp#$dst_root#g" "$template" > "$config"

chmod +x \
  "$dst_root/bin/wisp" \
  "$dst_root/bin/wispclient" \
  "$dst_root/bin/wispenv" \
  "$dst_root/bin/wisp-fs-agent" \
  "$dst_root/bin/juicefs-smount" \
  "$dst_root/juicefs/hack/smount.sh" \
  "$dst_root/juicefs/hack/sformat.sh"

cat <<EOF
installed_root=$dst_root
config=$config
start_cmd=sudo $dst_root/bin/wisp daemon run
bootstrap_cmd=sudo $dst_root/bin/wisp bootstrap
client_cmd=$dst_root/bin/wispclient
EOF
