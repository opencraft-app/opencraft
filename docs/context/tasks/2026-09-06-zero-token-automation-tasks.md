## goal
在 LightVela 国内站与国际站的现有自动任务产品中，增加基于 Hermes `no_agent` 的 0 Token 固定通知与脚本任务，同时复用既有定时和通知配置，并保持已有 Agent 任务行为不变。

## non_goals
- 不修改 Hermes Agent 本体、调度器或通知渠道协议。
- 不把用户脚本描述为运行在独立安全沙箱中。
- 不支持 Agent 任务、固定通知、脚本任务之间直接转换。
- 不提交、推送、创建 MR、发布或操作生产环境。

## requirement_ids / requirement_refs / requirement_excerpt
- `ZT-AUTO-2026-09-06`：`wiki/prd-docs/2026-09-06-zero-token-automation-tasks.md`。
- 范围：现有创建入口增加 Agent / 0 Token；0 Token 包含固定通知与 Bash/Python 脚本任务。
- 共享约束：三种任务复用同一套定时、时区、生效窗口和通知渠道配置。
- 运行约束：0 Token 任务映射 Hermes `no_agent`；无模型降级；关闭创建开关后仍可管理已有任务。

## interface_refs / data_structure_refs
- `frontend/src/lib/hermes-cron-client.ts`：`CronJob`、`CronInferenceConfig`、`CreateCronJobInput`、Hermes CLI 命令构造、脚本文件生命周期、测试任务生命周期。
- `frontend/src/pages/marketing/agent-automations-panel.tsx`：创建/编辑表单、任务卡片、详情、最近运行、双站通知渠道。
- `frontend/src/contexts/runtime-config-context.tsx`：创建入口的 runtime feature flag；关闭时不得隐藏已有任务管理能力。
- `ctl/main/api/server.go`：`GET /v1/frontend/runtime-config` 的 feature contract。
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
- 已有外部 `no_agent` 任务识别为脚本任务；无法确认 LightVela 所有权的脚本只读，但任务仍可启停和删除。
- 功能开关只控制新的 0 Token 创建入口；已有任务管理入口始终保留。
- 新增中英文及开放 locale 文案通过生成资源检查；新增行为有聚焦单元/组件测试和双站可视验证。

## affected_paths
- `frontend/src/lib/hermes-cron-client.ts`
- `frontend/src/lib/__tests__/hermes-cron-client.test.ts`
- `frontend/src/pages/marketing/agent-automations-panel.tsx`
- `frontend/src/pages/marketing/__tests__/agent-automations-panel*.test.tsx`
- `frontend/src/contexts/runtime-config-context.tsx`
- `frontend/src/contexts/__tests__/runtime-config-context.test.ts`
- `frontend/src/locales/**`
- `ctl/main/api/server.go`
- `ctl/main/api/*test.go`
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
- runtime flag 默认值或请求失败回退错误可能提前暴露入口；新增 flag 采用失败关闭，已有任务识别和管理不受 flag 影响。

## validation
- 前端聚焦 Vitest：Hermes Cron client、runtime config、自动任务 CN/global 组件测试。
- 前端 lint、typecheck、test、build 与仓库 `pnpm check` 对应门禁；共享生成目录的命令串行执行。
- locale 生成与校验按现有 package scripts 执行，生成资源不手工编辑。
- `cd ctl && go test ./main/api/...`，必要时扩展为 `go test ./...`。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`。
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`。
- 双站桌面/移动端创建、切换、测试反馈、列表和详情截图验证。

## decisions
- 固定通知是 LightVela 产品子类型，运行时仍为受管理 Python 脚本 + Hermes `no_agent`。
- 脚本任务统一通过受管理 Python wrapper 承载元数据、生效窗口和 Bash/Python 子进程；stdout/stderr/退出码按 Hermes script-only contract 传递。
- 任务类型创建后不可转换；外部 `no_agent` 任务按脚本任务显示且脚本只读。
- feature flag 只门控创建入口，默认失败关闭；内部账号灰度属于发布配置/身份策略，不在前端伪造账号判断。
- 不修改 Hermes 运行时；目标镜像能力验证留作发布门禁。

## scan_scope
- `frontend/src/lib/hermes-cron-client.ts`
- `frontend/src/pages/marketing/agent-automations-panel.tsx`
- `frontend/src/contexts/runtime-config-context.tsx`
- `ctl/main/api/server.go`
- 对应聚焦测试与正式设计文档。

## scan_output
- Graphify query 命中既有图中的 UI、client 与测试符号；源码精确搜索确认 runtime flag contract 与现有受管理生效窗口脚本。

## handoff
- 当前处于 FE-AI Native `build` 阶段，已在独立 worktree 完成实现与本地验证，待登记 build 证据后进入 verify。
- 实现覆盖受管理固定通知、Bash/Python 脚本、所有权保护、测试运行、列表/详情/最近运行类型呈现，以及默认关闭的 runtime 创建开关；Agent 任务路径保持原行为。
- `pnpm check`、282 个聚焦前端测试、CTL API Go 测试、文档校验、变更影响校验和 CN/global Webpack 构建均通过；双站桌面/390px 移动端原型验证无横向溢出。
- 全量 `pnpm test` 的需求相关用例通过，但仓库其余基线仍有 54 个失败并触发一次 4GB worker OOM；标准 Turbopack 构建在本机无进展，改用显式 Webpack 构建取得双站 `exit 0` 证据。
- 真实账号下的 `/agents/automations`、目标 Hermes 镜像中的 `no_agent` 调度/投递和发布配置尚未验证，不能将本地完成描述为运行态或发布完成。
- 主 checkout 有既存未跟踪文件和非目标分支；实现位于基于 `origin/master@c7395f17e` 的 `.worktrees/zero-token-automation-tasks`，未 stash、未覆盖用户改动。
- 未获授权执行 commit、push、MR、发布或生产操作。
