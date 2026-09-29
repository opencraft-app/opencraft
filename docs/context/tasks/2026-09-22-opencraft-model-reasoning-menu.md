## goal
把 OpenCraft Composer 的模型选择做成一个自适应双区菜单：模型是可滚动主列表，所选模型的用户配置和思考强度由独立详情区呈现。

## non_goals
- 不改变默认模型、思考选择或提交语义。
- 不显示营销式模型描述，不根据模型名称推断能力。
- 不声明尚未进入配置与执行校验的工具调用能力。
- 不新增模型搜索、Provider 配置或移动端专用流程。
- 不提交或推送；按用户后续授权打包并更新当前 OpenCraft 预览服务。
- 不覆盖当前工作树中的其他并行改动。

## requirement_ids / requirement_refs / requirement_excerpt
- `user-2026-09-22-model-reasoning-menu`："模型和思考，一个菜单，但是应该分开"；用户随后确认“修改一下”。
- `user-2026-09-22-model-capability-detail`：参考 WorkBuddy 的成熟经验，宽屏使用同一 Popover 的模型列表和详情双栏；展示用户配置的自定义来源、上下文、输出限制和真实支持能力，暂不展示描述。
- `user-2026-09-22-reasoning-scale`：鼠标 hover 不应出现与共享菜单语言冲突的蓝色轮廓；思考强度改为主题化的离散选择器，不再显示纵向 radio 表单。
- `user-2026-09-25-reasoning-parity`：当前轨道式思考强度与 Codex 差距明显；允许参考 BB 收敛交互。
- `user-2026-09-25-codex-reasoning-memory`：Codex 引擎的模型档位缺乏跨新会话记忆。

## interface_refs / data_structure_refs
- `opencraft/packages/codex-composer/src/codex-composer.tsx`：`ComposerModelOption`、`ComposerReasoningEffortOption` 与 `ComposerSelectionCatalog`。
- `opencraft/packages/composer-core/src/reasoning.ts`：模型能力和思考强度解析不变量。
- `opencraft/packages/appserver-protocol/src/methods.ts`：OpenCraft 模型目录扩展字段。
- `opencraft/packages/workbench-runtime/src/composer-model-catalog.ts`：Host 模型目录到 Composer 详情投影。
- `opencraft/apps/local-agent-host/src/dsh-appserver-adapter.ts`：用户模型配置到 `model/list` 的边界。
- `opencraft/docs/chat-ui-architecture.md`：思考控件只由当前模型声明的 effort 集合驱动。

## history_context
- `current_design_refs`：`opencraft/docs/chat-ui-architecture.md`、`opencraft/design/model-configuration.md`。
- `relevant_evolution`：现有 Composer 已把模型和思考放在同一个 Radix DropdownMenu，但两组都使用同一菜单行视觉，并且任一选择都会关闭菜单。
- `superseded_refs`：无。

## acceptance
- 入口以模型为主标签、思考强度为次要状态，并保持一个可访问按钮。
- 宽屏菜单为左侧可滚动模型列表、右侧模型详情；窄屏保持同一状态并上下堆叠。
- 主列表保持单行密度，不展示模型描述。
- 详情展示用户配置的模型名称、自定义来源、上下文窗口、最大输出、输入模态和声明的思考能力。
- 选择模型后菜单保持打开；保留兼容的思考强度，不兼容时采用该模型的正式默认值。
- 选择思考强度后关闭菜单并把焦点还给编辑器。
- 支持 Codex 配置 RPC 的 Host 从 `config/read` 恢复新 Thread 的模型/档位默认值，并在用户选择后通过 `config/batchWrite` 更新；已有 Thread 继续使用自己的执行设置。
- 无思考能力的模型不展示思考区域。
- 思考分段控件只投影当前模型声明的合法档位，直接展示每个档位标签和当前选择；鼠标悬停使用共享菜单的软填充，不出现 focus 轮廓。
- 离散档位仍使用 Radix RadioGroup/RadioItem 语义，键盘聚焦保留主题 focus token，Enter/Space 选择后恢复编辑器焦点。
- Chromium 真实组件 smoke 留存截图并覆盖模型切换、能力刷新、关闭与焦点恢复。

## affected_paths
- `opencraft/packages/codex-composer/src/codex-composer.tsx`
- `opencraft/apps/workbench-web/src/app.tsx`
- `opencraft/apps/workbench-web/src/runtime/appserver-runtime-context.tsx`
- `opencraft/packages/appserver-protocol/src/methods.ts`
- `opencraft/packages/workbench-runtime/src/appserver-runtime.ts`
- `opencraft/packages/workbench-runtime/src/composer-model-catalog.ts`
- `opencraft/apps/local-agent-host/src/dsh-appserver-adapter.ts`
- `opencraft/apps/workbench-web/src/styles/app.scss`
- `opencraft/apps/workbench-web/src/i18n/locales/zh-CN.json`
- `opencraft/scripts/smoke-hermes-reasoning-ui.ts`
- `opencraft/tests/model-capability-consistency.test.ts`
- `opencraft/docs/chat-ui-architecture.md`

## required_context
- 根 Context Router：无匹配 Pack，改用有界精确搜索。
- OpenCraft 局部入口与维护验证清单。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | 根仓硬边界和 Task Pack 规则 | 限定修改、验证和交付边界 |
| `opencraft/AGENTS.md@working-tree` | OpenCraft UI、Radix、主题和真实呈现规则 | 约束实现层和验证层 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@working-tree` | OpenCraft 交互维护方法 | 明确状态所有权和验收证据 |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md@working-tree` | 可见 UI 验证清单 | 选择真实组件 smoke 与截图 |
| `opencraft/docs/chat-ui-architecture.md@working-tree` | Composer/模型/思考能力权威 | 保持空 effort 隐藏和能力驱动 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@working-tree` | 前端与 i18n 邻接检查 | 复用既有翻译 key，不新增旁路文案 |

## evidence
- `npm run typecheck --workspace @opencraft/codex-composer`：通过。
- `npm run typecheck --workspace @opencraft/workbench-web`：通过。
- `npx tsx scripts/smoke-hermes-reasoning-ui.ts`（临时 Playwright Core + 系统 Chrome）：通过；验证模型选择不关闭菜单、无 effort 隐藏区域、重新选择 Hermes 模型恢复默认 `high`、选择 `max` 后关闭并恢复编辑器焦点。
- 真实组件截图：`/tmp/opencraft-hermes-reasoning-ui-hJiNQg/model-reasoning-menu-wide.png`、`model-reasoning-menu-narrow.png`、`model-reasoning-menu-dark.png`。
- `npm run test:chat`：通过。
- `npx tsx --test tests/reasoning-capability.test.ts tests/local-agent-reasoning-settings.test.ts`：7/7 通过。
- `npm run check:i18n`、`npm run check:typography`、`git diff --check`：通过。
- `npm run build:web`：通过；仅保留既有动态导入和大 chunk 警告。
- 双栏能力详情 smoke：`/tmp/opencraft-hermes-reasoning-ui-xQRuuV/`；覆盖浅色宽屏、浅色窄屏、深色窄屏和自定义模型能力详情。断言主列表不显示模型/effort 描述，自定义模型显示用户名称、`Custom`、128K 上下文、16.4K 最大输出、Text/Image，且无 effort 时不显示思考控件。
- 受影响的 5 个 workspace 类型检查通过；`check:boundaries`、`test:chat`、Host/模型配置 50 项聚焦回归、`check:i18n`（81 条源消息）、Web 构建和文档门禁通过。
- 离散轨道真实组件 smoke：`/tmp/opencraft-hermes-reasoning-ui-O7mwd8/`；使用真实 Appearance Theme 初始化，验证浅/深/窄屏、当前 `High` 的 50% 填充、鼠标 hover 无蓝色 outline、键盘 Enter 选择 `Max` 并恢复编辑器焦点。
- 本轮复核：CodexComposer/Workbench Web typecheck、Chat 回归、模型/思考 18 项聚焦测试、typography 检查、Web 与 Electron 生产构建通过；仅保留既有大 chunk/动态导入告警。
- Codex 新 Thread 默认值：为 `config/read`、`config/batchWrite` 增加类型化 RPC；Workbench 从 AppServer 配置恢复 `model` / `model_reasoning_effort`，选择后串行写回。已有 Thread 仍以自己的 execution settings 为准；不支持配置 RPC 的 Host 保持兼容降级。
- `tests/chat-workbench-draft.test.ts`：23/23 通过，包含读取与写回 AppServer-owned 新 Thread 默认值的新用例；`tests/appserver-protocol.test.ts`：5/5 通过。
- `tests/workbench-timeline-host.test.ts`、`tests/reasoning-capability.test.ts`、`tests/workbench-conversation-binding.test.ts`、`tests/chat-appserver-command.test.ts`、`tests/composer-core.test.ts` 聚焦回归均通过；平台边界检查与 `git diff --check` 通过。
- 最新 Workbench Web、Workbench Runtime、AppServer Protocol、Codex Composer 类型检查通过。
- Linux headless 发布包 smoke 通过：buildId `20260925000505-7f9e4d3c0b10`，归档 SHA-256 `63b1e70db2b2c2ca9a8f048003c9a05ae009fd4c3b7dbf55fb3a4dd51048890a`。
- 当前环境缺少 Playwright 与系统 Chromium，因此改成分段按钮后的真实浏览器截图尚未补跑；源码 smoke 断言已同步更新，但不将其记为本轮视觉验证通过。

## risks
- Radix 默认选择即关闭；模型项必须显式阻止默认关闭，思考项保留默认关闭语义。
- 当前工作树包含并行 i18n、Skill 和主题改动；补丁只编辑目标区块，不回退其他差异。
- 目录协议的可选元数据必须保持兼容；非 OpenCraft AppServer 可以完全省略。
- 自定义模型详情必须来自 Host 目录，不能让 Renderer 读取配置文件或猜测 Provider。
- 双栏在窄窗口必须堆叠，不能裁掉模型或思考操作。

## validation
- `npm run typecheck --workspace @opencraft/codex-composer`
- `npm run typecheck --workspace @opencraft/workbench-web`
- `npx tsx scripts/smoke-hermes-reasoning-ui.ts`
- `npm run test:chat`
- `npx tsx --test tests/model-capability-consistency.test.ts tests/reasoning-capability.test.ts`
- `npm run build:web`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`（若有 staged 变更）

## decisions
- 保持一个 Radix DropdownMenu 和一个触发按钮；不拆成两个入口。
- 模型选择是菜单内的中间状态变更，不关闭菜单；思考选择完成本次意图并关闭。
- 思考强度使用 Radix RadioGroup/RadioItem 保留单选语义，详情区参考 BB 以带完整标签的分段按钮投影；颜色、悬停、聚焦和阴影只消费 Design System 主题 token。
- 复用 WorkBuddy 的目录密度和上下文详情思想，不复制三级 hover 菜单或 `isThinking + effort` 双状态模型。
- 用户模型元数据沿 `RuntimeModelView → CatalogModel → WorkbenchComposerModelChoice → ComposerModelOption` 投影；Renderer 不拥有第二份配置。
- 模型无 effort 时遵循正式架构隐藏思考区域，不制造不可用选项。
- Codex 的新 Thread 选择记忆归 AppServer 配置所有：读取有效配置，用户选择后写回；Thread 恢复值不被全局默认覆盖。
- BB 只作为带完整标签的分段交互参考；本仓没有 Codex 客户端 UI 源码，因此不声明视觉上与 Codex 原样一致。

## scan_scope
- `opencraft/packages/codex-composer/src/codex-composer.tsx`
- `opencraft/packages/composer-core/src/reasoning.ts`
- `opencraft/apps/workbench-web/src/styles/app.scss`
- `opencraft/scripts/smoke-hermes-reasoning-ui.ts`
- `opencraft/docs/chat-ui-architecture.md`

## scan_output
- Context Router 无匹配；有界精确搜索定位到现有 Radix 菜单、共享 menu mixin、reasoning resolver 与 Hermes UI smoke。

## handoff
- 已完成共享模型元数据投影、双栏/堆叠菜单、带完整档位标签的分段思考控件、统一菜单 hover/键盘焦点状态，以及 Codex 新 Thread 模型/思考档位的 AppServer 配置记忆。
- 用户写入的名称、contextWindow、maxTokens、input 和 custom source 已展示；工具调用支持尚无端到端模型能力 contract，本轮未显示。
- 已生成并 smoke 验证 Linux headless 包；按用户授权更新当前预览服务。未提交或推送。
