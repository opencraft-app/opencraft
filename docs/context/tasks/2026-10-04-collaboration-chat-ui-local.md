---
id: collaboration-chat-ui-local-2026-10-04
type: task
scope: 完成本地 OpenCraft Collaboration 从空 Server 到默认 Channel IM 聊天的可用路径并验证。
triggers: ["collaboration chat local UI"]
owner: wisp/mono2-maintainers
authority: primary
status: active
reviewed_at: 2026-10-04
review_due: 2026-11-04
revision: 1.0.0
precedence: task
---

## goal

在本地 OpenCraft Collaboration 界面中，让没有 Server 的已登录用户能够创建 Server、
进入默认 Channel，并通过独立的腾讯 IM 聊天界面收发消息；以真实本地客户端路径验收。

## non_goals

- 不把 IM 消息写入 Codex Conversation/Thread/Activity，也不建立第二套聊天库。
- 不迁入 Tasks/Reminders，不默认开放 Computer，不更改登录 authority。
- 不操作 GitOps、生产发布或云资源；真实测试数据创建须得到用户确认。

## requirement_ids / requirement_refs / requirement_excerpt

- 本任务目标：“验证聊天，完成界面。”
- 近期约束：“我们只讨论本地，你那本地验证下。”
- 已有产品决定：IM 群聊/私聊是同一体验，和 Codex 会话 ChatUI 分明；Computer 默认隐藏。

## interface_refs / data_structure_refs

- `collaboration/platform/v1/openapi.yaml` 的 `createServer`（201/202）和 `listChannels`。
- `opencraft/plugins/lightvela-collaboration/src/collaboration-client.ts` 的共享账户请求端口。
- `CollaborationWorkspaceService`、`ImDirectoryService`、`ImChatService` 和 Workspace route。
- 服务创建 Server 时同时持久化默认 `#全员` Channel；仅 `imState=ready` 时允许聊天。
- 新增兼容的 `getHumanProfile`：委托身份不要求邮箱；旧邮箱 Account 契约不变。

## history_context

- `current_design_refs`: `opencraft/docs/platform-architecture.md`、
  `opencraft/docs/plugin-architecture.md`、`opencraft/design/invariants.md`、
  `docs/engineering/domains/agent-gateway-runtime.md`。
- `relevant_evolution`: 本地 Web 入口已接线 API Base/Region；当前真实账户页面进入
  “还没有 Server”的空状态，插件已有 IM service 和群聊/私聊路由，但无创建 Server 界面。
- `superseded_refs`: 无。

## acceptance

- 空状态提供清晰的 Server 创建流程，不要求用户先操作 API。
- 创建成功或异步受理均给出诚实状态；默认 Channel ready 后可以在界面打开。
- 群聊发送、历史恢复和至少一次独立接收路径由本地客户端证据证明；若缺第二账号或授权，
  明确标记未验收，不以 mock 替代。
- IM 与 Codex ChatUI 状态隔离；Computer 仍默认隐藏。

## affected_paths

- `opencraft/plugins/lightvela-collaboration/src/` 及相邻测试、样式。
- `opencraft/tests/headless-server.test.mjs`：只修正完整门禁中服务器关闭诊断的事件等待。
- `collaboration/platform/v1/openapi.yaml`、HTTP DTO/接线和生成物：新增 HumanProfile；
  `shared/vela-chat-client-core` 及 OpenCraft 生成快照、Gateway 精确路径。
- 本 Task Pack；必要的正式设计文档。

## required_context

- `agent-gateway-runtime`、`frontend-product-surface`、`service-collaboration`、
  `site-environment-routing`、`upstream-subtrees`、`service-opencraft`。
- `opencraft/AGENTS.md`、`collaboration/AGENTS.md`。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md`, `opencraft/AGENTS.md`, `collaboration/AGENTS.md` | 根与服务约束 | 授权、TDD、界面验收边界 |
| `docs/context/domains/agent-gateway-runtime.md` | 路由结果 | 区分网关与插件责任 |
| `docs/context/project/services/frontend.md` | 路由结果 | 避免误改独立站点前端 |
| `docs/context/project/services/collaboration.md` | 路由结果 | 后台/IM 数据权威 |
| `docs/context/domains/site-environment-routing.md` | 路由结果 | 本地预览不能冒充双站发布 |
| `docs/context/project/upstream-subtrees.md` | 路由结果 | mono2 单一写入源 |
| `docs/context/project/services/opencraft.md` | 路由结果 | OpenCraft 插件与 Web 边界 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | UI 维护方法 | 真实页面与生命周期验收 |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md` | 验证清单 | 聚焦测试与客户端证据 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | 邻接卡 | 证实该卡针对独立 `frontend/`，本任务改 OpenCraft 插件 |
| `collaboration/docs/README.md`、`docs/context/project/adjacency/argocd-ci-secrets.md` | 后台诊断 | 只读目标集群和现有 Secret 引用，不持久化凭据 |

## evidence

- 初始 IAB 本地页 `localhost:10000` 刷新后显示已登录账户和“还没有 Server”。
- `createServer` 契约存在，Server 后端会创建默认根 Channel。
- 本地真实工作台显示创建表单；独立 fixture 在浏览器走通空状态创建、默认 Channel、
  群聊/私聊发送、更早消息加载与实时接收；切到私聊后频道消息不串入。
  这些是 mock IM，不冒充腾讯 IM 实投递。
- RED→GREEN 回归证实初始历史页晚到曾覆盖已收到的新消息；当前按会话合并历史与
  实时快照，聚焦 IM 测试通过。该修复后完整 `npm run gate` 再次顺序通过。
- RED→GREEN 回归证实发送回执丢失后再次点击曾生成新请求 ID。当前保存原 ID 并先
  对账，界面显示“确认状态”；隔离预览完成未知结果→确认→单条消息的可见流程。
  该修复后插件 65/65、扩展测试与完整 `npm run gate` 顺序通过。
- 过期登录曾因独立 Web Region 误触嵌入 Host 同步预检而进入错误边界；修正后真实
  本地页面显示“登录后开始协作”和重试入口。
- 经用户授权，已通过北京公开注册接口创建两个仅供验收的 LightVela 账户：
  `usr_97ebf1fd9a58e87873557b65`（发送端）与
  `usr_362bc08d6af36d8e0742d51b`（接收端）。两个浏览器分别恢复各自会话；
  未记录或提交密码、Session Token。
- 发送端通过真实本地界面创建测试 Server
  `01a10471-6699-7208-843f-2c6b5afae007`。刷新后全员频道仍为“准备中”且不可发送；
  接收端仍无 Server。因而尚未证明真实腾讯 IM 收发。现场还发现北京
  `/v1/collaboration/me` 返回 HTTP 200 加 `internal_error` 错误对象，使旧 UI 错把错误当
  当前账户。只读后台与精确分区 SQL 已确认 JIT actor 邮箱为空；oapi runtime Email 编码器
  拒绝空邮箱，生成处理器先写 200 后编码失败。HTTP 回归在本地复现相同响应。
- 通过云 API 在内存获取现有 `tke-bj8` kubeconfig，解决旧地址失效；实际 Pod 使用
  `sha256:7959d9d5f0fa27a9fe77ed1f4c37c930aafbeff46946231ec8a37661f4d965e4`。
  Server 与 Owner 已 ready；根 Channel 已 error，其 `im.topic.ensure` operation
  `01a10471-6699-7211-b566-8ec8ae893f36` 一次执行失败于 `tencent_11000`。
  只读腾讯 API 确认 Community 存在；已发布源码创建时设置 `SupportTopic=1`，需继续核对
  应用社群/话题开关。控制台未登录，不改套餐或购买资源。
- RED→GREEN 新增 `/me/profile`/HumanProfile 与 Gateway 路由，旧 Account 邮箱格式保持；
  兼容性门禁通过。旧 /me 在编码前返回错误，避免假 200。客户端改读 profile，根 Channel
  error 在界面呈现“聊天初始化失败”。全量 Go test/vet/race、生成物、OpenAPI 兼容、
  SQLite/TDSQL/MySQL 迁移锁/生成校验和秘密扫描通过；client-core 77 项测试、类型检查、
  构建与 OpenCraft 全量 gate 通过。
- 本地代码已用 RED→GREEN 补齐公开 Gateway 的邀请创建、加入链接和操作状态精确路径，
  以及 Workspace 的一次性邀请、空 Server 加入入口和同键重试。对账户和 IM session
  及邀请结果的 200 错误对象增加结构校验，避免显示假登录态、假邀请或把错误交给 IM SDK。
  隔离浏览器预览已验证输入邀请令牌→进入 Server、Owner 生成一次性令牌；发布前进入 MR 审查。
- `npm test --workspace @opencraft/plugin-lightvela-collaboration`：63/63 通过；
  `npm run test:extensions`、`npm run test:web-release`、插件/Web typecheck、
  `npm run check:boundaries`、`npm run build:web` 与文档影响/完整性检查通过。
- `npm run gate` 完整顺序运行通过。先前 PTY 失败来自隔离工作树中被 Git 忽略的
  `node-pty` helper 缺执行权限，DSH 失败来自该工作树未安装的子运行时依赖；
  两者仅修本地依赖安装。另有 headless-server 测试提前断言服务端关闭诊断，已用
  事件驱动等待修复，无生产代码变化。
- 新增邀请与伪成功响应回归：插件 71/71、Gateway 包 210/210、Gateway 模块
  215/215 及其 race 检查通过；最终 OpenCraft 全量 gate、文档系统、docs-impact
  和差异空白检查通过。

## risks

- 202 受理后 IM Community/Topic 可能仍 provisioning；UI 不得提前允许发送。
- 模糊请求失败时不可盲目使用新 Idempotency-Key 重试，避免重复 Server。
- 已授权的真实聊天验证留下两个测试账户及一个测试 Server，尚无真实消息；
  不应以页面可见代替腾讯 IM 双端投递证明。
- 北京 `GET /me` 的 200 错误对象与全员频道持续准备中是当前真实验收阻塞；
  后台修复已在本地完成，尚未发布；频道实际已失败，需要解决 IM 话题能力。

## validation

- RED→GREEN 的插件客户端、Workspace、IM 导航聚焦测试。
- 插件和 Web typecheck、相关扩展测试、Web 构建、文档/影响检查。
- 本地预览真实 DOM 与 IM 链路；待初始化状态和邀请路径可用后做真实持久化聊天。

## decisions

- 复用当前 trusted extension、共享账户和腾讯 IM port；不复制聊天服务。
- 视觉方向为克制的工作区式 IM：频道目录、消息区和空状态清楚分层，沿用 OpenCraft 语义 token。

## scan_scope

- `opencraft/plugins/lightvela-collaboration/src/`、
  `opencraft/tests/*collaboration*`、相关 OpenAPI operation。

## scan_output

- 有界源码及测试检索；无外部扫描产物。

## handoff

- 当前：客户端、服务和界面实现及完整 gate、文档门禁、浏览器 mock 流程通过；
  北京两个独立测试账户及一个测试 Server 已创建。Server 与 Owner IM 已 ready，根频道
  因 `tencent_11000` 失败，尚未发送真实消息。空邮箱响应的根因和精确失败操作已取得。
  本地兼容的 HumanProfile、Gateway 接线和插件消费路径通过回归与兼容性门禁。
- 下一步：合入并发布后台/Gateway 修复；控制台登录后核对 AgentNetwork 社群话题配置，
  然后通过正常业务流程重试/新建测试 Server，验证真实腾讯 IM 发送、历史恢复和独立接收。

## stage

本地界面与完整代码门禁已完成；北京测试账号与 Server 已就绪，真实 IM 双端验收
后台契约修复及前端入会入口已实现，待合入发布；真实 IM 验收仍受社群话题能力影响。

## verified

- 工作树 `fix/collaboration-local-web-base` 的修复已完成本地验证；源码合入和发布状态
  分别由 MR 与 GitOps/运行时证据确认。
- `npm run gate`、文档影响/完整性与差异检查通过。
- 本地 mock 浏览器路径覆盖空 Server 创建、默认频道、群聊/私聊发送和历史翻页。
- 本地 mock 浏览器还覆盖实时接收与 Channel/Direct 视图隔离；真实腾讯 IM
  双端收发仍未验收。
- 本地 mock 浏览器还覆盖发送结果不确定时沿原请求对账且不重复发消息。
- 当前完整 `npm run gate` 在接收竞态和发送对账两轮修复后均有成功退出证据。

## unverified

- 当前短期测试登录已过期；未在真实腾讯 IM 中创建 Server、发送或由第二客户端接收。
- 用户尚未答复是否允许在目标账户留下测试 Server 和消息。
- 独立接收验收还需要第二个获授权的 LightVela 身份；复用同一 IM 用户的两个窗口
  不能替代跨成员聊天验证。

## discard

- 先前完整 gate 的 PTY 与 DSH 失败已由当前隔离工作树的本地依赖状态修复，不是源码缺陷。
- headless-server 的提前断言已由事件等待测试替代。

## restore

- 继续使用当前 mono2 隔离工作树，不在旧 chatserver 快照或 GitHub 镜像双写。
- 不输出或持久化登录令牌；真实业务写入需先获得用户对此次测试数据的选择。

## next_action

收到测试数据与第二身份的授权后，续上短期账户会话，经本地 `localhost:10000`
创建专用测试 Server，确认默认频道就绪，再用两个独立授权身份验证发送、接收和
刷新后历史。
