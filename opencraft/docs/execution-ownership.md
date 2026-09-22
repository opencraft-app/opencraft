# 会话、执行运行时与能力租约所有权

本设计适用于 OpenCraft 的会话执行边界。DSH 是首个具体实现；其他引擎通过自己的 adapter 实现相同语义，不必采用 DSH 的 Agent 对象或私有 bridge。

会话存在、历史可读、运行实例已加载、工具访问权有效、某轮正在执行是不同事实。不得用一个 `ready` 或 `loading` 同时表达它们。

## 对象与唯一所有者

| 对象 | 唯一 Owner | 身份与寿命 |
|---|---|---|
| Draft | 客户端草稿服务 | 本地输入意图；不是服务端 Thread |
| Thread 与产品目录 | 执行 Host 的 ThreadLifecycle/ThreadCatalog | `(hostId, threadId)`；跨连接保留 |
| 历史 | 对应引擎的持久化服务 | 原生日志是历史真源；目录、Replica 和 UI 不另存权威副本 |
| 引擎运行实例 | Host 的引擎 adapter | DSH Agent 是内存执行对象，可加载、空闲保留、卸载 |
| Capability 声明与访问租约 | Host capability broker | 绑定 Thread 和具体 logical client incarnation；可撤销 |
| 引擎内工具挂载 | 引擎插件 | 绑定当前 native Agent 实例；不等于访问权限本身 |
| Turn 执行权 | Host execution authority | 连接 owner、执行 epoch、Turn 身份；直到明确终态 |
| View 与导航 | 客户端 Shell | 页面呈现、焦点、订阅；不拥有引擎资源的最终执行权 |

同一个 Thread 可以存在且可读取，但没有活跃引擎实例。关闭 View 不等于停止 Turn；连接撤销不等于删除历史。原生 preset 属于引擎 composition，外部 Browser/Terminal/Connector 工具通过可撤销 scope 接入，不能把客户端回调权限固化进 preset。

## Readiness 的含义

| 条件 | 可以证明 | 不能证明 |
|---|---|---|
| Host/AppServer ready | 协议连接已初始化 | 某 Thread 已恢复或可执行 |
| History authoritative | 首屏历史有服务端基线 | Agent 已加载、工具已挂载 |
| Capability declaration accepted | Host 接受当前客户端的声明 | Engine 已完整挂载；冷态允许 deferred |
| Engine tools mounted | 当前实例具有所需工具集合 | 旧客户端仍获授权、模型或权限仍匹配 |
| Turn admission accepted | Host 接受本轮执行 | 推理或工具操作已成功完成 |

`AgentRuntimeDirectory.ensureReady()` 当前是 Host 连接边界，不能用其名字推导为 Thread 执行实例就绪。Renderer 的 `capabilityDeclarationAccepted` 可以接受冷态 deferred；真正执行前的完整挂载检查属于 Host。

## 新建、恢复与执行

新建路径：

1. Host 验证声明并为本次创建分配 native session ID。
2. 引擎创建 Agent，在 native setup 内挂载 preset 和首次 Host capability scope。
3. setup 失败由引擎创建生命周期收尾，不能发布半装配的 Session。
4. Host 确认客户端仍有效，绑定 broker 声明，确认挂载结果。
5. 准备成功后提交产品目录、订阅及 `thread/started`。
6. 第一轮输入通过执行准入后进入引擎。

上述目录提交顺序只适用于 `thread/start` 已经产生可恢复持久身份的
Host。Codex AppServer 的新 Thread 在首轮接纳前可能只有内存身份、writer
lock 与 shell snapshot，尚无 rollout；此时 Renderer 若先将 Draft 升级为
Thread，激活阶段的 `thread/resume` 会与首轮提交竞态并得到
`no rollout found`。这类 Host 必须声明
`opencraft/thread-start-durability: { durableAfter: "first-turn-accepted" }`：
Workbench 在同一 Draft 提交事务内依次完成 `thread/start` 与首个
`turn/start`，收到含 Turn ID 的回执后才导航升级；确定性失败保留原 Draft
及原输入。该能力不声称两个 RPC 是数据库原子事务，也不允许在未知网络
结果后自动重发。

恢复已有会话时，历史读取独立完成并呈现；capability 声明可在后台准备。失败不清空已恢复历史、不删除已有 Thread。用户执行时重试所需准备，并在提交位置呈现失败。

执行准入必须保证检查与提交之间绑定没有变化。Capability 替换和执行准入复用 Host 的 ThreadLifecycle 队列；引擎执行权继续由 execution authority 管理。不能只在 `await validate` 前检查“当前没有执行”，随后无条件卸载工具。

停止任务、审批回复、撤销与队列删除不等待 capability 初始化；仍需验证各自对应的 Thread、Turn、请求身份和权限。控制操作应在故障时保持可达。

## 撤销、重连与释放

断线首先同步撤销客户端 owner 与执行权限，再异步清理引擎挂载和待处理调用。所有在途操作在提交前重新验证 owner；旧请求不能恢复已撤销租约。

Logical client incarnation 与 physical socket、客户端提供的 logical ID 分开。同一物理连接重新建立同名 logical client 时使用新的 owner 身份；旧实例的清理不能删除新实例。

工具挂载和完整 Agent release 在引擎侧使用同一 native session 操作队列。只把 release 后的 unregister 放进队列不够，Agent dispose 本身也必须受协调。Host 的旧 owner 清理不得撤销后继 owner 的能力。

注销失败属于真实失败，不能静默当作成功继续替换。连接清理可以尽力完成，但权威访问权限必须已经撤销。关闭插件时先停止接受新的生命周期操作，再等待既有操作收尾并释放资源。

## 不变量

| ID | 约束 |
|---|---|
| EXO-01 | 目录查询、历史读取和 View 呈现不隐式获得 Turn 执行权 |
| EXO-02 | Thread 持久身份、native runtime 实例、连接 incarnation 和执行 epoch 不混用 |
| EXO-03 | 声明接受、冷态 deferred 与完整挂载是不同结果 |
| EXO-04 | Capability 替换与执行准入共用 Thread 协调边界，校验到提交之间不可被替换 |
| EXO-05 | Owner 先撤销后清理；所有异步完成均受生命周期有效性约束 |
| EXO-06 | 停止、审批回复和撤销不依赖重新准备工具成功 |
| EXO-07 | 新建产品目录不早于准备成功发布；已有持久历史不得作为挂载失败的补偿删除 |
| EXO-08 | 相同工具挂载幂等；完整挂载、释放和清理必须遵循同一资源顺序 |
| EXO-09 | Bridge 只返回允许列表中的错误码；截断任意异常文字不构成脱敏 |
| EXO-10 | 预热复用正常准备流程，不改变身份、权限或持久化语义 |

## 已有复用与 warm 的边界

当前已存在 Host 连接 single-flight、DSH session activation single-flight、Thread binding 复用，以及最后订阅离开后的默认 30 分钟延迟卸载。这些机制应继续由现有 owner 管理。

当前没有 Codex 式预创建 Thread reservation，也没有 WorkBuddy 式 hover 后提前 loadSession 的产品流程。若引入预热，应先证明耗时所在，再定义目标配置指纹、连接/引擎代次、单次消费、TTL 和失效释放。预热失败允许正式请求重试；其 TTL 不得回收其他消费者或活动 Turn 持有的资源。不要为预热再创建第二套 Thread 或 Agent 权威。

## 实现与验证入口

- Host 装配：[main.ts](../apps/local-agent-host/src/main.ts)。
- 目录/订阅/协调：[ThreadLifecycle](../apps/local-agent-host/src/thread-lifecycle.ts)。
- 客户端租约：[DshCapabilityBroker](../apps/local-agent-host/src/dsh-capability-broker.ts)。
- 执行权：[DshExecutionAuthority](../apps/local-agent-host/src/dsh-execution-authority.ts)。
- 引擎生命周期：[thread engine](../apps/local-agent-host/src/dsh-thread-engine.mjs)、[capability plugin](../apps/local-agent-host/src/dsh-capability-plugin.mjs)。
- Renderer 历史和声明准备：[Workbench runtime](../packages/workbench-runtime/src/appserver-runtime.ts)。

回归必须覆盖：注册悬挂时历史可读且停止可达；校验期间断线后迟到提交被拒绝；替换与 Turn 准入交错；同 socket logical client 重建；并发重复挂载；setup 挂载失败后原生列表无新 Session；释放与挂载交错；错误正文包含敏感内容仍不回传。

模型测试从 `tests/thread-lifecycle.test.ts`、`tests/dsh-capability-broker.test.ts`、`tests/dsh-execution-authority.test.ts`、`tests/chat-workbench-draft.test.ts` 进入；真实引擎验证使用 `scripts/smoke-dsh-capability-plugin.ts`。这些是验收范围，不能把测试入口存在当成每种交错已完整验证。

## 尚未闭合的交付边界

Native setup 回滚、Host 目录提交和跨进程回执不是一个数据库事务。当前 Host 预分配 native session ID，使请求超时后的运行资源释放可以定位原创建；这仍不等于跨重启幂等或 exactly-once 创建。

创建已持久化但响应丢失时，后续还需稳定 operation ID、结果查询和重试复用契约。补偿不能以删除持久日志代替确认。工具挂载的端到端 lease revision/CAS 以及超时取消传播也不能仅凭串行队列推定已经实现。

本设计描述所有权和目标不变量；当前测试、全量 gate、签名包与对方机器的验收证据分别记录在[整改 Task Pack](../../docs/context/tasks/2026-09-21-dsh-ownership-rectification.md)。源码修改不等于旧分发包已经更新。
