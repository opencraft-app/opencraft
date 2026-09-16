# 多自然人、多 Agent Group/Topic P1 设计

日期：2026-07-30
状态：已获用户批准，进入 TDD 实施

## 1. 目标

在不增加平台消息数据库、不恢复自研 Computer 长连接的前提下，让多个自然人与
多个 Agent 在同一腾讯 IM Community/Topic 中稳定协作。

P1 只解决：

- Human 与 Agent 加入同一 Server；
- Group/Topic 实时和离线消息；
- 显式 `@Agent` 定向唤醒；
- 一条消息同时 `@` 多个 Agent；
- Agent 回复原会话；
- 防止未提及消息和 Agent 自身消息造成回复风暴。

## 2. 固定拓扑

- 一个平台 `Server` 映射一个腾讯 IM `Community`。
- `#全员` 映射 Community 根会话。
- 普通 `Channel` 映射 Community `Topic`。
- Public/System Channel 使用 Community 隐式成员。
- Private Channel 使用 Topic 显式成员。
- Human 与 Agent 都使用普通、对等的腾讯 IM UserID。
- 每个 Agent 由一个独立 `vela run` 进程承载，独立登录腾讯 IM。
- 同一 Computer 可以并发运行多个不同 Agent；同一 Agent 只能有一个 Host。

腾讯 IM 负责消息存储、顺序、未读、漫游和群成员关系。平台只保存资源映射、
成员期望状态、异步操作和 Agent 运行配置，不保存第二份消息正文。

## 3. 唤醒规则

默认 `replyPolicy` 为 `mention_and_dm`：

| 会话与消息 | 是否唤醒 |
|---|---|
| 发给 Agent 的 C2C | 是 |
| Group/Topic 明确包含当前 Agent IM UserID 的 mention | 是 |
| 同一消息明确 mention Agent A、Agent B | A、B 各自一次 |
| Group/Topic 没有 mention | 否 |
| mention 其他 Agent | 否 |
| Agent 自己发送的消息 | 否 |
| `@所有人`、广播 marker | 否 |

P1 暂不支持 `@所有人` 唤醒 Agent，也不把 `@所有人` 展开为全部 Agent。

兼容保留：

- `dm_only`：只消费 C2C；
- `all_channel_messages`：消费全部 Group/Topic 消息。

`all_channel_messages` 不是默认策略。多个此类 Agent 同群可能互相触发，P1 的真实
Canary 不使用该策略。

## 4. 后台状态链

Human 已采用两阶段状态：

1. `Account.im_state` 表示腾讯 IM 身份；
2. `Member.im_state` 表示 Server Community membership。

Agent 必须采用同样语义：

1. 创建 Agent 时保存 `Agent.im_state=provisioning`、
   `Member.im_state=provisioning`，并提交 `im.identity.ensure`；
2. identity 成功事务只把 `Agent.im_state` 置为 `ready`；
3. `Member.im_state` 保持 `provisioning`；
4. 同一事务创建一个 UUIDv7 `im.membership.ensure` 和对应 OutboxEvent；
5. membership Worker 调腾讯 `add_group_member`；
6. 成功后才把 `Member.im_state` 置为 `ready`。

identity 失败时：

- `Agent.im_state=error`；
- `Member.im_state=error`；
- 不创建 membership operation。

升级旧数据时，启动阶段执行一次幂等 reconciliation：

- 只选择 active、Agent identity ready、Member ready，且从未存在
  `im.membership.ensure` 的旧 Agent；
- 按当前 revision 条件更新 Member 为 provisioning 并递增 revision；
- 同事务创建 UUIDv7 membership operation/outbox；
- 已有 membership operation 的新旧 Agent 永久跳过；
- 腾讯 `add_group_member` 必须按幂等操作处理：正常响应中的成员
  `Result=1`（本次加入）与 `Result=2`（已经是成员）都视为成功；真实 Community
  还可能对“已经是成员”返回顶层 `ErrorCode=10013`，Ensure 路径同样归一为成功。
  Remove 路径不得套用这一规则。
- 完整扫描并成功持久化所有 repair operation 后，在固定 synthetic partition 写入
  `maintenance.agent_membership_backfill.v1` 终态 marker；后续启动 O(1) 跳过，
  marker 不会被任何腾讯副作用 Worker 消费。

所有操作继续使用 `server_id` 作为分区键，`desired_revision` 进行 fencing。派生的
membership operation ID 由应用层 UUIDv7 生成器提供，不在 Repository 内随机生成。

## 5. 消息路径

```text
Human/Agent
  → 腾讯 IM Community/Topic
  → 每个 Agent 的 Node IM Bridge
  → Go Host
  → Runtime Adapter 精确匹配当前 Agent UserID
  → Agent Runtime
  → 本地 Capability Gateway
  → 原 Bridge/腾讯 IM 会话
```

- Bridge 保留完整 mention UserID 数组，不按显示名匹配。
- Runtime Adapter 在调度前过滤 ReplyPolicy。
- Agent 自发消息按发送者 UserID 过滤，不能回灌自己。
- Capability Gateway 只允许回复当前 Host 已接收并登记的会话 target。
- 离线恢复走腾讯未读/历史，使用同一 ReplyPolicy，过滤后再 mark read。

## 6. API 与数据库

P1 不新增消息 API、Delivery API 或消息正文表。

复用现有：

- Server、Member、Agent API；
- Channel/Topic CRUD；
- Channel Member add/remove；
- Runtime Session；
- `members`、`agents`、`channels`、`channel_members`；
- `tencent_operations`、`outbox_events`、`idempotency_records`。

本轮后台生产代码的必要变化只在 Agent identity 成功后的 membership 派生链，
以及相应测试。现有 Channel/Topic 和 Private Topic membership 管理面保持不变。

## 7. 测试顺序

严格 TDD：

1. RED：identity 成功必须产生 pending `im.membership.ensure`，Member 仍为
   provisioning；
2. RED：identity 失败不得产生 membership operation；
3. GREEN：应用层生成 UUIDv7 并在完成事务中创建派生 operation/outbox；
4. RED/GREEN：membership Worker 真正把 Agent Member 收敛为 ready；
5. RED/GREEN：Bridge Group/Topic 多 mention 保真；
6. RED/GREEN：两个 Runtime Adapter 对单 @、多 @、无 @、其他 @、自发消息、
   `dm_only`、`all_channel_messages`、广播 marker 的分发矩阵；
7. 离线 Group/Topic 恢复、去重、mark read；
8. Chatserver 与 Go Client 全量测试、race、vet、凭证扫描。

## 8. 验收

自动验收至少覆盖：

- 两个 Human Member 与两个 Agent Member；
- Agent identity 和 Community membership 都 ready；
- Human A 在 Topic 只 `@Agent A`：仅 A 启动；
- Human B 同时 `@Agent A`、`@Agent B`：A/B 各处理一次；
- 普通消息与 `@所有人`：两个 Agent 均不启动；
- Agent A 回复：A 不触发自己，未被明确 mention 的 B 不触发；
- Agent 离线期间收到的定向 Topic 消息，恢复后只处理一次；
- Private Topic 只有显式成员可参与。

真实 Canary 采用独立测试资源，不接管或删除当前线上 Canary；若缺少第二个自然人
登录主体，则先完成双 Agent + 两个测试 Human IM UserID 的腾讯闭环，并把人工 UI
验收步骤明确记录。

## 9. 非目标

- `@所有人` 唤醒 Agent；
- Activity 流；
- 平台代发或平台 Delivery 路由；
- 平台聊天消息持久化；
- 附件、任务、提醒、公开发现、意图撮合、VFS；
- 本地多 Agent supervisor；
- Agent 身份类型猜测或根据 UserID 前缀判断 Human/Agent。
