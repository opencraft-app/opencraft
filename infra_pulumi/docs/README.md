# 基础设施控制面

`infra_pulumi` 是当前仓库唯一的一方 infra 控制面，以 `cmd/infractl` 和 Pulumi Automation API 管理环境资源并向部署层输出事实。

## 权威入口

- [平台说明](../README.md)、[Agent 约束](../AGENTS.md)、[目录记录](../catalog-info.yaml)
- [发布与 GitOps 领域](../../docs/engineering/domains/release-gitops.md)
- Grafana 任务先看 [Dashboard 指南](../../docs/agent-guides/infra-grafana-dashboard-guide.md)

## 关键边界

非敏感环境事实属于 `envs/tencentcloud/<env>/inventory.yaml`，凭据属于环境变量或 Pulumi Secret。`deploy/envs/<env>/platform.env` 是派生部署输入，可能含敏感值，不能手改、提交或整份注入 ConfigMap。

## 验证

```bash
cd infra_pulumi
GOWORK=off go build ./...
GOWORK=off go run ./cmd/infractl preview --stack <stack>
```

Preview 是变更预览，不等于 apply 或发布授权。
