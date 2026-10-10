#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
: "${CHATSERVER_AGENT_BINARY:?必须设置为内嵌 IM 的 vela-computer 绝对路径}"

case "$CHATSERVER_AGENT_BINARY" in
  /* | [A-Za-z]:[\\/]* ) ;;
  *) echo "CHATSERVER_AGENT_BINARY 必须是绝对路径" >&2; exit 2 ;;
esac
if [ ! -f "$CHATSERVER_AGENT_BINARY" ] ||
  [ -L "$CHATSERVER_AGENT_BINARY" ] ||
  [ ! -x "$CHATSERVER_AGENT_BINARY" ]; then
  echo "CHATSERVER_AGENT_BINARY 必须是安全的可执行文件" >&2
  exit 1
fi

release_directory=${CHATSERVER_RELEASE_DIR:-"$repository_root/dist/release"}
if [ -e "$release_directory" ]; then
  echo "build-release: output directory already exists" >&2
  exit 1
fi
mkdir -p "$release_directory"
install -m 0755 \
  "$CHATSERVER_AGENT_BINARY" \
  "$release_directory/vela-computer"

if command -v shasum >/dev/null 2>&1; then
  checksum=$(shasum -a 256 "$release_directory/vela-computer" | awk '{print $1}')
elif command -v sha256sum >/dev/null 2>&1; then
  checksum=$(sha256sum "$release_directory/vela-computer" | awk '{print $1}')
else
  echo "build-release: 缺少 SHA-256 工具" >&2
  exit 1
fi
printf '%s  %s\n' "$checksum" "vela-computer" \
  >"$release_directory/SHA256SUMS"
chmod 0644 "$release_directory/SHA256SUMS"
