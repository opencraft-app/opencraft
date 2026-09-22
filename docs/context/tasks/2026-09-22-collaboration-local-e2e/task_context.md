---
id: collaboration-local-e2e-2026-09-22
type: task
scope: 修复本地 OpenCraft 复用 LightVela 登录访问北京 Collaboration 的真实端到端链路。
triggers: ["collaboration local e2e", "OpenCraft Collaboration", "localhost CORS"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - service-gateway/internal/gateway
  - opencraft/plugins/lightvela-platform
  - opencraft/apps/workbench-web
status: active
reviewed_at: 2026-09-22
review_due: 2026-12-22
revision: 0.1.0
precedence: task
derived: false
---

## goal

让本地 OpenCraft 使用唯一的 LightVela Account authority，经北京 Service Gateway 正常打开
Collaboration Workspace，不再被内部上游的重复 CORS 或本地启动配置阻断。

## non_goals

- 不新增登录、token store、Human 身份或 Collaboration OpenAPI。
- 不改变腾讯云 IM、Computer、Tasks/Reminders 产品边界。
- 不发布、不修改 GitOps/Secret/数据库或生产资源。

## requirement_ids / requirement_refs / requirement_excerpt

- E2E-01：用户要求“跑一下看看”，真实浏览器复现本地 Collaboration 返回 HTTP 403。
- E2E-02：用户随后要求“继续”，授权修复该真实联调阻塞。
- 外部 TAPD/Issue：unknown。

## interface_refs / data_structure_refs

- `service-gateway/internal/gateway/server.go` 的 Collaboration reverse proxy。
- `opencraft/plugins/lightvela-platform/src/account/lightvela-account-service.ts` 的共享认证请求端口。
- `opencraft/apps/workbench-web/src/runtime/web-workbench-application.ts` 的应用级 account owner。
- 浏览器 CORS 只在公共 Gateway 终止；内部 Collaboration hop 不继承浏览器 Origin。

## history_context

- `current_design_refs`：`docs/engineering/domains/identity-access.md`、
  `opencraft/docs/platform-architecture.md`、`opencraft/design/lightvela-collaboration-workspace.md`。
- `relevant_evolution`：MR !4365/!4369 已发布北京 Gateway route；真实本地页面确认 Gateway
  验证 LightVela 会话后，上游 Collaboration 因只允许 `https://chat.lightvela.com` 而返回 403。
- `superseded_refs`：旧独立 Collaboration 登录与外部 Computer Enrollment 不参与本轮。

## acceptance

- 本地 Origin 经 Gateway 的 Collaboration 请求不把浏览器 Origin 传给内部上游。
- standalone LightVela Web 可启动且可显式配置北京 API Base/国内 region。
- 真实已登录浏览器打开 Collaboration，不出现 HTTP 403；Server 空态或实际数据正常呈现。
- 聚焦 Go/TypeScript 测试、typecheck、LightVela Web build 和 docs/change-impact 通过。

## affected_paths

- `service-gateway/internal/gateway/`
- `opencraft/apps/workbench-web/`
- `opencraft/docs/`
- `docs/engineering/domains/identity-access.md`

## required_context

- `agent-gateway-runtime`
- `identity-access`
- `service-collaboration`
- `opencraft-maintenance`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@81c4ad076` | mono2 写入、Task Pack 与发布边界 | 隔离 worktree、禁止未授权发布 |
| `opencraft/AGENTS.md@81c4ad076` | OpenCraft 本地预览与验证 | 真实 Web QA、独立依赖与产物 |
| `docs/context/domains/agent-gateway-runtime.md@2.1.0` | 公共 Gateway 责任 | CORS 在公网入口终止 |
| `docs/context/domains/identity-access.md@2.0.0` | LightVela 会话权威 | 不新增第二身份/凭据 |
| `docs/context/project/services/collaboration.md@1.0.0` | Collaboration 服务边界 | 只接收已验证 subject |
| `collaboration/AGENTS.md@81c4ad076` | HTTP/身份契约 | 不改 OpenAPI/数据库模型 |
| `collaboration/docs/README.md@81c4ad076` | Gateway token/JIT 映射 | 保留内部 Bearer 投影 |
| `service-gateway/README.md@81c4ad076` | 公共路由权威 | 公网与 upstream 证据分层 |
| `opencraft/docs/platform-architecture.md@81c4ad076` | Account/Extension owner | 单一 AccountService 供 Collaboration 借用 |
| `opencraft/docs/build-matrix.md@81c4ad076` | LightVela Web 验收 | 选择真实产品 build/runtime |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@81c4ad076` | 维护方法 | TDD 与真实页面证据 |
| `docs/context/project/adjacency/argocd-ci-secrets.md@1.0.0` | 发布邻接 | 本轮不读取/修改 Secret 与 GitOps |

## evidence

- 2026-09-22 真实 Chrome QA：现有 LightVela 会话可访问 profile/实例，打开 Collaboration 后
  `/v1/collaboration/me`、`/servers`、`/me/im/session` 均由 Gateway 记录为 403。
- 北京 live Gateway 已验证对应请求具有 `route_name=collaboration`；Collaboration Deployment
  只配置 `--cors-origin https://chat.lightvela.com`。
- Gateway RED：`TestCollaborationRouteUsesVerifiedHumanAndInternalBearer` 观察到 upstream Origin
  为 `http://127.0.0.1:10000` 并失败；GREEN 后 Gateway 聚焦 5 项、全量 197 项与 vet 通过。
- OpenCraft RED/GREEN：显式北京 account authority、非法 region/API authority 和 standalone
  `process.env` 兼容共 5 项通过；Workbench typecheck 与账户/Collaboration 聚焦 15 项通过。
- `VITE_LIGHTVELA_API_BASE_URL=https://lightclaw.tech VITE_LIGHTVELA_REGION=cn`
  的 `build:lightvela-web` 与 179 个产品边界 artifact 检查通过。
- OpenCraft `test:web-release` 9 项与通用 `build:web` 通过。完整 `npm run gate` 已通过边界检查、
  全 workspace typecheck 和前序测试，但在未修改的 `local-agent-host.test.ts` 用例
  `process RPC survives WebSocket replacement without contacting the Agent harness` 因
  `posix_spawnp failed` 停止；该用例独立复验仍失败，未冒充完整 gate 通过。
- 最新 master 真实 Chrome：standalone Workbench 正常启动、现有 LightVela 账号恢复且
  Collaboration 请求到达北京 route；当前 live Gateway 尚未包含本分支修复，因此仍返回预期的 403。
- docs-impact 通过，命中 `identity-access` 与 `agent-gateway-runtime`，均需 Owner review。
- 受影响文件限定凭证扫描与 `git diff --check` 通过；全仓扫描命中仓库既有 base64 SVG/ref 私钥 fixture，
  因此仅记录限定范围结果。

## risks

- 去除内部 hop Origin 必须仅限 Collaboration reverse proxy，不能放松其他公网路由。
- API Base 配置必须是应用级 Account owner 输入，不能由 Collaboration 插件建立第二客户端。
- 本地修复不能被描述为已发布；发布后仍需 Argo 与真实账号复验。

## validation

- RED/GREEN：Service Gateway Collaboration route tests。
- OpenCraft account/Collaboration tests与 `@opencraft/workbench-web` typecheck。
- `npm run build:lightvela-web` 与真实本地浏览器 QA。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`。

## decisions

- Gateway 是唯一公共 CORS authority；内部 Collaboration hop 删除浏览器 Origin。
- LightVela API Base/region 通过 Web application bootstrap 配置同一个 AccountService。
- standalone Web 的 Node env 兼容在 Vite/build 边界解决，不编辑机械生成的 Hermes upstream。

## scan_scope

- 上述 affected paths 与对应聚焦测试；不扫描或输出 Secret payload。

## scan_output

- 仅在本 Task Pack 记录命令摘要，不保存真实账户标识、token 或服务日志原文。

## handoff

- 源码和本地验证完成；尚未提交、推送、创建 MR 或发布。真实成功态必须在 Gateway 新镜像完成
  GitOps/Argo 收敛后，用同一已登录本地 OpenCraft 输入序列复验 Server/IM session。
