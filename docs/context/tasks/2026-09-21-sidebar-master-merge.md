---
id: task-sidebar-master-merge-20260921
type: task
scope: 将分支收敛为左侧导航并包含现有 master。
triggers: ["master merge", "sidebar merge", "侧栏范围收敛"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - frontend/src/components/site/agent-sidebar.tsx
  - frontend/src/components/site/sidebar-user-menu.tsx
  - frontend/src/pages/marketing/agent-settings-page.tsx
status: active
reviewed_at: 2026-09-23
review_due: 2026-12-23
revision: 2.1.0
precedence: task
derived: false
---

## goal

依用户最新要求，只保留左侧导航、账号菜单及必要支持文件；包含 origin/master，更新原 MR !4390。

## non_goals

- 不改 Account/Buddy/Memory/任务/模型等正文、依赖版本、全局 UI 或 OpenCraft 产品功能。
- 不改变 show 的 toggle 语义，不新增 hide，不修无关测试；不操作其他 worktree、生产或 GitOps。

## requirement_ids / requirement_refs / requirement_excerpt

- 本会话用户：收敛一下，把改动范围控制在左侧导航和现有 master 分支合并上来。
- 用户此前授权提交、推送 frontsandbox 分支并维护 https://git.woa.com/wisp/mono2/merge_requests/4390 。

## interface_refs / data_structure_refs

- AgentSidebar 只负责滚动边界；页面保留 master 导航和业务接线。
- SidebarUserMenuController 只读现有 Session/Pass，复用 master 的 console-show-event、usePassUpgrade 和购买路由。
- OpenCraft 生成目录只能由未修改的 master 同步脚本生成；无手写产品修改。

## history_context

- current_design_refs: frontend/DESIGN.md、frontend/src/components/site/sidebar-user-menu.README.md。
- relevant_evolution: 收敛前版本 6214001a0；原 MR 相对 master 305 文件，包含超出当前范围的 Agent/Account/Radix 重构。
- superseded_refs: 本文旧版所有测试和交接结论作废；不再沿用“162 文件通过”“存在原有未提交改动”等描述。

## acceptance

- 相对 master 只剩侧栏、必要支持、测试、文案、交接和机械同步产物。
- click-only、整行按钮、Portal、滚动边界和 master 菜单接线的聚焦测试通过。
- pnpm check/build 和投影检查分别记录；无关全量失败不扩展修复范围。

## affected_paths

- frontend/src/components/site/{agent-sidebar,sidebar-user-menu,sidebar-user-menu-controller,user-avatar-menu} 及测试。
- frontend/src/lib/{account-pass-summary,use-account-pass-summary}、components/ui/progress、styles.css。
- agent-settings-page/loading-view 的侧栏 wrapper、导航断言；一条账号管理翻译。
- 两份侧栏 Task Pack、README、catalog；OpenCraft 必要生成副本与 UPSTREAM metadata。

## required_context

frontend、site-environment-routing、frontend-runtime-openspec-i18n、upstream-subtrees。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| AGENTS.md、frontend/AGENTS.md | 仓库与前端边界 | 控制范围、记录命令证据 |
| docs/context/project/services/frontend.md、docs/context/domains/site-environment-routing.md | 路由 must_read | 保留站点规则 |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md | 邻接 | 核对 i18n 脚本与测试 |
| frontend/openspec/plan.md、frontend/DESIGN.md | 现有规范 | 不迁移无关组件 |
| docs/context/tasks/TASK-TEMPLATE.md、docs/context/tasks/CHECKPOINT-TEMPLATE.md | 交接契约 | 更新失效记录 |
| opencraft/AGENTS.md、opencraft/MONO2_MIGRATION.md、docs/context/project/upstream-subtrees.md | 生成边界 | 只做必需机械同步 |
| docs/context/domains/agent-gateway-runtime.md、docs/context/project/services/opencraft.md | 同步脚本路由 must_read | 校验生成冲突，不扩改 OpenCraft 产品 |

## evidence

- 2026-09-22 精确 fetch：origin/master=c1875f2f166a66924330a8f8e3f1cfb278366819，已为 HEAD 祖先；无需空 merge。
- 收敛后账号页、Buddy、Memory、依赖、锁文件及 OpenCraft 产品代码与 master 相同；原内容可由 6214001a0 找回。
- pnpm check 通过：171 current / 171 baseline / 0 new TypeScript diagnostics；所有必填语种无缺译。
- 默认和 global 环境聚焦 Vitest 均 8 文件、125 项通过，含滚动边界、整行按钮子元素点击、hover 不开、Portal 和焦点恢复；mock 测试不等同于真实双站验收。
- 补充侧栏引导 guard：agent-multi-bot-onboarding.test.ts 16 项通过；仅将旧 aside 字面匹配更新为 AgentSidebar，保留原引导条件。
- pnpm build 通过（cn 静态构建）；未宣称 global 构建、浏览器像素命中、真实登录/计费验证。
- 全量 pnpm run test --maxWorkers=2 已启动并出现失败，后按收窄范围停止；未完成 master 基线对比，不将失败定性为既有，也不宣称全量通过。

- validate_documentation.py 无错误；validate_context.py --build-catalog 已生成 catalog，但仓库文档元数据及 secret-scan 告警仍导致 exit 1；本次两份侧栏 Pack 无报错。
- 收敛提交的 --staged docs-impact 通过；后续机械 UPSTREAM metadata 会单独触发 agent-gateway-runtime 正式设计要求。本次不为满足路径门禁改写无关架构文档，需 owner 评审此生成物例外。
- 标准同步脚本核对 130 文件；除菜单账号管理文案，顺带同步 master 已有的英文 Basic setup，OpenCraft 依赖/脚本/产品源码与 master 无差异。

## risks

- 组件测试不提供浏览器真实尺寸证据；预览验收待后续确认。
- 生成 metadata 必须在最后 frontend 源码提交后 sync，另行提交，不 amend 源码提交。

## validation

- pnpm check、pnpm build；8 个 sidebar/menu/summary/nav/helper 文件的聚焦 Vitest（默认/global）。
- git diff origin/master --check；仅必要文档和投影一致性检查。完整日志保存在本机 /tmp/sidebar-converge-*.log，不提交日志。

## decisions

- 以用户最新范围覆盖此前“所有组件样式 ours”的宽范围决策。
- Account/Buddy/Memory/依赖/OpenCraft 产品修改恢复 master；侧栏保留 click-only 与整行命中，不改 show/hide API。

## scan_scope

侧栏源码、相邻测试、styles.css、i18n 脚本和 master 的同步脚本。

## scan_output

git diff -w origin/master 的 settings page 仅侧栏 wrapper/import；正文与业务接线无改动。

## handoff

源码收敛与聚焦验证完成；提交、生成物检查和远端 MR 更新结果以最终 Git/MR 为准。

## checkpoint

### 2026-09-23 补齐最新 master 并推送原预览分支

- 用户已明确同意继续合并、提交并推送原 frontsandbox 分支；覆盖上一轮“只本地提交”的限制。
- 远端核验：MR !4390 仍 opened，source_commit 为 2bedc539b；此前 07aa1c18f / bdb42c768 仅在本地，因此 MR 仍显示冲突。master 此后又前进 26 个提交，本轮合并基点为 21f831c58416cc41c45406390970b094dfbffcae。
- 唯一冲突为 opencraft 的 UPSTREAM.json；使用未改动的 sync:mono2-agent-console 重新生成，不手工选边。同步后 check:mono2-agent-console 核对 130 文件通过。
- 范围复核：侧栏源码自动合并，保留固定探索/对话页签、滚动区与底部账号区、click-only 菜单、国内站菜单内反馈。Account/Buddy/Memory 正文、frontend 依赖和锁文件相对本轮 master 无差异；其余新增文件均来自 master。
- 当前合并树验证：7 文件 113 项侧栏/导航测试、global 菜单 42 项及真实页面滚动独立性 1 项通过（同文件其他 11 项未跑）。pnpm check 通过：171 current / 171 baseline / 0 new，i18n 无缺译。日志 /tmp/sidebar-latest-0923-{focused,global,page,check}.log。未跑全量测试，不复用早期 head 的结论。
- CN pnpm build 通过，日志 /tmp/sidebar-latest-0923-build.log；撤回其生成的无关字体文件。validate_documentation 无错误；context 校验仍有仓库其他 Pack 的既有报错，不扩修。
- 提交顺序：先提交合并树，再运行 sync 并单独提交 sourceRevision metadata，最后在最终 HEAD 上复查生成一致性与来源提交可达性；不 amend 合并提交，不强推。
- 推送目标仅 frontsandbox/agents-sidebar-account-hit-area；以远端 SHA 与 MR 读回结果为交付证据，不把 push 等同于预览部署完成。

### 2026-09-23 再次合并 master

- 用户请求：解决冲突后提交；本轮只创建本地提交，不自动推送。
- 基点：原分支 2bedc539b；本次 fetch 的 master 为 b2573c45a，共 103 个待纳入 master 提交。工作树初始干净，远端源分支与本地一致。
- 唯一冲突：agent-settings-page.tsx 的 Bot 资料区。保留分支 AgentSidebar/profile/controls/middle/footer 结构，精确纳入 master 的 pausedStatusTooltip 包裹；master 的键盘事件防冒泡和成就入口自动合并保留。
- 审计：相对 master 的 settings page 忽略缩进差异后只剩侧栏结构和独立反馈移除；Account/Buddy/Memory 正文、frontend 依赖与锁文件和 master 一致；未整文件选 ours/theirs。
- Context：路由 query “frontend sidebar merge latest master conflicts” 无匹配，随后有界搜索上述侧栏符号；读取 frontend/AGENTS.md、frontend-runtime-openspec-i18n 邻接、现有 sidebar 测试、openspec/plan.md 和 CHECKPOINT-TEMPLATE。机械同步路由补读 agent-gateway-runtime、site-environment-routing、upstream-subtrees、services/opencraft、opencraft/AGENTS.md、MONO2_MIGRATION.md。
- 验证：7 个侧栏/导航文件 113 项通过；global 菜单 42 项通过；tooltip/onboarding 17 项通过；真实页面 “independent from content scrolling” 1 项通过（同文件其余 11 项未跑）。日志 /tmp/sidebar-merge-0923-{focused,global,tooltip,page}.log。
- pnpm check：171 current / 171 baseline / 0 new，i18n 无新增缺译；CN pnpm build 通过。日志 /tmp/sidebar-merge-0923-{check,build}.log。未跑全量测试，未重做浏览器和远端部署验收。
- 生成一致性：master 本身未同步 runtime-config-context、model-action-tooltip、fake-repositories 及 i18n 的源码 hash；已按原脚本机械同步 130 文件，实际差异为上述 3 个副本、8 个字典和 manifest。无手写 OpenCraft 产品改动。
- 文档：validate_documentation 无错误；合并暂存集 docs-impact 通过；context 校验仍报其他 Pack 等错误，本任务 Pack 无报错，catalog 随本记录生成。不为单独来源 SHA 提交扩改架构文档。
- 提交顺序：先提交合并树及生成内容，再用原同步脚本更新来源 SHA，另行提交；不 amend 源码提交。

### 2026-09-22 预览侧栏回归修复

- 目标：修复探索/对话页签随导航滚动被裁切及与首项紧贴；把国内站反馈收回头像菜单，移除独立入口。
- 范围：真实侧栏、加载态、局部 CSS、账号菜单反馈显隐及相关测试/README；不动正文、依赖、show/hide、OpenCraft。
- 回归矩阵：正式/加载态页签不在滚动容器；桌面顶部/底部滚动页签固定且间距正常；账号菜单默认及 show 切换后仅一个反馈入口；国际站无反馈。
- 已读取技能：baseline-ui、lightvela-web-validation；沿用本文件 context_receipt 的 frontend 服务与邻接卡，核对既有导航测试。
- 修复前证据：3 个聚焦组件用例均在预期断言失败（页签包含关系、默认反馈缺失），日志 /tmp/sidebar-fix-red.log。预览浏览器实测页签上部随导航滚动被裁切。
- 修复：探索/对话移出导航滚动区，保留原切换逻辑；桌面页签前后各 16px 间距，上边滚动阴影移到页签下沿；加载态同步。反馈仅在国内站账号菜单默认展示，复用既有“产品反馈”字典，无新文案。
- 最新测试：上述 3 项修复后通过；6 个侧栏聚焦文件 104 项通过；global 环境 controller/header 2 文件 42 项通过。日志 /tmp/sidebar-fix-{green,focused,global}.log；未跑全量测试。
- 最新 check：171 current / 171 baseline / 0 new，i18n 无缺译；日志 /tmp/sidebar-fix-check.log。
- 浏览器证据：本地 mock 登录、CN、Chrome，http://127.0.0.1:5194/agents/；滚动顶部/底部页签完整固定，反馈只在菜单内，Escape 归还头像按钮焦点，探索/对话导航切换正常。截图 /tmp/lightvela-sidebar-fix/screenshots/；不等同于远端部署或真实计费验收。
- 环境说明：首次 NEXT_DIST_DIR=.next-sidebar-fix 被 Tailwind 扫入缓存导致热更新 CSS 解析失败；改用 git-ignored 的 .next/sidebar-fix 后恢复，未改构建配置。
- 最新 build：pnpm build 通过（CN）；首次与 dev 同时运行因缓存目录占用失败，停止本轮 dev 后完整重跑通过，日志 /tmp/sidebar-fix-build-final.log。撤回构建生成的无关字体差异，保留侧栏范围。
- 文档：validate_documentation 无错误；实际本轮 diff 文件的 docs-impact 通过；context catalog 仅更新本 Pack 的 hash，仓库 context 校验仍因其他 Pack 等错误 exit 1，不扩修。
- 未覆盖：移动端浏览器、国际站浏览器、真实账号服务端操作和远端预览新版本；本轮未提交或推送。报告 /tmp/lightvela-sidebar-fix/report.html。

### stage
2026-09-23 最新 master 21f831c58 的生成冲突已解决，准备合并提交及机械来源记录提交，并推送原预览分支。
### verified
最新合并树的 113 项侧栏/导航、42 项 global、1 项页面结构、pnpm check、CN build 与 130 文件生成检查通过；早期验证只作历史证据。
### unverified
全量测试、master 基线对比、移动端/国际站浏览器与远端部署状态未验证。
### discard
旧重构和旧门禁声明。
### restore
独立 worktree frontsandbox/agents-sidebar-account-hit-area；原版本 6214001a0。
### next_action
按用户授权提交、机械同步并推送，核对远端 SHA 和 MR 冲突状态。
