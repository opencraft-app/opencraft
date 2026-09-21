# 运维与故障处理入口

本页是路由索引，不保存会漂移的 IP、密码、当前 revision 或在线状态。执行任何外部/生产操作前重新发现目标并取得对应授权。

## 按系统进入

- CTL：`docs/agent-guides/ctl-observability-guide.md` 与 `docs/runbooks/`
- Sandbox：`docs/agent-guides/sandbox-agent-guide.md`、`sandbox-image-agent-guide.md`、`docs/deploy-guides/sandbox-deploy-guide.md`
- AI Gateway：`docs/agent-guides/ai-gateway-agent-guide.md` 与 `docs/deploy-guides/ai-gateway-deploy-guide.md`
- Dashboard：`docs/agent-guides/gateway-dashboard-agent-guide.md`
- 平台监控：`docs/agent-guides/infra-grafana-dashboard-guide.md`
- GitOps：`argocd/README.md` 与 [源码到生产 Journey](../journeys/source-to-production.md)

## 通用诊断顺序

1. 明确用户可见症状、时间、环境和关联标识。
2. 只读确认服务健康与入口是否收到请求。
3. 沿 Journey 检查编排、存储/状态、上游生成和出口交付。
4. 区分期望状态与运行状态；区分单次恢复与持久修复。
5. 写操作前给出影响面、回滚和验证，生产操作必须单独授权。

日志与命令输出不得包含 token、密码、私钥、临时凭据、解密 payload 或完整敏感业务内容。
