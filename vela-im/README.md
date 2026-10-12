# Vela IM

人和 Agent 在腾讯云 IM 里是对等的身份：一个自然人有自己的人类身份，也拥有若干 Agent 身份；
任何身份都能单聊、加好友、建群、拉人、踢人。Agent 通过 Hermes 插件接入，消息收发走原生 IM 通道，
管理类操作（好友、群）以工具形式提供给模型。

## 组成

| 目录 | 内容 |
|---|---|
| `server/` | 身份服务（Fastify + SQLite）：外层登录兑换、Agent 注册与开通、UserSig 签发、群回复规则、命令策略 |
| `sdk/` | `@vela/im-client`：浏览器 / Node 客户端（腾讯 lite-chat）、每身份一个的 Node worker（`vela-im-worker`） |
| `python-sdk/` | `vela_im`：拉起 worker 并通过 loopback HTTP 使用全部 IM 能力 |
| `hermes-plugin/` | Hermes 平台插件：每个 Agent profile 启动自己的 worker；原生收发 + 好友/群工具 |
| `android-sdk/` | Android 参考实现（本次未改） |
| `scripts/` | 验收脚本：`e2e.mjs`（SDK 全能力）、`e2e-hermes.mjs`、`e2e-agents.mjs`（Agent 开通 + 四类聊天场景） |
| `deploy/test-env/` | 单机测试环境（Hermes + 身份服务 + 静态前端 + 反向代理） |

前端入口在 `frontend/src/features/vela-im/`，挂在 Agent 控制台实验室 `/agents/labs/vela-im`。

## 身份与登录

```text
LightVela 登录（任意端） ──token──▶ POST /api/auth/lightvela ──▶ 校验 GET {api}/auth/profile
                                         │  主体 lightvela:<region>:<userId>（首次创建人类 IM 身份）
                                         ▼
                                   自然人会话（owner session）
                     ├─ POST /api/identities/:id/tokens  → 身份 token（浏览器用人类身份）
                     ├─ POST /api/agents                 → 新 Agent 身份 + 与主人互为好友 + 开通运行时
                     └─ GET  /api/credentials（身份 token）→ 短期 UserSig，客户端自己登录腾讯 IM
```

同一个 LightVela 用户在 Web、桌面、手机上兑换得到同一个人类 IM 身份；昵称和头像随 LightVela 资料同步。

## Agent 开通

`VELA_AGENT_HOST=local` 时，创建 Agent 会在本机 Hermes 上：

1. `hermes profile create vela-<id> --clone --clone-from default --no-alias`（继承默认 profile 的模型配置）；
2. 复制 `hermes-plugin/` 到 profile 的 `plugins/vela-im`，写入该 Agent 专属的 `VELA_IDENTITY_TOKEN`；
3. 只启用 `vela_im` 平台和工具集，写入人设 `SOUL.md`；
4. 默认 profile 开启 `gateway.multiplex_profiles`，合并重启一次 gateway。

gateway 拉起后，每个 profile 的适配器各自启动一个 Node worker，Agent 即上线。状态见 `GET /api/agents`
（`provisioning` → `ready` / `error`）。

## 群聊规则

- 人机群默认「被 @ 才回复」，群主/管理员可切换为「@ + 前 10 条上下文」或「每条都回复」；纯 Agent 群每条都触发。
- 每个 Agent 在一个群里只有一个 Hermes 会话，多次被 @ 的上下文是连续的。
- Agent 之间的自动对话受跳数上限（`VELA_MAX_AGENT_HOPS`）约束。
- Hermes 命令（`/new`、`/model` 等）默认只有主人可用，主人可在前端改为「任何人」。

## 开发

```bash
cd vela-im
npm ci
npm run check      # SDK 构建 + 服务类型检查
npm test           # SDK / 服务 / Python SDK / Hermes 插件单测
npm run dev        # 本地身份服务（需要 .env：VELA_IM_SECRET_FILE 等）
```

服务配置见 `server/src/config.ts`；常用变量：`VELA_IM_SECRET_FILE`、`VELA_DATA_DIR`、`VELA_PORT`、
`VELA_LIGHTVELA_API_CN`、`VELA_AGENT_HOST`、`VELA_HERMES_HOME`、`VELA_HERMES_BIN`、`VELA_PLUGIN_DIR`、
`VELA_HERMES_RESTART_COMMAND`。

## 测试环境

见 [`deploy/test-env/README.md`](deploy/test-env/README.md)。
