# Agent 在线投影

状态：v1 实施规格  
日期：2026-08-04

## 1. 原则

Agent 在线状态只组合两类一手事实：

1. Computer daemon 对当前 Assignment/launch 的 Runtime observation；
2. Agent 直连腾讯云 IM 后的 transport 状态，以及腾讯 IM 状态回调。

后台不为 Agent 创建 TAT probe，不维护第二条 Agent 控制链，也不把某次 start 请求
永久解释为在线。TAT 只观测 Computer。

## 2. 持久化事实

```text
desired_state                 用户期望：running / stopped
observed_state                当前 launch：starting / running / stopped / error
current_launch_*              后台签发的当前 launch fencing
observed_*                    daemon 已确认的 fencing 与递增 sequence
im_transport_state            Agent 本地 IM transport：connected / disconnected / error
im_transport_updated_at       daemon 观测时间
im_presence                   腾讯回调：unknown / online / offline
im_presence_updated_at        腾讯回调 EventTime
host_last_seen_at             当前 credential 最近一次成功访问平台
last_error_code               稳定错误码
```

不设置逐 Agent 探测排队时间字段。

## 3. Runtime observation

Computer 每次拉取 Assignment 都获得 `assignmentEpoch` 和 Agent generation。启动 Runtime
时生成 `launchId` 和 attempt。回报必须同时匹配当前：

```text
computerId + assignmentEpoch + agentId + generation + credentialVersion
+ launchId + attempt + sequence
```

后台拒绝旧 epoch、旧 generation、旧 credential、旧 launch、旧 attempt 和非递增
sequence。单个 Agent 的错误不会升级为 Computer 或 IM 连接故障。

## 4. 腾讯 IM 回调

端点：

```text
POST /v1/callbacks/tencent-im/state
```

回调按全局 `agent_im_routes.im_user_id` 定位 `server_id + agent_id`。只接受正确
SDKAppID、命令字、签名、时间窗口和大小限制的 `State.StateChange`；同一 Agent 只应用
严格更新的 EventTime，重复和乱序事件幂等忽略。

`Login` 投影为 online，`Logout/Disconnect` 投影为 offline。该事实用于诊断，不替代
daemon 报告的本地 IM transport 状态。

## 5. availability 派生

1. `desired_state != running`：offline；
2. 当前 launch fencing 尚未被 daemon 确认：unknown；
3. `observed_state` 为 stopped/error：offline；
4. `im_transport_state` 为 disconnected/error：offline；
5. `host_last_seen_at` 超过租约：offline；
6. 当前 launch 为 running、IM transport connected 且租约有效：online；
7. 其他：unknown。

腾讯回调可能延迟或缺失，所以 `im_presence` 不单独决定 availability；它保留为独立
诊断事实。

## 6. 故障恢复

- daemon 重启：重新拉取完整 Assignment，并为新启动生成新 launch fencing；
- Agent Runtime 崩溃：RuntimeActor 按本机策略重启并回报新 attempt；
- IM 断线：Agent 内嵌 IM transport 自行重连并回报状态；
- Computer 失联：后台通过 `tat.computer.refresh` 修正 Computer 状态；
- 后台短暂不可用：daemon 保留本机当前 Assignment，恢复后继续长轮询和回报。

## 7. 验收

- 腾讯 IM 回调签名、时间窗口、乱序与身份路由测试；
- current launch fencing 与 sequence 单调性测试；
- Agent、IM transport、Computer daemon 分别被杀后的恢复测试；
- credential 轮换后旧 launch 无法继续更新；
- 全状态 availability 矩阵；
- 代码和正式文档中不存在逐 Agent TAT operation 或探测 Worker。
