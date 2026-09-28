## goal
将 Codex 会话 Fork 按 OpenCraft 现有 Thread 生命周期能力契约接通到侧边栏，与 DSH 使用同一产品操作路径，并验证真实 Codex AppServer 的分支语义。

## non_goals
- 不伪造 Fork 结果、不复制 UI 历史作为分支。
- 不改变 DSH 原生 Fork 的实现或用户模型/账号配置。
- 不自动重启当前用户会话服务；部署需单独确认。

## requirement_ids / requirement_refs / requirement_excerpt
- `user-2026-09-25-codex-fork`: 用户指出 Codex 会话无 Fork、DSH 有，并要求“标准化实现”。

## interface_refs / data_structure_refs
- AppServer `thread/fork`、`ThreadForkParams/Response`；Host `initialize.capabilities.extensions["opencraft/thread-lifecycle"]`。
- `WorkbenchRuntime.resources.threads.capabilities()` 决定菜单动作；`ThreadRowMenu` 复用现有“新建分支”；CodexEngineAdapter 拥有逻辑 Client 与子 Thread 的订阅/交互 owner。

## history_context
- `current_design_refs`: `opencraft/docs/platform-architecture.md` 会话生命周期、`opencraft/design/invariants.md` WSP-07/08/12/13、`opencraft/design/thread-lifecycle/`。
- `relevant_evolution`: DSH 已声明 Fork/ephemeral/injectItems；Codex 0.156.1 协议含 thread/fork，当前适配器只声明首轮持久化扩展。
- `superseded_refs`: 无。

## acceptance
- Codex Host 只声明已验证的 Fork 相关能力；菜单与 DSH 共用动作与导航，不以 engine 名称分支。
- 真实隔离 Codex AppServer 使用合成本地模型完成源 Thread → durable Fork；若声明 ephemeral/Side Chat，需验证临时分支、注入和 unsubscribe 语义。
- Codex 多 Client 子 Thread 订阅、断线/迟到结果及失败路径有测试；DSH/Hermes 的能力门控不回退。
- 相关类型检查、聚焦测试、边界检查和 Headless 冒烟通过；运行服务更新另获授权。

## affected_paths
- `opencraft/packages/appserver-protocol/src/`、`opencraft/apps/opencraft-daemon/src/codex-engine-adapter.ts`、`opencraft/packages/workbench-runtime/src/appserver-runtime.ts`、相关测试和设计文档。

## required_context
- 根 Context Router 对 `opencraft codex native thread fork host lifecycle capability` 无匹配；先有界搜索源码。另一宽泛查询误命中 identity/frontend，已读 must_read，确认与本任务无关。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@working-tree`、`references/verification.md@working-tree` | 生命周期/运行时验证 | 能力诚实、真实 Host 冒烟 |
| `opencraft/docs/platform-architecture.md@working-tree`、`opencraft/design/thread-lifecycle/task_plan.md@working-tree` | 正式会话契约 | 区分 durable/ephemeral 与 owner |
| `opencraft/apps/opencraft-daemon/src/codex-engine-adapter.ts@working-tree` | Codex 适配入口 | capability 声明、逻辑订阅 |
| `opencraft/apps/local-agent-host/src/dsh-appserver-adapter.ts@working-tree` | DSH 对照 | 现有声明与原生 Fork 语义 |
| `opencraft/packages/workbench-runtime/src/appserver-runtime.ts@working-tree` | UI 能力消费 | 菜单/Side Chat 门控 |

## evidence
- 运行服务 Codex initialize：无 `opencraft/thread-lifecycle`，但有首轮持久化扩展；DSH initialize：`fork:true, ephemeral:true`。
- Codex 0.156.1 生成协议有 `thread/fork`；CodexEngineAdapter 已转发请求并为成功 Fork 订阅子 Thread。
- 隔离的真实 Codex AppServer + 本地合成模型：源首轮完成后 durable Fork 返回不同 child ID、`forkedFromId` 与继承的 Turn；ephemeral Fork 需 `excludeTurns:true`，注入边界消息和 unsubscribe 均成功，无外部模型请求。
- 空白 durable child 在 AppServer 重启后仍可 `thread/read` 恢复，但 Codex 原生 `thread/list` 直到子会话完成首轮才列出它。Workbench 以成功 Fork 回执作 Host 范围内临时目录投影，原生目录出现后去重撤销；刷新浏览器前可见，刷新后空白子分支仍能用直接路由恢复但暂未在列表发现。

## risks
- Codex `thread/start` 返回未持久化身份；空 Thread Fork 可能失败。要验证首轮之后的 durable Fork，菜单失败需明确反馈。
- 标准化能力声明不得把不支持的 ephemeral/injectItems/unsubscribe 一并推断为可用。
- 当前 worktree 含用户未提交改动，保留无关内容。

## validation
- `tests/appserver-protocol.test.ts` + `tests/codex-engine-adapter.test.ts`：11/11 通过；`tests/chat-workbench-draft.test.ts`：25/25 通过（含成功 Fork 回执的目录投影、Host 列表去重、ephemeral 排除）。
- `scripts/smoke-codex-engine.ts`：真实 Codex 适配器 + 本地合成模型，durable/ephemeral/inject/unsubscribe、空白分支重启恢复和首轮后列表出现通过；仅 2 个本地合成模型请求。
- 相关六个包类型检查通过：appserver-protocol、workbench-runtime、opencraft-daemon、local-agent-host、lightvela-hermes、workbench-web。
- 生命周期/Codex/DSH/Hermes 回归 115/115；目录/Sidebar/协议/Workbench 回归 40/40；平台边界与 `git diff --check` 通过。
- 根 `validate_change_impact.py --staged` 通过，但当前未暂存文件，工具报告 `changed_files: []`；正式设计 `opencraft/docs/platform-architecture.md` 与 `opencraft/design/invariants.md` 已同步人工核对。

## decisions
- 使用既有 Host capability 和 ThreadRowMenu，不造 Codex 专用按钮。

## scan_scope
- CodexEngineAdapter、DSH adapter、appserver-protocol、workbench-runtime 和相邻测试/烟测。

## scan_output
- 精确命中 Codex capability 注入缺口与 Workbench `fork === true` 门控；DSH 已声明且原生处理 `thread/fork`。

## handoff
- 已增加统一生命周期扩展解析、Codex Host 声明、Workbench 严格门控与 Fork owner 回归，并在用户授权后部署到当前 headless 运行服务。
- 已知边界：Codex 的空白 durable child 虽然可在引擎重启后读取，但直到子分支第一轮完成才进入原生 `thread/list`。成功回执的临时投影保证本次运行可见；浏览器刷新会丢失该投影，直接路由仍可恢复。没有伪造持久历史。

## deployment_checkpoint_2026_09_25
- 用户随后明确授权“替换”当前 headless 运行服务。
- 构建工具 npm 12.1.0 放在临时目录 `/tmp/opencraft-fork-npm.4YpdBaB2`，不写服务数据根。原归档备份 `opencraft/release/OpenCraft-server-0.1.0-linux-amd64-before-fork-8a96e30e.tar.gz`，SHA-256 `8a96e30efd894118b64058d8605f3bdfcd5fbfbc9e8f8f53fe8d88b2e404c074`。
- 新归档 `opencraft/release/OpenCraft-server-0.1.0-linux-amd64.tar.gz`，SHA-256 `3c7a87d365734ac4b66a6bc45a7e02ab6812c495f92e70123980e6d5acbd22dc`，buildId `20260925032609-63040606d22c`；`smoke:headless:linux` 通过。
- 受服务 `ProtectSystem=strict` 限制，使用独立 systemd transient unit 执行部署脚本 `opencraft/release/.deploy-fork-3c7a87d3.sh`。`opencraft-deploy-stage-3c7a87d3.service` 已成功校验归档和 30442 文件，并预置 `/opt/opencraft-server/releases/3c7a87d365734ac4`；此刻 `current` 仍指旧 release `/opt/opencraft-server/releases/8a96e30efd894118`，服务健康。
- 下一步 activation：`systemd-run --unit=opencraft-deploy-activate-3c7a87d3 --property=Type=oneshot /bin/bash /data/mono2/opencraft/release/.deploy-fork-3c7a87d3.sh activate`。脚本校验旧 buildId，原子切换，重启并等待新 buildId/健康；失败自动回滚旧 release。切换本身可能终止本会话 turn。
- activation 实际完成：`opencraft-deploy-activate-3c7a87d3.service` 为 `Result=success, ExecMainStatus=0`；日志报告 `DEPLOYED build=20260925032609-63040606d22c`。`current` 指向 `/opt/opencraft-server/releases/3c7a87d365734ac4`，服务 `ActiveState=active`、MainPID `1980939`、`NRestarts=0`。
- `/__opencraft_health` 返回 `{"ok":true,"appServerConfigured":true}`，`/version.json` 返回新 buildId；真实运行服务的 `/apphost` initialize 声明 lifecycle v1 的 `fork/ephemeral/injectItems/unsubscribe` 全为 true。启动初期健康轮询曾遇短暂空响应，随后脚本正常确认健康，未触发回滚。
- 用户手机页面具体 Fork 点击仍需刷新后实测；本次没有做付费模型推理，也没有提交/推送源码。
