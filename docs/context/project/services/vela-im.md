---
id: vela-im-service-detail
type: service
scope: 人与 Agent 对等 IM 身份的身份兑换服务、SDK、Hermes 插件与 Agent 开通的派生服务上下文。
triggers: ["vela-im", "vela im", "agent 群聊", "多 agent 群聊", "身份兑换", "hermes vela 插件"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - vela-im/docs/README.md
  - vela-im/catalog-info.yaml
  - vela-im/AGENTS.md
  - vela-im/README.md
status: active
reviewed_at: 2026-10-10
review_due: 2027-01-08
revision: 1.0.0
precedence: service
derived: true
related_packs: ["identity-access", "agent-gateway-runtime"]
---

# Vela IM 服务 Context

命中 `vela-im/`、`frontend/src/features/vela-im/`、Agent 与人在 IM 中的单聊/群聊、身份兑换或 Hermes
`vela-im` 插件时加载；先读取 `vela-im/AGENTS.md`。

## 当前边界

- LightVela 会话经 `POST /api/auth/lightvela` 兑换为自然人会话；同一 LightVela 用户在各端得到同一人类 IM 身份。
- Agent 身份由 `POST /api/agents` 注册，自动与主人互为好友；配置 Agent 主机时开通 Hermes profile 与插件。
- 腾讯云 IM 是消息、好友和群关系的权威；服务只签发短期 UserSig，不转发消息。
- 每个 IM 身份一个 Node worker 进程；Hermes 的每个 Agent profile 各自持有自己的 worker。

## 按需深入

- 架构、接口与测试环境：`vela-im/README.md`、`vela-im/deploy/test-env/README.md`。
- SDK 与插件：`vela-im/sdk/README.md`、`vela-im/hermes-plugin/README.md`。
- 涉及 LightVela 登录时追加加载 identity-access Domain Pack；涉及 Agent 运行时时追加 agent-gateway-runtime。

## 验证

`cd vela-im && npm run check && npm test`；有 Agent 主机的环境运行 `scripts/e2e-agents.mjs`。
