# 升级套餐等待状态

## 全量复核收敛（2026-09-12）

- local_submission（提交前记录）：用户查看37文件范围、提交信息和验证结果后明确回复“确认”，授权“完善升级异常恢复与提示 / fix(frontend): refine upgrade checkout recovery”的本地提交，包含上轮32文件增量及本轮优化；不推送、更新MR、合并或发布。下方等待验收状态为实现阶段记录，最终提交状态以Git为准；本次仅更新提交状态文档，不修改业务实现。
- goal / approval：用户确认修复全量review的五项：迟到支付响应、普通首次Pass读取卡住、失败终态轮询、首次弹窗询价兼容、空resume分支。
- decisions：沿用现有恢复与请求身份机制；正常modifying无60秒交付期限，确认本地失败终态停止自动读取并保留显式刷新。首次普通查询超时显示通用套餐查询提示，不能标记为升级或支付失败。
- current_design / history：`frontend/openspec/specs/pass-upgrade.md`；当前HEAD b55ee6a0c，上轮32文件未提交增量保留，历史状态记录不替代本节。
- context_receipt：根/frontend AGENTS、subscription-entitlements、site-environment-routing、frontend-runtime-openspec-i18n邻接、现有plan顶部与升级spec；读取既有runtime摘要发现停留在旧push，按当前Git与用户请求校正。FEAI global规则文件缺失；graph索引不存在，按已定位源码有界检索，不创建索引。
- scope：支付弹窗与测试由S1实现者负责；Provider、页面恢复、资格死分支、规格与集成由主agent负责，互不覆盖文件。UI与无障碍技能要求复用按钮、可访问错误提示和确定的刷新操作。
- validation：新增失败回归先RED再GREEN；前端双站聚焦测试、类型/i18n与双站build、生成副本、文档/实际差异检查。无真实支付或发布，CI与类型基线不修改。
- evidence：初次新增5条回归按预期RED，Provider/页面/视图修复后40条通过。独立审查补出“首次查询重试拒绝后提前展示Bot”和“迟到手动状态响应/微任务错误重新影响旧支付”，均以组件回归先RED再修复；Provider三文件最终42条、支付两文件59条通过。S1/S2/S3分项复核均通过，支付准备中两处重复捕获按等价性核验删除。
- checkpoint：本地实现和验证完成，等待用户验收；37个未提交文件包含上轮32个文件的已有增量，未暂存、提交、推送或更新MR。最终国内294通过/1区域跳过，国际270通过/6区域跳过；双站build exit0，97/607静态页、8/42公开路由检查通过。恢复next-env生成路径后pnpm check仍为174 current / 276 baseline / 0 new；副本127文件、文档/实际37文件影响和diff检查通过。没有lint脚本，保留既有翻译告警和全量测试边界，未执行真实支付、浏览器多标签或远端CI验收。
- review：S1/S2/S3分项及最终全分支只读审查Approved，无本轮新增阻塞；最终审查覆盖移除两处重复catch后的代码与字典共享差异。另核实基线b3184f39a已有恢复限制：支付URL/授权请求始终pending时，轮询虽确认取消，busy/inFlight仍等旧请求结束；当前五项未包含支付在途锁重构，该限制保留并向用户披露，不能宣称所有旧有支付异常均已解决。

## MR3941 评审建议增量（2026-09-12）

- goal / requirement_refs：用户在核实 CR 建议后确认“把建议的改了”；执行 `frontend/openspec/plan.md` 顶部 R1–R3。
- non_goals：不修改支付窗口打开方式、60 秒恢复阈值、后端支付渠道、CI / 类型基线；不提交、推送、发布，不动原5176预览。
- history_context：当前 HEAD b55ee6a0c，工作区干净；当前规则为 `frontend/openspec/specs/pass-upgrade.md`，最近提交已补齐 vendored 副本。本文下方旧记录只作历史证据。
- interface_refs：`billing-error.ts` 兼容已有 resolver 调用；升级显式注入当前 useT。未知后端错误不可当成已翻译消息直出；前端本地校验提示须保留。订单创建、支付回跳、恢复与交付 contract 不变。
- acceptance / validation：真实语言测试覆盖已知/未知异常与本地校验；轮询测试无真实3秒等待；相关双站回归、类型/i18n、构建、生成副本和文档检查。真实支付与真实双标签浏览器竞争另行验收，不把单测称为该验证。
- affected_paths：frontend billing-error、升级弹窗 / 测试、SubscribePage 升级询价、升级常量与 Provider、i18n；对应 OpenCraft 标准生成副本及规格文档。
- required_context / context_receipt：已读根/frontend AGENTS、site-environment-routing Pack、frontend-runtime-openspec-i18n 邻接、Task/Checkpoint 模板、当前升级计划、i18n runtime / 生成脚本及组件测试。FE-AI global.md 与 runtime active slice 在本分支缺失，按根 AGENTS、既有 OpenSpec 和 gate-verification 执行，不补造流程配置。
- decisions：选择 opt-in 本地化，避免改变新购/续费既有错误语义；常量整理保持值与 URL 不变；不采纳已证伪的两项 P0 建议。
- context_receipt（共享副本）：同时读取OpenCraft AGENTS、MONO2_MIGRATION和同步脚本，正式runtime设计与升级OpenSpec；二次路由仍命中site-environment-routing。标准同步不修改生成算法。
- evidence：新增核心回归先11失败/39通过，修复后50通过；最终国内275通过/1区域跳过，国际251通过/6区域跳过。27条新增提示覆盖7份语言字典；pnpm check 174 current / 276 baseline / 0 new，原有49告警/172印尼语缺项保持。双站构建97/607页通过。OpenCraft 127文件漂移检查通过，完整gate 852测试及多端Web/JS bundle通过。
- validation：文档和实际32文件变更影响检查通过，正式runtime设计需maintainer review；缺少lint脚本如实记录，不修改检查器。之前的`--base-ref HEAD`空集合检查未当作未提交变化的证据。具体命令在既有verification-ledger及计划中保留。
- handoff：32个文件的本地增量完成、未暂存或提交、未推送或更新MR。新购/续费旧调用语义和支付/恢复规则保持；原5176预览不变。未执行真实支付、登录态浏览器或真实双标签页验收，历史全量失败继续独立处理。

### Checkpoint：评审建议增量

- stage：本地验证完成，等待用户验收与下一步提交授权。
- verified：R1–R3已有本轮测试、类型/i18n、双站构建、生成副本及完整OpenCraft gate证据；CI/checker/依赖/锁文件无改动。
- unverified：真实支付、真实浏览器多标签页竞争、远端CI和生产发布。
- discard：两项已证伪P0建议、旧原始网络错误直出断言、空变更集的影响检查结果。
- restore：clean工作区、HEAD b55ee6a0c、当前plan顶部和本节；保留所有未提交增量。
- next_action：向用户交付本轮结果，不自动提交或推送。

## MR3941 OpenCraft 副本补齐（2026-09-12）

- requirement_refs：用户确认修复截图中已核实的 vendored 同步遗漏；只生成副本并验证，不提交、推送、评论或修改 CI 检查规则。
- current_design_refs：`opencraft/MONO2_MIGRATION.md`；执行计划为 `frontend/openspec/plan.md` 顶部 V1–V2。
- context_receipt：根 / frontend / OpenCraft AGENTS；frontend 服务、site-environment-routing must_read；frontend-runtime-openspec-i18n 邻接；OpenCraft 同步脚本、迁移约定、package scripts。前轮调查结果保存在忽略的 runtime investigation 中。
- scope：Dialog、8 份生成字典 / 映射、HTTP Repository 副本及 UPSTREAM 清单。字典与 Repository 漂移在原 MR 基线已存在，本 MR 新增 Dialog 漂移并进一步更新源字典；不修改 frontend 真源或同步算法。
- acceptance：使用标准同步脚本，漂移检查从 exit 1 转为通过；保留平台适配；运行 OpenCraft gate，记录未通过项而不修改检查器。
- documentation_impact：生成副本触发 Agent runtime 文档映射；正式文档 `docs/engineering/domains/agent-gateway-runtime.md` 补充共享 Dialog / i18n / Repository 消费及升配数据降级的权限边界。检查规则保持不变。
- evidence：同步检查先因 Dialog drift 退出 1，标准生成后全部 127 文件通过。OpenCraft gate 最终 exit 0，类型 / 平台边界、852 项测试及 Web / Expo Web / iOS JS bundle 均通过；frontend 聚焦 95 passed / 1 skipped，pnpm check 174 current / 276 baseline / 0 new。文档 / 实际 15 文件影响 / diff 检查通过，正式文档仍需 maintainer review。
- environment：npm 共享 cache 权限问题通过临时独立 cache 解决，版本与锁文件不变。首次 gate 的终端用例因新装 node-pty spawn-helper 缺少执行权限失败；仅修复本地 node_modules 权限后，定向用例及完整 gate 复跑通过，未调整源码或测试断言。
- handoff（提交前记录）：11 个机械生成文件及 4 份文档已本地更新，用户已确认仅提交到本地；不推送、更新 MR、评论、合并或发布，最终提交状态以本地 Git 记录为准。单 Agent 复核；未执行真实支付、登录态浏览器验收、iOS 原生编译或远端 CI 查询，5176 原预览工作树未改动。

## MR3941 CR 优化（2026-09-11 提出，2026-09-12 验证）

- requirement_refs：用户提供 `CR-MR3941.md`，先要求设计方案，再确认“优化一轮”；2026-09-12 进一步确认仅提交本轮 18 个文件到本地，不推送或更新 MR。
- current_design_refs：`frontend/openspec/specs/pass-upgrade.md`，活动任务为 `frontend/openspec/plan.md` 顶部 CR1–CR3；历史方案保留在下文。
- decisions：采用“防护回归 + 异常恢复 + 刷新协调”；单补测试会保留持续 loading，环境渠道治理和全站 Dialog 本地化留给独立任务。不恢复 show 或域名白名单，不触碰后端渠道配置。
- interface_refs：保持 `Pass` / `PassOrderStatus` 与 Repository API 不变；Provider 暴露暂停、刷新中、返回确认状态和同单 `retryPassUpgrade`，现有 `refreshPasses(): Promise<void>` 调用方式兼容。
- acceptance：连续 60 秒套餐缺失 / 查询失败 / 请求卡住后停止自动查询，保留订单并提供刷新与支持入口；正常 modifying 无 60 秒交付限制。暂停、注销、换账号淘汰旧请求；刷新去重时手动调用等待一次补查。过期 modifying 保留界面等待状态，不授予有效权益。
- context_receipt：本轮重新读取根 / frontend AGENTS、subscription-entitlements、frontend-runtime-openspec-i18n 邻接、frontend OpenSpec config 与本任务 plan / spec；核对 Provider、相邻组件测试、i18n 生成脚本及服务条款支持邮箱。既有 linked worktree 干净，继续原 clean 分支，不动主工作树和 5176 预览。
- evidence：基础3文件17条通过；新增 M4/M5 用例在移除对应校验后分别失败，恢复校验后通过。异常暂停 / 刷新合并 / 身份切换5条先红后绿；卡住请求和注销清理2条先红后绿；视图恢复2条和页面接入1条先红后绿。复核补齐卸载取消的 RED/GREEN 及 StrictMode 回归，最终4文件40条通过；pnpm check 174 current / 276 baseline / 0 new。
- risks / validation：UI 超时不得判定扣款失败；只用服务端交付结果解除 Bot 等待。国内13文件183条、国际12文件164条通过；双区域构建生成97 / 607页、公开路由检查8 / 42条通过；文档 / 真实变更集影响 / diff 门禁通过。原有 jsdom window.open 提示、49条翻译告警和172条印尼语缺项未扩大；不执行真实支付，不修改历史全量测试失败及质量基线。
- handoff（提交前记录）：18个文件的优化已完成，用户已确认本地提交；单 Agent 复核、组件级交互验证，未声称真实支付或登录态浏览器验收。不推送、合并、归档或发布，5176 原预览工作树未改动；最终提交状态以本地 Git 记录为准。

当前规格已同步至 [升级套餐交互](../../../frontend/openspec/specs/pass-upgrade.md)，验证与变更汇总见 [OpenSpec 变更记录](../../../frontend/openspec/changes/2026-09-11-pass-upgrade-interaction.md)。本 Task Pack 保留逐轮演进证据，初始 decisions / handoff 不代表后续调整后的最终展示规则。

## goal
Pass 进入 `modifying` 后保留套餐信息，Agent 页面展示参照现有创建咖啡插画的升级等待视图，完成后自动恢复 Bot。

## requirement_refs / requirement_excerpt
- 当前任务用户补充（2026-09-11）：升级中展示套餐信息；`modifying` 使用 loading；参考“正在给 Agent 喂咖啡”，升级完成后再展示 Bot。
- 范围：国内与国际站共用的账户与 Agent 页面。

## non_goals
- 不改变升级价格、合法目标和支付接口；不改造整个套餐目录或历史订单恢复策略。升级入口的控制台展示开关按用户后续要求移除，见末尾增量记录。

## interface_refs / data_structure_refs
- `frontend/src/domain/types.ts`：`Pass.status`、套餐名、积分与到期时间。
- `GET /v1/passes` 是升级状态来源；只有同一 Pass 明确返回 `active` 并成功刷新 Bot 快照才结束等待。
- 空响应、缺少状态、网络失败均保留等待与最近一次套餐信息。

## decisions
- 使用现有 `hermes-loading.png` 咖啡插画、轻浮动动效和项目主题 token；不展示无服务端数据支撑的百分比、预计时长或目标规格。
- 展示当前套餐名、总积分、到期时间，说明升级完成后更新，到期时间不变。
- 账户页显示“套餐升级中”，升级期间不展示续费操作；进入账户/Agent 页重新查询权益。
- Provider 在升级中每 3 秒查询，完成后更新套餐与 Bot 快照并停止轮询。
- 减少动画偏好下静止显示；插画离开视口后暂停循环。

## acceptance / validation
- 组件测试覆盖 modifying 时套餐可见、Bot 操作隐藏、active 后恢复。
- Provider 测试覆盖刷新恢复、缺失与失败响应重试、Bot 快照刷新前保持等待、完成后停止轮询。
- `pnpm check`、相关 Vitest、`git diff --check`；桌面与移动端 mock 预览。真实支付不在本次验证范围。

## affected_paths
- `frontend/src/contexts/agent-context.tsx`
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/agent-upgrading-view.tsx`
- `frontend/src/pages/marketing/account-page.tsx`
- 相邻测试与 i18n 生成字典。

## context_receipt
| 文件 | 用途 |
|---|---|
| `frontend/AGENTS.md` | 前端边界与验证要求 |
| `docs/context/domains/subscription-entitlements.md` | 保留服务端权益状态权威 |
| `docs/context/flows/tapd-gongfeng-delivery.md` | clean 分支交付的用户授权、工蜂操作及提交 / 发布边界 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | 检查生成字典与相邻测试 |
| `frontend/DESIGN.md` | 卡片圆角、排版、动效与状态可访问性 |
| `AGENTS.md` | 本次文档同步的源码优先、目录与确认边界 |
| `docs/context/domains/site-environment-routing.md` | 双站独立验证与前端展示权限边界 |
| `docs/context/project/services/frontend.md` | OpenSpec 当前规格所在位置 |
| `frontend/openspec/config.yaml`、`frontend/openspec/plan.md` | 定位本需求与保留已有计划 |

## handoff
已实现。108 条相关测试通过，`pnpm check` 无新增类型错误，国内站 `pnpm build` 通过。
桌面 1280×720、移动端 390×844 的本地 mock 预览已确认套餐可见；模拟 active 后自动恢复 Bot，账户页同步新套餐。
截图位于本任务的 `upgrade-plan-interaction-audit` 产物目录。未执行真实支付、提交、推送或发布。

## 增量：升级操作卡片与新购支付对齐

> 以下第一轮三步弹窗方案已被用户最新提供的两张截图替代，最新要求与验收见文末。

用户追加要求：按照项目设计规范优化升级操作卡片，支付交互与新购保持接近。

### 方案与实现
- 保留新购的确认订单 → 扫码 / 信用卡支付页 → 自动确认结果的顺序，升级多一个真实交付等待状态。
- 使用现有 Dialog / Button 和主题 token；固定标题、三步进度与底部操作区，中间内容滚动。桌面操作右对齐，手机按钮通栏。
- 确认阶段完整展示当前与目标套餐、目标 CPU / 内存 / 存储 / 积分、原到期日、含税实付补差价和支付方式。
- 支付阶段压缩为套餐摘要，继续保留配置、金额、税费和到期日，为完整二维码留出空间。
- 国内使用现有微信中转页，增加“刷新二维码”，只刷新同一订单的支付授权。保留原有自动刷新和结果轮询。
- 国际站在用户确认点击内打开占位窗口，取得 HTTPS 支付链接后跳转；弹窗被拦截时保留“前往支付”。询价变化、零元单或错误会关闭未使用的占位窗口，不跳走当前升级页面。
- 已支付阶段不再显示付款入口，使用现有咖啡插画和升级等待提示，仍以服务端交付状态与目标 Pass 生效共同判定成功。
- 遮罩点击不关闭；保留 Esc 与关闭按钮，补充本地化关闭标签和键盘焦点样式。

### 增量验证
- 7 个相关测试文件、79 条测试通过；覆盖套餐金额持续可见、扫码刷新同单、国际站支付页与弹窗拦截、重新询价、未知提交防重、支付后等待交付、键盘与遮罩行为，以及账户 / Agent 相邻回归。
- 本地浏览器使用真实 UpgradePassModal 与项目样式，替换账单接口为明确标识的模拟数据；覆盖中文桌面 / 手机确认和扫码、手机升级中、国际站英文手机确认与支付入口。
- 390×844 手机页面无横向溢出，二维码完整可见，未点击或扫描真实付款二维码。
- 临时预览入口与模拟模块已删除，开发服务器已停止；截图保留在任务产物目录。
- 最终 `pnpm check` 通过（174 个已有类型诊断，276 基线，0 新增）；国内站 `pnpm build:cn` 通过。构建生成的 `next-env.d.ts` 路径变更已恢复，不混入需求差异。

## 最新方案：按用户截图简化为两步
- 视觉基准：用户提供的确认订单和微信扫码两张截图，仅作参考，所有内容与控件用真实 DOM 实现，不嵌入截图。
- 第一步：440px 白色弹窗，28px 内边距，标题“确认订单”和副标题“订单详情”；仅目标套餐名、CPU / 内存 / 存储 / 积分、实付补差价、微信支付行，底部等宽取消与支付金额按钮。移除当前套餐对比、到期日和步骤条。
- 第二步：同宽自适应高度弹窗，“请完成支付”、微信扫码说明、灰底二维码区域和全宽刷新按钮；移除套餐摘要、订单号和弹窗内升级步骤。
- 支付成功即跳转 /agents，先记录升级等待上下文，防止服务端仍返回旧 active 套餐时闪现 Bot；在 Agent 页继续等待目标套餐和服务端交付完成，再刷新 Bot。
- 国际站保持信用卡支付入口，沿用同样的精简确认与支付后跳转，微信图标复用新购实现；不新增图像资产、装饰或动效。
- 响应式：桌面居中，手机留 16px 安全边距；自然高度，内容可滚动，无横向裁剪。以用户截图优先于原多阶段固定高度规范。
- 验证目标：桌面与 390px 手机两阶段截图；支付前不跳转，paid 后立即跳转且不等待 Pass 请求；旧 active 不结束加载，目标 active + 交付确认 + Bot 刷新后才展示 Bot。

### 最新验证结果
- 桌面 1280×800、手机 390×844 已核对两步真实组件布局，保存 `simple-confirm-*`、`simple-pay-*` 截图。根据全局段落 margin 重置的实际样式，用容器间距保证标题、配置和扫码提示留白。
- 浏览器模拟 paid 后进入 /agents 并显示咖啡升级加载；旧 active 保持等待，目标 active + provisioned + 新 Bot 快照返回后才解除等待。演示使用真实 Provider 和加载组件，Bot 完成态为模拟占位；正式 Subscribe 导航顺序由组件测试覆盖。
- 7 个相关测试文件、86 条测试通过。补充失败/取消交付提示、失败后恢复、Agent 页 Bot 隐藏，以及手动刷新 paid 后不再次读状态的测试。
- 独立审查的两处问题均已修复并复核：已付款订单在目标 active 检查前查询，失败时显示联系支持；手动刷新直接使用已确认的 paid 响应跳转。
- `pnpm check` 通过：174 current / 276 baseline / 0 new；新增文案各语种已补齐，id-ID 原有172条未翻译不在本次范围。
- 检查与构建曾并行执行，导致共享 `.fumadocs-content/docs` 目录 ENOTEMPTY；确认两命令均重建该目录后改为串行执行，不改构建脚本。
- 串行国内站构建 `NEXT_PUBLIC_REGION=cn VITE_REGION=cn pnpm build` 通过：97个静态页面生成，8条公开路由SEO检查通过。
- 本轮报告为任务产物目录的 `checkout-simple-validation.html`。临时模拟入口、模块和5186预览已删除/停止；5176真实API预览继续运行。未执行真实支付、提交、推送或发布。

## 国际站增量：卡支付与新购跳转一致
- 用户已指定：第一步信息和国内站一致，仅支付方式为“卡支付”；点击支付打开外部页面；付款后进入 Agents 升级加载。
- 实现顺序：先补测试；卡支付文案与新购窗口/拦截回退对齐；成功 return_url 指向 /agents；补独立支付返回上下文及 Provider 恢复；运行相关测试、国际化检查和国际站构建。
- 回跳仅保存用户隔离的订单号、Pass ID、目标套餐与时间戳，不保存支付授权或支付 URL；24小时有效。URL 只携带订单标记，不能凭标记判定支付/交付成功，仍检查服务端订单与目标 Pass。
- 国内微信扫码路径保持不变；取消支付返回原订阅页，不进入升级加载。
- 国际站原窗口轮询确认已支付后也携带同一订单标记进入 /agents，支持升级期间刷新；独立支付返回页和原窗口使用同一恢复路径。
- 独立审查复现“原窗口刷新丢失等待”和“旧 Bot 快照晚到覆盖升级结果”两项，均先添加失败测试再修复；返回上下文只在完整交付后清理，Bot 快照统一请求代次。审查复核无新增阻断。
- 最新回归：10个测试文件、130条通过（含国内/国际新购相邻用例、升级弹窗、返回上下文、Provider和账户/Agent页）；`pnpm check` 通过，174 current / 276 baseline / 0 new。
- 真实组件模拟预览验证：中文桌面440px确认框、英文390px手机确认框均无溢出；外部支付模拟后从全新 /agents 页面恢复咖啡升级加载，目标交付完成后更新模拟 Agent 并清理返回标记。截图与报告使用 `intl-card-*` 文件名。
- 临时5186模拟服务、HTML和模块已清理；保留5176国内预览。没有执行真实扣款、提交或发布。
- 国际站 `pnpm build:global` 通过：607页静态生成、42条公开路由SEO检查通过。构建生成的 next-env 类型路径已恢复，`git diff --check` 通过，5176 /subscribe 返回200（仅可用性检查）。

## 圆角对齐新购弹窗
- 对照新购确认订单 / 卡支付 / 微信扫码弹窗，升级流程固定使用外层16px、订单与支付方式内框12px、二维码 / 支付状态容器12px、底部操作按钮8px；不改支付逻辑及全局主题。
- 5176页面运行时读取到 `--radius-xl: 1.8rem`、`--radius-lg: 1.35rem`，根字号16px，原语义类实际为28.8px / 21.6px。升级组件改用明确像素类，避免主题覆盖造成与新购的固定圆角不一致。
- 新增国内 / 国际两步圆角回归，升级弹窗26条测试通过；浏览器CSSOM确认预览已包含8px / 12px / 16px规则。未发起真实支付。
- 本轮 `pnpm check` 通过（174 current / 276 baseline / 0 new），`git diff --check` 通过。

## 点击升级按钮先询价
- 用户指定：将初次询价 loading 从弹窗移动到“升级至此套餐”按钮，得到完整报价后再打开弹窗。
- 国内 / 国际共用 SubscribePage 点击询价，按钮内显示已有加载图标和“正在查询升级差价...”，禁用重复点击；校验来源套餐、目标ID、币种及金额后将该报价传入弹窗，首屏不再重复请求。
- 询价失败在对应按钮旁显示可读错误，按钮恢复；请求标识隔离迟到响应，切换积分档位、计费时长、登录身份或离开页面后旧请求失效。支付前仍重新询价，金额变动要求再次确认，现有支付及 Agent 升级加载逻辑不变。
- TDD：新增按钮状态 / 迟到响应等8个用例及双站弹窗首屏2个用例，先确认旧实现失败再修改；国际站回跳用例追加报价前不弹窗检查。相关6个文件98条测试通过，包含新购相邻流程、升级资格、返回上下文和 Provider。
- 独立审查无 Critical / Important 阻断；按建议补充“取消旧请求后启动新请求，旧响应不能清除新 loading 或覆盖新报价”测试，相关6个文件最终99条通过。
- `pnpm check` 通过（174 current / 276 baseline / 0 new）；国内 / 国际构建通过，分别生成97 / 607页、完成8 / 42条公开路由检查。构建生成的 next-env 类型路径已恢复。本轮通过组件测试验证交互，未执行真实支付、提交或发布；5176保持国内预览。

## 创建升配订单也使用按钮 Loading
- 用户追加：点击第一步支付按钮后，订单创建 loading 留在该按钮，创建完成才进入二维码支付。
- 增加仅表达首轮提交过程的 submitting 状态：价格复核、创建订单、准备二维码 / 卡支付链接期间保留确认页信息及金额，支付按钮显示原有“正在处理...”及加载图标，禁用重复提交与取消；有效支付内容就绪后切换第二步。
- 订单 record、跨页防重、支付前金额变动再次确认、同单支付授权重试、未知 / 失败提示与支付成功进入 Agents 的逻辑保持不变；后续刷新支付不会重新进入第一步。
- 双站测试分开挂起创建订单和准备支付两个请求，确认每一阶段都保持第一步与按钮 busy，仅准备完支付内容后进入第二步；29条弹窗测试、相关6文件100条回归通过，pnpm check 通过（174 current / 276 baseline / 0 new）。本轮未执行真实支付。
- 本次国内构建通过（97页静态生成、8条公开路由检查），独立只读增量审查无阻断项；构建生成的 next-env 类型路径已恢复。未提交或发布，保留5176国内预览。

## 升级加载页展示目标套餐
- 用户指定：移除模型积分，将当前套餐替换为目标套餐，保留到期时间。
- AgentUpgradingView 通过当前 Pass 的 getModifyCheckout 与无询价参数的 listBundles 读取目标 ID 和名称，使用现有排版、边框与咖啡动画；不使用旧 Pass 的 bundle_name 冒充目标，不修改支付和交付判定。
- 元数据暂缺 / 请求失败时显示“—”并在3秒后重试，成功后停止；卸载或用户 / Pass 切换会取消重试并忽略迟到响应。目标套餐文案同步6个翻译语种，繁体按项目转换规则生成。
- TDD 新增5条组件用例，旧实现因仍显示当前套餐 / 模型积分而失败；实现后页面、Provider、双站支付等8个文件113条测试通过。pnpm check 通过（174 current / 276 baseline / 0 new），已有49条翻译告警和172条印尼语缺项未扩增。未执行真实支付。
- 国内构建通过（97页、8条公开路由检查），独立只读审查确认 checkout 支持 paid_pending_provision 订单并无实际阻断项。构建生成的 next-env 类型路径已恢复；5176 /agents 返回200仅用于确认可用性，本轮交互以组件测试为证，未提交或发布。

## 合并 master 与本地交付
- 用户已确认保存本次26个文件，合并最新 master 后恢复并处理冲突，验证后仅提交本地，不 push / 创建 MR / 发布。
- 当前分支 frontsandbox/upgrade-interaction 已从 b4842ce2c 快进到最新拉取的 master ac29594cac4feb07070c244e2ea6882f8fa8b705，共20个上游提交；原 checkout 未改动。本轮合并前备份保留在 stash d5bb458ec3fd9639e6dd83b1853df2357d9f0d16。
- agent-settings-page.tsx 自动合并保留双方逻辑；计划文档保留双方新增章节；5份翻译冲突保留本功能新增文案及 master 的定时任务译文，重新运行 i18n extract / zh-hant。8份生成文件逐 key 核验 lostMaster / lostFeature 均为空，master 的 PASS_MODIFYING 实例回退逻辑及测试保持原样。
- 合并后15个相关测试文件517条通过、1条原有跳过；pnpm check 通过（174 current / 276 baseline / 0 new），国内 / 国际构建分别生成97 / 607页并完成8 / 42条公开路由检查；独立只读合并复核无阻断项。保留已有翻译告警与缺项，未执行真实支付。
- 提交信息：优化升级套餐交互 / feat(frontend): simplify plan upgrade checkout。

## 升级入口默认展示
- 用户追加：升级入口不再需要调用 show() 解锁。删除升级专用 pass-upgrade-rollout 模块及旧开关测试；国内与国际共用资格查询和确认弹窗直接保留登录判断，不再按域名或控制台开关隐藏。
- 保留计费启用条件、Pass 归属 / 有效期 / 状态、后端合法目标、支付前复核及交付判断；其他功能的 show() 注册与行为未修改。
- TDD：先复现四个生产域名资格查询和双站弹窗共6条失败；实现后7文件123条回归通过，包含匿名与业务关闭保护、双站订阅 / 支付 / 账户和其他隐藏入口。pnpm check 通过（174 current / 276 baseline / 0 new），独立只读审查未发现问题。
- 5176 /subscribe 返回200仅验证预览可用性；本轮交互以组件测试为证，未重新构建或执行真实支付。本轮增量尚未提交，未推送或发布。

## OpenSpec 同步

- 按用户要求新增升级当前规格及变更记录，从 spec、套餐 / 营销模块与 config 连接到该规格；保留其他需求和逐轮历史验证。
- 本次仅改文档，业务源码及上一轮待提交 diff 保持原样；重跑9个相关测试文件132条通过。文档校验、链接与差异检查结果记入对应 OpenSpec 变更记录，不执行提交 / 发布或真实支付。
