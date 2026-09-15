# Codex 工作区复刻

## goal
按 Codex 任务工作区的身份/状态/呈现/资源所有权实施 OpenCraft，并在 `opencraft/design/` 维护设计、不变量与测试对应关系。

## non_goals
- 不改账户、计费、模型后端或生产；不提交/push。
- 不把整份恢复源码接入构建，不覆盖现有多 Host 或 Cordis 内核。

## requirement_refs / requirement_excerpt
- 本次用户请求：“开始整体复刻实现吧（严格遵循）…维护设计文档和不变量: opencraft/design/”。

## interface_refs / data_structure_refs
- `opencraft/packages/workbench-panels/src/{model,service}.ts`
- `opencraft/packages/composer-core/src/`
- `ref/codex/lazy/app-initial/local-conversation-page-DSaHQbBd.js`
- `ref/codex/lazy/app-initial/use-toggle-diff-panel-subscription.js`

## history_context
- current_design_refs: OpenCraft platform/chat/browser/plugin architecture；新增设计入口为 `opencraft/design/README.md`。
- relevant_evolution: 本轮之前已完成 Codex 静态建模分析；四条怀疑不是已证实缺陷，不据此擅改参考策略。

## acceptance
- 主会话与工具入口同一草稿/提交目标；移动不关闭资源，显式关闭按策略；旧结果不能写入新实例。
- 单元测试、Web 交互、完整 gate、独立 Mac 预览；准确区分平台未实现能力。

## affected_paths
- opencraft/design/、workbench-panels、workbench-runtime、workbench-web 及对应测试/设计。

## context_receipt
| 文件 | 原因 | 用途 |
|---|---|---|
| `AGENTS.md`、`opencraft/AGENTS.md` | 工作边界 | 路由/门禁/保留改动 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md`、`references/verification.md` | 维护方法 | 所有权及真实 UI 验收 |
| `opencraft/docs/platform-architecture.md` | 应用所有权 | 复用现有内核 |
| `opencraft/docs/chat-ui-architecture.md` | 草稿/协议 | 不建第二份会话事实 |
| `opencraft/docs/browser-workbench-architecture.md` 相关章节 | 资源/呈现 | 移交与关闭 |
| `opencraft/docs/plugin-architecture.md` 入口/账本 | Cordis 边界 | 不扩展公共 API 权限 |

## evidence
- 路由无匹配，限定相关目录精确搜索；当前工作树不干净。

## decisions
- 实施计划/发现/进度放 `opencraft/design/`；专题规范另设明确入口，不把计划当规范。

## handoff
本轮核心实现及预览交付；完整状态见 `opencraft/design/progress.md`。完整 gate 通过，最终增量类型/聚焦回归 40/40 通过，Web 普通/减少动效与真实 iframe 通过，标准 Codex AppServer 临时父子会话通过（本地合成模型，外部调用 0），Mac ad-hoc 产物签名和原生终端迁移/held-drag 通过。

## checkpoint
- stage: 本轮核心交付；全量参考等价尚有待办。
- verified: 主输入投影、草稿 target、面板 transfer/close、iframe/PTY 保活、fork baseline adoption、晚到结果失效；设计/不变量与正式领域文档已同步。
- unverified: Codex 实验性 browser peek、完整侧聊窗口交互/编辑器选择撤销跨呈现；DSH 不支持临时 fork；Expo 桌面布局未移植。
- discard: 不使用 ephemeral fork 后 rollout Resume，也不添加 deferGoalContinuation；不重新 freeze submitting 草稿。
- restore: 当前源代码及 design/ 下规范/账本；用户既有改动保留，未提交/push。
- next_action: 根据剩余兼容边界继续精细呈现和侧聊 UI 验收，不以新管理器数量衡量忠实程度。
