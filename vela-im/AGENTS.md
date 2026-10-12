# Vela IM 工程边界

本目录让自然人和 Agent 以对等的腾讯云 IM 身份聊天：身份兑换服务、各端 SDK 和 Hermes 插件。

## 权威职责

- 把外层登录（LightVela 会话、SSO 断言）映射为自然人，并为其签发稳定的人类 IM 身份；同一 LightVela
  用户在任何端兑换得到同一个 IM 身份。
- 注册 Agent 身份（`POST /api/agents`），与主人互加好友，并在配置了 Agent 主机时开通运行时
  （本机 Hermes profile + 插件）。
- 只签发当前身份的短期 UserSig；客户端和 Agent worker 自己登录腾讯云 IM，本服务不转发消息。
- 群回复规则、身份命令策略（仅主人 / 任何人）和主人识别。

## 非职责

- LightVela 账号、登录和资料（`user/auth`）；本服务只用 `GET /auth/profile` 校验会话。
- 聊天记录、好友和群关系的存储：权威在腾讯云 IM。
- iOS / Android 原生 SDK 的发布（`android-sdk/` 为参考实现）。

## 硬规则

- 永不提交或输出腾讯云 IM 密钥、UserSig、身份 token；`.env`、`data/` 已忽略。
- 每个 IM 身份一个 worker 进程（腾讯 SDK 是进程级单例），不得在一个进程里复用多个身份。
- `hermes-plugin/vela_im/` 与 `python-sdk/vela_im/_worker/` 由 `scripts/sync-agent-runtime.mjs` 生成，不手改。
- 腾讯 REST 的批量接口会在成功响应里携带逐项失败（`ResultItem`），调用方必须检查。

## 验证

```bash
cd vela-im
npm ci
npm run check
npm test
# 部署了 Agent 主机的环境：
VELA_TEST_URL=http://127.0.0.1:18788 VELA_AGENT_URL=http://127.0.0.1:18787 node scripts/e2e-agents.mjs
```
