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

推送到 csighub：

```bash
make -C cloudladdergateway csighub TAG=dev
```

默认构建标签仍是 `csighub.tencentyun.com/skipzhang/cloudladdergateway:<tag>`，但当前 Mac 上
`csighub.tencentyun.com` 需要内网 DNS；`csighub` 目标会同时推送：

- `21.41.42.116:80/skipzhang/cloudladdergateway:<tag>`，用于 HTTP 内网 push endpoint。
- `csighub.tencentyun.com/skipzhang/cloudladdergateway:<tag>`，用于 public csighub 拉取入口。

```bash
make -C cloudladdergateway csighub TAG=dev \
  CSIGHUB_PUSH_REGISTRY=21.41.42.116:80/skipzhang
```

该目标默认使用 PATH 里的 `crane`，不要求全局 Docker daemon 配置 insecure registry。

如果所在网络可以直接解析并访问 `csighub.tencentyun.com`，也可以单独执行 `login-csighub`。
登录支持三种来源：

```bash
# 方式 1：固定 csighub 账号
export CSIGHUB_USERNAME=...
export CSIGHUB_PASSWORD=...

# 方式 2：固定 TCR 账号
export TCR_USERNAME=...
export TCR_PASSWORD=...

# 方式 3：读取现有 env 文件，通过 tccli 换临时 token
make -C cloudladdergateway login-csighub \
  CSIGHUB_ENV_FILE=/path/to/env-file
```

登录脚本默认使用 `crane auth login --password-stdin`，不会把密码打印到日志；如需 Docker 登录可设置
`CSIGHUB_LOGIN_TOOL=docker`。

镜像不内置 HMAC secret。运行时注入 `CLOUDLADDER_PAYMENT_HMAC_SECRET`：

```bash
export CLOUDLADDER_PAYMENT_HMAC_SECRET="$(openssl rand -hex 32)"
make -C cloudladdergateway run-image TAG=dev
```

`run-image` 只打印 secret 的长度和 SHA-256 指纹前 12 位，便于客户端与服务端对账，不打印明文。

运行镜像内置基础排障工具：`bash`、`curl`、`wget`、`strace`、`lsof`、`tmux`、`ss/ip`、`dig/nslookup`、
`nc`、`ps/top`。手动部署到 K8s 后，可以直接 `kubectl exec` 进入 Pod 做 HTTP、DNS、端口和进程排查。

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

可复用后端可以配置成 backend alias。当前 billing trade 直接把后端别名暴露成同名 route，调用方通过
`route_id` 选择要访问的站点和环境：

```yaml
backends:
  - alias: billing-trade-cn-prod
    upstream:
      scheme: http
      polaris:
        service: "1333953:131072"
        namespace: "Production"
      timeout: 5s
      allowed_methods: ["POST"]
      headers:
        Host: "trade.tencentyun.com"

routes:
  - id: billing-trade-cn-prod
    callers: ["payment"]
    condition: 'request.method == "POST"'
    upstream:
      backend: billing-trade-cn-prod
```

HTTP 调用示例：

```bash
curl -X POST 'http://127.0.0.1:8095/v1/proxy/billing-trade-cn-prod/interfaces/interface.php' \
  -H 'X-CloudLadder-Caller: payment' \
  -H 'X-CloudLadder-Timestamp: 2026-05-07T12:00:00Z' \
  -H 'X-CloudLadder-Signature: sha256=<hex>' \
  -H 'Content-Type: application/json' \
  -d '{"version":"1.0","componentName":"qcbuy","caller":"payment","eventId":4962132,"timestamp":1504077981,"interface":{"interfaceName":"qcloud.price.getPrice","para":{}}}'
```

Billing trade 后端别名固定为：

| alias | Polaris namespace/service | Host |
| --- | --- | --- |
| `billing-trade-cn-test` | `Test/cloud.drouter.http` | `trade.itd.com` |
| `billing-trade-cn-pre` | `Pre-release/jf_trade_pre` | `pre.trade.billing.woa.com` |
| `billing-trade-cn-prod` | `Production/1333953:131072` | `trade.tencentyun.com` |
| `billing-trade-intl-test` | `Test/cloud.drouter.http` | `test.trade-intl.billing.tencentyun.com` |
| `billing-trade-intl-pre` | `Pre-release/jf_trade_pre_intl` | `pre.trade.intl.billing.woa.com` |
| `billing-trade-intl-prod` | `Production/jf_intl_trade` | `intl.trade.tencentyun.com` |

国内站 / 国际站按腾讯云账号 `uin` 属性区分，不按下单地域 `region` 区分。使用 Polaris/L5 访问 billing trade 时必须显式带对应 `Host`；计费后台接口 timeout 不低于 `5s`。

## Signed HTTP Tunnel

`mode: signed_http_tunnel` 用于转发 TencentCloud SDK 已签名的 HTTP 请求。调用方仍然通过
`/v1/proxy/:route_id/*path` 访问 gateway，但上游 `Host` 只能来自 route/backend 的可信配置，不能来自调用方任意 URL。

```yaml
backends:
  - alias: tcapi-billing-cn-dev
    upstream:
      base_url: "https://billing.dev.tencentcloudapi.com"
      timeout: 10s
      allowed_methods: ["POST"]

routes:
  - id: tcapi-billing-cn-dev
    mode: signed_http_tunnel
    callers: ["shadow"]
    condition: 'request.method == "POST"'
    upstream:
      backend: tcapi-billing-cn-dev
```

Signed tunnel 的转发规则：

- 保留 `Authorization`、`Content-Type`、`X-TC-*`、path、query 和 body。
- 入口请求的 `Host` 是 gateway host；上游请求的 `Host` 从 `base_url` 或 `upstream.headers.Host` 重建。
- `X-CloudLadder-Caller`、`X-CloudLadder-Timestamp`、`X-CloudLadder-Signature`、`X-CloudLadder-Signed-Host`、`X-CloudLadder-Route`、`X-CloudLadder-Request-ID`、`X-Caller`、`X-Service-Name` 不会透传到上游。
- `X-CloudLadder-Signed-Host` 仅用于 gateway 校验原始 TencentCloud host，校验后会被剥离。
- v1 不支持在 `signed_http_tunnel` route 上配置 webhook。

Go SDK 调用方可使用 `pkg/sdktransport` 包装 TencentCloud SDK 的 HTTP transport：

```go
transport, err := sdktransport.New(sdktransport.Options{
    GatewayBaseURL: "https://cloudladdergateway.internal",
    RouteID:        "tcapi-billing-cn-dev",
    Caller:         "shadow",
    Secret:         os.Getenv("CLOUDLADDER_SHADOW_HMAC_SECRET"),
})
if err != nil {
    return err
}

client, err := billingv20180709.NewClient(credential, "ap-guangzhou", profile)
if err != nil {
    return err
}
client.WithHttpTransport(transport)
```

当前示例只包含已确认的 TencentCloud API host：

| alias | Host | 来源 |
| --- | --- | --- |
| `tcapi-account-cn-dev` | `account.dev.tencentcloudapi.com` | SaaS 注册开发联调文档 |
| `tcapi-billing-cn-dev` | `billing.dev.tencentcloudapi.com` | `shadow` 默认 billing API endpoint |
| `tcapi-billing-trade-intl-test` | `billing.dev.tencentcloudapi.com` | 国际站 trade 获取支付链接 `CreatePayUrl` 测试通道 |
| `tcapi-account-cn-test` | `account.test.tencentcloudapi.com` | `shadow/scripts/start-tencent-test.sh` |
| `tcapi-cam-cn-test` | `cam.test.tencentcloudapi.com` | `shadow/scripts/start-tencent-test.sh` |
| `tcapi-sts-cn-test` | `sts.test.tencentcloudapi.com` | `shadow/scripts/start-tencent-test.sh` |
| `tcapi-account-cn-prod` | `account.tencentcloudapi.com` | SaaS 注册/安全手机生产环境 |
| `tcapi-cam-cn-prod` | `cam.tencentcloudapi.com` | SaaS BasicAuth 生产环境 |
| `tcapi-sts-cn-prod` | `sts.tencentcloudapi.com` | SaaS BasicAuth 生产环境 |

## TencentCloud SaaS callback 兼容入口

腾讯 SaaS 接入工具只支持配置固定 callback URL，例如：

```text
http://21.215.157.57:8080/internal/tencentcloud/account
```

这不是 HTTP 302 场景。腾讯会用 `POST` 发送 JSON body，gateway 必须在服务端做 reverse proxy，保留 body、状态码和响应体。

多个 LightVela 环境共用这个入口时，auth 服务必须给 Shadow 用户名和 auth code 加环境前缀。gateway 按前缀选择回调目标，并在转发 `checkSaaSAuthCode` 前移除 auth code 前缀：

| 环境 | Shadow 用户名前缀 | auth code 前缀 | 回调目标 |
| --- | --- | --- | --- |
| 北京主沙箱 | `bjsbx_` | `bjsbx.` | `https://lightclaw.tech` |
| 韩国沙箱 | `krsbx_` | `krsbx.` | `https://api-sandbox-kr-1.lightclaw.tech` |
| 上海生产 | 无（兼容存量） | `shprod.` | `https://api.lightvela.com` |

未匹配前缀的请求继续进入上海生产默认 route，以兼容存量 Shadow 账号。

```yaml
external_routes:
  - path: /internal/tencentcloud/account
    methods: ["POST"]
    route_id: tencentcloud-account-callback-shprod
    upstream_path: /auth/internal/tencentcloud/account
    auth_code_routes:
      - prefix: "bjsbx."
        route_id: tencentcloud-account-callback-bjsbx
      - prefix: "krsbx."
        route_id: tencentcloud-account-callback-krsbx
      - prefix: "shprod."
        route_id: tencentcloud-account-callback-shprod
    user_id_prefix_routes:
      - prefix: "bjsbx_"
        route_id: tencentcloud-account-callback-bjsbx
      - prefix: "krsbx_"
        route_id: tencentcloud-account-callback-krsbx
```

`external_routes` 只注册 exact path，不允许调用方传任意 URL。这个 route 可加入 `auth.allow_unauthenticated`，因为腾讯侧无法生成 CloudLadder HMAC；真实安全边界由固定 upstream 和注入的 `X-Shadow-Callback-Token` 共同保证。北京/上海使用 `CLOUDLADDER_TENCENT_CALLBACK_TOKEN`，韩国使用独立的 `CLOUDLADDER_TENCENT_CALLBACK_KRSBX_TOKEN`；目标 auth 服务中的 `SHADOW_TENCENT_CALLBACK_TOKEN` 必须与对应 route 的 token 一致。

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
