# Mono 项目文档索引

## 交接入口

- [CTL + Images 交接文档](handover-ctl-images.md) — CTL 控制面和沙箱镜像的交接说明、现状、未完成工作

## 按角色导航

### 新人上手

1. 阅读 [AGENTS.md](../AGENTS.md) 了解项目总规范
2. 阅读对应服务的 agent-guide（见下方）
3. 本地跑通服务（[ctl-local-run-guide](agent-guides/ctl-local-run-guide.md)）
4. 了解部署模型（[deployment-model-overview](deploy-guides/deployment-model-overview.md)）

### 开发指南（agent-guides/）

| 文档 | 说明 |
|------|------|
| [ctl-agent-guide.md](agent-guides/ctl-agent-guide.md) | CTL 开发主入口（分层、异步模型、约束） |
| [ctl-local-run-guide.md](agent-guides/ctl-local-run-guide.md) | CTL 本地启动、联调、回归脚本 |
| [ctl-observability-guide.md](agent-guides/ctl-observability-guide.md) | Prometheus 指标 / zap 日志 / OpenTelemetry |
| [ctl-create-instance-followup-guide.md](agent-guides/ctl-create-instance-followup-guide.md) | CreateInstance 卡 Creating 排查 |
| [ctl-weixin-login-api-guide.md](agent-guides/ctl-weixin-login-api-guide.md) | 微信扫码登录 API 对接 |
| [ctl-weixin-followup-guide.md](agent-guides/ctl-weixin-followup-guide.md) | 微信登录排障与已知坑 |
| [sandbox-agent-guide.md](agent-guides/sandbox-agent-guide.md) | Sandbox 开发入口 |
| [sandbox-image-agent-guide.md](agent-guides/sandbox-image-agent-guide.md) | 镜像构建（TAT/envd/健康检查） |
| [sandbox-image-rollout-guide.md](agent-guides/sandbox-image-rollout-guide.md) | 镜像切换与 rollout 流程 |
| [ai-gateway-agent-guide.md](agent-guides/ai-gateway-agent-guide.md) | AI Gateway 开发指南 |
| [gateway-dashboard-agent-guide.md](agent-guides/gateway-dashboard-agent-guide.md) | Dashboard 前端指南 |
| [infra-grafana-dashboard-guide.md](agent-guides/infra-grafana-dashboard-guide.md) | Grafana Dashboard 管理 |

### 部署指南（deploy-guides/）

| 文档 | 说明 |
|------|------|
| [deployment-model-overview.md](deploy-guides/deployment-model-overview.md) | 部署模型总览：Pulumi -> platform.env -> Kustomize |
| [ctl-deploy-guide.md](deploy-guides/ctl-deploy-guide.md) | CTL 三进程部署与验证 |
| [sandbox-deploy-guide.md](deploy-guides/sandbox-deploy-guide.md) | Sandbox 发布与 pool 镜像 rollout |
| [ai-gateway-deploy-guide.md](deploy-guides/ai-gateway-deploy-guide.md) | AI Gateway 测试环境部署 |

### 架构设计（ctl-design/）

| 文档 | 说明 |
|------|------|
| [architecture.md](ctl-design/architecture.md) | **当前架构设计**（沙箱服务模式） |
| [prd.md](ctl-design/prd.md) | 产品需求文档 |
| [epics.md](ctl-design/epics.md) | Epic/Story 分解与进度 |
| [product-brief.md](ctl-design/product-brief.md) | 产品简报 |
| [archive/core-design.md](ctl-design/archive/core-design.md) | 原架构（已废弃） |
| [archive/vpc-design.md](ctl-design/archive/vpc-design.md) | 原网络设计（已废弃） |

### 技术规格（ctl-tech-specs/）

[索引](ctl-tech-specs/README.md) — 9 个 tech-spec，记录每个功能的设计决策和实现方案

### 开发者背景文档（developer-guide/）

[索引](developer-guide/README.md) — Sandbox 集成模型、命令执行、Pool 镜像更新等背景知识

### 故障处理手册（runbooks/）

12 个 runbook，覆盖 API 错误率/延迟、Bypass 锁失败、DB 连接池、Redis 连接池、远程命令失败/超时、Sandbox API 延迟、Task 失败/卡住/重试等场景。

### 设计规范（superpowers/）

AI Gateway、Dashboard、语义缓存等设计规范和开发计划。

### 其他

| 文档 | 说明 |
|------|------|
| [full-architecture.md](full-architecture.md) | 系统架构总览（Mermaid 图） |
| [sandbox-image-contract.md](sandbox-image-contract.md) | 镜像运行时契约 |
| [PRECOMMIT_SETUP.md](PRECOMMIT_SETUP.md) | Pre-commit 编译门禁 |
| [ctl-dev-setup/README.md](ctl-dev-setup/README.md) | CTL 本地联调详细参考（早期记录） |

### 归档（archive/）

历史文档，不再维护：init.md、bmad.md、sprint-status.yaml 等。
