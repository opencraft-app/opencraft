## goal
在保留国际站首页能力卡现有六卡信息架构、locale 文案与动效状态机的前提下，重做卡片演示内容与视觉层级，使其更接近克制的产品演示而不是骨架屏或素材拼贴。

## non_goals
- 不修改首页其他 section。
- 不改生产、GitOps、云资源或发布配置。
- 不删除仓库内暂未引用的旧能力卡资源。
- 不提交、推送或创建 MR。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户截图与本地工作区说明（2026-09-16）：继续现有能力卡改动，改善当前视觉效果。

## interface_refs / data_structure_refs
- `frontend/scripts/import-international-homepage.mjs`：能力卡生成真源。
- `.about__cards .wcard`：六张能力卡 DOM 契约。
- `data-motion=idle|playing|complete`：现有动效状态机，不改变状态语义。

## history_context
- `current_design_refs`：当前工作区未提交的能力卡 v4.0 实现与用户提供截图。
- `relevant_evolution`：能力卡已从八张缩减为六张，并已有 locale parity、整卡链接、reduced-motion 与移动端队列。
- `superseded_refs`：旧 `wcard-apps-*` 与能力卡通用 3D 插图仅供历史参考。

## acceptance
- 六张卡静态完成帧可读，画面类型不重复。
- 聊天卡不再是密集聊天记录；确认卡明确表达安全边界；记忆卡不再混入旧位图。
- 生成器与所有已发布 locale fragment 同步。
- 聚焦测试、lint/typecheck 的最小有效门禁通过。

## affected_paths
- `frontend/scripts/import-international-homepage.mjs`
- `frontend/public/lightvela-intl-home/index-fragment*.html`
- `frontend/public/lightvela-intl-home/style.css`
- `frontend/next-site/__tests__/international-home-page.test.tsx`
- `frontend/next-site/international-home-runtime.tsx`

## required_context
- `site-environment-routing`
- `frontend-product-surface`
- `service-frontend`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/site-environment-routing.md@2.0.0` | 国际站与 locale 边界 | 保持多语言产物一致 |
| `docs/context/project/services/frontend.md@2.1.0` | 前端验证要求 | 确定聚焦测试与类型检查 |
| `frontend/AGENTS.md` | 最近服务级规则 | 不新增 any，视觉变更需要验证 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 生成物与 i18n 邻接 | 同步生成器、产物与测试 |
| `docs/context/flows/tapd-gongfeng-delivery.md@2.0.0` | MR 交付口径复核 | 避免把 commit/push/MR 更新误写成已完成 |

## evidence
- 2026-09-18：修复多语言自动任务卡“只显示 LightVela、正文没出来”的观感问题。生成器里 id-ID/es/ja-JP/ko-KR 自动化 case 统一为四段结构（用户话、创建结果、时间点、AI 正文），默认英文 fragment 也补齐 `LightVela` 名字行；runtime 不再全局预清空三条投递正文，改为保留完整文案兜底、仅在当前 case 启动打字时清空当前 span 并立即起打，避免切换/重载错过 `animationstart` 后出现空泡泡，也避免气泡露出后才等字。资源版本提升到 `20260918-chat-cadence-v76` 防止缓存继续加载旧 runtime/style。
- 2026-09-18：按用户确认，渠道卡上下两个独立框都保留箭头入口：上半张「多平台聊天接入」右下角新增 `channel-stack__more` 箭头，下半张「重要动作先确认」沿用 `wcard__more` 箭头；两者均跳转 `/agents/channels`。资源版本提升到 `20260918-chat-cadence-v77`。
- 2026-09-18：能力区 7 个可见框按白/灰交替统一底色：云端 Agent 白、网页工作台灰、多平台聊天接入白、重要动作先确认灰、技能扩展白、定时任务灰、长期记忆白。资源版本提升到 `20260918-chat-cadence-v78`。
- 2026-09-18：自动任务卡对话底色按用户反馈改为灰/白/灰间隔：用户指令灰、LightVela 创建结果白、时间后的投递通知灰，避免三条消息全部同色。
- 2026-09-18：复核 MR 需求清单后，统一交付口径为 zh-CN/zh-SG/zh-Hant 均使用中文工作台轮播图；能力卡 `/agents/*` 链接不加 locale 前缀；重要动作确认使用“回复确认短语”而不是按钮式确认。清理了生成 CSS 中已无 DOM 对应的 `.channel-approval__actions` 样式残留。
- 2026-09-18：多语言渠道卡标题逐页实测：英文、印尼语、西班牙语、日语为 2 行；简中、繁中、韩语为 1 行；七种国际站 locale 均无横向溢出或文字截断。渠道卡右下角箭头改为全断点固定显示，距右/底各 14px，16px 图标，不再依赖 Hover。
- 2026-09-18：繁体站工作台轮播已按用户要求切换为 6 张现有中文 `.zh-CN.png` 图片；生成器与 `zh-Hant` 静态片段同步，并新增 locale 断言。
- 2026-09-18：英文「Multi-Channel Messaging」标题取消单行省略号，窄卡内允许自然换为两行完整展示；仅作用于渠道卡标题，不改变其余能力卡排版。
- 2026-09-18：重要动作确认示例改为真实的“输入确认短语”流程：明确说明永久删除影响，并要求用户回复精确的「确认删除」后才执行；移除容易误解为页面按钮的取消/确认操作。参考了高风险 CLI 的 exact confirmation word 范式，并同步八种 locale。
- 2026-09-18：定时任务最后一句的起打等待由 2700ms 缩短为 800ms，逐字间隔由 45ms 缩短为 35ms，气泡出现后更快进入打字状态，避免多语言页面只露出 LightVela 名字行。
- 2026-09-18：定时任务卡对齐检查发现 `.aut__conversation/.aut__case` 在窄屏曾计算为 `0px` 高，且原打字逻辑会同时重置三组 case，导致只有部分 case 能在可见阶段逐字出现。现改为固定四行舞台，三组 case 的用户消息、Agent 回复、时间点、送达消息中心线分别统一为 `28/92/137/182px`；每个 case 仅在自己的时间点之后逐字打出最后一句。
- 2026-09-18：为工作台轮播新增 6 张简体中文图片素材 `anniversary/resume/thesis/event/product/travel.zh-CN.png`；按最新产品口径，zh-CN、zh-SG 与 zh-Hant fragment 均引用完整 6 张中文图，其余国际语言保持英文原图。
- 2026-09-17 最终 browser QA：渠道区已成为两个独立圆角卡片，子卡边框均为 `1px`、圆角 `20px`、卡间距 `10px`，外层容器边框为 `0px`，不再呈现为一个卡片上下分区。
- 2026-09-17 最终 browser QA：zh-SG 安全卡标题仅显示「重要动作先确认」；自动化第三个案例包含「下午 3 点，AI：该喝水吃药了」。
- 2026-09-17 最终 browser QA：所有标题底部 veil 已关闭（伪元素 `display:none`、`backdrop-filter:none`）；Skills 图面 mask 为 `none`；云端 Agent 文案距卡底约 `11px`。
- 2026-09-17 中间态 browser QA：标题统一贴左下、箭头贴右下；双层渠道卡的两个标题分别贴各自分区左下。文字 veil 当时收窄为 `inset: -5px 0 0`、`blur(1px)`，最终已按用户反馈完全关闭。
- 2026-09-17 browser QA：渠道窄卡已拆成「多平台聊天接入 / Human Approval」上下两层，确认式对话与按钮可读；zh-SG 六张卡 href 依次为 `/agents/channels`、`/zh-sg`、`/agents/automations`、`/agents/websites/`、`/agents/skills`、`/agents/memory`；该轮中间态 veil 为 15px，后续已按用户反馈继续收窄，见上一条最终证据。
- v4.2 browser QA at 1960 × 1000 confirmed a white section, light cards, a shared first-row top coordinate, no horizontal overflow, and `scenesTop === aboutBottom`.
- Motion-state inspection over 8.7 seconds confirmed multiple cards transition back into `is-replay`; stage elements now receive the state classes targeted by CSS.
- `design-qa.md` records the source/reference comparison and final passed result.
- 九个 locale fragment 均包含且仅包含一组 `cht__phone`、`cht__capsule`、`ok__gate`、`ok__payload`、`mem__arrow`。
- 本地浏览器在 1280px 视口完成视觉检查；能力卡栅格 `scrollWidth=1240`，与容器宽度一致，无横向溢出。
- `pnpm vitest run next-site/__tests__/international-home-page.test.tsx`：36/36 通过。
- `pnpm typecheck`：174 current、276 baseline、0 new、102 resolved。
- `node --check scripts/import-international-homepage.mjs` 与 `node --check public/lightvela-intl-home/runtime.js` 通过。
- `git diff --check` 通过。
- `pnpm check:homepage-performance` 未形成性能结论：检查所需的 `frontend/out/index.html` 尚未生成。

## risks
- 生成器和静态产物漂移：通过同步断言与聚焦测试缓解。
- 动画影响性能：仅使用 transform/opacity，并保留 reduced-motion。
- locale 布局溢出：保留现有 locale 文案与响应式布局，视觉验证覆盖中英文。

## validation
- 2026-09-18 browser QA：新开韩语 `/ko-kr/?qa=automation-v75` 预览页，确认 v75 产物中三条韩语投递正文均非空；随后 v76 将资源版本、空泡兜底与灰/白/灰底色间隔固化进生成器/runtime/style。
- 2026-09-18：静态 Node 检查确认 9 份 fragment 自动任务卡均有 3 个时间点、3 个 `LightVela` 名字行、3 条非空正文；`node --check` 覆盖生成器、polish 脚本与 runtime；相关文件 `git diff --check` 通过；首页多语言聚焦测试通过（8 passed / 28 skipped）；首页渲染聚焦测试通过（4 passed / 17 skipped）。
- 2026-09-18：需求清单修正后静态复核通过：过期 zh-Hant 英文图口径已移除，生成器/runtime `node --check` 通过，相关文件 `git diff --check` 通过；`pnpm exec vitest run next-site/__tests__/international-home-page.test.tsx --reporter=dot --testTimeout=180000 -t "capability|approval|workspace|Multi-Channel|localized"` 通过（8 passed / 28 skipped）。
- 2026-09-18 browser QA：七种国际站 locale 的渠道标题均完整展示且无横向溢出；英文/印尼语/西语/日语为 2 行，简中/繁中/韩语为 1 行。渠道卡箭头计算样式为 `opacity:1`、16×16px、距右/底 14px。繁体站工作台卡实测引用 6 张 `.zh-CN.png`。
- 2026-09-18：多语言 fragment 测试单项在 180s 合理时限下通过（1 passed / 35 skipped）；能力卡结构测试通过。生成器 `node --check`、繁体 6 图静态计数和相关文件 `git diff --check` 通过。
- 2026-09-18 browser QA：国际站英文卡片标题「Multi-Channel Messaging」计算高度为 38.99px、行高 19.5px，实际完整占两行；`white-space: normal`、`text-overflow: clip`。确认卡已无 action DOM，并显示“回复确认短语才执行”的完整说明。
- 2026-09-18：本轮对应的两项首页测试通过（2 passed / 34 skipped）；完整文件运行 34/36，另两项仅因 15s 超时失败，与本轮断言无关。生成器/runtime `node --check`、locale parity 静态检查与相关文件 `git diff --check` 通过。
- 2026-09-18 browser QA：319px 窄屏下自动化卡高度恢复为 244px、会话舞台为 210px；三组 case 四行中心线完全一致；第一、第二 case 均实测在时间标签出现后才逐字写入最后一条通知。
- 2026-09-18：`node --check`（生成器与 runtime）、`pnpm typecheck`、聚焦文件 `git diff --check` 通过。首页聚焦测试 35/36；唯一失败是既有 locale href 断言仍期待 `/agents/...`，当前产物按已确认需求使用 `/zh-sg/agents/...`，与本次动画改动无关。
- `node --check scripts/import-international-homepage.mjs`（通过）。
- `git diff --check -- frontend/scripts/import-international-homepage.mjs frontend/public/lightvela-intl-home/index-fragment.zh-CN.html frontend/public/lightvela-intl-home/index-fragment.zh-SG.html frontend/public/lightvela-intl-home/index-fragment.zh-Hant.html frontend/public/lightvela-intl-home/assets/workspace-carousel`（通过）。
- 静态 Node 检查确认 6 张 `.zh-CN.png` 均存在，zh-CN/zh-SG/zh-Hant 均引用完整中文图，其余国际语言不引用 `.zh-CN.png`（通过）。
- `pnpm i18n:validate`（通过，0 个错误；57 个仓库既有告警）。
- 前端未定义 `lint` script；已运行可用的 typecheck、聚焦测试、i18n 结构校验、脚本语法与 diff 门禁。
- `pnpm exec vitest run next-site/__tests__/international-home-page.test.tsx --reporter=dot --testTimeout=15000`（通过，36/36）。
- `pnpm typecheck`（通过，174 current、276 baseline、0 new、102 resolved）。
- `pnpm vitest run next-site/__tests__/international-home-page.test.tsx`（通过，36/36）。
- `pnpm typecheck`（通过，0 个新增问题）。
- `node --check scripts/import-international-homepage.mjs`（通过）。
- `node --check public/lightvela-intl-home/runtime.js`（通过）。
- 九个 locale fragment 的新 DOM 标记计数检查（通过）。
- `git diff --check`（通过）。
- `pnpm check:homepage-performance`（前置产物缺失：`frontend/out/index.html`，未执行到预算判断）。

## decisions
- 不使用视频；保留 DOM/SVG 动画。
- 不推倒现有状态机，只重做演示 DOM 与视觉层。
- 旧资源不删除，避免扩大改动范围。

## scan_scope
- `frontend/public/lightvela-intl-home/`
- `frontend/scripts/import-international-homepage.mjs`
- `frontend/next-site/__tests__/international-home-page.test.tsx`

## scan_output
- 使用聚焦 `rg` 与 `git diff`；无独立扫描产物。

## handoff
- 2026-09-18：修复多语言自动任务卡正文空窗：生成器与 9 份 fragment 的投递气泡统一为 `LightVela + 正文`，runtime 起打等待改为 800ms，asset version 升到 v75。韩语浏览器 QA 与聚焦测试通过；未提交、未推送、未发布。
- 2026-09-18：修正需求清单/Task Pack 口径：繁体站按最新要求继续用中文工作台图，确认卡不再保留按钮样式残留，能力卡 `/agents/*` 链接不做 locale 前缀。聚焦测试 8/8 命中通过；未提交、未推送、未发布。
- 2026-09-18：补齐多语言标题换行检查、繁体工作台中文图片与渠道卡常显箭头。七语言均无标题截断，繁体站 6 张工作台图均切为中文，箭头全断点固定右下显示。未提交、未推送、未发布。
- 2026-09-18：重要动作卡已从按钮确认改为对话式精确回复确认；八种 locale 的生成源与静态片段均已同步。定时任务最后一句同步缩短起打等待与逐字间隔。未提交、未推送、未发布。
- 2026-09-18：修复定时任务卡动效对齐与打字相位。三组 case 共用固定四行网格；逐字效果只作用于时间点后的最后一句，并由各 case 自身 15s 周期触发，移动端同样生效。浏览器已实测前两组独立打字与四行基线一致；未提交、未推送、未发布。
- 2026-09-18：工作台轮播 6 张图已生成简体中文版并放入 assets；zh-CN/zh-SG/zh-Hant 使用中文图，其余国际语言保持英文图；脚本语法、diff 与静态引用检查通过。未提交、未推送、未发布。
- 2026-09-17 最终收口：多平台聊天接入与重要动作先确认改为两个具有独立边框、圆角与间距的卡片；中文标题去掉英文前缀；自动化新增下午 3 点 AI 喝水吃药提醒；移除卡片底部虚化/漂白层与 Skills 边缘 mask。浏览器计算样式核验通过；首页测试 36/36、typecheck 0 个新增诊断、脚本语法与 diff 检查通过；未提交、未推送、未发布。
- 2026-09-17：渠道卡改为上下双层，新增全 locale 的 Human Approval 确认对话；能力卡跳转统一到当前语言首页与真实 Agent 控制台 section；底部文字 veil 收窄为 15px。浏览器、36 项首页测试、typecheck、脚本语法与 diff 检查均通过；未提交、未推送、未发布。
- 2026-09-17 视觉收口：新增共享 capability-polish 生成转换和 CSS；九语言同步审批等待确认、云端 24/7 标签、偏好示例和短标题，去除自动化装饰栏，Skills 恢复克制彩色矢量图标。保留布局与 Memory 粒子。聚焦能力卡测试通过，diff/语法通过。浏览器首轮已查看并修复新标签被旧 inset 样式撑满的问题，最终复查连接超时；不宣称完整视觉验收。
- 2026-09-17：按用户提供的 ParticleText 源码将 Memory 插图轮播替换为品牌紫 canvas 粒子字；保留背景和卡片标题，首次入场/悬停聚合，支持指针排斥、离屏暂停、减少动态效果和卸载清理。源脚本为 frontend/scripts/homepage-memory-particles.js，生成器复制到静态资源目录；九个 fragment 同步。
- 本轮读取 site-environment-routing.md、services/frontend.md、frontend/AGENTS.md 与 frontend-runtime-openspec-i18n 邻接卡。聚焦卡片测试、脚本语法和 diff 检查通过；浏览器预览因 localhost:5174 无响应未完成。
- 能力卡 v4.2 结构修复、持续动效、自动化仿真、回归测试及本地视觉检查已完成；未提交、未推送、未发布。
