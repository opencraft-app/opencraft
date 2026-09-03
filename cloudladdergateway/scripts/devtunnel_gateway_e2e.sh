#!/usr/bin/env bash
# 全链路自测（含云梯这一跳）：devtunnel_local_e2e.sh 是拿 curl 冒充云梯的，会把
# 「云梯自己不会带 Authorization」这类问题掩盖掉。本脚本真的把 cloudladdergateway
# 拉起来，按现网拓扑串起来跑。
#
# 拓扑（与 tkexgz testing 一致，只是全在本机）：
#   curl(冒充 jifei，只带 uin) → cloudladdergateway
#     → uin_routes 命中 jifei-callback-dev-1
#     → base_url=devtunnel + host_header=dev1.tunnel.internal
#     + headers_from_env 注入 Authorization=DEVTUNNEL_TOKEN
#     → devtunnel ingest（按 Host 分流，阻塞等应答）
#   agent 长轮询走的也是云梯：-hub .../v1/proxy/devtunnel → devtunnel 控制面
#     → 取走 → 回放本机假 trade → 应答原路穿回 curl
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TOKEN="local-test-token"
ENVKEY="dev1.tunnel.internal"
UIN="700003135209"
GW_PORT=18095
HUB_PORT=18090
TRADE_PORT=18091
FALLBACK_PORT=18092
BIN="$(mktemp -d)"
LOG="$(mktemp -d)"

cleanup() {
  kill "${GW_PID:-}" "${SRV_PID:-}" "${AGENT_PID:-}" "${TRADE_PID:-}" "${FB_PID:-}" 2>/dev/null || true
  wait 2>/dev/null || true
  rm -rf "$BIN" "$LOG" /tmp/dt_gw_fakes.go 2>/dev/null || true
}
trap cleanup EXIT

echo "=== 0) 编译 gateway / devtunnel / agent / 假下游 ==="
go build -o "$BIN/gateway" ./cmd/cloudladdergateway
go build -o "$BIN/devtunnel" ./cmd/devtunnel
go build -o "$BIN/agent" ./cmd/devtunnel-agent
cat > /tmp/dt_gw_fakes.go <<'EOF'
package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
)

// 一个二进制冒充两个下游：marker 用来断言回调到底落在哪一边。
func main() {
	marker := os.Args[2]
	http.HandleFunc("/trade/jifei/callback", func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		fmt.Fprintf(w, `{"returnCode":0,"marker":%q,"echoPath":%q,"echoBody":%q}`,
			marker, r.URL.Path, string(b))
	})
	http.ListenAndServe(":"+os.Args[1], nil)
}
EOF
go build -o "$BIN/fake" /tmp/dt_gw_fakes.go

# gateway 的 addr 只能从配置文件读，复制一份改端口，避免占用 8095。
sed "s|^addr: \":8095\"|addr: \":$GW_PORT\"|" config.example.yaml > "$BIN/config.yaml"

echo "=== 1) 起假 trade（开发者机器）与假兜底环境 ==="
"$BIN/fake" "$TRADE_PORT" devcloud-trade >"$LOG/trade.log" 2>&1 & TRADE_PID=$!
"$BIN/fake" "$FALLBACK_PORT" fallback-env >"$LOG/fallback.log" 2>&1 & FB_PID=$!

echo "=== 2) 起 devtunnel server ==="
DEVTUNNEL_LISTEN=":$HUB_PORT" DEVTUNNEL_TOKEN="$TOKEN" "$BIN/devtunnel" >"$LOG/srv.log" 2>&1 & SRV_PID=$!

echo "=== 3) 起 cloudladdergateway（按 tkexgz testing 的 env 覆盖） ==="
CLOUDLADDERGATEWAY_CONFIG="$BIN/config.yaml" \
CLOUDLADDER_PAYMENT_HMAC_SECRET=test-secret \
DEVTUNNEL_TOKEN="$TOKEN" \
CLOUDLADDERGATEWAY_ROUTE_JIFEI_CALLBACK_BASE_URL="http://127.0.0.1:$FALLBACK_PORT" \
CLOUDLADDERGATEWAY_ROUTE_JIFEI_CALLBACK_UIN_ROUTES="$UIN=jifei-callback-dev-1" \
CLOUDLADDERGATEWAY_ROUTE_JIFEI_CALLBACK_DEV_1_BASE_URL="http://127.0.0.1:$HUB_PORT" \
CLOUDLADDERGATEWAY_ROUTE_JIFEI_CALLBACK_DEV_1_HOST_HEADER="$ENVKEY" \
CLOUDLADDERGATEWAY_ROUTE_DEVTUNNEL_BASE_URL="http://127.0.0.1:$HUB_PORT" \
  "$BIN/gateway" >"$LOG/gw.log" 2>&1 & GW_PID=$!

for _ in $(seq 1 40); do
  curl -sf -o /dev/null "http://127.0.0.1:$HUB_PORT/healthz" && break || sleep 0.3
done
for _ in $(seq 1 40); do
  curl -s -o /dev/null "http://127.0.0.1:$GW_PORT/v1/proxy/devtunnel/healthz" && break || sleep 0.3
done

echo "=== 4) 起 agent —— hub 走云梯 proxy 路由（与现网一致，DevCloud 只出站） ==="
"$BIN/agent" -hub "http://127.0.0.1:$GW_PORT/v1/proxy/devtunnel" -env "$ENVKEY" -token "$TOKEN" \
  -local "http://127.0.0.1:$TRADE_PORT" -allow-prefix "/trade/jifei/callback" >"$LOG/agent.log" 2>&1 & AGENT_PID=$!
sleep 2

echo "=== 5) 冒充 jifei 打回调（只带 uin，不带任何隧道相关 header） ==="
RESP=$(curl -sS -m 20 -X POST \
  "http://127.0.0.1:$GW_PORT/v1/proxy/jifei-callback/trade/jifei/callback" \
  -H 'Content-Type: application/json' \
  -d "{\"interface\":{\"para\":{\"uin\":\"$UIN\"}}}" -w "\nHTTP=%{http_code}")
echo "$RESP"

echo "=== 6) 断言穿透到 DevCloud 假 trade（而不是兜底环境） ==="
echo "$RESP" | grep -q 'HTTP=200' || { echo "FAIL: 期望 200"; tail -30 "$LOG"/*.log; exit 1; }
echo "$RESP" | grep -q '"marker":"devcloud-trade"' || { echo "FAIL: 没落到 DevCloud"; tail -30 "$LOG"/*.log; exit 1; }
echo "$RESP" | grep -q "$UIN" || { echo "FAIL: body 未穿透"; exit 1; }

echo "=== 7) 表外 uin 必须走兜底环境，不进隧道 ==="
RESP2=$(curl -sS -m 20 -X POST \
  "http://127.0.0.1:$GW_PORT/v1/proxy/jifei-callback/trade/jifei/callback" \
  -H 'Content-Type: application/json' \
  -d '{"interface":{"para":{"uin":"900000000000"}}}' -w "\nHTTP=%{http_code}")
echo "$RESP2" | grep -q '"marker":"fallback-env"' || { echo "FAIL: 表外 uin 应走兜底"; echo "$RESP2"; exit 1; }

echo "=== 8) 断言 ingest 鉴权真的由云梯注入（去掉注入源则应 401） ==="
CODE=$(curl -sS -m 10 -o /dev/null -w "%{http_code}" -X POST \
  -H "Host: $ENVKEY" "http://127.0.0.1:$HUB_PORT/trade/jifei/callback" -d '{}')
[ "$CODE" = "401" ] || { echo "FAIL: 裸 ingest 无 token 应 401，得到 $CODE"; exit 1; }

echo
echo "ALL PASS ✅ 含云梯的全链路（uin 改派 + Host 分流 + ingest 鉴权注入）穿透成功"
