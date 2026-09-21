## goal
在 LightVela 国内站与国际站的现有自动任务产品中，增加基于 Hermes `no_agent` 的 0 Token 固定通知与脚本任务，同时复用既有定时和通知配置，并保持已有 Agent 任务行为不变。

## non_goals
- 不修改 Hermes Agent 本体、调度器或通知渠道协议。
- 不把用户脚本描述为运行在独立安全沙箱中。
- 不支持 Agent 任务、固定通知、脚本任务之间直接转换。
- 不提交、推送、创建 MR、发布或操作生产环境。

## requirement_ids / requirement_refs / requirement_excerpt
- `ZT-AUTO-2026-09-06`：`wiki/prd-docs/2026-09-06-zero-token-automation-tasks.md`。
- 范围：现有创建入口直接提供智能任务、通知任务与 Bash/Python 脚本任务三种选择；后两者映射为 0 Token 执行。
- 共享约束：三种任务复用同一套定时、时区、生效窗口和通知渠道配置。
- 运行约束：0 Token 任务映射 Hermes `no_agent`；无模型降级；关闭创建开关后仍可管理已有任务。

## interface_refs / data_structure_refs
- `frontend/src/lib/hermes-cron-client.ts`：`CronJob`、`CronInferenceConfig`、`CreateCronJobInput`、Hermes CLI 命令构造、脚本文件生命周期、测试任务生命周期。
- `frontend/src/pages/marketing/agent-automations-panel.tsx`：创建/编辑表单、任务卡片、详情、最近运行、双站通知渠道。
- `frontend/src/contexts/runtime-config-context.tsx`：创建入口默认开启；显式构建期或本地紧急关闭时不得隐藏已有任务管理能力。
- Hermes contract：`no_agent=true` 时必须有脚本，不创建 Agent 会话，不使用 prompt/skills/model；stdout 非空才投递，空 stdout 静默，失败与超时告警。

## history_context
- `current_design_refs`：`wiki/prd-docs/2026-09-06-zero-token-automation-tasks.md`、`docs/engineering/domains/site-environment-routing.md`、`docs/engineering/domains/agent-gateway-runtime.md`。
- `relevant_evolution`：现有 LightVela 自动任务通过 Hermes CLI 管理 Cron，生效窗口由 LightVela 管理的前置 Python 脚本表达；Hermes 当前已暴露 `no_agent` 与 script-only 调度能力。
- `superseded_refs`：无。

## acceptance
- 国内站与国际站可创建、测试、编辑同类型、启停和删除固定通知与 Bash/Python 脚本任务。
- 固定通知安全支持引号、换行、Emoji 和中英文，不经模型改写，不形成代码注入。
- 0 Token 创建命令包含 `--no-agent`，不携带 prompt、Skill 或模型配置；测试任务同样不创建 Agent 会话。
- 定时、生效窗口和通知渠道继续使用既有组件、默认值与校验，切换任务类型不丢失共享字段。
- 单次执行时间使用站内受控日期时间弹层；日期与时间先保存在临时草稿中，右下角“确认”后才写回，点“取消”、Esc 或弹层外部不改变表单原值。
- 已有外部 `no_agent` 任务识别为脚本任务；无法确认 LightVela 所有权的脚本只读，不要求确认不可见脚本的运行风险，但任务仍可编辑允许的元数据、启停和删除。
- 功能开关只控制新的 0 Token 创建入口；已有任务管理入口始终保留。
- 国内站、国际站和 EdgeOne 预览默认展示三种创建类型；远端 runtime config 缺少字段、字段异常或请求失败时保持默认开启，显式布尔 `false`、构建期关闭或本地紧急关闭仍优先。
- 新增中英文及开放 locale 文案通过生成资源检查；新增行为有聚焦单元/组件测试和双站可视验证。
- 当前任务卡片不展示类型标签；任务详情仅展示“智能任务 / 通知任务 / 脚本任务”，不附加“0 Token”或单独展示“模型调用”字段；“当前任务”视图右上角提供默认“全部”的类型下拉，可过滤智能任务、固定通知和脚本任务。
- 创建弹窗直接展示智能任务、通知任务和脚本任务，不展示“0 Token 任务”的中间选择层级。
- 创建弹窗的三张任务类型卡片使用无边框能力标签：智能任务的“AI 驱动”使用深靛蓝底白字，通知任务和脚本任务的“0 Token”使用浅蓝底蓝字，以清晰区分两类能力。
- 智能任务卡片说明为“由 AI 理解你的需求并自动完成任务”，优先表达能力价值，不在任务类型选择阶段强调 Token 消耗。
- 当前选中的任务类型卡片使用浅蓝底和蓝色描边，未选中卡片保持白底，避免与禁用态混淆。
- 三张类型卡片的解释文案使用完整语句并按卡片宽度自然换行；卡片高度随各自内容自适应，一行文案更紧凑，两行文案仅增高自身；通知任务和脚本任务不重复展示“不消耗模型 Token”。
- 新建与编辑共用弹窗的桌面端最大宽度为 800px，移动端继续由视口留白约束。
- 智能任务的“任务说明”文本框支持沿纵向拖拽调整高度，与“编辑人设文件”的编辑框交互保持一致；横向尺寸固定，避免破坏弹窗布局。
- 智能任务的“任务说明”占位提示使用“整理每日 AI 资讯并总结关键进展”的信息型示例，不再使用更适合通知任务的“提醒我喝水”。
- “未选择通知方式”的后台执行说明收进“通知方式”标题后的小问号提示，鼠标悬停或键盘聚焦时展示；0 Token 任务提示文案为“如未勾选通知方式，任务只会在后台执行并写入日志，不发通知。”；提示浮层挂载到页面顶层，避免被弹窗滚动容器裁切。
- 脚本任务卡片说明为“运行预设脚本，适合开发者”。
- 脚本内容输入框按 Python/Bash 分别展示可运行占位示例；首行使用本地化的“示例脚本：”标识，后续约三行覆盖状态读取、阈值设置和条件输出，不自动写入用户脚本。
- 脚本任务安全确认文案为“我已了解风险：脚本会直接在云端 Agent 环境中运行，并非独立安全沙箱；请仅运行你信任的脚本。”，国际站及其他必填语言使用语义一致的本地化表达。
- 脚本任务的字符计数器与 Python/Bash 切换控件同排、分居左右；通知任务的字符计数器仍位于“通知内容”标题行右侧。
- 通知任务的“通知内容”占位提示为“例如：该喝水啦，休息一下再继续吧”，不附加 Emoji。
- 通知任务的“通知内容”最多输入 1000 字；计数器、文本框 `maxLength` 与输入截断使用同一限制。
- 编辑 0 Token 任务时，弹窗顶部任务模式说明使用中性灰视觉，不使用容易被理解为成功状态的绿色。
- 选择“按间隔”执行时，微信通知要求换算后的时间间隔不少于 150 分钟；低于阈值时自动取消并禁用微信通知选项，其他通知渠道不受影响。
- 编辑受管理的 0 Token 任务时，只有正文、脚本语言、生效时间段、星期或每日多时间点发生变化才重写脚本；仅修改名称或通知方式不写脚本文件。
- 本需求新增组件测试使用双站对应的可访问名称和文案断言，不给 global 侧新增失败。

## affected_paths
- `frontend/src/lib/hermes-cron-client.ts`
- `frontend/src/lib/__tests__/hermes-cron-client.test.ts`
- `frontend/src/pages/marketing/agent-automations-panel.tsx`
- `frontend/src/components/ui/popover.tsx`
- `frontend/src/pages/marketing/__tests__/agent-automations-panel*.test.tsx`
- `frontend/src/contexts/runtime-config-context.tsx`
- `frontend/src/contexts/__tests__/runtime-config-context.test.ts`
- `frontend/src/locales/**`
- `docs/engineering/domains/site-environment-routing.md`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- `service-frontend`
- `service-ctl`
- `site-environment-routing`
- `agent-gateway-runtime`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | 仓库级边界与 Task Pack/验证规则 | 限定权限、正式文档同步和交付门禁 |
| `frontend/AGENTS.md` | 最近的前端服务规则 | 确定 i18n、测试、构建和 runtime authority 边界 |
| `ctl/AGENTS.md` | 最近的 CTL 服务规则 | 确定 CTL contract 测试边界 |
| `docs/context/project/services/frontend.md@2.1.0` | 前端服务派生上下文 | 确定双站前端验证范围 |
| `docs/context/project/services/ctl.md@2.1.0` | CTL 服务派生上下文 | 确定 feature contract 归属与 Go 测试范围 |
| `docs/context/domains/site-environment-routing.md@2.0.0` | 双站路由与 locale 边界 | 要求同一能力语义覆盖 CN/global |
| `docs/context/domains/agent-gateway-runtime.md@2.0.0` | Agent 与通知运行时边界 | 保持 Hermes/渠道 contract，不把 UI 测试当运行态证据 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 前端 runtime、i18n 与生成物邻接检查 | 纳入 runtime config、locale 生成与变更影响；按 FE-AI Native 规则不读取 `openspec/` |
| `wiki/prd-docs/2026-09-06-zero-token-automation-tasks.md` | 已确认 PRD | 需求、验收、灰度与回滚真源 |

## evidence
- Context route `implement zero-token automation tasks fixed notifications script tasks reuse scheduler notification channels frontend hermes no_agent` 未命中 Pack，已记录后改用路径路由。
- 路径路由 `frontend/src/pages/marketing/agent-automations-panel.tsx frontend/src/lib/hermes-cron-client.ts` 命中 frontend/site packs。
- 路径路由 `ctl/main/api/server.go frontend/src/contexts/runtime-config-context.tsx zero-token automation feature flag` 命中 frontend/ctl/runtime/site packs。
- Graphify 现有图查询定位 `AutomationFormModal`、`CronJobCard`、Hermes Cron client 和相关测试；未重建图。

## risks
- 受管理脚本序列化错误可能造成内容注入；使用结构化元数据和 base64 数据载荷，不把通知正文拼接为代码。
- 脚本运行在 Agent/Hermes 主机权限边界内；UI 创建和测试前必须明确提醒并确认。
- 创建 Cron 与写脚本是跨步骤操作；失败按所有权回滚，仅删除本次创建且可证明归属的脚本。
- 外部脚本可能被共享或手工管理；未知所有权脚本永不自动删除或覆盖。
- 目标 Hermes 镜像可能落后于官方主分支；本地代码完成不等于发布可用，发布前必须以目标镜像实测。
- 创建入口默认开启；为保留紧急止损能力，显式远端布尔 `false`、构建期 `false` 与本地紧急关闭仍可隐藏新建入口，已有任务识别和管理不受影响。

## validation
- 前端聚焦 Vitest：runtime config、自动任务 CN/global 组件测试。
- 前端 lint、typecheck、test、build 与仓库 `pnpm check` 对应门禁；共享生成目录的命令串行执行。
- locale 生成与校验按现有 package scripts 执行，生成资源不手工编辑。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`。
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`。
- 双站桌面/移动端创建、切换、测试反馈、列表和详情截图验证。

## decisions
- 固定通知是 LightVela 产品子类型，运行时仍为受管理 Python 脚本 + Hermes `no_agent`。
- 脚本任务统一通过受管理 Python wrapper 承载元数据、生效窗口和 Bash/Python 子进程；stdout/stderr/退出码按 Hermes script-only contract 传递。
- 任务类型创建后不可转换；外部 `no_agent` 任务按脚本任务显示且脚本只读，不要求用户为不可见的脚本内容勾选风险确认。
- 创建入口由前端默认开启，不依赖 CTL 新增 feature 字段或 CTL 发布；显式远端布尔 `false`、构建期关闭和本地紧急关闭仍可门控新建入口。
- 不修改 Hermes 运行时；目标镜像能力验证留作发布门禁。
- 列表类型信息采用“卡片减法、详情保留、下拉筛选”的层级：卡片仅保留运行状态标签，类型在详情与最近执行中展示，筛选器不与状态 Tab 同级且不显示冗余标题。

## scan_scope
- `frontend/src/lib/hermes-cron-client.ts`
- `frontend/src/pages/marketing/agent-automations-panel.tsx`
- `frontend/src/contexts/runtime-config-context.tsx`
- 对应聚焦测试与正式设计文档。

## scan_output
- Graphify query 命中既有图中的 UI、client 与测试符号；源码精确搜索确认 runtime flag contract 与现有受管理生效窗口脚本。

## handoff
- 当前处于 FE-AI Native `build` 阶段，已在独立 worktree 完成实现与本地验证，待登记 build 证据后进入 verify。
- 实现覆盖受管理固定通知、Bash/Python 脚本、所有权保护、测试运行、列表/详情/最近运行类型呈现，以及 CN/global/EdgeOne 默认开启并保留显式关闭通道的前端创建开关；Agent 任务路径保持原行为。
- `pnpm check`、282 个聚焦前端测试、CTL API Go 测试、文档校验、变更影响校验和 CN/global Webpack 构建均通过；双站桌面/390px 移动端原型验证无横向溢出。
- 全量 `pnpm test` 的需求相关用例通过，但仓库其余基线仍有 54 个失败并触发一次 4GB worker OOM；标准 Turbopack 构建在本机无进展，改用显式 Webpack 构建取得双站 `exit 0` 证据。
- 真实账号下的 `/agents/automations`、目标 Hermes 镜像中的 `no_agent` 调度/投递和发布配置尚未验证，不能将本地完成描述为运行态或发布完成。
- 主 checkout 有既存未跟踪文件和非目标分支；实现位于基于 `origin/master@c7395f17e` 的 `.worktrees/zero-token-automation-tasks`，未 stash、未覆盖用户改动。
- 未获授权执行 commit、push、MR、发布或生产操作。
