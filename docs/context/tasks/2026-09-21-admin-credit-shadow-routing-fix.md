---
id: admin-credit-shadow-routing-fix-2026-09-21
type: task
scope: 修正积分包后台管理鉴权接线，并把影子账号查询迁回 lightclaw-auth。
triggers: ["积分包后台", "影子账号后台", "credit admin routing"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - user/auth/internal/httpapi/admin.go
  - user/auth/internal/shadowbinding/
  - gateway-dashboard/src/app/api/
  - gateway-dashboard/k8s/
status: active
reviewed_at: 2026-09-21
review_due: 2026-12-20
revision: 1.0.0
precedence: task
derived: false
---

## goal
通过 master MR 和服务 CI 修正积分包后台管理接线，并由 lightclaw-auth 提供影子账号只读查询。

## non_goals
- 不直接修改运行中 Deployment、Secret 或 GitOps 分支。
- 不改变影子账号注册、实名、换绑和 testing 绑定写操作。
- 不触发生产发布或 Argo 同步。

## requirement_ids / requirement_refs / requirement_excerpt
- `conversation-2026-09-21-admin-credit-shadow-routing`
- 需求摘录：配置必须提 MR 到 master 后走 CI；影子账号能力合并在 lightclaw-auth，不使用独立 Shadow 服务。

## interface_refs / data_structure_refs
- `GET /admin/shadow-accounts`：Auth admin token 保护的只读分页查询。
- `shadow_bindings`：lightclaw-auth 持有的影子身份绑定表。
- `GET /internal/credit/admin/*`：Credit 管理接口继续使用共享内部服务令牌。
- Dashboard 浏览器只持有管理员会话；上游服务令牌仅由 BFF 注入。

## history_context
- `current_design_refs`：`docs/engineering/domains/identity-access.md`、`gateway-dashboard/README.md`。
- `relevant_evolution`：MR !4273 错把影子账号查询接到 standalone shadow，并漏接 Dashboard 的 Credit token。
- `superseded_refs`：`docs/context/tasks/2026-09-18-admin-shadow-accounts.md` 中 standalone Shadow 查询设计。

## acceptance
- Dashboard 影子账号查询使用 `AUTH_ADMIN_API_URL` 和 `AUTH_ADMIN_TOKEN`。
- lightclaw-auth 提供影子绑定分页、搜索与状态字段。
- Dashboard 的 `CREDIT_INTERNAL_TOKEN` 由现有同值共享 Secret 键显式映射，不引入明文或直接滚动更新。
- standalone shadow 不再暴露本次误加的管理查询接口。
- Auth、Dashboard、Kustomize 与 context 门禁通过。

## affected_paths
- `user/auth/internal/`
- `gateway-dashboard/`
- `shadow/`
- `docs/engineering/domains/identity-access.md`

## required_context
- `service-credit`
- `identity-access`
- `release-gitops`
- `tapd-gongfeng-delivery`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/credit.md@d7ccdbd04` | Credit 服务边界 | 保持 Credit 管理接口独立 |
| `docs/context/domains/identity-access.md@d7ccdbd04` | 身份 Owner 边界 | 将影子绑定查询放回 Auth |
| `docs/context/domains/release-gitops.md@d7ccdbd04` | CI/GitOps 发布约束 | 禁止直接滚动更新 |
| `docs/engineering/domains/release-gitops.md@23037357d` | 发布正式设计 | 补充 Dashboard 上游与共享令牌的 CI 投影约束 |
| `docs/context/flows/tapd-gongfeng-delivery.md@d7ccdbd04` | MR 交付门禁 | 提交 master MR |
| `gateway-dashboard/AGENTS.md@d7ccdbd04` | Dashboard source-facing 入口 | 修改 k8s 源模板 |
| `user/auth/AGENTS.md@d7ccdbd04` | Auth 发布与测试入口 | 增加 Auth admin API |
| `docs/context/project/adjacency/argocd-ci-secrets.md@d7ccdbd04` | Secret 与 CI 邻接 | 只改键映射，不输出密钥 |

## evidence
- 三地运行态只读比较确认 `gateway-dashboard-runtime-secrets.CTL_INTERNAL_TOKEN` 与 `credit-runtime-secrets.LIGHTCLAW_INTERNAL_SERVICE_TOKEN` 同值；命令仅输出 `match/no-match`。
- `user/auth`：`GOWORK=off go test ./...` 与 `go vet ./...` 通过。
- `gateway-dashboard`：项目测试、24 条显式 BFF 路由测试、ESLint 与 Next.js production build 通过；lint 仅保留两条既有 React Compiler warning。
- standalone `shadow`：完整测试与 vet 通过，且本次误加的管理查询改动已精确移除。
- Beijing sandbox、Shanghai、Singapore 三套 source-facing Kustomize overlay 均可渲染；渲染结果仅包含一处 `CREDIT_INTERNAL_TOKEN` 映射，且不再包含 Shadow API URL/Token。
- `validate_documentation.py` 与 `git diff --check` 通过；全仓 `validate_context.py --build-catalog` 仍报告 master 既有 Task Pack 元数据问题，本任务文档未出现在错误列表中。
- `validate_change_impact.py --repo . --staged` 通过；仅保留不阻断的 site-environment-routing 提示。

## risks
- Auth 查询字段与旧 Shadow SQLite 模型不同；Dashboard 必须以 `shadow_bindings` 的真实状态字段展示。
- Secret 映射错误会使 Credit BFF 返回 401；通过三地同值比较和 Kustomize render 缓解。
- 生产环境仍需 CI 构建后按既有手工 Argo 同步流程发布。

## validation
- `cd user/auth && go test ./... && go vet ./...`
- `cd gateway-dashboard && pnpm lint && pnpm test && pnpm build`
- 三套 Gateway Dashboard source-facing Kustomize render。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`

## decisions
- 影子账号查询复用 Auth admin 上游与 Token，不新增 Shadow URL/Token。
- Credit 使用已有共享内部令牌，通过 Deployment `env.valueFrom` 映射成语义明确的变量名。
- 只提交 master 源码和 source-facing 配置，由 CI 负责制品与 GitOps promotion。

## scan_scope
- `user/auth/internal/httpapi`
- `user/auth/internal/shadowbinding`
- `gateway-dashboard/src/app/api`
- `gateway-dashboard/k8s`
- `shadow/internal/httpapi`

## scan_output
- MR !4273 的 standalone Shadow 管理查询与目标部署边界冲突；Auth 已持有 `shadow_bindings` 和管理鉴权。

## handoff
- 当前状态：代码与本地门禁完成，等待 commit、push 和 master MR。
- 发布约束：只合入 master；由服务 CI 生成制品并推进 GitOps，不直接滚动运行中配置。
