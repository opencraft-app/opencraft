#!/bin/sh
set -eu

source_root=${1:-"$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"}
generated_paths=${CHATSERVER_GENERATED_PATHS:-"internal/ent internal/api/openapi/server.gen.go internal/api/openapi/client.gen.go internal/api/computerbootstrap/server.gen.go internal/api/computerbootstrap/client.gen.go internal/api/computerupdate/server.gen.go internal/api/computerupdate/client.gen.go"}
temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/chatserver-generated.XXXXXX")
work_root="$temporary_root/work"
before_file="$temporary_root/before"
after_file="$temporary_root/after"
generate_log="$temporary_root/generate.log"

cleanup() {
  rm -rf -- "$temporary_root"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$work_root"
# 只复制源码；本地构建产物和 Computer 运行态可能达到数 GB，既不参与
# go generate，也不应被一致性检查复制到临时目录。
(
  cd "$source_root"
  find . -mindepth 1 -maxdepth 1 \
    ! -name build \
    ! -name computer \
    ! -name dist \
    ! -name .git \
    -print | tar -cf - -T -
) | tar -C "$work_root" -xf -

snapshot() {
  destination=$1
  (
    cd "$work_root"
    for path in $generated_paths; do
      if [ ! -e "$path" ]; then
        echo "缺少生成产物：$path" >&2
        exit 1
      fi
      find "$path" -type f -print
    done |
      LC_ALL=C sort |
      while IFS= read -r file; do
        checksum=$(cksum <"$file")
        printf '%s %s\n' "$checksum" "$file"
      done
  ) >"$destination"
}

snapshot "$before_file"
if ! (cd "$work_root" && go generate ./...) >"$generate_log" 2>&1; then
  echo "生成产物检查失败：go generate 执行失败" >&2
  cat "$generate_log" >&2
  exit 1
fi
snapshot "$after_file"

if ! cmp -s "$before_file" "$after_file"; then
  echo "生成产物不一致：请重新运行 go generate ./..." >&2
  diff -u "$before_file" "$after_file" >&2 || true
  exit 1
fi

echo "生成产物一致"
if [ -n "${CHATSERVER_MIGRATION_TRUSTED_RELEASE_LOCK:-}" ]; then
  CHATSERVER_MIGRATION_TRUSTED_RELEASE_LOCK="$CHATSERVER_MIGRATION_TRUSTED_RELEASE_LOCK" \
    "$source_root/scripts/check-migration-release.sh" "$source_root"
else
  "$source_root/scripts/check-migration-release.sh" "$source_root"
fi
"$source_root/scripts/check-openapi-compatibility.sh" "$source_root"
