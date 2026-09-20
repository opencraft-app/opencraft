---
id: global-multi-bot-rollout-20260920
type: task
scope: 将现有国内站多 Bot 产品能力完整开放到国际站。
triggers:
  - 国际站多 Bot
  - global multi-bot
  - sgprod Bot routes
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - frontend/src/contexts/runtime-config-context.tsx
  - frontend/src/repositories/http-repositories.ts
  - argocd/services/ctl/sgprod/ctl-platform.env
  - argocd/services/service-gateway/sgprod/config.yaml
status: active
reviewed_at: 2026-09-20
review_due: 2026-12-19
revision: 1.0.0
precedence: task
derived: false
---

## goal

国际站复用国内站当前的多 Bot 列表、创建/克隆、切换、重命名、删除、失败修复、唯一通道绑定，以及按 Bot Profile 隔离的设置、Skills、Memory、自动任务等能力；额外 Bot 创建入口默认隐藏，仅由浏览器控制台 `show()` 揭示。

## non_goals

- 不改变套餐 5/10 个 Bot 的前端软限制及计费语义。
- 不改变 CTL Bot/Profile 数据模型、创建/克隆/删除契约或实名与归属校验。
- 不在本任务中执行 MR 合并、GitOps promote、Argo sync 或生产写操作。

## requirement_ids / requirement_refs / requirement_excerpt

- 用户请求（2026-09-20）：`把现在国内站的多bot相关的功能，之前没有在国际站上线，这次上线到国际站吧`。
- 用户补充（2026-09-20）：`国际站还是先隐藏入口吧，需要在浏览器f12里面show()的时候，才出现新建bot的入口。`

## interface_refs / data_structure_refs

- `RuntimeFeatureFlags.multiBotEnabled`：双站统一消费，显式 `false` 继续作为紧急回滚开关。
- `ctl-api` 从 `ctl-platform-values.MULTI_BOT_ENABLED` 可选注入；`sgprod` 显式设为 `true`，可通过 GitOps 独立切换为 `false`。
- `GET/POST /v1/instances/{instance_id}/bots`：列表及创建/克隆。
- `PUT/DELETE /v1/instances/{instance_id}/bots/{bot_id}`：重命名及删除。
- `POST /v1/instances/{instance_id}/bots/{bot_id}/retry`：失败 Bot 修复。
- `PUT/POST/DELETE /v1/instances/{instance_id}/bots/{bot_id}/channel-bindings/{channel}`：唯一通道占用、确认及释放。
- 后端返回的 `instance_id`、`bot_id`、`profile_id` 三元组必须保持不变；Profile 级功能继续使用真实 `profile_id`。

## history_context

- `current_design_refs`：`docs/engineering/domains/site-environment-routing.md`、`docs/engineering/domains/agent-gateway-runtime.md`。
- `relevant_evolution`：MR !3863 将首次 Agent 创建与额外 Bot 创建分开；MR !4037/!4038 已向国际站放行 Bot CRUD，但前端仍按区域降级且 retry/通道绑定仍未开放。
- `superseded_refs`：`docs/context/tasks/2026-09-15-sgprod-bot-routes.md` 中“国际站只开放 CRUD”的阶段性边界。

## acceptance

- 国内和国际构建下，`multiBotEnabled=true` 都使用真实多 Bot；国内站默认展示额外 Bot 创建入口，国际站仅在 `show()` 后展示。显式 `false` 都关闭额外 Bot 能力但不阻断首次 Agent 创建。
- 国际构建读取 `/bots`，创建额外 Bot 时使用嵌套 Bot API，重命名/删除/修复/唯一通道绑定与国内站使用相同路径。
- sgprod 只新增 retry 与三条 channel-bindings 精确路由，继续保留 authenticated、require_realname 和 CTL 归属校验。
- 双区域聚焦前端测试、service-gateway 路由测试、前端 `pnpm check`、国际站构建、文档与 change-impact 门禁通过。

## affected_paths

- `frontend/src/contexts/runtime-config-context.tsx`
- `frontend/src/contexts/__tests__/runtime-config-context.test.ts`
- `frontend/src/repositories/http-repositories.ts`
- `frontend/src/repositories/__tests__/http-repositories.test.ts`
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.ts`
- `frontend/src/pages/marketing/__tests__/agent-diagnostics-multi-bot.test.tsx`
- `ctl/k8s/base/manifests.yaml`
- `argocd/services/ctl/sgprod/README.md`
- `argocd/services/ctl/sgprod/ctl-platform.env`
- `.ci/runtime/tests/contract_tests/test_release_bundle_contracts.py`
- `opencraft/scripts/sync-mono2-agent-console.mjs`
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/**`（机械生成闭包）
- `argocd/services/service-gateway/sgprod/config.yaml`
- `service-gateway/internal/gateway/config_policy_test.go`
- `service-gateway/internal/gateway/sgprod_bots_config_test.go`
- `docs/engineering/domains/site-environment-routing.md`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context

- `site-environment-routing`
- `agent-gateway-runtime`
- `service-service-gateway`
- `service-frontend`
- `identity-access`
- `release-gitops`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/site-environment-routing.md@92edd0f0f` | 双站区域边界 | 不把单站验证当作双站证据 |
| `docs/context/domains/agent-gateway-runtime.md@92edd0f0f` | Bot 公共路由边界 | 保持 CTL 与 gateway 责任分层 |
| `docs/context/domains/identity-access.md@92edd0f0f` | 网关实名/鉴权 | 新路由沿用既有策略 |
| `docs/context/domains/release-gitops.md@92edd0f0f` | 生产发布边界 | 源码完成不等于生产上线 |
| `docs/context/project/services/frontend.md@92edd0f0f` | 前端服务约束 | 双站共用实现并验证 |
| `docs/context/project/services/service-gateway.md@92edd0f0f` | 公共网关约束 | 覆盖成功与拒绝传播 |
| `frontend/AGENTS.md@92edd0f0f` | 最近服务规则 | 执行 check/test/build 门禁 |
| `frontend/DESIGN.md@92edd0f0f` | 前端交互规范 | 保留现有入口和 Tooltip 交互 |
| `service-gateway/AGENTS.md@92edd0f0f` | 发布与配置真源 | 不把源码配置视为线上状态 |
| `ctl/AGENTS.md@92edd0f0f` | 上游契约边界 | 不修改 CTL 数据模型 |
| `.ci/AGENTS.md@92edd0f0f` | 发布契约测试规则 | 为平台值注入增加结构化回归测试 |
| `opencraft/AGENTS.md@92edd0f0f` | OpenCraft 生成物边界 | 禁止手改 vendored 闭包，使用同步脚本 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@92edd0f0f` | OpenCraft 维护流程 | 源码与机械生成物分提交并执行闭包检查 |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md@92edd0f0f` | OpenCraft 验证矩阵 | 运行 Bot 与扩展测试 |
| `opencraft/MONO2_MIGRATION.md@92edd0f0f` | mono2 vendoring 谱系 | 保持 `sourceRevision` 和源提交一致 |
| `docs/context/project/upstream-subtrees.md@92edd0f0f` | 上游同步约束 | 确认生成闭包的权威边界 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@92edd0f0f` | 配置与测试邻接 | 同步运行时配置测试 |
| `docs/context/project/adjacency/argocd-ci-secrets.md@92edd0f0f` | GitOps 邻接 | 只改非敏感配置并验证 manifest |

## evidence

- 前端聚焦测试：国内与国际构建各 4 个文件、151/151 通过，覆盖运行时开关、真实 `/bots` 列表/创建/删除/修复/唯一通道路径、首次创建权限以及国内/国际 Skills Profile 命令。
- 国际侧栏入口与套餐限制专项：2/2 通过（同文件其余 7 项按筛选跳过）。
- 国际站创建入口补充验证：动态测试确认默认不可见、执行 `show()` 后可用；源码守卫确认国内默认可见且国际复用现有隐藏工具状态，2/2 通过。
- `pnpm check` 通过：i18n 0 错误，TypeScript 0 个新增诊断。
- `pnpm build:global` 通过，静态生成 649/649；`pnpm build:cn` 通过，静态生成 103/103。
- `CGO_ENABLED=0 go test ./... && CGO_ENABLED=0 go vet ./...`（service-gateway）通过；默认 CGO 全量测试在本机 Go 1.26/macOS 链接阶段因缺少 `SecTrustCopyCertificateChain` 失败，聚焦 `./internal/gateway` 默认 CGO 测试通过。
- `CGO_ENABLED=0` 下 CTL Bot API 与 channel-binding 聚焦测试通过。
- `validate_documentation.py --format json`、`validate_change_impact.py --staged` 与 `git diff --cached --check` 通过；context-audit Skill 自测 33/33 通过。
- 仓库全量 context unittest 仍有 4 个与本变更无关的基线失败：历史 Task Pack、指令链体积、catalog 漂移和既有 secret-scan 告警；构建 catalog 产生的派生噪声已还原，未纳入变更。
- 未带区域隔离运行的全量国际 Vitest 触发大量既有国内站专用测试失败并挂住，已停止；不得把该次运行表述为本变更失败或全量通过。
- 入口测试所在动态文件仍有一项既有文案断言失败：测试期待“Skills”，当前源码展示“主 Bot 后续安装的 Skills”；该失败与入口条件无关，本任务未顺带修改。
- CTL 发布契约专项 1/1 通过，确认 `sgprod` 显式启用且 `ctl-api` 通过可选 ConfigMap key 注入 `MULTI_BOT_ENABLED`。
- OpenCraft 官方同步与闭包检查通过：130 个文件，`UPSTREAM.json.sourceRevision=e5b64b0ebdcd95e69728c64640bc1c1cfe9d29c5`。
- OpenCraft `test:bot-management` 32/32 通过；`test:extensions` 主套件 164/164、Collaboration workspace 56/56 通过。

## risks

- 国际 CTL/Hermes 镜像若缺少 Profile 能力，前端会按既有 `/bots` 临时不可用路径回退到根 Bot；发布前仍需真实公共 API 与浏览器回归。
- 新增网关路径若过宽会扩大攻击面；只允许国内站已使用的四条精确 retry/通道绑定 method/path 组合。
- 回滚方式：通过 GitOps 将 `argocd/services/ctl/sgprod/ctl-platform.env` 的 `MULTI_BOT_ENABLED` 改为 `false`，由 `ctl-api` 注入后同时关闭运行时配置与新增 Bot；网关路由可独立撤回新增四项。

## validation

- 前端聚焦测试分别以 `NEXT_PUBLIC_REGION=cn` 和 `NEXT_PUBLIC_REGION=global` 运行。
- `cd frontend && pnpm check && pnpm build:global`。
- `cd service-gateway && go test ./internal/gateway && go vet ./...`。
- CTL Bot API 聚焦测试（证明上游接口仍兼容）。
- CTL sgprod 平台值注入发布契约专项。
- `npm --prefix opencraft run sync:mono2-agent-console && npm --prefix opencraft run check:mono2-agent-console`。
- `npm --prefix opencraft run test:bot-management && npm --prefix opencraft run test:extensions`。
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`。
- `git diff --check`。

## decisions

- 双站共用同一套 Repository 多 Bot 实现，不新增国际站分叉。
- 保留 `multiBotEnabled` 运行时开关作为双站一致的服务端/前端回滚边界。
- `ctl-api` 显式映射可选的 `MULTI_BOT_ENABLED` 平台值，`sgprod` 先设为 `true`，不依赖未接线的远端配置假设。
- OpenCraft 只通过官方生成器同步完整闭包；适配器跟随源组件宽度更新，生成物单独提交并吸收已存在的闭包漂移。
- 国内站额外 Bot 创建入口默认可见；国际站入口复用现有 `show()` 揭示状态，不新增持久化或独立后门。
- Profile/Skills 不复制实现；国际站沿用当前真实 `profile_id` 路由。

## scan_scope

- `frontend/src/contexts`、`frontend/src/repositories`、`frontend/src/pages/marketing`、`service-gateway/internal/gateway`、`argocd/services/service-gateway/{sgprod,shprod}`。

## scan_output

- 有界搜索确认区域分叉集中在 `useMultiBotEnabled`、HTTP Bot Repository 和 sgprod allowlist；Profile 级页面已使用 `activeBot.profileId`。

## handoff

- 交付由 MR !4308 跟踪；CR 修正按源码/配置与机械生成闭包分提交，并保留上述聚焦验证证据。生产发布仍需另行完成 CI/review/合并、GitOps promote、Argo `Synced/Healthy` 和真实国际站回归。
