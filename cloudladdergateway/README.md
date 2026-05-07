# cloudladdergateway

`cloudladdergateway` 是一个 Connect/gRPC + Gin HTTP 的条件代理网关：

- Connect RPC：`CloudLadderGatewayService.Invoke`
- HTTP/Gin：`/v1/proxy/:route_id/*path`
- 条件路由：每条 route 和 webhook 都可配置 Starlark 表达式
- 强认证：支持 caller 级 HMAC 签名和 route 权限
- Webhook：支持同步/异步发送，支持镜像原始请求到其它环境
- 审计：每次代理调用输出结构化 audit event，并可通过 OTLP logs 导出
- 上游发现：支持固定 `base_url` 和 Polaris Sidecar 服务发现
- 连接池：上游 HTTP client 使用统一 transport 连接池
- 客户端生成：`make generate` 生成 Go protobuf 和 Connect client

## 本地运行

```bash
cd cloudladdergateway
make generate
go test ./...
go run ./cmd/cloudladdergateway -config config.example.yaml
```

## 镜像构建

从仓库根目录构建：

```bash
docker build -f cloudladdergateway/Dockerfile -t cloudladdergateway:local .
docker run --rm -p 8095:8095 cloudladdergateway:local
```

## HTTP 调用

```bash
curl -X POST 'http://127.0.0.1:8095/v1/proxy/sandbox-cn/post?x=1' \
  -H 'X-CloudLadder-Attr-env: sandbox' \
  -H 'Content-Type: application/json' \
  -d '{"hello":"world"}'
```

`X-CloudLadder-Attr-*` 会进入 Starlark 的 `request.attributes`。

HTTP 入口会先校验 `route_id` 是否存在。未知 route 直接返回 404，不读取 body、不触发鉴权、不进入业务审计，用于过滤公网 IP 上常见的扫描噪音。

## 上游地址与 Polaris

每条 route 的 upstream 必须显式选择一种来源。

固定上游：

```yaml
upstream:
  base_url: "https://billing.example.internal"
  timeout: 10s
```

Polaris 服务发现：

```yaml
discovery:
  polaris:
    sidecar_url: "http://127.0.0.1:8080"
    cache_ttl: 30s
    stale_on_error: true

routes:
  - id: billing.query_bill
    upstream:
      scheme: http
      polaris:
        service: billing.service
        namespace: Production
```

Polaris resolver 会调用 Sidecar `/v1/GetOneInstance`，缓存 `host:port`。当 Sidecar 临时失败且已有旧缓存时，默认使用旧实例兜底，避免 IDC 内部服务发现短抖动直接打断调用。

## 上游连接池

上游 HTTP client 默认开启连接池：

```yaml
transport:
  max_idle_conns: 100
  max_idle_conns_per_host: 20
  idle_conn_timeout: 90s
  response_header_timeout: 30s
  tls_handshake_timeout: 10s
  expect_continue_timeout: 1s
```

这些配置同时用于普通 upstream 请求、webhook 请求和 Polaris Sidecar 查询。

## 强认证

生产部署应打开 HMAC 认证。每个 caller 使用独立 secret，并限制可调用 route：

```yaml
auth:
  enabled: true
  timestamp_skew: 5m
  callers:
    - id: payment
      secret_env: CLOUDLADDER_PAYMENT_HMAC_SECRET
      routes: ["billing.query_bill"]
```

HTTP 调用方需要发送：

- `X-CloudLadder-Caller`
- `X-CloudLadder-Timestamp`，RFC3339，例如 `2026-05-07T12:00:00Z`
- `X-CloudLadder-Signature`，格式 `sha256=<hex>`

签名 canonical string：

```text
caller
route_id
method
path
query
timestamp
body_sha256
```

Go Connect 调用方可使用 `pkg/clientauth`：

```go
req := &gatewayv1.ProxyRequest{
    Caller:  "payment",
    RouteId: "billing.query_bill",
    Method:  "POST",
    Path:    "/bill/query",
    Body:    payload,
}
clientauth.SignProxyRequest(os.Getenv("CLOUDLADDER_PAYMENT_HMAC_SECRET"), req, time.Now())
```

## Starlark 上下文

Route condition 可访问：

- `request.route_id`
- `request.method`
- `request.path`
- `request.query`
- `request.headers`
- `request.attributes`

Webhook condition 额外可访问：

- `response.status_code`
- `response.headers`
- `response.upstream_url`

## 审计与 OTLP

这个组件会代理访问腾讯 IDC 内部账号/计费能力，审计是核心能力。每次代理调用都会记录：

- `request.id`
- `caller`
- `operation`
- `upstream.url`
- `http.response.status_code`
- `duration.ms`
- `error.message`
- `request.body.bytes`
- `request.body.sha256`
- `response.body.bytes`
- `webhook.count`

默认输出 stdout JSON。要接入标准 OpenTelemetry Collector，可打开 OTLP logs：

```yaml
audit:
  service_name: cloudladdergateway
  stdout: true
  otlp:
    enabled: true
    endpoint_url: "http://otel-collector:4318/v1/logs"
    insecure: true
    timeout: 5s
```

也可以不在配置里写 endpoint，改用标准环境变量；只要设置了下面任一变量，程序会自动启用 OTLP audit logs：

```bash
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://otel-collector:4318/v1/logs
```

审计只记录请求摘要和 body SHA-256，不记录 body 明文，避免泄露账号/计费敏感信息。

## 仍需产品化的能力

第一版先不做持久化。后续进入生产前应补齐：

- mTLS：当前先落 HMAC；公网入口正式化时应叠加 mTLS 或网关层 TLS client cert 校验。
- 可靠投递：异步 webhook 的队列、重试、死信、幂等键。
- 安全边界：header/body 脱敏、最大 body、allowlist、SSRF 防护。
- 熔断限流：route 级 timeout、retry、rate limit、circuit breaker。
- 配置治理：热加载、配置校验、dry-run、灰度发布。
