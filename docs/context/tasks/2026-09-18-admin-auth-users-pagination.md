---
id: admin-auth-users-pagination-2026-09-18
type: task
scope: Gateway Dashboard 认证用户列表的服务端分页。
triggers: ["认证用户分页", "后台用户分页"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - user/auth/AGENTS.md
  - docs/engineering/domains/identity-access.md
  - docs/context/tasks/2026-09-18-admin-auth-users-pagination.md
status: active
reviewed_at: 2026-09-18
review_due: 2026-12-17
revision: 1.0.0
precedence: task
derived: false
---

## goal
为 Gateway Dashboard 的认证用户列表增加真实的服务端分页和每页条数选择。

## non_goals
- 不改变用户搜索字段、删除用户或代登语义。
- 不为短信验证码和邀请码列表顺带增加分页。

## requirement_ids / requirement_refs / requirement_excerpt
- `conversation-2026-09-18-admin-auth-users-pagination`
- 需求摘录：认证用户当前没有分页功能，需要补充。

## interface_refs / data_structure_refs
- `GET /admin/users?page=<n>&page_size=<n>&search=<text>`：返回当前页 `items` 与全部匹配数 `total`。
- 旧 `limit` 参数继续作为未传 `page_size` 时的兼容页大小。
- `user/auth/internal/service.Store`：分页查询同时返回 items 和 total。

## history_context
- `current_design_refs`：`docs/engineering/domains/identity-access.md`。
- `relevant_evolution`：原接口仅应用 `LIMIT`，响应 `total` 等于当前页长度，无法驱动真实分页。
- `superseded_refs`：无。

## acceptance
- 认证用户列表支持上一页、下一页和 20/50/100 每页条数。
- 搜索变化时回到第一页。
- `total` 表示全部匹配记录数，而非当前页长度。
- MySQL 与 Memory Store 使用相同分页语义。
- User Auth 测试/vet、Dashboard lint/test/build 和 context impact 门禁通过。

## affected_paths
- `user/auth/internal/httpapi/`
- `user/auth/internal/service/`
- `gateway-dashboard/src/app/(dashboard)/auth-users/`
- `gateway-dashboard/src/lib/queries/use-auth-admin.ts`
- `docs/engineering/domains/identity-access.md`

## required_context
- `identity-access`
- `agent-gateway-runtime`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/identity-access.md@origin/master` | Auth 责任边界 | 保持管理查询由 User Auth 提供 |
| `docs/context/domains/agent-gateway-runtime.md@origin/master` | Dashboard 运行时边界 | 保持既有 BFF 调用路径 |
| `user/auth/AGENTS.md@origin/master` | User Auth 发布与验证约束 | 使用服务自身测试门禁 |
| `gateway-dashboard/AGENTS.md@origin/master` | Dashboard 发布边界 | 不修改 deploy-facing GitOps |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@origin/master` | 前端相邻验证 | 核对查询 hook 和生产构建 |

## evidence
- User Auth Store 增加分页查询契约，MySQL 使用同条件 `COUNT(*)` 与 `LIMIT/OFFSET`，Memory Store 使用相同筛选、排序和切页语义。
- `GET /admin/users` 接受 `page/page_size` 并返回完整匹配数 `total` 与页码元数据；旧 `limit` 仍可作为兼容页大小。
- Gateway Dashboard 认证用户 Tab 使用服务端分页，提供 20/50/100 每页条数，搜索变化时回到第一页。
- User Auth 全量 `go test ./...` 与 `go vet ./...` 通过。
- Gateway Dashboard ESLint 通过（仅两条既有 React Compiler warning），20 个 Node 测试与 Next.js 生产构建通过。
- 文档完整性和变更影响门禁通过；变更影响检查提示 identity-access 需要 Owner review，符合该身份管理面变更的预期。

## risks
- MySQL count 与 page query 是两个只读语句，极短并发窗口内 total 与 items 可能因用户新增略有偏差；下一次查询会收敛。
- 页码过大返回空 items，但保留真实 total。

## validation
- `cd user/auth && go test ./... && go vet ./...`
- `cd gateway-dashboard && npm run lint`
- Dashboard Node 22 tests。
- `cd gateway-dashboard && npm run build`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --changed-file ...`

## decisions
- 使用服务端 `LIMIT/OFFSET`，不在浏览器对最多 100 条结果做假分页。
- 保留 `limit` 参数兼容旧管理调用，`page_size` 优先。

## scan_scope
- `user/auth/internal/httpapi/admin.go`
- `user/auth/internal/service/{store,mysql_store,memory_store,service}.go`
- `gateway-dashboard/src/lib/queries/use-auth-admin.ts`

## scan_output
- 原接口只支持 `limit`，且 Handler 把 `len(items)` 当作 `total`。

## handoff
- 当前状态：实现与本地验证完成，尚未提交、推送或发布。
