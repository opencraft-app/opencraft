---
stepsCompleted: [step-01-init, step-02-context, step-03-starter, step-04-decisions, step-05-patterns, step-06-structure, step-07-validation, step-08-complete, step-09-change-2026-03-19, step-10-correction-2026-03-19, step-11-testing-2026-03-19]
inputDocuments:
  - _bmad-output/planning-artifacts/prd.md
  - _bmad-output/planning-artifacts/product-brief-mono-2026-03-17.md
  - docs/init.md
  - docs/bmad.md
  - docs/ctl-sandbox-plan-design/sandbox-openapi.yaml
workflowType: 'architecture'
lastStep: 11
status: 'complete'
completedAt: '2026-03-19'
project_name: 'mono'
user_name: 'Mason'
date: '2026-03-19'
changeHistory:
  - date: 2026-03-19
    type: architecture_shift
    summary: 从腾讯云直调架构转型为沙箱服务架构
  - date: 2026-03-19
    type: correction
    summary: 矫正过度设计 — 移除 Template 管理组件、合并 SandboxProvider+适配器为单层、移除不存在的指标 API
  - date: 2026-03-19
    type: enhancement
    summary: 新增 Testcontainers 集成测试架构标准
  - date: 2026-03-21
    type: enhancement
    summary: 补充本地联调真实链路、pool/template 资源模型、镜像运行时契约与调试顺序
---

# Architecture Decision Document

_This document builds collaboratively through step-by-step discovery. Sections are appended as we work through each architectural decision together._

## 架构转型说明（2026-03-19）

**重大变更：** 原架构设计为控制面直接调用腾讯云 API 创建/管理 VPC、CVM、安全组、CLB、COS 等云资源。现改为使用现成的沙箱服务（基于 E2B API）。

**变更影响：**
- 不再需要 VPC/子网/安全组/CLB/COS 适配器
- 异步任务流程大幅简化
- 部分功能不支持（重启、重装系统、命令执行）
- 新增能力（暂停/恢复、超时设置、日志查询）

**矫正说明：**
- Template 管理从控制面移除，改为内部运维/CI 流程
- SandboxProvider 接口层与适配器合并为单层适配器（`pkg/adapter/sandbox/`）
- 移除不存在的单实例指标查询 API

## 架构补充说明（2026-03-21）

### 真实联调拓扑

Story 2.4 的联调表明，当前最稳定的本地调试链路是：

```text
ctl(local:9590)
  -> sandbox adapter
  -> http://127.0.0.1:18081
  -> kubectl port-forward
  -> sandbox-api Service
  -> pool/template
  -> 腾讯云 CVM
  -> sandbox-clientproxy
  -> <private-ip>:49983/health
```

关键结论：

- 本地直连 sandbox 公网 CLB 当前会返回 `502 Server UnReachable`
- 本地到测试集群的稳定联调方式应优先使用 `kubectl port-forward -n sandbox svc/sandbox-api 18081:80`
- `ctl` 本地推荐覆盖：
  - `adapter.sandbox.baseUrl = "http://127.0.0.1:18081"`
  - `api.instance.default_template_id = "pool-bj8"`

### 对 sandbox 资源模型的更新理解

2.4 排障后，对 template/pool 的更准确理解是：

- 每个 pool/template 本质上都是一组固定的云侧下单参数：
  - `vpc_id`
  - `subnet_id`
  - `zone`
  - `base_image`
- 同一 VPC 下，每个可用区都需要独立子网
- 因此一个 template 不是抽象逻辑标签，而是“绑定到特定可用区子网的资源池”

这带来两个现实约束：

- 子网存在，不代表当前账号一定还能在该子网对应可用区买出机器
- 单一 `default_template_id` 在工程上是脆弱的；后续更合理的方向是在 `ctl` 支持候选 template/pool fallback

### 对 sandbox 运行时契约的更新理解

本次还确认了一条关键约束：

- sandbox 不是“任意基础镜像都能工作”的系统
- 当前镜像必须满足运行时契约：
  - 镜像内具备 TAT
  - 镜像内安装并启动 `envd`
  - 实例内提供 `127.0.0.1:49983/health`

当前 sandbox 创建实例后不会自动 bootstrap `envd`。
所以判断镜像是否可用，不能只看 CVM 是否创建成功，而要看该 pool 中实例是否能进入 `CLEAN`。

### 对未来调试最有帮助的排障顺序

后续再遇到 `CreateInstance` 失败时，建议按以下顺序排：

1. 先确认 `ctl` 是否真的走到了目标 sandbox-api 地址
2. 再确认目标 pool 是否有容量，不要先入为主怀疑 `ctl`
3. 若 worker 日志报云侧下单错误，优先检查 pool 绑定的 `zone + subnet_id + vpc_id`
4. 若 CVM 已创建但实例进不了 `CLEAN`，优先检查镜像是否满足 `envd/TAT` 契约
5. 在未完全吃透 sandbox 调度设计前，短期优先在 `ctl` 做兼容适配，不直接修改 sandbox 调度逻辑

---

## Project Context Analysis

### Requirements Overview

**功能需求（19 条，4 个能力域）：**

| 能力域 | 需求范围 | 架构含义 |
|--------|----------|----------|
| 实例生命周期管理（FR1-FR7） | 创建、查询、列表、销毁、暂停、恢复、设置超时 | 核心 CRUD + 沙箱服务集成 |
| 沙箱服务集成（FR8-FR13） | 创建/查询/销毁/暂停/恢复/超时/日志 | 沙箱适配器封装 |
| 配额管理（FR14-FR16） | 配额维护、创建前校验、销毁后释放 | 控制面本地实现 |
| 监控与可观测性（FR17-FR19） | 结构化日志、业务指标、操作历史 | 横切关注点 |

**非功能需求（13 条，关键约束）：**

- **性能**：同步 API P99 ≤ 500ms，实例创建 ≤ 30s（P95），200 并发用户
- **可靠性**：API 99.9% 可用性，沙箱调用最终成功率 ≥ 99%，全幂等
- **安全**：租户数据隔离，API 密钥加密存储，审计日志
- **可扩展性**：无状态 API 水平扩展
- **集成**：沙箱服务 HTTP API 集成，RESTful API 对外

### Scale & Complexity

- **主要技术域**：API Backend / 沙箱服务集成
- **复杂度级别**：中等偏低（架构转型 + 矫正后进一步降低）
- **估计架构组件数**：~6 个核心组件（API 入口 + REST handler + 业务逻辑层 + 沙箱适配器 + 数据访问层 + 配额管理）
- **已有技术栈约束**：Go 1.26、MySQL 8.0、Redis 7.x、标准 REST HTTP（`net/http`）、沙箱服务 HTTP API、Prometheus

### Technical Constraints & Dependencies

| 约束类型 | 详情 |
|----------|------|
| 语言和框架 | Go 1.26，基于 ctl 项目模板改造 |
| 存储 | MySQL 8.0（数据持久化）+ Redis 7.x（缓存/预留未来池化） |
| HTTP 框架 | 标准 REST HTTP（当前实现为 `net/http`） |
| 部署 | TKE（腾讯云容器服务） |
| 外部依赖 | 沙箱服务 HTTP API（基于 E2B API），上层平台鉴权 |
| 测试框架 | testcontainers-go（Docker 容器化集成测试），Go 标准 testing 包 |
| 详细设计文档 | `docs/ctl-sandbox-plan-design/sandbox-openapi.yaml`（沙箱服务 API 定义） |
| 项目结构 | mono repo 下 ctl 目录，单服务架构 |

### Cross-Cutting Concerns Identified

1. **幂等性保证**：创建请求使用 idempotency key，防止重复创建
2. **错误处理与重试策略**：沙箱服务调用失败时自动重试（指数退避）
3. **可观测性**：结构化日志 + Prometheus 指标，贯穿所有组件
4. **配额一致性**：配额扣减与实例创建的原子性保证，防止超卖

---

## Starter Template Evaluation

### Primary Technology Domain

Go API Backend / 沙箱服务集成

### Selected Starter: ctl 项目模板（直接改造）

**Rationale for Selection:**
ctl 是团队内部经过验证的 Go 云服务控制面模板，技术栈与需求匹配。直接改造可以复用成熟的基础设施代码。

**需要的升级和调整：**

- Go 版本：1.20 → 1.26
- MySQL：确认使用 8.0
- Redis：确认使用 7.x
- 新增：沙箱服务 HTTP 客户端

**Architectural Decisions Provided by ctl:**

**语言与运行时：** Go 1.26，TOML 配置两层覆盖

**项目结构：**
- `main/api/` - HTTP API 服务入口
- `main/api/` - REST 路由和 handler
- `pkg/logic/` - 业务逻辑层
- `pkg/model/` - 数据模型（Entity + DAO）
- `pkg/adapter/` - 外部服务适配器

**监控与可观测性：** Prometheus 指标

**开发体验：** TOML 配置管理，标准 REST 路由注册

---

## Core Architectural Decisions

### Decision Priority Analysis

**Critical Decisions (Block Implementation):**
- 沙箱服务集成方式：HTTP API，单层适配器封装
- ORM 框架：GORM
- 幂等性策略：Idempotency Key

**Important Decisions (Shape Architecture):**
- 数据库迁移：golang-migrate
- 日志库：zap
- API 文档：Swagger/OpenAPI 自动生成
- 错误处理：REST 风格统一错误码

### Data Architecture

**ORM 框架：GORM**
- 版本：最新稳定版
- 理由：Go 生态最流行的 ORM，AI 熟悉度极高
- 影响：数据模型层（pkg/model/）全部使用 GORM struct tag 定义

**数据库迁移：golang-migrate**
- 版本：最新稳定版
- 理由：版本化 SQL 迁移，支持 up/down 回滚
- 影响：项目根目录增加 migrations/ 目录

**缓存策略：**
- Redis 预留用于未来池化场景和分布式锁
- MVP 阶段配额管理通过数据库事务保证一致性
- 实例状态：不缓存，实时查沙箱服务或 DB 保证一致性

### Network & Isolation Architecture

**网络隔离由沙箱服务托管**

控制面不直接管理底层网络资源，但调试和 template 选择仍受沙箱底层 VPC/子网/可用区约束。沙箱服务提供：
- 自动网络隔离（每个 Sandbox 独立网络命名空间）
- 控制面运行时无需直接配置 VPC/子网/安全组
- 通过 domain 字段访问沙箱服务入口

### Object Model & Sandbox Adapter

**核心原则：Instance 对应 Sandbox**
- Instance 是产品对象，用户看到和操作的是 OpenClaw 实例
- Sandbox 是沙箱服务中的运行实例，通过 sandbox_id 关联
- 用户不感知底层沙箱细节，仅通过 instance_id 操作

**沙箱适配器（单层封装，pkg/adapter/sandbox/）：**

```go
// SandboxAdapter 封装沙箱服务 HTTP API 调用
// 包含重试、错误处理、日志记录等横切关注点
type SandboxAdapter struct {
    client  *http.Client
    baseURL string
    apiKey  string
    // ...
}

// 沙箱生命周期管理
func (a *SandboxAdapter) CreateSandbox(ctx context.Context, templateID string, opts CreateSandboxOptions) (*Sandbox, error)
func (a *SandboxAdapter) GetSandbox(ctx context.Context, sandboxID string) (*SandboxDetail, error)
func (a *SandboxAdapter) ListSandboxes(ctx context.Context, filter ListSandboxesFilter) ([]ListedSandbox, error)
func (a *SandboxAdapter) DeleteSandbox(ctx context.Context, sandboxID string) error
func (a *SandboxAdapter) PauseSandbox(ctx context.Context, sandboxID string) error
func (a *SandboxAdapter) ResumeSandbox(ctx context.Context, sandboxID string, opts ResumeSandboxOptions) (*Sandbox, error)
func (a *SandboxAdapter) SetTimeout(ctx context.Context, sandboxID string, timeout int32) error
func (a *SandboxAdapter) Refresh(ctx context.Context, sandboxID string, duration int32) error
func (a *SandboxAdapter) GetLogs(ctx context.Context, sandboxID string, opts GetLogsOptions) (*SandboxLogs, error)
```

**说明：** 不再定义 SandboxProvider 接口层。适配器直接作为具体实现被 logic 层调用。如果未来需要替换沙箱服务提供方，可以在此时抽取接口。

**Template 管理：**
- Template 不作为控制面业务组件
- 控制面通过 TOML 配置读取默认 `templateID`
- Template 的创建/构建/删除通过内部运维工具或 CI/CD 流程完成

**实例状态：**
- `Creating` → 创建中（已调用沙箱 API，等待确认）
- `Running` → 实例可正常服务
- `Paused` → 已暂停（节省成本）
- `Failed` → 不可自动恢复错误
- `Deleting` → 销毁中（已调用沙箱 API，等待确认）
- `Deleted` → 已删除

### Authentication & Security

**API 鉴权：上层平台负责（已确定）**
- 控制面接收已鉴权请求，通过 HTTP Header 中的 user_id 标识租户
- 控制面职责：基于 user_id 的资源隔离校验

**敏感信息管理：Kubernetes Secret**
- 沙箱服务 API 密钥通过 K8s Secret 挂载为环境变量或文件
- 配置中不存储任何密钥明文
- 日志中对密钥字段脱敏处理

**审计日志：**
- 所有 API 操作记录审计日志（操作人、操作类型、时间、结果）
- 使用 zap 结构化日志输出

### API & Communication Patterns

**API 版本策略：URL 路径版本**
- 格式：`/v1/instances`、`/v1/quotas`

**错误处理：REST 风格统一错误码**
- HTTP 状态码 + 业务错误码 + 错误消息
- 格式：`{"code": "QUOTA_EXCEEDED", "message": "用户实例配额已满", "request_id": "xxx"}`

**API 文档：Swagger/OpenAPI 自动生成**
- 使用 swag 工具从代码注释生成 OpenAPI spec
- 提供 Swagger UI 开发环境访问

**沙箱服务通信：HTTP API**
- 控制面通过沙箱适配器调用沙箱服务 API
- 调用失败时自动重试（指数退避，最大 3 次）
- 使用 idempotency key 保证创建请求幂等

### Infrastructure & Deployment

**部署平台：TKE（已确定）**
- 单个 Deployment：api
- 无状态 API 服务支持水平扩展

**配置管理：TOML 两层覆盖（ctl 已有）**
- 基础配置：conf/server/common/server_conf.toml
- 环境覆盖：conf/server/{env}/server_conf.toml
- 敏感配置：Kubernetes Secret 注入环境变量
- 沙箱服务 templateID 配置在 TOML 中
- 本地联调推荐通过 rewrite 覆盖将 sandbox baseUrl 指向本地 `port-forward`

**日志方案：zap（替换 golog）**
- 理由：Go 生态标准结构化日志库，性能最优
- 输出格式：JSON（生产环境）/ Console（开发环境）
- 必带字段：trace_id、action、user_id（如有）

**监控方案：Prometheus（已确定）**
- 业务指标：创建成功率、实例状态分布、配额使用率、沙箱调用延迟

---

## Implementation Patterns & Consistency Rules

### Naming Patterns

**数据库命名约定：**
- 表名：snake_case 复数形式（`instances`、`tasks`、`quotas`）
- 列名：snake_case（`user_id`、`sandbox_id`、`created_at`）
- 索引：`idx_{表名}_{列名}`

**API 命名约定：**
- 端点：复数名词（`/v1/instances`、`/v1/quotas`）
- 路由参数：`{id}` 格式
- 查询参数：snake_case

**Go 代码命名约定（遵循 Effective Go）：**
- 包名：短、简洁、全小写（`model`、`logic`、`adapter`）
- 文件名：snake_case（`instance_logic.go`、`sandbox_adapter.go`）
- 结构体：PascalCase（`Instance`、`SandboxAdapter`）
- 方法/函数：PascalCase 导出，camelCase 私有
- 变量：camelCase，缩写词全大写（`instanceID`、`sandboxID`）
- `context.Context` 永远是函数第一个参数，`error` 永远是最后一个返回值

### Structure Patterns

**项目组织：**
- `pkg/model/` - 一个实体一个子目录
- `pkg/logic/` - 一个业务域一个子目录
- `pkg/adapter/` - 一个外部服务一个子目录
- `main/api/` - REST handler 与路由
- `pkg/errcode/` - 统一错误码定义
- `migrations/` - golang-migrate SQL 迁移文件

### Format Patterns

**API Response 格式：**

成功响应：
```json
{
  "instance_id": "ins-xxx",
  "sandbox_id": "sbx-xxx",
  "status": "Running",
  "created_at": "2026-03-21T01:23:45+08:00",
  "timeout_at": "2026-03-21T02:23:45+08:00"
}
```

错误响应：
```json
{
  "code": "INSTANCE_QUOTA_EXCEEDED",
  "message": "user instance quota exceeded",
  "request_id": "req-xxx"
}
```

### Process Patterns

**错误处理模式：**
- 业务错误：返回自定义错误码 + 友好消息
- 系统错误：记录 Error 日志 + 返回通用 5xx 错误
- 沙箱服务错误：封装为统一错误类型，记录原始错误到日志

**幂等性实现模式：**
- 创建类操作：使用 idempotency key
- 查询/删除：天然幂等
- 暂停/恢复/设置超时：幂等操作

**重试策略模式：**
- 沙箱服务调用失败时自动重试
- 默认重试：3 次，指数退避（1s、2s、4s）
- 可配置项：`max_retries`、`retry_interval`、`retry_backoff`

**配额管理模式：**
- 创建前：检查配额 + 预扣配额（事务内）
- 创建成功：配额保持扣减
- 创建失败：释放预扣配额
- 销毁成功：释放配额

### Testing Standards

**集成测试架构：Testcontainers-go**

项目使用 [testcontainers-go](https://golang.testcontainers.org/) 实现基于真实数据库的集成测试，替代 mock/内存数据库方案，确保测试行为与生产环境一致。

**核心原则：**
- 集成测试使用真实 MySQL 8.0 容器，而非 SQLite 或 mock
- 测试容器生命周期由 `TestMain` 管理，整个包共享一个容器实例
- 每个测试用例执行前清空表数据（TRUNCATE），保证测试隔离
- 数据库迁移文件复用 `migrations/` 目录，确保 schema 与生产一致
- 集成测试使用 `//go:build integration` 构建标签，与单元测试分离

**测试工具层（`test/testutil/`）：**

| 文件 | 职责 |
|------|------|
| `docker.go` | Docker 环境检测、容器健康检查 |
| `mysql.go` | MySQL testcontainer 启动/关闭、DSN 生成、GORM 连接 |
| `migrate.go` | 自动执行 golang-migrate 迁移，确保 schema 最新 |
| `cleanup.go` | 表数据清理（TRUNCATE），测试间隔离 |

**测试生命周期：**
```
TestMain(m *testing.M)
  ├── SetupMySQLContainer()     // 启动 MySQL 容器
  ├── RunMigrations()           // 执行数据库迁移
  ├── m.Run()                   // 运行所有测试
  └── TeardownContainer()       // 销毁容器

每个 TestXxx(t *testing.T)
  ├── TruncateTables()          // 清空数据，隔离测试
  └── 执行测试逻辑
```

**运行方式：**
```bash
# 运行集成测试（需要 Docker）
go test -tags=integration ./test/...

# 运行单元测试（无需 Docker）
go test ./pkg/...
```

**测试覆盖要求：**
- Model/DAO 层：CRUD 操作、边界条件、并发安全（如配额原子操作）
- Logic 层：业务逻辑、多租户隔离、幂等性
- 数据库约束：唯一索引冲突、外键约束、软删除行为

---

## Project Structure & Boundaries

### Complete Project Directory Structure

```
ctl/
├── go.mod                                    # module ctl, Go 1.26
├── go.sum
├── Makefile                                  # build-api
├── Dockerfile
├── README.md
├── .gitignore
├── .golangci.yml
│
├── conf/
│   ├── server/
│   │   ├── common/
│   │   │   └── server_conf.toml              # 基础配置（含默认 templateID）
│   │   └── rewrite/
│   │       └── .gitkeep                      # 环境覆盖配置
│   └── rigger/                               # Rigger 模板引擎配置
│
├── migrations/                               # golang-migrate SQL 迁移文件
│   ├── 000001_create_instances.up.sql
│   ├── 000001_create_instances.down.sql
│   ├── 000002_create_quotas.up.sql
│   ├── 000002_create_quotas.down.sql
│   ├── 000003_create_tasks.up.sql
│   └── 000003_create_tasks.down.sql
│
├── main/
│   ├── api/
│   │   ├── main.go                           # API 服务入口
│   │   └── server.go                         # 服务器配置
│   └── common/
│       └── common.go                         # 共享初始化
│
├── pkg/
│   │
│   ├── config/                               # 配置管理
│   │   ├── config.go
│   │   └── define.go
│   │
│   ├── context/                              # 请求上下文
│   │   └── context.go
│   │
│   ├── resource/                             # 资源初始化
│   │   ├── log.go                            # zap 日志初始化
│   │   ├── mysql.go                          # GORM 连接初始化
│   │   └── redis.go                          # Redis 连接初始化
│   │
│   ├── errcode/                              # 统一错误码
│   │   ├── errcode.go
│   │   ├── instance.go
│   │   └── quota.go
│   │
│   ├── model/                                # 数据模型层（GORM）
│   │   ├── factory/
│   │   │   └── factory.go
│   │   ├── common.go
│   │   │
│   │   ├── instance/                         # 实例模型
│   │   │   ├── entity.go                     # Instance struct
│   │   │   └── dao.go                        # CRUD 方法
│   │   │
│   │   ├── quota/                            # 配额模型
│   │   │   ├── entity.go
│   │   │   └── dao.go
│   │   │
│   │   └── task/                             # 任务模型（操作记录）
│   │       ├── entity.go
│   │       └── dao.go
│   │
│   ├── logic/                                # 业务逻辑层
│   │   ├── factory/
│   │   │   └── factory.go
│   │   │
│   │   ├── instance/                         # 实例业务逻辑
│   │   │   ├── logic.go                      # 创建/查询/销毁/暂停/恢复
│   │   │   └── common.go
│   │   │
│   │   └── quota/                            # 配额管理逻辑
│   │       └── logic.go
│   │
│   ├── adapter/                              # 外部服务适配器
│   │   ├── factory/
│   │   │   └── adapter.go
│   │   │
│   │   └── sandbox/                          # 沙箱服务适配器（单层封装）
│   │       ├── adapter.go                    # HTTP 客户端 + 业务方法
│   │       ├── types.go                      # 请求/响应类型定义
│   │       └── adapter_test.go
│   │
│   ├── transport/                            # HTTP 响应结构体
│   │   ├── common.go
│   │   └── instance.go
│   │
│   ├── metric/                               # Prometheus 指标
│   │   ├── api.go
│   │   ├── sandbox.go
│   │   └── instance.go
│   │
│   └── util/                                 # 工具函数
│       ├── misc.go
│       ├── time.go
│       └── request/
│           └── request.go
│
└── test/                                     # 集成测试（//go:build integration）
    ├── common.go
    ├── testutil/                              # Testcontainers 测试工具
    │   ├── docker.go                          # Docker 环境检测
    │   ├── mysql.go                           # MySQL 容器管理 + GORM 连接
    │   ├── migrate.go                         # golang-migrate 自动迁移
    │   └── cleanup.go                         # 表数据清理（TRUNCATE）
    ├── model/                                 # DAO 层集成测试
    │   ├── instance/dao_test.go
    │   └── quota/dao_test.go
    ├── adapter/
    │   └── sandbox/adapter_test.go
    └── logic/
        ├── instance/logic_test.go
        └── quota/logic_test.go
```

### Architectural Boundaries

**API Boundaries：**
- 外部 API：`/v1/instances/*`、`/v1/quotas` — 上层 Coding Plan 平台调用
- 内部通信：API → 沙箱服务 HTTP API
- 数据库：只有 model 层直接访问 MySQL，logic 层通过 DAO 方法操作

### Requirements to Structure Mapping

**FR 需求 → 目录映射：**

| 需求域 | 核心目录 |
|--------|----------|
| 实例生命周期（FR1-FR7） | main/api/、logic/instance/、model/instance/、adapter/sandbox/ |
| 沙箱服务集成（FR8-FR13） | adapter/sandbox/ |
| 配额管理（FR14-FR16） | logic/quota/、model/quota/ |
| 监控可观测性（FR17-FR19） | metric/、resource/log.go |

### Data Flow

**实例创建数据流：**
```
上层平台 → API(handler) → logic/instance
  → 检查配额(quota) → 标记 Creating 状态(model/instance)
  → 调用沙箱服务(adapter/sandbox)
  → 成功：更新为 Running / 失败：更新为 Failed + 释放配额
  → 返回实例信息
```

**实例销毁数据流：**
```
上层平台 → API(handler) → logic/instance
  → 标记 Deleting 状态(model/instance)
  → 调用沙箱服务销毁(adapter/sandbox)
  → 更新为 Deleted → 释放配额(quota)
```

---

## Architecture Validation Results

### Coherence Validation

**Decision Compatibility：**
- Go 1.26 + GORM + zap + Redis 7.x + MySQL 8.0：版本间无冲突
- 沙箱服务 HTTP API 集成：标准 HTTP 客户端，单层适配器

**Pattern Consistency：**
- 命名约定：数据库 snake_case、Go 代码 Effective Go 标准、API JSON snake_case
- 分层架构：Handler → Logic → Model/Adapter，数据流单向清晰

### Requirements Coverage Validation

**功能需求覆盖（19/19）：**

| FR 范围 | 覆盖 | 对应架构组件 |
|---------|------|-------------|
| FR1-FR7（实例生命周期） | 覆盖 | main/api/ + logic/instance/ + adapter/sandbox/ |
| FR8-FR13（沙箱服务集成） | 覆盖 | adapter/sandbox/ |
| FR14-FR16（配额管理） | 覆盖 | logic/quota/ + model/quota/ |
| FR17-FR19（监控可观测性） | 覆盖 | metric/ + resource/log.go |

### Architecture Readiness Assessment

**Overall Status:** READY FOR IMPLEMENTATION

**Confidence Level:** HIGH

**Key Strengths:**
1. 架构复杂度低（单层适配器，无冗余抽象）
2. 沙箱服务提供成熟的网络隔离和资源调度
3. 控制面职责清晰（配额 + 实例记录 + 沙箱 API 调用）
4. 完整的 FR/NFR 覆盖

**First Implementation Priority：**
1. Go 1.26 升级 + go.mod 依赖更新
2. GORM 集成 + 数据模型定义（Instance/Quota/Task）
3. zap 日志库替换
4. 沙箱服务适配器实现
5. 核心业务模块实现（实例创建/查询/销毁）

---

## 本地联调开发指南

本地开发环境搭建和联调测试方案请参考：**`docs/ctl-dev-setup/README.md`**

包含：
- 本地依赖启动（MySQL + Redis via Docker Compose）
- ctl API 服务启动方式
- Sandbox `port-forward` 联调配置
- 可用 template（pool）列表
- 本地回归脚本
- pool/template 与 VPC/子网/可用区的真实关系
- 镜像运行时契约（`envd` / TAT / `49983/health`）
- 密码加密工具使用
- 常见问题排查
