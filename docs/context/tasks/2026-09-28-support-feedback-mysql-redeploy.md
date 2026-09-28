## goal
将 LightVela 自建问卷/反馈系统恢复为可重新部署的双站能力：国内站与国际站均可直达提交；反馈主记录与附件统一存放在 ticket MySQL。

## non_goals
- 不发布生产；用户已授权将仅问卷相关内容提交并 push 到独立分支。
- 不下掉既有腾讯问卷入口。
- 不恢复 ticket release contract；尊重 !2093/!2094 临时下线决策，测试发布先走后端/发布同学认可的临时北京测试发布路径。
- 不迁移历史 COS 反馈数据。

## requirement_refs
- 用户要求：重新部署问卷系统，国际国内都要做；附件最好也和主记录放在一起。
- 后续修正：前端本地页面已验收 OK；旧腾讯问卷入口必须保留，新站内问卷入口只作为“用户反馈”补回。

## interface_refs / data_structure_refs
- 用户提交：`POST /support/feedback/submit`，`multipart/form-data`。
- 运营列表：`GET /support/feedback/list?site=cn|global`。
- 附件下载：`GET /support/feedback/attachment/:id`。
- MySQL 表：`support_feedback`、`support_feedback_attachment`。
- 附件限制：最多 5 个；单文件 50MB；单条反馈附件总计 100MB。

## history_context
- 之前实现使用 COS 存主记录 JSON 和附件；本次改为 MySQL 主存储，COS 不再是反馈新链路依赖。
- ticket 服务已有 `ticket / ticket_message / ticket_audit_log` MySQL 分层，本次沿用 `httpapi → service → store`。

## acceptance
- 国内裸 `/support` 可渲染。
- 国际带语言前缀 `/es/support` 等可渲染。
- 新反馈数据按 `site=cn/global` 分区进入 MySQL。
- dashboard 可切国内/国际/全部并下载 MySQL 附件。
- 既有“产品反馈”腾讯问卷入口保留；用户头像菜单补回“用户反馈”站内入口 `/support`。

## affected_paths
- `frontend/src/app/(site)/support/`
- `frontend/src/app/(site)/[lang]/support/`
- `frontend/next-site/support-page.tsx`
- `frontend/src/lib/support-feedback-cos-client.ts`
- `frontend/src/components/site/user-avatar-menu.tsx`
- `frontend/src/constants/product-feedback.ts`
- `ticket/`
- `gateway-dashboard/src/app/(dashboard)/feedback/page.tsx`
- `argocd/services/service-gateway/{sgprod,shprod}/config.yaml`
- `argocd/services/gateway-dashboard/{sgprod,shprod}/gateway-dashboard-platform.env`

## required_context
- `docs/context/domains/site-environment-routing.md`
- `docs/context/project/services/frontend.md`
- `docs/context/project/services/gateway-dashboard.md`
- `docs/context/project/services/ticket.md`
- `docs/context/domains/agent-gateway-runtime.md`
- `frontend/AGENTS.md`
- `gateway-dashboard/AGENTS.md`
- `ticket/AGENTS.md`
- `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/site-environment-routing.md` | 双站与部署边界 | 确认国内/国际需分别接网关与前端路由 |
| `docs/context/project/services/frontend.md` | 前端服务规则 | 确认验证边界与 i18n 要求 |
| `docs/context/project/services/gateway-dashboard.md` | dashboard 服务规则 | 确认正式发布经 Argo CD |
| `docs/context/project/services/ticket.md` | ticket 存储与分层 | 确认 MySQL、realm、审计分层约束 |
| `docs/context/domains/agent-gateway-runtime.md` | service-gateway 路由权威 | 确认公共入口不能只靠直连上游 |
| `frontend/AGENTS.md` | 前端命令与硬规则 | 选择 typecheck、i18n、聚焦测试 |
| `gateway-dashboard/AGENTS.md` | dashboard 发布边界 | 修改 deploy-facing env |
| `ticket/AGENTS.md` | ticket 发布模型 | 新增 migration 与 MySQL store |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | 前端邻接 | 同步 i18n generated 并跑 i18n check |

## evidence
- `GOWORK=off GOCACHE=/tmp/mono2-ticket-go-cache go test ./cmd/ticket ./cmd/ticket-migrate ./internal/...`
- `pnpm typecheck`
- `pnpm i18n:check`
- `pnpm vitest run 'src/app/(site)/support/page.next.test.tsx' next-site/__tests__/support-page-localization.test.ts src/lib/__tests__/public-site-navigation.test.ts`
- `pnpm vitest run src/components/site/__tests__/user-avatar-menu.test.tsx src/components/site/__tests__/legal-footer.test.tsx src/components/site/__tests__/lightvela-footer.test.tsx ... -t "feedback|用户反馈|产品反馈|..."`
- `git diff --check`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`

## risks
- 生产 ticket app 目前仓库只看到 beijing-sandbox overlay；sgprod/shprod 若要正式部署仍需补 Argo app、镜像 tag、MySQL DSN secret 和 `SUPPORT_AGENT_IDS`。
- MySQL 存附件会增加 binlog/备份体积；已用 50MB/100MB/5 个限制控制。
- 未做历史 COS 数据迁移，旧记录不自动出现在新 dashboard。
- 当前主线 ticket release contract 已被 !2093/!2094 临时下线；不要未经后端 owner 确认直接恢复。
- 当前本机没有 Docker/nerdctl/finch，不能本机构建并推送 ticket 镜像。

## validation
- 运行 ticket Go 测试、i18n check、support 路由/本地化测试、入口相关测试。
- gateway-dashboard 聚焦 proxy 测试需注意仓库当前 node_modules 缺 `zod` 时全量脚本会被无关测试阻断。

## decisions
- 选择 MySQL 存主记录与附件：符合 mono2 业务主数据存储习惯，并满足“放一起”的产品诉求。
- 不复用 `ticket` 主表硬塞问卷字段：问卷字段结构与工单状态机不同，独立 `support_feedback` 更清晰。
- 保留腾讯问卷入口：旧“产品反馈”继续指向 `PRODUCT_FEEDBACK_URL=https://wj.qq.com/s2/27184784/6d06/`。
- 新站内问卷入口命名为“用户反馈”，从用户头像菜单进入 `/support`。
- 不把首页 Company footer 新增为本次交付入口；此前新增的静态首页 Company `/support` 项已撤掉。

## scan_scope
- `ticket/`
- `frontend/src/app/(site)/support`
- `frontend/src/app/(site)/[lang]`
- `frontend/next-site/support-page.tsx`
- `frontend/src/lib/support-feedback-cos-client.ts`
- `frontend/src/components/site/user-avatar-menu.tsx`
- `frontend/src/constants/product-feedback.ts`
- `gateway-dashboard/src/app/(dashboard)/feedback/page.tsx`
- `argocd/services/service-gateway/{sgprod,shprod}/config.yaml`

## handoff
- 代码层已切到 MySQL 存储；独立交接分支 `codex/support-feedback-mysql-redeploy` 仅包含问卷相关改动，不包含首页、自动化卡片或图片资产变更。
- 前端第一层验收已由用户确认 OK。
- 下一步由后端/发布同学完成北京测试环境临时发布：
  1. 在有 Docker/TCR 权限的 DevCloud 或构建机上构建并推送 `ticket/Dockerfile`：
     `lightclaw-bj8.tencentcloudcr.com/lightclaw/ticket:<test-tag>`。
  2. 将 `argocd/services/ticket/beijing-sandbox/ticket-platform.env` 的 `TICKET_IMAGE` pin 到该测试镜像。
  3. 使用同一镜像执行 `ticket-migrate up`，读取 `ticket-runtime-secrets` 中的 `TICKET_MYSQL_DSN`。
  4. 确认北京测试 `service-gateway` 已有 `/support/feedback/*` 路由到 `ticket.ticket.svc.cluster.local`。
  5. 等 ticket Pod Ready 后，用户直接打开北京测试环境 `/support/` 提交带附件反馈，再在 gateway-dashboard「用户反馈」后台检查记录和附件下载。

## stage
独立分支提交与 push 交接；不是部署完成。

## verified
- 2026-09-28 独立副本：ticket Go test / go vet 通过。
- 前端问卷、入口、API base、OAuth 聚焦测试：5 文件通过，113 测试通过，1 跳过；i18n check 通过。
- staged diff check、变更影响文档门禁、documentation 检查通过；首页路径在提交清单中为零。

## unverified
- 独立副本 frontend typecheck 仍有 23 个基线外诊断，均位于借用的 velachat 依赖源码；前端完整 build 因跨目录 node_modules 链接导致 Turbopack 无法解析 workspace root 而失败。需 CI 使用当前 lockfile 安装依赖后重跑，不标记为全量验证通过。
- gateway-dashboard 未安装完整依赖：eslint/tsc 不可用，测试 12 通过、1 因缺少 zod 失败。
- 镜像发布、数据库 migration 和提交到后台的线上闭环仍由后端完成。

## discard
- 原混合工作区的首页、自动化卡片、图片改动不纳入此次交接。

## restore
- 独立副本基于本地已获取的 master `d7ccdbd04`；原工作区保持原状。

## next_action
- 后端接手分支后先在完整依赖的 CI 跑门禁，再按上述北京测试步骤部署与验收。
