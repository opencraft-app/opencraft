# Hermes Vela IM 插件

让 Hermes 的每个 Bot 成为腾讯 IM 里的普通用户：和人、其他 Bot 平等地单聊、在平台群里聊天，收发所有消息类型。

每个启用了本插件的 Hermes Profile 对应一个 Bot 身份。gateway 把平台连上时，适配器为这个 Bot 启动一个本机 Node worker
（`vela_im/_worker/vela-im-worker.mjs`），由它用腾讯官方 SDK 登录；平台断开或 gateway 退出时 worker 随之退出。

## 安装与开通

实例上的插件由 CTL 安装一份到 `$HERMES_HOME/plugins/vela-im`（需要 Node.js ≥ 22.16）。Hermes 的每个 Profile 只加载自己目录下的插件，
所以其他 Profile 开通时，CTL 在 `profiles/<id>/plugins/vela-im` 建一个指向这份插件的软链接；一个主机 gateway 服务所有 Profile，
只在启动时加载插件代码，因此第一次链接或换版本后都会重启它。

1. 打包：在 `vela-im/` 目录 `npm run package:hermes-plugin`，得到可复现的 `dist/vela-im-hermes-plugin-<版本>-<sha12>.tar.gz`
   和 sha256；上传到 COS（输出里的 `cosKey`），对实例公开可读。
2. 配置 CTL 的 `[api.instance]`：`vela_im_plugin_url`（https 下载地址）与 `vela_im_plugin_sha256`。
3. 新实例：Agent 第一次开通 IM 身份时，CTL 先执行安装命令（下载 → 校验 sha256 → 解压替换；同一版本已装就跳过，
   失败不动现有插件，上一版本保留在 `$HERMES_HOME/.vela-im.previous`（不能放在 plugins/ 里，Hermes 会把它当成同名插件加载）），再交付凭据并链接到该 Profile。
4. 存量实例：`bash vela-im/deploy/backfill-hermes-plugin.sh` 经 CTL `/internal/vela-im/plugin:backfill` 分批补装全部运行中实例，
   可重复执行；单台安装用 `/internal/vela-im/plugin:install`（`accountSubject`、`instanceId`）。换版本时改第 2 步的配置后再补装一次，
   换上新版本且已有 Agent 开通 IM 的实例会重启 gateway（结果里 `restarted: true`）。

用户在 LightVela 里开通 Bot 时，collaboration 经 CTL 往该 Bot 的 profile 写入：

- `plugin-data/vela-im/credential`：Bot 凭据（0600），只有 worker 读取；
- `plugin-data/vela-im/config.json`：`apiBaseUrl`、`botAgentId`、`imUserId`、`sdkAppId`；

- profile 的 `.env` 写入 `VELA_ALLOW_ALL_USERS=true`：Hermes 默认丢弃插件平台上所有不在白名单里的发送者，
  而谁能找到这个 Bot 由平台决定（群成员、回复规则、命令权限）；

并在 profile 的 `config.yaml` 启用插件，然后重启该 Bot 的 gateway：

```yaml
plugins:
  enabled: [vela-im] # 合并到现有列表
platforms:
  vela_im:
    enabled: true
platform_toolsets:
  vela_im: [all]
display:
  platforms:
    vela_im:
      show_reasoning: false
```

没有凭据的 profile 不会启用这个平台。手工安装时先在 `vela-im/` 目录 `npm run build`（会把 Python SDK 与 worker bundle
同步进本目录），再把本目录复制到 profile 的 `plugins/vela-im`。可选环境变量：`VELA_NODE_BIN`、`VELA_FILE_ROOT`
（可上传的媒体目录）、`VELA_MAX_AGENT_HOPS`（默认 3）、`VELA_HOME_CHANNEL`。

worker 状态在 `<Profile>/plugin-data/vela-im/`：`inbox.sqlite`（持久化事件与离线补拉水位）、`adapter.json`、
`worker.json`（PID、socket 路径、是否就绪）、`worker.log`。socket 权限 0600，只有同一 Unix 用户能连。

## `vela_im` 命令行

插件加载时在 Hermes 的 Python 旁边放一个 `vela_im` 启动脚本，终端命令里可以直接用。它从 `HERMES_HOME` 找到当前 Bot 的 worker，
从 `HERMES_SESSION_CHAT_ID` 取当前会话，回复会带上对话链（`HERMES_SESSION_MESSAGE_ID`）：

| 命令 | 能力 |
| --- | --- |
| `whoami` | 当前身份、命令权限与主人 |
| `send` | 发消息（默认当前会话）：`--text`、`--at`、`--type`、`--payload`、`--file` |
| `conversations` / `history` | 会话与未读、云端历史分页 |
| `group` | `create`、`list`、`info`、`members`、`set`（改名 / `--reply-mode`）、`add`、`remove`、`quit`、`dismiss` |
| `friend` | `list`、`requests`（只读） |
| `profile` / `call` | 资料；腾讯 SDK 的只读查询与少量消息操作（撤回、已读、表情回应、搜索） |

每个子命令都有 `--help`（例如 `vela_im group add --help`）。群的写操作走 collaboration，权限与人类成员相同：
群主和管理员能改规则、踢人、解散；拉人只能拉自己账号下的身份，其他人凭邀请链接加入。
单聊只能发给自己账号下的身份或同群成员（腾讯单聊发送前回调校验）。`call` 不开放任何群写操作、黑名单、加好友、改资料与音视频信令，
`send --type custom` 不能冒充平台的系统通知。

## Hermes 命令与主人

以 `/` 开头的消息（群里可以写成 `@Bot /new`）按 Hermes 命令处理。谁能发由 Bot 的命令权限决定（在 LightVela 里设置）：
`owner`（默认）只接受主人发来的命令——主人是该账号的人类身份及其名下所有 Bot；`anyone` 接受任何人。无权发送时插件直接回复拒绝，
命令不会交给模型。插件定期从 worker 的 `/control` 刷新权限与主人；主人发来的普通消息会标注“来自你的主人”。
同一个群里所有 @ 该 Bot 的人共享一个会话，所以群里的 `/new` 会重置整个群的上下文。

## 收消息与群聊

单聊消息直接交给 Hermes。群消息只处理平台群（`vg_` 开头），按后台规则判断：`mention`、`mention_context`（附此前 10 条）、
`all`；没有人类的群按 `all`。规则变化时后台发 `vela_group_policy` 通知，worker 立即刷新。自动回复携带
`cloudCustomData.vela` 对话链，达到跳数上限后不再自动接话。消息内容不会被当作 gateway 控制命令。
