---
id: task-opencraft-ssh-native-goals-20261011
type: task
scope: SSH Codex 原生已有 Goal 的能力发现与呈现。
triggers: []
owner: skipzhang
authority: primary
source_of_truth:
  - opencraft/apps/opencraft-daemon/src/codex-native-surface.ts
  - opencraft/apps/opencraft-daemon/src/codex-engine-adapter.ts
status: active
reviewed_at: 2026-10-11
review_due: 2026-11-11
revision: 1.0.0
precedence: task
derived: false
---

# SSH Codex 原生 Goal 发现

## goal
SSH 连接上的工作台发现并读取远端 Codex 已有的 Thread Goal。

## non_goals
- 不接管 SSH Codex 的 Goal 自主续跑，不在发现/读取时创建、恢复或修改真实 Goal。
- 不发布或重启当前服务；Git 提交、推送、合入已获用户明确授权。

## requirement_ids / requirement_refs / requirement_excerpt
- 本轮用户：Codex 接线无法发现 Codex 本身已经有的 goal；确认连接为 SSH 远程机器。
- 后续用户明确要求“提交 推送 合入master”。

## interface_refs / data_structure_refs
- `opencraft/apps/opencraft-daemon/src/codex-native-surface.ts`：远端能力投影和 method admission。
- `opencraft/packages/appserver-protocol/src/extensions.ts`：Thread Goal capability 的 read/write 分离。
- `opencraft/packages/appserver-protocol/src/generated/v2/ExperimentalFeature.ts`：原生功能目录的 name/enabled。
- `opencraft/packages/workbench-runtime/src/thread-goal-resource.ts`：Thread scoped get/notifications/confirmed writes。
- 原生 Goal 状态及计数归远端 Codex；缓存不是第二权威。

## history_context
- current_design_refs：`opencraft/docs/platform-architecture.md`；`opencraft/docs/chat-ui-architecture.md#thread-goals`。
- relevant_evolution：MR !5183 的 SSH 附件接线保留共享 native surface 的本机 store 过滤；Goal 原生 RPC 未进入该 surface。
- superseded_refs：无。

## acceptance
- 支持并启用 goals 的远端完成初始化后，既有 Goal 可通过真实 Runtime 和 Web Goal Surface 展示。
- 显式只读声明保留只读；禁用/不支持/探测失败不伪造能力，普通会话仍可连接。
- 并发 logical Client 共享一次发现；关闭时晚到发现不能建立就绪状态。
- 读取 active Goal 和 Turn 完成通知不会产生桥接端的自主 Goal 写入或 Turn 启动。

## affected_paths
- `opencraft/apps/opencraft-daemon/src/codex-native-surface.ts`
- `opencraft/apps/opencraft-daemon/src/codex-engine-adapter.ts`
- `opencraft/tests/ssh-native-surface.test.ts`
- `opencraft/tests/fixtures/fake-codex-ssh-proxy.mjs`
- `opencraft/scripts/smoke-ssh-codex-workbench.ts`
- `opencraft/docs/chat-ui-architecture.md`
- `docs/engineering/domains/agent-gateway-runtime.md`
- `opencraft/tests/ssh-codex-routing.test.ts`

## required_context
- Router 无匹配后按局部入口读取 AppServer/Runtime 相关正式文档与维护验证清单。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md`、`opencraft/AGENTS.md` | 工作边界 | 能力诚实、实时证据与分层交接 |
| `docs/context/tasks/TASK-TEMPLATE.md`、`CHECKPOINT-TEMPLATE.md` | 非简单任务状态 | 记录验收与检查点 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | 检索邻接卡 | 检查邻居 `thread-goal-resource.test.ts` |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md`、`references/verification.md` | 协议与 Web 验收 | 源码/进程区分和晚到结果围栏 |
| `opencraft/docs/platform-architecture.md` | Host 和 Runtime 所有权 | 在 Host 边界发现能力 |
| `opencraft/docs/chat-ui-architecture.md` | 原生 Goal 设计 | 保留已有 UI 与 Server authority |
| `docs/engineering/domains/agent-gateway-runtime.md`、`docs/context/domains/agent-gateway-runtime.md` | 变更影响映射命中 | 同步 SSH 原生 Goal 的发现与续跑边界 |

## evidence
- Router query `OpenCraft Codex 原生已有 goal 发现 读取 thread goal 接线`：无匹配。
- 有界 exact search：`thread/goal/get`、`OPENCRAFT_THREAD_GOAL_EXTENSION` 于 adapter/native surface/runtime/UI；SSH 明确过滤 Goal extension 且未放行 RPC。
- SSH 原生只读探测：Codex 0.162.1；`experimentalFeature/list` 的 goals 为 stable/enabled=true；`thread/goal/get` 返回一个 active Goal。未读取或记录目标正文、凭据。
- 此 checkout 无 `ref/codex`；有界扩大到机器上的只读 Codex source 核对功能目录和 Goal get handler，不把参考源代替实际远端响应。
- 当前源码实际 SSH 集成：`/tmp/opencraft-goal-actual-runtime-20261011.json`，Runtime capability/read admission 成功，既有 active Goal 与用量字段可读；发出的方法仅 initialize/initialized/experimentalFeature-list/goal-get。
- AppServer 270/270；SSH 92 passed、1 环境条件 skip；Goal resource 5/5；daemon/runtime/web typecheck 与平台边界通过。
- 独立 headless Web build `/tmp/opencraft-ssh-goal-web-20261011` 成功；完整 Workbench 浏览器 fixture 验证桌面/手机、明暗主题、刷新后已有 Goal 显示，单次 physical feature discovery，无 Goal 写入/Turn 启动。
- 文档 0 errors、0 broken links；按实际 9 文件变更集合运行 docs-impact 通过（不能用仅已提交 HEAD diff 的空集合代替）。
- 当前服务 MainPID 保持 97189、active；本轮没有更新运行包或重启。

## risks
- 功能目录探测为只读并有超时；失败降级到无 Goal 能力。
- 初始化发现必须对 logical Client 和关闭状态做有效性检查。
- SSH Goal 续跑保持由远端原生 Codex 所有；桥接端禁止追加自主续跑。

## validation
- Daemon/Runtime/Web typecheck、边界检查、AppServer/SSH 回归与真实 Web Goal Surface 浏览器验收。
- 当前源码 adapter + 实际 SSH native + Runtime 的只读集成验证。
- 文档链接及改动影响检查。

## decisions
- 远端没有 OpenCraft extension 时，从 native `experimentalFeature/list` 的 goals.enabled 发现支持；已有显式 extension 按 read/write 声明。
- 发现发生于共享 physical 初始化，不对每个 UI 或 logical Client 重复探测，不扫描/恢复 Thread。

## scan_scope
- Daemon native surface、Runtime Goal resource、Web Goal Surface 和相关测试。

## scan_output
- 私有探测脚本 `/tmp/opencraft-remote-goal-probe-20261011.ts`，不含 credentials，不进入 Git。

## handoff
- stage：源码修复与隔离构建/验证完成；用户已授权 Git 交付。本记录是提交前检查点，合入结果以最终交付回执与工蜂 MR 为准。
- verified：真实 SSH 原生 Goal 经当前 adapter/Runtime 可读；完整 Workbench fixture 浏览器通过；各项回归、类型、边界及文档检查通过。
- unverified：当前用户正在运行的服务仍是原构建；未对真实 Goal 执行 set/clear 或推理。
- discard：本机暂停 Goal 与 SSH 用户报告不同；错误 parser 名及旧同步初始化 mock 已修正；普通 Web 构建不满足 headless fixture 的交付目标，改用含正式 Host profile 的隔离 headless build。
- restore：本轮无真实 Goal 状态写入；当前运行服务未更新。
- next_action：提交、推送并经工蜂 MR 合入 master；运行服务更新属于后续单独指令。
