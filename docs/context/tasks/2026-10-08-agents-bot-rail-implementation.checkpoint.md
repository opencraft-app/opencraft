---
id: agents-bot-rail-implementation-checkpoint
type: task
scope: Recovery state for the Agents Bot rail implementation.
triggers: ["agents bot rail", "implementation checkpoint", "agents handoff"]
owner: pablozhong
authority: primary
source_of_truth:
  - docs/context/tasks/2026-10-08-agents-bot-rail-implementation.md
status: active
reviewed_at: 2026-10-08
review_due: 2026-11-08
revision: 1.0.0
precedence: task
derived: false
---

## stage
双站 `/agents` 代码已实现；获批的 PC 顶栏方案已写入前端、OpenCraft 嵌入式顶栏和 PRD，国内站 5174 已实测。工蜂 MR !5097 已提交，待评审与 CI。

## verified
- 前端真源提交 `5e1bbc2e5`，按仓库要求同步 130 个 OpenCraft 副本文件并单独提交 `876538eab`；只读同步检查通过。远端分支与本地 SHA 一致。MR !5097 指向 `master`，创建后的快照为 `opened`、`can_be_merged`，CI `pending` 且暂时阻塞合并。
- 国际站创建引导复测 20/20 通过；测试已按当前 Bot 头像状态名称和竖栏底部管理入口更新。工蜂只读鉴权有效，同名开放 MR 不存在；提交前 OpenCraft 副本检查提示预期的真源漂移，须按仓库要求在真源提交后同步并单独提交生成副本。
- 已有 Bot 的「新建 Bot」现向浏览器历史新增 `newBot=1` 状态；返回到原 `/agents` 地址时关闭创建引导，未提交表单不会创建实例。创建等待由“可能需要几分钟”改为通常 10 秒内完成，超过 10 秒展示实际等待秒数与继续创建状态；双站 locale 已补齐。相关 4 个测试文件 70/70、`pnpm check`（0 新增类型诊断）、国内／国际站构建、文档校验、staged change-impact 与 `git diff --check` 通过。当前预览账号已达 Bot 数量上限，未通过该账号点击入口实测。
- 左上角展开态 LightVela 文字标识从 32px 收至 28px，顶部栏仍为 60px；5174 已登录国内站实测标识宽约 100px、高 28px，x=16px，页面加载完成正常。侧栏定向测试 4/4、`pnpm check`（0 新增类型诊断）及 `git diff --check` 通过。
- `/agents` 两层加载骨架已适配多 Bot 导航：最左列为 Bot 头像、新建入口与底部管理入口占位，功能侧栏不再闪现旧 Bot 卡片；聊天路由显示新建会话输入区轮廓，展开／收起态沿用对应列宽。路由等待和 Bot 数据等待共用这套骨架。前端聚焦测试 50/50、`pnpm check`（0 新增类型诊断）、国内／国际站构建、文档校验、staged change-impact 与 `git diff --check` 通过。构建生成的 `next-env.d.ts` 和字体改动已还原。
- 最新上下区域高度微调：桌面多 Bot 的顶部品牌区与底部账号区均从 68px 收至 60px；Bot 竖栏、宽侧栏和非聊天内容的顶部起点同步调整。5174 已登录预览实测展开／折叠态两区均同高，通道页内容起点 60px 且无横向溢出；侧栏聚焦测试 48/48、`pnpm check`（0 个新增类型诊断）、国内／国际站构建、文档校验及 `git diff --check` 通过。
- 最新宽度微调：桌面多 Bot 展开态功能导航栏从 248px 收到 232px，顶部品牌区、底部账号区及主内容起点统一至 x=288px；Bot 竖栏和折叠态尺寸未变。国内站 5174 登录预览已测量并查看截图；侧栏聚焦测试 48/48、`pnpm check`（0 个新增类型诊断）、国内／国际站构建、文档校验及 `git diff --check` 通过。
- 独立工作树 `/Users/pablozhong/.codex/worktrees/agents-bot-rail-prd/lightvela` 在改代码前快进同步 master 至 `e32b6e8e9`。
- Bot 竖栏、移动头像条、切 Bot 新会话、旧总览地址重定向、账户菜单权益、Bot 管理菜单均已写入本地源码；总览内容不再从 `/agents` 渲染。
- `frontend` 的 `pnpm check`、国内站 `pnpm build`、国际站 `pnpm build:global` 通过；相关 8 个测试文件拆批执行，共 189 条通过。
- 文档校验、变更路径影响检查、`git diff --check` 通过。OpenCraft 只读同步检查发现新前端源码与 vendored 副本漂移，符合尚未提交源代码的当前状态。
- 视觉微调：多 Bot 宽侧栏由 264px 收至 248px，新增 Bot 紧跟头像列表，当前 Bot 有紫色底框和侧边标记，桌面 Logo 距左 16px。Chrome 已登录国内站通过已有本地映射命中 5174，展开／折叠及无横向溢出均已核对。相关 3 个测试文件 67 条与 `pnpm check` 通过。
- 最新反馈：Bot 头像竖栏由 68px 收至 56px，改为与左导航相同的白底；顶部栏和侧栏起点同步。Chrome 实测竖栏 x0/56px、侧栏 x56/248px、顶部栏 304px，三者均为白底；相关 3 个测试文件 63 条、`pnpm check`（0 个新增类型诊断）与 `git diff --check` 通过。
- 后续视觉反馈：删除竖栏“BOTS”标签，移除选中 Bot 的描边，新增 Bot 虚线框缩至 36px（44px 点击区保留）。Chrome 国内站预览已核对；相关 3 个测试文件 63 条、`pnpm check`（0 个新增类型诊断）与 `git diff --check` 通过。
- 头像去重反馈：多 Bot 模式宽侧栏移除重复头像与状态点，最左竖栏每个 Bot 显示自己的状态点，重启中显示橙点；单 Bot 仍沿用原卡片头像。Chrome 实测左侧两个 Bot 各有状态点、右卡片 0 个头像，折叠时空卡片隐藏。相关 3 个测试文件 63 条、`pnpm check`（0 个新增类型诊断）与文档校验通过；PRD 和 Task Pack 已同步。
- 选中态反馈：桌面 Bot 头像左侧紫色竖条移除，选中背景调为 `#f8f7ff`；移动头像条仍保留底部选中线。Chrome 实测桌面伪元素不存在、选中背景为 rgb(248,247,255)；相关 3 个测试文件 63 条、`pnpm check`（0 个新增类型诊断）与 `git diff --check` 通过。
- 用户批准 `wiki/prd-docs/demos/2026-10-08-agents-bot-header-proposal.html` 后，PC 多 Bot 宽侧栏已去 Bot 卡片；主内容顶栏显示 Bot 名称和页面／会话标题，管理菜单含修改资料、复制、重启／修复、删除。OpenCraft 仅为内嵌模式提供具名 slot，原会话标题重命名与预览开关保留；交互菜单放在宿主层，避免 Shadow DOM 事件使弹层立即关闭。PRD、Task Pack 和正式设计文档已同步。
- 本轮 `pnpm check`（0 个新增类型诊断）、OpenCraft 内嵌发布构建、侧栏测试 40/40、OpenCraft 导航测试 35/35、文档校验及 `git diff --check` 通过。国内站 5174 已登录 Chrome 实测新会话、历史会话、管理菜单和技能页；顶栏标题及侧栏排布可见。
- 最新源码的 `pnpm build:cn`、`pnpm build:global` 均通过，含 OpenCraft 的完整变更集合通过 change-impact 校验。5174 按预览约定带 `NEXT_PUBLIC_OPENCRAFT_EMBED_SCRIPT_URL=/__opencraft/embedded-workbench.js` 恢复，已登录 Chrome 的真实会话再次载入，并留在完整导航的新建会话页。
- 后续用户要求将截图左下账户入口移到右上角试用。桌面多 Bot 顶栏现包含 Bot 管理菜单、账户头像／姓名／套餐及原预览开关；账户弹层改向下展开，原权益数据和操作保留。单 Bot 与移动端仍用侧栏入口。`pnpm check`、OpenCraft 内嵌构建和 86 条聚焦测试通过，国内站 5174 实测聊天页和技能页布局与菜单。
- 右上角调整后的双站正式构建、文档校验、change-impact 及 `git diff --check` 通过；构建临时生成的 `next-env.d.ts` 和字体文件变更已还原。5174 已恢复并在原 Chrome 本地映射标签核对新建会话和右上角账户入口。
- 用户最终决定账户入口移回左下角；右上角试用方案已撤回，当前源码、PRD 与正式设计文档以左下角为准。
- 账号区继续延伸到桌面最左侧，横跨 Bot 竖栏与宽侧栏；5174 已登录页面确认展开时 x=0 至 304px、折叠时至 128px，菜单仍向上展示权益。本轮 `pnpm check` 无新增诊断，聚焦测试 85/85、OpenCraft 内嵌发布构建、文档与变更影响检查、`git diff --check` 通过。
- 新建会话的右侧预览入口已隐藏，仅已有会话显示；Bot 管理入口移到名称旁并改成设置图标。5174 实测菜单可展开，已有会话仍可见右侧入口；前端 48/48 与 OpenCraft 1/1 聚焦测试、前端检查、嵌入构建通过。
- 新建会话顶栏已去掉“新建对话”占位及斜杠，已有会话仍显示原会话标题。5174 已登录页面核对两种状态，聚焦测试 48/48、前端检查、文档校验通过。
- 桌面多 Bot 收起态复用站点 `lightvela-icon.svg` 填补左上品牌空白；第二列收至与 Bot 列同为 56px，顶部、内容与底部统一为 112px；账户头像旁恢复箭头。5174 国内站已登录 Chrome 在聊天与通道页核对列宽及品牌显示，并确认账户菜单可打开；侧栏聚焦测试 48/48、`pnpm check`（0 个新增类型诊断）、文档校验及 `git diff --check` 通过。另有账户菜单测试 2 条因既有“模型”入口断言与当前菜单不符而失败，和本轮收起态 CSS 无关。
- 2026-10-08 再次抓取 `origin/master`，由 `e32b6e8e9` 快进至 `a905e4c64`（38 个提交），本地改动以可恢复 stash 备份后重新应用；14 个重叠文件自动合并，无未解决冲突。上游会话置顶逻辑新增较早出现的 `setChatSessionCommands(null)`，修正侧栏源码断言的截取边界后聚焦测试 48/48 通过；`pnpm check` 无新增类型诊断，OpenCraft 内嵌资源构建和呈现测试 1/1 通过。5174 国内站已重启并在已登录 Chrome 核对折叠导航及真实聊天输入框。
- 用户调整账户菜单：移除“已服务”天数，把“升级套餐”从积分进度下方移到顶部套餐名称旁；原可升级资格和跳转保持。5174 已登录国内站展开、折叠导航均已核对；国内站账户菜单聚焦测试 16/16、`pnpm check`（0 个新增类型诊断）和 `git diff --check` 通过。
- 收起态两列导航的 Bot 头像、新建 Bot、日常／探索与功能图标提示统一为右侧白底浮层，外观对齐顶部「展开导航」，通过 Portal 脱离裁剪容器；移动头像条方向不变。5174 已登录国内站以键盘聚焦核对 Bot 与通道提示位置；提示／侧栏测试 43/43，`pnpm check`（0 个新增类型诊断）、国内站和国际站构建、文档与变更影响检查、`git diff --check` 均通过。5174 已恢复运行，PRD、Task Pack 与 `frontend/DESIGN.md` 已同步。
- 最新反馈：桌面 Bot 管理入口移至最左竖栏底部、账户区上方；聊天顶栏保留 Bot 与已有会话标题，通道和技能等配置页不再显示 Bot／页面名称顶栏。Bot 头像间距由 6px 调为 10px，选中背景和边框取各头像同色系浅色。5174 国内站已登录 Chrome 核对真实聊天标题、管理菜单四项、通道与技能页无顶栏、头像位置和计算颜色；3 个聚焦测试文件 61/61、`pnpm check`（0 新增类型诊断）、国内站及国际站构建、文档与完整变更影响检查、`git diff --check` 均通过。5174 已恢复运行，PRD、Task Pack 与 `frontend/DESIGN.md` 已同步。
- 用户继续要求去掉选中 Bot 头像的外圈线条。已移除选中按钮的行内 `border`，保留与头像同色系的浅色背景和独立状态点；5174 已登录 Chrome 的计算样式显示 `border-width: 0px`、`border-style: none`，背景仍为浅橙色。PRD、Task Pack 和 `frontend/DESIGN.md` 已同步；相关 2 个测试文件 48/48 通过。
- 最新会话顶栏改为仅显示已有会话名称与编辑按钮，不再插入 Bot 名称和斜杠；新会话无左侧占位标题，右侧已有会话预览按钮保留。LightVela 宿主投影和 OpenCraft 具名 slot 已移除，PRD、Task Pack 与正式运行时设计文档同步。5174 国内站已登录浏览器核对两种会话状态；前端定向测试 61/61、OpenCraft 定向测试 1/1、`pnpm check`（0 新增类型诊断）、内嵌构建、双站构建、文档与完整 change-impact 检查均通过。默认 Vitest 曾受本机 localhost DNS 影响，指定 `--api.host 127.0.0.1` 后通过。
- Bot 管理菜单删除项恢复常规图标和文字颜色；禁用时保留简短操作名称并置灰，悬停或键盘聚焦提示原因。5174 已登录国内站确认主 Bot 删除禁用、计算颜色及焦点提示；前端定向测试 53/53、`pnpm check`（0 新增类型诊断）、双站构建、`git diff --check` 与 staged change-impact 检查通过，5174 已恢复。
- Bot 竖栏视觉再次微调：桌面头像纵向间距 10px → 14px，选中底色的头像颜色混合比例 10% → 6%，不加边框。5174 国内站计算样式确认相邻按钮 y 坐标相差 58px、间隔 14px，选中按钮边框 0px；前端聚焦测试 48/48、`pnpm check`（0 新增诊断）、双站构建、文档校验、staged change-impact 与 `git diff --check` 均通过。
- 用户继续微调后，最终头像纵向间距为 12px，选中底色的头像颜色混合比例为 8%，边框仍为 0。5174 国内站计算样式确认相邻按钮 y 坐标相差 56px、间隔 12px；前端聚焦测试 48/48、`pnpm check`（0 新增诊断）及双站构建通过。
- 新增 Bot 加号框再上移 4px：仅将桌面竖栏加号按钮的额外上边距从 6px 收至 2px，头像列表的 12px 间距保持。5174 国内站实测加号框距最后一个头像按钮 14px；前端聚焦测试 48/48、`pnpm check`（0 新增诊断）及双站构建通过。
- 用户要求再上移一点，已去掉加号按钮剩余的 2px 额外上边距；它与最后一个头像按钮现相距 12px，与列表间距一致。5174 国内站实测位置；前端聚焦测试 48/48、`pnpm check`（0 新增诊断）、双站构建、change-impact 与 `git diff --check` 通过。
- 新增 Bot 加号虚线框的高度由 36px 收至 32px，与右侧“默认对话”行实测 32px 一致；44px 外层点击区域不变。5174 国内站核对样式和视觉，前端聚焦测试 48/48、`pnpm check`（0 新增诊断）和双站构建通过。
- 加号框随外层按钮再上移 3px，在当前四 Bot／默认单会话桌面布局中虚线框和“默认对话”行的顶部均为 307px、高度均为 32px；44px 点击区域不变。5174 国内站实测，前端聚焦测试 48/48、`pnpm check`（0 新增诊断）、双站构建、change-impact 与 `git diff --check` 通过。

## unverified
- 真实登录环境下国际站、移动视觉、账户实际邀请数、Bot 切换新会话的端到端验收。
- 全量 `pnpm test` 未通过：含与本需求无关的旧断言失败及 Vitest worker 内存耗尽；`validate_context.py --build-catalog` 也受全仓既有 Task Pack 缺字段影响。不得对外宣称这两个全仓门禁通过。
- MR 已提交；尚未合并或发布。国际站真实登录环境、移动端视觉与 Bot 创建入口的完整人工验收仍待完成。

## discard
- 旧总览、左栏 Bot 下拉切换的测试断言已替换；临时借用主工作区依赖的类型检查结果不可作为门禁证据。

## restore
- PRD：`wiki/prd-docs/2026-10-08-agents-bot-rail.md`；原型：`wiki/prd-docs/demos/2026-10-08-agents-bot-rail.html`。
- Task Pack：`docs/context/tasks/2026-10-08-agents-bot-rail-implementation.md`。
- 门禁日志：`/tmp/agents-bot-rail-check.log`、`/tmp/agents-bot-rail-build.log`、`/tmp/agents-bot-rail-build-global.log`、`/tmp/agents-bot-rail-focused-tests.log`、`/tmp/agents-bot-rail-opencraft-check.log`。

## next_action
- 等待 MR !5097 评审及 CI 结果；本次不合并或发布。

## requirement_ids / requirement_refs / requirement_excerpt
- `agents-bot-rail-2026-10-08`；见 `wiki/prd-docs/2026-10-08-agents-bot-rail.md`；双站独立 Bot 竖栏与总览退场。

## interface_refs / data_structure_refs
- `frontend/src/lib/agent-routes.ts` 的 `?bot=` 与 `frontend/src/pages/marketing/agent-settings-page.tsx` 的 Bot／会话切换状态。

## history_context
- current_design_refs：`wiki/prd-docs/2026-10-08-agents-bot-rail.md`。
- relevant_evolution：开发前同步 `origin/master` 至 `e32b6e8e9`。
- superseded_refs：旧多 Bot 总览 PRD 仅作现状对照。

## context_receipt
- 见对应实现 Task Pack 的 `context_receipt`。
