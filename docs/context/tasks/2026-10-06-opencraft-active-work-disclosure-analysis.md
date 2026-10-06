# OpenCraft 活跃工作被折叠分析

## goal
调查并按用户“整改吧”授权修复活跃步骤被归入“历史消息”的模型缺口，对照新版 Codex Renderer。

## non_goals
- 不提交、发布或重启；不向真实会话发送测试消息。不混入并行听写、模型迁移及其他工作区改动。
- 不把静态 Codex 代码推断为其线上产品的全部行为。

## requirement_refs / requirement_excerpt
- 用户截图：23 条历史消息下仍显示思考状态；用户确认折叠体内有活跃步骤，要求参考本机新版 Codex。
- 2026-10-06 用户“整改吧”授权实施；本轮说明先验证共享模型与实际组件，不重启当前预览。

## interface_refs / data_structure_refs
- `opencraft/packages/chat-core/src/agent-activity.ts`：连续分段、活动分组、折叠默认值和布局。
- `opencraft/packages/chat-core/src/work-status.ts`：工作时钟，不得因缺失时钟推断工作完成。
- `opencraft/apps/workbench-web/src/components/conversation-renderers/activity/work-status.tsx`：无时钟和耗时的标题兜底。
- `opencraft/apps/workbench-web/src/components/conversation.tsx`：View 的显式折叠选择及恢复。

## history_context
- 当前设计：`opencraft/docs/chat-ui-architecture.md`，执行轮次、连续展示分段和 Thinking owner 分离。
- 现有分段代码引用 r2440/r3562；本轮对照新版 26.930.31428 / build 12913 的原始 Renderer，不将 Wakaru 拆分产物视为运行入口。

## acceptance
- 通过纯模型输入证明是否会吞掉仍运行的步骤。
- 区分代码已证实的缺口与截图确切协议序列尚未核对的部分。
- 汇总到达/更新不改变 ordered slots、工作时钟或 Thinking owner；连续进度和恢复仍展开。
- 旧 turnDiff Item 兼容、显式 null 清除、稳定资源身份、完成 Review 卡与打开中的 Review 更新均正确。

## affected_paths
- `opencraft/packages/chat-core/src/{projection,timeline,agent-activity,turn-diff,work-status,timeline-turns}.ts`
- `opencraft/packages/chat-runtime/src/replica-conversation-runtime.ts`
- Web `conversation.tsx` / `app.tsx`，Native `workbench-conversation.tsx`
- chat-core/runtime/resource 单元测试、真实组件资源 browser fixture/smoke、领域文档与本 Task Pack。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md`, `opencraft/AGENTS.md` | 授权和上下文边界 | 分析后按用户授权实施，不自动发布 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md`, `references/verification.md` | 所有权及验证层次 | 合成复现不能冒充当前会话原始序列 |
| `opencraft/docs/chat-ui-architecture.md` | 当前领域与呈现契约 | 分段不获得执行完成权 |
| `opencraft/docs/platform-architecture.md` ownership/reuse sections | 共享底座与平台边界 | pure projection，独立 DOM/Native View，不动并行修改 |
| `opencraft/docs/build-matrix.md` | 完整 gate 中的 Web/Expo 构建 | generic Web、Expo export、iOS bundle 与 headless/原生安装分开 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | UI 与测试邻居 | 核对 chat ordered-presentation/work-status 测试 |
| 新版 Codex `ANALYSIS-ZH.md` 与原始 webview 模块 | 版本及参考权威 | 核对真实 import/export 和模式差异 |

## evidence
- Router 查询 `OpenCraft history messages active steps folded conversation timeline` 无匹配；随后对 chat-core、Web 活动组件和相关测试进行有界搜索。
- 最初在 Wakaru app-initial/app-shared 检索 previousMessages / previous messages / worked for 无命中；扩大到原始 webview 后命中独立 collapsed-turn-disclosure 模块。
- `createActivitySlot` 将 endedByContent 段标为 complete；preventAutoCollapse 又要求该段未关闭，因而会忽略其中 pending/running 的 Item。
- 合成序列“running command → async question → live reasoning”输出：command 仍 running，活动段 complete，preventAutoCollapse=false，默认 isCollapsed=true，workStatus=null；外部 Turn Thinking 仍存在。
- 合成序列“running command → streamed final answer”同样默认折叠运行中的 command。
- 现有 ordered-presentation/work-status 共 23 例通过；上述并行活跃 Item 跨分段边界未在这些测试中覆盖。
- 新版 `collapsed-turn-disclosure-d691dfc9be95.js` 也只在无 work item/耗时时兜底 previousMessagesSummary，因此该文案不是历史权威。
- 新版 `local-conversation-turn-61ed6cbe5e81.js` 分别计算 Turn 运行状态、final answer 资格、activity 模式；preventAutoCollapse 含 activity-mode && turn-in-progress，以及持续活动/未完成子 agent 条件。
- 新版 `sites-end-resource-b8a510733e15.js` 的 EO 分离 shouldAllowCollapse、preventAutoCollapse、forceExpanded、persistedCollapsed；显式选择优先于默认。普通模式开始 final answer 后不保证活跃 Turn 一律展开。
- 2026-10-06 真实窄屏页面只读观察成功复现：云桌面 Turn `01a10ea1-e681-7f11-a2c2-c309c2792e50` 初始状态 streaming、区域展开、无 disclosure boundary。收到两次 `turn/diff/updated` 后，Turn 仍 streaming，但同一活动区域被派生为 complete、boundary=true、preventAutoCollapse=false，DOM 立即变为 collapsed=true、41 previous messages。随后新增 commentary/reasoning 时仍折叠，计数变成 42。只记录方法、身份、状态和长度，不输出 diff 正文。
- 具体路径：`replica-conversation-runtime.ts` 的 `sourceTurns` 将 `candidate.diff/unifiedDiff` 合成为列表末尾的 `turnDiff` Item；builtin projector 给它 running 状态。`isAgentActivityBlock` 不包含 turn-diff，通用 `flushActivity(true, ..., block.type !== "text" ...)` 因此把它当成可折叠的结束边界。这个装饰性汇总还令唯一 workStatus 被置空，触发“历史消息”兜底。之后每次投影仍把汇总追加在新工作的末尾，故持续吞入新工作。
- 对照输入仅增加 turnDiff：原始 Turn streaming 和 Command running 均不改变，但工作段从 streaming/open/working-clock 变为 complete/collapsed/no-clock。这次已由上面的真实通知和 DOM 证实，不再仅是合成缺口。
- 新版原始 `local-conversation-turn-61ed6cbe5e81.js` 中运行中变更卡使用 `Yi({isInProgress:true,inProgressDiffSummary,...})` 的独立固定区域；结束资源另外呈现。工作折叠资格仍由最终回答/模式/liveness 派生，不由这张汇总卡取得结束权。

## decisions
- 建议分开 transcript boundary、执行 liveness、折叠用户意图；不能给整个段写假的 complete 来关闭展示。
- 当前响应未结束或段中仍有活跃 Item 时不自动折叠；旧已结算段仍可收起，不把整个历史强制展开。
- 缺时钟不等于历史；活跃状态可显示简短“处理中”，未知已结算记录可显示“工作记录”，不制造计时。
- 共享 chat-core 负责纯派生规则，Session/协议负责执行事实，View 只持有显式折叠选择，Renderer 不再自行判活跃。
- 实际根因需要区分 ordered transcript 与 Turn 附属资源：Turn diff 是附属汇总，不是假消息，更不是 response/disclosure boundary。共享呈现计划应独立拥有该资源的固定槽位与去重，不能用各端强制展开/CSS 覆盖掩盖错误分类；已结束轮次的 Review/完成卡继续可用。

## risks / validation
- 已识别截图轮次：协作实现云桌面，2026-10-05 23:05:22 收到“重启吧”，Turn `01a10c99-1a12-7ab2-880d-9c28e0ad0576`。原始记录持续工作至 23:19:08 被中断；5 个 AgentMessage 均为 commentary，没有 final_answer，也没有该轮内第二个 UserMessage。不能用“最终回答/Steer 关闭段”的合成复现直接解释这张截图。
- 只读 AppHost 查询显示当前两个活跃会话的原始 Turn 仍是 inProgress。当前预览为 `20261006-hunyuan-desktop-634fcdab5`，80 端口运行新包，未修改或重启。
- 独立 Playwright 新页面恢复云桌面会话，实际加载 `a-BpmeNagV.js`；截图轮次和最新进行中轮次的工作区域均展开，完成轮次才默认折叠。新页面目前未复现用户持续页面的现象，不能声称全部会话均已验证或问题已消失。
- 旧静态 bundle 仍在资源目录，但新页面未加载它，不能仅凭资源残留认定旧缓存是根因。
- 原始记录不包含当时浏览器的折叠选择、全部 started/delta 通知时序。Thread items 分页返回 79 项，但初次与原始 item id 的直接匹配全部失败，结果不作为重放证据；AppHost 诊断第一次把 response 错当 result 导致超时，修正后读取成功。
- 未改 UI，未做真实 Codex 产品运行验收。用户补充所有会话可复现，已询问刷新后立即出现还是继续输出才触发，以区分恢复与流式路径。
- 用户确认刷新后立即折叠并提供 8:16 请求的新截图；该轮原始记录至 8:33:59 才完成，之前 9 个 AgentMessage 均为 commentary。当前只读真实流式复现已经确认共享汇总路径；手机外网入口 HTTPS 从本机访问被拒绝连接，因此没有宣称验证了同一外网连接或 Safari 引擎。

## handoff
- 已按授权实施共享资源分离；未提交或重启，当前 80 端口仍为旧预览。更一般的异步提问/Steer 跨边界活跃 Item 缺口仍须分别验收，本轮不扩大为所有语义边界重构。

## implementation / validation
- 当前 Router 精确查询 `OpenCraft running turn diff end resource causes active work history disclosure collapse refactor` 无匹配，沿此前已确认路径及 frontend-runtime 邻居继续，不做全仓兜底扫描。
- 先新增 5 个资源契约回归，旧实现 0/5；修复后增加 legacy→canonical 稳定身份及显式 null 清除，共 6 个。
- Runtime 不再尾插假 Item；共享 plan 的 changeSummary 固定资源不参与 slots。旧 Item 在 projection 降低为同一资源，work-status/latest-phase 忽略它；资源-only 恢复保留空载体 Frame，不造消息。
- Web/Native 复用既有 TurnDiff renderer，资源不取得 follow ref；Workbench Review 查询加入资源。未改 Host 协议、数据库、执行/队列或用户折叠意图。
- `npm run test:chat` 487/487 通过；core、chat-runtime、Web、Expo `tsc --noEmit` 均通过。`npm run check:boundaries` 包含 typography guard，通过。
- 浏览器回归前三次失败来自误把“任意新完成 commentary 之后仍有 shimmer”设为资源验收条件，以及 reasoning 摘要不一定显示在 steps-prose。改为资源到达前后保留既有 live 指示；连续新进度断言可见、时钟/open/DOM 身份不变，不改生产 Thinking 语义以迎合测试。
- 浏览器路径及最终结果见 checkpoint；使用独立 Vite fixture 与现有 Chromium，不启动 Agent 推理或切换用户服务。历史消息、资源、计时与 Review 使用真实组件，不复制界面实现。
- 资源 browser 回归（含现有 preflight）四组合通过，ordered-presentation 四组合、旧 completed-diff geometry 八组合通过；截图人工检查 mobile-light。不是 Safari 或 Android 真机验收。
- `npm run gate` 最终 exit 0，含全 workspace typecheck/tests 及 Web、Expo Web、iOS JS bundle 构建。构建输出为本 checkout 忽略目录，不覆盖当前 headless 服务产物，不是部署或 IPA。
- 文档验证无 errors/broken links，显式本轮改动集合 docs-impact 通过（维护者 Owner review 提示保留），git diff check 通过。staged 无文件，不将空检查解释为提交门禁已完成。
- 最终 80 端口仍由 PID 534254 监听，未提交、推送、合入或重启。并行脏改动保持原状，不打包/混入本轮交付。
