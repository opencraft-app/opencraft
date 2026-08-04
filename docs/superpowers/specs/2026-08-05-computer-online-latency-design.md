# Computer 首次在线延迟治理设计

## 背景

macOS Computer 完成安装后，Web 仍会较长时间显示“等待连接”。本机实测链路为：

- enrollment claim 完成后约 10 秒，LaunchAgent 才稳定运行；
- daemon 进程启动后约 11 秒，才写入本地 healthy 状态；
- daemon 再等待完整的 60 秒心跳周期，后台才首次观测到在线；
- Computer 页面只在进入页面或手动刷新时重新读取，未知状态不会自动收敛。

后台处理已到达心跳只需毫秒级，延迟来自端侧启动顺序与页面读取策略。

## 目标

- 正常安装或替换后，Computer 在 1～3 秒内向后台首次声明在线。
- 保留后续 60 秒周期心跳，不因启动加速增加长期请求量。
- Runtime 探测失败或缓慢时，Computer 仍应先具备机器控制与心跳能力。
- 页面只在 Computer 尚未首次连接时短暂轮询，已连接后立即停止。
- 不增加新 API、数据库字段、后台状态机或常驻前端轮询。

## 设计

### LaunchAgent 单次启动

安装器继续按 `bootout → 等待卸载 → bootstrap → 等待已加载` 执行。plist 已配置
`RunAtLoad=true`，因此 `bootstrap` 成功后不再执行 `kickstart -k`。如果 `bootstrap` 返回错误但
检查发现服务已经加载，则仍按幂等成功处理；安装器不得为了“确认启动”杀死刚创建的进程。

### daemon 就绪优先

Runtime Catalog 的外部可执行文件探测从 daemon 主启动路径移出。daemon 先完成本地锁、TAT
component、管理 IPC、assignment 获取与首次心跳；Runtime 探测在受控后台任务中完成，并通过可替换
的 Catalog snapshot 提供给随后创建的 Agent。

首版采取更小的改动：Catalog 构造不执行外部探测，Runner 已启动后异步完成 snapshot，并在 factory
首次消费前提供结果。若 assignment 立即要求启动 Agent，单个 Agent 等待该 snapshot，而 Computer
心跳和机器控制不等待。探测失败只表示对应 Runtime 不可用，不使 daemon 退出。

### 首次心跳立即发送

Runner 应在成功应用首份 assignment 后立即生成并发送心跳。后续心跳继续每 60 秒发送。首次发送
失败沿用已有重试策略；发送操作始终位于 heartbeat goroutine，不阻塞 assignment poller。

在尚无 assignment revision 时不发送不完整心跳。一旦 revision 从 0 变为有效值，立即唤醒 heartbeat
goroutine；同一 revision 的重复 assignment 不产生额外即时心跳。

### 页面有限刷新

Computer 管理页存在 `tatAgentState=unknown` 或缺少 `lastObservedAt` 的 Computer 时，每 2 秒强制
刷新 Computer 列表。全部 Computer 已首次连接、用户离开页面或组件卸载时停止。最长持续 2 分钟，
到期后保留手动刷新入口，避免异常机器导致浏览器永久轮询。

## 错误与并发

- 即时心跳失败不让 daemon 退出；沿用指数重试，成功后恢复 60 秒周期。
- Runtime 探测结果以一次性不可变 snapshot 发布，不允许并发修改 map。
- daemon 关闭时取消探测上下文并等待 goroutine 退出，不泄漏子进程。
- 页面并发刷新复用现有 single-flight；定时器不绕过 Server 切换和组件卸载保护。

## 验收

- LaunchAgent 单元测试证明成功 bootstrap 后没有 `kickstart -k`。
- Runner 测试使用很长的周期，仍能在应用首份 assignment 后立即收到心跳。
- 慢 Runtime probe 测试证明 daemon 状态与心跳先于 probe 完成。
- 前端测试证明未知 Computer 自动刷新、在线后停止、卸载后停止。
- Agent 全量测试、前端全量测试、race/static checks 通过。
- Canary 重新安装实测从 claim 到后台 online 不超过 3 秒；后台不可达等错误场景不误报在线。
