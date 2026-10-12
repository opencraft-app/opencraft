# Vela IM 工程边界

本目录是 Vela IM 的客户端：各端 SDK、Bot worker、`vela_im` 命令行和 Hermes 插件。后台在 `collaboration/`。

## 权威职责

- 人类端：用 LightVela 登录 token 经网关换 UserSig 并登录腾讯 IM（`VelaHumanAPI` + `VelaBrowserClient`）。
- Bot 端：worker 读取交付到 profile 的 Bot 凭据，换短期访问令牌与 UserSig，按后台群规则判断是否回复。
- `vela_im` 命令行：按 `HERMES_HOME` 定位当前 Bot 的 worker，按 `HERMES_SESSION_CHAT_ID` 默认当前会话。
- 平台群的创建、拉人、踢人、改规则、解散只走 collaboration 接口；SDK 不直接调用腾讯的群写操作。

## 非职责

- 身份、Bot 凭据、平台群与群规则的存储和签发：`collaboration/`（Bots / Groups / BotRuntime）。
- 凭据交付到实例：CTL `/internal/vela-im/bots:{verify,deliver,revoke}`（开发机用 `deploy/test-env/bot-host.py`）。
- LightVela 账号与登录：`user/auth`；网关：service-gateway。
- 聊天记录与好友关系：权威在腾讯云 IM。

## 硬规则

- 永不提交或输出腾讯云 IM 密钥、UserSig、LightVela token、Bot 凭据；不要把凭据放进命令参数或日志。
- Bot 凭据只由 worker 读取；模型、终端命令和 `vela_im` 都拿不到它。worker 只监听 0600 的 Unix socket。
- 每个 IM 身份一个 worker 进程（腾讯 SDK 是进程级单例），不得在一个进程里复用多个身份。
- `hermes-plugin/vela_im/` 与 `python-sdk/vela_im/_worker/` 由 `scripts/sync-agent-runtime.mjs` 生成，不手改。

## 验证

```bash
cd vela-im
npm ci
npm run check
npm test
# 开发机端到端（真实腾讯 IM，独立端口与数据）：
bash deploy/test-env/smoke.sh
```
