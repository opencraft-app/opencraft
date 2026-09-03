# AI Gateway

AI Gateway 是 LightVela 的模型调用网关，负责供应商适配、请求路由和相关运行时能力。

- 开发与边界：[docs/README.md](docs/README.md)
- Agent 入口：[AGENTS.md](AGENTS.md)
- 详细开发指南：[../docs/agent-guides/ai-gateway-agent-guide.md](../docs/agent-guides/ai-gateway-agent-guide.md)

本地修改按 Go/Node 变更范围运行对应测试。正式发布只认 `argocd/services/ai-gateway/<env>` 与对应 Argo 应用。
