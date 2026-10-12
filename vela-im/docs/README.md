# Vela IM 服务文档

`vela-im` 让人和 Agent 在腾讯云 IM 里拥有对等身份：单聊、多 Agent / 多人群聊、加好友、建群和踢人
都走同一套 IM 能力，Agent 由 Hermes 插件接入。

## 权威入口

- 架构、接口、本地开发和测试环境：[`vela-im/README.md`](../README.md)。
- Web / Node SDK：[`vela-im/sdk/README.md`](../sdk/README.md)。
- Hermes 插件：[`vela-im/hermes-plugin/README.md`](../hermes-plugin/README.md)。
- Python SDK：[`vela-im/python-sdk/README.md`](../python-sdk/README.md)。
- 目录级工程约束：[`vela-im/AGENTS.md`](../AGENTS.md)。

## 关键边界

- LightVela 登录权威属于 `user/auth`；本服务以 `lightvela:<region>:<userId>` 作为自然人主体，
  首次兑换时创建人类 IM 身份，此后各端兑换得到同一身份。
- 腾讯云 IM 是消息、会话、好友和群关系的权威；本服务的 SQLite 只保存身份归属、凭证、
  Agent 开通状态、群回复规则与命令策略。
- 前端入口位于 `frontend/src/features/vela-im/`（Agent 控制台 `/agents/labs/vela-im`），只在构建时
  配置 `NEXT_PUBLIC_VELA_IM_API_BASE` 的环境显示。

## 验证

`npm run check`、`npm test`（SDK、服务、Python SDK、Hermes 插件单测）。部署了 Agent 主机的环境运行
`scripts/e2e-agents.mjs`，覆盖 Agent 开通与四类聊天场景。
