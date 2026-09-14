---
id: composer-permission-menu-2026-09-14
type: task
scope: OpenCraft Composer permission menu simplification.
status: retired
owner: skipzhang
---

## goal
移除权限菜单提问标题和 AppServer default，保留实际权限选择与内部继承。

## non_goals
- 不修改权限策略、默认配置、宿主协议或用户数据；不提交、发布。

## requirement_refs
- 当前对话截图及用户“搞吧”。

## interface_refs / data_structure_refs
- codex-composer.tsx 的 draft.selections.permissionProfile、effectiveSelections 和 catalog.permissionProfiles。
- null/缺省继续继承；显示不得写回；仅明确菜单选择修改草稿。

## history_context
- current_design_refs: opencraft/docs/chat-ui-architecture.md；docs/engineering/domains/agent-gateway-runtime.md。
- relevant_evolution: DSH 已接通 effective permission；本次仅简化呈现。
- superseded_refs: 无。

## acceptance
- 菜单无默认行/标题，实际档位可选，刷新后勾选与宿主一致。
- 聚焦测试、类型检查、共享前端 gate、真实组件本地 DSH smoke。

## affected_paths
- opencraft/packages/codex-composer/src/codex-composer.tsx
- opencraft/scripts/smoke-reasoning-contract.ts
- 上述设计文档。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md、opencraft/AGENTS.md | 入口 | 路由/门禁 |
| opencraft/.agents/skills/opencraft-maintenance/SKILL.md、references/verification.md | 维护 | 局部所有权与验收 |
| opencraft/docs/chat-ui-architecture.md | Composer | 继承不写回 |
| docs/engineering/domains/agent-gateway-runtime.md | 影响映射 | 正式不变量 |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md | 邻接检查 | frontend/vitest.config.ts 不属于本独立 workspace；采用 Composer 测试邻居 |
| .agents/skills/baseline-ui/SKILL.md、fixing-accessibility/SKILL.md、graphify/SKILL.md、graphify/references/query.md | 控件与定位 | 保留 Radix；图无 permission/composer 节点，回到精确源码 |
| /Users/skipzhang/.agents/skills/vercel-react-best-practices/SKILL.md | React | 直接派生，不新增 effect |

## scan_scope / scan_output
路由 opencraft composer permissions menu 无匹配；精确搜索 codex-composer 中菜单文案命中。图无相关节点。内存查询无相关权限菜单记录。

## risks
旧 null 草稿需显示 effective profile；未知状态不可猜默认档位。现有用户改动全部保留。

## validation / evidence
- 聚焦 chat-permission-menu 两项测试通过。
- UI smoke 通过：真实 Workbench → DSH → 本地模型；无默认菜单行、精确档位数、切换实际生效、刷新保留勾选。未调用外部模型。
- 首轮 gate 的旧标题断言已更新；首轮 UI 的 accessible-name 定位改为现有权限菜单 role/class（Radix 通过 trigger labelledby 命名）。
- Electron renderer/host 构建、独立打包与 codesign --verify --deep --strict 通过。
- 独立预览 permission-menu-preview 实测三个档位，无默认/标题；Escape 退场后关闭。未覆盖旧包或终止用户窗口。
- 完整 gate 重跑通过（exit 0，含跨 workspace 类型、测试、Web/Expo/iOS 构建）；文档校验 errors=[]，diff --check 通过。staged impact 检查无暂存变更，不作为实际语义证据。

## decisions
保留 Radix 菜单和原命令；null 只改变呈现回退，不改变提交。

## handoff / checkpoint
stage: complete
verified: 源码、聚焦测试、真实浏览器权限恢复及打包窗口均通过。
unverified: 无本次所需的剩余验收；未做生产发布。
restore: /tmp/opencraft-permission-menu-gate.log、/tmp/opencraft-permission-menu-ui.log；新包 release/permission-menu-preview。
next_action: 用户在新预览验收；未提交或推送。
