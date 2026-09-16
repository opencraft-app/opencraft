# Agent 删除闭环设计

## 1. 目标

为 Human Owner/Admin 提供幂等的 Agent 删除能力。删除是 Server 内 Agent 身份的
逻辑删除，不是 Computer 或腾讯云 TAT 生命周期操作。

## 2. 权威事实

删除请求先在同一个 `server_id` 分片事务内完成：

- Agent 写入 `deleted_at`，`desired_state` 变为 `stopped`；
- 对应 Member 写入 `status=removed`；
- 当前和历史未撤销 Runtime credential 全部撤销；
- ChannelMember 本地投影进入 removed；
- 活动 Reminder 取消，未确认 occurrence 终结；
- 非终态 Task 解除 owner，终态 Task 保留历史 owner；
- 所属 Computer 的 `assignment_revision` 增加；
- 写入幂等结果、腾讯 IM Operation 和 Outbox。

`AgentIMRoute` 按 `im_user_id` 分片，不能伪装成上述事务的一部分。事务提交后，
Worker 使用墓碑中不可变的 `im_user_id` 点路由并幂等撤销。路由收敛前，任何 IM
回调解析路由后都必须重读 Agent；`deleted_at` 非空即 no-op。

事务提交后 Agent 对平台已经不可用。外部副作用失败不恢复 Agent，只按稳定
Operation 重试。

## 3. Computer 收敛

Computer 的 Assignment Snapshot 不返回 `deleted_at` 非空的 Agent。Vela Controller
将 Snapshot 视为完整权威集合：删除前后集合差异只 retire 被删除 Agent 的 Cell。

删除流程不得：

- 调用 TAT stop、卸载或注销；
- 停止 Computer Controller 或共享 Hermes/Vela Gateway；
- 关闭 PTY；
- 影响同一 Computer 的其他 Agent。

Computer 离线时，平台删除仍然成功。凭证撤销保证平台访问立即失效；Computer
恢复后从新 Snapshot 收敛并终止遗留 Agent 工作负载。

## 4. 腾讯云 IM 收敛

Worker 对 Agent IM UserID 有序执行：

1. 撤销 `AgentIMRoute`；
2. `v4/im_open_login_svc/kick`，使当前登录和历史 UserSig 会话下线；
3. `v4/im_open_login_svc/account_delete`，永久删除普通账号。

202 只保证平台本地权限和 Runtime credential 已撤销；只有 IM Operation 成功才保证
腾讯 IM 侧旧登录态完成失效。Worker 必须检查 `account_delete` 每一个
`ResultItem.ResultCode`：`70107` 按幂等成功处理，`71000` 按不可重试能力错误和上线
门禁处理。外部失败永不恢复本地 Agent。

`account_delete` 负责：

1. 永久删除 Agent 的腾讯云 IM 普通账号；
2. 清理该账号的关系链、资料、群组成员关系和自身会话状态；
3. 使 Agent 不再具备登录和收发消息能力；
4. 平台不再为该 UserID 签发 UserSig。

Agent ID、IM UserID 和 handle 永久保留在平台墓碑中且不得复用。腾讯云返回“账号不
存在”时按幂等成功处理。平台历史消息引用继续使用原 IM UserID；上线前必须通过真实
Canary 验证其他 Human 在账号删除后仍可拉取并展示既有群聊和 DM 消息。

## 5. Workspace、Task 与 Reminder

- workspace 默认保留在 Computer 磁盘，物理清理由独立、显式能力负责；
- `todo`、`in_progress`、`in_review` Task 解除 owner，同时增加 assignment revision
  和资源 revision，并记录操作者；
- `done`、`closed` Task 保留原 owner 作为历史事实；
- `active`、`paused` Reminder 取消、清空 `next_fire_at` 并增加 revision；
- 仅 `due` occurrence 取消；`acknowledged` 历史事实保留；
- 已领取的通知在真正发送前重读当前 revision、owner 和 Agent tombstone。

## 6. HTTP 与界面

`DELETE /v1/servers/{serverId}/agents/{agentId}` 需要 `Idempotency-Key`，返回
`202 AcceptedResource`。重复同键同请求返回相同结果；同键不同请求返回幂等冲突。

Agent 管理页只向 Owner/Admin 展示危险操作。用户二次确认后提交删除：202 前请求
失败保留当前详情；收到 202 后立即从活跃列表移除，并继续显示 Operation 状态。
后续 IM 收敛失败只展示失败/重试状态，不得把 Agent 恢复为活跃。

HTTP 幂等查询必须先于 active Agent 查询；同 key 重试返回原 202。不同 HTTP key 或
记录过期后遇到同一 tombstone，也必须复用墓碑对应的稳定 IM 删除 Operation。HTTP
幂等键和外部 IM 操作键分离，后者绑定不可变 Agent ID 与 delete revision。

## 7. 验收条件

- 删除运行中 Agent 后，它立即不能使用 Runtime credential；IM Operation 成功后旧
  UserSig 会话也不能继续；
- Assignment revision 增加，新 Snapshot 不包含该 Agent；
- Vela 只 retire 目标 Agent，Computer 与其他 Agent 保持运行；
- 历史消息、终态 Task 和 workspace 保留；
- 非终态 Task 解除认领，Reminder 不再触发；
- 重复请求、Worker 重试和 Computer 离线均不产生重复副作用或状态回滚。
- 真实 Canary 中，`account_delete` 后其他 Human 仍可拉取并展示该 Agent 的既有群聊
  和 DM 消息；若腾讯云实际行为不满足此条件，则发布门禁失败，不得静默降级。

所有 currentness 路径必须以 `deleted_at IS NULL` 为 terminal fence，包括 Agent
管理、Assignment、launch、Runtime auth/session、UserSig、presence/heartbeat、
observation、Task/Reminder Runtime API 和异步完成回写。Vela 验收使用两个运行中的
Agent：删除一个只 `ClearDesired` 目标 Cell，另一个 Cell 与共享 Hub 保持运行；不得
调用 TAT Computer stop/uninstall/deregister/terminal API，也不得关闭无关终端。
