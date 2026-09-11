## goal
将 OpenCraft 模态窗口按 Codex 的所有权分层整改：业务只提供内容和语义描述，平台统一拥有窗口栈、Host、Portal、遮罩、焦点与关闭行为，并为 Web/Radix 和 Expo/Native 提供同构适配器。

## non_goals
- 不改变 Hermes 设置页面的数据请求和业务内容。
- 不发布 Web、Expo 或生产环境。
- 不直接修改 `plugins/lightvela-hermes/src/upstream/mono2/` 机械生成代码。

## requirement_ids / requirement_refs / requirement_excerpt
- `conversation:2026-09-10-modal-ownership`：严格遵循 Codex 的 ModalController → ModalHost → ModalSurface → 平台行为原语分层；删除 Web 手写焦点循环和 Escape；业务提供内容、平台提供容器；Expo 共享语义而不是复用 DOM。

## interface_refs / data_structure_refs
- `opencraft/packages/design-system/src/modal.shared.ts`：跨端 Modal 描述、尺寸、层级和关闭原因。
- `opencraft/apps/workbench-web/src/components/modal/`：Web Controller/Host/Radix Surface 与业务内容槽。
- `opencraft/apps/workbench-expo/src/components/ui/modal-surface.tsx`：Native Modal Surface。
- 不变量：业务内容不得拥有 Portal、scrim、焦点陷阱或 Escape 监听。

## history_context
- `current_design_refs`：`opencraft/docs/platform-architecture.md`、Codex 解包源码 `restored/ui/dialog-layout/*` 与 `restored/ui/modal-*.tsx`。
- `relevant_evolution`：现有 Web `ModalSurface` 手写 `inert`、焦点循环、Escape 和 `createPortal`，与业务内 Radix 浮层形成两套所有权。
- `superseded_refs`：现有 `modal-surface.tsx` 手写行为仅作迁移输入。

## acceptance
- Web `ModalSurface` 直接组合 Radix Dialog，不再出现手写 `inert`、Tab 循环、Escape 或 `createPortal`。
- Web 所有应用 Modal 通过唯一 `ModalHost` 投影，Modal 栈顺序由平台 Controller 解析。
- Expo 至少一个真实 Modal 使用同一共享语义契约和 Native adapter。
- 聚焦测试、Web/Expo 类型检查、边界检查与相关构建通过。

## affected_paths
- `opencraft/packages/design-system/`
- `opencraft/apps/workbench-web/`
- `opencraft/apps/workbench-expo/`
- `opencraft/tests/`
- `opencraft/docs/platform-architecture.md`

## required_context
- `agent-gateway-runtime`
- `site-environment-routing`
- `upstream-subtrees`
- `service-opencraft`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@worktree` | mono2 P0 与 Task Pack 规则 | 限定提交、发布和验证边界 |
| `opencraft/AGENTS.md@worktree` | OpenCraft 服务约束 | 保持生成代码与跨端边界 |
| `docs/context/domains/agent-gateway-runtime.md@2.1.0` | OpenCraft runtime 归属 | 避免把 UI 容器混入业务 runtime |
| `docs/context/domains/site-environment-routing.md@2.0.0` | 多交付面约束 | 不把本地构建等同于发布 |
| `docs/context/project/upstream-subtrees.md@2.1.0` | mono2 唯一真源 | 不回写历史独立仓库 |
| `docs/context/project/services/opencraft.md@1.0.0` | 服务级验证要求 | 确定 gate 与构建范围 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 前端相邻测试检查 | 选择 Workbench 聚焦测试 |
| `opencraft/docs/platform-architecture.md@worktree` | 跨端复用边界 | 共享语义、隔离 renderer 实现 |
| `opencraft/docs/build-matrix.md@worktree` | Web/Expo 交付矩阵 | 选择双端构建验证 |
| `opencraft/MONO2_MIGRATION.md@worktree` | 生成闭包与唯一真源 | 禁止直接编辑生成上游代码 |

## evidence
- `packages/design-system/modal` 提供 renderer-neutral descriptor、尺寸、层级和 dismissal 语义。
- Web `ModalHost` 统一投影设置和账户窗口；Radix Dialog 独占 Portal、Overlay、焦点、Escape 与 outside interaction。
- 目录选择器、工具原始输出和图片预览已删除自建 Portal/Escape，复用平台 `ModalSurface`。
- Expo 模型选择器已删除业务自建 `Modal`、scrim 和关闭控件，改用 Unistyles 驱动的 Native `ModalSurface`。
- `npm run gate` 通过（边界、全 workspace typecheck、扩展/AppServer/Chat/Workbench tests、Web/Expo Web/Expo iOS builds）。

## risks
- Radix Portal 与业务内 Select/Popover 的 DOM 顺序和层级冲突；由语义 layer token 和 Host 栈顺序覆盖。
- Expo `Modal` 与 Web Dialog 行为并不相同；仅共享描述契约，由 Native adapter 使用系统关闭事件。
- 工作树已有用户改动；只修改本任务文件和明确相邻行，不覆盖现有差异。

## validation
- `npm run check:boundaries`
- `npm run typecheck --workspace @opencraft/design-system --workspace @opencraft/workbench-web --workspace @opencraft/workbench-expo`
- `npx tsx --test tests/workbench-timeline-host.test.ts tests/adaptive-navigation.test.ts`
- `npm run build:web`
- `npm run build:expo:web`
- `npm run build:expo:ios`

## decisions
- 业务内容仅提交 `ReactNode` 和跨端 Modal descriptor；Platform Host 决定具体容器。
- Web 使用 Radix Dialog；Expo 使用 React Native `Modal`/未来 Stack adapter；不让 Radix 进入共享包。
- Web route state 继续是业务导航真源，平台 ModalController 只将当前请求解析为有序窗口栈，不复制路由状态。

## scan_scope
- `opencraft/apps/workbench-web/src/components/modal/`
- `opencraft/apps/workbench-expo/src/components/`
- `opencraft/packages/design-system/src/`
- `opencraft/tests/workbench-timeline-host.test.ts`

## scan_output
- 有界源码检查记录在本任务命令输出中，无额外生成物。

## handoff
- 实现完成，未提交、未推送、未发布。
