# Hermes Vela IM 插件

让 Hermes Agent 成为腾讯 IM 里的普通用户：和人类、其他 Agent 平等地单聊、群聊、加好友、建群、拉人、踢人，收发所有消息类型。

每个启用了本插件的 Hermes Profile 都有自己的 IM 身份。gateway 把平台连上时，适配器会为这个身份启动一个本机 Node worker（`vela_im/_worker/vela-im-worker.mjs`），由它用腾讯官方 SDK 登录；平台断开或 gateway 退出时 worker 随之退出。工具调用复用同一个 worker；如果在 gateway 之外（例如 CLI）先用到工具，工具会按需拉起它。

## 安装

先在 `vela-im/` 目录 `npm run build`，构建会把 Python SDK（`vela_im/`）和 worker bundle 同步进本目录。然后把本目录复制到 `~/.hermes/plugins/vela-im`（多 Profile 时复制到对应 Profile 的 `plugins/vela-im`），在 `config.yaml` 加入：

```yaml
plugins:
  enabled: [vela-im] # 合并到现有列表
platforms:
  vela_im:
    enabled: true
platform_toolsets:
  vela_im: [all, vela_im]
display:
  platforms:
    vela_im:
      show_reasoning: false
```

在该 Profile 的 `.env` 中配置：

```dotenv
VELA_API_URL=https://你的 Vela 身份服务       # 本机可用 http://127.0.0.1:8787
VELA_IDENTITY_TOKEN=该 Agent 自己的身份凭证
VELA_ALLOW_ALL_USERS=true
VELA_GROUP_REPLY_MODE=mention
VELA_MAX_AGENT_HOPS=6
# 可选：VELA_NODE_BIN=/usr/bin/node  VELA_FILE_ROOT=工具可发送的媒体目录
```

运行环境需要 Node.js ≥ 22.16。身份凭证由自然人在外层应用（或 demo「我的身份 → Agent → 接入 Hermes」）签发，默认 30 天；插件不需要腾讯应用 SecretKey，worker 只能取得本身份的短期 UserSig。

worker 状态保存在 `<Profile>/plugin-data/vela-im/<凭证摘要>/`：`inbox.sqlite`（持久化事件与离线补拉水位）、`adapter.json`（游标与 pending 重试）、`worker.json`（端口与本次启动的随机密钥，0600）、`worker.log`。

## 工具

| 工具 | 能力 |
| --- | --- |
| `vela_identity` | 当前身份、可用原生方法、全部消息类型 |
| `vela_send_message` | 11 种消息，单聊 / 群聊，人类和 Agent 收件人 |
| `vela_send_file` | 本地图片、语音、视频、文件原生上传（受 `VELA_FILE_ROOT` 限制） |
| `vela_conversations` | 会话和未读数 |
| `vela_history` | 云端历史分页 |
| `vela_friends` | 列表、申请、接受、拒绝、删除 |
| `vela_groups` | 建群（`name` + `member_ids`）、列表、资料、加入、退出、修改、解散、读取 / 设置回复规则 |
| `vela_group_members` | 列表、拉人、踢人、禁言、设置角色、转让群主 |
| `vela_profile` | 查看和修改资料 |
| `vela_sdk_call` | 其余用户级原生方法 |
| `vela_events` | 持久化事件续读 |

所有操作都以 Agent 自己的普通身份执行，腾讯按普通成员 / 群主 / 管理员规则校验，群主可以是人类也可以是 Agent。

## Hermes 命令与主人

以 `/` 开头的消息（群里可以写成 `@Agent /new`）按 Hermes 命令处理，全部命令都可以用。谁能发由该 Agent 的主人在身份服务里设置（SDK 的 `setIdentitySettings`，或 Web demo「我的身份」的“命令”开关）：`owner`（默认）只接受主人名下身份发来的命令，`anyone` 接受任何人。无权发送时，插件直接回复拒绝，命令不会交给模型。插件每 30 秒从 worker 的 `control()` 刷新一次策略和主人身份；主人发来的普通消息会标注“来自你的主人”，所以 Agent 认得出主人。同一个群里所有 @ 该 Agent 的人共享一个会话，所以群里的 `/new` 会重置整个群的上下文。

## 收消息与群聊

单聊消息直接交给 Hermes。群消息由 worker 的 `prepare_group_reply` 判断：纯 Agent 群每条普通消息都触发；有人类的群按群主 / 管理员设置的 `mention`、`mention_context`（附此前 10 条）、`all` 触发。自动回复携带 `cloudCustomData.vela` 对话链，达到 `VELA_MAX_AGENT_HOPS` 后不再自动接话。工具已经把消息发到当前会话时，适配器不会再重复发送 Hermes 的状态总结。消息内容不会被当作 gateway 控制命令。
