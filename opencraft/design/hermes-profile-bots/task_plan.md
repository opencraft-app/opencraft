# Hermes 多 profile Bot

## Hosted Room 群聊桥接（2026-09-16）

- Hermes `groups.capabilities` 是唯一能力门禁；不支持或协商失败时保持 direct-only，不能影响 Bot、Agent 或模型目录。
- `groups.create/list/state/log/send/stop/rename/disband/approve` 薄映射现有 `vela/bot-conversations` group topology；Room拥有身份、成员、历史、执行和authority，浏览器不建第二份群聊数据库。
- Room ID是conversation ID；`authority_gateway_id + authority_epoch`是live epoch；Room event seq是游标。日志轮询只投影Server事件，失败不制造终态。
- Hermes v1 roster创建后冻结，因此支持2–6 Bot创建但不声明`groupMembership`修改能力；成员变化需要重建房间。
- Composer补齐`agent/list`：成功时Hermes Agent的`modelIds`来自`model.options`；协商失败返回空Agent页，不得令联合查询抹掉独立成功的模型目录。
- Web Bots管理页在Host声明group topology且至少两个Bot可用时显示“新建群聊”，选择2–6个Bot后创建并打开统一Bot Chat View。

## 当前阶段：管理能力（2026-09-15追加）

用户明确要求实现创建／克隆／删除，并在Applications加入Bots入口。本节取代下文第一阶段的readonly限制。

- 已接通实例控制面API的blank创建、指定Bot克隆、重命名及删除；Host提供management能力，每个Bot声明可用动作。
- 默认Bot不能单独删除；名称仅展示，clone来源与删除目标使用BotID。不同Host不共享状态。
- 创建意图回执由物理Host端口保存，跨Bridge更新保留；相同请求ID不会重复POST，未知结果不自动重试。
- 目录拒绝旧连接的迟到变更，刷新不能覆盖已发布管理事件；删除使打开的会话失效，保留屏幕历史但禁止继续发送。
- Bots列表使用主题Settings控件与Radix菜单/弹窗，删除用AlertDialog；侧栏新建入口进入同一管理页。
- Bots管理不呈现实例选择器，只消费当前账号唯一的`lightvela.hermes`云端Host。本机及其他Provider即使声明Bot能力也不参与；多个云端Host没有唯一已连接owner时拒绝暗选。
- 管理页将“Host连接 + Bot目录刷新”作为一个15秒用户交互事务；Host传输逐步投影“确认Agent/TAT会话/Hermes Dashboard/AppServer”阶段，进入目录阶段后显示“正在读取Bot列表”。任一阶段超时都释放加载态，并在提示中带最后已知阶段和后台任务状态。Host连接与目录请求仍归其原owner，若随后成功，订阅自行收敛。
- 进入Bots View即为唯一云端Hermes Host启动一次自动连接/目录刷新，连接不作为用户按钮呈现。首屏显示Bot列表或加载占位；失败后保留原因和通用刷新动作。
- 控制面HTTP 404/405不是Hermes运行时“不支持”信号；`route_not_allowed`立即结束加载并向用户呈现通用内部错误，具体代码只保留在诊断对象中。只有原生Hermes RPC `-32601`才降级为运行时能力缺失。
- 新Bot的canonical会话可先由Hermes Gateway创建，首条消息前Dashboard历史行尚不存在。身份由Profile canonical session ID而非展示标题拥有；Dashboard的HTTP 200/404语义错误信封统一在History Client边界解包。已成功Resume的canonical Bot Chat可将not-found投影为空历史，普通会话及其他错误继续失败。
- CTL无跨客户端CAS：本实现只承诺新鲜revision检查与当前Host的串行操作，不宣称服务端CAS。
- 14项管理聚焦测试与真实组件/API边界替身验收通过；最终完整gate通过。无生产/真实资源写入，未提交推送。
- 最终Mac包：`apps/workbench-electron/release/bot-management-ready-20260915/mac-arm64/OpenCraft Preview.app`。
  严格签名验证通过，457个renderer文件逐一匹配当前构建；真实客户端Bots入口和管理页已验证。
  管理截图为 `evidence/management-light.png`、`management-dark.png`。最终客户端刷新验收以以下补充为准。
  本轮真实远端控制面变更未执行；根context仍有4项历史失败，本Task无新增命中。

### 深层页面刷新修复

最终实机reload发现Electron相对资源base导致`/views/assets`404白屏，已改为私有loopback origin根路径。
`node scripts/smoke-electron-route-assets.mjs`验证实际构建HTML在根、Bots和Settings路由的每个JS/CSS资源经真实静态server返回200及正确MIME。
发布测试8项通过；最终重新打包到`release/bot-management-ready-20260915`，严格签名验证通过、457个renderer文件匹配当前构建。
该包实机进入Bots后执行深层路由reload，管理页正常恢复；无JS异常、无assets 404。截图`evidence/management-mac-final.png`。
当前独立preview未登录，真实云端创建/删除未执行；真实控件与控制面API边界替身的CRUD验收已通过。

## 第一阶段历史

目标：同实例Host下已有profile Bot的发现、聊天、恢复/取消；前端沿用AppServer Bot扩展，统一控制面Bot ID与native profile绑定。
非目标：不开放创建/克隆/删除，不新增Host per profile，不修改生产/CTL，不提交推送，不进行真实付费推理。

1. 入口/版本/身份对照 — 完成。
2. 控制面绑定、正式连接只读能力协商、Bot handler隔离 — 完成，TDD。
3. 单实例多profile并发/重连/取消/跨身份拒绝、现有UI目录验证 — 本地边界验收完成。
4. 类型/完整gate、独立签名客户端/本地RPC替身与交接 — 本地源码/产物验收完成。

## 已实现范围

- 控制面与原生 Profile 求交集，不合并跨 Host 身份、不伪造默认；main只在provider adapter转default。
- 正式transport按原物理实例请求Bot目录，generation与账户撤销继续隔离旧请求。
- Bridge成功探测才声明readonly Bot扩展，404/405/-32601省略能力；其他失败不当作空目录。
- managed handler禁止管理写入；legacy显式runtime fixture保留原行为。
- Canonical Bot Chat会话明确归属；恢复、发送、流式事件、执行与取消共用原身份。
- 普通任务事件不冒充Bot；跨会话/旧执行取消拒绝，目录刷新不可把Bot迁到另一profile。
- 注册已有通用Bot View/Source/Resolver，目录卡片打开确切Bot；不新增空应用入口，不重建环境页面。

## 验证边界

最终完整 `npm run gate` 复跑通过；最终受影响包类型检查及126项扩展测试通过。
真实组件/协议浏览器验收通过：仅native Hermes与控制面替身，发送按profile区分，换generation恢复对应历史，样式来自实际构建CSS。
独立ad-hoc签名Mac启动正常、无白屏；没有登录真实Hermes，不能宣称账号/TAT/真实模型推理验收。
根文档及影响检查通过、context-audit 33测试通过；根context仍有4项既有失败（旧frontmatter、中文优先、instruction budget和既有长hash扫描），本Task无新增命中。
尚未授权提交/推送或生产发布。

## 最终产物证据

`apps/workbench-electron/release/hermes-profiles-verified-20260915/mac-arm64/OpenCraft Preview.app`
通过 `codesign --verify --deep --strict`；其453个renderer文件逐一SHA-256匹配当前 `dist-electron`。
使用独立profile与已确认空闲CDP启动，真实Shell/Composer启动和reload无白屏、无空Bot应用入口。
截图位于 `evidence/mac-startup-final.png`；真实组件边界验收位于 `evidence/profile-restored.png` 和 `evidence/profile-restored-dark.png`。
预览为ad-hoc签名，非Developer ID/notarization发行。这里的native远端测试为替身，不代表真实TAT或推理成功。

源码事实：旧Bridge可opt-in但正式transport未开；已有bot/* typed扩展和generic Bot Directory，不新造协议；Ctl main映射native default，非默认bot ID来自native ID。账户bots列表仍指物理实例，此阶段保留其transport角色，子Bot只由Host下typed目录发现。
路由无匹配，有界搜索。ref/hermes不存在，不clone或查私人config。无图谱只读检索，不生成全仓图。
