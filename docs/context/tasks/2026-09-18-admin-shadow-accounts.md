---
id: admin-shadow-accounts-2026-09-18
type: task
scope: Gateway Dashboard 认证用户页中的影子账号查询视图。
triggers: ["后台影子账号", "影子账号查询", "认证用户影子账号"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - shadow/AGENTS.md
  - docs/engineering/domains/identity-access.md
  - docs/context/tasks/2026-09-18-admin-shadow-accounts.md
status: retired
reviewed_at: 2026-09-21
review_due: 2026-12-17
revision: 1.1.0
precedence: task
derived: false
---

## goal
在 Gateway Dashboard 的“认证用户”页面增加“影子账号”视图，支持查询 Shadow 服务中的用户注册状态和腾讯云账号绑定信息。

## non_goals
- 不增加影子账号注册、实名状态修改、手机号换绑或账号删除能力。
- 不直接读取 Shadow SQLite 文件，不绕过 Shadow 服务边界。
- 不修改公共影子账号注册、回调或支付流程。

## requirement_ids / requirement_refs / requirement_excerpt
- `conversation-2026-09-18-admin-shadow-accounts`
- 需求摘录：后台管理增加影子账号能力，优先评估放入“认证用户”页面，也可单独成页。

## interface_refs / data_structure_refs
- `GET /internal/shadow/admin/accounts`：内部只读分页查询，独立内部 Token 鉴权。
- `shadow/internal/storage/storage.go`：用户注册状态与 binding 联合查询契约。
- `gateway-dashboard/src/app/(dashboard)/auth-users/page.tsx`：通过 Tab 区分认证用户与影子账号。
- 不变量：浏览器只持有 Dashboard 管理员会话；Shadow 内部 Token 仅由 BFF 注入。

## history_context
- `current_design_refs`：`shadow/AGENTS.md`、`docs/engineering/domains/identity-access.md`。
- `relevant_evolution`：Shadow 独立拥有影子账号注册、认证和腾讯云绑定事实，Dashboard 不跨服务拼接数据库。
- `superseded_refs`：无。

## acceptance
- “认证用户”页面内提供“认证用户”和“影子账号”两个 Tab。
- 影子账号视图支持按用户 ID、影子用户名、手机号、UIN、OwnerUIN、AppID 或实例 ID 搜索。
- 列表展示注册、基础认证、标准实名状态以及腾讯云绑定信息。
- Shadow 管理 API 在 Token 未配置或不匹配时 fail closed。
- Shadow Go test/vet、Gateway Dashboard lint/test/build 和 context impact 门禁通过。

## affected_paths
- `shadow/internal/httpapi/`
- `shadow/internal/storage/`
- `shadow/internal/config/`
- `gateway-dashboard/src/`
- `gateway-dashboard/k8s/`
- `docs/engineering/domains/identity-access.md`

## required_context
- `identity-access`
- `agent-gateway-runtime`
- `service-shadow`
- `gateway-dashboard-service-context`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/identity-access.md@origin/master` | 身份与影子账号责任边界 | 保持 Shadow 为绑定事实 Owner |
| `docs/context/domains/agent-gateway-runtime.md@origin/master` | Dashboard 与网关运行时边界 | 限制浏览器侧凭据暴露 |
| `docs/context/project/services/shadow.md@origin/master` | Shadow 派生服务上下文 | 定位存储、回调和认证入口 |
| `shadow/AGENTS.md@origin/master` | Shadow 服务约束 | 沿用 storage interface 与服务测试方式 |
| `shadow/docs/README.md@origin/master` | Shadow 正式入口 | 核对服务能力和验证命令 |
| `gateway-dashboard/AGENTS.md@origin/master` | Dashboard 发布边界 | 只修改 source-facing 配置模板 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@origin/master` | 前端配置邻接检查 | 核对 BFF 环境变量及相邻测试 |

## evidence
- `cd shadow && GOWORK=off GOCACHE=/tmp/codex-shadow-go-cache go test ./... && ... go vet ./...`：通过；全量测试因既有 `httptest` 需要监听临时端口，在获批的沙箱外环境执行。
- `cd gateway-dashboard && npm run lint`：通过，保留 2 条既有 React Compiler compatibility warning，无 error。
- Dashboard Node 22 基础测试 4 项通过；`admin-proxy-route-helpers.test.ts` 单独通过，包含 Shadow 路由和服务端 Token 断言。
- `cd gateway-dashboard && npm run build`：通过，产物包含 `/auth-users` 与 `/api/shadow/[...path]`。
- 本地 Webpack 预览 + 纯本地 mock：登录返回 204，认证用户页面返回 200，Shadow BFF 查询返回 200，并保留 UIN、OwnerUIN、AppID 的字符串表示。
- `kubectl kustomize gateway-dashboard/k8s/base`：通过，`SHADOW_API_URL` source-facing 占位符存在。
- `validate_documentation.py`：通过，无 broken link 或文档分类问题。
- `validate_change_impact.py`：变更集合命中 `identity-access` 与 `site-environment-routing`；两份正式设计均已更新。

## risks
- Shadow 当前使用 SQLite；管理查询必须分页，避免全表返回影响注册主链路。
- 内部 Token 未接线时 API 和 BFF 均失败关闭；发布前需在目标环境的加密 secret 中配置同值 Token。

## validation
- `cd shadow && go test ./...`
- `cd shadow && go vet ./...`
- `cd gateway-dashboard && pnpm lint`
- `cd gateway-dashboard && pnpm test`
- `cd gateway-dashboard && pnpm build`
- source-facing Kustomize base render。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`

## decisions
- 影子账号属于身份映射，使用“认证用户”页内 Tab，不增加侧边栏一级入口。
- 本期只提供只读查询，避免将注册、实名和换绑操作扩展为后台捷径。
- 查询以 `users LEFT JOIN bindings` 返回注册中和已绑定记录，不只展示成功绑定账号。

## scan_scope
- `shadow/internal/httpapi`
- `shadow/internal/storage`
- `gateway-dashboard/src/app/(dashboard)/auth-users`
- `gateway-dashboard/src/app/api`

## scan_output
- Shadow 当前无管理查询接口；现有 SQLite `users` 与 `bindings` 足以形成只读视图。

## handoff
- 当前状态：本方案已被 `2026-09-21-admin-credit-shadow-routing-fix.md` 取代。
- 原因：实际影子账号运行边界和权威存储位于 `lightclaw-auth`，不应依赖 standalone Shadow 服务。
