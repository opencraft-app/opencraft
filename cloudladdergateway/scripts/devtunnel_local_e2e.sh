#!/usr/bin/env bash
# 本地全链路自测：不依赖 DevCloud / 云梯，全部在本机跑。
#
# 拓扑（模拟真实链路的每一跳）：
#   假云梯 ingest(curl，带 Host) → devtunnel server → agent 长轮询取走
#     → 回放到假 trade(echo) → 应答原路穿回 → curl 看到 assert
#
# 先编译成二进制再后台运行（而非 go run），这样能按 PID 干净 kill、脚本自终止。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TOKEN="local-test-token"
ENVKEY="dev1.tunnel.internal"
HUB_PORT=18090
TRADE_PORT=18091
BIN="$(mktemp -d)"
LOG="$(mktemp -d)"

cleanup() {
  kill "${SRV_PID:-}" "${AGENT_PID:-}" "${TRADE_PID:-}" 2>/dev/null || true
  wait 2>/dev/null || true
  rm -rf "$BIN" "$LOG" /tmp/faketrade_dt.go 2>/dev/null || true
}
trap cleanup EXIT

echo "=== 0) 编译 server / agent / 假 trade ==="
go build -o "$BIN/devtunnel" ./cmd/devtunnel
go build -o "$BIN/agent" ./cmd/devtunnel-agent
cat > /tmp/faketrade_dt.go <<'EOF'
package main
import ("fmt";"io";"net/http";"os")
func main(){
  http.HandleFunc("/trade/jifei/callback", func(w http.ResponseWriter, r *http.Request){
    b,_:=io.ReadAll(r.Body)
    w.Header().Set("X-Fake-Trade","1"); w.WriteHeader(200)
    fmt.Fprintf(w, `{"returnCode":0,"echoPath":%q,"echoBody":%q}`, r.URL.Path, string(b))
  })
  http.ListenAndServe(":"+os.Args[1], nil)
}
EOF
go build -o "$BIN/faketrade" /tmp/faketrade_dt.go

echo "=== 1) 起假 trade ==="
"$BIN/faketrade" "$TRADE_PORT" >"$LOG/trade.log" 2>&1 & TRADE_PID=$!
echo "=== 2) 起 devtunnel server ==="
DEVTUNNEL_LISTEN=":$HUB_PORT" DEVTUNNEL_TOKEN="$TOKEN" "$BIN/devtunnel" >"$LOG/srv.log" 2>&1 & SRV_PID=$!
echo "=== 3) 起 agent ==="
"$BIN/agent" -hub "http://127.0.0.1:$HUB_PORT" -env "$ENVKEY" -token "$TOKEN" \
  -local "http://127.0.0.1:$TRADE_PORT" -allow-prefix "/trade/jifei/callback" >"$LOG/agent.log" 2>&1 & AGENT_PID=$!

# 等三个端口就绪
for i in $(seq 1 30); do
  curl -sf -o /dev/null "http://127.0.0.1:$HUB_PORT/healthz" && break || sleep 0.3
done

echo "=== 4) 模拟云梯 ingest：POST 带 Host=$ENVKEY ==="
RESP=$(curl -sS -m 10 -H "Host: $ENVKEY" -H "Authorization: Bearer $TOKEN" \
  -X POST "http://127.0.0.1:$HUB_PORT/trade/jifei/callback" \
  -d '{"interface":{"para":{"uin":"700003135209"}}}' -w "\nHTTP=%{http_code}")
echo "$RESP"

echo "=== 5) 断言正向穿透 ==="
echo "$RESP" | grep -q 'HTTP=200' || { echo "FAIL: 期望 200"; cat "$LOG"/*.log; exit 1; }
echo "$RESP" | grep -q '"echoPath":"/trade/jifei/callback"' || { echo "FAIL: 路径未穿透"; exit 1; }
echo "$RESP" | grep -q '700003135209' || { echo "FAIL: body 未穿透"; exit 1; }

echo "=== 6) 负路径：未知 Host 无 agent → 期望 504 ==="
CODE=$(curl -sS -m 12 -o /dev/null -w "%{http_code}" -H "Host: dev-nobody" -H "Authorization: Bearer $TOKEN" \
  -X POST "http://127.0.0.1:$HUB_PORT/trade/jifei/callback" -d '{}')
[ "$CODE" = "504" ] || { echo "FAIL: 期望 504 得到 $CODE"; exit 1; }

echo "=== 7) 负路径：白名单外路径 → 期望 403 ==="
CODE=$(curl -sS -m 10 -o /dev/null -w "%{http_code}" -H "Host: $ENVKEY" -H "Authorization: Bearer $TOKEN" \
  -X POST "http://127.0.0.1:$HUB_PORT/evil/path" -d '{}')
[ "$CODE" = "403" ] || { echo "FAIL: 期望 403 得到 $CODE"; exit 1; }

echo "=== 8) 负路径：无 token → 期望 401 ==="
CODE=$(curl -sS -m 5 -o /dev/null -w "%{http_code}" -H "Host: $ENVKEY" \
  -X POST "http://127.0.0.1:$HUB_PORT/trade/jifei/callback" -d '{}')
[ "$CODE" = "401" ] || { echo "FAIL: 期望 401 得到 $CODE"; exit 1; }

echo
echo "ALL PASS ✅ 反向隧道全链路穿透成功"
