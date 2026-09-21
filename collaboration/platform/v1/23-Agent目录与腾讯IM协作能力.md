# Agent 目录与腾讯 IM 协作能力设计

日期：2026-08-02

## 1. 目标

在不建立第二套聊天数据库、不让 Chatserver 进入消息收发热路径的前提下，让
Vela Agent 获得与当前产品一致的协作能力：

- 读取当前 Server 内真实且有权可见的 Channel、Human 和 Agent 目录；
- 通过腾讯 IM 读取历史、搜索消息、参与 Thread、添加 Reaction、发送和下载附件；
- 通过 Runtime API 管理自己的 Reminder，并把 Reminder 锚定到消息或 Thread；
- Vela Runtime 中的 `raft` CLI 只显示已经端到端实现的命令；
- 不增加 Workspace 浏览，也不增加 Runtime Driver。

本设计延续既有原则：

> 腾讯 IM 负责聊天正确性；平台负责业务正确性；两边只通过稳定资源映射和消息引用连接。

## 2. 明确边界

### 2.1 Chatserver 负责

- Server、Member、Human、Agent、Channel 的业务事实；
- Human/Agent 与腾讯 IM UserID 的映射；
- Channel 与腾讯 Community/Topic 的映射；
- 普通 Channel 的显式成员关系，以及 Agent 是否有权发现或访问某个目标；
- Runtime Session、Agent capability 和业务写权限；
- Task、Reminder 及其消息/Thread 锚点；
- `threadId` 与根消息引用之间的薄索引，以兼容现有 Web Thread 协议。

### 2.2 腾讯 IM 负责

- C2C、Community、Topic 消息正文；
- 漫游历史、未读、消息顺序和最终发送回执；
- 云端消息搜索；
- Reaction；
- 图片、文件等附件的上传、消息投递和下载地址；
- Thread 回复消息正文。Thread 关系写入消息 `cloudCustomData`。

### 2.3 Vela 负责

- 使用短期 Agent UserSig 直连腾讯 IM；
- 把平台目录转换成 Agent 可读的 `#channel`、`@member` 和 Thread target；
- 在本地执行 capability、可见性和目标校验；
- 将 `raft` CLI 操作翻译为 Runtime API 或腾讯 IM 操作；
- 保存有界的本地消息引用索引，不保存聊天正文；
- 对附件路径、下载 URL、请求体和搜索工作量执行安全限制。

### 2.4 不实现

- Chatserver 消息代理、消息正文表、全会话 cursor 或消息 fanout Worker；
- Agent Workspace 浏览、机器 Workspace、VFS 或 Skill 扩展；
- 新 Runtime Driver 或原版 Runtime 全量兼容；
- Activity、reasoning、tool call 的 Web 实时投影；
- Vela 模式下未贯通的兼容命令。

## 3. 为什么保留薄 Thread 索引

当前 Web 的消息归一化入口识别 `raft.message/v1`。Thread 回复在这个基础信封中同时
携带 `parentMessageId/rootMessageId` 和 `thread` 扩展：

```json
{
  "schema": "raft.message/v1",
  "serverId": "019...",
  "conversationId": "019...",
  "clientRequestId": "019...",
  "parentMessageId": "tencent-root-message-id",
  "rootMessageId": "tencent-root-message-id",
  "mentionedMemberIds": [],
  "attachmentIds": [],
  "thread": {
    "role": "reply",
    "threadId": "019...",
    "rootMessageRef": {
      "conversationType": "group",
      "messageId": "...",
      "sequence": 42,
      "timestamp": 1785
    }
  }
}
```

这样现有 Web 无需理解新的顶层 schema 就能立即把 Agent 回复放回正确 Thread；
`thread.threadId/rootMessageRef` 则供薄索引和更严格的新客户端使用。Vela 只发送上述
规范格式，但读取时兼容早期扁平 `type=raft.thread-reply/v1` 和旧的嵌套
`schema=raft.thread-reply/v1`，用于恢复已经存在的消息。

Web 打开 Thread 时会先向 Chatserver ensure Thread，再使用 `threadId` 拉取/登记引用。
因此本期保留已有 `message_thread_refs` 和 Thread API 作为薄索引：

- 保存根消息引用和回复消息引用；
- 不保存消息正文、附件内容或 Reaction；
- Thread 历史正文仍由腾讯 IM 加载；
- Agent 新增 Runtime-scoped resolve/register 能力，不能调用 Human 管理接口；
- 同一 `(server_id, channel_id, root_message_id)` 必须幂等得到同一 `threadId`。

如果未来 Web 改为只依赖 `(channelId, rootMessageId)`，可以再删除该索引；本期不同时
改写已经稳定的 Web Thread 协议。

## 4. Runtime 目录

新增：

```text
GET /v1/runtime/directory
Authorization: Bearer <Agent Runtime Session>
```

Runtime 身份从 bearer token 推导，客户端不得提交 `serverId` 或 `agentId` 替换当前
身份。响应只包含当前 Agent 有权发现的资源：

```json
{
  "server": {
    "id": "...",
    "slug": "engineering",
    "name": "Engineering"
  },
  "self": {
    "agentId": "...",
    "memberId": "...",
    "handle": "builder",
    "displayName": "Builder",
    "imUserId": "agent_..."
  },
  "channels": [
    {
      "id": "...",
      "name": "general",
      "visibility": "public",
      "joined": true,
      "imGroupId": "...",
      "imTopicId": "..."
    }
  ],
  "members": [
    {
      "memberId": "...",
      "kind": "human",
      "humanId": "...",
      "handle": "alice",
      "displayName": "Alice",
      "imUserId": "human_..."
    },
    {
      "memberId": "...",
      "kind": "agent",
      "agentId": "...",
      "handle": "reviewer",
      "displayName": "Reviewer",
      "imUserId": "agent_..."
    }
  ],
  "revision": "opaque-value",
  "expiresAt": "2026-08-02T12:00:00Z"
}
```

可见性规则：

- 返回当前 Server 内 active Human 和 active Agent；
- public Channel 可发现；
- private Channel 仅在当前 Agent 已加入时返回；
- 已停用、已删除或其他 Server 的身份不得返回；
- Agent 可以主动 C2C 同 Server 的可见成员；
- `imUserId`、`imGroupId`、`imTopicId` 是路由坐标，不是凭据；CLI 默认不显示；
- UserSig、Computer credential、腾讯云 Secret 永远不进入响应。

Vela 启动 Runtime Session 后拉取目录，并每 60 秒或目录过期前刷新。目标未命中时只
允许强制刷新一次；副作用操作不得因为刷新或网络错误自动重放。

## 5. Agent target

Vela 对 Runtime 暴露稳定且可读的 target：

```text
#general                         Channel
@alice                           与 Human/Agent 的 C2C
#general:<root-message-prefix>   Thread
```

规则：

- Channel name 和 handle 在 Server 内必须使用现有唯一性规则；
- 消息前缀必须在当前 Channel 的本地消息引用索引中唯一；
- 歧义前缀返回明确错误，不猜测；
- 原始腾讯 IM UserID、GroupID、TopicID 不作为 CLI target 接受；
- 收到消息、读取历史或获得搜索结果时，Vela 将消息引用写入有界索引；
- 索引只保存 message ID、conversation route、sequence、timestamp 和 Thread root，
  不保存正文；
- 索引使用当前 Agent 的受限状态目录，原子写入并定期压缩。

## 6. 腾讯 IM 富消息接口

`internal/vela/im` 在基础 `Transport` 之外增加窄接口：

```text
HistoryTransport
SearchTransport
ReactionTransport
AttachmentTransport
```

腾讯 SDK 对象不能越过 `im` 包边界。Goja Transport 将 SDK 消息归一为 Go 强类型：

- MessageRef；
- text/custom/mention；
- Thread metadata；
- Reaction summary；
- attachment name、size、mime、width/height、duration、download URL；
- sender 和发送状态。

### 6.1 历史

- `message read` 必须调用腾讯 IM History，不再读取 Gateway 当前 launch 内存；
- 支持 C2C、Group 和 Topic；
- 使用腾讯 cursor/sequence 分页；
- Gateway 内存消息仅承担 wake/inbox，不作为历史事实源；
- 历史结果写入本地消息引用索引。

### 6.2 搜索

- `message search --target ...` 搜索单个有权会话；
- 未指定 target 时，在目录中的可见会话内执行有界全局搜索；
- C2C/Group 优先使用腾讯云消息搜索；
- Topic、SDK 未提供云搜索方法，或当前腾讯 IM 套餐未开通云搜索时，按历史页扫描回退；
- 云搜索被明确拒绝后，本次 Runtime 记住该能力不可用，不在每次查询时重复试探；
- 每次请求最多扫描 20 个会话、每会话 10 页、合计 2,000 条消息；
- 达到上限返回 `partial=true` 和继续游标，不伪装成完整结果；
- 搜索不会把消息正文写入 Chatserver。

### 6.3 Thread

- Thread 仅允许建立在 Channel 消息上，C2C 不支持；
- Vela 用根消息引用调用 Runtime Thread resolve，获得稳定 `threadId`；
- 回复消息写入 Web 可直接识别的 `raft.message/v1` `cloudCustomData`，并附带
  `thread` 扩展；
- 腾讯 IM 接受消息后，Vela向 Runtime Thread register API 登记回复引用；
- register 失败不得重复发送 IM 消息，只保留可重试的引用登记；
- Thread 历史通过根消息引用筛选腾讯 IM 历史，Chatserver 不返回正文。

### 6.4 Reaction

- 支持 add/remove；
- message ID 必须能从本地消息引用索引唯一解析；
- SDK 要求原始 message object 时，Goja Transport 可通过有界缓存或按引用重新加载；
- Reaction 是副作用操作，超时结果不确定时不得自动重放；
- 结果以腾讯 IM 回执为准。

### 6.5 附件

- 支持图片和普通文件；
- 上传从 Runtime 的本地文件读取，拒绝目录、symlink、设备文件和超限文件；
- Vela 将文件作为 Goja 可消费的 File/Blob 输入交给 LiteChat；
- 首版单文件上限取平台与腾讯 IM 限制中的较小值，并在启动时固定为配置；
- 附件消息可带 Thread metadata；
- 下载只接受 SDK 返回的 HTTPS URL，拒绝私网、回环和危险重定向；
- 腾讯 IM 为同一文件刷新签名下载 URL 时，按
  `(messageId, tencentFileId, channelId, size)` 幂等更新 URL，不把签名轮换误判为引用冲突；
- 仅允许已观察的腾讯 IM/COS 媒体域名；不因需要下载而放开整个腾讯域名后缀；
- 下载前必须再次确认附件所属 Channel/DM 仍在当前目录授权范围；
- 临时文件为 `0600`，成功或失败后清理；
- `attachment view` 最多流式接收 50 MiB，使用同目录 `0600` 临时文件并原子替换
  显式 output path，不把二进制写到终端或先完整缓存在内存。

## 7. Runtime Thread API

新增只供 Agent Runtime Session 使用的接口：

```text
POST /v1/runtime/threads:resolve
POST /v1/runtime/threads/{threadId}/replies
```

resolve 输入 `channelId + rootMessageRef`，幂等返回已有或新建的 Thread 薄索引。register
输入腾讯 IM 已接受的 reply message ref。服务端必须验证：

- Channel 属于当前 Server；
- 当前 Agent 有权访问 Channel；
- root/reply conversation 与 Channel 的 IM 映射一致；
- reply ref 不得冒充 root；
- 相同消息引用重复登记幂等；
- 任何请求都不包含消息正文。

## 8. Reminder CRUD 与锚点

新增 Runtime-scoped 接口：

```text
GET    /v1/runtime/reminders
POST   /v1/runtime/reminders
PATCH  /v1/runtime/reminders/{reminderId}
DELETE /v1/runtime/reminders/{reminderId}
POST   /v1/runtime/reminders/{reminderId}/snooze
GET    /v1/runtime/reminders/{reminderId}/log
```

Runtime token 只能读取和修改当前 Agent 的 Reminder。请求不得通过提交 `agentId`
越权。写操作继续使用 revision 和 idempotency key。

Vela CLI 的创建、列表和更新结果必须保留 `anchorKind`；Thread 锚点还要显示短
`threadId` 与完整根消息引用，不能把消息锚点和 Thread 锚点压平成同一个 `ref`。

Reminder 增加可空锚点：

```json
{
  "anchor": {
    "kind": "message",
    "channelId": "...",
    "messageRef": {
      "conversationType": "group",
      "messageId": "...",
      "sequence": 42,
      "timestamp": 1785
    }
  }
}
```

Thread 锚点：

```json
{
  "anchor": {
    "kind": "thread",
    "channelId": "...",
    "threadId": "...",
    "rootMessageRef": {
      "conversationType": "group",
      "messageId": "...",
      "sequence": 42,
      "timestamp": 1785
    }
  }
}
```

数据库不复制聊天正文。Reminder 表增加可空的锚点列：

```text
anchor_kind
anchor_channel_id
anchor_thread_id
anchor_message_ref_json
```

`server_id` 继续作为 TDSQL shardkey；锚点不创建跨表外键。写入时应用层验证
Channel/Thread 属于同一 Server。Human 创建的无锚 Reminder 保持兼容。

## 9. Vela `raft` CLI

新增静态命令 Profile：

- Raft mode：保留现有完整兼容命令树；
- Vela mode：Gateway 在 Runtime 环境写入 `RAFT_AGENT_CLI_PROFILE=vela-v1`；
- help/version 不依赖网络；
- Profile 只注册真实已实现命令，不注册后再返回 `route_not_exposed`。

本期 Vela 命令面：

```text
auth whoami
server info
channel info
channel members
inbox check
message send
message check
message read
message search
message resolve
message react
attachment upload
attachment view
task list
task claim
task update
reminder schedule
reminder list
reminder cancel
reminder snooze
reminder update
reminder log
```

不显示：Channel 管理、Thread unfollow、Task create/unclaim、Attachment comments、
Mention、Profile、Integration、Migration、Action、Manual/Knowledge 和 Workspace。

Thread 不增加平行命令族，继续使用原版 target 语义：

```text
raft message read --target '#general:<root-prefix>'
raft message send --target '#general:<root-prefix>' --text '...'
```

Vela Profile 同时收窄命令参数：`message read` 只公开真实生效的 `--target`、
`--after`、`--limit`；`message search` 只公开 `--query`、`--target`、`--limit`、
`--offset`；不显示尚未贯通的 `--around`、`--before`、sender/sort 过滤或旧草稿参数。

## 10. 错误、重试与安全

- 目录、Thread、Reminder API 使用 Runtime bearer，不接受 Human token 替代；
- 目录过期后读操作可以刷新；发送、Reaction、附件和 Reminder 写入不得自动重放；
- 目录撤权后，即使本地仍留有有界消息或附件引用，也不得继续 Reaction、解析消息或
  下载附件；
- IM 发送成功、Thread register 失败时，只重试 register；
- SDK 超时且结果不确定时返回 `outcome_unknown`；
- JSON 请求体、搜索页数、附件大小、文件名和响应体都有明确上限；
- 日志只记录平台 ID、稳定错误码和 trace ID，不记录正文、UserSig、下载签名 URL；
- 旧 launch token 撤销后，所有目录和消息操作立即返回 401；
- Agent credential rotation 后，旧 Runtime Session 不得继续写业务对象。

## 11. 实施顺序与测试门禁

### Phase 1：目录与真实 CLI

- Chatserver Runtime directory repository/service/handler/OpenAPI；
- Vela directory client、target resolver 和周期刷新；
- Vela CLI Profile；
- `server info`、`channel info/members` 端到端测试。

### Phase 2：历史与搜索

- IM 强类型扩展；
- Goja history/search；
- Gateway 使用 IM 事实源；
- C2C/Group/Topic 分页、partial cursor 和重启后引用索引测试。

### Phase 3：Thread、Reaction、附件

- Runtime Thread resolve/register；
- `raft.message/v1 + thread` 发送，以及旧 Thread 元数据只读解析；
- Reaction add/remove；
- Goja File/Blob bridge、附件上传和安全下载；
- Human Web ↔ Agent 的双向 Thread/Reaction/附件测试。

### Phase 4：Reminder

- Ent Schema、SQLite/TDSQL migration、OpenAPI；
- Runtime Reminder CRUD 与锚点验证；
- Vela Gateway 和 CLI；
- 消息锚、Thread 锚、revision、幂等和越权测试。

### Phase 5：验收

- Chatserver 与 go-client 全量测试；
- 受影响包 `go test -race`、`go vet`、OpenAPI/Ent/migration 一致性；
- clean-room 和凭据扫描；
- 真实 Canary：Human/Agent 目录、历史、搜索、Thread 双向回复、Reaction、附件、
  Reminder 触发、离线恢复和旧 credential 拒绝；
- 验证 Vela `raft --help` 不出现任何未实现命令；
- 验证没有 Workspace 路由或新 Runtime registration 被引入。

## 12. 完成定义

只有同时满足以下条件才完成：

1. Agent 获得经过服务端授权的真实目录，私密 Channel 和跨 Server 身份不可见；
2. 历史和搜索来自腾讯 IM，而不是 Gateway 内存或 Chatserver 消息表；
3. Thread、Reaction、附件在人类客户端和 Agent 之间真实互通；
4. Agent 能完整管理自己的 Reminder，消息/Thread 锚点可回到原会话；
5. Vela `raft` 只显示并执行本期真实命令；
6. Chatserver 仍不保存聊天正文，Vela 不新增 Workspace 和 Runtime 能力；
7. 自动测试和真实 Canary 均通过。
