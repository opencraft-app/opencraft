# Codex bridge 能力对照清单

目标：内置 Codex 全部走 provider bridge，退休旧路径（`apps/opencraft-daemon/src/codex-engine-adapter.ts` 及其 Codex 库）。退休前，bridge 线程必须提供旧路径已有的全部用户可见能力。本清单是 [P8](README.md) 之前的能力对齐范围；每项补齐时在此更新状态与证据。

核验基线（2026-11-21，只读）：

- 旧路径：`codex-engine-adapter.ts` 处理的方法与通知。
- bridge：daemon 侧 `apps/opencraft-daemon/src/codex-provider-bridge.ts` 对 `bridge:codex:` 线程的路由；Engine Host 侧 `apps/agent-bridge-host/src/codex-runtime.ts` / `codex.ts`。
- 原生：固定 Codex 0.162.1 `codex app-server generate-json-schema` 导出的方法。
- 通用 bridge 提供者 `apps/local-agent-host/src/bridge-engine-provider.ts`（Pi、DSH）同样声明 queue/fork/rename/archive 为 false，这是 bridge 家族的共同缺口，不只是 Codex。

## 已具备

bridge 线程目前只路由以下方法；其它线程级方法一律返回 `Method unavailable for this bridge thread`。

| 能力 | bridge 路径 |
|---|---|
| 新建（显式 opt-in） | `thread/start {agentBridge}` → `session/create` |
| 发送、steer、中断 | `turn/start`、`turn/steer`（需 evidence 扩展）、`turn/interrupt` → `turn/stop` |
| 续接、读取、历史分页 | `thread/resume`、`thread/read`、`thread/turns/list`、`thread/items/list` |
| 退订、steer 状态、审批回复 | `thread/unsubscribe`、`opencraft/steer/status`、interaction resolve |
| 事件 | turn/item/消息增量/reasoning/plan/tokenUsage/审批投影 |
| 执行准入与会话 MCP | `turn/start` 携带 `opencraftExecutionAdmission`、`opencraftSessionMcp` |

与线程无关的方法（`model/list`、`opencraft/codex/accounts/*`、`opencraft/tasks/*`、`opencraft/schedules/*`、`command/exec`、`thread/list`）仍由旧 adapter 经 Core 处理，`thread/list` 已对 bridge 线程做 ID 投影。退休旧 adapter 时这些要另找 owner，见末节。

## A. Codex 原生已支持，只需接线

bridge 协议加方法与能力声明，Engine Host 转发原生请求并投影 ID，daemon 路由，客户端按声明开放入口。

| 能力 | 原生方法 | 旧路径 | 备注 |
|---|---|---|---|
| 分叉 | `thread/fork` | 有 | 协议已有 `forkCheckpoint` 能力位，Codex 声明为 false；新线程需新的 `bridge:codex:` 身份与 Host 账本记录 |
| 重命名 | `thread/name/set`、`thread/name/updated` | 有 | 旧路径同时失效标题缓存 |
| 归档 / 取消归档 | `thread/archive`、`thread/unarchive` 及通知 | 有 | 需定义归档后 bridge 会话的保留与续接 |
| 删除 | `thread/delete`、`thread/deleted` | 有 | 需同步清理 Host 账本与网关 inbox 的绑定 |
| 目标（goal） | `thread/goal/get|set|clear` 及通知 | 有 | 旧路径还在 goal 激活时执行模型使用策略检查 |
| 图片输入 | `turn/start` 的 `localImage` / `image` | 有 | bridge 声明 `inputContentTypes: ["text"]`；附件暂存见 B |
| 压缩上下文 | `thread/compact/start` | 未暴露 | 非对齐必需，按产品需要 |

## B. OpenCraft 自有能力，需要在 bridge 侧确定 owner

旧路径把这些放在 daemon 的 Codex 库或 adapter 内存里。bridge 线程的常驻 owner 是 Engine Host，daemon 可能重启；凡是必须在 daemon 不在时继续推进的，放 Engine Host。

| 能力 | 旧路径 owner | 建议 owner | 说明 |
|---|---|---|---|
| 排队 `thread/queue/add|list|update|reorder|delete|start|steer|retry|collaborationReceipt` 及 `thread/queue/changed` | `OpenCraftHostQueue`（`opencraft-host-queue.ts`） | Engine Host 命令账本 | 设计已预留 `next-turn` 投递方式；轮次结束时出队派发需在 daemon 不在时继续 |
| 标题生成 | `CodexThreadTitles` | daemon（观察 bridge 事件） | 不影响执行连续性 |
| 置顶 `thread/pins/updated` | `codex-thread-pins.ts` | daemon | 纯展示状态 |
| 线程设置 `thread/settings/update` | adapter 配置刷新 | 共享配置 owner | P7a 已让 bridge 消费同一 Codex 配置刷新 owner，需补线程设置入口 |
| 附件暂存 | `LocalAttachmentStagingService` | daemon 暂存后以本地路径传入 | 与图片输入一起做 |
| 维护准入（`codex-admission.paused`） | adapter 检查 | daemon 路由层统一检查 | 目前 bridge 线程的 `turn/start` 不受维护暂停约束，属漏洞 |
| 模型使用策略 | adapter 在 `turn/start`、goal 激活时检查 | daemon 路由层统一检查 | 目前 bridge 线程绕过 |
| 历史读取取消 `thread/history/cancel` | adapter | daemon | 长历史读取的取消 |
| 待建线程 | `ProvisionalThreads` | 由 bridge 的 `session/create` 幂等语义取代，需核实 UI 依赖 | |
| 编排 / 协作回执 | adapter 与 orchestration | P7a 执行 CLI 已覆盖 spawn/tell/wait；queue follow-up 待做 | 见 P7a 剩余范围 |

## C. 不需要在 bridge 内对齐

- SSH 远程 Codex（`kind: "remote"`）：bridge 只接本机 Core，远程 Host 保留现有路径，不在本清单退休范围。
- 实时语音 `thread/realtime/*`、`thread/revert`、`thread/shellCommand` 等原生能力：旧路径未暴露，不是对齐项。

## 已有会话的连续性

- 并存期：账号 Core 与 APP Server 使用桌面现有 `codexDataDirectory`（同一 `CODEX_HOME` 与账号库），已有会话不迁移数据。路由按线程 ID 前缀，非 `bridge:codex:` 的已有会话继续由旧 adapter 经 Core 读写。
- 关闭 bridge：已有会话不受影响；开启期间创建的 `bridge:codex:` 会话因“native fallback refused”暂不可用，原生数据仍在 `CODEX_HOME`，重新开启即恢复。开关说明须写明。
- 退休前必需：**接管已有会话**。当前规则是线程 owner 由创建前缀决定、永不 adoption，旧 adapter 退休后已有会话将无 owner。须新增：以原线程 ID 在 bridge 内续接原生会话（原生 `thread/resume`），Engine Host 账本补登记，公开 ID 不变；只在会话空闲时接管，活动轮次与排队输入先在旧路径结算。未完成此项不得退休旧 adapter。

## 退休旧 adapter 时的其余 owner

线程无关的能力目前借旧 adapter 的连接：账号管理、任务、定时、`command/exec`、模型列表、`thread/list` 合并。退休 adapter 前，需要一个不持有线程执行的 Codex 控制 owner（直接连 Core 控制接口）接住它们。

## 顺序建议

1. B 中的维护准入与模型使用策略：现在就是漏洞，先补。
2. A 中的分叉、重命名、归档、删除、目标：原生已有，接线即可。
3. 排队（Engine Host 落地）、图片输入与附件。
4. 标题、置顶、线程设置、历史取消。
5. 已有会话接管、线程无关能力的 owner 拆分，然后才能进入 P8。
