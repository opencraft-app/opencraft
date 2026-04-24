# AI Gateway Agent Guide

本文档适用于开发 `ai-gateway/` 子项目时参考。开发前请先阅读本文档。

## 项目概述

AI Gateway 是一个 OpenAI 兼容的 API 代理服务，提供 token 计费、限流、多 provider 支持等功能。

**技术栈**: Go + Gin + PostgreSQL + Redis

> **Note**: 本项目通过根目录的 `go.work` 与 mono repo 中其他 Go 项目进行工作区管理。

## 构建与运行

### 一键启动（推荐）

在项目根目录运行，同时启动 Portkey Gateway + AI Gateway 后端 + Dashboard 前端：

```bash
# 后台启动所有服务（日志输出到 logs/ 目录）
make dev

# 前台启动（可看到实时日志，Ctrl+C 停止全部）
make dev-fg

# 停止所有后台服务
make stop
```

单独启动某个服务：

```bash
make backend              # 只启动 AI Gateway 后端 + Portkey (端口 18080 + 18787)
```

### 进入 ai-gateway 目录操作

```bash
cd ai-gateway

# Build
make build                # → bin/ai-gateway

# Local dev — 自动启动 Portkey Gateway + Go 后端 + Dashboard（推荐）
make dev                  # Portkey(8787后台) + Dashboard(13000后台) + Go后端(18080前台), Ctrl+C 自动停止二者

# 只启动 Go 后端（不含 Portkey）
make dev-only             # 仅 go run ./cmd/server

# Run (requires PostgreSQL, Redis, Portkey running)
make run                  # go run ./cmd/server

# Portkey 管理
make portkey              # 前台启动 Portkey Gateway (自动检测安装)
make portkey-ensure       # 只检测/安装 @portkey-ai/gateway
make stop                 # 停止后台 Portkey 进程

# Tests
make test                 # go test ./... -v -count=1
go test ./internal/service/... -v -count=1 -run TestBilling  # single test

# Infrastructure (Docker)
make docker-up            # starts postgres, redis, portkey, ai-gateway
make docker-down

# Database migrations (requires golang-migrate CLI)
make migrate-up           # DATABASE_URL must be set
make migrate-down

# Swagger docs regeneration
make swagger              # swag init -g cmd/server/main.go -o docs
```

### Portkey Gateway

Portkey Gateway 现在由 `ai-gateway/` 自己维护（`ai-gateway/package.json` + `ai-gateway/patches/`），本地 `make portkey` / `make dev` 会自动安装并使用带 patch 的 `@portkey-ai/gateway`。不要再依赖 `gateway-dashboard` 的 `node_modules` 承载流式修复。

## 架构

### 分层架构

```
cmd/server/main.go        → entry point, wiring
internal/
  config/                  → YAML config with env var overrides
  router/                  → Gin route registration, middleware chain setup
  handler/                 → HTTP handlers (AdminHandler, ProxyHandler, HealthHandler, UserSelfHandler)
  middleware/              → auth, admin_auth, model_auth, billing, ratelimit, logging, max_body_size
  service/                 → business logic (billing, provider selection, provisioning, CRUD)
  repository/              → GORM-based data access (one repo per domain entity)
  model/                   → GORM models + domain errors
  pkg/                     → shared utilities (crypto, redisclient, response helpers)
  scheduler/               → background jobs (subscription expiry)
deploy/                    → Dockerfile, docker-compose.yml, config.yaml
migrations/                → PostgreSQL migrations (golang-migrate format)
```

### 请求流程

**Proxy 端点** (`/v1/chat/completions`, 等):
Auth middleware (API key → user+subscription+plan lookup via Redis cache) → RateLimiter → BillingCheck → ModelAuth → ProxyHandler → reserve tokens → forward to Portkey gateway → settle billing with actual usage.

**Admin API** (`/api/admin/*`): Protected by admin token + optional IP whitelist. Full CRUD for users, plans, providers, API keys, subscriptions. One-shot `/provision` endpoint creates user + subscription + API key.

### 关键模式

- Provider keys are AES-256 encrypted at rest (`internal/pkg/crypto`)
- API key auth uses SHA-256 hash lookup with Redis caching (5-min TTL)
- Token billing uses reserve-then-settle: pre-deducts estimated tokens, refunds/charges difference after response
- Streaming responses (SSE) extract usage from the final chunk
- `providerTypeFromModel()` maps model name prefixes to provider types (openai, deepseek, qwen, anthropic)
- Config: YAML file (`deploy/config.yaml`) with env var overrides for `ENCRYPTION_KEY`, `ADMIN_TOKEN`, `DATABASE_URL`, `REDIS_ADDR`, `PORTKEY_BASE_URL`

### 数据库 Schema

PostgreSQL with 7 tables: `users`, `plans`, `subscriptions`, `providers`, `api_keys`, `usage_logs` (partitioned by month), `admin_audit_logs`. All primary keys are UUIDs.

`providers` 除了 `provider_type` 和 `supported_models` 外，还包含 `model_discovery_protocol`，用于 Dashboard 侧的模型发现与真实调用验证；路由选择仍以 `provider_type + supported_models` 为主。

## 环境变量

| Variable | Required | Purpose |
|---|---|---|
| `ENCRYPTION_KEY` | Yes | 32-byte AES-256 key for provider API key encryption |
| `ADMIN_TOKEN` | Yes | Admin API authentication |
| `DATABASE_URL` | No | Overrides config.yaml DSN |
| `REDIS_ADDR` | No | Overrides config.yaml Redis address |
| `CONFIG_PATH` | No | Config file path (default: `deploy/config.yaml`) |

## 高峰可用性相关配置

- `gateway.max_inflight_budget`: 单实例代理请求在途预算；`0` 表示不限制
- `gateway.stream_request_weight` / `gateway.non_stream_request_weight`: 流式与普通请求占用的预算权重
- `gateway.overload_status_code`: 预算耗尽时返回的状态码，默认 `503`
- `provider_cooldown.default_429_ttl_s`: provider+model 命中 `429` 后的默认冷却时间
- `provider_cooldown.max_429_ttl_s`: `Retry-After` 上限，避免异常长时间摘除

## Go Module Path

Go module 使用 `git.woa.com/wisp/mono/ai-gateway` — 所有 internal imports 使用此前缀。

## ⚠️ 重要提醒

项目数据库和 redis 均为云端服务！不要连接本地服务！！！

## 开发原则

### 1. 对外用户标识统一使用 `user_id`

- 对外 admin / internal 接口统一暴露业务侧 `user_id`
- 不要在新代码里重新引入 `external_uid` 命名
- 数据库当前仍复用 legacy `external_uid` 列承载业务 `user_id`，这是存储细节，不是对外契约
- 如果 merge 后同时出现 `GetByUserID(...)` 和 `GetByExternalUID(...)`，基本就是把旧语义混回来了，要优先清掉

这次真实踩坑就是：

- `internal/handler/internal.go` 在合并后又回到了 `external_user_id` / `ExternalUID`
- 结果 handler 直接编译失败，且会把已经统一好的 `user_id` 语义重新撕裂

### 2. `stream=true` 的外部契约比“上游是不是原生流式”更重要

当前 live 策略不是“强依赖上游原生 SSE”，而是：

- 对客户端仍然提供 OpenAI 风格 `text/event-stream`
- 上游 provider / Portkey 如果流式链路不稳定，允许在网关内部降级为非流式请求
- 然后由 ai-gateway 本地重新合成 SSE 返回给客户端

这条原则很重要，因为 OpenClaw 真正在意的是：

- 返回头必须是 `Content-Type: text/event-stream`
- body 里必须有合法 `data: ...` 事件
- 结尾必须有 `data: [DONE]`

不要把“上游请求体里 `stream` 是 true 还是 false”误当成最终正确性的标准。

### 3. Synthetic SSE 不能丢 `tool_calls` 和 `reasoning_content`

这是这轮最关键的坑。

如果 `stream=true` 经过 ai-gateway 合成 SSE，delta 里必须保留：

- `role`
- `content`
- `reasoning_content`
- `tool_calls`

否则 OpenClaw 会出现这种假象：

- 模型看起来已经决定要调用工具
- 但 agent 收不到完整工具参数
- 最终停在 `toolUse`，没有 `toolResult`，也没有最终回复

后续如果改 streaming 逻辑，至少要重新验证：

- `stream=true` 普通对话返回 200 + SSE + `[DONE]`
- `stream=true + tools` 返回的 SSE 中能看到 `delta.tool_calls`
- `finish_reason` 能正确返回 `tool_calls` 或 `stop`

### 4. 流式测试要校验“客户端契约”，不要把内部实现写死

现在集成测试已经收敛到新的真实约束：

- 上游 mock 可以收到 `stream=false`
- 但客户端仍然必须收到 SSE
- 计费、provider 解析、usage 提取仍然要正确

所以写测试时：

- 可以断言响应头、SSE 事件、`[DONE]`、usage、tool_calls
- 不要把“upstream 一定收到 `stream=true`”写成硬约束
- 不要把“truncated upstream SSE 一定导致客户端没有 `[DONE]`”写成硬约束

因为在 synthetic streaming 模式下，这些都已经不是稳定真相了。

### 5. 测试环境部署不要写死旧 workload 名

当前测试环境 live 拓扑是：

- `gateway-backend`：容器 `aigateway` + `portkey`
- `gateway-dashboard`

不是旧的：

- `aigateway`
- 独立 `portkey`

所以部署脚本、rollout 检查、镜像切换都必须基于 live workload 名写。否则镜像已经推上去了，脚本最后一步还是会因为 patch 不到对象而 404。

涉及测试环境发布时，再看：

- [ai-gateway-deploy-guide.md](../deploy-guides/ai-gateway-deploy-guide.md)

### 6. 生成物升级要检查依赖是否一起升级

这次 merge 里还有一个很隐蔽的坑：

- `docs/docs.go` 已经切到了 `github.com/swaggo/swag/v2`
- 但 `go.mod` 还停在 `github.com/swaggo/swag v1`

结果是：

- 代码表面看起来没问题
- 一到 `go build ./cmd/server` 或 Docker build 才会炸

所以只要动了 Swagger 生成物，就要顺手检查：

- `docs/docs.go` 的 import
- `go.mod` / `go.sum` 的 swag 版本
- `make swagger`
- `go build ./cmd/server`

### 7. 测试环境联调时，`admin/provision` 最好显式传唯一手机号

测试环境当前仍有 legacy `users.phone_hash` 唯一约束副作用。

如果直接调用 `/api/admin/provision` 且不传 `phone`，可能会撞到：

- `Duplicate entry '' for key 'users.phone_hash'`

这不是本轮 streaming 主问题，但会干扰联调。测试环境手工 provision 时，建议传一个唯一手机号绕过去。

## 最小回归清单

改动 `ai-gateway` 数据面后，至少做这组检查：

```bash
cd ai-gateway
go test ./internal/handler/... ./internal/middleware/... ./internal/service/... -count=1
go test ./test/integration/... -count=1
go build ./cmd/server
```

如果改动涉及 streaming / tools，再额外做 live 验证：

- `stream=true` 返回 `200 + text/event-stream + [DONE]`
- `stream=true + tools` 返回的 SSE 中能看到 `tool_calls`
- OpenClaw/调用方不再出现 `500 status code (no body)` 或停在 `toolUse` 无后续结果
