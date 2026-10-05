---
id: opencraft-navigation-ownership-20261005
type: task
scope: Consolidate semantic conversation selection and asynchronous navigation eligibility.
owner: wisp/mono2-maintainers
authority: primary
status: complete
reviewed_at: 2026-10-05
review_due: 2026-10-19
source_of_truth:
  - opencraft/apps/workbench-web/src/runtime/workbench-navigation-transaction.ts
derived: false
---

## goal / requirement_refs
用户在 `/data/codex-new` 建模分析后授权“好的，搞起来”：进一步统一设置页返回聊天与相邻恢复路径的所有权。此前资源引用修复已存在，本次消除 UI 自己判断恢复资格的分支。

## non_goals
不替换预览、不重启、不提交/推送，不操作用户历史、Host 或云资源。不照搬参考产品页面 key，不合并同会话的独立 View/输入。

## interface_refs / history_context
- Router 是唯一历史写入者；ConversationActivationCoordinator 管资源接受/释放，ScopeRegistry/BindingStore/ViewRegistry 管实际身份。
- 事务表达 selectConversation（复用有效保留 View）、openChat（记住的 entry）、navigate（显式页面打开）、navigateToHome（新本地草稿），不可混为按 Thread ID 去重。
- 正式契约：`opencraft/docs/platform-architecture.md#application-router-authority`、`opencraft/design/invariants.md`、`opencraft/design/application-navigation/task_plan.md`。
- 有界历史：`2026-10-04-opencraft-chat-return-diagnosis.md`；当前源码已有引用校验/恢复纠正，尚未部署。
- 参考 Codex macOS 26.930.31428 build12913，`/data/codex-new/codex-26.930.31428-12913/unpacked/webview/assets` 原始 bundle 静态核对 ThreadScope/RouteScope、条件草稿重置、entry/tab 恢复与 `_Yo` 提交资格。`analysis/wakaru-standard` 仅定位辅助，符号冲突已用原始导出核实；不执行/编辑参考源码，不当作线上全行为证明。

## acceptance / validation
会话行只发出选择意图；相同保留 View 从设置/扩展页返回不等连接、不丢输入。重复恢复由事务合并；新意图、失败、释放后旧结果不得写路由或抢 View。显式打开同会话的不同历史页面仍保留独立输入。
聚焦导航/引用测试、Web 类型检查、边界校验、桌面/触控真实 Browser Router 与 Sidebar 隔离 smoke、定向文档影响和 whitespace 校验。

## affected_paths / scan_scope
OpenCraft Web app/runtime 的导航入口、相邻导航测试与现有 smoke；正式导航文档与映射 agent-gateway-runtime。不全仓扫描参考代码。

## required_context / context_receipt
根及 OpenCraft AGENTS、维护 Skill/verification 已完整读；Context Router 唯一命中 frontend-product-surface，其 must_read frontend 服务包及邻接卡已读，但不修改 frontend。任务/检查点模板、正式 Router authority/导航计划、activation/coordinator 和真实资源 fixture 已读。维护 Skill要求所有权、取消与真实界面验证，不增加服务或部署权限。

## decisions / risks
在现有事务内集中语义选择和异步资格，不另建 route/selected-Thread authority。Sidebar/HostCatalog 只表达选择；事务优先记住的 entry View，其次实际 active View，否则准备新目的地。重复选择仅在目标位置及已明确的 View 同时匹配时合并，不能将同 Thread 的新页面准备错误合并进保留页面返回。
`beginIntent` 统一撤销旧准备；`ownsIntent` 统一检查导航代次/释放/Router revision；`accept` 统一接受或释放（含抛错）。Home 后台准备与 retained return/POP 使用同一检查。草稿转换确认发起时仍为 active Draft，捕获原 View；旧转换不得抢占新草稿。保留原本有效提交后的 Composer target 切换/提交输入清空语义，不将已发送文字复制到下一轮。
Host 选择代次与有效路由结果限制最后使用偏好写入；偏好不成为实际选中会话或路径 authority。

## evidence / scan_output
当前 Sidebar 用 UI snapshot/pendingLocation 自行早退/选择 openChat，而事务重复执行相似判断；新草稿后台续接也重复实现 epoch/dispose 检查。资源所有者本身已有 lease/Scope 校验，应保留。

## implementation_validation
- `test:application-route-restoration` 48/48 通过（此前 37 项）；新增真实资源所有者 slow selection/输入隔离/重复选择取消/有效转换与不同 View 同 Thread pending 负例，及失败重试、迟到清理、Home/转换代次、释放后的 Promise 契约测试。
- 初次新增有效 promotion 测试误期待已提交输入保留；源码既有 `bindScopeTarget` 正确切换目标并清空已提交草稿，修正测试为 Scope/View/Composer identity 保留、submission 原文不变、下一轮为空，不为错误测试改变产品。
- `smoke:application-route-restoration` 20 场景通过：真实 NavigationContent + Sidebar 与 Browser Router，实际 Scope/Binding/Lease/View/Coordinator/Activation，仅物理 Host connect/acquire 隔离替身；桌面/390px touch、Draft/Thread/共享偏好漂移、ready/held、reload 与 Back/Forward。侧栏行通过真实 click/tap 走 `selectConversation`。不是完整账户/扩展 Supervisor、iPhone 或 Electron 实机验收。
- 初次 smoke 新增 Sidebar 后出现启动等待超时（未取得原因），重跑到侧栏点击时确定 exact accessible name 未包含 metadata，改为可访问名称前缀选择；补与现有真实组件 smoke 一致的 automatic JSX/React dedupe 和失败诊断，再通过全部场景。未因此改产品时序或加延时。
- Web 类型检查、包边界/typography 检查、定向 docs-impact、全仓文档系统校验（26/26 服务、2964 文档、无未登记失效链接）与 scoped whitespace 检查通过。未运行完整产品 gate/构建，不能宣称完整发行验证。
- 正式结论回写 platform-architecture、design/invariants 与映射 agent-gateway-runtime，维护 Skill影响为边界集中、取消/失败一等化与真实按钮验证，而非全局新服务或照搬参考页面 key。

## handoff / checkpoint
源码实现及隔离验收完成；沿用已有资源引用修复，收敛剩余 UI 语义与异步提交资格。正在运行的预览未替换、后端未重启，无提交/推送。后续若授权交付，再做构建/预览替换与完整启动及手机验收；当前不能刷新正在运行的旧预览来验证本次源码。

## preview_delivery_authorization / context_receipt
用户最新授权“替换预览”。重新读取根/OpenCraft AGENTS、maintenance Skill/verification、自托管预览 Skill、构建矩阵 headless/Web contract、publish 脚本与相邻发布测试。Context Router因 deployment 命中 release-gitops，已读 must_read，但本次仅临时本机预览，不改 GitOps/云资源。已读 frontend-runtime 邻接卡，检查实际静态发布脚本/测试/metadata 邻居。
当前实际预览为 `20261005-ssh-flex-thread-ring`，PID 576109 / `opencraft-ssh-flex-20261005-preview.service`，root `/data/opencraft-ssh-flex-preview-0EUz5Y/opencraft-server`，runtime SHA256 `2338489dae0cf063e20dd910ee7bbf59443a66661fd0a82b288bd338fc843329`。data root仍为既有私有数据，不读凭据。此前 SSH task 已明确授权整体 dirty 工作区临时预览；本次延续该 checkout 构建前端，保留既有功能，不将其他改动认领为导航修复。
只发布前端，不切换/重启后台进程，不改持久安装指针。隔离候选目录 `/data/opencraft-navigation-preview-l5qv5Y`，先保留旧 Web，再用既有 publisher 的 immutable asset/atomic mutable entry 方式更新实际 web root；失败从旧 Web 回退。`/health`、`/healthz` 不是本服务健康入口，实际 `/__opencraft_health` 返回 ok；一次限定路径检索 cwd 错误后按已知 OpenCraft 根纠正，不扩大扫描。
当前阶段：候选构建和发布门禁中，尚未切换。

### preview_checkpoint
候选 headless 前端构建完成，buildId `20261005-navigation-ownership-l5qv5Y`，headless metadata 断言通过；10 项 Web 发布/缓存/网关测试通过。旧 Web 已完整备份至 candidate 的 `previous-web`，运行后台仍未变。
新建完整产物浏览器验证脚本的前三次失败是验证入口定位问题：前两次点到设置的 Chat 分类，导致进入 `/settings/chat` 而非应用聊天；截图证明无 pageerror。改为限定 Applications nav 后，第三次只等待 trigger，而已展开布局隐藏 trigger；改为等待实际 nav 或 trigger 可见，不修改产品行为/延时。当前重新验证中，尚不算发布完成。

### preview_delivery_result / final_checkpoint
- 新验证入口还需处理触控布局中整个 sidebar 已隐藏；采用实际 Show sidebar → Applications → 应用 Chat 的序列（不改产品）。完整候选及切换后的完整应用各在桌面和390px触控通过 Settings reload → Chat → Back → Forward，无 pageerror，无推理请求；外部控制面请求在验证中拦截。截图与发布脚本、回退备份和来源记录在 `/data/opencraft-navigation-preview-l5qv5Y`。
- 发布成功：buildId `20261005-navigation-ownership-l5qv5Y`，旧版本 `20261005-ssh-flex-thread-ring`；逐项 HTTP 核对456个manifest资源的SHA256，index匹配候选、no-store、hash assets immutable、旧入口仍可用。未触发回退。
- 重要修正：本轮发布新增hash资源0、复用477；旧Web备份与候选manifest SHA一致（`a333220b56568582a3d97922d9b4ca1b720cccc6e0b6a568f1a7bc03b4d53c0c`），入口都是 `a-DKG0FVWG.js`，旧chunk已经含事务 `selectConversation`、Sidebar语义适配与inactive Draft guard。因此此前另一轮整包dirty预览已纳入同一份导航源码；不能声称这些行为是本次发布才首次上线。本轮完成重新构建、entry/版本标识切换与实际产物核验。
- 80端口仍为PID576109，unit `opencraft-ssh-flex-20261005-preview.service`，NRestarts=0、active；runtime SHA256仍为 `2338489dae0cf063e20dd910ee7bbf59443a66661fd0a82b288bd338fc843329`，health ok/appServerConfigured true。后台、数据、SSH配置与持久安装指针均未改动。
- 此次是既有headless包的Web overlay；原归档/整包manifest仍描述初始包，不重写它假装新整包。新的 provenance 单独记录前端构建和核验。没有提交/推送/GitOps操作。
- 手机实机与公司HTTPS入口仍须用户刷新验收；本机浏览器验证不冒充用户手机回执。
- 交接前文档系统校验通过；尝试读取公司HTTPS `/version.json`，本机连接443立即失败（HTTP000），不声称网关侧已验证。实际本机80端口已完成版本/资源/健康和浏览器链路验证。
完成：用户可刷新当前预览使用；若需要回退，使用该目录的previous-web和同一publisher恢复旧entry/public资源，不重启后台。

## git_delivery_checkpoint
用户于 2026-10-05 明确授权“提交推送合入master”。原分支属于 launch-token 任务且工作区包含大量无关修改，因此从最新 origin/master 040af895f 建立隔离分支 fix/opencraft-navigation-ownership-20261005，仅提取导航源码、测试、脚本和正式文档共14个文件；未覆盖 master 新的嵌入启动、账户、模型和会话记忆隔离契约，未加入 SSH/移动端/设计系统等混合改动。
隔离分支使用自己的 npm ci 依赖：48项导航测试、20场景桌面/触控 Browser Router smoke、25项相邻嵌入/Host/Fork/首次提交测试、Web类型检查、边界/typography、Web与preview-bridge构建、staged docs-impact、文档系统、敏感信息和whitespace检查通过。未重复完整产品gate、iPhone/Electron或真实账户/模型验收。
提交 e0c1f1b37（fix(opencraft): unify conversation navigation ownership）已推送同名功能分支；远端允许普通 fast-forward，master 已从040af895f更新到该提交，无强推、无GitOps/公开镜像操作。重新fetch后 origin/master 为 e0c1f1b373d332519cf35c19a9ce2c547ad42677，包含关系校验通过，隔离分支工作区干净。原共享工作区与原分支保留，后台/预览未重启。Git交付完成。
