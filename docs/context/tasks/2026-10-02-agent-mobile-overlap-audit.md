## goal
检查 Agent 控制台移动端是否还有与导航徽标、会话列表、人设卡片类似的文字或控件重叠。

## non_goals
- 不检查支付、登录和云资源操作。
- 不把本地预览结果当作线上发布结果。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-10-02：「再检查一下移动端有没有类似的重叠问题呢」。

## interface_refs / data_structure_refs
- `/agents` 共享设置侧栏、会话抽屉及当前可进入的内容页；保留已有数据和交互。

## history_context
- current_design_refs: `frontend/openspec/changes/2026-08-24-sidebar-chat-settings-tabs-plan.md`；前两轮本地布局修复。
- relevant_evolution: 移动端设置分组为双列、实验室极窄屏单列、会话列表单列。
- superseded_refs: 无。

## acceptance
- 在 320px、390px 宽度下检查导航、会话抽屉、人设和可用设置页，记录实际可见的重叠和横向溢出。
- 发现可复现的同类问题时做局部修复并复测；输出测试报告和未覆盖边界。

## affected_paths
- `frontend/src/pages/marketing/agent-diagnostics-panel.tsx`：为诊断中心的两层网格指定单列最小宽度，避免 320px 下内容撑开页面。
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/pages/marketing/agent-diagnostics-panel.tsx` 与 `UPSTREAM.json`：CI 修复阶段由同步脚本机械生成。
- 本任务记录与 `/tmp/lightvela-mobile-overlap-audit-20261002/` 下的验证报告。

## required_context
- `frontend-product-surface`；前端服务 context 与最近的 `frontend/AGENTS.md`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md` | 路由 must_read | 双站与验证边界 |
| `frontend/AGENTS.md` | 最近服务规则 | 页面、测试与构建规则 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | 前端邻接 | 规格与测试邻居 |
| `frontend/openspec/changes/2026-08-24-sidebar-chat-settings-tabs-plan.md` | 对话侧栏设计 | 保留会话导航结构 |
| `docs/context/flows/tapd-gongfeng-delivery.md` | MR 交付路由 must_read | 在原 MR 更新提交，不执行合并或发布 |
| `opencraft/AGENTS.md`、`opencraft/MONO2_MIGRATION.md` | OpenCraft 服务规则与源所有权 | 使用官方同步脚本，不手改 vendored 副本 |
| `docs/context/project/upstream-subtrees.md` | OpenCraft 邻接边界 | 保持 mono2 单一真源 |

## test_matrix
| id | 初始状态 | 入口 | 设备 | 操作 | 预期 | 证据 | 结果 |
|---|---|---|---|---|---|---|---|
| NAV-320 | 本地已登录、Bot 暂停 | `/agents/persona/` | 320px Chrome | 查看探索导航 | 文字、徽标和相邻导航不重叠 | 实际页面截图与 DOM 几何 | 通过 |
| NAV-390 | 同上 | `/agents/persona/` | 390px Chrome | 查看探索导航 | 同上 | 实际页面截图与 DOM 几何 | 通过 |
| CHAT-320 | 同上 | `/agents/chat/` | 320px Chrome | 展开会话抽屉 | 列表单列、按钮不重叠 | 实际页面截图与 DOM 几何；背景遮罩交叠为预期 | 通过，运行态未覆盖 |
| CHAT-390 | 同上 | `/agents/chat/` | 390px Chrome | 展开会话抽屉 | 同上 | 实际页面截图与 DOM 几何 | 通过，运行态未覆盖 |
| PERSONA-320 | 同上 | `/agents/persona/` | 320px Chrome | 查看卡片工具栏及操作区 | 标题、来源、按钮不重叠 | 实际页面截图与 DOM 几何 | 通过 |
| PERSONA-390 | 同上 | `/agents/persona/` | 390px Chrome | 同上 | 同上 | 实际页面截图与 DOM 几何 | 通过 |
| SETTINGS-320 | 同上 | 模型、技能、定时任务、记忆、通道、成就、高级设置、工作台、DeepSeek Harness、诊断中心 | 320px Chrome | 浏览已加载内容 | 无新增文字重叠或水平溢出 | 诊断中心修复前溢出 12px，修复后为 0；其余已加载页无异常 | 通过，部分内容为空态 |
| SETTINGS-390 | 同上 | 同上 | 390px Chrome | 浏览已加载内容 | 同上 | 实际页面截图与 DOM 几何 | 通过，部分内容为空态 |

## evidence
- 本地国内站 Chrome 320px 与 390px 浏览器实际渲染；对可见文字矩形交集和 `documentElement.scrollWidth - innerWidth` 做检查，并用页面截图辨别抽屉遮罩的预期交叠。
- 诊断中心修复前 320px `scrollWidth=332`、`innerWidth=320`；修复后溢出 0，卡片网格宽度与内容区同为 272px；390px 溢出 0。
- 原始巡检矩阵及结论见 `/tmp/lightvela-mobile-overlap-audit-20261002/report-data.json`、`report.html`。截图仅在浏览器工具会话中观察，未保存独立图片文件。
- MR !4945 首轮 CI 日志中 `frontend` guard 全部通过；`opencraft` guard 报 `vendored mono2 file drifted`，首个文件为 `pages/marketing/agent-diagnostics-panel.tsx`。i18n WARN 并非该次退出原因。
- 前端真源已经在 `ce74de1c29c4e9d2e01458932fb05702fa7690a0` 提交；同步脚本只改变 OpenCraft 诊断中心副本及 `UPSTREAM.json` 两个文件。
- 目标 `master` 同期修改了 Agent 定时任务源文件及同一份 manifest；合入目标后由同步脚本重生 manifest，同时保留定时任务和诊断中心两项 source hash。
- 合并提交 `a52c2b6701d94d627b427b7147fe5f0856c213b1` 成为生成器计算的最新 closure 源修订；合并后重新同步使 manifest 记录该提交。

## risks
- 暂停 Bot 无法展示真实多会话和部分运行态；有些页面仅检查了暂停或空状态。
- 本次实际浏览器检查是本地国内站。国际站完成构建，但未做同等页面浏览器逐页检查。

## validation
- 页面截图和 DOM 几何：320px 与 390px 的已加载页面无剩余可见重叠或横向溢出。
- `pnpm check`、`pnpm build:cn`、`pnpm build:global` 均通过。
- 诊断中心聚焦 Vitest：24 通过、2 失败；失败为仓库原有文案预期不一致（测试期待“开始新会话”/“fresh session”，组件现有“开始新对话”/“fresh chat”），已用 `git show HEAD` 核对基线。
- `git diff --check` 交接前执行。
- CI 修复阶段：`npm --prefix opencraft run sync:mono2-agent-console` 与 `npm --prefix opencraft run check:mono2-agent-console` 通过，核对 130 个 Agent Console 同步文件；`npm --prefix opencraft run test:embedded-ci` 155/155 通过。
- 合并目标分支后再次运行同步检查与 embedded CI 测试：130 个同步文件一致，155/155 通过。

## decisions
- 本次围绕 `/agents` 的移动端界面巡检，不扩展到营销站全站。
- CI 修复只同步 OpenCraft 生成副本及 provenance；真源提交保持独立，不修改同步脚本或 CI 规则。

## scan_scope
- `frontend/src/pages/marketing/agent-settings-page.tsx`、`frontend/src/styles.css`、相关相邻测试与 OpenSpec。

## scan_output
- 精确搜索定位导航、会话和响应式样式。

## handoff
- 本地修复和巡检完成；用户随后授权修复 CI 并更新原 MR !4945，合并与发布另行处理。运行态多会话与国际站实际浏览器页面可在具备相应状态后补测。
