---
id: task-2026-10-04-opencraft-loading-performance
type: task
scope: 主站嵌入 OpenCraft 启动调度、资源缓存、可选扩展及长等待诊断。
triggers: ["embedded startup", "opencraft loading performance"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - frontend/src/pages/marketing/opencraft-embedded-workbench.tsx
  - opencraft/apps/workbench-web/src/browser/web-host-proxy-broker.ts
  - opencraft/docs/platform-architecture.md
status: active
reviewed_at: 2026-10-04
review_due: 2026-11-04
revision: 1.0.0
precedence: task
derived: false
---

# OpenCraft 线上加载性能、启动优化与稳定性诊断

## goal
定位并实施 `https://lightvela.com/agents/chat` 嵌入启动优化第一批：主体资源与 Bot 发现并行、聊天不等待可选代理、内容哈希资源长期缓存。独立站只作对照。
第二批按最新授权移出可选扩展的首屏等待，并先定位超过40秒未就绪的阻塞阶段；Host修复不在这次“先查”的实施范围。

## non_goals
- 最新用户已授权提交、推送并通过 MR 合入 master；不发布、不替换生产，不改 CTL、账户模型。第二批只调整已授权的可选呈现扩展启动调度，不重构通用扩展协议。
- 不发送模型消息、不创建 Bot、不输出账户凭据或会话内容。

## requirement_ids / requirement_refs / requirement_excerpt
- requirement_ids：OPT-010；TAPD 卡片 `1070234090138752342`。
- 当前用户请求：检查 OpenCraft 加载慢；允许使用指定账户登录复现。
- 当前实施授权：主体资源与 /bots 并行、单一 Application；修正 SW 等待、聊天独立就绪；哈希资源长期缓存、入口/版本文件可更新。
- 当前测量授权：“三项一起生效后的完整新版耗时测一下”；构建隔离全量前端产物并测量，不包含发布授权。
- 第二批授权：用户指定“可选扩展退出首屏关键路径”及“先查超过40秒未就绪”。仅实施扩展/面板初始化调度并诊断启动失败；不实施 /bots 批量化、账户身份模型重构或生产发布。

## history_context
- current_design_refs：`opencraft/docs/platform-architecture.md` 的 Embedded Workbench Shell；`opencraft/docs/browser-workbench-architecture.md` 的 Web 页面/Host 边界；`docs/engineering/domains/agent-gateway-runtime.md`。
- relevant_evolution：现有迁移 Surface 在 enable + prepare/show 成功后才接管，hide 不销毁 Application；本轮只提前共享资源准备，不提前该权限/身份边界。10 月 4 日线上隔离浏览器证据确认 SW 的 document.ready 与窄 scope 不匹配。
- superseded_refs：诊断中禁用 SW 和硬编码瀑布 chunk 的 A/B 只作有界取证，不作为实施方案。

## interface_refs / data_structure_refs
- `opencraft/apps/workbench-web/src/`：启动与 Shell 初始化。
- `opencraft/plugins/lightvela-platform/src/account/lightvela-account-service.ts`：认证与资源发现。
- `user/auth/internal/httpapi/admin.go`：受审计代登录接口；凭据仅在诊断进程内存中流转。

## acceptance
- 记录生产页面 HTML、资源瀑布、Shell 首屏和登录后 API 的耗时。
- 区分测量结论与尚未验证的推断。
- 未启用或非聊天入口不提前加载；确认 Bot/Profile 后才创建单个 Application。
- 指定 registration 的激活决定代理就绪；页面自身 controller/ready 不作为代理权威。
- 新开/恢复的远端回环预览等待代理；失败/停止/关闭/改地址/销毁后迟到结果不能导航。
- 哈希 JS/CSS 使用 immutable；稳定 loader/version/SW 保持 no-cache。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | 生产与凭据边界 | 只读诊断，用户已授权账户复现 |
| `opencraft/AGENTS.md` | OpenCraft 所有权与验证 | 从真实客户端取证 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | 性能诊断流程 | 核对真实版本与链路 |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md` | 登录验收与授权 | 隔离浏览器诊断，保持账户数据 |
| `docs/context/domains/identity-access.md` | 认证权限 | 使用受审计代登录接口 |
| `user/auth/AGENTS.md` | 身份服务边界 | 不更改生产部署 |
| `frontend/AGENTS.md` | 主站嵌入入口与诊断边界 | 主站与 embed 分段测量 |
| `ctl/AGENTS.md` | Bot 列表来源 | 公共入口实测与本地源码区分 |
| `docs/context/domains/site-environment-routing.md` | 追加诊断路由结果 | 国内 embed 的结论不自动推广到国际站 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | 主站入口邻接 | 核对嵌入迁移组件的相邻测试 |
| `opencraft/docs/platform-architecture.md` 嵌入与认证相关章节 | 共享应用与所有权 | 不用独立站 hostless 行为推断 embed |
| `opencraft/docs/browser-workbench-architecture.md` Web 策略 | 远端预览身份 | 等待自己的代理，不导航客户端回环 |
| `opencraft/docs/build-matrix.md` 与 Vite 配置 | 独立嵌入制品 | 隔离输出，不覆盖正在运行的预览 |
| `.agents/context/change-impact.json` | 正式设计映射 | 保留既有文档修改，追加当前启动不变量 |
| `docs/context/domains/agent-gateway-runtime.md` | 后续 /bots 优化评估边界 | 区分 CTL 执行、公共入口与实际测量，未实施或操作生产 |
| `docs/context/project/services/collaboration.md` | 第二批路由必读 | 协作仍借用同一账户/Application，不改服务端连接所有权 |
| `opencraft/docs/plugin-architecture.md` | 扩展生命周期与依赖 | 完整阅读；保持 Supervisor 激活、回滚与退休权威 |
| `docs/context/tasks/optimization-queue.md` | 优化需求交付队列 | 回读最新 master 与实时 TAPD，独立分支/卡片 |
| `docs/context/flows/tapd-gongfeng-delivery.md` | Git 与 MR 交付 | 用户明确授权，正常平台门禁，凭据不落日志 |
| `docs/context/flows/change-delivery.md` | 源码交付检查 | 独立复验、文档影响和证据 |
| `docs/context/domains/release-gitops.md` | 发布边界 | 合入 master 不等于生产发布 |
| `.agents/skills/gongfeng/SKILL.md` 与 `DEPENDENCIES.md` | 工蜂接口与鉴权 | mcporter-internal 不可用，使用已验证的仓库 CI API 路径 |

## 2026-10-04 Git 交付复验

- 交付回执：功能提交 `ee7ddd3f9` 已推送；[MR !4961](https://git.woa.com/wisp/mono2/-/merge_requests/4961) 已创建，目标 master。首次平台回读 `can_be_merged`、commit check `success`、block=false；按最新授权继续正常合并，合并结果以随后平台及 Git readback 为准。

- 最新授权：用户要求“先提交，推送，合入 master”。单项独立分支 `perf/opencraft-embedded-startup-20261004` 从 `origin/master@bbd7ffb83` 创建；仅提取本项改动，保留 upstream loader 的30秒 deadline、轻量错误文案和 browserMetadataStorage。原 dirty checkout 及其其他改动不在提交集。
- 新工作区按各自锁文件安装 OpenCraft/npm 与 frontend/pnpm 依赖，没有借用其他 checkout 的 node_modules。
- 新源码 Web 类型检查、typography/platform boundaries、130 文件 Agent Console 同步检查通过。前端 check exit 0（166 current/171 baseline，0 new/5 resolved）；启动与所有权聚焦测试18/18、相关浏览器/扩展/嵌入账户/恢复/真实PTY回归28/28、前端资源准备和缓存规则测试8/8。
- Embedded release 构建 exit 0；国内前端完整构建 exit 0（106静态页、194 HTML、13条路由）；国际站完整构建本交付阶段未重跑。文档检查 exit 0，broken first-party links=0。
- 新工作区真实 Chromium 的 narrow SW/broker/iframe smoke exit 0：聊天响应探针在代理激活前可操作，文档不受控且 document.ready 未完成时代理仍就绪；停止/关闭预览无迟到恢复、无客户端 localhost 请求、无 pageerror。远端 HTTP 为合成服务，探针不等于完整 Application/真实登录验收。
- 扩展持久化 `extension-artifacts.test.ts` 的 pinned-module 测试报 `artifactRef` deep-equal 失败并挂起，已终止该次自有测试进程。该测试、extension-runtime 与加载器/持久化文件和当前 master 完全一致；未在本项扩大修复，不能声称完整扩展/全量 gate 通过。
- 本地提交前 CR：核对资源预备不创建 Application/Host，Bot/Profile 仍守唯一 canvas owner；代理只等自身 registration，预览失败不回退 localhost；延迟模块销毁先 abort 后排空，工厂超时和迟到 import 有 scope fence；Full Workbench 的 eager 默认与 Terminal 协议服务保留。未发现本提交的阻断项；此前真实 Host bootstrap 风险保留。
- 真实账户端到端耗时来自较早隔离诊断，并非最新 master 回执；诊断 prompt gate 不在交付代码中。尚未完成原始优化前与新版本的受控因果 A/B，不能排除第一批时序变化放大旧竞态，不能把成功样本平均值当作稳定性已解决。
- 公开分支预览未发布；Fanny/负责人 CR 和完整登录态验收仍待完成。按用户直接源码交付授权创建并尝试正常平台合并，不绕过平台检查；TAPD 保持 open，尚不标记已完成。

## evidence
- 2026-10-04 09 时左右 CST，隔离 Chromium 手机 viewport（非真实手机、未节流），使用用户授权的受审计短期代登录会话；开启主站既有 console-show rollout 标记，仅在隔离浏览器中设置。
- 生产嵌入版本：`embedded-f08e38a40a63`，version.json builtAt `2026-10-03T16:00:59.338Z`。源码未完整包含在该主仓库提交树中，不以主仓库 SHA 证明全部本地文件与部署一致；关键等待行为已通过线上浏览器插桩验证。
- 多次正常冷加载 `opencraft-ready` 11.19 / 11.60 / 11.83 / 11.78 / 11.73 秒；正常缓存刷新 10.06 秒。该指标是嵌入界面接管显示，不宣称已验证真实手机可输入或已有会话历史恢复。
- `/v1/instances/:id/bots` 约 2.88–3.13 秒，主站获取完整 Bot 列表后才挂载 embed、请求 embedded-workbench.js。普通认证与实例接口多为 35–100ms。
- 本地 `frontend/src/repositories/http-repositories.ts:listBots` 等待 instances 与各实例 /bots；`ctl/pkg/instance/bots.go:ListInstanceBots` 顺序执行 listHermesProfiles、微信绑定读取、WhatsApp 绑定读取，三者都经 execHermesProfileCommand -> TAT 远端命令。线上 /bots 慢已实测；内部三段分别耗时尚未追踪生产 ctl 日志，不作逐段量化。
- 嵌入首次约 33 个资源、1.78MB 响应体，整页约 3.92MB；缓存刷新 embed 响应体约 1.4KB，但仍有多个带哈希 JS/CSS must-revalidate，串行动态依赖有数轮 0.1–0.4 秒网络等待。Playwright sizes 缓存资源负数已 clamp 到 0；此值仅响应体测量，不等于原始源码体积或完整网络流量。
- TAT session API 约 0.44–0.49 秒，connect:start 到 connect:open 约 0.98–1.06 秒，只有一条物理 TAT WebSocket；没有证据支持重复物理连接造成慢。
- **确定根因：可选 Host Proxy Service Worker 错误等待当前页面的 navigator.serviceWorker.ready**。注册 scope 是 `/__opencraft/host-proxy/`，文档 `/agents/chat` 不在 scope 内，主站 controller=false，ready 无 resolve，4,000ms timer 每次耗满。此等待被 createWebWorkbenchApplication await，阻塞 prepare/show。
- 线上只加日志的证据：SW register_start=6778ms、register_end=7145ms；ready_wait/timer_start=7145ms、timer_end=11146ms；opencraft-ready=11725ms。同时 Host connect:open=7843ms，后面多数时间没有聊天 RPC。
- 物理 TAT 帧只在进程内解析，只输出 RPC 方法与耗时，不输出参数、请求正文、凭据或历史：session.list 46ms，model.options 113ms，发生在 UI 接管时，不能把前面约 3.6 秒归因为慢历史列表。
- 隔离浏览器对照：在缓存刷新阶段仅禁用该上下文的 Service Worker API，让可选 Host Proxy 启动返回 unavailable；opencraft-ready=6493ms，sessions count=17 在6533ms，Host connect:open=6461ms。与正常缓存刷新 10062ms 对照，差约3.57秒。它验证等待是关键路径，并不是建议生产禁用 Service Worker，也不是已实现修复。
- 所有成功创建的诊断代登录会话均 DELETE /auth/session 返回204；每轮浏览器与本轮 port-forward 子进程已关闭，未改变目标账号业务数据、生产配置或发布。

### 追加评估：6.5 秒不是验收目标

- 用户要求确认是否仍有其他问题，并指出 6.5 秒不符合预期；继续只读调查，没有实现或发布授权。
- 第二组对照（三次加载同一隔离上下文，均跳过可选 SW API）：cold ready=7557ms、warm baseline ready=6932ms；提前 modulepreload 已观察到的 embed 依赖并提前加载入口后 warm ready=5570ms，session 列表完成5609ms，Shadow DOM 内编辑器数量1。未输入、发送模型消息或操作业务数据。
- 提前资源准备能省约1.36秒，仍不能消除约3秒 /bots（该组3000/3098/2972ms）。这是实验性调度变更，不代表生产已有修复；预加载依赖来自本轮瀑布，不建议硬编码生产 chunk 清单。
- 剩余路径：主站认证/实例发现 -> /bots 完整返回 -> embed 配置/应用与扩展准备 -> TAT/Host 连接约1秒。主站与 embed 还重复读取 profile/instances/subscription/passes；要分清首屏必需、身份校验必需与可后台读取项，不能靠跳过授权或猜 main Profile 提速。
- 源码级交互风险（尚未真实账户复现）：`AgentChatMigrationSurface.publishSessions` 只在 selectedChatId 非 null 时回传。新 Draft 会回传 null，但外层可能保留旧 ID；外层点击会话仅 setSelectedChatId，如果点击值与保留的旧值相同，React 不一定触发选择 effect。这可能导致侧栏高亮与画布不一致、从新草稿点回旧会话无效。相邻测试目前只覆盖非 null 的 thread-1，未覆盖该序列；不把源码风险当成确定线上故障。

### 整条启动链路优化分析（未实施）

- 目标：优化可见且可交互的聊天，不把仅有空壳或 ready 事件当作历史恢复完成。保持 rollout、身份/地域/实例/Profile 校验、唯一 Host/Application owner、会话恢复和发送权限边界。
- 当前串行依赖：主站 JS/认证 -> 实例列表 -> 完整 /bots -> activeBot/sdkInstance 分支挂载 -> embed 模块 -> 共享 Application 初始化/账户详情等待/扩展加载 -> Host TAT -> 会话激活与呈现。可选 Host Proxy 的4秒等待与连接部分重叠，不能把各阶段简单相加。
- 建议启动图：进入且已启用的聊天页后，资源/渲染内核准备与认证/Bot 发现并行；两者就绪后，在确认的绑定上创建唯一 Host 连接 -> 协议初始化 -> 指定 Thread/Draft 激活 -> 可用。权益详情、管理 View、协作、可选 Browser Proxy、Terminal 呈现等按实际依赖后台/按需完成，不另造精简业务内核或第二个 Application。
- P0，修 Host Proxy 正确注册对象的激活等待，并让可选代理不成为聊天就绪的必要条件；保留 scope 隔离、失败反馈和销毁代次，不能简单绑当前页的任意 controller。
- P1，资源启动提到不依赖 activeBot 的聊天页面层，保留 enabled 门禁；应用分阶段 prepare，资源阶段不需要实例、不能提前跟随全局 activeBot 连接。预加载清单来自构建 manifest，不能硬编码本次 chunk 文件名。
- P1，真正内容哈希资源 immutable；loader、version、SW 保留可重验证策略；发布保留旧 hash 闭包，验收新旧 loader、回退与跨发布会话，不能把缓存加速换成新旧构建混用。
- P1，/bots 优先评估保留现有 API contract 的一次 TAT 批量执行，减少三次远端执行及进程冷启动；不优先并发创建三条 TAT 执行。Profile 与两通道分别阶段耗时未量化，收益需实际验证。重要：通道 action=get 在源码中会持锁、迁移遗留 WhatsApp 归属并对过期预留进行对账，不能误当纯读直接删除；批量/拆接口要保留这些不变量与错误语义。
- P2，拆账户 identity 就绪与 details 就绪：当前 supervisor 在显式 region 时 await refreshBots 和 refreshAccountDetails；后者等待 profile 后又等待 subscriptions/passes，最终才发布 profile。provider 的 accountId 校验依赖 details.profile.id，不能直接删 await details，应由同一 account owner 提供独立身份就绪边界，权益继续后台读取。
- P2，按依赖提前下载必须的扩展；语音、协作、Bot 管理等不属于嵌入核心聊天呈现的启动必要条件。只延迟呈现不能减少当前 await 串行动态加载，需显式 startup capability 依赖计划，保留共享服务和依赖先后，不无差别 Promise.all 激活所有扩展。
- P2，主站与嵌入同一账户代次下复用在途发现/身份结果或窄凭据 port；不是复制 token 或长期信任旧 catalog。保持 region/account/generation 作用域，切账号、切 Bot、取消时旧异步结果必须失效。
- 目前证据不支持优先改聊天历史：该次启动是 Draft，session.list 46ms、model.options 113ms；已有长历史、实际手机低速网、后端真正冷启动未覆盖。已有 Thread 应只等其首屏必要历史/能力，其他会话的列表与模型信息按依赖并行，后台不抢选中态。
- 实施顺序建议：前端正确性+调度+缓存，随后 CTL 批量执行，最后账户/可选扩展关键路径整理；逐步产出可回退验证，不一次性重写。
- 验收建议分别量 startup shell、host connected、composer interactive、requested history ready；冷/暖浏览器缓存、已有 Thread 与 Draft、弱网手机、快速 Bot/Profile/账户切换、401与权益5xx、断线重连、发布升级各自检查。2–3秒可作为正常网络缓存场景的候选目标，但当前证据不能保证达成，需先测优化后 /bots。

### 落地复评与基线（2026-10-04 09:55 CST）

- 用户“搞起来？再评估一下看看”本轮按落地复评处理，已明确暂不修改业务代码或生产。
- Context Router 本轮额外命中并完整读取 `docs/context/project/services/ctl.md`；核对 `/bots` 和通道对账相邻用例。首批涉及的 loader、页面、发布规则、Host Proxy 源文件无现有修改；`appserver-runtime-context.tsx` 已有用户恢复链路修改，本轮未触碰，后续账户/扩展整理必须保留。
- 首批范围建议仅资源早准备、Host Proxy 正确就绪与可选能力独立初始化、哈希缓存交付，保持 API/身份/账户模型不变；主体早加载入口从页面层触发，沿用单个 loader Promise 与注册元素，不创建额外 Application 或 Host。
- Host Proxy 后台化不能只删 await：恢复的 Browser 页与新开预览仍须等待它自己的能力就绪，不得把远端 loopback URL 直接交给本机浏览器。Controller 来源应确认属于本次 registration，不能错误借用主站另一 Service Worker。
- CTL 第二批仅改 ListInstanceBots 获取路径与批量脚本/投影，保留现有 API 字段、鉴权、TAT 地域路由、官方 Profile API、gateway_running 三态、通道锁和对账；CRUD/claim/confirm/release 的执行语义不顺手重构。真实收益与错误语义仍待新增测试及隔离验证。
- 基线命令：OpenCraft `node --import tsx --test tests/workbench-host-proxy.test.ts tests/embedded-workbench-host-profile.test.ts tests/embedded-workbench-authority.test.ts`，10/10通过；frontend `node node_modules/vitest/vitest.mjs run src/pages/marketing/__tests__/opencraft-embedded-workbench.test.tsx scripts/fix-next-static-html-lang.test.ts scripts/build-release-artifacts.test.ts`，20/20通过。这是现有基线，不证明性能缺陷已被覆盖或修复。
- CTL 聚焦测试尝试未执行：本机 `go` 不在 PATH，几个标准安装路径也无 Go；未安装工具链、未因此修改构建环境。实现 CTL 前需落实已有 Go 构建环境或单独补齐工具链，并补批量失败/对账回归。

### 第一批实施与验收

- 页面层 enabled Chat hook 提前请求共享模块 loader，实际 migration surface 复用 Promise；仅确认实例/Profile 后创建元素/应用。错误移除失败 script 并清空在途缓存，可由正式 Surface 重试；退场候选不得迟到接管。
- Application 不 await 代理；Broker 针对自己的 registration.active 激活监听，清理 timeout/abort 监听器，不读 document.ready、不借任意主站 controller。start 合并在途操作，失败可重试，销毁拒绝晚到绑定。
- BrowserPageRuntime 为需要代理的导航保留等待事务及代次，创建惰性空 surface 供 Presentation 持有，未就绪不发原始 localhost。停止/关闭/改地址/销毁撤销旧导航；automation/capture 也等待该导航并检查失效。
- EdgeOne Build Output 对 release Vite 的 `assets/a-[hash][extname]` 声明一年 immutable；loader/version/preview bridge/SW 明确 no-cache。没有把整个 assets 目录标长期缓存，也没有改变生产 edge 配置。发布仍需保留旧 hash 闭包。
- 最终聚焦验证：OpenCraft 25/25（含超时后重试、迟到结果、既有恢复/Browser owner）；frontend 21/21（含退场、门禁、并行加载去重与缓存规则）。Frontend baseline TS 171 个既有诊断、0 新增；Web workspace TS 最终通过；平台边界/typography 检查通过。
- 独立 release 构建 `/tmp/opencraft-startup-20261004-final` 通过，未覆盖默认输出。完整 Next export 未执行，以避免影响共享开发产物；构建规则通过临时目录制品测试验证。Frontend i18n 提取与结构校验通过。
- 真实 Chromium + 实际窄 scope SW/Broker/Browser runtime/iframe：页面 controller=false、document.ready 未 resolve，代理自身仍激活并转发 HTML+CSS。人为延迟 worker 响应800ms时交互 probe 在35ms可用、代理844ms就绪；关闭/停止页面均未导航，未发原始 localhost 请求。远端 HTTP 为合成端点；交互按钮不是 Application 启动证据。
- 另外用用户已授权的隔离代登录会话，在**仅诊断浏览器**将嵌入静态资源替换为本轮构建（主站 Next 仍为线上版），人为延迟 register 8秒：proxy_start=6636ms，opencraft-ready=7809ms、show_end=7820ms，注册尚未结束。画布数量1、Shadow DOM 编辑器1、物理 TAT WebSocket1。这证明实际应用不被慢注册阻塞，不是完整新版启动性能基准；主站提前准备尚未包含在此组合测量，已有历史就绪和手机输入也未验证。会话 DELETE204、浏览器/port-forward 已关闭，未发模型请求或改业务数据。
- 广泛门禁未全绿：OpenCraft workbench-* 运行包含范围外的旧生命周期源码匹配失败（workbench-root.tsx 无 pagehide 片段，本轮未改该文件）；frontend 全量测试出现范围外模型配置/账号/引导/CSS边界等失败，最终一个 worker 长时间满 CPU，受控 SIGINT 结束，无最终通过声明。共享上游 check 发现工作区原有 i18n 生成漂移；本轮前端 loader/page 不在该闭包，未覆盖上游副本。
- 正式文档链接检查无错误、显式变更集 docs-impact 通过；全仓 context/audit 存在大量历史 metadata/任务字段/凭据启发式告警，不扩大本轮治理。staged gate 为空集，不拿它代替显式变更集。

### 完整新版组合测量（2026-10-04 11 时 CST）

- 按维护 skill 的隔离要求，在 `/tmp/mono2-startup-benchmark-bzrXhq` 复制本工作区当前 frontend/shared 源码及同一 checkout 依赖；新构建嵌入 release，执行国内生产组合完整 Next export、版本化资源、嵌入 staging、语言修正、EdgeOne 规则生成与 SEO/资源引用检查。Next 106 页生成、194 HTML 格式化、13 routes 生成、177 versioned refs 检查通过。没有覆盖主工作区 `.next/out` 或运行中的服务。
- 浏览器以 `https://lightvela.com/agents/chat/` 访问本机回环 HTTPS 静态服务，应用生成的真实缓存规则；只在隔离 Chromium 内将该主站域名解析到回环，不改变机器 DNS、生产或公开入口。API/auth/TAT 仍访问真实国内服务；390×844 触控 viewport，无手机 CPU 节流。计时从 navigation 起点到 Draft 画布可见、编辑器可见且启用、非 loading 会话列表完成；随后确认编辑器可聚焦。不发消息、不输入草稿，不把此指标当已有长历史恢复或发送成功。
- HTTP 缓存未用 Playwright route（该 API 会禁用缓存），资源在计时前压缩准备；同一上下文先 cold 再 warm，新上下文重复三组。生成 header 已通过实际响应确认：哈希 JS/CSS immutable、稳定嵌入入口 no-cache。这里使用静态服务器而非生产 CDN/EdgeOne Functions；遥测 `/cgi/capi` 在隔离静态环境404，不是生产故障判断。
- 控制网络条件：额外100ms延迟、10Mbps下载、2Mbps上传。完整三组均成功：cold 编辑器/可见 `10021 / 9775 / 9680ms`，中位 `9775ms`；列表 `10071 / 9824 / 9736ms`，中位 `9824ms`。warm 编辑器/可见 `6079 / 6176 / 6343ms`，中位 `6176ms`；列表 `6125 / 6228 / 6383ms`，中位 `6228ms`。原始结果 `/tmp/mono2-startup-benchmark-bzrXhq/results.json`。
- 三组 warm 嵌入33次请求中32次命中浏览器缓存，嵌入传输约248字节（冷启动约1.76MB，CDP encodedDataLength）；所有成功页面元素构造1、画布1、TAT物理WebSocket1。另一条 lightai WebSocket 不属于 TAT，不能将所有 WebSocket 都算成重复聊天连接。SW 自身激活正常，不再出现 document.ready 固定4秒等待。
- 不节流补测完成两组成功值：cold `6234 / 9608ms`，warm `5599 / 7067ms`；第三次 cold 超过40秒未就绪，不以这四个成功样本计算完整三组中位数。进一步复核连续 cold/warm 各一次同样超过40秒：SW 均激活，/bots 约3.0–3.2秒返回200、TAT/session约0.43秒返回200、无 pageerror，但嵌入 prepare 尚未结束、画布与列表未就绪。复核请求/事件记录在 `results-native.json`；重复失败后受控关闭本轮 Chromium，未无限重试。具体阻塞的 Host/扩展阶段尚未取证，不把全部超时归因为 /bots 或 SW，也不能排除测试插桩/环境因素。
- 不节流成功样本证明 loader 与 /bots 已并行：例如 /bots 从624ms开始、耗3109ms，loader从652ms开始、耗7ms；元素847ms定义、3836ms才配置已确认Bot。慢样本 /bots 达4523ms，TAT/session达2653ms，均明显高于此前约3秒/0.45秒；剩余后端抖动真实存在，但不是所有超时的根因证明。
- 本轮静态产物完整，但不是生产手机/CDN上线实测，也不是与旧版本同环境严格 A/B；不直接用旧线上11–12秒计算百分比。三项生效不等于已经稳定达到2–3秒；后续必须独立对账超过40秒的失败样本。
- 测量工具初次失败源于把 lightai socket 与 TAT 合计断言、即时高质量压缩计时污染；该轮不纳入基准，诊断登录态 DELETE204。控制网络测量会话 DELETE204；首次不节流运行因 auth port-forward 中断，清理 DELETE 无法执行且 token 已随进程释放，30分钟代登会话 TTL 到期前不能声称已撤销。尝试只读找回本轮特定会话的数据库路径不可达，未更新任何数据库记录。最后复核会话 DELETE204，浏览器/回环服务器/本轮 port-forward 均已关闭。没有输出 token、历史内容或修改账号业务数据。

### 后续空间只读复评

- 用户询问“还有进一步的优化空间吗？”，本轮仅评估，不修改业务代码或生产。重新核对根/服务入口、维护 skill/验证清单、站点及 Agent runtime Domain；读取正式 Embedded Shell/认证所有权章节，并检查资源预加载相邻测试，未重新跑性能矩阵。
- 最新控制网络 warm 数据，首次 prepare 到 ready 分别2304/2301/2489ms；资源32/33命中仍有这段必要或可移出关键路径的等待。不能将它全部解释成资源下载、某个扩展或 Host 连接，因为尚无逐阶段计时。
- `/bots` 当前仍在 `ListInstanceBots` 顺序调用 Profile 列表、微信 binding、WhatsApp binding，每项最终执行远端命令。候选方案是保持响应 contract、归属鉴权与渠道锁/遗留迁移/预约对账语义，将三项读取合为一次远端执行，减少 TAT 往返和 Python 进程启动；不是删除 get 的副作用或直接并发三个锁操作。已有请求约3秒、个别4.5秒证明这段优先级高，但不能按3次命令直接承诺降至1秒。
- supervisor 在显式 embedded region 时仍 await refreshBots + refreshAccountDetails；后者先读 /auth/profile，再等待 subscription/passes 后才发布 profile。候选是同一 account owner 暴露身份就绪边界，使权益详情后台读取，并在 account/region/generation 范围复用主站和内嵌在途发现。不能绕过 provider 对账号/实例/Profile 的校验或造第二个可写身份缓存。
- 初始化仍串行 await voice、collaboration、bot-chat、bot-management 等扩展；Application 在 supervisor 后也 await Terminal 插件。候选是依照 capability 依赖提前准备必须模块、可选能力后台/按需激活，保持同一 Application、工具协议声明与可用状态一致；不能无差别 Promise.all 激活，或将视觉隐藏当作没有初始化。
- 优先级应为：先给 >40秒未就绪建立逐阶段完成/失败/取消证据并核对测试插桩；然后 /bots 单次执行；再身份/权益就绪分离与必需/可选扩展调度。3秒级热启动只是后续目标，不是当前数据已证明可达的承诺。本轮无新实现、测试或发布完成声明。

## affected_paths
- frontend 的 agent-settings-page、opencraft-embedded-workbench 及资源准备测试。
- frontend/scripts/fix-next-static-html-lang 与发布缓存测试。
- opencraft Web Application、Host Proxy broker、BrowserPageRuntime、就绪测试和浏览器 smoke。
- 对应正式架构、领域文档与当前 Task Pack/checkpoint。

### 第二批：可选呈现退出关键路径与长等待诊断

- 先在未改扩展调度的完整隔离制品读取已有 Hermes 连接日志，只输出 stage/generation/elapsedMs、API 状态与 PTY 帧数量/字节数/布尔标记，不输出终端内容或凭据。超过40秒的样本停在 `tat:session-created`：API 约0.45秒成功、TAT socket 未报错、PtyReady 已到、7631字节启动输入已发；没有 `hermes:backend-ready`，也没有 `appserver:initialize:start`。SW 已激活，可选扩展在此之前已完成，分类确定为 **Host ensure 阶段**，不是扩展或协议初始化慢。
- 延长观察至85秒（不增加业务重试）：冷/暖各一个失败样本在 Host 相对75.540/75.539秒失败，之后 Application 正常释放。源码 ensure 默认预算75秒；两者均未出现 READY/ERROR 标记，终端输出元数据同为11866字节。错误文本“等待端口监听超时”不是后端实际不存在的证明，只能证明没有拿到启动检查回执。
- 源码把约7.6KB的整个 POSIX shell 函数在 PtyReady 后立即一次写入 PTY。PtyReady 只表示通道建立，不表示交互 shell 已完成行规程配置。真实本地 PTY 合成对照：同长度函数在延迟的 shell 启动前写入，不执行（输出11766字节）；等 shell 进入可接收输入状态后写入则执行（输出7694字节）。合成实验没有执行 Hermes 命令，也不改变账号数据。
- 进一步在**仅诊断浏览器**拦住原始长 PtyInput，观察远端 shell 的 bracketed-paste 就绪标记后释放，命令内容和后端流程不变。不使用固定延时、也不是生产修复。两组冷/暖全部就绪；两次真正 ensure 的输入仅等56/45ms后投递，READY 均返回，Host连接1286/1111ms；另外两次暖加载直接采用既有后端。诊断文件 `diagnostic-prompt.json`。这与本地实验共同高度指向过早长行输入/终端行规程竞态；远端实际 ICANON 状态与被截断字节没有直接读取，因此不把推断升级为云端行规程已逐字证明。
- 本轮只实施用户授权的可选启动调度，不修改 Host bootstrap。下一步应设计可验证的命令投递/执行回执边界，不能把 PtyReady 当作 shell 可执行就绪，不能把等 Bash ANSI prompt 的诊断方法直接当通用 POSIX 生产契约；仅调大超时/增加重试不解决丢失的输入。
- Embedded 仍调用唯一 `createWebWorkbenchApplication`。Application 持有延后 lane；首个可见 show 帧后依次加载语音、Collaboration、Bot Chat/Management 呈现及 Terminal 插件。身份/实例/Profile 校验、WebSocket/Hermes provider 和 Terminal session/tool core 不后移；Full Workbench 默认保留 eager 启动。既有用户 Host query recovery 改动未回滚或改写。
- lane 合并重复 start；未完成模块加载有15秒预算及工厂 AbortSignal，Application 退休或 Supervisor 更早收尾时撤销旧工厂；已经开始的激活先排空，再销毁其借用的注册表/Host。Supervisor 保留激活/回滚/失败描述的权威，Terminal 仍通过原 Panel runtime 注册，不另造 registry。
- 单元/模型验收26/26，包含延后、重复 start、失败继续、退休前禁止启动、晚到 import/factory、模块超时、in-flight drain、真实 Supervisor 一次激活/卸载和嵌入写 lease；相邻扩展/平台/Hermes/Profile/Panel/真实 Terminal 回归132/132。Web workspace TS、typography/平台边界及独立 embedded release 构建通过；新增测试加入 pretest:extensions 门禁。无单独 lint 脚本，未声明全仓 gate 通过。
- 可选运行时对照：完整当前 frontend静态产物 + 新嵌入制品，真实授权API/TAT；两组 cold编辑器5937/6049ms、warm5376/5517ms。cold时语音模块在5946/6055ms才请求，人为响应延迟8003ms，聊天在此前已可输入；首帧只有必需扩展，后台全部可选扩展激活且 Terminal 注册成功，始终一元素/画布/TAT连接。warm资源32/33命中。只有静态诊断服务器延迟模块，不改浏览器HTTP缓存策略。这不是生产/CDN/真实手机基准，也不证明Host稳定性已恢复。
- 最后一项工厂 scope hardening 后重新通过26测试、TS和独立制品构建，输出 `/tmp/opencraft-optional-startup-20261004-verified`；实际客户端复核继续记录于 checkpoint。所有当前完整诊断会话 DELETE204，浏览器/回环静态服务器/本轮port-forward关闭；先前丢失token的30分钟TTL记录仍不伪称已立即撤销。
- 最终未改变Host投递的制品再次 cold/warm 各超过40秒，均停在同一ensure阶段，证明可选扩展后移未解决该Host故障，记录在 `diagnostic-optional.json`。随后仅加前述诊断prompt门禁验证同一个最终制品：cold5942ms就绪、语音响应额外8秒仍不阻塞，所有可选扩展active且Terminal注册；warm同样成功。完整安全元数据保存在 `diagnostic-optional-verified.json`。此验证可用于可选调度/清理边界，不可用于声明无诊断门禁的启动稳定性。
- 检索边界：曾误猜 `extension-runtime/src/supervisor.ts`、Terminal `index.ts`、`runtime/chat-tool-handlers.ts` 不存在；使用相应目录 rg --files 与实际 import 定位 runtime.ts/index.tsx/registry tool host，未扩大为无界全仓扫描。

## risks
- 未发布的源码不影响生产缓存；正式上线需测冷/暖缓存、实际手机和旧资源闭包保留。
- /bots 约3秒仍存在；不承诺总启动2–3秒，不跳过 Profile/账户授权。
- 广泛 gate 的范围外失败需另行对账，不把聚焦验证描述成全仓通过。

## handoff
第一批与第二批可选呈现调度源码已实现并完成聚焦验证；没有提交、发布或重启生产。长等待明确在Host启动检查，75秒耗尽仍无命令回执；诊断对照高度指向过早长行PTY输入，不是扩展加载或协议初始化。Host可靠投递修复尚未实施，不能声明稳定性验收通过。/bots批量执行与账户模型仍未授权/未实施；正式发布前另需真实手机/CDN冷暖及旧hash闭包验证。
