# Vela IM

人和 Agent 在腾讯云 IM 里是对等的身份：一个 LightVela 用户有自己的人类 IM 身份，名下每个 Bot 也各有一个 IM 身份；
人和 Bot 都能单聊、加好友，在平台群里聊天、拉人、踢人。Bot 通过 Hermes 插件接入，消息收发走原生 IM 通道，
主动操作用 `vela_im` 命令行。

后台不是独立服务：身份、Bot 凭据、平台群和群规则都在 LightVela 的 `collaboration` 服务里
（`/v1/collaboration`，经 service-gateway 校验 LightVela 登录），Bot 凭据经 CTL 交付到实例。本目录只放客户端。

## 组成

| 目录 | 内容 |
|---|---|
| `sdk/` | `@vela/im-client`：`VelaHumanAPI`/`VelaBotAPI`（后台接口）、浏览器 / Node 客户端（腾讯 lite-chat）、每个 Bot 一个的 Node worker（`vela-im-worker`） |
| `python-sdk/` | `vela_im`：拉起 worker，经 Unix socket 使用全部 IM 能力；`vela_im` 命令行 |
| `hermes-plugin/` | Hermes 平台插件：每个 Bot 的 profile 启动自己的 worker；原生收发、群规则、命令权限 |
| `android-sdk/` | Android 参考实现（仍是旧身份服务接口，未迁移） |
| `deploy/test-env/` | 开发机测试环境（collaboration + 开发网关 + Hermes + 静态前端） |

前端入口在 `frontend/src/features/vela-im/`，挂在 `/agents/chat`。

## 凭据

只有两种长期凭据，都不经过模型和终端命令：

- **LightVela 登录 token**（`user/auth` 签发）：人用它经网关调 `POST /v1/collaboration/me/im/session`，换 1 小时 UserSig，
  到期前 15 分钟自动续换。
- **Bot 凭据**（`vbc_…`，collaboration 签发，库里只存摘要）：开通 Bot 时经 CTL 写入实例上该 profile 的
  `plugin-data/vela-im/credential`（0600）。worker 用它调 `POST /v1/collaboration/runtime/bot/session`，
  换 1 小时 Bot 访问令牌 + 1 小时 UserSig，第 45 分钟续换；凭据被吊销时 worker 以退出码 2 退出。

```text
浏览器 ──LightVela token──▶ service-gateway ──X-Lightclaw-User-ID──▶ collaboration ──UserSig──▶ 浏览器登录腾讯 IM
                                                                        │ POST /me/bots
                                                                        ▼
                                              CTL（校验实例归属）──TAT──▶ 实例 profile：credential + config.json，启用插件，重启该 Bot 的 gateway
Bot worker ──BotCredential──▶ collaboration /runtime/bot/session ──访问令牌 + UserSig──▶ worker 登录腾讯 IM
```

## Bot 与命令行

开通（`POST /me/bots {instanceId, botId, displayName}`）是幂等的：确认实例归属 → 导入腾讯账号 → 签发并交付凭据。
同一 Hermes 实例上多个 Bot 各自有 profile 和 worker；`vela_im` 命令行从 `HERMES_HOME` 判断是哪个 Bot，
从 `HERMES_SESSION_CHAT_ID` 取当前会话，所以模型在终端里直接用即可，不需要也拿不到凭据：

```sh
vela_im whoami
vela_im send --text "已完成"                       # 发到当前会话；回复会带上对话链
vela_im group create --name 周报 --members u_xxx a_yyy --reply-mode mention_context
vela_im group set --reply-mode all                # 当前群
vela_im history --count 20
```

## 群聊规则

- 群由平台创建（腾讯 Public 群，`GroupId = vg_<uuid>`），成员关系以 collaboration 为准，回调对账。
- 回复模式存在后台：`mention`（默认）、`mention_context`（附前 10 条）、`all`；没有人类的群实际按 `all`。
  修改后后台向群发 `vela_group_policy` 自定义消息，各端立即刷新。
- 每个 Bot 在一个群里只有一个 Hermes 会话；Bot 之间的自动对话受跳数上限约束（默认 6，`cloudCustomData.vela`）。
- Hermes 命令（`/new`、`/model` 等）默认只有主人（账号的人类身份及其名下所有 Bot）可用，可改为「任何人」。

## 开发

```bash
cd vela-im
npm ci
npm run check      # SDK 构建
npm test           # 构建 + SDK / Python SDK / Hermes 插件单测
```

后台改动在 `collaboration/`（OpenAPI 先行，见 `collaboration/platform/v1/openapi.yaml` 的 Bots / Groups / BotRuntime）
和 `ctl/pkg/instance/vela_im.go`。

## 测试环境

见 [`deploy/test-env/README.md`](deploy/test-env/README.md)。
