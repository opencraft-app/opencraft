## goal
在最新 `origin/master` 的 Agent 控制台上统一 Setup / Use 导航分组，并按当前有效 Pass 的 `bundle_type` 调整 Model 入口位置。

## non_goals
- 不修改模型配置页、模型读写逻辑或套餐权益。
- 不改变非 `ai` 类型以及套餐类型未知状态的 Model 可发现性。
- 不合并 MR、不发布或操作生产环境。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户本轮请求（2026-09-21 修订）：基于最新 master，将 model、channel、skill、scheduled task 放在同一 Use 分组；当前有效 Pass 的 `bundle_type` 为 `ai` 时从主导航隐藏 Model，并在左下角用户菜单的 Plan & Billing 后展示 Model；其他类型保留主导航入口；模型页继续保留 Agent 左侧导航。外部需求标识：`unknown`。

## interface_refs / data_structure_refs
- `UserPassResponse.bundle_type`：CTL 从 Bundle 真源填充 `free` / `general` / `ai`，随 `GET /v1/passes` 和免费试用创建响应返回。
- 前端兼容边界：套餐判断集中在 `agent-plan-navigation.ts`，严格匹配 `bundle_type === "ai"`；字段缺失或未知值保守地保留主导航入口。
- `AGENT_SECTION_PATH_BY_ID.model`：模型配置页唯一入口路由。
- `getAgentSectionHref`：用户菜单跳转模型页时保留当前 Bot 查询参数。
- 不变量：入口迁移不改变 `/agents/models` 页面渲染和访问能力。

## history_context
- `current_design_refs`：`frontend/src/pages/marketing/agent-settings-page.tsx`、`frontend/src/components/site/user-avatar-menu.tsx`、`frontend/src/lib/agent-plan-navigation.ts`、`docs/engineering/domains/site-environment-routing.md`。
- `relevant_evolution`：最新 master 已包含新版左侧栏、底部账号菜单和 Bot 查询参数持久化；本任务在该结构上做最小修改。
- `superseded_refs`：旧预览 worktree `/Users/pablozhong/codex/lightvela-agent-nav-use-preview`，仅用于识别原始需求，不作为实现基线。

## acceptance
- Channel、Model、Skills、Automations 统一位于一个 Use 分组，不再展示 Setup 分组。
- 任意 `bundle_type === "ai"` 的当前有效 Pass，其 Use 分组不显示 Model。
- `ai` 类型套餐的用户菜单在 Plan & Billing 后显示 Model，并链接模型页。
- `free`、`general`、未知类型或字段缺失时继续在 Use 分组显示 Model，用户菜单不显示重复入口。
- 从用户菜单进入模型页时保留当前 Bot 查询参数，模型页继续渲染 Agent 左侧导航。
- 聚焦测试、前端检查、文档与 diff 检查通过。

## affected_paths
- `frontend/src/lib/agent-plan-navigation.ts`
- `frontend/src/lib/__tests__/agent-plan-navigation.test.ts`
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/agent-settings-labs-nav.test.tsx`
- `frontend/src/components/site/user-avatar-menu.tsx`
- `frontend/src/components/site/__tests__/user-avatar-menu.test.tsx`
- `ctl/pkg/logic/pass/logic.go`
- `ctl/pkg/logic/pass/credit_fill_test.go`
- `ctl/pkg/transport/pass.go`
- `ctl/main/api/pass_handler.go`
- `ctl/main/api/pass_response_test.go`
- `docs/engineering/domains/site-environment-routing.md`
- `docs/engineering/domains/agent-gateway-runtime.md`
- `docs/engineering/domains/subscription-entitlements.md`
- `frontend/docs/frontend-domestic-billing-flow.md`
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/UPSTREAM.json`
- `docs/context/tasks/2026-09-20-agent-navigation-use-ai-model.md`

## required_context
- Pack：`docs/context/domains/agent-gateway-runtime.md`。
- Pack：`docs/context/domains/subscription-entitlements.md`、`docs/context/flows/tapd-gongfeng-delivery.md`（CR 修订路由结果）。
- 服务入口：`docs/context/project/services/frontend.md`、`docs/context/project/services/ctl.md`。
- 邻接卡：`docs/context/project/adjacency/frontend-runtime-openspec-i18n.md`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@ddcaadbad5a6` | 仓库硬边界与 Task Pack 要求 | 约束隔离工作区、验证与交付范围 |
| `frontend/AGENTS.md@ddcaadbad5a6` | 前端服务门禁 | 确定复用策略与检查命令 |
| `frontend/DESIGN.md@ddcaadbad5a6` | 前端设计规范 | 保持既有导航和菜单样式 |
| `ctl/AGENTS.md` | CTL 服务门禁 | 约束用户面 Pass contract 与 Go 测试 |
| `docs/context/project/services/frontend.md` | context router 的 must_read | 确认前端数据与验证边界 |
| `docs/context/project/services/ctl.md` | context router 的 must_read | 确认 CTL Pass 响应所有权与验证边界 |
| `docs/context/domains/agent-gateway-runtime.md@2.1.0` | context router 的 must_read | 确认本次只变更前端入口，不改变运行时路由 |
| `docs/context/domains/subscription-entitlements.md` | CR 修订 context router 的 must_read | 核对套餐标识与权益边界 |
| `docs/context/flows/tapd-gongfeng-delivery.md` | CR 修订 context router 的 must_read | 约束 MR 修订与交付状态表述 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 前端邻接检查 | 核对实现、相邻测试与 i18n 边界 |
| `opencraft/AGENTS.md`、`opencraft/MONO2_MIGRATION.md` | CR 指出 vendored closure 漂移 | 将套餐策略移出 vendored `agent-routes.ts`，不手改生成副本 |

## evidence
- 基线：`origin/master@ddcaadbad5a60a55d6f3a7a85d744e48d8d27b56`。
- `corepack pnpm@10.23.0 exec vitest run --config vitest.config.ts --api.host 127.0.0.1 ...`：CR 修订后 6 个文件、74 条测试通过，覆盖套餐 helper、AI/标准套餐菜单、Header 隔离、英文 `Models`、导航分组和 provider locale。
- `corepack pnpm@10.23.0 check`：通过；i18n 错误 0，TypeScript diagnostics 171 current / 276 baseline / 0 new / 105 resolved。
- `git diff --check`：通过。
- `validate_change_impact.py --repo . --staged`（隔离临时 index）：通过，无命中的正式设计映射。
- `validate_documentation.py --repo . --format json`：错误 0、断链 0、警告 0。
- 国际站本地预览由 `/Users/pablozhong/codex/lightvela-agent-nav-use-latest/frontend` 监听 `5174`；Chrome 同登录态页面显示新版 master 的底部账号菜单和新版侧栏，Setup 已移除，Use 依次展示 Channels / Models / Skills / Scheduled Tasks。页面资源来自 Next.js dev `_next/static`，不是生产 `__releases/`。
- 国内站本地预览已切换至同一 worktree 的 `pnpm dev:cn` / `5174`，通过现有 Whistle `lv` 规则映射 `lightvela.com`；Chrome 登录态页面完整加载，使用分组依次展示通道 / 模型 / 技能 / 定时任务，浏览器错误为 0，页面资源来自本地 Next.js dev `_next/static`。
- CR 修订：AI 套餐的 Model 入口仅允许出现在 Agent 侧栏底部账号菜单；公共 Header 不展示；英文复用集合标签规则显示为 `Models`。
- CR 修订：套餐入口判断移至非 vendored 的 `agent-plan-navigation.ts`，MR 相对 `origin/master` 不再修改 `agent-routes.ts`，因此不新增 OpenCraft Agent Console closure 漂移。
- CR 修订后 `corepack pnpm@10.23.0 check`：通过；i18n 错误 0，TypeScript diagnostics 171 current / 276 baseline / 0 new / 105 resolved。
- `npm --prefix opencraft run check:mono2-agent-console`：仍在既有 `components/ui/scroll-area.tsx` 漂移处失败；`git diff --exit-code origin/master -- frontend/src/lib/agent-routes.ts frontend/src/lib/__tests__/agent-routes.test.ts` 通过，确认本 MR 不再新增 `agent-routes` vendor closure 漂移。
- `validate_documentation.py`：错误 0、断链 0、警告 0；`validate_change_impact.py --staged`（隔离临时 index）：通过。
- 本轮 `bundle_type` 修订：前端聚焦 Vitest 共 7 个文件、111 条测试通过，覆盖 `ai`、`free`、`general`、未知和字段缺失状态，以及侧栏菜单、公共 Header、导航顺序与间距。
- 本轮 `corepack pnpm@10.23.0 check`：通过；i18n 错误 0，TypeScript diagnostics 171 current / 276 baseline / 0 new / 105 resolved。
- CTL：`CGO_ENABLED=0 go test -run TestFillBundleMetadataIncludesBundleType -count=1 ./pkg/logic/pass` 与 `CGO_ENABLED=0 go test -run TestDetailToUserPassResponseIncludesBundleType -count=1 ./main/api` 通过，另以 `-run '^$'` 完成 Pass logic 编译。常规 CGO 测试被本机 Go 1.26/macOS SDK 缺失 `_SecTrustCopyCertificateChain` 阻断；关闭 CGO 后 SQLite 运行测试不可用，因此未把环境失败记为测试通过。
- 本轮 `validate_documentation.py`：错误 0、断链 0、警告 0；`validate_change_impact.py --staged`（隔离临时 index）：通过，命中 `agent-gateway-runtime` 并同步正式设计文档。
- OpenCraft 生成闭包未新增业务文件漂移：本轮不修改闭包内的 `domain/types.ts`；rebase 后运行官方同步命令，仅更新 `UPSTREAM.json` 的源 revision，`check:mono2-agent-console` 通过。
- 本轮 `git diff --check`：通过。
- 提交前刷新并 rebase 到 `origin/master@f09b62866ad7c20a507fe4beeb455c9d7fe8eba6`，无冲突；rebase 后前端 7 个文件、111 条测试与 CTL 聚焦测试重新通过，`pnpm check` 为 171 current / 171 baseline / 0 new。

## risks
- 风险：CTL 与前端分批发布时旧响应没有 `bundle_type`。缓解：仅严格匹配 `ai` 时迁移，字段缺失、大小写异常或未知值都保留主导航入口。
- 风险：用户菜单跳转后切换了当前 Bot。缓解：复用 `getAgentSectionHref` 保留 `bot` 查询参数。
- 回滚：移除套餐判断并恢复 Model 为 Use 分组固定入口。

## validation
- 聚焦 Vitest：路由、用户菜单、Agent 导航测试。
- `cd frontend && pnpm check`
- `git diff --check`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`
- 国际站同登录态本地预览。

## decisions
- 以 CTL 返回的 `bundle_type` 精确匹配 `ai`，不使用套餐 ID 或可本地化套餐名推断。
- `bundle_type` 由既有 Bundle 查询在 Pass 运行时填充，不新增前端请求；前端对旧响应保持 fail-open 可发现性。
- 前端在非 vendored 的导航策略 helper 中收窄新增字段，避免为单一导航策略扩大 OpenCraft 生成闭包；正式 wire contract 由 CTL transport 与文档记录。
- 使用 `Use` 作为统一分组名，沿用产品现有英文信息架构。
- 复用 `/agents/models`，不新增账号子页面。
- 仅在 `UserAvatarMenu` 的 `sidebar` variant 展示迁移入口，公共 Header 保持既有账号菜单边界。
- 使用既有 `resolveAgentConsoleCollectionLabel` 统一英文集合名，避免菜单 `Model` 与侧栏 `Models` 不一致。
- 不扩大 OpenCraft vendor closure；将产品套餐策略放在普通前端 helper 中，避免为了单个策略函数同步无关的 129 文件生成闭包。

## scan_scope
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/components/site/user-avatar-menu.tsx`
- `frontend/src/lib/agent-plan-navigation.ts`
- 对应聚焦测试。

## scan_output
- 通过 `settingsGroups|activePass|ACCOUNT_BILLING_PATH|AGENT_SECTION_PATH_BY_ID|bundle_type|UserPassResponse|fillCredit` 完成最新 master 的有界精确搜索。

## handoff
- 已在最新 master 的隔离 worktree 完成实现、检查与国内/国际站登录态预览；本轮已将套餐判断从固定 Bundle ID 改为 CTL `bundle_type` contract，并补齐用户面 Pass 响应字段与兼容测试。
- 本轮改动已在最新 master 基线上提交并验证；交付目标为更新当前功能分支到 `master` 的 MR，不合并、不发布。
