#!/bin/sh
set -eu

source_root=${1:-"$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"}
levels="$source_root/platform/v1/oasdiff-levels.txt"

cd "$source_root"

# oasdiff v1.10.29 是最后一个支持本项目 Go 1.25 工具链的官方版本。
# 该版本没有 validate 子命令，因此结构验证由 kin-openapi 契约测试完成。
go test ./internal/api/openapi ./internal/api/computerbootstrap ./internal/api/openapirelease
if [ -n "${CHATSERVER_OPENAPI_TRUSTED_RELEASE_LOCK:-}" ]; then
  go run ./cmd/openapi-release --verify \
    --root "$source_root" \
    --trusted-base "$CHATSERVER_OPENAPI_TRUSTED_RELEASE_LOCK"
else
  go run ./cmd/openapi-release --verify --root "$source_root"
fi

go tool oasdiff breaking \
  platform/v1/releases/4.0.0.openapi.yaml \
  platform/v1/openapi.yaml \
  --severity-levels "$levels" \
  --fail-on WARN \
  --format text

go tool oasdiff breaking \
  platform/v1/releases/4.0.0.computer-bootstrap.openapi.yaml \
  platform/v1/computer-bootstrap.openapi.yaml \
  --severity-levels "$levels" \
  --fail-on WARN \
  --format text

echo "OpenAPI 3.0 兼容性门禁通过"
