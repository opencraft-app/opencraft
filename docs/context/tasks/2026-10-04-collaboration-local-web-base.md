---
id: collaboration-local-web-base-2026-10-04
type: task
scope: 修复 LightVela Web 本地预览未消费显式北京 API Base 与 Region。
triggers: ["collaboration local web api base"]
owner: wisp/mono2-maintainers
authority: primary
status: active
reviewed_at: 2026-10-04
review_due: 2026-11-04
revision: 1.0.0
precedence: task
---

## goal

让本地 `dev:lightvela-web` 实际把 `VITE_LIGHTVELA_API_BASE_URL` 与
`VITE_LIGHTVELA_REGION` 传入唯一的 `LightVelaAccountService`，用已授权的国内账户
打开 Collaboration Workspace。

## non_goals

- 不修改北京 Gateway、Auth、Collaboration 后端或生产部署。
- 不增加第二套账号、Session 或 IM 客户端。
- 不创建 Server、Computer 或其他业务数据。

## requirement_ids / requirement_refs / requirement_excerpt

- 用户要求在本地验证协作接口是否仍返回 404。
- 当前源码已有 `resolveLightVelaWebBootstrapOptions`，但 Web 入口调用
  `module.a()` 时未传递其结果。国内 Auth 主机上的协作路径返回 404，
  北京 Gateway 的相同路径已验证存在。

## interface_refs / data_structure_refs

- `opencraft/apps/workbench-web/src/main.tsx`
- `opencraft/apps/workbench-web/src/runtime/lightvela-web-bootstrap.ts`
- `opencraft/apps/workbench-web/src/runtime/appserver-runtime-context.tsx`
- `opencraft/plugins/lightvela-platform/src/account/lightvela-account-service.ts`
- 保持一个应用级 LightVela 账户 authority；未设置预览环境变量时保持既有默认值。

## history_context

- `current_design_refs`: `opencraft/docs/platform-architecture.md`、
  `opencraft/README.md`、`docs/engineering/domains/site-environment-routing.md`。
- `relevant_evolution`: 北京 Collaboration 后台已部署；本地 Web 显式 API Base
  解析器和聚焦测试已存在，入口接线缺失。
- `superseded_refs`: 无。

## acceptance

- 当前 Web 入口传入已校验的 API Base/Region；没有覆盖值时保持默认。
- 聚焦解析测试、Web typecheck 和实际本地预览通过。
- 已授权用户的本地协作请求不再落到国内 Auth 主机的 404 路径。

## affected_paths

- `opencraft/apps/workbench-web/src/main.tsx`
- 本 Task Pack。
- `docs/engineering/domains/agent-gateway-runtime.md`。

## required_context

- `agent-gateway-runtime`、`site-environment-routing`、`upstream-subtrees`、
  `service-opencraft`、`service-collaboration`。

## context_receipt

| 文件 | 用途 |
|---|---|
| `AGENTS.md`, `opencraft/AGENTS.md` | 发布与本地预览边界 |
| `docs/context/domains/agent-gateway-runtime.md` | Gateway 上游归属 |
| `docs/context/domains/site-environment-routing.md` | 国内区域边界 |
| `docs/context/project/upstream-subtrees.md` | mono2 唯一写入真源 |
| `docs/context/project/services/opencraft.md` | Web 服务边界 |
| `docs/context/project/services/collaboration.md` | 协作服务边界 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | 真实预览验收 |

## evidence

- 修复前：本地预览账户已接入，但 Collaboration 显示 `Failed to fetch`；
  `api.lightvela.com/v1/collaboration/me` 返回 404，而北京 Gateway 同一路径
  使用目标用户会话返回 200。
- 修复后：本地预览显示目标用户“虾米老师”和“还没有 Server”；该就绪状态要求
  账户读取、Server 列表和 IM 连接全部完成。Web typecheck 和现有配置解析器聚焦测试通过。

## risks

- Web 入口影响通用 OpenCraft 与 Electron Renderer；没有环境覆盖值时解析器
  返回空选项，按现有默认服务行为运行。

## validation

- `npm run typecheck --workspace @opencraft/workbench-web`
- `npx tsx --test tests/lightvela-web-bootstrap.test.ts`
- 本地 `dev:lightvela-web` 真实页面与请求。
- `git diff --check`，按影响规则运行文档门禁。

## decisions

- 复用既有解析器并在 Web 应用创建边界传递选项，不新增配置层。

## scan_scope

- `opencraft/apps/workbench-web/src/runtime/`、`opencraft/plugins/lightvela-platform/src/account/`。

## scan_output

- 有界源码搜索；无外部扫描产物。

## handoff

- 当前：入口接线与本地会话复验通过；Web typecheck、聚焦测试和 `build:web` 通过。
- 完整 OpenCraft gate 未通过：独立的 `local-agent-host` 进程 RPC 用例报
  `posix_spawnp failed`，单独重跑该用例仍复现；该失败不在本次入口修改路径上，
  不将完整 gate 标为通过。
- 文档影响门禁、文档完整性检查及暂存差异检查通过；本地修复保留在独立工作树，未提交或发布。
