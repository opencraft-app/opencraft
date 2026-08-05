# Computer 状态新鲜度与心跳抖动设计

## 背景

Computer 首次上线已经通过 Session 建连即续租、首份 assignment 后立即 heartbeat，以及前端 2 秒有限轮询收敛到 1～3 秒。当前剩余问题位于两个反方向：

- Computer 一旦被页面观测过，前端就停止自动刷新；daemon 退出后，页面可能持续显示旧的“在线”投影，直到用户手动刷新或重新进入。
- daemon 的周期 heartbeat 固定为每 60 秒；大量 Computer 同时启动时，后续心跳可能长期保持相位接近，形成周期性请求和数据库写入尖峰。

## 目标

- 保留现有首次连接 2 秒轮询和 2 分钟上限。
- Computer 管理页面可见时，已连接 Computer 的在线/离线投影持续收敛。
- 页面重新回到前台时立即校准 Computer 投影。
- 终端创建明确返回 `computer_offline` 时立即校准对应页面状态。
- 周期 heartbeat 的平均间隔仍为 60 秒，每轮加入独立的 ±10% 均匀抖动。
- 不增加 API、数据库字段、后台状态机或新的常驻连接。

## 非目标

- 不把 Computer 在线状态改成前端乐观状态。
- 不改变后台 90 秒 Host Lease TTL。
- 不改变 heartbeat 失败时的 1～30 秒指数退避。
- 不引入 WebSocket/SSE 推送 Computer 状态。
- 不在本轮改变 Agent 在线投影。

## 前端状态新鲜度

`ManagementRouteSurface` 只在 `section === "computers"` 时维护刷新生命周期：

1. 进入页面仍立即执行现有 `refreshComputers()`。
2. 存在 `lastObservedAt == null` 的 active Computer 时，保留每 2 秒刷新、最长 2 分钟的首次连接轮询。
3. 页面处于前台时，每 30 秒执行一次 `refreshComputers({force: true})`，覆盖已经在线、离线或曾经连接过的 Computer。
4. 应用从非 active 状态重新进入 active 时，立即执行一次强制刷新，并从该时刻重新计算 30 秒周期。
5. 页面离开、组件卸载或 Server 切换时，停止对应定时器和前台状态订阅。

30 秒刷新与 2 秒首次连接轮询可以同时触发，但都复用 AppStore 已有的 Server 级 single-flight，因此不会产生并发重复请求。30 秒刷新只存在于用户正在查看 Computer 页面时，不是全局后台轮询。

### 明确离线错误

`createComputerTerminalSession` 收到结构化 `PlatformError` 且 `code === "computer_offline"` 时，在保留原操作错误的同时触发一次 Computer 强制刷新。刷新失败不得覆盖原终端错误；刷新成功只更新 Computer 集合，使操作入口与真实离线投影收敛。

普通网络错误、权限错误和终端协议错误不推断 Computer 离线，也不触发额外刷新。

## Heartbeat 抖动

daemon 保留 `HeartbeatInterval = 60s` 作为基准。每次需要启动新的周期计时器时，计算：

```text
next = uniform(0.9 × base, 1.1 × base)
```

默认基准下即 54～66 秒，期望值仍为 60 秒。每轮成功 heartbeat 后重新独立取样；周期定时器到期但当前尚无有效 assignment fence 时，也重新取样下一轮。

以下路径不增加抖动：

- assignment 应用后的即时唤醒；
- daemon 启动时从持久 cursor 恢复后的即时唤醒；
- heartbeat 请求失败后的指数退避重试；
- context 取消和 daemon 关闭。

因此抖动只分散正常续租相位，不延迟首次在线，不在故障恢复路径叠加随机等待。最坏 66 秒周期相对 90 秒租约仍保留 24 秒正常余量。

Runner 配置提供内部可注入的 interval jitter 函数，生产默认使用均匀随机实现，测试使用确定性序列。自定义函数返回非正值时回退到基准 interval，避免计时器忙循环。

## 并发与错误语义

- 前端所有周期刷新继续走现有 `refreshComputers` single-flight；慢请求期间跳过本轮，不堆积定时任务。
- 前端失去焦点后不发周期刷新；重新 active 只发一次即时刷新。
- heartbeat 仍由单 goroutine 串行发送；抖动不创建第二条发送路径。
- heartbeat 失败期间保持同一 heartbeat ID 和最新 assignment fence 切换语义；只有成功后才安排新的抖动周期。
- 后台仍以服务器接收时间写入 `host_last_seen_at`，不信任端侧时钟。

## 测试与验收

### 前端

- 已观测且在线的 Computer 在页面可见时每 30 秒强制刷新。
- 非 Computer 页面不启动状态新鲜度刷新。
- 应用进入后台后周期刷新停止，重新 active 时立即刷新。
- 首次连接 2 秒轮询仍可在 30 秒刷新存在时运行，single-flight 不重复请求。
- 页面卸载和 Server 切换后旧定时器不能继续刷新。
- `computer_offline` 终端错误触发一次强制刷新并保留原错误；其他错误不触发。

### Agent

- 默认抖动结果始终位于基准 interval 的 90%～110%。
- 注入确定性 jitter 后，连续成功 heartbeat 使用不同的指定周期。
- assignment 唤醒仍立即发送，不等待 jitter。
- 失败重试只使用现有指数退避，成功后才启动下一次抖动周期。
- jitter 返回非正值时回退到基准 interval。

### 发布门禁

- 前端定向测试、全量测试和 TypeScript 类型检查通过。
- Agent 定向测试、全量测试、`go test -race` 和 `go vet` 通过。
- Canary 页面首次在线速度不回退；daemon 停止后，页面最迟在后台租约过期加 30 秒内显示离线。
