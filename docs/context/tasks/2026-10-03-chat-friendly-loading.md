## goal
将 Chat 首屏朴素的加载提示改为温暖、活泼的 AI 小助理等待状态，并统一 launch token、SDK lazy chunk 与嵌入式工作台初始准备阶段的视觉。

## non_goals
- 不改变对话启动、连接、认证、会话选择、超时或重试机制。
- 不替换错误、暂停与重连的真实状态提示。
- 不新增位图、动画库、生产配置或发布动作。
- 本次尚未获得 Git commit、push 或 MR 授权；本地结果已可审阅，待确认提交与推送预览。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户请求（2026-10-03）：Chat 页面打开时的「正在加载对话...」不符合个人 AI 助理的产品调性，希望改得活泼可爱，并加图案或动效。
- OPT-009：[TAPD 卡片 1070234090138744537](https://tapd.woa.com/tapd_fe/t/index/70234090?workitemId=1070234090138744537)，项目 `70234090`「Vela体验优化」。
- 独立分支：`frontsandbox/chat-friendly-loading-20261003`；根代理已创建卡片并回读初始「进行中」，入队/开始评论尾号分别为 `3797`/`3798`。用户已回复「确认提交并推送预览」，本次授权范围已交付，当前 `pending_user` 等待 MR 确认；root 已将 TAPD 移至「待确认」，流转评论 `1070234090217814055`、最终构建证据评论 `1070234090217814062`，回读待确认分组 `3875`。

## interface_refs / data_structure_refs
- `frontend/src/components/site/chat-loading-state.tsx`：共享初始等待状态，包含文案、装饰头像及状态播报。
- `frontend/src/pages/marketing/agent-avatar-shapes.tsx`：复用 `GeometricAvatar`、`blob` 与 `DEFAULT_AVATAR_COLOR`，通过 `alive` 启用现有动效。
- `frontend/src/pages/marketing/agent-chat-panel.tsx`：`launchTokenStatus` 的 `idle`/`loading` 及 `Suspense` fallback 统一使用共享组件；错误与 token 刷新 contract 不变。
- `frontend/src/pages/marketing/opencraft-embedded-workbench.tsx`：`presentedOwner === "loading"` 且没有异常/连接提示时显示共享组件；已进入对话后的重连、超时、暂停与失败继续显示真实消息。
- `frontend/src/styles.css`：已有头像 keyframes 与全局 reduced-motion 规则，无需新增 CSS 动画。
- `frontend/src/i18n/index.ts`、`frontend/scripts/i18n-extract.mjs`、`frontend/scripts/i18n-apply.mjs`：中文即 key 与生成字典入口；本次新文案经这些入口同步。

## history_context
- `current_design_refs`：`frontend/DESIGN.md`、上述聊天宿主和头像组件；当前基线 `0c07c1202d40c5bbd6344bbeb39b9085a9e4dddf`。
- `relevant_evolution`：头像组件已支持橘橙色 blob 与 `alive`，相邻 `agent-avatar-motion.test.tsx` 已覆盖呼吸、眨眼、眼睛分组及 reduced motion；嵌入式工作台有独立的初始准备、真实错误与重连语义。
- `.agents/context/change-impact.json` 当前规则不覆盖本次 `frontend/src/components/site/` 或 `frontend/src/pages/marketing/` 的 UI 改动；仍按前端可复用模式约定补充 `frontend/DESIGN.md`，不更新无关领域设计。
- 队列历史来源：`/data/automation-test-task-cleanup-20260930` 中干净、已提交的 `c19ba07862eaf485e087efb05a61ea52a0c3712f` 队列，保留 OPT-001–008 全部历史。本地尚无其远端分支 ref，不据此宣称已推送；根代理实时 TAPD 回读用于校准 OPT-007 为待验收、OPT-008 为待确认及 OPT-009 入队时为进行中、交接时为待确认。
- `superseded_refs`：本分支初始队列只含 OPT-001–006，不能当作当前空队列；`/data/optimization-queue-worktree-20260929` 的更早未提交队列不作为校准源。

## acceptance
- token 等待、聊天 SDK lazy chunk 等待和嵌入式工作台正常初始等待都显示「你的 AI 小助理，马上就来」与「正在准备我们的对话」。
- 显示现有橘橙 blob 头像，启用轻量呼吸/眨眼，提供小星光装饰；reduced motion 下保持可读。
- 新状态具有礼貌状态播报，装饰图案不产生重复无障碍内容；窄屏和长译文不溢出。
- token 错误、连接失败、慢连接、Agent 暂停与重连保留当前消息和适用的重试按钮；不把异常包装成正常等待。
- 新文案覆盖所有已登记字典，并通过 i18n/check、测试、生产构建及聚焦浏览器截图验证。

## affected_paths
- `frontend/src/components/site/chat-loading-state.tsx`
- `frontend/src/pages/marketing/agent-chat-panel.tsx`
- `frontend/src/pages/marketing/opencraft-embedded-workbench.tsx`
- `frontend/src/pages/marketing/__tests__/opencraft-embedded-workbench.cn.test.tsx`
- `frontend/src/i18n/generated/`
- `frontend/DESIGN.md`
- `docs/context/tasks/optimization-queue.md`
- 本 Task Pack 与对应 checkpoint。

## required_context
- `service-frontend`、`frontend-product-surface`、`site-environment-routing`。
- `AGENTS.md`、`frontend/AGENTS.md`。
- `docs/context/project/services/frontend.md`、`docs/context/domains/site-environment-routing.md`。
- `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md`。
- `vela-optimization-queue` skill 与现有队列记录。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@0c07c1202` | 根入口；root 与文档代理实际读取 | P0、Task Pack、路由与交接边界。 |
| `frontend/AGENTS.md@0c07c1202` | 最近服务入口；root 与文档代理实际读取 | 复用组件、Tailwind、别名、验证与视觉证据要求。 |
| `docs/context/project/services/frontend.md@0c07c1202` | 路由 must_read；root 与文档代理实际读取 | 双站与生成资源边界；命令以近端服务入口为准。 |
| `docs/context/domains/site-environment-routing.md@0c07c1202` | 路由 must_read；文档代理实际读取 | 使用已有 locale contract、分站验证。 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@0c07c1202` | 前端邻接；root 与文档代理实际读取 | 精确查源码及 avatar/embedded 测试、i18n 生成邻居。 |
| `frontend/DESIGN.md@0c07c1202` | UI 模式规范；文档代理实际读取 | 新增共享初始等待规范。 |
| `.agents/context/change-impact.json@0c07c1202` | 正式设计影响映射；root 与文档代理实际读取 | 确认本次 UI 路径不触发领域设计联动。 |
| `docs/context/tasks/TASK-TEMPLATE.md@0c07c1202`、`docs/context/tasks/CHECKPOINT-TEMPLATE.md@0c07c1202` | 状态文档模板；文档代理实际读取 | 记录目标、验收、证据、恢复条件。 |
| `vela-optimization-queue/SKILL.md@2026-10-03`（runtime skill） | 本次队列工作；root 与文档代理实际读取 | 看板回读、逐项交付、授权与流转评论。 |
| `docs/context/tasks/optimization-queue.md@c19ba0786` | 较新完整队列；文档代理实际读取 | 保留 001–008 历史，实时 TAPD 校准后追加 009。 |
| `frontend/openspec/spec.md`、`frontend/openspec/plan.md@0c07c1202` | 有界规格精确查找；文档代理实际查询 chat/loading | 确认对话布局历史，不扩展首屏加载需求。 |
| `frontend/src/i18n/index.ts`、`frontend/vitest.config.ts@0c07c1202` | i18n 与测试邻居；文档代理实际读取 | 字典生成与组件验证入口。 |
| `frontend/scripts/i18n-extract.mjs`、`frontend/scripts/i18n-apply.mjs@0c07c1202` | 新文案生成入口；root 实际读取 | 按仓库流程同步字典，不手工猜生成结构。 |
| `frontend/src/pages/marketing/agent-avatar-shapes.tsx`、`frontend/src/pages/marketing/__tests__/agent-avatar-motion.test.tsx@0c07c1202` | 现有图案与动效；root 与文档代理实际读取 | 复用 blob、alive、橘橙默认色和动效验证。 |
| `frontend/src/pages/marketing/opencraft-embedded-workbench.tsx`、`frontend/src/pages/marketing/__tests__/opencraft-embedded-workbench.cn.test.tsx@0c07c1202` | 初始等待与异常分支；root 与文档代理实际读取 | 保留超时、错误、暂停与重连 contract。 |

## evidence
- 文档代理第一条路由查询 `frontend chat initial loading friendly assistant GeometricAvatar` 未命中；改用精确仓库路径后命中 frontend 服务、产品面与站点路由三个 Pack。
- 首次有界查询误用了 `components/site/agent-chat-panel.tsx`，路径不存在；在 `frontend/src/pages/marketing/` 的文件名查询定位真实宿主，不再扩大扫描范围。
- 分支 `frontsandbox/chat-friendly-loading-20261003`；基线 `0c07c1202`，功能提交 `2bfd749a5` 已推送并发布为双站预览。
- 根代理实时 TAPD 回读：OPT-007 [MR !4850](https://git.woa.com/wisp/mono2/-/merge_requests/4850)，源分支 `frontsandbox/agent-onboarding-suggestions-scroll-20260929` → `master`，已合入最新 master 至需求分支并复验、双站 HTTP 200，尚未合并 MR 或发布；OPT-008 待确认清理范围。
- 文档代理 `python3 .agents/context/scripts/validate_documentation.py --repo . --format json` exit 0：`errors=[]`、`warnings=[]`、一方断链 0；`git diff --check` 无输出。
- root 聚焦回归：7 个文件、115 个测试通过，命令 exit 0；本地 CR 无阻断项。仅更新现有 `opencraft-embedded-workbench.cn.test.tsx` 的两个加载文案断言，没有新增 `ChatLoadingState` 测试文件。
- root 完整 `pnpm check` exit 0：TypeScript diagnostics 为 166 current / 171 baseline / 0 new / 5 resolved。环境本地依赖问题已修复，没有为此修改源码或 baseline。
- root `pnpm build:cn` exit 0。国际站首次日志完成全部 SEO 与 postprocess，但执行结果为 exit 143，没有将首次结果表述为通过；最终单独重跑 `/tmp/chat-friendly-loading-build-global-final-20261003.log` exit 0（session `58649`），42 条公开静态路由 SEO 与全部 postprocess 检查通过。双站构建均通过。
- root 尝试完整 `pnpm test`，发生两次 V8 OOM、两 worker 超时以及多项未修改范围测试失败；最终停止 exit 143，没有完整测试汇总，不能判定这些失败属于 baseline。相关聚焦 115 个测试通过不能替代全量成功。
- root 真实浏览器组件预览：7 语言显示实际文本、320px 无溢出、头像使用 `lv-avatar-breathe`，reduced motion 下计算动画时长为 `1e-6s`，没有 JavaScript errors；证据 `/tmp/chat-friendly-loading-browser-20261003.log`。
- 聚焦截图：`/data/chat-friendly-loading-preview-20261003/chat-loading.png`、`mobile.png`、`desktop.png`。这是隔离的真实组件配现有样式的浏览器预览；Linux 截图以已有 bundled `ChuangJiHei` 作为字体 fallback，没有验证已登录生产完整链路。

## risks
- 长译文与较窄对话画布可能增加折行：限制内容宽度、允许自然折行，验收桌面与窄屏。
- 正常等待与失败共用宿主区域：保持异常优先级和重连提示，通过现有嵌入式工作台回归覆盖。
- 动效对敏感用户不适：仅复用已有轻量头像动效及 reduced-motion 全局覆盖。
- 全量前端测试没有完成且存在失败：保留失败和资源耗尽事实，未将其归为 baseline；合入前仍需调查并补全有效门禁。
- 组件浏览器证据未覆盖已登录完整 Chat 链路；源码未推送预览、生产未发布。

## validation
- 聚焦回归 7 files / 115 tests exit 0；本地 CR 无阻断。
- 完整 `pnpm check` exit 0，无新增 TypeScript diagnostics；国内生产构建 exit 0。
- 国际生产构建最终单独重跑 exit 0，42 条公开静态路由 SEO 与全部 postprocess 通过；首次 exit 143 不计为通过。
- 全量 `pnpm test` 未通过：OOM、超时和未改范围失败，停止 exit 143，无完整汇总。
- 浏览器组件预览已验证 7 语言、320px、动画与 reduced motion，无 JS errors；不作为已登录完整链路或生产验证。
- 文档门禁已由文档代理执行通过；待 root 执行 `validate_change_impact.py --repo . --staged` 与最终 `git diff --check`。

## decisions
- 使用共享 `ChatLoadingState` 消除不同初始准备阶段的文案/视觉跳变。
- 复用现有 SVG 头像与 CSS 动效；可爱感来自小助理图案和温暖文案，不新增资源请求。
- 本次只有营销聊天宿主与 site 复用 UI，不编辑 OpenCraft 运行时状态机或后端接口。
- 用户本次已明确回复「确认提交并推送预览」，允许提交和推送本独立分支；不将其扩展为 MR、合并或生产发布授权。

## scan_scope
- `frontend/src/pages/marketing/agent-chat-panel.tsx`、`opencraft-embedded-workbench.tsx`、`agent-avatar-shapes.tsx`、相关 `__tests__/`。
- `frontend/src/components/site/`、`frontend/openspec/`、i18n 生成入口与 `frontend/vitest.config.ts`。
- 两个已定位优化 workspace 的队列文件与 Git 状态；未读取凭据或扩大到无关 workspace。

## scan_output
- 精确源码/测试锚点已列在 interface_refs，未产生持久化扫描产物。

## handoff
- 用户明确授权的提交、推送和分支预览已完成；功能提交 `2bfd749a54260a4411e31392f2980e0197f7f4b2` 已推送，双站预览 HTTP 200。
- 国内：`https://chat-friendly-loading-20261003.preview.lightclaw.tech/agents/chat`；国际：`https://intl-chat-friendly-loading-20261003.preview.lightclaw.tech/agents/chat`。
- 已发布资源含新加载文案和 hash keys；国内 37 个链接 JS 中 7 个、国际 35 个中 4 个相对对应 master 不同。匿名桌面/390px 移动端浏览器显示正确登录入口，最终回执无页面错误、无缺失 JS、无横向溢出。
- 相关 115 测试、完整 check、双站构建与 7 语言组件视觉检查通过；全量测试未通过，不能将相关检查代称完整门禁通过。
- 验证报告：`/data/chat-friendly-loading-preview-20261003/report.html`；JSON、资源证据和截图同目录。已登录完整 Chat 链路仍未验证，生产未发布。
- MR 草稿：`feat(chat): add a friendly assistant loading state`，`frontsandbox/chat-friendly-loading-20261003` → `master`；准备完成，尚未创建。
- MR 描述：Chat 打开时的初始等待统一显示「你的 AI 小助理，马上就来」与「正在准备我们的对话」，并复用橘橙 blob 头像的轻量呼吸、眨眼和星光装饰。launch token、SDK lazy chunk 与嵌入式工作台采用同一加载状态，错误、超时、暂停和重连继续显示真实消息及操作。
- 卡片转入「待确认」，具体待决定项为是否创建 MR；已获授权的提交和推送无需再次确认。

## delivery_authorization
- 2026-10-03：用户在确认问题中明确回复「确认提交并推送预览」。
- 实时 TAPD 核对没有其他进行中项，OPT-009 恢复「进行中」，评论 `1070234090217814534`。
- 复用现有配置的工蜂 SSH 认证，已验证仓库可读且远端同名分支不存在；不输出或复制凭据。
- 提交与推送后核对双站分支预览的 HTTP 状态和新加载文案/组件资源。

## delivery_evidence
- 远端分支回读确认功能提交 `2bfd749a5` 已存在；提交前 staging diff 与 change-impact 检查通过。
- 资源证据：`/data/chat-friendly-loading-preview-20261003/published-cn-assets.json`、`published-intl-assets.json`；两站均包含新中文文案，国际站资源同时包含英文译文。
- 浏览器证据：`online-cn-evidence.json`、`online-intl-evidence.json`，对应桌面与移动端截图保留。
- 国际站首次在预览就绪时的短等待回执出现一次页面错误；随后等待 networkidle 重测并对照 intl-master，均正常。最终回执无错误和缺失资产，不以首查异常猜测源码原因。
- 交付回执文档提交不改变 `frontend/` tree，不额外触发前端预览构建。
