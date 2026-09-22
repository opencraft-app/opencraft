# OpenCraft Codex 国际化实现

## goal
在 OpenCraft 落地 Codex 的语言解析、共享 Intl 实例、异步字典与 ICU 格式化方案。

## non_goals
- 不执行生产发布、提交或替换已安装应用。
- 不复制私有灰度服务；不将 Codex 自身的多语种产品文案冒充 OpenCraft 的完整翻译。

## requirement_refs / requirement_excerpt
- 用户：“完整、100%复刻codex方案…请你实现。无需考虑其他方案”。

## interface_refs / data_structure_refs
- `ref/codex/lazy/app-initial/set-language-alias.js`：来源策略、取消与应用级 Intl 投影。
- `ref/codex/lazy/app-initial/to-kebab-case-sq-5mqra.js`：语言目录与区域匹配。
- `opencraft/packages/ui-preferences/src/index.ts`：安装级偏好权威。
- `opencraft/packages/i18n/src/index.ts`：应用级 Intl 内核与只读消费端口。

## history_context
- current_design_refs：`opencraft/docs/platform-architecture.md`。
- relevant_evolution：Embedded 已有独立 Application 生命周期和 Shadow DOM，偏好已分 Web/桌面 adapter。
- superseded_refs：无。

## acceptance
- 实现 override/IDE/system/FIRST_AVAILABLE、规范语言标签、区域匹配、方向和英文回退。
- React 与命令式消费者使用同一 Intl 对象；独立根不污染宿主语言。
- 异步字典迟到、失败重试与释放安全；切换不重建会话或编辑器。
- 显式语言持久化并在重启后恢复，核心设置与聊天控件正确显示翻译。
- 完成类型、聚焦测试、边界、构建和真实界面验证。

## affected_paths
- `opencraft/packages/i18n`、`opencraft/packages/ui-preferences`、Web/Electron 语言 adapter 与相关消费者。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md` | 路由必读 | 产品界面边界 |
| `opencraft/AGENTS.md` | 局部规则 | 偏好权威及保留工作区修改 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | 维护方法 | 所有权与生命周期 |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md` | 验证要求 | 实机证据 |
| `opencraft/docs/platform-architecture.md` | 当前设计 | 应用及嵌入生命周期 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | 相邻卡 | 注册表与测试检查 |
| `frontend/src/i18n/__tests__/locales.config.test.ts` | 测试邻居 | 语言目录一致性 |
| `docs/context/tasks/TASK-TEMPLATE.md` | 任务格式 | 状态记录 |

## decisions
- 使用 React Intl/FormatJS；本地显式选项承接 Codex 的私有灰度输入。
- 空 locale.override 表示继承平台语言，不把解析结果反写为显式用户选择。
- 保留已有主题、发布和其他任务修改。共享控件的独立测试入口同步补 Intl Provider。

## validation
- `check:i18n`：64 个来源 ID，ICU 与中文参数一致性通过。
- `test:i18n`：10 项内核、控制器、原生投影用例通过。
- Intl 内核、Web、Composer、Electron 类型检查与包边界通过；补齐 NodeNext 所需 .js 相对导入。
- `test:workbench:unit`：271 项通过；最终账户/标题栏/Timeline 聚焦回归 79 项通过。
- 初次 gate 在旧源码正则要求字面量 aria-label 处停止，已改为检查国际化 descriptor；此前 gate 套件和之后余下套件已分别完成。
- Web、embedded release、Expo Web 与 iOS bundle 构建通过。
- Chromium 真实组件：语言选择、刷新持久化、同一编辑器节点、草稿、焦点、撤销、独立根和 RTL 通过。
- 隔离 Electron：生产 preload、真实原生 Menu、真实 Composer 同一矩阵通过。
- 完整构建产物：匿名设置页切语言与刷新恢复通过；不连接 Agent 或付费推理。
- 拆开 LanguageSetting 与启动模块依赖后重建 Web/embedded，再次通过完整 Web 产物验证。
- 原有 Hermes 模型/思考菜单与真实听写所有权 smoke 通过；组件测试入口显式安装 Intl 边界。
- 文档验证无错误；影响检查同时执行 staged（空集）及本轮显式文件集合，均通过。
- Context audit 测试 33 项通过；仓库 context 全套 26 项中 4 项失败（治理资产、中文优先、服务预算、仓库校验）。本任务文件已改中文；报告还包含其他既有任务及参考目录问题，未扩大修改。审计发现脚本完成，状态 needs_agent_review，不冒充完成全仓评审。

## stage
实现与验证完成，保留全仓 context 门禁未全绿的记录。

## verified
- Codex 核心国际化机制及真实编辑器连续性，证据见上方命令。
- Embedded manifest 将 zh-CN 标记为独立动态入口，未同步并入主入口。

## unverified
- 不宣称整个产品所有文案已翻译：本轮已迁移 64 条核心文案，中英字典之外的资源尚未翻译。
- 原生验证为隔离测试宿主；没有替换或验证 /Applications 安装包。
- 全仓 context 门禁尚未通过；具体失败类别见 validation。

## restore
- 不覆盖其他任务的 dirty 文件；没有提交、发布和替换安装包。
- 完整内核与词条迁移覆盖率是不同验收维度，后续词条沿用同一机制。

## next_action
- 本轮无待执行部署动作。后续页面文案按同一 descriptor/字典机制继续迁移。

## handoff
- 国际化机制已接通并完成上述验证；未提交、未发布，未替换已安装应用。
