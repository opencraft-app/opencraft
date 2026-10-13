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
     启用 vela-im 插件，profile .env 写 VELA_ALLOW_ALL_USERS=true（准入由平台把关），acli gateway restart --agent <profile>
  5. state=ready
```

- 幂等：已 ready 直接返回；失败停在可重试状态，`lastErrorCode` 记录原因。
- 上限：每个账号同时开通的 Bot（未删除）不超过 `--max-im-bots-per-account`（默认 20，1–200），
  新开通或恢复已删除 Bot 时检查，超出返回 409 `bot_quota_exceeded`，不产生任何腾讯侧副作用。
- `POST /v1/me/bots/{id}/credential` 轮换：`credential_version + 1` 并重新交付，旧凭据立即失效。
- `DELETE /v1/me/bots/{id}`：踢下线、删除腾讯账号、吊销凭据（Host.Revoke 删除实例上的凭据文件）。腾讯只允许体验版删除账号
  （释放 100 个账号的名额）；付费版返回 71000，账号下线后闲置，平台不再为它签发登录凭证；
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
- 修改名称 / 回复规则、踢任何人：群主和管理员；解散：只有群主；任何成员可以移除自己（退群），群主不能被移出。
- 建群和拉人只能直接添加操作者账号下的身份（主人与其 Agent）；其他人凭邀请链接加入。
- 单聊只允许同一账号下的身份之间，或同在一个进行中的平台群里的成员之间（`C2C.CallbackBeforeSendMsg` 校验）。
- 腾讯回调需在控制台开启：建群前、入群申请前、拉人入群前（非平台发起一律拒绝）、新成员入群后、成员退群后、
  群解散后、群资料修改后（绕过平台改的群名会被改回）、群内发言前与单聊发消息前（封禁与单聊关系校验）。
  回调暂不可用时发消息放行，平台故障不阻断聊天。
- 解散后成员关系保留，成员仍能读取群：`dismissedBy` 是 `owner`、`admin` 或 `tencent`（在腾讯侧被解散），管理员解散时带 `dismissReason`。聊天页据此在输入框位置提示，向已解散群发消息失败时弹窗说明。
  普通成员可以拉入、移出自己账号下的 Bot（多人群里每个人带自己的 Agent）。人和 Bot 适用同一套权限。
- 邀请：群主或管理员 `POST /v1/me/groups/{id}/invite-link` 得到 7 天有效的凭据（群 ID + 过期时间的 HMAC，
  密钥由访问令牌密钥派生，不落库）；其他 LightVela 用户 `POST /v1/me/group-invites/accept` 加入，已是成员时幂等返回。
  凭据过期、被篡改或群已解散返回 410 `im_group_invite_invalid`。
  规则变化后以管理员发送自定义消息 `{"businessID":"vela_group_policy","groupId","replyMode","revision"}`，各端据此刷新缓存。
  建群成功后以管理员发送与腾讯客户端建群相同格式的 `{"businessID":"group_create","opUser":<建群人>}`，
  管理员 REST 建群时腾讯不会自动发送这条通知。两种通知都不计未读，Bot 不会回复。
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
chatserver im accounts [--list] [--check|--repair --im-sdk-app-id ID --im-admin-user-id UserID --im-secret-key-file 文件]
```

按类型和状态统计平台记录的账号；`--check` 用 `account_check` 逐批核对，报告“平台认为在但腾讯没有”的账号
（已删除的 Bot 在付费版仍在腾讯侧闲置，不算不一致）。`--repair` 在核对后补导入这些账号，并在腾讯侧补建进行中的平台群，
用于更换 SDKAppID 或账号被绕过平台删除后的恢复。只读打开数据库，可与 `serve` 并存。各环境应使用独立 SDKAppID，
并且不能丢弃数据库后复用同一个 SDKAppID，否则旧账号会成为无人记录的孤儿。

## 8. 管理后台接口

`--admin-token-file` 配置后注册 `/v1/admin/im/**`（安全方案 `AdminBearer`），只由 gateway-dashboard BFF
以服务端 Token 调用，经 admin-gateway 暴露为 `/admin/api/collaboration/*`：

| 接口 | 作用 |
| --- | --- |
| `GET /admin/im/summary` | 人类 / Bot 账号、平台群、被限制身份数量，以及预计占用的腾讯账号数 |
| `GET /admin/im/identities?q=&kind=` | 按 IM UserID、`usr_`、账号 ID 精确或按名称查找账号 |
| `POST /admin/im/identities/{userId}/restrict`、`/release` | 限制（下线 + 停发 UserSig）或解除 |
| `GET /admin/im/groups?q=&state=`、`GET /admin/im/groups/{id}` | 平台群与成员 |
| `POST /admin/im/groups/{id}/dismiss` | 解散平台群；`reason` 必填（1–200 字），群成员读取群时得到 `dismissedBy=admin` 和 `dismissReason` |
| `POST /admin/im/accounts/{accountId}/bots/{botAgentId}/disable` | 停用 Bot（等同用户删除） |
| `POST /admin/im/tencent-check` | 与腾讯逐批核对平台记录的账号 |

列表的筛选、计数和分页都在数据库里完成（`limit` 最大 200，`offset` 从 0 开始），按创建时间倒序；不筛选类型时人类和 Bot 合并排序。腾讯核对按批次（每批 100 个）遍历全部记录。写操作只定位单个身份、群或账号下的 Bot。

## 9. 错误码

`bot_agent_not_found` 404、`bot_agent_not_ready` 409、`bot_instance_not_owned` 403、`bot_host_unavailable` 503、`bot_quota_exceeded` 409、
`im_group_not_found` 404、`im_group_not_ready` 409、`im_identity_unknown` 422、`im_identity_restricted` 403、
`im_group_invite_invalid` 410。
