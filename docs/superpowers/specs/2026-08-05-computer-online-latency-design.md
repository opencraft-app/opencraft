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
`RunAtLoad=true`，因此 `bootstrap` 成功后不再执行 `kickstart -k`。如果 `bootstrap` 返回错误，只有
检查发现服务已加载、指向本次 plist 与期望 program 且处于可运行状态时才按幂等成功处理；安装器
不得为了“确认启动”杀死刚创建的进程。

### daemon 就绪优先

Runtime Catalog 的外部可执行文件探测从 daemon 主启动路径移出。daemon 先完成本地锁、TAT
component、管理 IPC、assignment 获取与首次心跳；Runtime 探测在受控后台任务中完成，并通过可替换
的 Catalog snapshot 提供给随后创建的 Agent。

首版采取更小的改动：Catalog 构造不执行外部探测，Runner 启动时并发完成 snapshot。factory 在
启动首个 Agent 前等待 snapshot 终态，而 Computer 心跳和机器控制不等待。future 只发布一次不可变
终态；成功、部分 Runtime 不可用、全部 Runtime 不可用和取消都会发布一个非 nil snapshot 并唤醒
等待者。daemon 关闭会取消 probe 上下文；尚未开始 Agent 的 factory 等待随其调用 context 取消。
不支持运行中替换 snapshot，避免可见集合发生无版本变化。

### 首次心跳立即发送

Runner 的 heartbeat goroutine 启动后立即生成并发送机器级心跳，不等待本地 assignment poll。
Computer session 响应已经携带后台当前的有效 assignment epoch/revision；当 Runner 尚未应用本地
snapshot 时，platform sink 使用该 session fence 补全首报。应用 snapshot 后，心跳继续使用本地已应用
fence。这样不修改现有 heartbeat API，也不会发送 revision 0。

发送由单个 goroutine 串行执行。失败时在该 goroutine 内按已有策略重试，不启动第二个周期发送；首次
成功后才重新计算下一次 60 秒周期。不存在可能丢失的边沿通知，当前 Runner 状态始终是真源。

### 页面有限刷新

Computer 管理页存在缺少 `lastObservedAt` 的 Computer 时，每 2 秒强制刷新 Computer 列表。
`tatAgentState=unknown` 不是轮询条件：历史上已经连接过的机器即使当前状态未知，也不重新进入首次
连接轮询。全部 Computer 已首次连接、用户离开页面或组件卸载时停止。最长持续 2 分钟，到期后保留
手动刷新入口，避免异常机器导致浏览器永久轮询。

## 错误与并发

- 即时心跳失败不让 daemon 退出；沿用指数重试，成功后从该时刻恢复 60 秒周期。
- Runtime 探测结果以一次性不可变 snapshot 发布，不允许并发修改 map；空结果也是合法终态。
- daemon 关闭时取消探测上下文并等待 goroutine 退出，不泄漏子进程。
- 页面并发刷新复用现有 single-flight；定时器不绕过 Server 切换和组件卸载保护。

LaunchAgent 的 `bootstrap` 错误只有在随后读取到的 service 同时指向本次写入的 plist 和期望 program，
且处于可运行状态时才可按幂等成功处理；仅“label 已加载”不足以证明成功。

## 时间预算

在后台和本机网络正常的 Canary 验收条件下：LaunchAgent 调度不超过 1 秒；daemon 本地锁、TAT thread
和 IPC 初始化不超过 1 秒；Computer session 交换与首次 heartbeat 合计不超过 1 秒。Runtime probe、
assignment 长轮询和 Agent 启动不属于 Computer 首次在线的关键路径。超时或网络故障不误报在线，恢复
后由同一 heartbeat goroutine重试收敛。

## 验收

- LaunchAgent 单元测试证明成功 bootstrap 后没有 `kickstart -k`。
- Runner 测试使用很长的周期，仍能在 assignment poll 返回前立即尝试心跳；platform sink 测试证明
  revision 0 会由 session fence 补全，已有本地 fence 不被覆盖。
- 心跳失败跨越一个周期仍保持单路串行，成功后才开始下一个 60 秒周期。
- 慢 Runtime probe 测试证明 daemon 状态与心跳先于 probe 完成；取消和空结果都会解除 factory 等待。
- 前端测试证明从未观测的 Computer 自动刷新、在线后停止、历史已连接但 unknown 不轮询、卸载后停止。
- Agent 全量测试、前端全量测试、race/static checks 通过。
- Canary 重新安装实测从 claim 到后台 online 不超过 3 秒；后台不可达等错误场景不误报在线。
