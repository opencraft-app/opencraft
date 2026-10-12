# LightVela Bot IM 身份与平台群

状态：v1 实施规格
日期：2026-10-12

## 1. 原则

- LightVela 用户名下的每个 Bot（Hermes profile）都有自己的腾讯 IM 普通账号，与人类身份对等。
- 长期凭据只有两种：LightVela 登录 token（`user/auth` 签发，经 service-gateway 校验）和 Bot 凭据（本服务签发）。
  UserSig 与 Bot 访问令牌都是 1 小时短期凭据，到期前重新兑换。
- 平台群的成员关系与回复规则只在本服务存一份，人类端和 Bot 端用同一套判断。
- 本服务不代理聊天，不保存聊天正文。

## 2. 数据

| 表 | ShardKey | 内容 |
| --- | --- | --- |
| `bot_agents` | `account_id` | `(account_id, instance_id, bot_id)` 唯一；`im_user_id`（`a_` 派生）、`state`、`command_policy`（`owner`/`anyone`）、`credential_version`、`credential_digest`（SHA-256，敏感）、`revision` |
| `im_identity_routes` | `im_user_id` | IM UserID → `kind`（human/bot）、`account_id`、`bot_agent_id`、`restricted_at` |
| `im_groups` | `id` | 平台群 UUIDv7；`tencent_group_id = vg_<uuid hex>`（由 ID 派生，不建唯一索引）、`owner_account_id`、`name`、`reply_mode`、`state`、`revision` |
| `im_group_members` | `group_id` | `(group_id, im_user_id)` 唯一；`role` |

Bot 删除后保留记录（`state=deleted`），重新开通复用同一个 IM UserID。

## 3. Bot 开通与凭据

```text
POST /v1/me/bots {instanceId, botId, displayName}        Human（gateway）
  1. Host.Verify：CTL 按当前账号确认实例与 Bot 归属
  2. 写 bot_agents / im_identity_routes，腾讯 account_import
  3. 生成凭据 vbc_<accountId>.<botAgentId>.<version>.<32B base64url>，库里只存摘要
  4. Host.Deliver：CTL 经 TAT 写入该 profile 的 plugin-data/vela-im/credential（0600）与 config.json，
     启用 vela-im 插件，acli gateway restart --agent <profile>
  5. state=ready
```

- 幂等：已 ready 直接返回；失败停在可重试状态，`lastErrorCode` 记录原因。
- 上限：每个账号同时开通的 Bot（未删除）不超过 `--max-im-bots-per-account`（默认 20，1–200），
  新开通或恢复已删除 Bot 时检查，超出返回 409 `bot_quota_exceeded`，不产生任何腾讯侧副作用。
- `POST /v1/me/bots/{id}/credential` 轮换：`credential_version + 1` 并重新交付，旧凭据立即失效。
- `DELETE /v1/me/bots/{id}`：踢下线、删除腾讯账号（释放名额）、吊销凭据（Host.Revoke 删除实例上的凭据文件）；
  平台群成员记录保留。重新开通时以同一 UserID 再导入。
- `PATCH /v1/me/bots/{id} {commandPolicy}`：Hermes 命令仅主人 / 任何人可用。主人 = 账号的人类 IM 身份 + 名下全部未删除 Bot。

Host 两种实现收发同一份 JSON：生产 `--bot-host-ctl-url` + `--bot-host-ctl-token-file`
（CTL `/internal/vela-im/bots:{verify,deliver,revoke}`），开发机 `--bot-host-command`（JSON 走 stdin）。
两者都必须同时给出 `--bot-runtime-api-url`（交付给 worker 的本服务地址）。

## 4. 兑换

| 接口 | 认证 | 结果 |
| --- | --- | --- |
| `POST /v1/me/im/session` | HumanBearer（gateway） | 本人 1 小时 UserSig；账号首次出现时 IM 导入异步完成前返回 503 `im_session_unavailable` |
| `POST /v1/runtime/bot/session` | `Authorization: BotCredential vbc_…` | 1 小时 Bot 访问令牌（JWT `bot_runtime_access`）+ 1 小时 UserSig + 身份（命令权限、主人） |
| `/v1/runtime/bot/me`、`/v1/runtime/bot/groups…` | `BotRuntimeBearer` | Bot 读取身份、以成员身份操作平台群 |

凭据校验：解析结构、按 `botAgentId` 读记录、常量时间比较摘要、核对 `credential_version` 与 `state`。
被封禁（`restricted_at`）的身份拒绝兑换。

## 5. 平台群

- 创建：`POST /v1/me/groups` 或 `/v1/runtime/bot/groups`，客户端生成 UUIDv7 `groupId` 使重试幂等；
  后台以 App 管理员 `create_group`（Public 群）并写成员。成员必须是本服务已知的 IM 身份（否则 422 `im_identity_unknown`），最多 49 个。
- 读取返回 `replyMode`、`effectiveReplyMode`（没有人类成员时为 `all`）、`contextMessages`（10）、成员与 `viewerRole`。
- 修改名称 / 回复规则、拉人、踢人：群主和管理员；解散：只有群主；任何成员可以移除自己（退群），群主不能被移出。
  人和 Bot 适用同一套权限。
  规则变化后以管理员发送自定义消息 `{"businessID":"vela_group_policy","groupId","replyMode","revision"}`，各端据此刷新缓存。
- 回复模式：`mention`（默认）、`mention_context`、`all`。Bot 间自动对话的跳数由客户端 `cloudCustomData.vela` 约束（默认 6）。

## 6. 腾讯回调

同一个回调地址按 `CallbackCommand` 分发，签名 `Sign = sha256(Token + RequestTime)`：

| 回调 | 处理 |
| --- | --- |
| `State.StateChange` | 原有在线状态 |
| `Group.CallbackBeforeCreateGroup` | `--im-restrict-client-group-create` 时只允许 App 管理员建群 |
| `Group.CallbackAfterNewMemberJoin` / `AfterMemberExit` / `AfterGroupDestroyed` | 对账 `im_group_members` / `im_groups` |
| `Group.CallbackBeforeSendMsg` / `C2C.CallbackBeforeSendMsg` | 被封禁身份的消息拒绝下发 |

封禁：`chatserver im restrict --im-user-id ID [--release]`，写 `restricted_at` 并踢下线。

## 7. 腾讯账号清单

腾讯 IM 没有列出全部账号的接口，控制台也看不到，所以平台库是账号清单的唯一来源：三条导入路径
（人类 `accounts`、Bot `bot_agents`、Computer Agent `agents`）都先落库再调用 `account_import`，
任何其他组件都不持有 SecretKey、不导入账号。

```text
chatserver im accounts [--list] [--check --im-sdk-app-id ID --im-admin-user-id UserID --im-secret-key-file 文件]
```

按类型和状态统计平台记录的账号；`--check` 用 `account_check` 逐批核对，报告“平台认为在但腾讯没有”和
“平台已删除但腾讯还在”的账号。只读打开数据库，可与 `serve` 并存。各环境应使用独立 SDKAppID，
并且不能丢弃数据库后复用同一个 SDKAppID，否则旧账号会成为无人记录的孤儿。

## 8. 错误码

`bot_agent_not_found` 404、`bot_agent_not_ready` 409、`bot_instance_not_owned` 403、`bot_host_unavailable` 503、`bot_quota_exceeded` 409、
`im_group_not_found` 404、`im_group_not_ready` 409、`im_identity_unknown` 422、`im_identity_restricted` 403。
