---
id: admin-credit-packages-2026-09-18
type: task
scope: Gateway Dashboard 积分包查询与退款管理入口。
triggers: ["后台积分包", "积分包查询", "积分包退款"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - credit/AGENTS.md
  - docs/engineering/domains/site-environment-routing.md
  - docs/context/tasks/2026-09-18-admin-credit-packages.md
status: active
reviewed_at: 2026-09-18
review_due: 2026-12-17
revision: 1.0.0
precedence: task
derived: false
---

## goal
在 Gateway Dashboard 的“业务订阅”下新增“积分包”管理页，支持按条件查询 live 积分包并发起退款。

## non_goals
- 不展示已归档积分包。
- 不增加商品编辑、人工销毁、续费或用量修正能力。
- 不修改用户侧积分包接口和计费退款语义。

## requirement_ids / requirement_refs / requirement_excerpt
- `conversation-2026-09-18-admin-credit-packages`
- 需求摘录：后台管理新增积分包页面，位于业务订阅下，页面风格相近，提供查询和退款。

## interface_refs / data_structure_refs
- `credit/internal/httpapi/server.go`：新增内部管理 API，复用 `LIGHTCLAW_INTERNAL_SERVICE_TOKEN` 鉴权。
- `credit/internal/store/mysql.go`：live package、product、usage 联表分页查询。
- `credit/internal/tradeclient/client.go`：退款继续复用 `RefundPackage`。
- `gateway-dashboard/src/app/api/admin-proxy-route-helpers.ts`：新增 Credit BFF 模块映射。
- 不变量：退款只调用既有在线退款链路；不在管理 API 内直接隔离、删除或归档积分包。

## history_context
- `current_design_refs`：`credit/AGENTS.md`、`docs/engineering/domains/subscription-entitlements.md`。
- `relevant_evolution`：积分包为一次性资源包，无续费；退款后由计费回调隔离并归档。
- `superseded_refs`：无。

## acceptance
- 侧边栏“业务订阅”下方出现“积分包”。
- 页面可按用户 ID、积分包 ID、商品 ID、状态分页查询 live 积分包。
- 列表展示资源、用户、商品、余额、计费账号、订单与时间信息。
- `active` 积分包可二次确认后退款；其他状态不展示退款操作。
- Credit 管理 API 必须通过内部 Token 鉴权。
- Credit Go test/vet、Gateway Dashboard lint/type/test/build 和 context impact 门禁通过。

## affected_paths
- `credit/internal/httpapi/`
- `credit/internal/store/`
- `gateway-dashboard/src/`
- `gateway-dashboard/k8s/`
- `docs/engineering/domains/site-environment-routing.md`

## required_context
- `subscription-entitlements`
- `control-plane-ops`
- `service-credit`
- `gateway-dashboard-service-context`
- `admin-gateway-service-context`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/subscription-entitlements.md@origin/master` | 权益与退款边界 | 保持 Credit/Trade 责任划分 |
| `docs/context/project/services/ctl.md@origin/master` | 现有业务订阅后台模式 | 对齐管理查询与退款交互 |
| `docs/context/project/services/credit.md@origin/master` | Credit 生命周期 | 限制查询范围为 live package |
| `credit/AGENTS.md@origin/master` | Credit 权威约束 | 复用在线退款与内部 Token |
| `gateway-dashboard/AGENTS.md@origin/master` | Dashboard 发布边界 | 使用 BFF 与正式环境变量接线 |
| `docs/context/project/services/gateway-dashboard.md@origin/master` | 管理台责任 | UI 只消费后端契约 |
| `docs/context/project/services/admin-gateway.md@origin/master` | 公网管理入口 | 不增加 direct-access 路径 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@origin/master` | 前端邻接检查 | 核验相邻页面测试与运行时配置 |

## evidence
- `cd credit && go test ./... && go vet ./...`：通过；沙箱内因 miniredis 监听端口受限，已在获批的沙箱外环境复跑。
- `cd gateway-dashboard && pnpm lint`：通过，保留 2 条既有 React Compiler compatibility warning，无 error。
- Dashboard 测试：使用临时 Node 22 运行仓库 test 命令，18 项通过；另单独运行 `admin-proxy-route-helpers.test.ts`，20 项通过。
- `cd gateway-dashboard && pnpm build`：通过，产物包含 `/credit-packages` 与 `/api/credit/[...path]`。
- 本地 Webpack 预览 + 纯本地 mock：登录 204、积分包页面 200、BFF 查询 200 并返回示例 package、BFF 退款 POST 200。
- `kubectl kustomize gateway-dashboard/k8s/base`：通过，`CREDIT_API_URL` source-facing 占位符存在。
- `validate_documentation.py`：通过，无 broken link 或文档分类问题。
- `validate_change_impact.py`：传入 working tree 与 untracked 文件后通过，命中 `site-environment-routing` 且正式设计已更新。
- `validate_context.py --build-catalog`：全仓因历史 Task Pack schema、既有 credential finding 和 instruction-chain 长度超限失败；当前 Task Pack 单独检查无 error。
- `.agents/context` / `context-audit` 全仓单测仍有既有失败，本次未修改对应工具或历史文档。

## risks
- 管理 Token 未注入时 Dashboard BFF 返回 500，Credit 管理接口自身也 fail closed；发布前需在目标环境 GitOps/加密 secret 中显式接线。
- 重复退款由既有 Trade/计费链路处理；页面提交期间禁用按钮，避免前端重复点击。
- live package 在退款后可能短暂仍显示，成功后刷新查询并等待计费隔离回调。

## validation
- `cd credit && env GOCACHE=/tmp/codex-go-cache go test ./...`
- `cd credit && env GOCACHE=/tmp/codex-go-cache go vet ./...`
- `cd gateway-dashboard && pnpm lint`
- `cd gateway-dashboard && pnpm exec tsc --noEmit`（当前仓库既有 `.test.ts` 扩展导入配置会报错，生产构建内置 TypeScript 检查已通过）
- `cd gateway-dashboard && pnpm test`
- `cd gateway-dashboard && pnpm build`
- source-facing Kustomize base render。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --changed-file ...`

## decisions
- 管理查询只返回 live 表，保持与 Credit 生命周期和用户可用资源一致。
- 管理退款复用现有 `RefundPackage`，不引入后台专用退款语义。
- BFF 使用 `CREDIT_API_URL` 与 `CREDIT_INTERNAL_TOKEN`，不向浏览器暴露内部凭据。

## scan_scope
- `gateway-dashboard/src/app/(dashboard)/subscriptions`
- `gateway-dashboard/src/lib/queries`
- `credit/internal/httpapi`
- `credit/internal/store`

## scan_output
- 精确搜索命中现有 Pass 查询/退款页面、Credit 用户退款和内部鉴权入口。

## handoff
- 当前状态：Credit 管理接口、Dashboard BFF/UI、source-facing 部署模板和正式文档已实现并通过门禁。
- 发布前置：经单独授权后，在目标环境 deploy-facing GitOps 中配置 `CREDIT_API_URL`，并把与 Credit 匹配的 `CREDIT_INTERNAL_TOKEN` 写入加密 runtime secret。
