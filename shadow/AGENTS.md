# AGENTS.md

本项目是用于 Tencent Cloud shadow-account 集成的 Go 单服务脚手架。

## 目标

该服务建模 SaaS 产品的 Level2 shadow-account 流程：

- 发送注册用 SMS verify code
- 注册 Tencent Cloud shadow account
- 使用一次性 `auth_code` 交换 SaaS token 和 temporary credential
- 保存 basic auth
- 创建 free-trial order 并构造 payment / console redirect
- 当 `SHADOW_BILLING_MODE=http` 时调用真实 dianshi / billing endpoint
- 以 rollback 语义更新 shadow-account phone number
- 暴露用于验证 `user_id` 和 `auth_code` 的 Tencent Cloud internal callback endpoint

## 当前状态

- 该服务可在本地运行。
- 默认模式为 `fake`，无需真实 Tencent Cloud 凭据即可进行本地验证。
- Tencent Cloud provider 已通过内部 `tencentcloud-sdk-go` 完成 wiring。
- HTTP billing provider 已实现，可调用真实 dianshi / billing endpoint。
- Storage 在 interface 层可插拔；内置实现为 `sqlite`。

## 重要文件

- `cmd/shadowd/main.go`：process entrypoint
- `internal/app`：dependency wiring
- `internal/platform`：Tencent Cloud `account` / `cam` / `sts` adapter
- `internal/shadow`：核心 registration、token、redirect、callback orchestration
- `internal/httpapi`：external API 和 internal callback handler
- `internal/billing`：billing abstraction、fake implementation 和真实 HTTP adapter
- `internal/mockcloud`：用于 black-box e2e test 的 mock official backend
- `internal/storage`：storage contract 和 shared record
- `internal/storage/sqlite`：SQLite 支撑的 persistent store
- `ARCHITECTURE.md`：architecture design
- `README.md`：runbook 和 verification step

## 运行方式

默认 local mode：

```bash
cd /Users/skipzhang/code/shadow
make build
./bin/shadowd
```

运行测试：

```bash
cd /Users/skipzhang/code/shadow
go test ./...
```

## 环境

支持的 environment variable 见 `.env.example`。

关键变量：

- `SHADOW_STORAGE_DRIVER=sqlite`
- `SHADOW_STORAGE_DSN`
- `SHADOW_PROVIDER=fake|tencent`
- `SHADOW_PROVIDER=fake|mock|tencent`
- `SHADOW_BILLING_MODE=fake|http`
- `SHADOW_PLATFORM`
- `SHADOW_SECRET_ID`
- `SHADOW_SECRET_KEY`
- `SHADOW_ACCOUNT_ENDPOINT`
- `SHADOW_CAM_ENDPOINT`
- `SHADOW_STS_ENDPOINT`
- `SHADOW_BILLING_ENDPOINT`
- `SHADOW_DIANSHI_ENDPOINT`
- `SHADOW_BILLING_RECOVERY_ENDPOINT`
- `SHADOW_FREE_TRIAL_ACTIVITY_ID`
- `SHADOW_FREE_TRIAL_ACT_ID`
- `SHADOW_CALLBACK_TOKEN`

Tencent Cloud test endpoint 未写入 config default。使用 `scripts/start-tencent-test.sh`，或显式设置 endpoint env var。启动脚本会运行 `make build` 并启动 `./bin/shadowd`。

Deployment build：

```bash
cd /Users/skipzhang/code/shadow
make build-linux-amd64
```

## Internal SDK 说明

内部 Tencent Cloud Go SDK 依赖一个在当前环境中不可用的 Polaris module。为保持项目可构建，`third_party/polaris-go-v2` 提供了本地 stub module，`go.mod` 使用该本地 stub 替换原始 dependency。

除非 build environment 中已提供真实 internal Polaris dependency，否则不得移除该 replace rule。

## 扩展本项目时

- 保持 public HTTP contract 与 Tencent Cloud shadow-account callback protocol 一致。
- 优先在 `internal/platform` interface 之后实现新的 Tencent Cloud integration。
- 将真实 billing behavior 置于 `internal/billing.Provider` 之后。
- 将 storage implementation 置于 `internal/storage.Store` 之后，避免 business layer 依赖特定 database。
