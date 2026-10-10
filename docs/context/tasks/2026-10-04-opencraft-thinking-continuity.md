## goal
统一原生对话中 Thinking 两条显示路径的基线，消除等待占位交接给活动列表时的下移动效。

## non_goals
- 不改变 Thinking 的协议状态、唯一 owner 判定或桌面渲染，不提交或发布。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户反馈：“thinking和 thinking还分两种，第二次出现会下移2px 3px”。

## interface_refs / data_structure_refs
- `TimelineTurnPresentationPlan.thinkingOwner` 仍由 Chat Core 仲裁，Native 只统一呈现。
- `NativeThinkingLabel` 供等待占位和实时 Activity 组复用；`NativeActivityExpansion` 区分状态交接与展开意图。

## history_context
- current_design_refs: `opencraft/docs/chat-ui-architecture.md`。
- relevant_evolution: 2026-10-03 的虚拟列表整改保持唯一 viewport owner，本次不改其坐标。
- superseded_refs: 两条 Native Thinking 路径分别使用不同字重和文字组件的旧实现。

## acceptance
- 等待首个 Item → Activity 组接管 → 工具完成后继续 Thinking，不出现由容器进入动画或字重切换引起的竖直位移；仍只显示一个 Thinking。
- 可折叠历史的主动展开保留动画；系统减少动态效果继续生效。
- Expo 类型检查、相关 Chat Core/Activity 测试及 iOS bundle；真机基线需用户预览核对。

## affected_paths
- `opencraft/apps/workbench-expo/src/components/workbench-conversation.tsx`
- `opencraft/docs/chat-ui-architecture.md`

## required_context
- Router 因 header 匹配 frontend-product-surface；实际执行路径在 Expo，无 frontend 业务修改。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md`, `opencraft/AGENTS.md`, `opencraft/apps/workbench-expo/AGENTS.md` | 本地约束 | 单一滚动 owner、Native token 和验证边界 |
| `docs/context/project/services/frontend.md`, `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | Router 与邻接要求 | 核对触发范围；邻居 `frontend/vitest.config.ts`，不扩大为主站改动 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md`, `references/verification.md` | 维护方法 | 源码、产物与真机证据分开 |
| `opencraft/docs/chat-ui-architecture.md` | 正式设计 | 实时状态 owner 与稳定几何 |
| `opencraft/tests/chat-core.test.ts`, `codex-activity-model.test.ts` | 相邻行为契约 | 保留唯一 Thinking owner 和 disclosure 分区 |

## evidence
- 原等待占位使用扫光 `NativeCadencedText` 和 body 字重；Activity 使用静态 Text 并覆盖字重为 500。
- `NativeActivityExpansion` 每次挂载从 translateY -8 动到 0，实时 Activity 接管也会播放进入位移。代码证据不能量化用户看到的 2–3px。
- 本次两处统一 `NativeThinkingLabel` 和 Thinking 行样式；仅 `layout.showToggle` 的可折叠展开允许进入动画。

## risks
- 未连接 iPhone，无法断言真实字体像素基线已通过；源码和 bundle 不替代设备观察。

## validation
- `chat-core.test.ts`、`workbench-agent-activity-disclosure.test.ts`：94/94 通过，进程 exit 0。
- `npm run typecheck -w @opencraft/workbench-expo`：通过。
- `npm run bundle:ios -w @opencraft/workbench-expo`：通过，4908 modules；未下载外部 bundle。
- `codex-activity-model.test.ts` 未通过：外部 Codex 参考 fixture `/data/mia/.runtime/lifecycle-authority-dead-contract-r3562/lazy/app-initial/subagent-activity-chip-group-CC185tmV.js` 缺失（ENOENT），不是本次渲染断言失败。
- 当前两个改动路径的 docs-impact 校验通过；`git diff --check` 通过。
- 真机 Thinking 交接基线尚未实测。
- 新预览的外部 iOS manifest 和 bundle origin 轻量核对通过，没有下载 bundle；Linux DevTools 缺少 libgbm，不影响已运行的 Metro。

## decisions
- 统一原生文字 primitive 和实时状态交接动效，不增加负 margin 或滚动补偿。

## scan_scope
- Expo workbench-conversation、Chat Core Activity、Web 对应 renderer 与 design-system Native typography。

## scan_output
- 有界 rg 和源码读取；无外部扫描产物。

## handoff
- 实现及本地验证完成；无提交、推送或发布。
- Expo CLI 账号 `beordle`；重启已停止的 Metro 与 Quick Tunnel，预览 `exps://lake-connections-caught-peas.trycloudflare.com`。
