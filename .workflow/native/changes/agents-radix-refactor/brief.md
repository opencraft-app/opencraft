# Agents 全页面 Radix UI / shadcn 风格重构

日期：2026-09-16。状态：方案草案，等待用户批准后进入实现。

## 需求

用户原文：“拉一个分支出来，把目前的 /agents/* 的页面，用 Radix UI、shadcn/ui 整体重构一遍。目标：确保功能逻辑不变的情况下，让交互更加现代和成熟。”

用户补充（2026-09-16）：“在实现时，需要参考项目规范完善一下各模块的依赖和边界”，并显式指定 `feai-workflow`。该项已纳入设计与验收；完整 UI 方案仍处于待确认状态。

工作分支为 `frontsandbox/agents-radix-refactor`，起点为本次 fetch 得到的 `origin/master@08b9cf568`。工作目录为 `/Users/junweicao/LightVela/orcaterm/mono2-frontsandbox-agents-radix-refactor`。

“现代和成熟”的验收定义：布局、控件尺寸和状态表达一致；所有操作可用键盘完成；弹窗管理焦点并在关闭后恢复；浮层不被滚动区域裁剪；长文案和窄屏可用；加载、空数据、失败、进行中和成功状态可区分；原有业务操作入口完整保留。

## 推荐方案与备选

| 方案 | 范围与效果 | 代价 | 结论 |
| --- | --- | --- | --- |
| A：完整宿主界面重构 | 全部 Agents 路由使用统一控制台布局；各本地业务页面逐项迁移到 Radix 原语与 shadcn 风格组件；专用内容保留原接入 | 需要逐页回归，尤其是定时任务、文件、模型、创建与维护弹窗 | 推荐，符合整体重构与业务保持目标 |
| B：共享外层更新 | 统一导航、页头和基础样式；页面内部大部分控件保持现状 | 变更较少，但内部交互差异仍在 | 可作为 A 的第一批实施，不能作为整体完成 |
| C：连同嵌入内容全面替换 | 重写 AgentChat、velachat 工作台、终端和远程浏览器内部界面 | 涉及 SDK/运行时和多仓库契约，回归面显著扩大 | 本次不推荐 |

下文为方案 A 的具体设计；尚未将其记录为用户已批准。

## 页面范围

按现有共享前端同时覆盖国内和国际构建，保留各站点原有开关与差异。此次交付到本地分支和预览；发布站点、发布时机另行决定。

| 路径 | 当前主要实现 | 改造内容与保留约束 |
| --- | --- | --- |
| `/agents` | `agent-settings-page.tsx` | Bot 选择、创建、初始化、升级、空态、导航、维护操作；保持所有 query 意图与权限条件 |
| `/agents/channels` | `agent-channel-panel.tsx`、`agent-config/` | 通道行/卡片、连接状态、配置表单、二维码弹窗；保留连接命令、微信占用与 Bot/Profile 限制 |
| `/agents/models` | `agent-model-config/agent-model-config-panel.tsx` | 模型列表、Provider 表单、主模型标记、测试状态和操作菜单；保留目录、检测、保存、删除与定时任务联动 |
| `/agents/skills`、`/agents/experts`、`/agents/packages` | `agent-skills-panel.tsx`、`skills-demo/`、`agent-experts-panel.tsx` | 页签、筛选、搜索、列表、安装进度和学习弹窗；保持路由别名对应子视图与操作顺序 |
| `/agents/persona` | `agent-buddy-panel.tsx` 及相关弹窗 | 模板选择、编辑、上传和抽取交互；保持数据、次数与提交规则 |
| `/agents/automations` | `agent-automations-panel.tsx` | 列表、表单、时间选择、历史、确认与 Tooltip；保留时区、调度、有效期、运行/暂停/删除和网关重启联动 |
| `/agents/memory` | `agent-settings-page.tsx` 内的 `MemoryPanel` | MEMORY/USER 页签、内容区和容量表单；只抽离展示组件，保留读取、上限校验与保存逻辑 |
| `/agents/achievements` | `agent-achievements-panel.tsx` | 成就展示、筛选与详情；保留当前路由可达性和入口可见策略 |
| `/agents/files` | `components/domain/tat-file-manager-panel.tsx` | 工具栏、路径导航、文件列表、选择、上传/下载状态、预览与确认弹窗；保留 TSSH 文件客户端与命令 |
| `/agents/diagnostics` | `agent-diagnostics-panel.tsx` 和宿主维护弹窗 | 状态、日志、检查项、备份恢复与重置确认；保留数据影响提示、主 Bot 与多 Bot 限制 |
| `/agents/settings` | `agent-common-settings-panel.tsx` | 统一设置分组、字段、帮助和危险操作区域；保留加载、校验、保存与重启行为 |
| `/agents/chat` | `agent-chat-panel.tsx`、宿主会话侧栏 | 会话导航、会话菜单、重命名/删除、加载/错误状态、容器布局；保留 SDK 消息面板、会话桥接、token 生命周期与滚动策略 |
| `/agents/browser` | `components/domain/tat-hermes-web-panel.tsx` | 页面工具栏、连接状态、重试与容器；保留代理 broker、iframe 与打开方式 |
| `/agents/terminal` | `agent-terminal-panel.tsx` | 连接状态、工具栏与终端外层；保留 xterm、会话与命令执行 |
| `/agents/labs/deepseek-harness` | `agent-deepseek-harness-panel.tsx` | 状态、设置区块和操作反馈；保留原有安装/更新/连接逻辑 |
| `/agents/websites` | `agent-website-panel.tsx` | 网站/工作台列表、状态、入口和操作区；保留远端操作与可见规则 |
| `/agents/workbench`、`/agents/session` | `agents-workbench/AgentsWorkbenchPage.tsx`、`VelaWorkbenchDesktopHost.tsx` | 加载、错误、连接和外围控件；保留 velachat ChatSurface/SessionListSurface、transport 与自动引导逻辑 |

共有 16 个能力 section（含 workbench），并保留根入口及 experts/packages/session 等别名。隐藏入口、实验室开关和主 Bot 专属能力保持现有策略。

## 布局与视觉

- 桌面端采用稳定侧栏与内容区。顶部集中 Bot 选择及状态；“探索/对话”保持原切换行为；保留配置、使用、成长、管理、实验室分组及当前顺序。
- 主内容统一为标题/说明/主要操作、筛选工具栏、内容、状态反馈四类区域。常规设置限制阅读宽度，文件、对话与工作台使用可用宽度。
- 窄屏导航使用基于 Radix Dialog 的 Sheet。动作可换行，表单单列；字段、选中项、错误与主要操作始终可识别。
- 延续 LightVela 字体、品牌色与 `frontend/DESIGN.md` 的克制工具型风格。卡片使用 `rounded-md`、轻边框和统一轻阴影；减少同级容器尺寸、留白和背景差异。
- 标准操作控件以 36–40px 高度为主；小图标按钮保证可触达区域与可访问名称。信息分为标题、正文、辅助说明三个可辨层级。
- 过渡限定 opacity/transform，时长不超过 200ms，尊重 reduced motion。聊天页保留桌面 `100dvh` 与内部滚动，移动端保留当前内容高度策略并验证软键盘场景。

## 组件与交互

1. 在现有 `components/ui/` 的 Radix Dialog、Popover、Tabs、Select 基础上补齐必要原语，按实际用例引入 DropdownMenu、Tooltip、AlertDialog、Checkbox、Switch 等；使用仓库内可维护的 shadcn 风格组件源码。
2. 增加 Agents 专用的 Shell、Section、Toolbar、Field、Status、EmptyState 等展示组件；是否抽取以真实复用为准。共享组件采用 opt-in 变体，控制台 token 限定于 Agents，Portal 内容显式携带相应样式。
3. 列表操作菜单使用 DropdownMenu；离散值选择使用 Select，复杂搜索选择使用 Popover 组合；页签保留受控 value、原 onChange 和原有挂载策略。
4. 常规编辑使用 Dialog，危险操作使用 AlertDialog。保留现有二次确认内容、提交条件、关闭限制及 pending 禁用行为；新的焦点/键盘行为不得触发额外业务请求。
5. Tooltip 支持 hover/focus、可选择复制、Esc 关闭和边界避让；在滚动区域内使用 Portal。禁用操作需要说明时提供可聚焦的解释触发器。
6. 保留现有 toast 调用；将现有加载、错误、进度数据统一呈现到操作附近。失败显示对应重试入口，空列表只在真实空数据时展示。

## 业务保持不变量

- 路径、别名、`bot` 查询参数、创建/升级意图、回跳目标、浏览器前进后退语义保持一致。
- Repository 方法、远端命令、请求 payload、执行顺序、身份与 Profile 归属保持一致。UI 重排不能新增隐式写操作。
- 不修改 auth、实名、套餐、续费/升级资格、网关状态或运行时开关的判定逻辑；已隐藏入口继续隐藏。
- 保留受控 state、异步请求身份校验、取消/重试、轮询生命周期和切换 Bot 后的失效机制。表单草稿、选中项和 pending 不因组件更名/重排意外重置。
- 保留 AgentChat 稳定首帧 API 参数、token 刷新、多会话协议、语言重挂边界、事件回调与懒加载 CSS 边界。
- 保留 velachat/xterm/iframe 的专用渲染内容与公开接入。其内部不承诺改用 Radix；该边界必须出现在最终交付说明中。
- 保留双站、多语言与现有内容；新增可见文案按仓库生成脚本更新 i18n，禁止手工改生成字典。

## 模块依赖与职责边界（用户补充）

具体执行计划与模块矩阵见 `frontend/openspec/changes/2026-09-16-agents-radix-boundaries.md`；`frontend/openspec/plan.md` 的本任务段为实施任务入口。Native brief 记录整体需求批准，不代替执行计划；runtime summary 只记录当前批次。

- 路由和页面负责组装模块、传入身份与能力、协调跨模块动作；模块内视图负责呈现受控状态和发出用户意图；功能 hook/client 保持原有请求、校验、取消与执行次序。
- Radix/shadcn 基础组件只依赖 React、UI 原语和纯样式工具。Agents 业务展示组件可消费明确 props，不直接读取完整 Repository、账户 token 或 SDK 实例。
- 模型、通道、技能、定时任务等按现有功能目录收敛公开入口和 types。模块内部使用相对导入；模块间通过公开契约或宿主回调连接，不通过对方内部组件、状态 setter 或私有 client 互调。
- 复用 `@lightvela/agent-core` 的中立身份与策略。不得为 UI 重构复制 Bot/Instance/Profile 判定，也不得向 core 添加 React、网络、路由、存储、时钟、埋点或 i18n。
- SDK 和专用 transport 留在接入层，保留动态加载、CSS 隔离、稳定引用及卸载行为；低层纯契约入口不得重新导出带副作用的 SDK 组件。
- OpenCraft 是现有下游消费者。命中其生成闭包的前端修改必须按标准同步脚本验证；不手改生成副本和 UPSTREAM.json。新增 Radix 依赖、Portal class 与导入路径必须验证下游可解析。
- 每批验收补充循环依赖、反向依赖、模块公开契约、资源清理和命令调用不变量检查；既有失败和本次新增失败分别记录。

本轮只读调查：从 Agents 客户端、控制台与基础 Button 入口解析 TypeScript 本地源码依赖，覆盖 231 个文件、752 条边（129 条仅类型、15 条动态导入）；扫描范围内未发现运行时循环与 UI→页面/Context/Repository、Context/Repository→页面的反向依赖。该结果不覆盖 node_modules、生成 locale、CSS 依赖或所有字符串拼接的动态路径。现有 core 边界与模型 hook 的 15 条基线测试通过。

OpenCraft 的只读同步检查在未修改生产源码时已失败：生成副本缺少 `domain/instance-bot-errors.ts`。实施前记录该基线，最终验证需说明标准同步的必要差异，不能把历史缺失误记为本次回归，也不能宣称当前下游已通过。

## 关键上下文发现

- 基线 `frontend/package.json` 已无 `@tencent/tea-sdk-lightclaw`；实际使用本地 `agent-config/` 与 `agent-model-config/`。`TeaSdkSettingsPanel` 等历史命名仍保留，不能据命名推断当前依赖。
- 宿主 `agent-settings-page.tsx` 为 5,823 行，定时任务主文件为 6,737 行，存在状态、请求与 JSX 混排。以展示层组件提取为主，分批审核 diff，避免同时搬动业务状态与事件实现。
- 会话侧栏存在手写菜单，定时任务有多处 `createPortal` + `role="dialog"` 和自建 Tooltip；这是此次交互迁移的具体对象。
- `agent-settings-sdk-boundary.test.ts` 已保护本地命令、稳定面板输入和真实执行适配；相关结构断言如因组件提取改变文件位置，需改为行为验证或正确的新边界，不能删除保护意图。
- `/agents/workbench` 可能在进入页面时自动安装/启动远端 velad。浏览器回归先使用完整 mock 或明确授权的测试实例，避免以“页面浏览”名义触发现有远端写入。
- 最新 `frontend/AGENTS.md` 声明 lint/typecheck/test/build；实际 package scripts 有 `check`、`typecheck`、`test` 和 build，没有 `lint`。实施时以可执行脚本核对门禁，不伪造 lint 成功。

## 分批实施

1. 建立路由/状态/关键操作基线，统一 Agents token 与可访问原语。
2. 重构控制台布局、Bot 选择、移动导航、会话侧栏及公共状态。
3. 迁移通道、模型、高级设置与诊断/维护弹窗。
4. 迁移 Skills/Experts/Packages、人设、记忆、成就。
5. 迁移定时任务、文件、网站、实验室及专用内容外围。
6. 完成全路由审计、双站构建、键盘/响应式和业务回归，提供可运行预览与截图。

每批都属于本次整体重构；完成共享外层不代表全任务完成。单 Agent 顺序实施，只有收到并行授权才调整协作方式。

## 验证口径

- 测试：原有相关用例保持通过；新增测试集中在菜单键盘导航、Dialog 焦点恢复、表单草稿、pending 防重、Bot/Profile 切换、关闭/重开与迟到请求等风险行为。
- 业务对比：相同 fixture 与相同用户操作前后，调用的 Repository/命令、参数、次数、关键顺序和终态相同；必要时用执行 spy 验证。交互改善带来的纯展示 state 可变化。
- 路由：16 个 section、根入口和别名逐项检查；覆盖登录中/未登录/无 Bot/加载失败/运行中，以及支持的主 Bot/附加 Bot/多实例分支。
- 视觉与可访问性：桌面 1440px、窄桌面 1024px、手机 390px；中文、英文及至少一种长文案 locale。检查键盘访问、Tab/Esc/方向键、焦点恢复、滚动/边缘浮层、200% 缩放、禁用原因和 reduced motion。
- 专用区域：对话保留容器高度与会话桥接，终端保留 resize，浏览器 iframe 完整显示，工作台入口及连接行为可达。mock 结果与真实运行结果分别记录。
- 工程门禁：`pnpm check`、相关 `pnpm test`、`pnpm build:cn`、`pnpm build:global`、`git diff --check`。不扩大 TypeScript baseline，不以删除测试取得通过；基线问题记录具体命令及影响。
- 最终结果必须附逐页覆盖表和截图/测试证据。真实网络、账号、远端命令未验证部分显式列出，不据组件测试宣称全链路通过。

## 非目标与交付

本次不新增产品能力、不调整定价/权限/模型目录/调度算法、不改后端或运行时、不迁移框架、不改公网部署、不重写 SDK 内部。控制台之外页面的共享组件默认表现应保持原状。

交付包括本地分支代码、设计与验证记录、预览入口、代表页面截图。Git commit、push、MR、部署及生产实例写入按用户后续明确授权执行。
