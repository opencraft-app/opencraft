# Infra Pulumi Agent Guide

本文件只约束 `infra_pulumi/` 目录。

## Entry Rule

- 先阅读 [README.md](README.md)
- 若任务涉及 Grafana dashboard，本目录不是主入口，先看 [../docs/agent-guides/infra-grafana-dashboard-guide.md](../docs/agent-guides/infra-grafana-dashboard-guide.md)

## Core Rules

- `infra_pulumi` 是当前唯一的 infra 控制面，不要再恢复 OpenTofu 路径或 shell 编排
- 入口统一使用 `cmd/infractl`
- `cmd/infractl` 应优先通过 Pulumi Automation API 驱动 stack，不要回退到手写 `exec pulumi ...`
- 运行命令时统一带 `GOWORK=off`
- 不要重新引入 `infra_pulumi/scripts/*.sh`
- 若需要新增运维入口，优先加到 [cmd/infractl/main.go](cmd/infractl/main.go)

## Source Of Truth

- 非敏感环境事实放在 `envs/tencentcloud/<env>/inventory.yaml`
- 敏感信息不要写进 inventory
- 资源密码走 Pulumi stack secrets
- 镜像拉取凭据也走 Pulumi stack secrets，并在建集群时通过 TKE `tcr` addon 自动分发到各 namespace/default ServiceAccount
- TCR 若开启公网能力，不只要设置 `open_public_operation=true`，还要保证实例安全策略同时放通外部来源；这应在 `pkg/components/tcr` 里统一完成
- 腾讯云 API 凭据来自环境变量或 repo 根未跟踪的 `secrets.local.sh`

## Change Rules

- 北京和新环境应尽量同源同构；不要为了某个环境继续堆专属分支
- 若确实要对存量环境做兼容，优先限制在 import/adopt 边界，不要污染主资源模型
- 优先修改 Go 代码和 inventory，不要把行为塞进外层命令拼装
- 输出回流 deploy 的逻辑属于正式能力，可以改，但不要删除这条链路
- `deploy/envs/<env>/platform.env` 现在包含 deploy 运行时密码，改动这条链路时要按敏感文件处理
- `deploy/envs/<env>/platform.env` 中的 `DEPLOY_KUBECONFIG` 是 workload 发布默认 kubeconfig 来源；如果调整字段名或语义，必须同步更新各服务 deploy 脚本和根文档
- 不要再把“给某个项目手工补 imagePullSecrets”当成长期方案；集群级镜像拉取凭据应在 `pkg/components/tke` 里统一沉淀

## Validation

修改后至少做这些检查：

```bash
cd infra_pulumi
GOWORK=off go build ./...
GOWORK=off go run ./cmd/infractl preview --stack beijing-sandbox
```

如果改动影响上海或其他新环境，再补对应 stack 的 `preview`。

## Documentation

- 如果改了入口、secret 方式、inventory 结构、命名规则、网络规则，同步更新 [README.md](README.md)
- 如果改了 deploy 输出格式，同步更新 `deploy/envs/<env>/README.md`
