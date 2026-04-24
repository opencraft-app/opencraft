# CTL 技术规格索引

本目录收录 CTL 控制面和镜像相关的技术规格文档，记录每个功能的设计决策、实现方案和文件变更范围。

> 源文件原为 BMAD 工作流输出（`_bmad-output/`，已从仓库删除，可从 git 历史恢复）。

## 已完成

| 文档 | 说明 | 日期 |
|------|------|------|
| [AI Gateway Provision](tech-spec-ctl-ai-gateway-provision.md) | 集成 AI-Gateway，创建实例时自动下发大模型配置 | 2026-03-23 |
| [可观测性增强](tech-spec-ctl-observability-enhancement.md) | Prometheus 指标 + Grafana + zap 日志 + OpenTelemetry | 2026-03-23 |
| [集成测试 - 异步任务与 Bypass](tech-spec-ctl-integration-tests-async-bypass.md) | testcontainers-go 集成测试，覆盖异步任务和 Bypass 补偿 | 2026-03-24 |
| [实例 Churn Guard](tech-spec-ctl-instance-churn-guard.md) | 实例流转防护 + Pool Pressure 可观测性 | 2026-03-27 |
| [测试环境 K8s 部署](tech-spec-ctl-test-env-k8s-deploy.md) | CTL 测试环境云原生部署方案 | 2026-03-23 |
| [负载均衡选池](tech-spec-ctl-sandbox-create-load-balance.md) | 创建 Sandbox 时多候选池 + 失败回退 + pool pressure 快照 | 2026-03-31 |
| [调试接口规格](debug-exec-tech-spec.md) | TAT 命令执行链路，MVP 实现 `openclaw --version` | 2026-03-22 |
| [调试接口实现计划](debug-exec-implementation-plan.md) | 调试接口的分层实现步骤和文件变更清单 | 2026-03-22 |

## 待实现

| 文档 | 说明 | 日期 |
|------|------|------|
| [微信登录两段式协议](tech-spec-sandbox-image-weixin-login-two-phase-protocol.md) | 镜像侧微信登录结构化执行协议（ready-for-dev） | 2026-03-30 |

## 技术债

| 文档 | 说明 |
|------|------|
| [Tech Debt Backlog](tech-debt-backlog.md) | 全量技术债记录（D1~D19） |
