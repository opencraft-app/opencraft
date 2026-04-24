# CTL + Images 交接文档

> 交接人：Mason | 日期：2026-04-09

## 1. 交接范围

本文档覆盖以下两个模块的交接：

- **ctl**：OpenClaw SaaS 控制面后端，负责实例生命周期管理
- **images**：沙箱镜像构建与运行时契约

### 产品定位

OpenClaw 是 AI Agent 运行时的 SaaS 托管服务。用户购买 Coding Plan 套餐即获得一个 OpenClaw 实例（沙箱环境），控制面（ctl）负责实例的创建、销毁、暂停、恢复等生命周期管理。

### 文档导航

| 你想做什么 | 看哪个文档 |
|-----------|-----------|
| 了解 ctl 开发规范 | [ctl-agent-guide.md](agent-guides/ctl-agent-guide.md) |
| 本地跑通 ctl 三服务 | [ctl-local-run-guide.md](agent-guides/ctl-local-run-guide.md) |
| 本地联调详细参考 | [ctl-dev-setup/README.md](ctl-dev-setup/README.md) |
| 部署到测试环境 | [ctl-deploy-guide.md](deploy-guides/ctl-deploy-guide.md) |
| 了解架构设计 | [architecture.md](ctl-design/architecture.md) |
| 了解产品需求 | [prd.md](ctl-design/prd.md) |
| 查看 Epic/Story 进度 | [epics.md](ctl-design/epics.md) |
| 了解技术规格 | [ctl-tech-specs/README.md](ctl-tech-specs/README.md) |
| 镜像构建 | [sandbox-image-agent-guide.md](agent-guides/sandbox-image-agent-guide.md) |
| 镜像运行时契约 | [sandbox-image-contract.md](sandbox-image-contract.md) |
| 镜像 rollout | [sandbox-image-rollout-guide.md](agent-guides/sandbox-image-rollout-guide.md) |
| 可观测性（指标/日志/tracing） | [ctl-observability-guide.md](agent-guides/ctl-observability-guide.md) |
| 故障排查 | [runbooks/](runbooks/) |
| 部署模型总览 | [deployment-model-overview.md](deploy-guides/deployment-model-overview.md) |

---

## 2. CTL 模块现状

### 2.1 代码结构

```
ctl/
├── main/
│   ├── api/       # HTTP 服务（端口 9590）
│   ├── service/   # MQ 消费者（异步任务执行）
│   └── bypass/    # 定期补偿任务
├── pkg/
│   ├── logic/instance/   # 业务逻辑
│   ├── model/instance/   # 数据模型 + DAO
│   ├── adapter/sandbox/  # 沙箱服务适配器
│   ├── tasks/            # 异步任务定义
│   ├── errcode/          # 错误码
│   └── ...
├── migrations/           # 数据库迁移
├── conf/                 # 配置文件
├── scripts/tests/        # 自动化测试脚本
└── test/                 # 集成测试
```

分层：Handler(main/api) -> Logic(pkg/logic) -> Model(pkg/model) -> Adapter(pkg/adapter)

### 2.2 核心业务流

- **创建实例**：API 写入 DB(Creating) -> Redis Stream 投递 -> Service Worker 调用沙箱创建 -> 更新状态(Running/Failed)
- **销毁实例**：API 转 Deleting -> 投递 MQ -> Worker 删除沙箱 + 释放配额
- **暂停/恢复**：同步调用沙箱 API（P2 异步化，见技术债 D14）
- **调试执行**：通过 TAT 在沙箱内执行命令（debug/exec 接口）
- **微信登录**：两段式结构化协议（SSE 推送 QR + 状态轮询）
- **Bypass 补偿**：定期扫描未完成任务，重新投递

### 2.3 微信登录机制（难点）

微信登录是 CTL 中最复杂的功能，横跨 ctl 控制面和镜像两侧。

**整体架构**

```
前端
  ↓ POST create-session
ctl API（创建 session 记录）
  ↓ envd process
沙箱实例内：openclaw-weixin-login-session start
  ↓ 生成二维码
ctl 轮询 status → 写 DB → SSE 推送前端
  ↓ 用户扫码
ctl 检测 success → 自动执行 openclaw gateway restart
```

**关键设计**
- 会话型流程，不是短命令：create session → 轮询 status → SSE 推状态 → cancel/expire
- 状态机：`starting → waiting_qr → scanned → success`（另有 failed/timeout/cancelled/expired）
- 二维码：`qr_ascii` 是最可靠的字段（等宽字符直接展示），`qr_url` 只是辅助
- 前端接入：snapshot + SSE 双通道，SSE 断连时退回轮询
- 事实源不是进程返回值，而是实例内 `state.json` + 结构化协议 JSON

**ctl 侧实现**
- 核心代码：`ctl/pkg/instance/weixin_login.go`
- API：4 个端点（create / snapshot / events SSE / cancel）
- 并发保护：同一实例同时只允许一个 active session；cancel 期间打 `closing` 标记防状态回刷

**镜像侧实现**
- 协议脚本：`images/runtime/openclaw-weixin-login-session.sh`
- 三个子命令：`start`（启动登录）/ `status`（查询状态）/ `cancel`（终止）
- 状态文件：`/tmp/lightclaw-weixin-login/<session_id>/state.json`

**已知的坑（重点关注）**
1. `pid` 返回类型不稳定（number/string/null），ctl 已做兼容但镜像侧应收敛
2. `cancel` 和并发 `status` 轮询存在竞态，已加保护但不完美
3. `envd process` 短命令偶发拿不到完整 JSON，ctl 回退读 state.json 兜底
4. pool 切镜像后旧库存未回填完，可能导致端到端测试失败 — 先查 pool 库存再怀疑微信逻辑
5. 当前稳定验收到 `waiting_qr`（拿到二维码），`scanned → success → gateway restart` 完整闭环尚未作为日常门禁

**排障优先级**
1. 先看 snapshot 的 `status`/`error_message`
2. 创建实例就失败 → 查 pool 镜像和库存，不是微信问题
3. 卡在 starting → 查实例内 state.json 和 output.log
4. 快速 failed → 查 error_message，通常是插件/OpenClaw/gateway 问题
5. cancel 报错 → 区分是镜像协议没成功还是 ctl 没拿到返回

详细 API 对接：[ctl-weixin-login-api-guide.md](agent-guides/ctl-weixin-login-api-guide.md)
坑点与排障：[ctl-weixin-followup-guide.md](agent-guides/ctl-weixin-followup-guide.md)
技术债跟进：[ctl-weixin-login-tech-debt.md](developer-guide/ctl-weixin-login-tech-debt.md)

### 2.4 完成度（截至 2026-04-10）

| Epic | 状态 | 说明 |
|------|------|------|
| Epic 1: 实例创建与查询 | **done** | 4 Story 全部完成 |
| Epic 2: 实例生命周期管理 | **done** | 全部完成 |
| Epic 3: 可观测性 | **~90%** | 3.1 done，3.2 仅剩沙箱日志查询接口 |

详细进度见 [epics.md](ctl-design/epics.md)。

### 2.5 未完成工作

**Epic 3.2 — 沙箱日志查询接口（ready-for-dev）**
- 操作历史记录部分已完成，仅剩沙箱日志查询接口未实现

**Pause/Resume 异步化（P2，技术债 D14）**
- 当前暂停/恢复为同步调用，需引入 Pausing/Resuming 中间状态
- 详见 [tech-debt-backlog.md](ctl-tech-specs/tech-debt-backlog.md) D14

### 2.6 已知的坑

**CreateInstance 偶发卡 Creating**
- Task replay 导致锁冲突，部分修复已部署
- 当前阻塞点已转移到 openclaw onboard OOM（小规格实例）
- 详见 [ctl-create-instance-followup-guide.md](agent-guides/ctl-create-instance-followup-guide.md)

**微信登录协议不稳定**
- pid 返回类型不一致（number/string）
- 并发状态覆盖
- 进程返回不可靠
- 详见 [ctl-weixin-followup-guide.md](agent-guides/ctl-weixin-followup-guide.md)

**Sandbox 孤儿 CVM**
- CVM 创建与 DB 写入非原子，可产生孤儿实例空转计费
- 2026-03-21 排查发现 26 台孤儿 CVM
- 详见技术债 D15~D17

**pool-c0/c1 不可用**
- ap-beijing-4/5 可用区对当前账号不可购买，Worker 空转
- 详见技术债 D19

### 2.7 技术债摘要

完整列表见 [tech-debt-backlog.md](ctl-tech-specs/tech-debt-backlog.md)

| 编号 | 描述 | 状态 | 优先级 |
|------|------|------|--------|
| D14 | Pause/Resume 异步化 | 待实现 | P2 |
| D1~D13 | 各类已修复问题 | 已解决 | - |
| D15~D19 | 孤儿 CVM / Pool API / 可用区等 | 已解决 | - |

---

## 3. Images 模块现状

### 3.1 镜像构成

镜像采用两层分离设计，版本锁定在 `images/build-manifest.json`：

**Base 层**（底座，变更频率低）
- Ubuntu 24.04 LTS
- TAT（腾讯云自动化助手）
- envd（沙箱运行时守护进程，暴露 `:49983/health`）
- Node.js 24.x / pnpm
- Python venv (`/opt/lightclaw-python`)
- Playwright + 浏览器依赖

**App 层**（应用，随版本迭代）
- OpenClaw（AI Agent 运行时）
- ClaWHub
- QQBot / 微信插件
- Gateway 配置（端口 18789）
- 默认插件集

**运行时契约**（sandbox 对镜像的硬要求）
- TAT 可用
- envd 自启动
- `127.0.0.1:49983/health` 返回成功

不满足以上三项的镜像，实例会在健康检查阶段被 worker 判定失败并清理。详见 [sandbox-image-contract.md](sandbox-image-contract.md)

### 3.2 镜像构建 → Pool 更新端到端流程

这是 CTL + Images 最核心的运维工作流。详细操作见各步骤对应的文档。

```
镜像构建 → 验证 → 制镜 → Pool 更新 → Worker 异步重装
```

**Step 1: 构建镜像**
```bash
# 日常推荐：基于现有基础镜像构建应用层（~8-12分钟）
python3 images/build-image.py --base-image-id img-id352nof --with-verify

# 首次或底座变更时：构建基础镜像（~15分钟）
python3 images/build-image.py --build-base
```
- 主入口：`images/build-image.py`（9 步自动化状态机）
- 构建规范：[sandbox-image-agent-guide.md](agent-guides/sandbox-image-agent-guide.md)
- 制镜完成后自动写入版本元数据并创建腾讯云镜像

**Step 2: 更新 Pool 镜像（SQL Fallback）**
```bash
# 更新 pools 表的 base_image，并将 CLEAN 实例标记为 DRY 触发重装
# 具体 SQL 见 rollout 指南
```
- Rollout 标准流程：[sandbox-image-rollout-guide.md](agent-guides/sandbox-image-rollout-guide.md)
- SQL Fallback 操作：[sandbox-pool-image-update.md](developer-guide/sandbox-pool-image-update.md)
- 注意：sandbox 的 rollout API 已删除，当前只能通过 SQL 操作

**Step 3: 异步回填**
```bash
# 走 sandbox-ops SQL fallback / worker 异步回填
source deploy/envs/beijing-sandbox/platform.env
KUBECONFIG="${DEPLOY_KUBECONFIG}" \
  bash .codebuddy/skills/sandbox-ops/scripts/query_pool_status.sh 'pool-%'
```
- Worker 异步消费 DRY 实例：DRY -> RESETTING -> CLEAN
- ALLOCATED 实例不受影响，释放后自动用新镜像重装

**Step 4: 验证**
```bash
# 检查 Pool 状态
source deploy/envs/beijing-sandbox/platform.env
KUBECONFIG="${DEPLOY_KUBECONFIG}" \
  bash .codebuddy/skills/sandbox-ops/scripts/query_pool_status.sh 'pool-c%'

# 创建实例验证新镜像
python3 ctl/scripts/tests/smoke-openclaw-testenv.py
```

相关文档：
- 镜像运行时契约：[sandbox-image-contract.md](sandbox-image-contract.md)
- 镜像版本台账：[sandbox-image-version-inventory.md](developer-guide/sandbox-image-version-inventory.md)

### 3.3 注意事项

- 更换镜像后必须验证 TAT/envd/health 三项，否则所有新实例都会在 VerifyInstance 阶段失败
- Pool 的默认池是 pool-c2~c5，pool-c0/c1 当前不可用
- pool-bj8 是 sandbox 侧兜底池，不是 ctl 默认入口
- 镜像侧微信登录两段式协议的 tech-spec 已完成但尚未实现
- 镜像验证测试脚本在 `images/tests/test-*.sh`

---

## 4. 环境与部署

### 4.1 本地开发

标准流程见 [ctl-local-run-guide.md](agent-guides/ctl-local-run-guide.md)，核心步骤：
1. `cd ctl && ./conf/local/dev.sh start` — 启动 MySQL + Redis
2. `cd ctl && ./conf/local/dev.sh reset-db` — 初始化 DB
3. `kubectl port-forward -n sandbox svc/sandbox-api 18081:80` — 转发 sandbox
4. `cd ctl && ./conf/local/services.sh start` — 启动三服务

### 4.2 测试环境部署

标准流程见 [ctl-deploy-guide.md](deploy-guides/ctl-deploy-guide.md)：
```bash
正式发布已迁到 `Argo CD` 主线；镜像构建改为统一 release bundle 入口。
```

### 4.3 自动化测试脚本

| 脚本 | 用途 | 运行环境 |
|------|------|---------|
| `ctl/scripts/tests/smoke_local_api.py` | 本地 API 冒烟 | 本地 |
| `ctl/scripts/tests/regression_local_api.py` | 本地全回归 | 本地 |
| `ctl/scripts/tests/smoke-openclaw-testenv.py` | 测试环境冒烟 | 测试环境 |
| `ctl/scripts/tests/regression-openclaw-testenv.py` | 测试环境全回归 | 测试环境 |
| `ctl/scripts/tests/smoke-openclaw-weixin-qr-testenv.py` | 微信登录验证 | 测试环境 |
| `ctl/scripts/tests/smoke-openclaw-qqbot-testenv.py` | QQBot 验证 | 测试环境 |
| `ctl/scripts/tests/smoke-pool-selection-testenv.py` | 多池选择验证 | 测试环境 |
| `ctl/scripts/tests/smoke-abuse-cooldown-testenv.py` | 滥用冷却验证 | 测试环境 |

Makefile 快捷方式：
```bash
cd ctl && make testenv-regression   # 测试环境全回归
cd ctl && make testenv-smoke        # 测试环境冒烟
make test-ctl-regression            # ctl 核心回归（根目录）
```

### 4.4 关键配置文件

| 文件 | 说明 |
|------|------|
| `.secret/ctl/local.env` | 本地敏感配置 |
| `.secret/ctl/test.env` | 测试环境敏感配置 |
| `ctl/conf/local/` | 本地开发配置 |
| `ctl/conf/server/` | 线上/测试环境配置 |
| `deploy/envs/beijing-sandbox/platform.env` | 部署事实文件（自动生成） |

---

## 5. 接手 Checklist

- [ ] 阅读 [AGENTS.md](../AGENTS.md) 了解项目总规范
- [ ] 阅读 [ctl-agent-guide.md](agent-guides/ctl-agent-guide.md) 了解开发约束
- [ ] 本地跑通 ctl 三服务（[ctl-local-run-guide.md](agent-guides/ctl-local-run-guide.md)）
- [ ] 本地跑通 `smoke_local_api.py` 和 `regression_local_api.py`
- [ ] 了解测试环境部署流程（[ctl-deploy-guide.md](deploy-guides/ctl-deploy-guide.md)）
- [ ] 了解镜像构建和 rollout 流程（[sandbox-image-agent-guide.md](agent-guides/sandbox-image-agent-guide.md)）
- [ ] 查看 [epics.md](ctl-design/epics.md) 了解未完成工作
- [ ] 查看 [tech-debt-backlog](ctl-tech-specs/tech-debt-backlog.md) 了解技术债
- [ ] 了解可观测性（[ctl-observability-guide.md](agent-guides/ctl-observability-guide.md)）
- [ ] 熟悉故障处理手册（[runbooks/](runbooks/)）

---

## 6. 归档说明

### _bmad-output/（已删除）

`_bmad-output/` 目录原为 BMAD 工作流输出，核心文档已迁移到 `docs/ctl-design/` 和 `docs/ctl-tech-specs/`。如需查看原始 Story 实现记录，可从 git 历史中恢复。

### docs/ctl-design/archive/

以下文档为历史设计方案，已被废弃（当前架构已转型为沙箱服务模式）：
- `core-design.md` — 原 MVP 架构（控制面直调腾讯云 API）
- `vpc-design.md` — 原网络隔离方案（每用户 VPC 等方案评估）

### docs/archive/

- `init.md` — 项目启动备注
- `bmad.md` — BMAD 工作流指南
- `code_review_async_refactor.md` — 异步重构代码审查
- `sprint-status.yaml` — Sprint 进度快照（截至 2026-03-21）
