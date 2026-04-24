---
stepsCompleted: [step-01-validate-prerequisites, step-02-design-epics, step-03-create-stories, step-04-final-validation, step-05-change-2026-03-19, step-06-correction-2026-03-19]
inputDocuments:
  - _bmad-output/planning-artifacts/prd.md
  - _bmad-output/planning-artifacts/architecture.md
  - docs/ctl-sandbox-plan-design/sandbox-openapi.yaml
changeHistory:
  - date: 2026-03-19
    type: architecture_shift
    summary: 从腾讯云直调架构转型为沙箱服务架构，Epic/Story 全面重构
  - date: 2026-03-19
    type: correction
    summary: 矫正过度设计 — 移除 Template 管理 Epic、合并适配器 Story、移除不存在的指标 API Story
---

# mono (OpenClaw SaaS 控制面) - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for mono (OpenClaw SaaS 控制面), decomposing the requirements from the PRD and Architecture into implementable stories.

**架构转型说明（2026-03-19）：** 原方案为控制面直接调用腾讯云 API 管理云资源，现改为使用沙箱服务。

**矫正说明（2026-03-19）：** 移除 Template 管理 Epic（改为内部运维），合并冗余的适配器/Provider Story，移除不存在的指标查询 API。最终结构为 3 Epic / 8 Story。

## Requirements Inventory

### Functional Requirements

**实例生命周期管理：**
- FR1: 上层系统可通过 API 为指定用户创建 OpenClaw 实例（调用沙箱服务）
- FR2: 上层系统可查询指定实例的详细信息和当前状态
- FR3: 上层系统可查询指定用户的所有实例列表
- FR4: 上层系统可销毁指定实例
- FR5: 上层系统可暂停指定实例（节省资源成本）
- FR6: 上层系统可恢复已暂停的实例
- FR7: 上层系统可设置实例的超时时间（自动过期）

**沙箱服务集成：**
- FR8: 系统调用沙箱服务 API 创建 Sandbox 实例
- FR9: 系统调用沙箱服务 API 查询 Sandbox 状态和列表
- FR10: 系统调用沙箱服务 API 销毁 Sandbox 实例
- FR11: 系统调用沙箱服务 API 暂停/恢复 Sandbox 实例
- FR12: 系统调用沙箱服务 API 设置 Sandbox 超时和刷新存活时间
- FR13: 系统调用沙箱服务 API 查询 Sandbox 日志

**配额管理：**
- FR14: 系统维护每个用户的实例配额（最大实例数）
- FR15: 创建实例前检查用户配额，超限拒绝创建
- FR16: 实例销毁后自动释放配额

**监控与可观测性：**
- FR17: 系统记录所有 API 请求的结构化日志
- FR18: 系统暴露关键业务指标
- FR19: 系统支持查询实例的操作历史记录

### NonFunctional Requirements

**性能：**
- NFR1: 同步 API 端点 P99 响应时间 ≤ 500ms
- NFR2: 实例创建端到端耗时 ≤ 30 秒（P95）
- NFR3: 系统支持 200 个并发用户的实例管理操作

**可靠性：**
- NFR4: API 可用性 ≥ 99.9%
- NFR5: 沙箱服务调用失败后自动重试，最终成功率 ≥ 99%
- NFR6: 所有沙箱服务调用保证幂等性

**安全：**
- NFR7: 租户间数据隔离
- NFR8: 沙箱服务 API 密钥加密存储
- NFR9: 所有操作记录审计日志

**可扩展性：**
- NFR10: 架构设计支持水平扩展
- NFR11: 数据模型预留池化扩展点

**集成：**
- NFR12: 通过 HTTP API 集成沙箱服务
- NFR13: 提供标准 RESTful API

### Additional Requirements

**从 Architecture 提取的技术需求：**

- AR1: 基于 ctl 项目模板改造，Go 版本从 1.20 升级到 1.26
- AR2: 集成 GORM 作为 ORM 框架
- AR3: 集成 golang-migrate 管理数据库迁移
- AR4: 使用 zap 替换 golog 作为日志库
- AR5: 实现沙箱服务 HTTP 适配器（单层封装）
- AR6: 实现统一错误码包（pkg/errcode/）

### FR Coverage Map

| FR | Epic | 简述 |
|----|------|------|
| FR1 | Epic 1 | 创建实例 |
| FR2 | Epic 1 | 查询实例详情 |
| FR3 | Epic 1 | 查询实例列表 |
| FR4 | Epic 2 | 销毁实例 |
| FR5 | Epic 2 | 暂停实例 |
| FR6 | Epic 2 | 恢复实例 |
| FR7 | Epic 2 | 设置超时 |
| FR8-FR13 | Epic 1,2 | 沙箱服务集成 |
| FR14 | Epic 1 | 配额维护 |
| FR15 | Epic 1 | 创建前配额校验 |
| FR16 | Epic 2 | 销毁后配额释放 |
| FR17 | Epic 3 | 结构化日志 |
| FR18 | Epic 3 | 业务指标 |
| FR19 | Epic 3 | 操作历史 |

## Epic List

### Epic 1: 实例创建与查询（核心路径）

上层系统可以为用户创建 OpenClaw 实例（调用沙箱 API）、查询实例状态和列表。用户完成"从无实例到拥有可用实例"的核心旅程。包含所有必要的基础设施搭建作为前置 Story。

**FRs:** FR1, FR2, FR3, FR8, FR9, FR14, FR15
**ARs:** AR1-AR6

### Epic 2: 实例生命周期管理

上层系统可以销毁、暂停、恢复实例，设置超时。系统自动管理配额释放。用户获得完整的实例生命周期管理能力。

**FRs:** FR4, FR5, FR6, FR7, FR10, FR11, FR12, FR16

### Epic 3: 可观测性

运维团队获得完整的监控和审计能力。系统暴露业务指标，记录操作历史，支持沙箱日志查询。

**FRs:** FR13, FR17, FR18, FR19
**NFRs:** NFR9

---

## Epic 1: 实例创建与查询（核心路径）

上层系统可以为用户创建 OpenClaw 实例（调用沙箱 API）、查询实例状态和列表。用户完成"从无实例到拥有可用实例"的核心旅程。

### Story 1.1: 项目基础设施搭建

**Status: COMPLETED** — 已在 ctl 项目模板中实现，无需额外开发。

As a 开发团队成员,
I want 在升级后的技术栈上拥有完整的开发基础（Go 1.26、GORM、golang-migrate、zap、统一错误码）,
So that 后续业务模块可以在一致的基础设施上快速开发。

**已验证完成项：**
- Go 1.26：go.mod 已配置
- GORM：pkg/resource/mysql.go 已初始化，含 BaseEntity/BaseDao 基类
- golang-migrate：migrations/ 目录 + Makefile target（migrate-up/migrate-down）已就绪
- zap：pkg/resource/log.go 已替换，支持开发（Console）/生产（JSON）双模式
- 统一错误码：pkg/errcode/ 完整（errcode.go + instance.go + quota.go 等）
- Redis：pkg/resource/redis.go 已集成 go-redis/v9

**ARs:** AR1, AR2, AR3, AR4, AR6

---

### Story 1.2: 实例数据模型与配额模型

As a 开发团队成员,
I want 定义 Instance 和 Quota 的 GORM 数据模型、DAO 层,
So that 实例生命周期和配额管理有完整的数据基础。

**Acceptance Criteria:**

**Given** 需要 Instance 数据模型
**When** 创建 pkg/model/instance/entity.go
**Then** Instance struct 包含字段：id、instance_id（业务ID）、user_id、sandbox_id、status、created_at、updated_at、deleted_at
**And** 使用 GORM tags 显式指定列名（snake_case）
**And** status 字段使用常量定义：Creating、Running、Paused、Failed、Deleting、Deleted

**Given** 需要 Instance DAO 层
**When** 创建 pkg/model/instance/dao.go
**Then** 提供 Create、GetByID、GetByInstanceID、ListByUserID（分页）、UpdateStatus 方法

**Given** 需要 Quota 数据模型
**When** 创建 pkg/model/quota/entity.go 和 dao.go
**Then** Quota struct 包含字段：id、user_id、max_instances、used_instances、created_at、updated_at
**And** DAO 提供 GetByUserID、CheckAndDeduct（原子检查+扣减）、Release 方法

**Given** 需要数据库迁移文件
**When** 创建 migrations/ 下的 SQL 文件
**Then** 000001_create_instances.up.sql 创建 instances 表
**And** 000002_create_quotas.up.sql 创建 quotas 表
**And** 每个 up.sql 对应 down.sql 回滚文件

**FRs:** FR14（配额维护）

---

### Story 1.3: 沙箱服务适配器

As a 开发团队成员,
I want 实现沙箱服务 HTTP 适配器,
So that 业务逻辑层可以通过适配器调用沙箱服务 API。

**Acceptance Criteria:**

**Given** 需要沙箱服务适配器
**When** 创建 pkg/adapter/sandbox/adapter.go
**Then** SandboxAdapter struct 提供方法：
- CreateSandbox(ctx, templateID, opts) (*Sandbox, error) - 创建沙箱
- GetSandbox(ctx, sandboxID) (*SandboxDetail, error) - 查询沙箱详情
- ListSandboxes(ctx, filter) ([]ListedSandbox, error) - 查询沙箱列表
- DeleteSandbox(ctx, sandboxID) error - 销毁沙箱
- PauseSandbox(ctx, sandboxID) error - 暂停沙箱
- ResumeSandbox(ctx, sandboxID, opts) (*Sandbox, error) - 恢复沙箱
- SetTimeout(ctx, sandboxID, timeout) error - 设置超时
- Refresh(ctx, sandboxID, duration) error - 刷新存活时间
- GetLogs(ctx, sandboxID, opts) (*SandboxLogs, error) - 查询日志

**Given** 沙箱服务调用需要重试
**When** 调用沙箱 API 失败
**Then** 自动重试（默认 3 次，指数退避 1s/2s/4s）
**And** 最终失败返回统一错误类型

**Given** 沙箱服务 API 密钥管理
**When** 初始化沙箱适配器
**Then** 从环境变量读取 API Key
**And** 不在日志中输出任何密钥信息

**Given** 需要请求/响应类型定义
**When** 创建 pkg/adapter/sandbox/types.go
**Then** 定义与沙箱 API 对应的 Go struct（CreateSandboxOptions、SandboxDetail、ListedSandbox、SandboxLogs 等）

**FRs:** FR8, FR9, FR10, FR11, FR12, FR13
**NFRs:** NFR5（重试）, NFR8（密钥安全）
**ARs:** AR5

---

### Story 1.4: 实例创建与查询 API

As a 上层系统调用方,
I want 通过 POST /v1/instances 创建实例，通过 GET 查询实例详情和列表,
So that 用户可以获得和管理 OpenClaw 实例。

**Acceptance Criteria:**

**Given** 用户配额充足
**When** 调用 POST /v1/instances（body: timeout）
**Then** 返回 200 + `{"code":"OK","message":"success","data":{"instance_id":"ins-xxx","sandbox_id":"sbx-xxx"}}`
**And** Instance 记录写入 DB，最终状态为 Running
**And** 配额扣减
**And** 使用配置中的默认 templateID 调用沙箱服务

**Given** 用户配额不足
**When** 调用 POST /v1/instances
**Then** 返回 403 + `{"code":"INSTANCE_QUOTA_EXCEEDED","message":"..."}` 错误响应

**Given** 需要查询单个实例
**When** 调用 GET /v1/instances/{id}
**Then** 返回 `{"code":"OK","message":"success","data":{...}}`
**And** 仅返回属于当前 user_id 的实例
**And** 实例不存在时返回 404 + `{"code":"INSTANCE_NOT_FOUND","message":"..."}`

**Given** 需要查询用户实例列表
**When** 调用 GET /v1/instances?page=1&page_size=20
**Then** 返回 `{"code":"OK","message":"success","data":{"total":n,"items":[...]}}`
**And** 仅返回当前 user_id 的实例

**FRs:** FR1, FR2, FR3, FR15
**NFRs:** NFR1（P99 ≤ 500ms）, NFR2（≤30s）

---

## Epic 2: 实例生命周期管理

上层系统可以销毁、暂停、恢复实例，设置超时。系统自动管理配额释放。用户获得完整的实例生命周期管理能力。

### Story 2.1: 实例销毁 API

As a 上层系统调用方,
I want 通过 DELETE /v1/instances/{id} 销毁实例,
So that 不再需要的实例可以被正确释放。

**Acceptance Criteria:**

**Given** 实例存在且状态为 Running 或 Paused
**When** 调用 DELETE /v1/instances/{id}
**Then** 返回 200 + `{"code":"OK","message":"success","data":{...}}`
**And** 实例状态更新为 Deleted
**And** 配额释放（used_instances - 1）

**Given** 实例不存在或不属于当前用户
**When** 调用 DELETE /v1/instances/{id}
**Then** 返回 404 + `{"code":"INSTANCE_NOT_FOUND","message":"..."}`

**FRs:** FR4, FR16

---

### Story 2.2: 实例暂停/恢复与超时设置

As a 上层系统调用方,
I want 通过 API 暂停、恢复实例，设置超时,
So that 可以优化成本和控制实例生命周期。

**Acceptance Criteria:**

**Given** 实例存在且状态为 Running
**When** 调用 POST /v1/instances/{id}/pause
**Then** 返回 200 + `{"code":"OK","message":"success","data":{...}}`
**And** 实例状态更新为 Paused

**Given** 实例存在且状态为 Paused
**When** 调用 POST /v1/instances/{id}/resume（可选 body: timeout）
**Then** 返回 200 + `{"code":"OK","message":"success","data":{...}}`
**And** 实例状态更新为 Running

**Given** 实例存在
**When** 调用 POST /v1/instances/{id}/timeout（body: timeout）
**Then** 返回 200 + `{"code":"OK","message":"success","data":{...}}`
**And** 实例超时时间更新

**Given** 实例状态不正确
**When** 调用暂停/恢复
**Then** 返回 409 + `{"code":"INSTANCE_STATUS_INVALID","message":"..."}`

**FRs:** FR5, FR6, FR7, FR11, FR12

---

### Story 2.3: Tech Debt 清理（代码审查发现项）

As a 开发团队成员,
I want 修复 Story 1.2–2.1 代码审查中发现的 6 个 P0/P1 技术债务,
So that 系统在安全性、并发安全和可观测性方面没有隐患。

**Acceptance Criteria:**

**Given** authResources 在 InstanceID 为空时返回通配符授权 (D1)
**When** 修改所有 instance controller 的 authResources() 逻辑
**Then** 空 ID 时返回空资源集而非通配符，拒绝授权

**Given** uk_sandbox_id 唯一索引在 SandboxId 为空时阻塞并发创建 (D3)
**When** 修改数据库迁移或插入逻辑
**Then** 并发创建不再因空字符串冲突而串行化

**Given** AllocQuota/FreeQuota 无 cnt 校验 (D4)
**When** 修改 DAO 方法入口
**Then** cnt <= 0 时返回错误，防止反向操作

**Given** CreateInstance 中 UpdateSandboxAndStatus 失败后实例卡在 Creating (D5)
**When** 修复创建流程的错误处理
**Then** 失败时回滚（删除沙箱 + 释放配额），不产生孤儿实例和配额泄漏

**Given** rollbackQuota 忽略 FreeQuota 的 bool 返回值 (D6)
**When** 修复 rollbackQuota 逻辑
**Then** freed == false && err == nil 时记录 Warning 日志

**Given** NewErrorResponse 吞掉非 errcode.Error 的错误上下文 (D8)
**When** 修复 common.go 的 fallback 分支
**Then** 记录原始 error 到日志，方便生产环境排查

**来源:** tech-debt-backlog.md（D1, D3, D4, D5, D6, D8）
**P2 延后项:** D2（Controller response 模式重构）、D7（ListByUserID 事务一致性）

---

### Story 2.5: Epic 2 技术债统一收口

As a 开发团队成员,
I want 在 Epic 2 收尾前统一清理剩余技术债务——多 template fallback、镜像契约文档化、回归测试加固、开发文档收口,
So that Epic 2 交付的代码在健壮性、可维护性和团队知识传承方面没有遗留尾巴。

**Acceptance Criteria:**

**Given** 当前仅使用单一 default_template_id，pool 失效即创建失败
**When** 实现候选 template 列表 + 顺序 fallback
**Then** 创建逻辑按候选列表依次尝试，首个成功即返回，全部失败才报错

**Given** sandbox 对 base_image 存在隐式运行时契约
**When** 创建 docs/sandbox-image-contract.md
**Then** 文档化合格镜像标准、健康检查链路、验证步骤

**Given** 回归测试脚本覆盖不全
**When** 增强 ctl/tools/regression_local_api.sh
**Then** 新增自动校验、摘要输出、更多覆盖场景

**Given** 联调经验分散在 story dev notes 中
**When** 整合到 docs/ctl-dev-setup/README.md
**Then** 开发者文档包含完整的本地联调步骤和常用命令

**Given** Story 2.3 已修正 spec 响应格式
**When** 对照 spec 检查代码实现
**Then** 确认 code 字段一致性（字符串格式）

**来源:** tech-debt-backlog.md（D-1, D-2）、Story 2.4 联调发现

---

## Epic 3: 可观测性

运维团队获得完整的监控和审计能力。系统暴露业务指标，记录操作历史，支持沙箱日志查询。

### Story 3.1: 业务指标暴露（Prometheus）

As a 系统运维人员,
I want 通过 Prometheus 采集关键业务指标,
So that 可以监控系统健康状况。

**Acceptance Criteria:**

**Given** 需要业务指标
**When** 创建 pkg/metric/instance.go
**Then** 暴露以下指标：
- `openclaw_instance_total`（Gauge）：按状态的实例数量
- `openclaw_instance_create_total`（Counter）：实例创建总数
- `openclaw_instance_create_duration_seconds`（Histogram）：创建耗时分布
- `openclaw_sandbox_api_duration_seconds`（Histogram）：沙箱 API 调用延迟

**Given** 指标采集端点
**When** 访问 /metrics 路径
**Then** Prometheus 格式输出所有注册指标

**FRs:** FR18
**NFRs:** NFR4（可用性监控基础）

---

### Story 3.2: 操作历史记录与沙箱日志查询

As a 系统运维人员,
I want 查询实例的操作历史记录和沙箱日志,
So that 可以追溯问题和审计操作。

**Acceptance Criteria:**

**Given** 需要记录操作历史
**When** 创建 pkg/model/task/（操作记录表）
**Then** Task struct 包含字段：id、task_id、task_type、instance_id、user_id、status、error_message、created_at
**And** 数据库迁移 000003_create_tasks.up.sql 创建 tasks 表

**Given** 需要查询操作历史
**When** 调用 GET /v1/instances/{id}/tasks
**Then** 返回该实例的操作历史列表

**Given** 需要查询沙箱日志
**When** 调用 GET /v1/instances/{id}/logs?start=xxx&limit=100
**Then** 返回沙箱日志列表（调用沙箱服务 GET /sandboxes/{sandboxID}/logs）

**FRs:** FR13, FR19
**NFRs:** NFR9（审计日志）
