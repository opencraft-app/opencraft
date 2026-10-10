---
id: opencraft-collaboration-load-failed-2026-10-04
type: task
scope: 只读定位 OpenCraft 协作页面 Load failed。
triggers: ["OpenCraft 协作 Load failed"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/plugins/lightvela-collaboration/src
  - opencraft/plugins/lightvela-platform/src/account/lightvela-account-service.ts
status: active
reviewed_at: 2026-10-04
review_due: 2027-01-04
revision: 0.1.0
precedence: task
derived: false
---

## goal
解释协作页面加载失败的请求边界与恢复缺陷。

## non_goals
- 不修改行为、登录状态、生产配置，不重启预览，不提交或发布。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户询问“协作为什么：Load failed”，进一步确认位置为“协作”；尚未提供截图。

## interface_refs / data_structure_refs
- CollaborationClient：`/v1/collaboration/servers`、`/me`、`/me/im/session`。
- AccountService：共享账户 authority 的 requestRaw/requestJson，默认国内/国际 API。
- WorkspaceService.load：并行列表、个人资料和 IM 连接，统一失败快照。
- MessagingService.connect：缓存连接 Promise，当前失败后不清空。
- service-gateway/internal/gateway/server.go：collaborationRoute 的路由、鉴权及 CORS。

## history_context
- current_design_refs：`opencraft/docs/platform-architecture.md` 的账户/扩展边界。
- relevant_evolution：2026-09-22 collaboration-local-e2e Task Pack 使用显式北京入口验证；该历史文档的发布状态不作为当前线上事实。
- superseded_refs：Hermes 生成翻译里的 Load failed 不是本协作插件的错误来源。

## acceptance
- 从当前产物与无凭据 HTTP 检查定位失败，不把服务健康当成协作链路成功。

## affected_paths
- 本 Task Pack 和 checkpoint；无业务源码修改。

## required_context
- service-collaboration；OpenCraft maintenance。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md、opencraft/AGENTS.md | 仓库与维护边界 | 只读调查，不发布 |
| opencraft/.agents/skills/opencraft-maintenance/SKILL.md | 实际链路及 owner 核验 | 区分应用服务和协作请求 |
| docs/context/project/services/collaboration.md、collaboration/AGENTS.md | 路由结果 | 身份与 IM 权威 |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md | 检查翻译邻居 | 排除生成翻译误定位 |
| opencraft/plugins/lightvela-collaboration/README.md | 产品边界 | 请求真源定位 |
| docs/context/tasks/2026-09-22-collaboration-local-e2e/task_context.md | 北京入口历史 | 不盲目切换全局 API |
| opencraft/docs/platform-architecture.md 账户/扩展章节 | 当前设计边界 | 单账户 authority |

## evidence
- 2026-10-04 02:47–02:50 UTC，无凭据实测国内 `api.lightvela.com/v1/collaboration/servers` GET 和 OPTIONS 均 404，正文 route_not_found；无 Access-Control-Allow-Origin。
- 国际 `api.lightvela.ai` 同一 OPTIONS 404；未测试国际带凭据 GET。
- 国内 `/auth/session` 对 `https://chat.lightvela.com` 的 OPTIONS 204 且正确 CORS；不是全域网络不可达。
- 北京 `lightclaw.tech` 同一 GET 401 unauthorized，证明路由存在但未证明鉴权后业务可用。
- 北京对 localhost:5173 的 OPTIONS 204 且允许凭据/Origin；对 chat.lightvela.com 和 join.devcloud.woa.com 204 但无 Allow-Origin，不能仅替换域名就宣称可用。
- 当前预览 local-edge-cfe65f910d12 产物包含默认 cn/intl API 和 CollaborationClient 前缀；主入口 module.a() 未传 API override，源码入口保持同一账户 authority。
- WorkspaceService 直接显示 Error.message；MessagingService 缓存 rejected connectOperation，后续 load 仍可能复用失败连接。
- 本机 __opencraft_health ok；近期真实 WebSocket 重连及 thread/resume 成功。02:36–02:39 的快速连接失败与 UI smoke 时间重合，不能归因用户。
- 浏览器工具无用户 tabs，无法确认用户本次具体请求或存储 region；这是诊断证据限制。

## risks
- 本次实时复现了接口/CORS 阻断，但未捕获用户浏览器事件，不排除叠加移动网络因素。
- 不通过插件第二 token store 或全局切换账户 API 绕过路由责任；北京入口 CORS 也需明确配置。

## validation
- curl 无凭据 GET/OPTIONS、当前运行静态产物与源码读取；无实现改动，无构建或端到端登录测试。

## decisions
- 先报告默认公共入口缺少协作路由及跨域响应，再单独处理错误呈现与失败连接重试；需要用户另行批准实现/发布。

## scan_scope
- 协作插件、账户 requestRaw、Web bootstrap、公共网关 route/config 与历史 task。

## scan_output
- 有界查询未发现 Web panels/components 的独立协作入口；扩至 plugins 后命中 lightvela-collaboration。
- 猜测的 adjacency/service-collaboration.md 和部分 .tsx/config 文件不存在；随后按 rg --files 和实际 .ts 入口核验。
- 未读取或输出账户凭据。

## handoff
- 只读原因定位完成；未改业务代码，未重启。准确用户客户端请求仍待截图或浏览器网络证据。
