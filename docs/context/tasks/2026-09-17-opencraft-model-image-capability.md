## goal
让用户在 OpenCraft Model Services 中显式声明自定义模型是否支持图片输入，并让 Composer 与 Host 一致消费该能力。

## non_goals
- 不按模型名称推断图片能力。
- 不复制 ref/wb 的工具调用、推理、协议与完整自定义模型表单。
- 不发起可能计费的图片推理，不修改生产、GitOps 或外部服务。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户请求：参考 `ref/wb` 的建模，合理简化并修复自定义模型图片能力缺失。

## interface_refs / data_structure_refs
- `RuntimeDiscoveredModelView.input` 与 `ConfiguredModel.input`：`["text"]` 或 `["text", "image"]`。
- `RuntimeProviderService.models()`：原生明确能力优先；原生未知时回退到显式模型声明；仍未知时保守 text-only。
- Composer 与 DSH Host admission 必须消费同一最终模型目录。

## history_context
- `current_design_refs`：`opencraft/design/model-configuration.md`。
- `relevant_evolution`：现有 schema、DSH 投影、Composer compiler 和 Host admission 已支持图片能力；Model Services 缺少编辑入口，且 Host 在原生返回 `null` 时绕过了显式声明。
- `superseded_refs`：按模型 ID/名称硬编码 vision 能力。

## acceptance
- 自定义模型的操作菜单显示“图片输入”开关及清晰说明。
- 开关保存既有 `input` 字段，不另建能力存储。
- 原生能力明确时优先；原生返回未知时使用用户声明。
- Composer catalog 与 Host admission 结果一致。
- 聚焦测试、类型检查、边界检查、Electron 构建与真实预览通过。

## affected_paths
- `opencraft/plugins/builtin-agents/src/model-services/`
- `opencraft/apps/local-agent-host/src/runtime-provider-service.ts`
- `opencraft/apps/local-agent-host/src/dsh-appserver-adapter.ts`
- `opencraft/tests/`
- `opencraft/design/model-configuration.md`

## required_context
- Context Router 误命中 `release-gitops`（由“image”词触发）；已读其 must-read，但本任务不涉及发布。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/AGENTS.md@working-tree` | OpenCraft UI/contract/预览边界 | 约束共享控件与真实预览 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@working-tree` | OpenCraft 维护方法 | 定义能力诚实和验证层次 |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md@working-tree` | 验证清单 | 选择模型聚焦测试与 Electron 验收 |
| `.agents/skills/baseline-ui/SKILL.md@working-tree` | UI 基线 | 复用现有 Radix/Settings primitive |
| `ref/wb/packages/agent-ui/src/components/setting/model-config/defaults.ts@working-tree` | WB 能力模型参考 | 确认 `supportsImages` 是显式模型字段并有目录默认 |
| `ref/wb/frozen-assets/zh-cn-CbBMr6iU.js@working-tree` | WB 用户文案参考 | 采用“图片输入/允许发送图片附件”语义 |
| `opencraft/design/model-configuration.md@working-tree` | OpenCraft 正式设计 | 保持受控能力来源与保守回退 |

## evidence
- `ref/wb` 对照：模型级 `supportsImages: boolean`；已知目录提供默认，自定义模型表单允许显式修改，发送前消费同一字段。
- `npx tsx --test tests/model-services.test.ts tests/model-capability-consistency.test.ts tests/runtime-provider-service.test.ts`：42/42 通过。
- Workbench Web 与 Local Agent Host workspace typecheck：通过。
- `npm run check:boundaries`：通过。
- `npm run build:electron` 与最终 `npm run build:renderer:electron`：通过。
- documentation validation、change-impact validation、目标文件 `git diff --check`：通过。
- 真实 Electron 44 隔离预览（CDP 9476）：Model Services 的 `lv / GLM-5.3-Flash` 操作菜单显示“图片输入 / 允许在聊天时向该模型发送图片附件”，`aria-checked=true`、可操作。
- `~/.opencraft/models.json` 只读复核：该模型启用且持久化 `input: ["text", "image"]`；未读取/输出凭据，未额外发起推理。
- 闪现回归：模型能力 mutation 改为独立 pending key，不再借用 provider draft 或 page-wide busy；held-promise 测试验证请求期间 `dirty=false`、连接区保持折叠、`busy=false`。
- 最终 Electron 44 隔离预览（CDP 9477）实际关闭/恢复图片能力，共采样 387 帧：连接编辑区从未可见，页面 scrollTop 始终 0，连接区高度始终 95px，局部 pending 可见；最终配置恢复为 `input: ["text", "image"]`，页面停留在开启状态菜单。

## risks
- 若上游明确报告 text-only，用户声明不得覆盖真实能力。
- provider 全量模型写入必须保留其他模型字段、默认模型与 revision/CAS。

## validation
- `npx tsx --test tests/model-services.test.ts tests/model-capability-consistency.test.ts tests/runtime-provider-service.test.ts`
- `npm run typecheck --workspace @opencraft/workbench-web`
- `npm run typecheck --workspace @opencraft/local-agent-host`
- `npm run check:boundaries`
- `npm run build:electron`
- 隔离 Electron profile 中验证开关、持久化和模型目录刷新。

## decisions
- 复用现有 Model Services 模型操作 Popover 与 `SettingsSwitch`；只增加“图片输入”一个用户可理解的能力。
- 不新增 model mutation RPC；通过已有 provider CAS apply 原子保存完整模型声明。

## scan_scope
- `ref/wb` 模型配置相关文件；OpenCraft Model Services、模型目录、Host admission 与测试。

## scan_output
- 有界源码对照，无额外扫描产物。

## handoff
- 实现与验证完成；最终隔离预览停留在目标模型能力菜单。未提交、推送、打包或发布。
